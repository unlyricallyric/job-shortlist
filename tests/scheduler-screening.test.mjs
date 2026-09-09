import test from "node:test";
import assert from "node:assert/strict";
import { validateSnapshot } from "../docs/model.mjs";
import { cardReadPriority, parseJobSections, prefilterCard, screenJob, validateMatchingConfig } from "../scheduler/screening.mjs";

const TEST_ONLY_DIRECTIONS = [
  "区域市场", "伙伴营销", "需求生成", "伙伴发展", "生态商业化", "销售开发",
  "销售运营", "客户成功", "产品市场", "品牌活动", "渠道销售", "大客户销售",
];
const TEST_ONLY_CAPABILITIES = [
  "b2bMarketing", "partnerMarketing", "fieldEvents", "demandGeneration", "marketingOps",
  "customerSuccess", "partnerDevelopment", "productMarketing", "brandEvents", "contentSeo",
  "portfolio", "aiTools", "teamLeadership", "budgetOwnership", "closingSales",
  "pricingStrategy", "isvEngineering", "technicalDevelopment",
];
const TEST_ONLY_TIME = "2026-08-20T03:00:00.000Z";

function testConfig(overrides = {}) {
  return {
    version: 1,
    directions: [...TEST_ONLY_DIRECTIONS],
    confirmedCapabilities: ["b2bMarketing", "partnerMarketing", "fieldEvents", "demandGeneration", "productMarketing"],
    years: { marketing: null, b2b: null, partner: null, events: null, management: null, technical: null },
    education: null,
    ...overrides,
  };
}

function testRecord(overrides = {}) {
  return {
    id: "boss-TEST_ONLY_JOB",
    title: "TEST_ONLY 市场合作经理",
    company: "TEST_ONLY 软件服务公司",
    location: "上海·浦东新区",
    experienceText: null,
    educationText: null,
    url: "https://www.zhipin.com/job_detail/TEST_ONLY_JOB.html",
    jd: "岗位职责：负责企业软件合作伙伴联合营销，组织联合市场活动，制作赋能内容。\n任职要求：具备伙伴营销经验，熟悉B2B企业软件。",
    retrievedAt: TEST_ONLY_TIME,
    ...overrides,
  };
}

function withRequirements(requirements, overrides = {}) {
  return testRecord({
    jd: `岗位职责：负责企业软件合作伙伴联合营销，组织联合市场活动。\n任职要求：${requirements}`,
    ...overrides,
  });
}

function assertSelected(result) {
  assert.equal(result.decision, "select", JSON.stringify(result));
  assert.ok(result.job);
  assert.equal(validateSnapshot({
    version: 1,
    generatedAt: TEST_ONLY_TIME,
    run: {
      source: "BOSS直聘", scope: "TEST_ONLY", mode: "单次采集",
      cardsReviewed: 1, detailsRead: 1, selectedCount: 1, newCount: 1,
    },
    jobs: [result.job],
  }).jobs[0], result.job);
  return result.job;
}

test("private matching configuration is exact, validated and returned unchanged", () => {
  const config = testConfig();
  assert.equal(validateMatchingConfig(config), config);
  assert.equal(validateMatchingConfig(testConfig({ confirmedCapabilities: [] })).education, null);
  assert.equal(validateMatchingConfig(testConfig({
    confirmedCapabilities: TEST_ONLY_CAPABILITIES,
    years: { ...config.years, marketing: 1.5, management: 0 },
    education: "doctor",
  })).years.marketing, 1.5);
  for (const invalid of [
    null, [], {}, { ...config, version: 2 }, { ...config, extra: true },
    { ...config, age: null }, { ...config, gender: null }, { ...config, marital: null },
    { ...config, english: null }, { ...config, directions: [] },
    { ...config, directions: ["TEST_ONLY_UNKNOWN"] },
    { ...config, directions: ["伙伴营销", "伙伴营销"] },
    { ...config, confirmedCapabilities: ["TEST_ONLY_UNKNOWN"] },
    { ...config, confirmedCapabilities: ["portfolio", "portfolio"] },
    { ...config, confirmedCapabilities: "portfolio" },
    { ...config, confirmedCapabilities: Array(1) },
    { ...config, directions: Array(1) },
    { ...config, years: { marketing: null } },
    { ...config, years: { ...config.years, sales: null } },
    { ...config, years: { ...config.years, marketing: -1 } },
    { ...config, years: { ...config.years, marketing: Infinity } },
    { ...config, years: { ...config.years, marketing: NaN } },
    { ...config, years: { ...config.years, marketing: "3" } },
    { ...config, education: "TEST_ONLY_UNKNOWN" },
  ]) assert.throws(() => validateMatchingConfig(invalid), /Invalid matching config:/u);
  assert.throws(() => prefilterCard(testRecord(), { ...config, extra: true }), /Invalid matching config/u);
  assert.throws(() => screenJob(testRecord(), { ...config, extra: true }), /Invalid matching config/u);
});

