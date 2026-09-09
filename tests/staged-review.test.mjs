import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultIntentPolicy, assessIntent, assessForReview, validateIntentPolicy, assertCollectionMode,
  prefilterIntentCard, collectionMode,
} from "../scheduler/intent.mjs";
import {
  emptyReviewQueue, updateReviewQueue, validateReviewQueue, loadReviewQueue, saveReviewQueue,
  approveReviews, rejectReview, showReview, listReviews, reviewCounts, buildReviewedSnapshot, evidenceHash,
} from "../scheduler/review.mjs";
import { publishReviewed, retryReviewedPublication } from "../scheduler/publish-reviewed.mjs";
import { activateNextSlot, dueSlot } from "../scheduler/clock.mjs";
import { atomicJson, readJson } from "../scheduler/io.mjs";
import { selectArrivalView, groupJobsByFirstSeen, validateSnapshot } from "../docs/model.mjs";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";
import { command } from "../scheduler/process.mjs";
import { loadConfiguration } from "../scheduler/config.mjs";
import { createHash } from "node:crypto";

const policy = defaultIntentPolicy();
const matching = {
  version: 1, directions: ["伙伴营销", "区域市场", "需求生成", "销售运营"],
  confirmedCapabilities: ["b2bMarketing", "partnerMarketing", "fieldEvents", "demandGeneration", "marketingOps"],
  years: { marketing: null, b2b: null, partner: null, events: null, management: null, technical: null }, education: null,
};
const jd = "岗位职责：\n负责拓展软件渠道伙伴，独立完成伙伴拜访、合作洽谈与签约准入。\n建立商机互荐机制并组织联合打单。\n负责伙伴赋能与分级经营，跟踪伙伴转售业绩。\n协同伙伴开展联合市场活动。\n任职要求：\n两年以上B2B软件、渠道或伙伴管理经验。\n具备独立商务拓展与谈判能力，需要联合打单实践并适应区域出差。\n优先条件：\nERP、MES或制造业经验。";
const record = (name = "a", overrides = {}) => ({
  ...fixture({ id: `boss-test-review-${name}`, url: `https://www.zhipin.com/job_detail/test-review-${name}.html`,
    title: "TEST_ONLY 生态合作经理", company: "TEST_ONLY_COMPANY", location: "上海" }),
  jd, retrievedAt: "2026-09-10T00:00:00Z", ...overrides,
});
const assessment = (item) => ({ id: item.id, ...assessForReview(item, matching, policy) });
const queued = (items) => updateReviewQueue(emptyReviewQueue(), items, items.map(assessment), "controlled-test-record");
const publicJob = (entry) => ({
  ...fixture({ id: entry.id, url: entry.evidence.url, title: entry.evidence.title, company: entry.evidence.company,
    location: entry.evidence.location, experienceText: entry.evidence.experienceText, educationText: entry.evidence.educationText,
    source: entry.evidence.source, firstSeen: entry.firstSeen, lastSeen: entry.lastSeen, isNew: true,
    priority: "有条件匹配", matchScore: 60 }),
  summary: ["合作伙伴发展与商机协同。"], requirements: ["相关业务实践仍需核实。"],
  concerns: ["独立商务责任与资格条件待确认。"], matchReasons: ["职责方向可进一步了解。"],
});
const approval = (queue, ids = queue.entries.map((entry) => entry.id)) => ({
  version: 1, approvals: ids.map((id) => {
    const entry = showReview(queue, id);
    return { id, evidenceHash: entry.evidenceHash, job: publicJob(entry) };
  }),
});

test("private intent policy fixes partner/channel/ecosystem rotation without altering qualification facts", () => {
  assert.equal(validateIntentPolicy(policy), policy);
  assert.equal(policy.queries.length, 6);
  assert.ok(policy.queries.every((query) => /[\u3400-\u9fff]/u.test(query.term) && !/市场|活动|内容/.test(query.term)));
  assert.ok(policy.queries.every((query) => !Object.hasOwn(query, "position")));
  assert.throws(() => validateIntentPolicy({ ...policy, queries: [{ term: "市场", industry: "100021" }] }));
  for (const mode of [undefined, "automatic-publication", "manual-review"]) {
    assert.throws(() => assertCollectionMode({ mode }), { code: "collection-mode-required" });
  }
  assert.doesNotThrow(() => assertCollectionMode({ mode: collectionMode, autoPublish: false, reviewRequired: true }));
});

