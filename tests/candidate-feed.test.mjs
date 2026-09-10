import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";
import { buildCandidateSnapshot, candidateEvidence, sourceCard } from "../scheduler/candidates.mjs";
import { emptyReviewQueue, updateReviewQueue, approveReviews, buildReviewedSnapshot, saveReviewQueue } from "../scheduler/review.mjs";
import { defaultIntentPolicy, assessIntent, modeSettings, assertRuntimeMode, collectionMode, candidateMode } from "../scheduler/intent.mjs";
import { candidateLimits, loadConfiguration } from "../scheduler/config.mjs";
import { atomicJson, readJson, RunError } from "../scheduler/io.mjs";
import { candidateCounts, selectArrivalView, selectJobs, validateSnapshot } from "../docs/model.mjs";
import { publishCandidates, retryCandidatePublication, publishCaptured } from "../scheduler/publish-candidates.mjs";
import { run, initialState, status } from "../scheduler/runner.mjs";

const policy = defaultIntentPolicy();
const now = "2026-09-10T02:00:00.000Z";
const observed = "2026-09-10T01:31:00.000Z";
const jd = "岗位职责：\n负责拓展软件渠道伙伴，建立伙伴招募与签约准入机制。\n组织伙伴赋能与联合打单，维护业务合作并共同跟踪商机。\n任职要求：\n具有相关业务经验，有良好沟通和项目协作能力，能够适应日常区域出差。";
const record = (name, overrides = {}) => ({
  ...fixture({ id: `boss-feed-test-${name}`, url: `https://www.zhipin.com/job_detail/feed-test-${name}.html`,
    title: `TEST_ONLY_${name}`, company: "TEST_ONLY_COMPANY", location: "上海", matchScore: null }),
  retrievedAt: observed, ...overrides,
});
const evidenceOf = (cards, details = []) => ({ cards, details, complete: true, queries: [] });
const queueOf = (records, status = "pending") => updateReviewQueue(emptyReviewQueue(), records, records.map((item) => ({
  id: item.id, intent: assessIntent(item, policy), qualification: { status, reasons: ["private-personal-test-condition"] },
})), "test-source-run");
const ledgerOf = (previous, evidence, queue = emptyReviewQueue()) => ({
  version: 1,
  reviewedIds: [...new Set([...previous.jobs, ...evidence.cards, ...queue.entries].map((item) => item.id))],
  detailIds: [...new Set([...previous.jobs.filter((job) => job.jdRead), ...evidence.details, ...queue.entries].map((item) => item.id))],
});
const build = (evidence, { previous = snapshotOf([]), queue = emptyReviewQueue(), ...options } = {}) =>
  buildCandidateSnapshot(previous, evidence, queue, ledgerOf(previous, candidateEvidence(evidence, options.now ?? now), queue), {
    policy, runId: "test-candidate-publication", sampleRunId: "test-source-run", sampledAt: now, now, ...options,
  }).snapshot;

test("all valid cards are visible regardless of private fit decisions, unread details or prior small publication caps", () => {
  const primary = record("primary", { jd });
  const outside = record("outside", { jd: "岗位职责：\n负责品牌传播与内容营销，撰写文案并组织市场活动，负责维护公司的媒体宣传渠道。\n任职要求：\n具有扎实的写作基础和市场活动经验，能够跟进品牌内容与活动执行，并协调多个项目的进度。" });
  const unclear = record("unclear", { jd: "岗位职责：\n整理日常信息并安排各类内部工作，跟踪团队工作进度，维护日常文档及相关内容。\n任职要求：\n具有良好的沟通能力、文档整理能力和学习能力，能够协调日常工作，按时完成团队交办的任务。" });
  const cards = [primary, outside, unclear, ...Array.from({ length: 10 }, (_, i) => record(`unread-${i}`))];
  const queue = queueOf([primary, outside, unclear], "not-met");
  const data = build(evidenceOf(cards, [primary, outside, unclear]), { queue });
  assert.equal(data.jobs.length, cards.length);
  assert.deepEqual(candidateCounts(data), { candidates: 13, selected: 0, cardOnly: 10, newCandidates: 13 });
  assert.equal(data.candidateStatesById[outside.id].direction, "outside");
  assert.equal(data.candidateStatesById[unclear.id].direction, "unclear");
  assert.ok(data.jobs.every((job) => job.matchScore === null && job.priority === "采样候选 · 待你判断" && job.matchReasons.length === 0));
  assert.ok(!JSON.stringify(data).includes("private-personal-test-condition"));
  assert.ok(!JSON.stringify(data).includes(jd));
  assert.equal(selectJobs(data.jobs, { candidateStatesById: data.candidateStatesById }).length, cards.length);
});

