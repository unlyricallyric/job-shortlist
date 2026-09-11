import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isIsoDate } from "../docs/model.mjs";
import { atomicJson, readJson, RunError } from "./io.mjs";
import { parseJobSections } from "./screening.mjs";

const categories = ["cockpit-project", "marketing-leadership", "entrepreneurial-partner", "executive-ownership", "procurement", "frontline-sales"];
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const feedbackRolePolicy = () => ({ version: 1, id: "role-feedback-v1", categories: [...categories] });
export const emptyRoleHistory = () => ({ version: 1, entries: [] });

export function validateRolePolicy(value) {
  if (!exact(value, ["version", "id", "categories"]) || value.version !== 1 || value.id !== "role-feedback-v1"
    || !Array.isArray(value.categories) || !value.categories.length || new Set(value.categories).size !== value.categories.length
    || value.categories.some((category) => !categories.includes(category))) {
    throw new RunError("invalid-role-policy", "A supported, versioned private role-exclusion policy is required.", { blocked: true });
  }
  return value;
}

export function validateRoleHistory(value) {
  if (!exact(value, ["version", "entries"]) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new RunError("invalid-role-history", "Private role-exclusion history is invalid.", { blocked: true });
  }
  const keys = new Set();
  for (const entry of value.entries) {
    const key = `${entry.id}:${entry.policyId}:${entry.category}`;
    if (!exact(entry, ["id", "policyId", "policyVersion", "category", "reasonCode", "basis", "observedAt", "filteredAt"])
      || typeof entry.id !== "string" || !/^(?:boss-[A-Za-z0-9_~-]+|bytedance-\d+|liepin-\d+)$/.test(entry.id)
      || entry.policyId !== "role-feedback-v1" || entry.policyVersion !== 1 || !categories.includes(entry.category)
      || entry.reasonCode !== `role-${entry.category}` || !["title", "duties"].includes(entry.basis)
      || !isIsoDate(entry.observedAt, false) || !isIsoDate(entry.filteredAt, false)
      || Date.parse(entry.observedAt) > Date.parse(entry.filteredAt) || keys.has(key)) {
      throw new RunError("invalid-role-history", "A private role-exclusion record is invalid.", { blocked: true });
    }
    keys.add(key);
  }
  return value;
}

async function privateJson(root, name, missingCode) {
  const path = join(root, name);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code === "ENOENT") throw new RunError(missingCode, "Configured role exclusions are missing; publishing is blocked.", { blocked: true });
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw new RunError("private-permissions", "Role exclusions require owner-only regular files.", { blocked: true });
  }
  return readJson(path);
}

export async function loadRoleContext(root, runtime) {
  if (runtime.roleExclusionsVersion === undefined) {
    if (await readJson(join(root, "role-exclusions.json"), null)) {
      throw new RunError("role-policy-unconfigured", "An existing role policy must be explicitly connected to the runtime.", { blocked: true });
    }
    return { policy: null, history: emptyRoleHistory() };
  }
  if (runtime.roleExclusionsVersion !== 1) throw new RunError("invalid-role-policy", "Unsupported runtime role policy version.", { blocked: true });
  return {
    policy: validateRolePolicy(await privateJson(root, "role-exclusions.json", "role-policy-missing")),
    history: validateRoleHistory(await privateJson(root, "role-exclusions-history.json", "role-history-missing")),
  };
}

export async function rememberRoleExclusions(root, context, removals, now = new Date().toISOString()) {
  if (!context.policy || !removals.length) return;
  const entries = [...validateRoleHistory(context.history).entries];
  for (const item of removals) {
    if (entries.some((entry) => entry.id === item.id && entry.policyId === context.policy.id && entry.category === item.category)) continue;
    entries.push({ id: item.id, policyId: context.policy.id, policyVersion: context.policy.version,
      category: item.category, reasonCode: item.reasonCode, basis: item.basis, observedAt: item.observedAt, filteredAt: now });
  }
  await atomicJson(join(root, "role-exclusions-history.json"), validateRoleHistory({ version: 1, entries }));
}

