import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessRoleExclusion, feedbackRolePolicy, loadRoleContext, validateRoleHistory, rememberRoleExclusions } from "../scheduler/role-exclusions.mjs";
import { atomicJson, readJson } from "../scheduler/io.mjs";

const v1 = feedbackRolePolicy(), policy = feedbackRolePolicy(2);
const jd = (duties, requirements = "能够完成所列职责，具体合作范围需要进一步核实；相关条件由来源岗位说明，没有个人资格结论。") =>
  `岗位职责：\n${duties}\n任职要求：\n${requirements}\n记录说明：这是用于规则边界的合成职责文本，不是真实招聘资料。`;
const decide = (title, details) => assessRoleExclusion({ title, jd: details }, policy);
const business = "负责伙伴招募与日常经营，安排联合业务计划和市场合作，帮助渠道伙伴了解产品并推进合作关系。";

test("v2 excludes explicit technical professions across example titles, synonyms, levels and new source IDs", () => {
  const titles = [
    "Java技术经理", "GPU容器云开发专家", "AI模型/大模型GPU平台开发支持", "AI框架与高性能算子工程师",
    "AI Agent Sandbox架构师", "AI Agent Sandbox 架构师", "Ｊ ａ ｖ ａ 技术经理", "G P U 容器云开发专家",
    "软件工程师", "前端工程师", "后端开发工程师", "全栈工程师", "移动端研发工程师", "嵌入式软件工程师",
    "机器学习工程师", "算法工程师", "数据科学家", "数据工程师", "云架构师", "系统架构师",
    "安全工程师", "安全架构师", "技术研发经理", "软件研发管理负责人", "运维工程师", "系统管理员",
    "Backend Engineer", "Software Developer", "Frontend Engineer", "Machine Learning Engineer", "Data Scientist",
    "CUDA Developer", "Rust Engineer", "Java Developer", "Kubernetes Engineer", "DevOps Engineer", "SRE",
    "Site Reliability Engineer", "System Administrator", "Network Engineer", "Security Architect", "Solutions Architect",
    "Engineering Manager", "HPC Performance Engineer",
  ];
  for (const [index, title] of titles.entries()) {
    const result = assessRoleExclusion({ id: `boss-technical-test-${index}`, title }, policy);
    assert.equal(result?.category, "technical-function", title);
    assert.equal(result?.basis, "title", title);
  }
  assert.equal(assessRoleExclusion({ title: "Java技术经理" }, v1), null);
});

test("technology industry, products, developer community and business development are not engineering by keyword", () => {
  for (const title of [
    "AI生态合作经理", "硬件渠道经理", "API产品合作伙伴经理", "Java生态商务拓展", "云合作伙伴经理",
    "软件业务开发经理", "Java合作伙伴开发经理", "商业开发经理", "市场开发经理", "Partner Development Representative",
    "Business Development Representative", "GPU Partner Manager", "Developer Community Manager", "开发者生态运营",
    "技术合作经理", "云技术伙伴赋能", "生态专家（向CTO汇报）", "合作运营（面向架构师）",
  ]) assert.equal(decide(title, jd(business)), null, title);
});

test("business wording does not override personally owned coding, implementation or stack-configuration duties", () => {
  for (const duties of [
    "负责Python SDK开发与维护，独立编写代码示例并调试软件接口。",
    "负责独立部署Kubernetes集群并配置Linux系统，排查服务器故障。",
    "独立设计系统架构与分布式系统，主导后端服务开发。",
    "负责算法开发、模型训练和推理优化，调试CUDA内核。",
    "负责开发者技术内容，独立建设接入教程、技术文章和Demo示例。",
    "主导整体方案设计并输出架构图及技术建议书，跟进技术实施。",
  ]) assert.equal(decide("开发者生态运营", jd(duties))?.category, "technical-function", duties);
  const engineering = "Responsibilities:\nDevelop Python SDKs and maintain code samples for partners.\nIndependently deploy Kubernetes clusters and troubleshoot Linux servers.\nRequirements:\nRelevant experience.";
  assert.equal(decide("Partner Enablement Manager", engineering)?.basis, "duties");
});

