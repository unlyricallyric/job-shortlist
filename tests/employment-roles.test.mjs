import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";
import { assessOutsourcedEmployment } from "../scheduler/employment-roles.mjs";
import { assessRoleExclusion, feedbackRolePolicy, emptyRoleHistory, loadRoleContext, rememberRoleExclusions } from "../scheduler/role-exclusions.mjs";
import { buildCandidateSnapshot, filterRoleCandidates } from "../scheduler/candidates.mjs";
import { emptyReviewQueue, updateReviewQueue, approveReviews, saveReviewQueue } from "../scheduler/review.mjs";
import { appendManualExclusions, manualExcludedIds } from "../scheduler/exclusions.mjs";
import { publishCandidates, publishCaptured, publishRoleCleanup, retryCandidatePublication } from "../scheduler/publish-candidates.mjs";
import { publishReviewed } from "../scheduler/publish-reviewed.mjs";
import { atomicJson, readJson } from "../scheduler/io.mjs";
import { defaultIntentPolicy, modeSettings, candidateMode } from "../scheduler/intent.mjs";
import { candidateLimits } from "../scheduler/config.mjs";
import { initialState, run } from "../scheduler/runner.mjs";

const policy = feedbackRolePolicy(3), intent = defaultIntentPolicy();
const at = "2026-01-02T01:00:00.000Z", now = "2026-01-03T01:00:00.000Z";
const jd = (statement) => `岗位职责：\n负责合作伙伴招募和日常关系维护，组织业务交流与伙伴赋能，不以此推断任职资格。\n任职要求：\n能够开展团队沟通与商业协作，具体职责边界以原岗位为准。\n用工说明：\n${statement}`;
const card = (name, title = "生态合作经理", extra = {}) => ({
  id: `boss-employment-test-${name}`, url: `https://www.zhipin.com/job_detail/employment-test-${name}.html`,
  title, company: "TEST_ONLY_COMPANY", source: "BOSS直聘", location: "上海", salaryText: null,
  experienceText: null, educationText: null, retrievedAt: at, ...extra,
});
const queueOf = (records) => updateReviewQueue(emptyReviewQueue(), records, records.map((item) => ({
  id: item.id, intent: { decision: "primary", family: "channel-management", reasons: ["test-only"] },
  qualification: { status: "pending", reasons: ["test-only"] },
})), "test-employment-source");
const evidenceOf = (cards) => ({ cards, details: cards.filter((item) => item.jd), queries: [], complete: true });
const ledgerOf = (snapshot, records) => ({ version: 1,
  reviewedIds: [...new Set([...snapshot.jobs, ...records].map((item) => item.id))],
  detailIds: [...new Set([...snapshot.jobs.filter((item) => item.jdRead), ...records.filter((item) => item.jd)].map((item) => item.id))] });
function build(records, { previous = snapshotOf([]), roleContext = { policy: null, history: emptyRoleHistory() }, queue = queueOf(records.filter((item) => item.jd)), ...options } = {}) {
  return buildCandidateSnapshot(previous, evidenceOf(records), queue, ledgerOf(previous, records), {
    policy: intent, roleContext, runId: "test-employment-source", sampledAt: at, now, ...options,
  });
}

test("explicit outsourced titles apply before JD reading, including spacing and full-width annotations", () => {
  for (const title of ["交付项目经理(外包)", "合作运营（外包）", "渠道支持【人力外包】", "渠道运营（外 包）",
    "外包伙伴运营专员", "第三方外包渠道经理", "劳务派遣商务专员", "派遣制渠道运营", "Outsourced partner specialist",
    "Partner specialist (outsourced)", "Channel coordinator [agency-employed]"]) {
    assert.equal(assessOutsourcedEmployment({ title })?.category, "outsourced-employment", title);
    assert.equal(assessRoleExclusion({ title }, policy)?.basis, "title", title);
  }
});

