import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";
import { validateFullReview, buildFullReviewSnapshot } from "../scheduler/full-review.mjs";
import { publishFullReview, retryCandidatePublication } from "../scheduler/publish-candidates.mjs";
import { publishReviewed, retryReviewedPublication } from "../scheduler/publish-reviewed.mjs";
import { buildCandidateSnapshot } from "../scheduler/candidates.mjs";
import { emptyReviewQueue, saveReviewQueue, updateReviewQueue, approveReviews, reviewContext } from "../scheduler/review.mjs";
import { feedbackRolePolicy, loadRoleContext } from "../scheduler/role-exclusions.mjs";
import { defaultIntentPolicy, candidateMode, modeSettings } from "../scheduler/intent.mjs";
import { loadManualExclusions, manualExcludedIds } from "../scheduler/exclusions.mjs";
import { atomicJson, readJson, RunError } from "../scheduler/io.mjs";

const at = "2026-09-10T01:00:00Z", displayed = "2026-09-10T02:00:00Z", policy = feedbackRolePolicy(2);
const textOf = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const card = (id, title = "生态合作经理") => ({
  id: `boss-${id}`, title, url: `https://www.zhipin.com/job_detail/${id}.html`, source: "BOSS直聘",
  company: "TEST_ONLY_COMPANY", location: "上海", experienceText: null, educationText: null, salaryText: null, retrievedAt: at,
});
function fixtureData() {
  const selected = Array.from({ length: 10 }, (_, index) => fixture({
    id: `boss-reviewed-${index}`, url: `https://www.zhipin.com/job_detail/reviewed-${index}.html`,
    title: index < 2 ? "大客户经理" : "合作伙伴经理", isNew: false,
  }));
  const previous = snapshotOf(selected), cards = Array.from({ length: 61 }, (_, index) =>
    card(`sampled-${index}`, index < 5 ? "Java技术经理" : "生态合作经理"));
  const ledger = { version: 1, reviewedIds: [...selected, ...cards].map((item) => item.id), detailIds: selected.map((item) => item.id) };
  const snapshot = buildCandidateSnapshot(previous, { cards, details: [], queries: [], complete: true }, emptyReviewQueue(), ledger, {
    policy: defaultIntentPolicy(), runId: "original-source-test", sampleRunId: "original-source-test", sampledAt: at, now: displayed,
  }).snapshot;
  const removals = new Set([...selected.slice(0, 2), ...cards.slice(0, 5)].map((item) => item.id));
  const text = textOf(snapshot);
  const payload = { version: 1, publicSha256: hash(text), decisions: snapshot.jobs.map((job, index) => ({
    id: job.id, decision: removals.has(job.id) ? "remove" : index % 2 ? "retain" : "uncertain",
    category: removals.has(job.id) ? selected.some((item) => item.id === job.id) ? "frontline-sales" : "technical-function" : null,
  })) };
  return { selected, cards, ledger, snapshot, text, payload, removals };
}

test("full 71-record review removes explicitly rejected selections too, preserving every retained object and first display date", () => {
  const data = fixtureData();
  const result = buildFullReviewSnapshot(data.text, data.payload, policy, "2026-09-11T00:00:00Z");
  assert.equal(result.counts.removed, 7);
  assert.equal(result.counts.removedSelected, 2);
  assert.equal(result.counts.removedCandidates, 5);
  assert.deepEqual(result.snapshot.jobs, data.snapshot.jobs.filter((job) => !data.removals.has(job.id)));
  for (const job of result.snapshot.jobs) {
    assert.equal(result.snapshot.assessmentMethods[job.id], data.snapshot.assessmentMethods[job.id]);
    assert.equal(result.snapshot.firstPublishedAtById[job.id], data.snapshot.firstPublishedAtById[job.id]);
  }
  assert.equal(result.snapshot.candidateFeed.publicationKind, "full-review");
  for (const key of ["sampleRunId", "sampledAt", "cardsThisSample", "detailsThisSample"]) {
    assert.deepEqual(result.snapshot.candidateFeed[key], data.snapshot.candidateFeed[key]);
  }
  assert.equal(result.snapshot.run.cardsReviewed, data.snapshot.run.cardsReviewed);
  assert.equal(result.snapshot.run.detailsRead, data.snapshot.run.detailsRead);
  assert.equal(result.snapshot.run.newCount, 56);
  assert.equal(data.snapshot.jobs.length, 71);
});

