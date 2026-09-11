import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";
import { feedbackRolePolicy, assessRoleExclusion, loadRoleContext, emptyRoleHistory, validateRolePolicy,
  rememberRoleExclusions, validateRoleHistory } from "../scheduler/role-exclusions.mjs";
import { buildCandidateSnapshot, filterRoleCandidates } from "../scheduler/candidates.mjs";
import { emptyReviewQueue, updateReviewQueue, saveReviewQueue, approveReviews } from "../scheduler/review.mjs";
import { defaultIntentPolicy, modeSettings, candidateMode } from "../scheduler/intent.mjs";
import { atomicJson, readJson } from "../scheduler/io.mjs";
import { publishCandidates, publishCaptured, publishRoleCleanup, retryCandidatePublication } from "../scheduler/publish-candidates.mjs";
import { publishReviewed } from "../scheduler/publish-reviewed.mjs";
import { run, initialState } from "../scheduler/runner.mjs";
import { candidateLimits, loadConfiguration } from "../scheduler/config.mjs";
import { validateSnapshot } from "../docs/model.mjs";

const policy = feedbackRolePolicy(), intent = defaultIntentPolicy();
const at = "2026-09-10T01:00:00.000Z", now = "2026-09-11T00:00:00.000Z";
const jd = (duties, rest = "具备相关业务沟通和协作能力，能够根据实际工作要求完成职责，具体条件需要进一步确认。") =>
  `岗位职责：\n${duties}\n任职要求：\n${rest}`;
const partnerDuties = "负责招募代理伙伴并推进伙伴准入。\n主导伙伴赋能和经销商经营，对伙伴转售指标负责，不承担直接客户成交。";
const directDuties = "负责独立开发终端客户与自主拓展新客户，拥有自己的客户资源。\n主导商务谈判、合同签署和回款，承担个人销售配额。";
const card = (name, title = "渠道经理", extra = {}) => ({
  id: `boss-feedback-test-${name}`, url: `https://www.zhipin.com/job_detail/feedback-test-${name}.html`,
  title, company: "TEST_ONLY_COMPANY", source: "BOSS直聘", location: "上海", educationText: null,
  experienceText: "5-10年", salaryText: null, retrievedAt: at, ...extra,
});
const queueOf = (records) => updateReviewQueue(emptyReviewQueue(), records, records.map((item) => ({
  id: item.id, intent: { decision: "primary", family: "channel-management", reasons: ["test-only"] },
  qualification: { status: "pending", reasons: ["test-only"] },
})), "test-feedback-source");
const context = (history = emptyRoleHistory()) => ({ policy, history });
const evidenceOf = (records) => ({ complete: true, cards: records, details: records.filter((item) => item.jd), queries: [] });
const ledgerOf = (previous, records) => ({ version: 1,
  reviewedIds: [...new Set([...previous.jobs, ...records].map((item) => item.id))],
  detailIds: [...new Set([...previous.jobs.filter((item) => item.jdRead), ...records.filter((item) => item.jd)].map((item) => item.id))] });
const build = (records, { previous = snapshotOf([]), roles = undefined, queue = queueOf(records.filter((item) => item.jd)), ...options } = {}) =>
  buildCandidateSnapshot(previous, evidenceOf(records), queue, ledgerOf(previous, records), {
    policy: intent, roleContext: roles, runId: "test-feedback-source", sampledAt: at, now, ...options,
  });