test("direct hire, negative statements, vendor management and outsourcing-service sales do not identify outsourced employment", () => {
  const titles = [
    "渠道经理（非外包）", "非 外 包 岗-伙伴运营", "商务经理（非派遣，正式直签）", "Non-outsourced Partner Manager",
    "外包团队管理经理", "管理外包团队的商务专员", "外包供应商管理专员", "外包项目管理经理",
    "销售外包服务经理", "外包服务销售经理", "客户的外包伙伴经理", "Contract Partner Manager", "驻场伙伴经理",
    "外包公司渠道经理", "外包服务交付经理",
  ];
  for (const title of titles) assert.equal(assessOutsourcedEmployment({ title }), null, title);
  for (const company of ["TEST_OUTSOURCING_VENDOR", "TEST_CONSULTANCY"]) {
    assert.equal(assessRoleExclusion(card("business", "合作伙伴经理", { company }), policy), null);
  }
});

test("actual applicant employment arrangements are distinct from company descriptions and other people's contracts", () => {
  for (const statement of [
    "本岗位为人力外包形式。",
    "该职位属于劳务派遣。",
    "用工性质：外包。",
    "入职后与第三方公司签订劳动合同，由该公司派驻客户方工作。",
    "入职后与第三方公司签订劳动合同。\n录用人员派驻客户单位工作。",
    "劳动合同与外包公司签署，并派驻客户单位现场办公。",
    "你将由第三方发放工资，并安排到客户单位工作。",
    "This role is outsourced.",
    "You will be employed by a staffing agency and assigned to the client.",
    "The position is employed by a third party and placed at the customer.",
  ]) assert.equal(assessOutsourcedEmployment({ title: "伙伴运营", jd: jd(statement) })?.basis, "employment", statement);
  for (const statement of [
    "本岗位非外包、非派遣，与招聘公司正式直签。",
    "本岗位不与第三方签订劳动合同，公司直招。",
    "负责管理外包团队、对接供应商，审核客户外包伙伴的工作进度。",
    "负责销售外包服务及渠道合作，派遣人员安排由客户自行管理。",
    "熟悉劳务派遣政策，有管理第三方合同的工作经验优先。",
    "第三方猎头协助招聘，入职后与用人公司正式直签。",
    "招聘公司是外包服务提供商，本岗位负责商务关系。",
    "本岗位属于外包团队管理，主要对接供应商。",
    "本职位是外包服务销售，负责商业伙伴拓展。",
    "需要驻场工作，合同为一年期，部分工作会外派。",
    "This role is not outsourced. You will manage outsourced teams.",
    "Manage employment contracts for third party staff assigned to the client.",
    "负责管理外包团队。\n负责审核第三方人员劳动合同和派驻客户安排。",
  ]) assert.equal(assessOutsourcedEmployment({ title: "商业伙伴经理", jd: jd(statement) }), null, statement);
  assert.equal(assessOutsourcedEmployment({ title: "管理外包团队经理（外包）" })?.basis, "title");
  assert.equal(assessOutsourcedEmployment({ title: "伙伴经理", jd: jd("本岗位非派遣。\n本岗位采用人力外包形式。") })?.basis, "employment");
});

test("title outsourcing is excluded even for unread or identity-conflicting candidate details; original selections are not silently revoked", () => {
  const selected = fixture({ isNew: true, firstSeen: at, lastSeen: at, title: "原已选入（外包）" });
  const previous = snapshotOf([selected]); previous.generatedAt = now;
  const records = [card("named", "交付项目经理(外包)"), card("unknown")];
  const original = build(records, { previous }).snapshot;
  original.candidateStatesById[records[0].id].evidence = "identity-conflict";
  const filtered = filterRoleCandidates(original, emptyReviewQueue(), { policy, history: emptyRoleHistory() });
  assert.deepEqual(filtered.removals.map((item) => item.id), [records[0].id]);
  assert.deepEqual(filtered.selectionConflicts.map((item) => item.id), [selected.id]);
  assert.deepEqual(filtered.snapshot.jobs, original.jobs.filter((job) => job.id !== records[0].id));
  for (const job of filtered.snapshot.jobs) assert.equal(filtered.snapshot.firstPublishedAtById[job.id], original.firstPublishedAtById[job.id]);
  assert.deepEqual(filtered.snapshot.candidateFeed, original.candidateFeed);
  assert.equal(filtered.snapshot.run.cardsReviewed, original.run.cardsReviewed);
});