test("card prefilter retains plausible generic and technical marketing titles for full JD inspection", () => {
  for (const title of [
    "TEST_ONLY 业务发展经理", "TEST_ONLY 生态运营", "TEST_ONLY FPGA产品市场经理",
    "TEST_ONLY 云计算营销经理", "TEST_ONLY AI技术营销", "TEST_ONLY ISV伙伴合作", null,
  ]) assert.deepEqual(prefilterCard(testRecord({ title }), testConfig()), { eligible: true, reason: "full-jd-required" });
  for (const title of ["TEST_ONLY FPGA研发工程师", "TEST_ONLY 后端开发工程师", "TEST_ONLY Software Engineer"]) {
    assert.equal(prefilterCard(testRecord({ title }), testConfig()).reason, "role-unrelated");
  }
  for (const title of ["TEST_ONLY 市场实习生", "TEST_ONLY 在校生兼职", "TEST_ONLY Marketing Intern"]) {
    assert.equal(prefilterCard(testRecord({ title }), testConfig()).reason, "student-only");
  }
});

test("canonical BOSS identity must be exact and match the URL", () => {
  for (const changes of [
    { id: "TEST_ONLY_JOB" }, { id: "boss-TEST_ONLY_OTHER" },
    { url: "https://www.zhipin.com/job_detail/TEST_ONLY_JOB.html?tracking=TEST_ONLY" },
    { url: "https://www.zhipin.com/job_detail/TEST_ONLY_JOB.html#TEST_ONLY" },
    { url: "http://www.zhipin.com/job_detail/TEST_ONLY_JOB.html" },
    { url: "https://www.zhipin.com.example.invalid/job_detail/TEST_ONLY_JOB.html" },
    { url: "https://user@www.zhipin.com/job_detail/TEST_ONLY_JOB.html" },
    { url: "https://www.zhipin.com:443/job_detail/TEST_ONLY_JOB.html" },
    { id: "boss-TEST_ONLY_JOB\n", url: "https://www.zhipin.com/job_detail/TEST_ONLY_JOB\n.html" },
  ]) {
    assert.equal(prefilterCard(testRecord(changes), testConfig()).eligible, false);
    assert.equal(screenJob(testRecord(changes), testConfig()).decision, "review");
  }
});

test("selection is driven by responsibilities rather than a flattering title", () => {
  const record = testRecord({ title: "TEST_ONLY 通用岗位" });
  assert.equal(assertSelected(screenJob(record, testConfig())).category, "伙伴营销");
  const unsupported = testRecord({
    title: "TEST_ONLY 伙伴营销经理",
    jd: "岗位职责：负责仓库收货和货物盘点。\n任职要求：经验不限，学历不限。",
  });
  assert.equal(screenJob(unsupported, testConfig()).decision, "reject");
  const sales = testRecord({
    title: "TEST_ONLY 伙伴营销经理",
    jd: "岗位职责：拓展渠道合作伙伴，独立承担销售额指标，完成客户合同签约。\n任职要求：具备渠道销售经验。",
  });
  assert.equal(screenJob(sales, testConfig({ directions: ["伙伴营销"] })).decision, "reject");
  assert.equal(screenJob(sales, testConfig()).decision, "review");
  assert.equal(assertSelected(screenJob(sales, testConfig({ confirmedCapabilities: ["closingSales"] }))).category, "渠道销售");
  assert.equal(screenJob(testRecord({
    jd: "岗位职责：负责合作伙伴联合营销，负责合作伙伴销售额指标。\n任职要求：具备伙伴营销经验。",
  }), testConfig({ directions: ["伙伴营销"] })).decision, "reject");
});

test("supported directions use their own duty evidence and capabilities", () => {
  for (const [category, duties] of [
    ["区域市场", "负责华东区域市场推广及市场活动"],
    ["伙伴营销", "负责合作伙伴联合市场活动"],
    ["需求生成", "负责B2B需求生成及营销pipeline建设"],
    ["伙伴发展", "负责拓展合作伙伴网络"],
    ["生态商业化", "负责B2B生态商业化方案落地"],
    ["销售开发", "负责商机初筛，开发潜在客户"],
    ["销售运营", "负责销售运营及CRM管理"],
    ["客户成功", "负责企业客户成功与客户留存"],
    ["产品市场", "负责产品定位与上市推广"],
    ["品牌活动", "负责品牌活动策划和传播"],
    ["渠道销售", "负责渠道销售，独立承担销售额目标"],
    ["大客户销售", "负责大客户销售，独立承担个人成交目标"],
  ]) {
    const record = testRecord({ jd: `岗位职责：${duties}。\n任职要求：具备相关工作经验。` });
    const config = testConfig({ confirmedCapabilities: TEST_ONLY_CAPABILITIES });
    assert.equal(assertSelected(screenJob(record, config)).category, category);
    assert.equal(screenJob(record, { ...config, confirmedCapabilities: [] }).decision, "review");
  }
});

