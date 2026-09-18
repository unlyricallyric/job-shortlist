import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";
import { feedbackRolePolicy, assessRoleExclusion, emptyRoleHistory, loadRoleContext } from "../scheduler/role-exclusions.mjs";
import { defaultIntentPolicy, validateIntentPolicy, modeSettings, candidateMode } from "../scheduler/intent.mjs";
import { rotatingQueries, candidateLimits } from "../scheduler/config.mjs";
import { buildCandidateSnapshot, filterRoleCandidates } from "../scheduler/candidates.mjs";
import { emptyReviewQueue, updateReviewQueue, approveReviews, saveReviewQueue } from "../scheduler/review.mjs";
import { publishCandidates, publishCaptured, publishRoleCleanup, retryCandidatePublication } from "../scheduler/publish-candidates.mjs";
import { publishReviewed } from "../scheduler/publish-reviewed.mjs";
import { appendManualExclusions } from "../scheduler/exclusions.mjs";
import { initialState, run } from "../scheduler/runner.mjs";
import { readJson, atomicJson } from "../scheduler/io.mjs";

const policy = feedbackRolePolicy(4), intent = defaultIntentPolicy();
const at = "2026-09-10T01:00:00Z", now = "2026-09-12T01:00:00Z";
const partnerDuties = "负责招募代理伙伴、推进伙伴准入。\n负责伙伴赋能、经销商经营和联合销售，对伙伴转售指标负责。";
const jd = (duties, requirements = "相关业务沟通能力及具体职位条件仍需依据源站核实，不代表申请者已经满足，也不替代来源记录。") =>
  `岗位职责：\n${duties}\n任职要求：\n${requirements}\n记录说明：这是短合成测试，不是真实招聘全文。`;
const card = (name, title, extra = {}) => ({
  id: `boss-core-title-${name}`, url: `https://www.zhipin.com/job_detail/core-title-${name}.html`, title,
  company: "TEST_ONLY_COMPANY", location: "上海", source: "BOSS直聘", salaryText: null,
  educationText: null, experienceText: null, retrievedAt: at, ...extra,
});
const queueOf = (records) => updateReviewQueue(emptyReviewQueue(), records, records.map((record) => ({
  id: record.id, intent: { decision: "primary", family: "channel-management", reasons: ["test-only"] },
  qualification: { status: "pending", reasons: ["test-only"] },
})), "test-core-title-source");
const evidenceOf = (records) => ({ cards: records, details: records.filter((record) => record.jd), queries: [], complete: true });
const ledgerOf = (previous, records) => ({ version: 1, reviewedIds: [...new Set([...previous.jobs, ...records].map((item) => item.id))],
  detailIds: [...new Set([...previous.jobs.filter((item) => item.jdRead), ...records.filter((item) => item.jd)].map((item) => item.id))] });
function build(records, { previous = snapshotOf([]), evidence = evidenceOf(records), queue = queueOf(records.filter((item) => item.jd)), roles, excludedIds = new Set() } = {}) {
  return buildCandidateSnapshot(previous, evidence, queue, ledgerOf(previous, records), {
    policy: intent, roleContext: roles, excludedIds, runId: "test-core-title-source", sampledAt: at, now,
  });
}

test("the two exact rejected titles carry sufficient negative evidence without a full JD", () => {
  for (const [title, category] of [
    ["(IDC )销售总监", "sales-leadership"], ["项目经理(整车经验必须)", "automotive-project"],
    ["GPU云服务销售总监", "sales-leadership"], ["硬件销售负责人", "sales-leadership"],
    ["Ｓａｌｅｓ Ｄｉｒｅｃｔｏｒ", "sales-leadership"], ["Head of Sales", "sales-leadership"],
    ["项目经理（整 车 经 验 必 须）", "automotive-project"], ["整车研发项目经理", "automotive-project"],
    ["整车交付经理", "automotive-project"], ["Vehicle Development Program Manager", "automotive-project"],
  ]) {
    const result = assessRoleExclusion({ title, company: "TEST_TECH_COMPANY" }, policy);
    assert.equal(result?.category, category, title);
    assert.equal(result.basis, "title");
  }
  for (const title of ["(IDC )销售总监", "项目经理(整车经验必须)"]) {
    assert.equal(assessRoleExclusion({ title }, feedbackRolePolicy(3)), null, "Legacy v3 behavior must not be rewritten.");
  }
});