test("Dingjie-like partner lifecycle is primary intent with explicit pending eligibility, not direction rejection", () => {
  const item = record();
  const before = structuredClone(matching);
  const result = assessForReview(item, matching, policy);
  assert.equal(result.intent.decision, "primary");
  assert.equal(result.intent.family, "partner-development");
  assert.equal(result.qualification.status, "pending");
  assert.ok(result.qualification.reasons.includes("independent-commercial-scope-needs-review"));
  assert.ok(result.qualification.reasons.includes("human-qualification-review-required"));
  assert.ok(!result.qualification.reasons.includes("direction-not-configured"));
  assert.deepEqual(matching, before);
});

test("partner coordination can match intent without satisfying domain or experience gates", () => {
  const result = assessForReview(record("coordination", {
    jd: "岗位职责：\n负责生态合作项目，协助伙伴关系管理，参与商务洽谈和合作协议跟进。\n协调售前与交付团队推动伙伴项目落地。\n任职要求：\n五年以上软件业务经历，需有财务核心系统等垂直领域丰富经验，熟练使用AI工具。",
  }), matching, policy);
  assert.equal(result.intent.decision, "primary");
  assert.equal(result.qualification.status, "pending");
  assert.ok(result.qualification.reasons.includes("specialist-domain-needs-review"));
});

test("required and preferred qualifications remain separate from matching the career direction", () => {
  const configured = { ...matching, years: { ...matching.years, partner: 3, marketing: 3, b2b: 3 } };
  const base = "岗位职责：负责拓展渠道伙伴，建立商机互荐机制，管理伙伴分级经营。\n任职要求：具备渠道销售经验；";
  const required = assessForReview(record("required", { jd: `${base}至少十年渠道业务经验。` }), configured, policy);
  const preferred = assessForReview(record("preferred", { jd: `${base}十年渠道业务经验优先。` }), configured, policy);
  assert.equal(required.intent.decision, "primary");
  assert.equal(preferred.intent.decision, "primary");
  assert.equal(required.qualification.status, "not-met");
  assert.equal(preferred.qualification.status, "pending");
  assert.ok(required.qualification.reasons.includes("years-insufficient"));
  assert.ok(!preferred.qualification.reasons.includes("years-insufficient"));
});

test("incidental partners do not relabel a marketing-led role, and true unrelated jobs stay outside", () => {
  const market = record("market", { jd: "岗位职责：负责品牌传播、内容营销和文案；拓展渠道伙伴并开展联合市场活动。\n任职要求：具备市场营销经验。" });
  assert.equal(assessIntent(market, policy).decision, "outside");
  assert.equal(assessIntent(record(), policy).decision, "primary");
  for (const duties of [
    "负责网络资源采购，开展供应商寻源和比价。",
    "负责客户资金结算和对账。",
    "负责开发ISV技术接口与代码。",
    "负责维护政府关系和公关事务。",
  ]) assert.equal(assessIntent(record("outside", { jd: `岗位职责：${duties}\n任职要求：本科以上。` }), policy).decision, "outside", duties);
  assert.equal(prefilterIntentCard(record("events", { title: "市场活动专员" }), matching, policy, new Set()).eligible, false);
  assert.equal(prefilterIntentCard(record(), matching, policy, new Set([record().id])).eligible, false);
});

test("customer-success and direct-account roles are secondary and never outrank primary queue entries", () => {
  const primary = record("primary");
  const secondary = record("secondary", { jd: "岗位职责：负责行业客户关系维护，制定新客户业务拓展计划。协调内部资源推进客户项目并跟踪销售进展，与客户业务负责人保持沟通。\n任职要求：有制造业客户经营经验，具备跨部门协作及客户沟通能力。" });
  const result = assessIntent(secondary, policy);
  assert.equal(result.decision, "secondary");
  const queue = queued([secondary, primary]);
  assert.equal(listReviews(queue)[0].id, primary.id);
  assert.equal(reviewCounts(queue).primary, 1);
  assert.equal(reviewCounts(queue).secondary, 1);
});