test("Chinese heading variants and separately collected sections are supported", () => {
  for (const dutyHeading of ["岗位职责", "工作职责", "职位描述"]) {
    for (const requirementHeading of ["任职要求", "职位要求", "岗位要求", "任职资格"]) {
      assertSelected(screenJob(testRecord({
        jd: `【${dutyHeading}】\n负责合作伙伴联合营销。\n二、${requirementHeading}：\n具备伙伴营销经验。`,
      }), testConfig()));
    }
  }
  assertSelected(screenJob(testRecord({
    jd: "TEST_ONLY 原始全文：负责伙伴联合营销。具备伙伴营销经验。",
    responsibilitiesText: "负责合作伙伴联合营销。",
    requirementsText: "具备伙伴营销经验。",
  }), testConfig()));
  assertSelected(screenJob(testRecord({
    jd: "工作职责：负责合作伙伴联合营销。\n任职资格：具备伙伴营销经验。\n福利待遇：TEST_ONLY 无关福利内容。",
  }), testConfig()));
});

test("observed descriptive and capability headings normalize presentation glyphs without mutating evidence", () => {
  for (const [duty, requirement] of [
    ["岗位基本描述", "希望你具备能力"],
    ["⼯作职责", "任职资格"],
    ["工作内容", "希望你具备的能力"],
  ]) {
    const record = testRecord({
      jd: `公司介绍：TEST_ONLY介绍。\n【${duty}】：\n１-负责企业软件合作伙伴联合营销。\n２-组织伙伴活动与赋能。\n【${requirement}】：\n１-具备伙伴营销经验。\n加分技能：\n有SEO经验。\n必备条件：\n必须具备团队管理经验。`,
    });
    const before = structuredClone(record);
    const parts = parseJobSections(record);
    assert.match(parts.duties, /负责企业软件合作伙伴联合营销/);
    assert.doesNotMatch(parts.duties, /TEST_ONLY介绍/);
    assert.match(parts.requirements, /加分项：\n有SEO/);
    const result = screenJob(record, testConfig());
    assert.equal(result.decision, "review");
    assert.ok(result.reasons.includes("capability-unconfirmed"));
    assert.ok(!result.reasons.includes("requirements-unseparated"));
    assert.deepEqual(record, before);
  }
});

test("numbered responsibilities before an explicit requirement heading preserve all qualification bullets", () => {
  const record = testRecord({
    jd: "1、负责企业软件合作伙伴联合营销。\n2.组织伙伴市场活动。\n3-参与渠道赋能。\n4.医疗行业经验优先。\n5.必须具备团队管理经验。\n任职要求\n1.具备伙伴营销经验。",
  });
  const parts = parseJobSections(record);
  assert.match(parts.duties, /组织伙伴市场活动/);
  assert.doesNotMatch(parts.duties, /医疗行业经验/);
  assert.match(parts.requirements, /医疗行业经验优先/);
  assert.match(parts.requirements, /必须具备团队管理经验/);
  const result = screenJob(record, testConfig());
  assert.equal(result.decision, "review");
  assert.ok(result.reasons.includes("capability-unconfirmed"));
  assert.ok(!result.reasons.includes("requirements-unseparated"));
  assertSelected(screenJob({ ...record, jd: record.jd.replace("5.必须具备团队管理经验。\n", "") }, testConfig()));
  for (const prefix of [
    "负责企业软件伙伴营销，具备丰富行业资源。",
    "1.具备伙伴营销经验。\n2.团队管理优先。",
    "1.负责伙伴联合营销。",
  ]) {
    assert.equal(screenJob(testRecord({ jd: `${prefix}\n任职要求：具备伙伴营销经验。` }), testConfig()).decision, "review");
  }
});

test("new section variants do not bypass revenue, specialist or engineering requirements", () => {
  for (const requirement of ["必须具备FPGA研发经验", "必须独立承担销售额指标", "必须具备医疗器械行业伙伴营销能力"]) {
    const result = screenJob(testRecord({
      jd: `岗位基本描述：负责合作伙伴联合营销。\n希望你具备能力：具备伙伴营销经验；${requirement}。`,
    }), testConfig());
    assert.equal(result.decision, "review");
    assert.ok(!result.reasons.includes("requirements-unseparated"));
  }
});