test("unread, short, unseparated and mismatched details fall back to the authentic card without stale body or score", () => {
  const cards = ["unread", "short", "unseparated", "mismatch", "conflict"].map((id) => record(id, { salaryText: "\ue031-\ue032K" }));
  const details = [
    { ...cards[1], jd: "too short" },
    { ...cards[2], jd: "UNSEPARATED_TEST_ONLY ".repeat(10) },
    { ...cards[3], title: "DIFFERENT_TEST_ONLY_TITLE", jd },
  ];
  const evidence = { ...evidenceOf(cards, details), detailConflicts: [{ id: cards[4].id, code: "detail-title-conflict" }] };
  const data = build(evidence);
  assert.equal(data.jobs.length, 5);
  for (const job of data.jobs) {
    assert.equal(job.jdRead, false);
    assert.equal(job.salaryText, null);
    assert.equal(job.salaryMinK, null);
    assert.equal(job.matchScore, null);
    assert.deepEqual(job.requirements, []);
    assert.equal(data.candidateStatesById[job.id].direction, "unclear");
  }
  assert.equal(data.candidateStatesById[cards[0].id].evidence, "card-only");
  assert.equal(data.candidateStatesById[cards[1].id].evidence, "incomplete-jd");
  assert.equal(data.candidateStatesById[cards[2].id].evidence, "incomplete-jd");
  assert.equal(data.candidateStatesById[cards[3].id].evidence, "identity-conflict");
  assert.equal(data.candidateStatesById[cards[4].id].evidence, "identity-conflict");
  assert.ok(!JSON.stringify(data).includes("DIFFERENT_TEST_ONLY_TITLE"));
  assert.ok(!JSON.stringify(data).includes("UNSEPARATED_TEST_ONLY"));
});

test("source whitelist rejects bogus identities and missing observation dates, and never copies contacts, tokens or raw descriptions", () => {
  const bad = [
    record("blank-date", { retrievedAt: "" }), record("id", { url: "https://www.zhipin.com/job_detail/other.html" }),
    record("account", { url: "https://www.zhipin.com/web/user/" }), record("token", { url: `${record("token").url}?securityId=TEST_ONLY` }),
    record("captcha", { title: "请完成验证码" }), record("contact", { title: "联系 test@example.invalid" }),
  ];
  const valid = record("safe", { jd: `${jd}\n联系方式 test@example.invalid 13800000000 securityId=TEST_SECRET`,
    company: "联系 test@example.invalid", salaryText: "\ue012K", recruiter: "PRIVATE_NAME", securityId: "TEST_SECRET", profile: "PRIVATE_PROFILE" });
  assert.ok(bad.every((item) => !sourceCard(item, now).card));
  const evidence = evidenceOf([null, ...bad, valid], [null, valid]);
  const data = build(evidence);
  assert.equal(data.jobs.length, 1);
  assert.equal(data.jobs[0].company, null);
  assert.equal(data.jobs[0].salaryText, null);
  assert.doesNotMatch(JSON.stringify(data), /test@example|13800000000|TEST_SECRET|PRIVATE_|securityId|recruiter|profile/);
  assert.throws(() => build({ ...evidence, complete: false }), { code: "incomplete-candidate-sample" });
});

test("public candidate schema refuses qualification scores, conditional-match defaults and unbound evidence states", () => {
  const data = build(evidenceOf([record("schema")]));
  for (const change of [
    (copy) => { copy.jobs[0].matchScore = 90; },
    (copy) => { copy.jobs[0].priority = "有条件匹配"; },
    (copy) => { copy.jobs[0].jdRead = true; },
    (copy) => { copy.candidateStatesById[copy.jobs[0].id].direction = "primary"; },
    (copy) => { delete copy.firstPublishedAtById[copy.jobs[0].id]; },
    (copy) => { copy.candidateFeed.autoApproved = true; },
  ]) {
    const copy = structuredClone(data);
    change(copy);
    assert.throws(() => validateSnapshot(copy));
  }
});

