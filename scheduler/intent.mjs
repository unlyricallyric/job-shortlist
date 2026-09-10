import { RunError } from "./io.mjs";
import { parseJobSections, prefilterCard, screenJob } from "./screening.mjs";

export const collectionMode = "collection-only";
export const candidateMode = "candidate-feed";

export function modeSettings(mode) {
  if (mode === candidateMode) return {
    mode, autoPublish: true, reviewRequired: false, manualApprovalRequiredForVisibility: false,
  };
  if (mode === collectionMode) return {
    mode, autoPublish: false, reviewRequired: true, manualApprovalRequiredForVisibility: true,
  };
  throw new RunError("collection-mode-required", "An explicit supported collection or candidate-feed mode is required.", { blocked: true });
}

export function assertRuntimeMode(runtime) {
  if (runtime.mode === candidateMode) {
    if (runtime.autoPublish !== true || runtime.reviewRequired !== false || runtime.manualApprovalRequiredForVisibility !== false) {
      throw new RunError("candidate-mode-required", "Candidate visibility requires an explicit candidate-feed configuration.", { blocked: true });
    }
  } else assertCollectionMode(runtime);
  return modeSettings(runtime.mode);
}
export const partnerQueries = [
  { term: "渠道经理", industry: "100021" },
  { term: "渠道拓展", industry: "100029" },
  { term: "生态合作经理", industry: "100021" },
  { term: "渠道运营", industry: "100021" },
  { term: "渠道经理", industry: "100023" },
  { term: "生态合作", industry: "100029" },
];
export const defaultIntentPolicy = () => ({
  version: 1, id: "partner-commercial-v1",
  primary: ["partner-development", "channel-management", "business-ecosystem"],
  secondary: ["customer-success", "account-sales"],
  queries: partnerQueries.map((query) => ({ ...query })),
});

export function validateIntentPolicy(policy) {
  const expected = defaultIntentPolicy();
  if (!policy || typeof policy !== "object" || Array.isArray(policy)
    || Object.keys(policy).length !== 5 || policy.version !== 1 || policy.id !== expected.id
    || JSON.stringify(policy.primary) !== JSON.stringify(expected.primary)
    || JSON.stringify(policy.secondary) !== JSON.stringify(expected.secondary)
    || JSON.stringify(policy.queries) !== JSON.stringify(expected.queries)) {
    throw new RunError("invalid-intent-policy", "An explicitly supported private career-intent policy is required.", { blocked: true });
  }
  return policy;
}

export function assertCollectionMode(runtime) {
  if (runtime.mode !== collectionMode || runtime.autoPublish !== false || runtime.reviewRequired !== true
    || (runtime.manualApprovalRequiredForVisibility !== undefined && runtime.manualApprovalRequiredForVisibility !== true)) {
    throw new RunError("collection-mode-required", "Legacy automatic publication is disabled. Explicit collection-only migration is required.", { blocked: true });
  }
}

const normalize = (text) => text.normalize("NFKC").toLowerCase().replace(/[\u2028\u2029]/gu, "\n");
const action = /负责|拓展|发展|招募|开发|建立|制定|执行|推进|推动|经营|管理|维护|跟进|组织|协调|协助|参与|落地|deliver|develop|manage|drive|build|own/u;
const partner = /伙伴|渠道|代理商|经销商|生态厂商|系统集成商|行业软件商|partners?|reseller/u;
const businessPartner = /伙伴.{0,12}(?:招募|拓展|发展|准入|经营|分级|激活|评价|销售|商机)|(?:发展|招募|拓展|开发|挖掘).{0,12}(?:伙伴|代理商|经销商)|(?:合作|伙伴).{0,10}(?:洽谈|签约|协议)|商机互荐|线索交换|联合打单|伙伴转售|分销体系/u;
const channelBusiness = /渠道.{0,12}(?:开发|拓展|经营|管理|销售|策略|政策)|(?:管理|发展|拓展|开发).{0,10}渠道|分销|代理销售|经销商/u;
const ecosystemBusiness = /生态.{0,12}(?:合作|建设|战略|规划|项目|伙伴|商业)|商务合作模式|交付合作模式|省专协同/u;
const marketPurpose = /内容营销|品牌(?:营销|传播|宣传)|需求生成|市场活动|活动策划|展会策划|会销|文案|内容产出|获客营销|seo|demand generation|field marketing|content marketing/u;
const technicalWork = /(?:负责|独立|主导|编写|开发|实现|设计).{0,16}(?:代码|接口|驱动|算法|技术架构|软件架构|电路|固件)|(?:fpga|嵌入式).{0,10}(?:研发|设计)|(?:研发|开发).{0,10}(?:fpga|驱动|固件)/u;
const outsidePurpose = /(?:负责|主导|开展|执行).{0,20}(?:采购|寻源|比价|对账|清结算|资金结算|政府关系|政务关系|公关事务)|自带.{0,10}团队|项目合作模式|门店.{0,10}(?:收银|地推)|旅行社|文旅渠道/u;