test("explicit feedback types cover spaced/full-width and unseen titles, not years or industries", () => {
  for (const [category, titles] of [
    ["cockpit-project", ["座舱项目经理", "座舱大模型项目经理", "座 舱 项 目 经 理", "Cockpit Project Manager"]],
    ["marketing-leadership", ["市场总监", "市场总监（企业软件）", "ＣＭＯ", "Head of Marketing"]],
    ["entrepreneurial-partner", ["A I+云 计 算 合 伙 人", "跨境B2B事业合伙人", "股权合伙人", "Co-founder", "Managing Partner"]],
    ["executive-ownership", ["东南亚AIDC总经理", "合伙事业VP", "CEO Asia Pacific", "General Manager", "首席AI官"]],
    ["procurement", ["采购经理", "采 购 经 理", "Procurement Manager"]],
    ["frontline-sales", ["业务销售", "海外销售经理", "绝缘纸业务销售经理", "KA大客户销售", "系统集成大客户销售", "Account Executive"]],
  ]) for (const title of titles) {
    const record = card(`unseen-${title.length}`, title);
    assert.equal(assessRoleExclusion(record, policy)?.category, category, title);
  }
  for (const title of ["汽车行业渠道经理", "智能硬件伙伴发展经理", "合作伙伴经理", "Partner Development Representative",
    "Partner", "HR Business Partner", "渠道经理", "生态销售经理", "市场活动负责人", "销售运营经理"]) {
    assert.equal(assessRoleExclusion(card("positive", title, { experienceText: "5-10年" }), policy), null, title);
  }
});

test("title subject distinguishes actual leadership from reporting, support and prospective career paths", () => {
  for (const title of ["生态咨询专家（集团战略与高管支持）", "总经理助理", "市场总监助理", "生态经理（向CEO汇报）",
    "渠道专家（对接客户CTO）", "商务专员（对接采购经理）", "BDR（晋升通道市场总监）", "Executive Assistant to CEO"]) {
    assert.equal(assessRoleExclusion({ title, jd: jd("负责合作伙伴招募及联合销售。\n负责向总经理汇报工作。\n晋升通道：市场总监。",
      "需要与采购经理和CTO沟通，有向高管汇报经验优先。") }, policy), null, title);
  }
  assert.equal(assessRoleExclusion({ title: "市场总监（向CEO汇报）" }, policy).category, "marketing-leadership");
  assert.equal(assessRoleExclusion({ title: "业务负责人", jd: jd("出任公司总经理，对公司整体经营盈亏负责。\n负责协调部门预算和业务工作。") }, policy).category, "executive-ownership");
});

test("partner account roles and generic sales titles with reseller duties are not frontline by title", () => {
  for (const title of ["Channel Account Manager", "Partner Account Manager", "渠道大客户经理", "Customer Success Account Manager"]) {
    assert.equal(assessRoleExclusion({ title }, policy), null, title);
  }
  for (const title of ["区域销售经理", "云计算销售经理", "Sales Manager"]) assert.equal(assessRoleExclusion({ title }, policy), null, title);
  for (const title of ["区域销售经理", "Sales Manager", "渠道经理", "生态销售经理"]) {
    assert.equal(assessRoleExclusion({ title, jd: jd(partnerDuties) }, policy), null, title);
    assert.equal(assessRoleExclusion({ title, jd: jd(`${partnerDuties}\n${directDuties}`) }, policy)?.category, "frontline-sales", title);
  }
  for (const duties of [
    "负责独立拓展渠道客户和代理商、招募经销伙伴。\n主导代理合作合同谈判与签署。",
    "负责支持渠道伙伴自主开发终端客户。\n负责协助渠道伙伴完成客户合同签署。",
    "负责招募代理伙伴、开展伙伴赋能与联合销售。\n主导伙伴经营并对伙伴收入和转售业绩负责。",
    "负责渠道经营和伙伴招募，不负责直接开发终端客户。\n负责伙伴赋能，无需承担个人签约回款。",
    "独立或协同客户经理完成技术讲解、产品演示及招投标支持等全流程销售支持。\n主导解决方案技术谈判，推动项目签约与交付。",
  ]) assert.equal(assessRoleExclusion({ title: "渠道经理", jd: jd(duties) }, policy), null, duties);
});