test("employment evidence is bound to the original source revision/time, not a mismatched or unknown JD", () => {
  const item = card("evidence", "伙伴运营", { jd: jd("本岗位为人力外包形式。") }), queue = queueOf([item]);
  const original = build([item], { queue }).snapshot;
  assert.equal(filterRoleCandidates(original, queue, { policy, history: emptyRoleHistory() }).removals[0].observedAt, at);
  const changed = structuredClone(original); changed.jobs[0].company = "TEST_DIFFERENT";
  assert.equal(filterRoleCandidates(changed, queue, { policy, history: emptyRoleHistory() }).removals.length, 0);
  changed.jobs[0].company = item.company; changed.jobs[0].jdRead = false;
  changed.candidateStatesById[item.id] = { ...changed.candidateStatesById[item.id], evidence: "identity-conflict", direction: "unclear" };
  assert.equal(filterRoleCandidates(changed, queue, { policy, history: emptyRoleHistory() }).removals.length, 0);
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-employment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = [card("bad", "生态经理（外包）", { jd: jd("本岗位为外包形式。") }), card("good")];
  const queue = queueOf([records[0]]), snapshot = build(records, { queue }).snapshot;
  const runtime = { ...modeSettings(candidateMode), repository: "TEST_ONLY/repository", roleExclusionsVersion: 3,
    limits: candidateLimits, queries: intent.queries };
  await atomicJson(join(root, "runtime.json"), runtime);
  await atomicJson(join(root, "state.json"), { ...initialState(), lastPublished: { sha: "old-confirmed" } });
  await atomicJson(join(root, "control.json"), { paused: false, cancelRunId: null });
  await atomicJson(join(root, "role-exclusions.json"), policy);
  await atomicJson(join(root, "role-exclusions-history.json"), { version: 1, entries: [
    { id: "boss-old-feedback-one", policyId: "role-feedback-v1", policyVersion: 1, category: "procurement", reasonCode: "role-procurement", basis: "title", observedAt: at, filteredAt: now },
    { id: "boss-old-feedback-two", policyId: "role-feedback-v2", policyVersion: 2, category: "technical-function", reasonCode: "role-technical-function", basis: "requirements", observedAt: at, filteredAt: now },
  ] });
  await atomicJson(join(root, "manual-exclusions.json"), { version: 1, entries: [{ id: "boss-manual-old", reasonCode: "user-direction-rejection", excludedAt: at }] });
  await atomicJson(join(root, "ledger.json"), ledgerOf(snapshotOf([]), records));
  await atomicJson(join(root, "intent-policy.json"), intent);
  await saveReviewQueue(root, queue);
  let published;
  const services = {
    prepareClone: async () => ({ cwd: "TEST_ONLY_CLONE", head: "a".repeat(40), snapshot }),
    publishSnapshot: async (_root, _runtime, next, _prepared, _signal, onPending) => {
      published = next;
      await onPending({ phase: "committed", baseSha: "a".repeat(40), sha: "b".repeat(40),
        digest: createHash("sha256").update(`${JSON.stringify(next, null, 2)}\n`).digest("hex"), runId: next.candidateFeed.runId });
      return { sha: "b".repeat(40), url: "https://example.invalid/", attempts: 1 };
    },
  };
  return { root, records, queue, snapshot, runtime, services, published: () => published };
}

test("v3 appends employment history and rejects missing/mismatched policy without changing v1/v2 records", async (t) => {
  const data = await setup(t), before = await readJson(join(data.root, "role-exclusions-history.json"));
  const roles = await loadRoleContext(data.root, data.runtime);
  const filtered = filterRoleCandidates(data.snapshot, data.queue, roles);
  await rememberRoleExclusions(data.root, roles, filtered.removals, now);
  const after = await readJson(join(data.root, "role-exclusions-history.json"));
  assert.deepEqual(after.entries.slice(0, 2), before.entries);
  assert.equal(after.entries[2].policyVersion, 3);
  assert.equal(after.entries[2].category, "outsourced-employment");
  assert.equal(assessRoleExclusion({ title: "伙伴运营（外包）" }, feedbackRolePolicy(2)), null);
  await assert.rejects(loadRoleContext(data.root, { ...data.runtime, roleExclusionsVersion: 2 }), { code: "role-policy-version-mismatch" });
});

test("maintenance, future merges, backfill and stale pending receipts all enforce employment feedback", async (t) => {
  const data = await setup(t);
  const result = await publishRoleCleanup(data.root, new AbortController().signal, data.services);
  assert.equal(result.removedCandidates, 1);
  assert.equal(result.removedByCategory["outsourced-employment"], 1);
  assert.equal(data.published().candidateFeed.sampledAt, data.snapshot.candidateFeed.sampledAt);
  assert.deepEqual(data.published().jobs, [data.snapshot.jobs[1]]);
  await publishCandidates(data.root, { evidence: evidenceOf(data.records), ledger: ledgerOf(snapshotOf([]), data.records),
    intent, runId: "test-future-employment", sampledAt: at }, new AbortController().signal, data.services);
  assert.deepEqual(data.published().jobs.map((job) => job.id), [data.records[1].id]);
  await atomicJson(join(data.root, "runs/test-employment-backfill/evidence.json"), evidenceOf(data.records));
  await atomicJson(join(data.root, "runs/test-employment-backfill/result.json"), { id: "test-employment-backfill", status: "collected", sampledAt: at });
  await publishCaptured(data.root, "test-employment-backfill", new AbortController().signal, data.services);
  assert.deepEqual(data.published().jobs.map((job) => job.id), [data.records[1].id]);
  await atomicJson(join(data.root, "pending.json"), { version: 1, type: candidateMode, status: "pending", phase: "committed",
    baseSha: "a".repeat(40), sha: "b".repeat(40), snapshot: data.snapshot, runId: data.snapshot.candidateFeed.runId,
    digest: createHash("sha256").update(`${JSON.stringify(data.snapshot, null, 2)}\n`).digest("hex") });
  await assert.rejects(retryCandidatePublication(data.root, new AbortController().signal, {
    git: async () => assert.fail("A stale excluded candidate must not reach Git."),
  }), { code: "candidate-pending-role-excluded" });
});

test("an explicit ID refusal is append-only and blocks an older approval even with a type override", async (t) => {
  const data = await setup(t), item = data.records[0], before = await readJson(join(data.root, "manual-exclusions.json"));
  const excluded = appendManualExclusions(before, [item.id], now);
  assert.deepEqual(excluded.entries[0], before.entries[0]);
  assert.ok(manualExcludedIds(excluded).has(item.id));
  const job = fixture({ id: item.id, title: item.title, company: item.company, source: item.source, url: item.url,
    location: item.location, firstSeen: at, lastSeen: at });
  const approved = approveReviews(data.queue, { version: 1, approvals: [{ id: item.id, evidenceHash: data.queue.entries[0].evidenceHash, job }] });
  await saveReviewQueue(data.root, approved);
  await atomicJson(join(data.root, "manual-exclusions.json"), excluded);
  await assert.rejects(publishReviewed(data.root, [item.id], new AbortController().signal, {
    prepareClone: async () => assert.fail("Old approval cannot override explicit ID refusal."),
  }, { roleOverride: true }), { code: "manual-approval-required" });
});

test("the installed-runner path screens explicit outsourced titles before spending its JD budget", async (t) => {
  const data = await setup(t), roles = await loadRoleContext(data.root, data.runtime);
  const outcome = await run(data.root, { dryRun: true, services: {
    loadConfiguration: async () => ({ runtime: data.runtime, matching: {}, intent, roleContext: roles }),
    caffeinate: () => null, prefilterIntentCard: () => ({ eligible: true }),
    collectBoss: async ({ prefilter, onEvidence }) => {
      assert.deepEqual(prefilter(data.records[0]), { eligible: false, reason: "role-outsourced-employment" });
      assert.deepEqual(prefilter(data.records[1]), { eligible: true });
      const evidence = { ...evidenceOf(data.records), details: [] }; await onEvidence(evidence); return evidence;
    },
    publishCandidates: async () => assert.fail("Dry run must not publish."),
  } });
  assert.equal(outcome.status, "dry-run");
});