test("card reading priority favors configured duty families without changing eligibility or assigning a category", () => {
  const config = testConfig();
  const generic = testRecord({ title: "市场经理" });
  const specific = testRecord({ title: "渠道市场经理" });
  const sales = testRecord({ title: "行业客户经理" });
  assert.ok(cardReadPriority(specific, config) > cardReadPriority(generic, config));
  assert.ok(cardReadPriority(generic, config) > cardReadPriority(sales, config));
  assert.ok(prefilterCard(generic, config).eligible);
  assert.ok(prefilterCard(sales, config).eligible);
  assert.equal(generic.category, undefined);
});

test("missing, unseparated or merely soft requirements cannot produce success", () => {
  for (const jd of [
    "",
    "负责合作伙伴联合营销，具备伙伴营销经验。",
    "岗位职责：负责合作伙伴联合营销。",
    "职位描述：负责合作伙伴联合营销，要求具备伙伴营销经验。",
    "岗位职责：负责合作伙伴联合营销。\n任职要求：",
    "岗位职责：负责合作伙伴联合营销。\n任职要求：良好沟通能力和团队合作意识。",
    "岗位职责：负责合作伙伴联合营销。\n任职要求：伙伴营销经验优先。",
  ]) {
    const result = screenJob(testRecord({ jd }), testConfig());
    assert.equal(result.decision, "review", jd);
    assert.equal(result.job, null);
  }
  assert.equal(screenJob(testRecord({ requirementsText: 42 }), testConfig()).decision, "review");
  assert.equal(screenJob(testRecord({
    jd: "岗位职责：负责合作伙伴联合营销。\n任职要求：良好沟通能力。",
    experienceText: "经验不限",
    educationText: "学历不限",
  }), testConfig()).decision, "review");
});

test("explicitly unknown capabilities remain review, not proven qualification", () => {
  const result = screenJob(testRecord(), testConfig({ confirmedCapabilities: [] }));
  assert.equal(result.decision, "review");
  assert.ok(result.reasons.includes("capability-unconfirmed"));
  assert.equal(result.job, null);
});

test("hard and preferred requirements have different scopes", () => {
  const optional = withRequirements("具备伙伴营销经验；SEO经验优先；团队管理经验加分；硕士优先；十年以上市场经验优先。");
  assert.ok(assertSelected(screenJob(optional, testConfig())).concerns.some((text) => text.includes("优先条件")));
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；必须具备SEO经验。"), testConfig()).decision, "review");
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；必须具备SEO经验者优先。"), testConfig()).decision, "review");
  assertSelected(screenJob(withRequirements("具备伙伴营销经验。\n加分项：\n有团队管理经验。\n有SEO经验。"), testConfig()));
  assert.equal(screenJob(withRequirements("具备伙伴营销经验。\n加分项：\n有SEO经验。\n必备条件：\n团队管理经验。"), testConfig()).decision, "review");
  assertSelected(screenJob(withRequirements("具备伙伴营销经验；无需团队管理经验；不要求SEO经验。"), testConfig()));
  assertSelected(screenJob(withRequirements("具备伙伴营销经验；SEO经验非必需；团队管理不做硬性要求。"), testConfig()));
  for (const text of [
    "无需学历但有十年市场经验",
    "无需学历且有十年市场经验",
    "无需学历，只需十年市场经验",
  ]) assert.equal(screenJob(withRequirements(`具备伙伴营销经验；${text}。`), testConfig()).decision, "review");
});

test("unrestricted education never exempts a required leadership or experience qualification", () => {
  const config = testConfig();
  for (const required of [
    "必须具备团队管理经验（学历不限）",
    "必须具备团队管理经验(不限学历)",
    "必须具备十年以上市场营销经验（学历不限）",
    "必须具备十年以上市场营销经验(不限经验)",
    "不要求学历但必须具备团队管理经验",
    "不要求学历须有三年团队管理经验",
    "必须具备团队管理经验学历不限",
  ]) {
    const result = screenJob(withRequirements(`具备伙伴营销经验；${required}`), config);
    assert.equal(result.decision, "review", required);
    assert.equal(result.job, null);
  }
  assertSelected(screenJob(withRequirements("具备伙伴营销经验（学历不限）；无需团队管理经验"), config));
  const result = screenJob(withRequirements("具备伙伴营销经验；必须具备三年市场营销经验（学历不限）"),
    testConfig({ years: { ...config.years, marketing: 1 } }));
  assert.equal(result.decision, "reject");
  assert.ok(result.reasons.includes("years-insufficient"));
});