test("English duties distinguish personally owned acquisition/closing from partner enablement", () => {
  const direct = "Responsibilities:\nOwn end-customer prospecting and full-cycle sales for new clients.\nLead contract negotiations, deal closing and payment collections.\nRequirements:\nRelevant communication experience.";
  const partner = "Responsibilities:\nRecruit channel partners and manage reseller targets.\nLead partner enablement and co-selling programs.\nSupport partners in acquiring new customers and closing deals.\nRequirements:\nRelevant communication experience.";
  for (const title of ["Business Development Manager", "Sales Manager", "Partner Account Manager"]) {
    assert.equal(assessRoleExclusion({ title, jd: direct }, policy)?.category, "frontline-sales", title);
    assert.equal(assessRoleExclusion({ title, jd: partner }, policy), null, title);
  }
});

test("procurement is assessed as an owned function, not selling software to purchasing stakeholders", () => {
  for (const duties of [
    "负责公司采购计划和供应商寻源比价。\n牵头采购成本控制及采购订单管理，并维护供应商合作关系。",
    "负责算力供应规划并建立供应商资源库。\n主导采购流程和采购管理体系建设。\n推动采购数字化建设与成本核算。",
  ]) assert.equal(assessRoleExclusion({ title: "供应链高级经理", jd: jd(duties) }, policy)?.category, "procurement");
  for (const duties of [
    "负责采购数字化产品的需求调研、方案设计与系统交付。\n负责协调研发和实施人员完成软件交付。",
    "负责软件合作伙伴招募，供应商是潜在合作企业的例子。\n负责与客户采购经理沟通商业合作，支持伙伴联合销售。",
  ]) assert.equal(assessRoleExclusion({ title: "商业合作经理", jd: jd(duties) }, policy), null, duties);
  assert.equal(assessRoleExclusion({ title: "Supply Chain Manager",
    jd: "Responsibilities:\nOwn procurement planning and supplier selection for purchased resources.\nManage purchase orders, supplier cost negotiation and sourcing.\nRequirements:\nRelevant experience." }, policy)?.category, "procurement");
});

test("only exact metadata, identity and observed-date bound full JDs affect current candidate filtering", () => {
  const item = card("ambiguous-procurement", "供应链经理", { jd: jd("负责公司采购计划和寻源比价。\n主导采购成本控制及订单管理。") });
  const queue = queueOf([item]), source = build([item], { queue }).snapshot;
  assert.equal(filterRoleCandidates(source, queue, context()).removals.length, 1);
  for (const change of [
    (copy) => { copy.jobs[0].title = "不同岗位"; },
    (copy) => { copy.jobs[0].company = "TEST_OTHER_COMPANY"; },
    (copy) => { copy.jobs[0].lastSeen = "2026-09-10T01:01:00.000Z"; copy.candidateStatesById[item.id].evidenceObservedAt = copy.jobs[0].lastSeen; },
    (copy) => { copy.jobs[0].jdRead = false; copy.candidateStatesById[item.id].evidence = "identity-conflict"; copy.candidateStatesById[item.id].direction = "unclear"; },
  ]) {
    const changed = structuredClone(source); change(changed);
    assert.equal(filterRoleCandidates(changed, queue, context()).removals.length, 0);
  }
});