test("manual exclusions and review rejections win over old public data, backlog, observations and details", () => {
  const excluded = record("excluded", { jd }), rejected = record("rejected", { jd }), retained = record("retained");
  const queue = queueOf([excluded, rejected]);
  queue.entries[1].status = "rejected";
  const initial = build(evidenceOf([excluded, retained], [excluded]));
  const data = build(evidenceOf([excluded, rejected, retained], [excluded, rejected]), {
    previous: initial, queue, excludedIds: new Set([excluded.id]),
  });
  assert.deepEqual(data.jobs.map((job) => job.id), [retained.id]);
  assert.deepEqual(Object.keys(data.firstPublishedAtById), [retained.id]);
  assert.deepEqual(Object.keys(data.candidateStatesById), [retained.id]);
});

test("two daily rounds retain first display dates, reset only batch-new flags, and preserve all ten manual selections", () => {
  const previous = snapshotOf(Array.from({ length: 10 }, (_, i) => fixture({ id: `boss-saved-${i}`,
    url: `https://www.zhipin.com/job_detail/saved-${i}.html`, isNew: false, salaryText: "TEST_ONLY_ORIGINAL_QUOTE" })));
  previous.assessmentMethods = Object.fromEntries(previous.jobs.map((job) => [job.id, "human-assisted"]));
  const a = record("early"), b = record("later", { retrievedAt: "2026-09-10T04:31:00Z" });
  const first = build(evidenceOf([a]), { previous, publicationKind: "manual-backfill" });
  const second = build(evidenceOf([{ ...a, retrievedAt: b.retrievedAt }, b]), {
    previous: first, now: "2026-09-10T04:40:00Z", sampledAt: b.retrievedAt,
  });
  assert.deepEqual(second.jobs.slice(0, 10), previous.jobs);
  for (const item of previous.jobs) assert.equal(second.assessmentMethods[item.id], previous.assessmentMethods[item.id]);
  assert.equal(second.run.newCount, 1);
  assert.equal(second.jobs.find((job) => job.id === a.id).isNew, false);
  assert.equal(second.jobs.find((job) => job.id === a.id).firstSeen, observed);
  assert.equal(second.firstPublishedAtById[a.id], now);
  assert.equal(selectArrivalView(second.jobs, "today", "2026-09-10T05:00:00Z", second.firstPublishedAtById).length, 2);
  assert.equal(second.firstPublishedAtById[b.id], "2026-09-10T04:40:00Z");
  const third = build(evidenceOf([{ ...a, retrievedAt: b.retrievedAt }, b]), {
    previous: second, now: "2026-09-10T04:50:00Z", sampledAt: "2026-09-10T04:49:00Z",
  });
  assert.equal(third.run.newCount, 0);
  assert.deepEqual(third.firstPublishedAtById, second.firstPublishedAtById);
  assert.equal(third.candidateFeed.sampledAt, "2026-09-10T04:49:00Z");
  assert.equal(selectArrivalView(third.jobs, "today", "2026-09-10T05:00:00Z", third.firstPublishedAtById).length, 2);
});

test("queued older full evidence enriches only matching metadata and never overrides a later identity conflict", () => {
  const original = record("enrichment", { jd });
  const queue = queueOf([original]);
  const newer = { ...original, retrievedAt: "2026-09-10T01:50:00Z" };
  const data = build(evidenceOf([newer]), { queue });
  assert.equal(data.jobs[0].jdRead, true);
  assert.equal(data.candidateStatesById[original.id].evidenceObservedAt, observed);
  const changed = build(evidenceOf([{ ...newer, company: "TEST_DIFFERENT" }]), { previous: data, queue });
  assert.equal(changed.jobs[0].jdRead, false);
  const conflict = build({ ...evidenceOf([newer]), detailConflicts: [{ id: original.id, code: "detail-title-conflict" }] }, { previous: data, queue });
  assert.equal(conflict.jobs[0].jdRead, false);
  const subsequent = build(evidenceOf([{ ...newer, retrievedAt: "2026-09-10T01:55:00Z" }]), { previous: conflict, queue });
  assert.equal(subsequent.jobs[0].jdRead, false);
  const contactCard = record("redacted-binding", { company: "first@example.invalid" });
  const contactDetail = { ...contactCard, company: "different@example.invalid", jd };
  const redacted = build(evidenceOf([contactCard], [contactDetail]));
  assert.equal(redacted.jobs[0].company, null);
  assert.equal(redacted.jobs[0].jdRead, false);
  assert.equal(redacted.candidateStatesById[contactCard.id].evidence, "identity-conflict");
  assert.ok(!JSON.stringify(redacted).includes("metadataHash"));
});