test("mandatory industry specialization is assessed independently from a generic matching capability", () => {
  for (const requirement of [
    "必须具备医疗器械行业伙伴营销经验",
    "必须具备医疗器械行业伙伴营销能力",
    "具备医疗器械伙伴营销经验",
    "具备半导体领域伙伴营销经验",
    "必须具备企业软件行业伙伴营销经验",
    "熟悉金融行业客户且具备伙伴营销经验",
  ]) {
    const result = screenJob(withRequirements(`具备伙伴营销经验；${requirement}`), testConfig());
    assert.equal(result.decision, "review", requirement);
    assert.ok(result.reasons.includes("industry-specialization-unconfirmed"), requirement);
    assert.equal(result.job, null);
  }
  for (const requirement of ["医疗器械行业伙伴营销经验优先", "医疗器械行业伙伴营销能力优先",
    "半导体领域经验加分", "无需医疗器械行业经验", "无需医疗器械行业伙伴营销能力"]) {
    assertSelected(screenJob(withRequirements(`具备伙伴营销经验；${requirement}`), testConfig()));
  }
  assertSelected(screenJob(withRequirements("具备伙伴营销经验；熟悉B2B企业软件"), testConfig()));
});

test("numeric years are exact, dimensioned and never inferred from a capability", () => {
  const base = testConfig();
  for (const [text, dimension, minimum] of [
    ["至少8年市场营销经验", "marketing", 8],
    ["十年以上市场营销经验", "marketing", 10],
    ["三至五年伙伴营销经验", "partner", 3],
    ["两年以上活动策划经验", "events", 2],
    ["十一年以上B2B市场经验", "b2b", 11],
    ["叁年以上市场营销经验", "marketing", 3],
    ["３年以上市场营销经验", "marketing", 3],
    ["3.5年以上市场营销经验", "marketing", 3.5],
    ["at least 4 years of marketing experience", "marketing", 4],
  ]) {
    const record = withRequirements(`具备伙伴营销经验；${text}。`);
    const unknown = screenJob(record, base);
    assert.equal(unknown.decision, "review", text);
    assert.ok(unknown.reasons.includes("years-unconfirmed"), text);
    assert.equal(screenJob(record, testConfig({ years: { ...base.years, [dimension]: minimum - 0.5 } })).decision, "reject", text);
    assertSelected(screenJob(record, testConfig({ years: { ...base.years, [dimension]: minimum } })));
  }
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；拥有丰富市场营销经验。"), base).decision, "review");
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；三五年市场营销经验。"), base).decision, "review");
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；超过3年市场经验。"), testConfig({ years: { ...base.years, marketing: 3 } })).decision, "reject");
  for (const [requirement, value, expected] of [
    ["不满3年市场经验", 3, "reject"],
    ["不满3年市场经验", 2, "select"],
    ["最多3年市场经验", 3, "select"],
    ["最多3年市场经验", 4, "reject"],
    ["not more than 3 years of marketing experience", 3, "select"],
    ["不少于3年市场经验", 2, "reject"],
    ["不少于3年市场经验", 4, "select"],
    ["不得超过3年市场经验", 4, "reject"],
  ]) {
    assert.equal(screenJob(withRequirements(`具备伙伴营销经验；${requirement}。`), testConfig({
      years: { ...base.years, marketing: value },
    })).decision, expected, requirement);
  }
});

test("separate total and management year gates are not conflated", () => {
  const config = testConfig({
    confirmedCapabilities: [...TEST_ONLY_CAPABILITIES],
    years: { ...testConfig().years, marketing: 10, management: 2 },
  });
  const record = withRequirements("具备伙伴营销经验；十年以上市场经验，其中三年以上团队管理经验。");
  assert.equal(screenJob(record, config).decision, "reject");
  assertSelected(screenJob(record, { ...config, years: { ...config.years, management: 3 } }));
  assert.equal(screenJob(record, { ...config, years: { ...config.years, management: null } }).decision, "review");
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；团队管理至少三年。"), {
    ...config, years: { ...config.years, management: null },
  }).decision, "review");
});

test("ambiguous or unsupported year dimensions cannot borrow unrelated years", () => {
  const config = testConfig({
    confirmedCapabilities: TEST_ONLY_CAPABILITIES,
    years: { marketing: 4, b2b: 4, partner: 1, events: 4, management: 4, technical: 4 },
    education: "bachelor",
  });
  for (const requirement of [
    "三年以上SEO经验",
    "三年以上预算管理经验",
    "三年客户成功经验",
    "管理经验三年以上",
    "三年以上管理经验",
    "3 years of management experience",
    "过去三年有伙伴营销经验",
    "三年以上市场或伙伴营销经验",
    "本科毕业三年以上",
  ]) {
    const result = screenJob(withRequirements(`具备伙伴营销经验；${requirement}。`), config);
    assert.equal(result.decision, "review", requirement);
  }
});