test("material evidence hashes ignore observation timestamps and preserve approvals on identical rereads", () => {
  const original = record();
  const first = queued([original]);
  const approved = approveReviews(first, approval(first), new Set(), "2026-09-10T01:00:00Z");
  const reread = { ...original, retrievedAt: "2026-09-11T00:00:00Z" };
  const updated = updateReviewQueue(approved, [reread], [assessment(reread)], "controlled-test-reread");
  const entry = updated.entries[0];
  assert.equal(entry.status, "approved");
  assert.equal(entry.firstSeen, original.retrievedAt);
  assert.equal(entry.lastSeen, reread.retrievedAt);
  assert.equal(entry.evidenceHash, first.entries[0].evidenceHash);
  assert.equal(entry.approval.job.lastSeen, original.retrievedAt);
  assert.equal(validateReviewQueue(updated), updated);
  const changed = { ...reread, jd: `${jd}\n必须承担独立新增收入配额。`, retrievedAt: "2026-09-12T00:00:00Z" };
  const stale = updateReviewQueue(updated, [changed], [assessment(changed)], "controlled-test-changed");
  assert.equal(stale.entries[0].status, "pending");
  assert.equal(stale.entries[0].approval, null);
  assert.notEqual(stale.entries[0].evidenceHash, entry.evidenceHash);
  assert.throws(() => approveReviews(stale, approval(first)), { code: "approval-stale" });
});

test("manual rejection and private exclusions survive re-observation and changed descriptions", () => {
  const original = record();
  const queue = queued([original]);
  const rejected = rejectReview(queue, original.id, queue.entries[0].evidenceHash);
  const changed = { ...original, jd: `${jd}\nTEST_ONLY_CHANGED`, retrievedAt: "2026-09-11T00:00:00Z" };
  const result = updateReviewQueue(rejected, [changed], [assessment(changed)], "controlled-test-rejected");
  assert.equal(result.entries[0].status, "rejected");
  assert.equal(result.entries[0].approval, null);
  assert.throws(() => approveReviews(result, approval(result)), { code: "approval-blocked" });
  assert.equal(updateReviewQueue(emptyReviewQueue(), [original], [assessment(original)], "controlled-test-excluded",
    new Set([original.id])).entries.length, 0);
});

test("approval requires current hash and exact safe metadata, not an inferred or title-only match", () => {
  const queue = queued([record()]);
  const payload = approval(queue);
  for (const mutate of [
    (item) => { item.evidenceHash = "0".repeat(64); },
    (item) => { item.job.id = "boss-other"; },
    (item) => { item.job.url = "https://example.invalid/"; },
    (item) => { item.job.company = "TEST_OTHER"; },
    (item) => { item.job.firstSeen = "2026-09-09T00:00:00Z"; },
    (item) => { item.job.summary = ["Contact test@example.invalid"]; },
  ]) {
    const changed = structuredClone(payload);
    mutate(changed.approvals[0]);
    assert.throws(() => approveReviews(queue, changed), undefined, mutate.toString());
  }
  assert.throws(() => approveReviews(queue, payload, new Set([record().id])), { code: "approval-blocked" });
  assert.equal(approveReviews(queue, payload).entries[0].status, "approved");
});