test("explicit human selection upgrades a visible candidate in place without resetting first observation or first display", () => {
  const item = record("promote", { jd }), queue = queueOf([item]);
  const cardEarlier = { ...item, retrievedAt: "2026-09-09T01:00:00Z" };
  const initial = build(evidenceOf([cardEarlier]), { now: "2026-09-09T02:00:00Z", sampledAt: cardEarlier.retrievedAt });
  const payload = { version: 1, approvals: [{
    id: item.id, evidenceHash: queue.entries[0].evidenceHash,
    job: fixture({ id: item.id, url: item.url, title: item.title, company: item.company, location: item.location,
      firstSeen: observed, lastSeen: observed, priority: "有条件匹配", matchScore: null }),
  }] };
  const approved = approveReviews(queue, payload);
  const promoted = buildReviewedSnapshot(initial, approved, [item.id], ledgerOf(initial, evidenceOf([item], [item]), queue), new Set(), now);
  assert.equal(promoted.jobs.length, 1);
  assert.equal(promoted.jobs[0].firstSeen, cardEarlier.retrievedAt);
  assert.equal(promoted.jobs[0].priority, "有条件匹配");
  assert.equal(promoted.run.newCount, 0);
  assert.equal(promoted.firstPublishedAtById[item.id], initial.firstPublishedAtById[item.id]);
  assert.deepEqual(promoted.candidateStatesById, {});
  assert.equal(promoted.candidateFeed.publicationKind, "manual-selection");
  assert.equal(candidateCounts(promoted).selected, 1);
  assert.equal(validateSnapshot(promoted), promoted);
});