test("card experience and education are assessed without replacing original text", () => {
  const record = testRecord({ experienceText: "5-10年", educationText: "硕士及以上" });
  assert.equal(screenJob(record, testConfig()).decision, "review");
  const config = testConfig({ years: { ...testConfig().years, marketing: 5 }, education: "master" });
  const job = assertSelected(screenJob(record, config));
  assert.equal(job.experienceText, record.experienceText);
  assert.equal(job.educationText, record.educationText);
  assert.equal(screenJob(record, { ...config, education: "bachelor" }).decision, "reject");
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；本科及以上，计算机相关专业。"), config).decision, "review");
  assertSelected(screenJob(withRequirements("具备伙伴营销经验；学历不限，经验不限。"), testConfig()));
});

test("leadership, substantial budget ownership and portfolios require confirmed capabilities", () => {
  for (const [requirement, capability] of [
    ["具有团队管理经验", "teamLeadership"],
    ["有年度营销预算管理经验", "budgetOwnership"],
    ["须提供作品集", "portfolio"],
    ["能够独立负责SEO", "contentSeo"],
    ["能够独立制定定价架构", "pricingStrategy"],
    ["具备AI工具使用能力", "aiTools"],
    ["具备ISV研发交付资源", "isvEngineering"],
    ["有ISV研发资源", "isvEngineering"],
  ]) {
    const record = withRequirements(`具备伙伴营销经验；${requirement}。`);
    assert.equal(screenJob(record, testConfig()).decision, "review", requirement);
    assertSelected(screenJob(record, testConfig({
      confirmedCapabilities: [...testConfig().confirmedCapabilities, capability],
    })));
  }
  for (const duty of ["独立管理营销团队", "独立负责年度营销预算", "负责合作伙伴年度预算", "独立负责SEO", "独立制定定价架构", "提供自有ISV研发团队资源"]) {
    const record = testRecord({
      jd: `岗位职责：负责合作伙伴联合营销；${duty}。\n任职要求：具备伙伴营销经验。`,
    });
    assert.equal(screenJob(record, testConfig()).decision, "review", duty);
  }
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；独立管理三人团队；负责1000万元年度预算。"), testConfig({
    confirmedCapabilities: [...TEST_ONLY_CAPABILITIES],
  })).decision, "review");
  for (const requirement of ["负责5000万的市场预算", "拥有成熟ISV伙伴资源"]) {
    assert.equal(screenJob(withRequirements(`具备伙伴营销经验；${requirement}。`), testConfig({
      confirmedCapabilities: [...TEST_ONLY_CAPABILITIES],
    })).decision, "review");
  }
});

test("collaboration, routine budget tracking and developer audiences are not ownership or coding", () => {
  const record = testRecord({
    jd: "岗位职责：负责企业软件合作伙伴联合营销；与ISV研发团队协作制作面向开发者的赋能内容；协同销售跟进MQL到SQL转化；负责活动预算跟踪。\n任职要求：具备伙伴营销经验；具备良好沟通和团队协作能力。",
  });
  assertSelected(screenJob(record, testConfig()));
  for (const duty of [
    "与ISV研发团队协作提供培训材料",
    "为ISV研发团队提供营销内容",
    "公司提供ISV研发资源支持",
    "与SEO团队协作制作传播内容",
    "协调ISV研发团队提供产品市场内容",
  ]) assertSelected(screenJob(testRecord({
    jd: `岗位职责：负责合作伙伴联合营销；${duty}。\n任职要求：具备伙伴营销经验。`,
  }), testConfig()));
});

test("collaboration elsewhere in a clause cannot hide a genuine hard gate", () => {
  for (const requirement of [
    "具备团队管理和跨部门协作经验",
    "熟悉SEO并善于团队协作",
    "熟悉SQL并具备协作能力",
    "须提供作品集和良好沟通能力",
    "具备伙伴营销经验以及持有航空执照",
  ]) assert.equal(screenJob(withRequirements(`具备伙伴营销经验；${requirement}。`), testConfig()).decision, "review");
});