export const normalizeRoleText = (text) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]/gu, "");
const contextHeading = /晋升(?:通道|路径|方向|空间)?|职业发展|发展(?:通道|路径)|汇报(?:对象|关系)|report(?:s|ing)?\s+to|career\s+path|promotion\s+to/iu;
const partnerTitle = /伙伴|渠道|生态|partner|reseller|channel|pdr|bdr|sdr|销售开发|salesdevelopment/u;
const directTitle = /直客|直销|终端销售|directsales/u;
const accountTitle = /大客户(?:销售|经理|商务)|ka(?:大客户|客户|销售|商务)|accountmanager|keyaccount/u;
const representativeTitle = /业务销售|海外销售|外贸销售|销售代表|accountexecutive|salesrepresentative/u;
const salesSupportTitle = /销售(?:代表)?(?:运营|支持|赋能|培训|策略|开发)|售前|sales(?:representative)?(?:operations|enablement|support|development)/u;
const executive = /总经理|副总裁|总裁|首席.{0,10}官|vicepresident|generalmanager|(?:^|[^a-z])(?:[es]?vp|ceo|cto|cfo|coo|cio|cdo|cpo)(?:$|[^a-z])/u;
const marketingHead = /(?:市场|营销|品牌).{0,6}(?:总监|一号位)|(?:市场|营销|品牌)负责人|marketingdirector|headofmarketing|chiefmarketingofficer|(?:^|[^a-z])cmo(?:$|[^a-z])/u;
const supportTitle = /(?:市场总监|营销总监|总经理|总裁|ceo|cmo|vp)(?:助理|秘书|办公室|支持)|(?:assistantto|supportfor)(?:the)?(?:ceo|cmo|vp|generalmanager)/gu;

function roleTitle(text) {
  return normalizeRoleText((text ?? "").split(contextHeading)[0])
    .replace(supportTitle, "")
    .replace(/(?:向|对接|支持|协助|汇报给)(?:集团|客户)?(?:总经理|市场总监|采购经理|高管|ceo|cto|cfo|coo|cmo|vp)(?:汇报)?/gu, "");
}