test("technical presales and DevRel are excluded only on actual technical responsibility or required skill, not promotion or product descriptions", () => {
  for (const requirements of [
    "必须具备独立编码和系统设计能力，能处理真实客户的技术实施问题。",
    "熟练使用Python开发SDK，能够独立调试代码和部署Kubernetes。",
    "精通C++与CUDA编程，具有底层研发经验。",
    "具备独立部署Linux系统和深层配置能力。",
    "必须具备独立编码能力，计算机专业优先。",
  ]) assert.equal(decide("解决方案合作经理", jd(business, requirements))?.category, "technical-function", requirements);
  assert.equal(decide("Developer Relations", "Responsibilities:\nManage the developer community and partner education programs without making qualification claims.\nRequirements:\nMust have hands-on coding and Kubernetes deployment experience.")?.basis, "requirements");
  const safe = [
    jd("负责合作伙伴业务培训，协调研发工程师完成SDK开发和技术部署。", "熟悉云产品商业模式，理解API产品价值，无需编码或系统部署能力。"),
    jd(`${business}\n晋升通道：软件架构师。`, "需要对接客户CTO和工程师，不要求编程经验。"),
    jd("负责伙伴产品介绍与合作沟通。\n产品功能：提供代码生成、容器部署和算法优化。", "有Python开发经验优先。"),
    `${jd(business)}\n加分项：\n精通CUDA编程、Linux系统配置及Python开发经验。`,
    jd(business, "要求计算机或相关专业；理解SaaS商业合作模式，不要求独立编程或系统部署。"),
    jd("负责Java生态合作伙伴开发，推进商业协议并开展业务合作。\n负责Python产品的市场开发和渠道沟通。", "熟练掌握Java生态合作流程与商业协同方式。"),
    jd("收集市场与伙伴反馈，驱动产品和渠道政策优化。\n负责维护伙伴数据库与商机档案，整理业务反馈。", "需要协调研发工程师完成技术实现和系统部署。"),
    "Responsibilities:\nDevelop business partnerships around Python SDK products and manage commercial partner relationships.\nRequirements:\nExperience with business planning and customer communication.",
    "Responsibilities:\nCoordinate with engineers to develop SDKs and deploy cloud systems.\nManage channel partner education and commercial programs.\nRequirements:\nUnderstand cloud products and business relationships.\nPreferred qualifications:\nProgramming experience.",
  ];
  for (const details of safe) assert.equal(decide("伙伴赋能经理", details), null, details);
});

test("other explicit occupation categories do not confuse commercial technology customers with employee functions", () => {
  for (const [title, category] of [
    ["HRBP", "human-resources"], ["生产计划经理", "production-planning"], ["财务经理 助理", "finance-settlement"],
    ["商家运营", "consumer-operations"], ["游戏运营", "consumer-operations"], ["高级信息流优化师", "professional-marketing"],
    ["科技内容传播专家", "professional-marketing"], ["商业化产品经理", "product-delivery"], ["外包交付经理", "product-delivery"],
    ["双休——部门运营管理", "internal-operations"],
  ]) assert.equal(decide(title)?.category, category, title);
  for (const title of ["医疗软件渠道经理", "财务软件合作伙伴经理", "游戏云服务伙伴开发经理", "技术合作项目经理",
    "AI产品合作伙伴经理", "硬件商务拓展", "商业运营经理", "伙伴运营经理"]) assert.equal(decide(title, jd(business)), null, title);
  assert.equal(decide("生态合作伙伴拓展与运维经理",
    jd("负责企业和高校合作伙伴建联、合作协议和关系维护。\n负责伙伴计划复盘，组织商业交流与非技术合作事项。")), null);
});

test("migration keeps v1 history byte-for-byte, supports v2 technical evidence basis and fails closed on version mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-technical-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = { version: 1, entries: [{
    id: "boss-old-rejected-test", policyId: v1.id, policyVersion: 1, category: "procurement", reasonCode: "role-procurement",
    basis: "duties", observedAt: "2026-09-10T01:00:00Z", filteredAt: "2026-09-11T00:00:00Z",
  }] };
  await atomicJson(join(root, "role-exclusions.json"), policy);
  await atomicJson(join(root, "role-exclusions-history.json"), original);
  const context = await loadRoleContext(root, { roleExclusionsVersion: 2 });
  assert.deepEqual(context.history, original);
  await rememberRoleExclusions(root, context, [{
    id: "boss-new-engineering-test", category: "technical-function", reasonCode: "role-technical-function",
    basis: "requirements", observedAt: "2026-09-11T01:00:00Z",
  }], "2026-09-11T02:00:00Z");
  const updated = validateRoleHistory(await readJson(join(root, "role-exclusions-history.json")));
  assert.deepEqual(updated.entries[0], original.entries[0]);
  assert.equal(updated.entries[1].policyVersion, 2);
  assert.equal(updated.entries[1].policyId, "role-feedback-v2");
  await assert.rejects(loadRoleContext(root, { roleExclusionsVersion: 1 }), { code: "role-policy-version-mismatch" });
  await atomicJson(join(root, "role-exclusions.json"), v1);
  await assert.rejects(loadRoleContext(root, { roleExclusionsVersion: 2 }), { code: "role-policy-version-mismatch" });
  await assert.rejects(loadRoleContext(root, { roleExclusionsVersion: 1 }), { code: "role-policy-version-mismatch" });
});