test("FPGA engineering, standalone pricing and ISV resources do not become partner marketing by title", () => {
  for (const responsibilities of [
    "负责FPGA研发，编写Verilog代码。",
    "独立制定定价架构和价格体系。",
    "提供自有ISV工程研发团队资源。",
  ]) {
    const record = testRecord({
      title: "TEST_ONLY 伙伴营销经理",
      jd: `岗位职责：${responsibilities}\n任职要求：具备伙伴营销经验。`,
    });
    assert.notEqual(screenJob(record, testConfig({ confirmedCapabilities: TEST_ONLY_CAPABILITIES })).decision, "select");
  }
  assertSelected(screenJob(testRecord({
    title: "TEST_ONLY FPGA产品市场经理",
    jd: "岗位职责：负责FPGA产品定位与上市推广；与研发团队协作制作产品内容。\n任职要求：具备产品市场经验。",
  }), testConfig()));
  assert.equal(screenJob(testRecord({
    jd: "岗位职责：负责FPGA产品定位与上市推广。\n任职要求：具备产品市场经验，必须有FPGA研发经验。",
  }), testConfig({ confirmedCapabilities: TEST_ONLY_CAPABILITIES })).decision, "review");
});

test("SQL marketing pipeline is not SQL programming or closed-revenue ownership", () => {
  for (const responsibilities of [
    "负责B2B需求生成，提升MQL→SQL转化，协同销售跟进商机管道。",
    "负责线索培育，跟进sales-qualified leads和pipeline。",
  ]) {
    const job = assertSelected(screenJob(testRecord({
      jd: `岗位职责：${responsibilities}\n任职要求：具备需求生成经验。`,
    }), testConfig()));
    assert.equal(job.category, "需求生成");
  }
  for (const requirement of ["必须熟练编写SQL查询", "掌握SQL编程与数据库", "熟悉SQL"]) {
    const record = withRequirements(`具备伙伴营销经验；${requirement}。`);
    assert.equal(screenJob(record, testConfig()).decision, "review");
  }
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；熟悉MQL到SQL转化并编写SQL查询。"), testConfig()).decision, "review");
});

test("English, age, gender and family statements are not matching gates", () => {
  for (const statement of [
    "必须英语流利，可用英文沟通",
    "English fluency is required",
    "国际团队使用英语作为工作语言",
    "年龄要求以岗位说明为准",
    "性别要求以岗位说明为准",
    "婚姻家庭状况以岗位说明为准",
    "CET-6",
    "雅思7分",
    "35周岁以下",
    "仅限男性",
    "女性",
    "已育",
  ]) assertSelected(screenJob(withRequirements(`具备伙伴营销经验；${statement}。`), testConfig()));
});

test("Shanghai must be explicit and contradictory duty locations cannot be ignored", () => {
  for (const location of ["上海", "上海/北京/深圳", "北京、上海任选", "Shanghai"]) {
    assertSelected(screenJob(testRecord({ location }), testConfig()));
  }
  for (const location of ["北京", "深圳·南山区", "苏州（上海周边）", "非上海", "海外"]) {
    assert.equal(prefilterCard(testRecord({ location }), testConfig()).eligible, false);
    assert.equal(screenJob(testRecord({ location }), testConfig()).decision, "reject");
  }
  for (const location of [null, "华东", "全国远程"]) {
    assert.equal(prefilterCard(testRecord({ location }), testConfig()).eligible, true);
    assert.equal(screenJob(testRecord({ location }), testConfig()).decision, "review");
  }
  assertSelected(screenJob(testRecord({
    location: null, jd: `${testRecord().jd}\n工作地点：上海或北京。`,
  }), testConfig()));
  assert.equal(screenJob(testRecord({ jd: `${testRecord().jd}\n工作地点：北京。` }), testConfig()).decision, "reject");
  assert.equal(screenJob(testRecord({
    jd: "TEST_ONLY 未分区正文。工作地为北京。",
  }), testConfig()).decision, "reject");
  assertSelected(screenJob(testRecord({
    jd: "岗位职责：负责合作伙伴联合营销；组织北京客户线上活动。\n任职要求：具备伙伴营销经验。",
  }), testConfig()));
});

test("student-only full-JD requirements reject while preferred graduate conditions do not", () => {
  assert.equal(screenJob(withRequirements("具备伙伴营销经验；仅限在校学生。"), testConfig()).decision, "reject");
  assertSelected(screenJob(withRequirements("具备伙伴营销经验；应届毕业生优先。"), testConfig()));
});

test("full-JD observation time is required and validated without inventing publication times", () => {
  for (const retrievedAt of [undefined, null, "2026-08-20", "2026-02-30T03:00:00Z", "2026-08-20T25:00:00Z", "TEST_ONLY_INVALID"]) {
    const result = screenJob(testRecord({ retrievedAt }), testConfig());
    assert.equal(result.decision, "review");
    assert.equal(result.job, null);
  }
  const job = assertSelected(screenJob(testRecord({ publishedAt: "TEST_ONLY_IGNORED" }), testConfig()));
  assert.equal(job.firstSeen, TEST_ONLY_TIME);
  assert.equal(job.lastSeen, TEST_ONLY_TIME);
  assert.equal(job.publishedAt, null);
});