export function assessIntent(record, policy) {
  validateIntentPolicy(policy);
  if (typeof record.jd !== "string" || !record.jd.trim()) {
    return { decision: "unclear", family: null, reasons: ["intent-evidence-missing"] };
  }
  const parsed = parseJobSections(record);
  // Unseparated text can inform a private direction preview, never establish qualifications.
  const body = normalize(parsed?.duties || record.jd.split(/任职要求|任职资格|岗位要求/u)[0]);
  const clauses = body.split(/[\r\n。；;]+/u).filter((text) => text.trim());
  const active = clauses.filter((text) => action.test(text) || /^伙伴拓展|^共商机|^共销售/u.test(text));
  const commercial = active.filter((text) => partner.test(text) && (businessPartner.test(text) || channelBusiness.test(text)));
  const ecosystem = active.filter((text) => ecosystemBusiness.test(text)
    && /合作|伙伴|商务|项目|洽谈|协议|交付/u.test(text));
  const unrelated = active.filter((text) => outsidePurpose.test(text)
    || (technicalWork.test(text) && !/协同|协调|对接|协助|配合/u.test(text)));
  if (unrelated.length && unrelated.length >= commercial.length + ecosystem.length) {
    return { decision: "outside", family: null, reasons: ["outside-business-partner-purpose"] };
  }
  const lifecycleSignals = [
    /(?:招募|发展|拓展|开发).{0,10}(?:伙伴|代理商|经销商)|伙伴(?:地图|拜访|准入)/u,
    /商机互荐|线索交换|联合打单|伙伴转售|代理销售|共商机|共销售/u,
    /伙伴.{0,8}(?:分级|经营|激活|评价|月度)|渠道政策|伙伴日常运营/u,
    /合作(?:洽谈|协议)|签约准入|伙伴合同/u,
  ].filter((pattern) => pattern.test(body)).length;
  const marketingClauses = active.filter((text) => marketPurpose.test(text) || /联合市场活动/u.test(text));
  if (marketingClauses.length && lifecycleSignals < 2
    && marketingClauses.length >= commercial.length + ecosystem.length) {
    return { decision: "outside", family: null, reasons: ["marketing-led-not-partner-business"] };
  }
  if (commercial.length) {
    return { decision: "primary", family: /招募|伙伴拓展|发展.{0,8}伙伴|伙伴.{0,8}准入|伙伴拜访/u.test(commercial.join("\n"))
      ? "partner-development" : "channel-management", reasons: ["business-partner-lifecycle"] };
  }
  if (ecosystem.length && partner.test(body)) {
    return { decision: "primary", family: "business-ecosystem", reasons: ["commercial-ecosystem-coordination"] };
  }
  if (active.some((text) => marketPurpose.test(text))) {
    return { decision: "outside", family: null, reasons: ["marketing-led-not-partner-business"] };
  }
  if (active.some((text) => /客户成功|客户健康|客户留存|客户续约|customer success/u.test(text))) {
    return { decision: "secondary", family: "customer-success", reasons: ["secondary-customer-success"] };
  }
  if (active.some((text) => /客户经理|行业客户|大客户|新客户|销售业绩|客户关系|account executive|客户.{0,8}业务拓展/u.test(text))) {
    return { decision: "secondary", family: "account-sales", reasons: ["secondary-direct-customer-sales"] };
  }
  return { decision: "unclear", family: null, reasons: ["business-purpose-needs-review"] };
}

export function intentCardPriority(card) {
  const title = normalize(card.title ?? "");
  if (/伙伴|渠道|生态/u.test(title) && !/市场|营销|内容|活动/u.test(title)) return 3;
  if (/伙伴|渠道|生态|商务拓展/u.test(title)) return 2;
  if (/客户成功|大客户|客户经理|业务拓展/u.test(title)) return 1;
  return 0;
}

export function prefilterIntentCard(card, matching, policy, excludedIds) {
  validateIntentPolicy(policy);
  if (excludedIds.has(card.id)) return { eligible: false, reason: "manual-excluded" };
  const base = prefilterCard(card, matching);
  if (!base.eligible) return base;
  const title = normalize(card.title ?? "");
  if (/采购|清结算|政府关系|政务关系|内容营销|活动策划|品牌营销/u.test(title)
    && !/伙伴发展|渠道管理|生态合作/u.test(title)) return { eligible: false, reason: "outside-intent-title" };
  if (/市场|营销|活动|文案/u.test(title) && !/伙伴|渠道|生态|商务/u.test(title)) {
    return { eligible: false, reason: "outside-primary-intent-title" };
  }
  return base;
}

export function assessForReview(record, matching, policy) {
  const intent = assessIntent(record, policy);
  // Broaden only the evaluator's role labels, never the confirmed capability facts.
  const qualification = screenJob(record, { ...matching, directions: [
    "伙伴发展", "渠道销售", "生态商业化", "客户成功", "大客户销售", "伙伴营销",
  ] });
  const reasons = qualification.reasons.filter((reason) => reason !== "direction-not-configured");
  const fatal = reasons.some((reason) => /^(geography-outside-shanghai|student-only|years-insufficient|education-insufficient)$/.test(reason));
  const unresolved = new Set(reasons);
  const body = normalize(record.jd);
  if (/独立.{0,10}(?:商务|拓展|谈判|签约)|联合打单|转售业绩|营收.{0,8}目标/u.test(body)) {
    unresolved.add("independent-commercial-scope-needs-review");
  }
  if (/丰富经验|垂直领域|监管|财务核心系统/u.test(body)) unresolved.add("specialist-domain-needs-review");
  if (intent.decision === "primary" || intent.decision === "secondary") unresolved.add("human-qualification-review-required");
  return {
    intent,
    qualification: { status: fatal ? "not-met" : "pending", reasons: [...unresolved].sort() },
  };
}