test("cleanup preserves manual selections, retained objects/dates/new flags and actual sample counters", () => {
  const previous = snapshotOf(Array.from({ length: 10 }, (_, index) => fixture({
    id: `boss-saved-feedback-${index}`, url: `https://www.zhipin.com/job_detail/saved-feedback-${index}.html`,
    title: index === 0 ? "大客户经理" : "合作伙伴经理", isNew: false,
  })));
  const items = [card("bad", "座舱项目经理"), card("unknown"), card("partner", "Channel Account Manager", { jd: jd(partnerDuties) })];
  const original = build(items, { previous }).snapshot, queue = queueOf(items.filter((item) => item.jd));
  const result = filterRoleCandidates(original, queue, context());
  assert.equal(result.removals.length, 1);
  assert.equal(result.selectionConflicts.length, 1);
  assert.deepEqual(result.snapshot.jobs, original.jobs.filter((job) => job.id !== items[0].id));
  assert.deepEqual(result.snapshot.candidateFeed, original.candidateFeed);
  assert.equal(result.snapshot.generatedAt, original.generatedAt);
  assert.equal(result.snapshot.run.cardsReviewed, original.run.cardsReviewed);
  assert.equal(result.snapshot.run.detailsRead, original.run.detailsRead);
  for (const job of result.snapshot.jobs) {
    assert.equal(result.snapshot.firstPublishedAtById[job.id], original.firstPublishedAtById[job.id]);
    assert.equal(result.snapshot.assessmentMethods[job.id], original.assessmentMethods[job.id]);
  }
  assert.equal(result.snapshot.run.newCount, 2);
});

async function setup(t, records = [card("blocked", "采购经理"), card("allowed", "生态合作经理")]) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-role-feedback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = { ...modeSettings(candidateMode), roleExclusionsVersion: 1, limits: candidateLimits,
    queries: intent.queries, repository: "TEST_ONLY/repository" };
  const queue = queueOf(records.filter((record) => record.jd)), snapshot = build(records, { queue }).snapshot;
  await atomicJson(join(root, "runtime.json"), runtime);
  await atomicJson(join(root, "role-exclusions.json"), policy);
  await atomicJson(join(root, "role-exclusions-history.json"), emptyRoleHistory());
  await atomicJson(join(root, "intent-policy.json"), intent);
  await atomicJson(join(root, "ledger.json"), ledgerOf(snapshotOf([]), records));
  await atomicJson(join(root, "state.json"), { ...initialState(), lastPublished: { sha: "previous-confirmed" }, lastCollection: { id: "real-previous-sample" } });
  await atomicJson(join(root, "control.json"), { paused: false, cancelRunId: null });
  await saveReviewQueue(root, queue);
  let published;
  const services = {
    prepareClone: async () => ({ snapshot, head: "a".repeat(40), cwd: "TEST_ONLY_CLONE" }),
    publishSnapshot: async (_root, _runtime, data, _prepared, _signal, pending) => {
      published = data;
      const text = `${JSON.stringify(data, null, 2)}\n`;
      await pending({ sha: "b".repeat(40), baseSha: "a".repeat(40), digest: createHash("sha256").update(text).digest("hex"),
        phase: "committed", runId: data.candidateFeed.runId });
      return { sha: "b".repeat(40), url: "https://example.invalid/", attempts: 1 };
    },
  };
  return { root, runtime, records, queue, snapshot, services, published: () => published };
}

test("private policy and removal records are strict, durable and fail closed when missing or disconnected", async (t) => {
  const data = await setup(t);
  const loaded = await loadRoleContext(data.root, data.runtime);
  const filtered = filterRoleCandidates(data.snapshot, data.queue, loaded);
  await rememberRoleExclusions(data.root, loaded, filtered.removals, now);
  const reloaded = await loadRoleContext(data.root, data.runtime);
  assert.equal(reloaded.history.entries[0].reasonCode, "role-procurement");
  assert.equal(reloaded.history.entries[0].policyVersion, 1);
  assert.equal(validateRoleHistory(reloaded.history), reloaded.history);
  assert.throws(() => validateRolePolicy({ ...policy, categories: ["test-unknown-rule"] }), { code: "invalid-role-policy" });
  await assert.rejects(loadRoleContext(data.root, {}), { code: "role-policy-unconfigured" });
  await chmod(join(data.root, "role-exclusions.json"), 0o644);
  await assert.rejects(loadRoleContext(data.root, data.runtime), { code: "private-permissions" });
  await chmod(join(data.root, "role-exclusions.json"), 0o600);
  await rm(join(data.root, "role-exclusions.json"));
  await assert.rejects(loadRoleContext(data.root, data.runtime), { code: "role-policy-missing" });
});