test("candidate mode requires explicit consistent settings, no maxNewJobs cap, and never silently migrates collection-only", async (t) => {
  assert.equal(assertRuntimeMode({ ...modeSettings(candidateMode) }).autoPublish, true);
  assert.equal(assertRuntimeMode({ mode: collectionMode, autoPublish: false, reviewRequired: true }).autoPublish, false);
  assert.throws(() => assertRuntimeMode({ mode: candidateMode, autoPublish: true, reviewRequired: true }), { code: "candidate-mode-required" });
  assert.throws(() => assertRuntimeMode({ autoPublish: true }), { code: "collection-mode-required" });
  const root = await mkdtemp(join(tmpdir(), "shortlist-feed-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = { version: 1, repository: "TEST_ONLY/repository", branch: "main", nodePath: process.execPath,
    ...modeSettings(candidateMode), limits: candidateLimits, queries: policy.queries };
  await atomicJson(join(root, "runtime.json"), runtime);
  await atomicJson(join(root, "intent-policy.json"), policy);
  await atomicJson(join(root, "ledger.json"), { version: 1, reviewedIds: [], detailIds: [] });
  await atomicJson(join(root, "matching.json"), { version: 1, directions: ["伙伴营销"], confirmedCapabilities: [],
    years: { marketing: null, b2b: null, partner: null, events: null, management: null, technical: null }, education: null });
  assert.equal((await loadConfiguration(root)).runtime.mode, candidateMode);
  await atomicJson(join(root, "runtime.json"), { ...runtime, limits: { ...candidateLimits, maxNewJobs: 0 } });
  await assert.rejects(loadConfiguration(root), { code: "invalid-config" });
});

async function runtimeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-feed-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = snapshotOf([fixture({ isNew: false })]);
  const rootState = { ...initialState(new Date("2026-01-01T00:00:00Z")), lastPublished: { sha: "previous-confirmed" } };
  await atomicJson(join(root, "state.json"), rootState);
  await atomicJson(join(root, "control.json"), { paused: false, cancelRunId: null });
  const runtime = { ...modeSettings(candidateMode), repository: "TEST_ONLY/repository", limits: candidateLimits, queries: policy.queries };
  await atomicJson(join(root, "runtime.json"), runtime);
  await atomicJson(join(root, "ledger.json"), ledgerOf(previous, evidenceOf([])));
  await atomicJson(join(root, "publish", "docs", "data", "jobs.json"), previous);
  await saveReviewQueue(root, emptyReviewQueue());
  const calls = [], base = "a".repeat(40), next = "b".repeat(40);
  let committed = false, pushed = false;
  const publishing = {
    prepareClone: async () => ({ cwd: join(root, "publish"), snapshot: previous, head: base }),
    git: async (_runtime, args) => {
      calls.push(args);
      if (args[0] === "remote") return "https://github.com/TEST_ONLY/repository.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "rev-parse") return args[1] === "HEAD^" ? base : committed ? next : base;
      if (args[0] === "ls-remote") return `${pushed ? next : base}\trefs/heads/main`;
      if (args[0] === "show") return JSON.stringify(previous, null, 2);
      if (args.includes("--name-only")) return "docs/data/jobs.json";
      if (args.includes("commit")) committed = true;
      if (args[0] === "push") pushed = true;
      return "";
    },
    verifyPublication: async (_runtime, text) => {
      assert.equal(text, await readFile(join(root, "publish", "docs/data/jobs.json"), "utf8"));
      return { url: "https://example.invalid/", attempts: 1 };
    },
  };
  const cards = [record("scheduled-outside", { title: "TEST_ONLY unrelated title" }), record("scheduled-unread")];
  const evidence = evidenceOf(cards);
  const services = {
    loadConfiguration: async () => ({ runtime, intent: policy, matching: {} }), caffeinate: () => null,
    prefilterIntentCard: () => ({ eligible: true }),
    assessForReview: () => assert.fail("Unread cards need no full-JD assessment."),
    collectBoss: async ({ onEvidence }) => { await onEvidence(evidence); return evidence; },
    publishCandidates: (root, context, signal) => publishCandidates(root, context, signal, publishing),
    recoverCandidates: (root, signal) => retryCandidatePublication(root, signal, publishing),
  };
  return { root, previous, runtime, services, publishing, evidence, calls, next };
}

test("an actual scheduled runner path publishes unread cards with no human approval prerequisite, then records verified success", async (t) => {
  const data = await runtimeFixture(t);
  const outcome = await run(data.root, { tick: true, services: data.services });
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.mode, candidateMode);
  assert.equal(outcome.summary.details, 0);
  assert.equal(outcome.summary.publicAdmissions, 2);
  assert.ok(data.calls.some((args) => args[0] === "push"));
  const state = await readJson(join(data.root, "state.json"));
  assert.equal(state.lastPublished.sha, data.next);
  assert.equal(state.lastPublished.type, candidateMode);
  assert.equal(state.lastCollection.status, "collected");
  assert.equal(await readJson(join(data.root, "pending.json"), null), null);
  assert.equal((await run(data.root, { tick: true, services: data.services })).status, "idle");
  const current = await status(data.root);
  assert.equal(current.autoPublish, true);
  assert.equal(current.manualApprovalRequiredForVisibility, false);
  assert.equal(current.queueBlocksVisibility, false);
});