test("sequential human publications reset only isNew and preserve honest observation/admission dates", () => {
  const a = record("a"), b = record("b");
  const queue = queued([a, b]), approved = approveReviews(queue, approval(queue));
  const baseline = snapshotOf([]);
  const ledger = { version: 1, reviewedIds: [a.id, b.id], detailIds: [a.id, b.id] };
  const first = buildReviewedSnapshot(baseline, approved, [a.id], ledger, new Set(), "2026-09-11T03:00:00Z");
  const second = buildReviewedSnapshot(first, approved, [b.id], ledger, new Set(), "2026-09-12T03:00:00Z");
  assert.equal(second.run.newCount, 1);
  assert.deepEqual(second.jobs[0], { ...first.jobs[0], isNew: false });
  assert.equal(second.jobs[0].firstSeen, a.retrievedAt);
  assert.equal(second.firstPublishedAtById[a.id], first.firstPublishedAtById[a.id]);
  assert.equal(second.firstPublishedAtById[b.id], "2026-09-12T03:00:00Z");
  assert.equal(selectArrivalView(second.jobs, "today", "2026-09-12T04:00:00Z", second.firstPublishedAtById)[0].id, b.id);
  assert.equal(groupJobsByFirstSeen(second.jobs, { now: "2026-09-12T04:00:00Z", firstPublishedAtById: second.firstPublishedAtById })[0].date, "2026-09-12");
  assert.equal(validateSnapshot(second), second);
  assert.throws(() => buildReviewedSnapshot(baseline, queue, [a.id], ledger, new Set()), { code: "manual-approval-required" });
});

test("private review queue is durable, bounded in list output and rejects unsafe permissions or selectors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-staged-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = queued([record("a"), record("b")]);
  await saveReviewQueue(root, queue);
  assert.deepEqual(await loadReviewQueue(root), queue);
  assert.equal(listReviews(queue, { limit: 1 }).length, 1);
  assert.throws(() => listReviews(queue, { limit: 1000 }));
  assert.throws(() => showReview(queue, "../../keys/test"));
  await chmod(join(root, "review-queue.json"), 0o644);
  await assert.rejects(loadReviewQueue(root), { code: "private-permissions" });
});

test("future activation leaves paused and successful slot history intact across timezone and DST", () => {
  const state = { activatedAt: "2026-01-01T00:00:00Z", lastScheduledSlot: "2026-03-07-1230", lastPublished: { sha: "TEST_ONLY" } };
  const now = new Date("2026-03-08T12:00:00Z");
  const active = activateNextSlot(state, now);
  assert.equal(active.collectionActivatedAt, "2026-03-09T01:30:00.000Z");
  assert.equal(active.lastScheduledSlot, state.lastScheduledSlot);
  assert.deepEqual(active.lastPublished, state.lastPublished);
  assert.equal(dueSlot(active, now), null);
  assert.equal(dueSlot(active, new Date("2026-03-09T01:30:00Z")).id, "2026-03-09-0930");
  assert.equal(state.collectionActivatedAt, undefined);
});

test("unapproved publication is blocked before Git, and stale approvals prevent pending-publication recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-review-gate-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await atomicJson(join(root, "runtime.json"), { mode: collectionMode, autoPublish: false, reviewRequired: true });
  const queue = queued([record()]);
  await saveReviewQueue(root, queue);
  const never = async () => assert.fail("Unapproved records must not reach Git or Pages.");
  await assert.rejects(publishReviewed(root, [record().id], new AbortController().signal, {
    prepareClone: never, git: never, verifyPublication: never,
  }), { code: "manual-approval-required" });
  await atomicJson(join(root, "review-publication-pending.json"), {
    version: 1, ids: [record().id], sha: "a".repeat(40), digest: "b".repeat(64),
    approvalHashes: { [record().id]: queue.entries[0].evidenceHash },
  });
  await assert.rejects(retryReviewedPublication(root, new AbortController().signal, { git: never, verifyPublication: never }),
    { code: "manual-approval-required" });
});