test("same-ID reappearance, queue backlog, automatic merges and explicit backfill cannot bypass feedback", async (t) => {
  const data = await setup(t);
  const ctx = await loadRoleContext(data.root, data.runtime);
  await rememberRoleExclusions(data.root, ctx, filterRoleCandidates(data.snapshot, data.queue, ctx).removals, now);
  const changed = { ...data.records[0], title: "渠道经理", jd: jd(partnerDuties) };
  const roleContext = await loadRoleContext(data.root, data.runtime);
  const outcome = build([changed, data.records[1]], { roles: roleContext });
  assert.deepEqual(outcome.snapshot.jobs.map((item) => item.id), [data.records[1].id]);
  const record = { ...changed, title: "采购经理" };
  await publishCandidates(data.root, { evidence: evidenceOf([record]), ledger: ledgerOf(data.snapshot, [record]),
    intent, runId: "test-new-feedback-run", sampledAt: at }, new AbortController().signal, data.services);
  assert.ok(!data.published().jobs.some((job) => job.id === changed.id));
  await atomicJson(join(data.root, "runs", "test-captured-run", "evidence.json"), evidenceOf(data.records));
  await atomicJson(join(data.root, "runs", "test-captured-run", "result.json"), { id: "test-captured-run", status: "collected", sampledAt: at });
  await publishCaptured(data.root, "test-captured-run", new AbortController().signal, data.services);
  assert.ok(!data.published().jobs.some((job) => job.id === changed.id));
});

test("maintenance publishes removals without a new sample or changing retained batch flags", async (t) => {
  const data = await setup(t), before = await readJson(join(data.root, "state.json"));
  const result = await publishRoleCleanup(data.root, new AbortController().signal, data.services);
  assert.equal(result.removedCandidates, 1);
  assert.equal(data.published().candidateFeed.publicationKind, "feedback-filter");
  for (const key of ["sampledAt", "sampleRunId", "cardsThisSample", "detailsThisSample"]) {
    assert.equal(data.published().candidateFeed[key], data.snapshot.candidateFeed[key]);
  }
  assert.deepEqual(data.published().jobs[0], data.snapshot.jobs[1]);
  assert.equal(data.published().run.newCount, 1);
  assert.deepEqual((await readJson(join(data.root, "state.json"))).lastCollection, before.lastCollection);
  assert.equal(await readJson(join(data.root, "pending.json"), null), null);
});

test("old pending receipt is rechecked against current role policy before any Git or Pages access", async (t) => {
  const data = await setup(t);
  const text = `${JSON.stringify(data.snapshot, null, 2)}\n`;
  await atomicJson(join(data.root, "pending.json"), { version: 1, type: candidateMode, status: "pending",
    phase: "committed", baseSha: "a".repeat(40), sha: "b".repeat(40), digest: createHash("sha256").update(text).digest("hex"),
    runId: data.snapshot.candidateFeed.runId, snapshot: data.snapshot });
  const never = async () => assert.fail("Feedback-blocked retry must not touch Git or Pages.");
  await assert.rejects(retryCandidatePublication(data.root, new AbortController().signal, { git: never, verifyPublication: never }),
    { code: "candidate-pending-role-excluded" });
  assert.equal((await readJson(join(data.root, "state.json"))).lastPublished.sha, "previous-confirmed");
});

test("runner applies explicit negative feedback before full-JD budget without hiding unknown partner roles", async (t) => {
  const data = await setup(t);
  const roles = await loadRoleContext(data.root, data.runtime);
  const result = await run(data.root, { dryRun: true, services: {
    loadConfiguration: async () => ({ runtime: data.runtime, intent, matching: {}, roleContext: roles }),
    caffeinate: () => null, prefilterIntentCard: () => ({ eligible: true }),
    collectBoss: async ({ prefilter, onEvidence }) => {
      assert.deepEqual(prefilter(data.records[0]), { eligible: false, reason: "role-procurement" });
      assert.deepEqual(prefilter(data.records[1]), { eligible: true });
      const evidence = evidenceOf(data.records); await onEvidence(evidence); return evidence;
    },
    publishCandidates: async () => assert.fail("A dry run cannot publish."),
  } });
  assert.equal(result.status, "dry-run");
});