function dutyClauses(jd) {
  if (typeof jd !== "string" || jd.length < 80 || jd.length > 60000) return [];
  const text = jd.normalize("NFKC").replace(/(?<=[\p{Script=Han}])[ \t]+(?=[\p{Script=Han}])/gu, "");
  const english = /(?:^|\n)\s*(?:job\s+|key\s+)?(?:responsibilities|duties|what you(?:'ll| will) do)\s*:?\s*\n?([\s\S]*?)(?=\n\s*(?:(?:required|preferred|minimum)\s+)?(?:qualifications|requirements|benefits|career path)\b|$)/iu.exec(text)?.[1];
  const duties = parseJobSections({ jd: text })?.duties || english || "";
  return duties.split(contextHeading)[0].split(/[\r\n。；;]+/u).map((clause) => normalizeRoleText(clause)
    .split(/不负责|不承担|无需|不需要|不要求|不涉及/u)[0])
    .filter((clause) => clause && !/^(?:向|汇报|晋升|熟悉|了解|具备|具有|至少|优先|要求)/u.test(clause));
}

export function assessRoleExclusion(record, policy) {
  if (policy === null) return null;
  validateRolePolicy(policy);
  const title = roleTitle(record.title);
  const rawTitle = (record.title ?? "").normalize("NFKC").toLowerCase().split(contextHeading)[0];
  const englishExecutive = /\b(?:ceo|cto|cfo|coo|cio|cdo|cpo|[es]?vp|general manager|vice president)\b/u.test(rawTitle)
    && !/assistant|support|liaison|report|客户|对接|支持|协助|汇报|助理/u.test(rawTitle);
  const enabled = new Set(policy.categories);
  const result = (category, basis) => enabled.has(category) ? { category, reasonCode: `role-${category}`, basis } : null;
  const titleChecks = [
    ["cockpit-project", /(?:座舱|cockpit).{0,18}(?:项目经理|项目管理|项目总监|技术交付|交付经理|projectmanager|programmanager)/u.test(title)],
    ["entrepreneurial-partner", /合伙人|联合创始人|共同创始人|cofounder|foundingpartner|equitypartner|managingpartner|franchiseowner/u.test(title)],
    ["marketing-leadership", marketingHead.test(title)],
    ["executive-ownership", executive.test(title) || englishExecutive],
    ["procurement", /采购|寻源|招采|purchasing|procurement|sourcingmanager/u.test(title) && !/采购(?:数字化|管理)?(?:软件|系统|产品|解决方案)|(?:采购经理|采购总监)客户/u.test(title)],
    ["frontline-sales", directTitle.test(title)],
  ];
  for (const [category, matches] of titleChecks) if (matches && enabled.has(category)) return result(category, "title");
  const clauses = dutyClauses(record.jd);
  const owning = clauses.filter((text) => /负责|主导|牵头|独立|自主|建立|制定|执行|开展|推动|担任|出任|开拓|拓展/u.test(text)
    || /^\d*(?:youwill)?(?:own|lead|manage|develop|drive|build|execute|responsiblefor|independently|support|enable|recruit)/u.test(text));
  if (owning.some((text) => /(?:担任|出任)(?:集团|公司)?(?:市场总监|营销总监|cmo)/u.test(text))) {
    const decision = result("marketing-leadership", "duties");
    if (decision) return decision;
  }
  if (owning.some((text) => /(?:担任|出任)(?:集团|公司|区域|事业部)?(?:总经理|总裁|ceo|vp)|对公司整体(?:经营|盈亏)负责/u.test(text))) {
    const decision = result("executive-ownership", "duties");
    if (decision) return decision;
  }
  if (owning.some((text) => /(?:共同创业|自负盈亏|自带资金|股权出资|个人出资)/u.test(text))) {
    const decision = result("entrepreneurial-partner", "duties");
    if (decision) return decision;
  }
  const cockpit = owning.filter((text) => /座舱|cockpit/u.test(text)
    && /研发|技术交付|开发交付|项目生命周期|软硬件交付|项目进度/u.test(text) && !/客户拓展|渠道|伙伴|商务合作/u.test(text));
  if (cockpit.length) {
    const decision = result("cockpit-project", "duties");
    if (decision) return decision;
  }
  const procurement = owning.filter((text) => !/客户采购|对接采购|协同采购/u.test(text)
    && !/采购(?:数字化|管理)?(?:产品|软件|系统|解决方案).{0,16}(?:调研|设计|开发|交付|销售)|procurement(?:software|platform|product)/u.test(text)
    && /(?:负责|主导|牵头|执行|制定|推动|建立).{0,22}(?:采购流程|采购计划|采购体系|采购的标准化体系|采购订单|采购成本|寻源|比价|采购管理|采购数字化)|(?:负责|主导|执行)(?:公司|供应链|物料|原材料|算力资源)?采购|(?:own|lead|manage|execute).{0,20}(?:procurement|sourcing|purchaseorders|supplierselection|purchasing)/u.test(text));
  const commercial = owning.filter((text) => /伙伴招募|渠道拓展|伙伴准入|合作伙伴|联合销售|联合打单|商务合作/u.test(text) && !/供应商/u.test(text));
  if (procurement.length && (procurement.length >= commercial.length || /供应链|供应商/u.test(title))) {
    const decision = result("procurement", "duties");
    if (decision) return decision;
  }
  const partnerSupport = (text) => /(?:协助|支持|帮助|赋能|辅导|培训|协同).{0,8}(?:伙伴|渠道|代理商|经销商)|(?:support|enable|coach|assist|help).{0,14}(?:partners|resellers|channels)/u.test(text);
  const ownCustomer = owning.map((text) => text.replace(/(?:渠道|代理商|经销商|合作伙伴|伙伴)客户|(?:channel|partner|reseller)(?:customers|accounts)/gu, "伙伴关系")
    .replace(/客户经理|客户成功经理/gu, "协同角色"))
    .filter((text) => /(?:独立|自主|自有|个人).{0,18}客户|直客(?:开发|拓展)|(?:开发|拓展).{0,6}(?:终端|新)客户|(?:own|independently|direct|new|end).{0,30}(?:customers|clients|prospecting)/u.test(text)
    && /开发|拓展|销售|商务谈判|合同签署|全流程|prospect|acqui|develop|sales|clos|negot|fullcycle|endtoend/u.test(text)
    && !/销售支持|售前支持|招投标支持|salessupport|presalessupport/u.test(text)
    && !partnerSupport(text));
  const closing = owning.some((text) => /商务谈判|合同(?:签署|签订|谈判)|签约|回款|个人.{0,8}(?:业绩|销售|配额)|销售闭环|closing|close(?:deals|sales)|contracts|collections|collectpayment|individualquota/u.test(text)
    && !partnerSupport(text) && !/(?:代理|伙伴|经销|渠道)(?:合作)?合同/u.test(text));
  if (ownCustomer.length && closing) return result("frontline-sales", "duties");
  const partnerLifecycle = [
    /伙伴招募|招募.{0,8}(?:伙伴|代理商|经销商)|伙伴准入|代理伙伴|recruit.{0,10}(?:partners|resellers)|partnerrecruitment/u,
    /伙伴赋能|赋能.{0,8}(?:伙伴|经销商)|经销商经营|伙伴经营|渠道经营|partnerenablement|enable.{0,10}(?:partners|resellers)/u,
    /伙伴转售|(?:伙伴|经销商|渠道).{0,6}(?:销售指标|收入指标|业绩)|转售指标|partnerrevenue|resellertargets/u,
    /联合打单|联合销售|商机互荐|coselling|jointselling|referrals/u,
  ].filter((pattern) => owning.some((text) => pattern.test(text))).length >= 2;
  const salesPurpose = owning.some((text) => !partnerSupport(text)
    && /(?:拓展|开发|开拓)(?:与维护)?(?:终端|企业|新|大)?客户|负责.{0,10}(?:企业级|终端|大)客户.{0,65}(?:开拓|拓展|开发)|customeracquisition|endcustomerprospecting/u.test(text));
  if (!partnerTitle.test(title) && !/客户成功|customersuccess|csm/u.test(title) && !partnerLifecycle
    && !salesSupportTitle.test(title)) {
    if (accountTitle.test(title) || representativeTitle.test(title)) return result("frontline-sales", "title");
    if (salesPurpose && /销售|sales(?:manager|executive)/u.test(title)) return result("frontline-sales", "duties");
  }
  return null;
}