test("partner/channel leadership and real reseller duties are not generic sales leadership", () => {
  for (const title of ["渠道销售总监", "渠道销售经理、总监", "生态合作总监GPU方向", "硬件伙伴发展总监",
    "Partner Development Director", "Channel Sales Director", "Partner Marketing Director", "SDR销售开发总监",
    "渠道市场总监", "伙伴营销总监",
    "销售总监助理", "合作协调（向销售总监汇报）", "BDR（晋升通道销售总监）"]) {
    assert.equal(assessRoleExclusion({ title }, policy), null, title);
  }
  assert.equal(assessRoleExclusion({ title: "销售总监", jd: jd(partnerDuties) }, policy), null);
  const direct = jd("负责管理直销团队，制定销售目标，主导终端客户开发和销售计划。");
  assert.equal(assessRoleExclusion({ title: "渠道销售总监", jd: direct }, policy)?.category, "sales-leadership");
  assert.equal(assessRoleExclusion({ title: "业务负责人", jd: jd("负责组建销售团队和销售团队管理。\n制定公司销售计划及营收指标。") }, policy)?.category, "sales-leadership");
  assert.equal(assessRoleExclusion({ title: "销售运营经理", jd: jd("负责销售计划文档和CRM运营，协助销售团队整理培训内容，不管理销售人员。") }, policy), null);
  assert.equal(assessRoleExclusion({ title: "伙伴赋能经理", jd: jd("负责给直销团队提供产品培训。\n负责伙伴赋能和联合业务计划，不承担团队销售管理。") }, policy), null);
  assert.equal(assessRoleExclusion({ title: "商务运营经理", jd: jd("负责对接销售团队管理系统，维护销售计划文档。\n负责培训销售团队使用CRM。") }, policy), null);
});

test("vehicle project ownership differs from customers in the automotive industry and optional experience", () => {
  for (const title of ["汽车行业渠道经理", "整车厂客户伙伴BD", "硬件生态项目经理", "项目经理（整车经验优先）",
    "合作项目经理（不要求整车经验）", "项目经理（整车经验非必须）"]) {
    assert.equal(assessRoleExclusion({ title, jd: jd(partnerDuties) }, policy), null, title);
  }
  assert.equal(assessRoleExclusion({ title: "伙伴经理", jd: jd("负责科技合作伙伴招募，客户是整车厂。\n协调技术团队完成客户项目，推动商业合作。") }, policy), null);
  assert.equal(assessRoleExclusion({ title: "项目协调经理", jd: jd("主导整车项目交付并负责车型量产导入的项目进度。") }, policy)?.category, "automotive-project");
  assert.equal(assessRoleExclusion({ title: "合作项目经理", jd: jd(partnerDuties, "必须具备五年以上整车开发项目经验。") }, policy)?.basis, "requirements");
  assert.equal(assessRoleExclusion({ title: "合作项目经理", jd: jd(partnerDuties, "整车项目管理经验优先，不要求整车研发经历。") }, policy), null);
});