test("new human selection of a feedback-blocked role needs a separate explicit override, not an older approval", async (t) => {
  const item = card("manual-override", "大客户经理", { jd: jd(directDuties) }), data = await setup(t, [item]);
  const entry = data.queue.entries[0];
  const approved = approveReviews(data.queue, { version: 1, approvals: [{
    id: item.id, evidenceHash: entry.evidenceHash, job: fixture({ id: item.id, url: item.url, title: item.title, company: item.company,
      location: item.location, source: item.source, experienceText: item.experienceText, educationText: item.educationText,
      firstSeen: at, lastSeen: at, priority: "有条件匹配", matchScore: null }),
  }] });
  await saveReviewQueue(data.root, approved);
  await assert.rejects(publishReviewed(data.root, [item.id], new AbortController().signal, {
    prepareClone: async () => assert.fail("An older approval cannot override newer negative feedback."),
  }), { code: "role-override-required" });
  const result = await publishReviewed(data.root, [item.id], new AbortController().signal, {
    prepareClone: async () => ({ snapshot: data.snapshot, cwd: join(data.root, "publish"), head: "a".repeat(40) }),
    git: async (_runtime, args) => {
      if (args[0] === "ls-remote") return `${"a".repeat(40)}\trefs/heads/main`;
      if (args[0] === "rev-parse") return "b".repeat(40);
      if (args.includes("--name-only")) return "docs/data/jobs.json";
      return "";
    },
    verifyPublication: async () => ({ url: "https://example.invalid/", attempts: 1 }),
  }, { roleOverride: true });
  assert.equal(result.status, "published");
  assert.deepEqual(result.roleOverrideIds, [item.id]);
  const promoted = await readJson(join(data.root, "publish/docs/data/jobs.json"));
  assert.equal(promoted.jobs.length, 1);
  assert.deepEqual(promoted.candidateStatesById, {});
  assert.deepEqual(promoted.firstPublishedAtById, data.snapshot.firstPublishedAtById);
  assert.equal(filterRoleCandidates(promoted, approved, context()).snapshot.jobs.length, 1);
});

test("the seven explicit manual ID exclusions still take priority over role rules and old choices", () => {
  const rejected = Array.from({ length: 7 }, (_, index) => card(`manual-rejected-${index}`, "渠道经理"));
  const allowed = card("uncertain-new", "生态销售经理");
  const result = build([...rejected, allowed], { roles: context(), excludedIds: new Set(rejected.map((item) => item.id)) });
  assert.deepEqual(result.snapshot.jobs.map((item) => item.id), [allowed.id]);
  assert.equal(result.snapshot.jobs[0].jdRead, false);
  assert.equal(result.snapshot.jobs[0].matchScore, null);
});

test("configured missing policy blocks actual configuration loading instead of silently disabling feedback", async (t) => {
  const data = await setup(t);
  await atomicJson(join(data.root, "runtime.json"), { ...data.runtime, version: 1, branch: "main", nodePath: process.execPath });
  await atomicJson(join(data.root, "matching.json"), { version: 1, directions: ["伙伴营销"], confirmedCapabilities: [],
    years: { marketing: null, b2b: null, partner: null, events: null, management: null, technical: null }, education: null });
  assert.equal((await loadConfiguration(data.root)).roleContext.policy.id, policy.id);
  await rm(join(data.root, "role-exclusions.json"));
  await assert.rejects(loadConfiguration(data.root), { code: "role-policy-missing" });
});