test("full audit digest, complete IDs and typed decisions fail closed without guessing removals", () => {
  const data = fixtureData();
  for (const change of [
    (copy) => { copy.publicSha256 = "0".repeat(64); },
    (copy) => { copy.decisions.pop(); },
    (copy) => { copy.decisions[0] = copy.decisions[1]; },
    (copy) => { copy.decisions[0].id = "boss-unseen-record"; },
    (copy) => { copy.decisions[0].decision = "approve"; },
    (copy) => { copy.decisions[0].category = null; },
    (copy) => { copy.decisions[3].category = "technical-function"; },
    (copy) => { copy.decisions[0].category = "personal-private-profile"; },
  ]) {
    const payload = structuredClone(data.payload); change(payload);
    assert.throws(() => validateFullReview(payload, data.text, policy));
  }
  assert.throws(() => validateFullReview(data.payload, `${data.text}\n`, policy), { code: "full-review-stale" });
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-full-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = fixtureData();
  const oldManual = { version: 1, entries: Array.from({ length: 7 }, (_, i) => ({
    id: `boss-old-user-reject-${i}`, excludedAt: at, reasonCode: "user-direction-rejection",
  })) };
  const oldHistory = { version: 1, entries: Array.from({ length: 22 }, (_, i) => ({
    id: `boss-old-role-reject-${i}`, policyId: "role-feedback-v1", policyVersion: 1, category: "procurement",
    reasonCode: "role-procurement", basis: "title", observedAt: at, filteredAt: displayed,
  })) };
  const runtime = { ...modeSettings(candidateMode), roleExclusionsVersion: 2, repository: "TEST_ONLY/repository" };
  await atomicJson(join(root, "runtime.json"), runtime);
  await atomicJson(join(root, "role-exclusions.json"), policy);
  await atomicJson(join(root, "role-exclusions-history.json"), oldHistory);
  await atomicJson(join(root, "manual-exclusions.json"), oldManual);
  await atomicJson(join(root, "ledger.json"), data.ledger);
  await atomicJson(join(root, "state.json"), { lastPublished: { sha: "old-published" }, lastRun: { id: "old-failed", status: "failed" },
    lastCollection: { id: "old-collected" }, queryCursor: 3, lastScheduledSlot: "old-slot" });
  await saveReviewQueue(root, emptyReviewQueue());
  const calls = [], base = "a".repeat(40), sha = "b".repeat(40);
  let output;
  const services = {
    prepareClone: async () => ({ cwd: join(root, "publish"), head: base, snapshot: data.snapshot, text: data.text }),
    publishSnapshot: async (_root, _runtime, snapshot, _prepared, _signal, pending) => {
      calls.push("publish");
      output = snapshot;
      await atomicJson(join(root, "publish/docs/data/jobs.json"), snapshot);
      await pending({ phase: "committed", baseSha: base, sha, digest: hash(textOf(snapshot)), runId: snapshot.candidateFeed.runId });
      return { sha, url: "https://example.invalid/", attempts: 1 };
    },
    git: async (_runtime, args) => {
      calls.push(args[0]);
      if (args[0] === "remote") return "https://github.com/TEST_ONLY/repository.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "rev-parse") return args[1] === "HEAD^" ? base : sha;
      if (args[0] === "diff-tree") return "docs/data/jobs.json";
      if (args[0] === "ls-remote") return `${sha}\trefs/heads/main`;
      return "";
    },
    verifyPublication: async (_runtime, bytes) => { assert.equal(bytes, textOf(output)); return { url: "https://example.invalid/", attempts: 1 }; },
  };
  return { ...data, root, runtime, oldManual, oldHistory, calls, services, output: () => output };
}

test("human full review persists all explicit removals, including old selected IDs, without rewriting old7/22 or queue approvals", async (t) => {
  const data = await setup(t), before = await readJson(join(data.root, "state.json"));
  const queueBytes = await readFile(join(data.root, "review-queue.json"), "utf8");
  const published = await publishFullReview(data.root, data.payload, new AbortController().signal, data.services);
  assert.equal(published.status, "published");
  assert.equal(published.removedSelected, 2);
  assert.equal(published.newlyDisplayed, 0);
  const excluded = await loadManualExclusions(data.root);
  assert.deepEqual(excluded.entries.slice(0, 7), data.oldManual.entries);
  assert.equal(excluded.entries.length, 14);
  assert.ok([...data.removals].every((id) => manualExcludedIds(excluded).has(id)));
  assert.deepEqual(await readJson(join(data.root, "role-exclusions-history.json")), data.oldHistory);
  assert.equal(await readFile(join(data.root, "review-queue.json"), "utf8"), queueBytes);
  const after = await readJson(join(data.root, "state.json"));
  assert.deepEqual({ ...after, lastPublished: before.lastPublished }, before);
  assert.equal(await readJson(join(data.root, "pending.json"), null), null);
  const audit = await readJson(join(data.root, "full-relevance-reviews", `${data.payload.publicSha256}.json`));
  assert.equal(audit.status, "published");
  assert.deepEqual(audit.decisions, data.payload.decisions);
  assert.doesNotMatch(textOf(data.output()), /publicSha256|decisions|role-feedback-v2|role-technical/);
});

test("stale full review changes neither exclusions nor publication", async (t) => {
  const data = await setup(t);
  await assert.rejects(publishFullReview(data.root, { ...data.payload, publicSha256: "0".repeat(64) },
    new AbortController().signal, data.services), { code: "full-review-stale" });
  assert.deepEqual(await loadManualExclusions(data.root), data.oldManual);
  assert.equal(data.calls.length, 0);
});

test("a transient Pages failure keeps explicit feedback durable and recovers through the existing receipt without re-approval", async (t) => {
  const data = await setup(t), commit = data.services.publishSnapshot;
  data.services.publishSnapshot = async (...args) => {
    await commit(...args);
    throw new RunError("pages-timeout", "TEST_ONLY");
  };
  await assert.rejects(publishFullReview(data.root, data.payload, new AbortController().signal, data.services), { code: "pages-timeout" });
  assert.equal((await readJson(join(data.root, "state.json"))).lastPublished.sha, "old-published");
  const excluded = manualExcludedIds(await loadManualExclusions(data.root));
  assert.ok([...data.removals].every((id) => excluded.has(id)));
  const pending = await readJson(join(data.root, "pending.json"));
  assert.equal(pending.fullReview.status, "pending");
  const recovered = await retryCandidatePublication(data.root, new AbortController().signal, data.services);
  assert.equal(recovered.status, "published");
  assert.equal(await readJson(join(data.root, "pending.json"), null), null);
  assert.equal((await readJson(join(data.root, "full-relevance-reviews", `${data.payload.publicSha256}.json`))).status, "published");
});

test("new removals and previous7/22 cannot reappear through queue or captured-card merges", async (t) => {
  const data = await setup(t);
  await publishFullReview(data.root, data.payload, new AbortController().signal, data.services);
  const oldExcluded = [...data.oldManual.entries, ...data.oldHistory.entries].map((item) => card(item.id.slice(5)));
  const returned = data.snapshot.jobs.filter((job) => data.removals.has(job.id)).map((job) => card(job.id.slice(5)));
  const records = [...oldExcluded, ...returned];
  const roleContext = await loadRoleContext(data.root, data.runtime);
  const allIds = [...new Set([...data.ledger.reviewedIds, ...records.map((item) => item.id)])];
  const merged = buildCandidateSnapshot(data.output(), { cards: records, details: [], complete: true, queries: [] }, emptyReviewQueue(),
    { ...data.ledger, reviewedIds: allIds }, { roleContext, excludedIds: manualExcludedIds(await loadManualExclusions(data.root)),
      policy: defaultIntentPolicy(), runId: "future-captured-reappearance", sampledAt: at });
  assert.deepEqual(merged.snapshot.jobs.map((job) => job.id), data.output().jobs.map((job) => job.id));
});

test("previous human approval and pending manual publication cannot override a full-review ID rejection", async (t) => {
  const data = await setup(t);
  const job = data.selected[0];
  const record = { ...job, retrievedAt: job.lastSeen,
    jd: "岗位职责：负责客户业务开发，协调合作和项目跟进，负责推进商业沟通和客户需求梳理。\n任职要求：具备相关经验，能够独立完成业务协作及客户关系维护，具体职位条件仍需进一步核对。" };
  const queue = updateReviewQueue(emptyReviewQueue(), [record], [{
    id: job.id, intent: { decision: "primary", family: "channel-management", reasons: ["test-only"] },
    qualification: { status: "pending", reasons: ["test-only"] },
  }], "test-old-human-review");
  const approved = approveReviews(queue, { version: 1, approvals: [{
    id: job.id, evidenceHash: queue.entries[0].evidenceHash, job: { ...job, firstSeen: record.retrievedAt, isNew: true },
  }] });
  await saveReviewQueue(data.root, approved);
  await publishFullReview(data.root, data.payload, new AbortController().signal, data.services);
  const never = async () => assert.fail("Old approvals cannot publish an explicitly rejected ID.");
  await assert.rejects(publishReviewed(data.root, [job.id], new AbortController().signal, { prepareClone: never },
    { roleOverride: true }), { code: "manual-approval-required" });
  await atomicJson(join(data.root, "review-publication-pending.json"), {
    version: 1, ids: [job.id], sha: "c".repeat(40), digest: "d".repeat(64), approvalHashes: { [job.id]: queue.entries[0].evidenceHash },
  });
  await assert.rejects(retryReviewedPublication(data.root, new AbortController().signal, { git: never }), { code: "manual-approval-required" });
  const current = await reviewContext(data.root);
  assert.throws(() => approveReviews(current.queue, { version: 1, approvals: [{
    id: job.id, evidenceHash: queue.entries[0].evidenceHash, job: approved.entries[0].approval.job,
  }] }, current.excludedIds), { code: "approval-blocked" });
});