test("unread and identity-conflicting JD states cannot erase title exclusions or use a stale partner JD as an exemption", () => {
  const sales = card("sales", "(IDC )销售总监"), automotive = card("automotive", "项目经理(整车经验必须)"), unknown = card("unknown", "生态合作经理");
  const records = [sales, automotive, unknown];
  const misleading = { ...sales, title: "渠道合作总监", jd: jd(partnerDuties) };
  const evidence = { ...evidenceOf(records), details: [misleading], detailConflicts: [{ id: automotive.id, code: "detail-title-conflict" }] };
  const original = build(records, { evidence }).snapshot;
  assert.ok(original.jobs.every((job) => !job.jdRead));
  const filtered = filterRoleCandidates(original, emptyReviewQueue(), { policy, history: emptyRoleHistory() }, [misleading]);
  assert.deepEqual(filtered.removals.map((item) => item.id), [sales.id, automotive.id]);
  assert.deepEqual(filtered.snapshot.jobs, [original.jobs[2]]);
  assert.deepEqual(filtered.snapshot.candidateFeed, original.candidateFeed);
  assert.equal(filtered.snapshot.firstPublishedAtById[unknown.id], original.firstPublishedAtById[unknown.id]);
  assert.equal(filtered.snapshot.jobs[0].isNew, true);
  const candidate = build(records, { roles: { policy, history: emptyRoleHistory() }, evidence });
  assert.deepEqual(candidate.snapshot.jobs.map((job) => job.id), [unknown.id]);
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-core-title-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = [card("sales", "(IDC )销售总监"), card("automotive", "项目经理(整车经验必须)"), card("partner", "渠道销售总监")];
  const snapshot = build(records).snapshot;
  const runtime = { ...modeSettings(candidateMode), repository: "TEST_ONLY/repository", roleExclusionsVersion: 4,
    limits: candidateLimits, queries: intent.queries };
  await atomicJson(join(root, "runtime.json"), runtime);
  await atomicJson(join(root, "intent-policy.json"), intent);
  await atomicJson(join(root, "role-exclusions.json"), policy);
  const history = { version: 1, entries: [{
    id: "boss-v3-outsourcing-test", policyVersion: 3, policyId: "role-feedback-v3", category: "outsourced-employment",
    reasonCode: "role-outsourced-employment", basis: "employment", observedAt: at, filteredAt: now,
  }] };
  await atomicJson(join(root, "role-exclusions-history.json"), history);
  await atomicJson(join(root, "manual-exclusions.json"), { version: 1, entries: [{ id: "boss-prior-manual-test", excludedAt: at, reasonCode: "user-direction-rejection" }] });
  await atomicJson(join(root, "state.json"), { ...initialState(), lastPublished: { sha: "old-confirmed" } });
  await atomicJson(join(root, "control.json"), { paused: false, cancelRunId: null });
  await atomicJson(join(root, "ledger.json"), ledgerOf(snapshotOf([]), records));
  await saveReviewQueue(root, emptyReviewQueue());
  let output;
  const services = {
    prepareClone: async () => ({ snapshot, cwd: "TEST_ONLY_CLONE", head: "a".repeat(40) }),
    publishSnapshot: async (_root, _runtime, next, _prepared, _signal, pending) => {
      output = next;
      await pending({ phase: "committed", baseSha: "a".repeat(40), sha: "b".repeat(40), runId: next.candidateFeed.runId,
        digest: createHash("sha256").update(`${JSON.stringify(next, null, 2)}\n`).digest("hex") });
      return { sha: "b".repeat(40), url: "https://example.invalid/", attempts: 1 };
    },
  };
  return { root, records, snapshot, history, runtime, services, output: () => output };
}

test("maintenance, automatic merge, backfill and pending recovery use the same negative policy and keep legacy history", async (t) => {
  const data = await setup(t);
  const result = await publishRoleCleanup(data.root, new AbortController().signal, data.services);
  assert.equal(result.removedCandidates, 2);
  assert.deepEqual(data.output().jobs, [data.snapshot.jobs[2]]);
  const history = await readJson(join(data.root, "role-exclusions-history.json"));
  assert.deepEqual(history.entries[0], data.history.entries[0]);
  assert.ok(history.entries.slice(1).every((entry) => entry.policyVersion === 4));
  const renamed = { ...data.records[0], title: "渠道经理" };
  const roles = await loadRoleContext(data.root, data.runtime);
  assert.deepEqual(build([renamed, data.records[2]], { roles }).snapshot.jobs.map((job) => job.id), [data.records[2].id]);
  await publishCandidates(data.root, { evidence: evidenceOf(data.records), ledger: ledgerOf(snapshotOf([]), data.records),
    intent, runId: "new-core-title-run", sampledAt: at }, new AbortController().signal, data.services);
  assert.deepEqual(data.output().jobs.map((job) => job.id), [data.records[2].id]);
  await atomicJson(join(data.root, "runs/core-title-backfill/evidence.json"), evidenceOf(data.records));
  await atomicJson(join(data.root, "runs/core-title-backfill/result.json"), { id: "core-title-backfill", status: "collected", sampledAt: at });
  await publishCaptured(data.root, "core-title-backfill", new AbortController().signal, data.services);
  assert.deepEqual(data.output().jobs.map((job) => job.id), [data.records[2].id]);
  await atomicJson(join(data.root, "pending.json"), { version: 1, type: candidateMode, status: "pending", phase: "committed",
    baseSha: "a".repeat(40), sha: "b".repeat(40), runId: data.snapshot.candidateFeed.runId, snapshot: data.snapshot,
    digest: createHash("sha256").update(`${JSON.stringify(data.snapshot, null, 2)}\n`).digest("hex") });
  await assert.rejects(retryCandidatePublication(data.root, new AbortController().signal, {
    git: async () => assert.fail("Rejected title must not reach Git."),
  }), { code: "candidate-pending-role-excluded" });
});

test("named refusals dominate historical approval while existing selections are not silently revoked", async (t) => {
  const data = await setup(t), record = { ...data.records[0], jd: jd(partnerDuties) }, queue = queueOf([record]);
  const selected = fixture({ id: record.id, title: record.title, company: record.company, source: record.source,
    url: record.url, location: record.location, firstSeen: at, lastSeen: at });
  const approved = approveReviews(queue, { version: 1, approvals: [{ id: record.id, evidenceHash: queue.entries[0].evidenceHash, job: selected }] });
  await saveReviewQueue(data.root, approved);
  const prior = await readJson(join(data.root, "manual-exclusions.json"));
  const extended = appendManualExclusions(prior, [record.id], now);
  assert.deepEqual(extended.entries[0], prior.entries[0]);
  await atomicJson(join(data.root, "manual-exclusions.json"), extended);
  await assert.rejects(publishReviewed(data.root, [record.id], new AbortController().signal, {
    prepareClone: async () => assert.fail("An old approval cannot override an explicit ID rejection."),
  }, { roleOverride: true }), { code: "manual-approval-required" });
  const previous = snapshotOf([selected]); previous.generatedAt = now;
  const result = filterRoleCandidates(previous, emptyReviewQueue(), { policy, history: emptyRoleHistory() });
  assert.equal(result.removals.length, 0);
  assert.equal(result.selectionConflicts.length, 1);
  assert.deepEqual(result.snapshot.jobs, [selected]);
});

test("the runner excludes explicit negative titles before full-JD allocation without closing the candidate feed", async (t) => {
  const data = await setup(t), roleContext = await loadRoleContext(data.root, data.runtime);
  const result = await run(data.root, { dryRun: true, services: {
    loadConfiguration: async () => ({ runtime: data.runtime, intent, matching: {}, roleContext }),
    caffeinate: () => null, prefilterIntentCard: () => ({ eligible: true }),
    collectBoss: async ({ prefilter, onEvidence }) => {
      assert.deepEqual(prefilter(data.records[0]), { eligible: false, reason: "role-sales-leadership" });
      assert.deepEqual(prefilter(data.records[1]), { eligible: false, reason: "role-automotive-project" });
      assert.deepEqual(prefilter(data.records[2]), { eligible: true });
      const evidence = evidenceOf(data.records); await onEvidence(evidence); return evidence;
    },
    publishCandidates: async () => assert.fail("Dry run cannot publish."),
  } });
  assert.equal(result.status, "dry-run");
});

test("intent v2 appends the two authorized broad queries, preserves the original six and bounded custom rotations", () => {
  const old = defaultIntentPolicy(1), current = defaultIntentPolicy();
  assert.equal(validateIntentPolicy(old), old);
  assert.equal(validateIntentPolicy(current), current);
  assert.deepEqual(current.queries.slice(0, 6), old.queries);
  assert.deepEqual(current.queries.slice(6), [{ term: "渠道", industry: "100021" }, { term: "生态", industry: "100029" }]);
  assert.equal(current.queries.length, 8);
  assert.equal(candidateLimits.queriesPerRun, 3);
  assert.equal(candidateLimits.maxCards, 45);
  assert.equal(candidateLimits.maxDetails, 8);
  assert.equal(candidateLimits.timeoutMinutes, 30);
  const groups = [0, 3, 6].map((cursor) => rotatingQueries(current.queries, cursor, 3));
  assert.deepEqual(groups[2], [current.queries[6], current.queries[7], current.queries[0]]);
  assert.equal(new Set(groups.flat().map((query) => JSON.stringify(query))).size, 8);
  const customized = { ...current, queries: [current.queries[6], current.queries[2], current.queries[0]] };
  assert.equal(validateIntentPolicy(customized), customized);
  for (const queries of [
    [], [{ term: "市场活动", industry: "100021" }], [current.queries[0], { industry: "100021", term: "渠道经理" }],
    [{ ...current.queries[0], position: "140101" }], Array(9).fill(current.queries[0]),
  ]) assert.throws(() => validateIntentPolicy({ ...current, queries }), { code: "invalid-intent-policy" });
});