test("push and Pages errors keep the previous confirmed publication and a recoverable receipt, without per-tick retries", async (t) => {
  for (const failure of ["push", "pages"]) await t.test(failure, async (t) => {
    const data = await runtimeFixture(t), originalGit = data.publishing.git, originalVerify = data.publishing.verifyPublication;
    if (failure === "push") data.publishing.git = async (runtime, args) => {
      if (args[0] === "push") throw new RunError("git-test-failure", "TEST_ONLY");
      return originalGit(runtime, args);
    };
    else data.publishing.verifyPublication = async () => { throw new RunError("pages-timeout", "TEST_ONLY"); };
    const outcome = await run(data.root, { tick: true, services: data.services });
    assert.equal(outcome.status, "failed");
    assert.equal((await readJson(join(data.root, "state.json"))).lastPublished.sha, "previous-confirmed");
    assert.equal((await readJson(join(data.root, "state.json"))).lastCollection.status, "collected");
    assert.equal((await readJson(join(data.root, "pending.json"))).phase, "committed");
    assert.equal((await run(data.root, { tick: true, services: data.services })).status, "idle");
    data.publishing.git = originalGit;
    data.publishing.verifyPublication = originalVerify;
    const recovered = await retryCandidatePublication(data.root, new AbortController().signal, data.publishing);
    assert.equal(recovered.status, "published");
    assert.equal((await readJson(join(data.root, "state.json"))).lastPublished.sha, data.next);
    assert.equal(await readJson(join(data.root, "pending.json"), null), null);
  });
});

test("retry rechecks exclusions and cannot resurrect a newly rejected card", async (t) => {
  const data = await runtimeFixture(t);
  data.publishing.verifyPublication = async () => { throw new RunError("pages-timeout", "TEST_ONLY"); };
  await run(data.root, { tick: true, services: data.services });
  await atomicJson(join(data.root, "manual-exclusions.json"), { version: 1, entries: [{
    id: data.evidence.cards[0].id, excludedAt: now, reasonCode: "user-direction-rejection",
  }] });
  data.publishing.git = async () => assert.fail("Excluded pending data must not access Git.");
  await assert.rejects(retryCandidatePublication(data.root, new AbortController().signal, data.publishing), { code: "candidate-pending-excluded" });
});

test("a pre-commit failure leaves a recoverable prepared receipt without resetting the clone or touching other paths", async (t) => {
  const data = await runtimeFixture(t), originalGit = data.publishing.git;
  data.publishing.git = async (runtime, args) => {
    if (args[0] === "add") throw new RunError("git-test-failure", "TEST_ONLY");
    return originalGit(runtime, args);
  };
  const outcome = await run(data.root, { tick: true, services: data.services });
  assert.equal(outcome.status, "failed");
  assert.equal((await readJson(join(data.root, "pending.json"))).phase, "prepared");
  assert.equal((await readJson(join(data.root, "state.json"))).lastPublished.sha, "previous-confirmed");
  data.publishing.git = originalGit;
  const result = await retryCandidatePublication(data.root, new AbortController().signal, data.publishing);
  assert.equal(result.status, "published");
  assert.equal(await readJson(join(data.root, "pending.json"), null), null);
  assert.ok(!data.calls.some((args) => ["reset", "checkout", "clean"].includes(args[0])));
});

test("candidate-feed dry runs still never publish or require approval", async (t) => {
  const data = await runtimeFixture(t);
  data.services.publishCandidates = async () => assert.fail("A dry-run must not publish.");
  const outcome = await run(data.root, { services: data.services, dryRun: true });
  assert.equal(outcome.status, "dry-run");
  assert.equal(data.calls.length, 0);
  assert.equal((await readJson(join(data.root, "state.json"))).lastPublished.sha, "previous-confirmed");
});

test("source errors and incomplete searches never publish fake records, and explicit backfill requires completed evidence", async (t) => {
  const data = await runtimeFixture(t);
  data.services.collectBoss = async () => { throw new RunError("captcha", "TEST_ONLY", { blocked: true }); };
  const result = await run(data.root, { tick: true, services: data.services });
  assert.equal(result.status, "blocked");
  assert.equal(data.calls.length, 0);
  assert.equal((await readJson(join(data.root, "state.json"))).lastPublished.sha, "previous-confirmed");
  await atomicJson(join(data.root, "runs", "test-source-run", "evidence.json"), { ...data.evidence, complete: false });
  await atomicJson(join(data.root, "runs", "test-source-run", "result.json"), { id: "test-source-run", status: "failed", finishedAt: now });
  await assert.rejects(publishCaptured(data.root, "test-source-run", new AbortController().signal, data.publishing), { code: "incomplete-candidate-sample" });
  await assert.rejects(publishCaptured(data.root, "../private", new AbortController().signal, data.publishing), { code: "invalid-captured-run" });
});