test("public output is a v1 allowlist of generic paraphrases, not JD excerpts or private data", () => {
  const sentinel = "TEST_ONLY_RAW_JD_DO_NOT_PUBLISH";
  const record = testRecord({
    jd: `${testRecord().jd}\n福利待遇：${sentinel}。\n联系人：TEST_ONLY_RECRUITER；邮箱：test-only@example.invalid；微信：TEST_ONLY_CONTACT_TOKEN。`,
    recruiter: "TEST_ONLY_RECRUITER",
    privateNotes: "TEST_ONLY_PRIVATE_CONFIG",
    matchReasons: ["TEST_ONLY_UNTRUSTED"],
    salaryMinK: 123, salaryMaxK: 456, salaryMonths: 78,
  });
  const config = testConfig();
  const before = structuredClone({ record, config });
  const result = screenJob(record, config);
  const job = assertSelected(result);
  const serialized = JSON.stringify(result);
  for (const value of [sentinel, "TEST_ONLY_RECRUITER", "test-only@example.invalid", "TEST_ONLY_CONTACT_TOKEN", "TEST_ONLY_PRIVATE_CONFIG", "TEST_ONLY_UNTRUSTED", "confirmedCapabilities"]) {
    assert.ok(!serialized.includes(value), value);
  }
  assert.ok(!serialized.includes("负责企业软件合作伙伴联合营销"));
  assert.equal(job.source, "BOSS直聘");
  assert.equal(job.priority, "有条件匹配");
  assert.ok(Number.isInteger(job.matchScore) && job.matchScore <= 85);
  assert.equal(job.languageNote, "工作语言以原始岗位为准，不据此排除国际团队");
  assert.equal(job.jdRead, true);
  assert.equal(job.isNew, true);
  for (const field of ["title", "company", "location", "experienceText", "educationText", "url"]) assert.equal(job[field], record[field]);
  for (const field of ["salaryText", "salaryMinK", "salaryMaxK", "salaryMonths"]) assert.equal(job[field], null);
  assert.deepEqual({ record, config }, before);
  assert.deepEqual(screenJob(record, config), result);
});

test("unstructured or contact-bearing metadata is quarantined, never copied into a public job", () => {
  for (const changes of [
    { title: "TEST_ONLY 岗位\n任职要求：TEST_ONLY 原文" },
    { title: "TEST_ONLY 岗位 任职要求：TEST_ONLY 原文" },
    { company: "TEST_ONLY 联系人：TEST_ONLY_RECRUITER" },
    { location: "上海 邮箱：test-only@example.invalid" },
    { company: "TEST_ONLY test-only＠example.invalid" },
    { company: "TEST_ONLY 电话：010-00000000" },
    { experienceText: { raw: "TEST_ONLY 原文" } },
    { educationText: ["TEST_ONLY 原文"] },
    { title: "TEST_ONLY \ue001" },
  ]) {
    const result = screenJob(testRecord(changes), testConfig());
    assert.equal(result.decision, "review");
    assert.equal(result.job, null);
    assert.ok(result.reasons.includes("card-metadata-invalid"));
  }
});

test("salary is only preserved as genuinely readable text; PUA and numeric inventions stay null", () => {
  for (const salaryText of ["20-30K·13薪", "薪资面议", "2-3万元/月"]) {
    const job = assertSelected(screenJob(testRecord({ salaryText }), testConfig()));
    assert.equal(job.salaryText, salaryText);
    assert.equal(job.salaryMinK, null);
    assert.equal(job.salaryMaxK, null);
    assert.equal(job.salaryMonths, null);
  }
  for (const salaryText of [null, undefined, "\ue123-\ue456K", "20-\ue456K", "TEST_ONLY_UNREADABLE", "20K 联系人：TEST_ONLY_RECRUITER", "20K TEST_ONLY_RAW_JD"]) {
    assert.equal(assertSelected(screenJob(testRecord({ salaryText }), testConfig())).salaryText, null);
  }
});

test("oversized or unreadable requirements safely route to review", () => {
  for (const requirements of [
    "TEST_ONLY ".repeat(120),
    "9".repeat(1200),
    "具备伙伴营销经验；需具备\ue001年市场经验。",
    Array.from({ length: 205 }, () => "具备伙伴营销经验").join("；"),
  ]) {
    const result = screenJob(withRequirements(requirements), testConfig());
    assert.equal(result.decision, "review");
    assert.equal(result.job, null);
  }
});