test("an explicitly approved publication can be recovered after a Pages timeout without automatic retries", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "shortlist-review-recovery-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const item = record("pending"), queue = queued([item]), approved = approveReviews(queue, approval(queue));
    await saveReviewQueue(root, approved);
    await atomicJson(join(root, "runtime.json"), { mode: collectionMode, autoPublish: false, reviewRequired: true, repository: "TEST_ONLY/repository" });
    await atomicJson(join(root, "state.json"), { lastPublished: null, lastCollection: { id: "test-collection" } });
    const ledger = { version: 1, reviewedIds: [item.id], detailIds: [item.id] };
    const snapshot = buildReviewedSnapshot(snapshotOf([]), approved, [item.id], ledger, new Set(), "2026-09-11T01:00:00Z");
    const path = join(root, "publish", "docs", "data", "jobs.json");
    await atomicJson(path, snapshot);
    const text = await readFile(path, "utf8"), sha = "a".repeat(40), parent = "b".repeat(40);
    await atomicJson(join(root, "review-publication-pending.json"), {
      version: 1, status: "pending", sha, ids: [item.id],
      digest: createHash("sha256").update(text).digest("hex"),
      approvalHashes: { [item.id]: approved.entries[0].evidenceHash },
    });
    const calls = [];
    const result = await retryReviewedPublication(root, new AbortController().signal, {
      git: async (_runtime, args) => {
        calls.push(args);
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return args[1] === "HEAD^" ? parent : sha;
        if (args[0] === "diff-tree") return "docs/data/jobs.json";
        if (args[0] === "ls-remote") return `${sha}\trefs/heads/main`;
        assert.fail("Already pushed reviewed commit must only be verified, not repushed.");
      },
      verifyPublication: async (_runtime, bytes) => { assert.equal(bytes, text); return { url: "https://example.invalid/", attempts: 1 }; },
    });
    assert.equal(result.status, "published");
    assert.equal(await readJson(join(root, "review-publication-pending.json"), null), null);
    const state = await readJson(join(root, "state.json"));
    assert.equal(state.lastPublished.sha, sha);
    assert.equal(state.lastCollection.id, "test-collection");
    assert.ok(!calls.some((args) => args[0] === "push"));
  });

test("actual private CLI lists/shows review data and refuses publication without approval", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "shortlist-review-cli-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const item = record(), queue = queued([item]);
    await saveReviewQueue(root, queue);
    await atomicJson(join(root, "runtime.json"), { mode: collectionMode, autoPublish: false, reviewRequired: true });
    const cli = new URL("../scheduler/cli.mjs", import.meta.url).pathname;
    const list = JSON.parse(await command(process.execPath, [cli, "review-list", "--root", root, "--limit", "1"]));
    assert.equal(list.entries[0].id, item.id);
    assert.equal(list.entries[0].status, "pending");
    const shown = JSON.parse(await command(process.execPath, [cli, "review-show", "--root", root, "--id", item.id]));
    assert.equal(shown.evidence.jd, item.jd);
    assert.equal(shown.evidenceHash, queue.entries[0].evidenceHash);
    await assert.rejects(command(process.execPath, [cli, "publish-reviewed", "--root", root, "--ids", item.id]),
      (error) => error.stderr.includes("manual-approval-required"));
  });

test("collection configuration validates intent without depending on deploy keys or GitHub credentials", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "shortlist-collection-config-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await atomicJson(join(root, "matching.json"), matching);
    await atomicJson(join(root, "ledger.json"), { version: 1, reviewedIds: [], detailIds: [] });
    await atomicJson(join(root, "intent-policy.json"), policy);
    const runtime = { version: 1, repository: "TEST_ONLY/repository", branch: "main", nodePath: process.execPath,
      mode: collectionMode, autoPublish: false, reviewRequired: true, queries: policy.queries,
      limits: { queriesPerRun: 3, cardsPerQuery: 15, maxCards: 45, maxDetails: 8, maxNewJobs: 0, timeoutMinutes: 30 } };
    await atomicJson(join(root, "runtime.json"), runtime);
    assert.equal((await loadConfiguration(root)).runtime.mode, collectionMode);
    await atomicJson(join(root, "runtime.json"), { ...runtime, queries: [{ term: "市场活动", industry: "100021" }] });
    await assert.rejects(loadConfiguration(root), { code: "invalid-config" });
  });

test("the collection worker has no publisher or notification dependency and daemon results are silent", async () => {
    const runner = await readFile(new URL("../scheduler/runner.mjs", import.meta.url), "utf8");
    const cli = await readFile(new URL("../scheduler/cli.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(runner, /preflightGithub|prepareClone|publishSnapshot|verifyPublication|notifyFailure|from "\.\/publish/);
    assert.match(cli, /if \(action !== "tick"\) console\.log/);
    assert.match(cli, /if \(action !== "tick"\) console\.error/);
  });
