import { join } from "node:path";
import { readFile, lstat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { atomicJson, readJson, RunError, appendLog } from "./io.mjs";
import { assertRuntimeMode, candidateMode, validateIntentPolicy } from "./intent.mjs";
import { reviewContext } from "./review.mjs";
import { buildCandidateSnapshot, rejectedCandidateIds, filterRoleCandidates, withoutSnapshotJobs } from "./candidates.mjs";
import { validateLedger } from "./snapshot.mjs";
import { prepareClone, git, publishSnapshot, verifyPublication } from "./publish.mjs";
import { validateSnapshot, candidateCounts } from "../docs/model.mjs";
import { loadRoleContext, rememberRoleExclusions } from "./role-exclusions.mjs";
import { buildFullReviewSnapshot, validateFullReviewReceipt } from "./full-review.mjs";
import { appendManualExclusions, loadManualExclusions } from "./exclusions.mjs";

const path = "docs/data/jobs.json";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const bytes = (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;
const validId = (id) => typeof id === "string" && /^[a-z0-9-]{8,90}$/.test(id);

async function candidateRuntime(root) {
  const runtime = await readJson(join(root, "runtime.json"));
  assertRuntimeMode(runtime);
  if (runtime.mode !== candidateMode) throw new RunError("candidate-mode-required", "Candidate publishing is disabled in collection-only mode.");
  if (await readJson(join(root, "review-publication-pending.json"), null)) {
    throw new RunError("review-publication-pending", "Recover the explicit reviewed publication before publishing candidates.", { blocked: true });
  }
  return runtime;
}

async function recordPublication(root, receipt, verified) {
  const { snapshot } = receipt;
  if (receipt.fullReview) validateFullReviewReceipt(receipt.fullReview, snapshot);
  const at = new Date().toISOString();
  const publication = { type: candidateMode, at, sha: receipt.sha, url: verified.url,
    runId: snapshot.candidateFeed.runId, sampleRunId: snapshot.candidateFeed.sampleRunId,
    generatedAt: snapshot.generatedAt, publicationKind: snapshot.candidateFeed.publicationKind };
  const result = { status: "published", ...publication, digest: receipt.digest, attempts: verified.attempts,
    total: snapshot.jobs.length, newCount: snapshot.run.newCount, ...candidateCounts(snapshot) };
  await atomicJson(join(root, "candidate-publication.json"), result);
  const state = await readJson(join(root, "state.json"));
  state.lastPublished = publication;
  await atomicJson(join(root, "state.json"), state);
  if (receipt.fullReview) {
    await atomicJson(join(root, "full-relevance-reviews", `${receipt.fullReview.publicSha256}.json`), {
      ...receipt.fullReview, status: "published", at, sha: receipt.sha,
    });
  }
  await unlink(join(root, "pending.json"));
  return result;
}

async function commitCandidates(root, runtime, prepared, snapshot, signal, services, metadata = {}) {
  let receipt;
  const verified = await (services.publishSnapshot ?? publishSnapshot)(root, runtime, snapshot, prepared, signal, async (binding) => {
    receipt = { version: 1, type: candidateMode, status: "pending", ...binding, snapshot, ...metadata };
    await atomicJson(join(root, "pending.json"), receipt);
  }, services);
  if (!receipt || receipt.sha !== verified.sha) throw new RunError("candidate-receipt-missing", "Candidate publication has no matching durable receipt.");
  return recordPublication(root, receipt, verified);
}

// The caller owns the kernel mutex; explicit negative feedback is not an approval or qualification gate.
export async function publishCandidates(root, context, signal, services = {}) {
  const runtime = await candidateRuntime(root);
  const roleContext = await loadRoleContext(root, runtime);
  const { queue, excludedIds } = await reviewContext(root);
  const prepared = await (services.prepareClone ?? prepareClone)(root, runtime, signal);
  const { snapshot, rejectedRecords, removals } = buildCandidateSnapshot(prepared.snapshot, context.evidence, queue, context.ledger, {
    policy: context.intent, excludedIds, roleContext, runId: context.runId, sampleRunId: context.sampleRunId,
    sampledAt: context.sampledAt, publicationKind: context.publicationKind, now: context.now,
  });
  await rememberRoleExclusions(root, roleContext, removals);
  if (rejectedRecords.length) await appendLog(root, { event: "candidate-safety-exclusions", runId: context.runId,
    counts: Object.fromEntries([...new Set(rejectedRecords.map((item) => item.code))]
      .map((code) => [code, rejectedRecords.filter((item) => item.code === code).length])) });
  return commitCandidates(root, runtime, prepared, snapshot, signal, services);
}

export async function publishRoleCleanup(root, signal, services = {}) {
  const runtime = await candidateRuntime(root), roleContext = await loadRoleContext(root, runtime);
  if (!roleContext.policy) throw new RunError("role-policy-missing", "Configure an explicit feedback policy before filtering candidates.");
  const { queue, excludedIds } = await reviewContext(root);
  const prepared = await (services.prepareClone ?? prepareClone)(root, runtime, signal);
  if (!prepared.snapshot.candidateFeed) throw new RunError("candidate-feed-missing", "Feedback cleanup requires an existing candidate snapshot.");
  const allowed = withoutSnapshotJobs(prepared.snapshot, excludedIds);
  const { snapshot, removals, selectionConflicts } = filterRoleCandidates(allowed, queue, roleContext);
  const now = new Date().toISOString();
  const filtered = validateSnapshot({ ...snapshot, generatedAt: now,
    run: { ...snapshot.run, scope: "上海 · 企业级科技 · 岗位采样与已保存线索" },
    candidateFeed: { ...snapshot.candidateFeed, publicationKind: "feedback-filter", runId: `feedback-${now.replace(/\D/g, "")}` } });
  await rememberRoleExclusions(root, roleContext, removals, now);
  const audit = { version: 1, policy: roleContext.policy.id, at: now, removals, selectionConflicts };
  await atomicJson(join(root, "role-exclusion-cleanup.json"), audit);
  const publication = await commitCandidates(root, runtime, prepared, filtered, signal, services);
  return { ...publication, removedCandidates: removals.length,
    removedByCategory: Object.fromEntries(roleContext.policy.categories.map((category) =>
      [category, removals.filter((item) => item.category === category).length])),
    priorSelectionConflicts: selectionConflicts.map((item) => item.id) };
}

export async function publishFullReview(root, payload, signal, services = {}) {
  const runtime = await candidateRuntime(root), roleContext = await loadRoleContext(root, runtime);
  if (roleContext.policy?.version !== 2) throw new RunError("full-review-policy-required", "Full relevance review requires the explicit extended role policy.");
  if (await readJson(join(root, "pending.json"), null)) {
    throw new RunError("pending-publication", "Recover the existing pending publication before applying a new full review.", { blocked: true });
  }
  if ((await readJson(join(root, "state.json"))).lastRun?.status === "running" || await readJson(join(root, "request.json"), null)) {
    throw new RunError("full-review-run-active", "Finish the active or requested collection before applying a full review.", { blocked: true });
  }
  const prepared = await (services.prepareClone ?? prepareClone)(root, runtime, signal);
  const { snapshot, removedIds, counts } = buildFullReviewSnapshot(prepared.text, payload, roleContext.policy);
  const exclusions = appendManualExclusions(await loadManualExclusions(root), [...removedIds], snapshot.generatedAt);
  const { excludedIds } = await reviewContext(root);
  if (snapshot.jobs.some((job) => excludedIds.has(job.id))) {
    throw new RunError("full-review-rejected-retention", "A retained record has an existing explicit rejection; review this conflict before publication.", { blocked: true });
  }
  const fullReview = { version: 1, status: "pending", publicSha256: payload.publicSha256,
    decisions: payload.decisions, policyId: roleContext.policy.id, reviewedAt: snapshot.generatedAt, counts };
  signal.throwIfAborted();
  await atomicJson(join(root, "full-relevance-reviews", `${payload.publicSha256}.json`), fullReview);
  await atomicJson(join(root, "manual-exclusions.json"), exclusions);
  const publication = await commitCandidates(root, runtime, prepared, snapshot, signal, services, { fullReview });
  return { ...publication, ...counts, newlyDisplayed: 0 };
}

export async function publishCaptured(root, sampleRunId, signal, services = {}) {
  await candidateRuntime(root);
  if (!validId(sampleRunId)) throw new RunError("invalid-captured-run", "Supply an exact completed source run ID.");
  const evidence = await readJson(join(root, "runs", sampleRunId, "evidence.json"));
  const result = await readJson(join(root, "runs", sampleRunId, "result.json"));
  if (!["collected", "succeeded"].includes(result.status) || result.id !== sampleRunId || evidence.complete !== true) {
    throw new RunError("incomplete-candidate-sample", "Backfill requires a completed, identified source run.");
  }
  const intent = validateIntentPolicy(await readJson(join(root, "intent-policy.json")));
  const ledger = validateLedger(await readJson(join(root, "ledger.json")));
  return publishCandidates(root, { evidence, ledger, intent, sampleRunId,
    runId: `backfill-${new Date().toISOString().replace(/\D/g, "")}-${randomUUID().slice(0, 8)}`,
    sampledAt: result.sampledAt ?? result.finishedAt, publicationKind: "manual-backfill",
  }, signal, services);
}

export async function retryCandidatePublication(root, signal, services = {}) {
  const executeGit = services.git ?? git, verify = services.verifyPublication ?? verifyPublication;
  const runtime = await candidateRuntime(root);
  const roleContext = await loadRoleContext(root, runtime);
  const receipt = await readJson(join(root, "pending.json"));
  if (receipt.version !== 1 || receipt.type !== candidateMode || receipt.status !== "pending"
    || !["prepared", "committed"].includes(receipt.phase) || !/^[a-f0-9]{40}$/.test(receipt.baseSha)
    || (receipt.phase === "committed" && !/^[a-f0-9]{40}$/.test(receipt.sha))
    || !/^[a-f0-9]{64}$/.test(receipt.digest) || !validId(receipt.runId)) {
    throw new RunError("candidate-pending-invalid", "The pending candidate receipt is invalid.", { blocked: true });
  }
  const snapshot = validateSnapshot(receipt.snapshot), text = bytes(snapshot);
  if (snapshot.candidateFeed?.publicationKind === "full-review") validateFullReviewReceipt(receipt.fullReview, snapshot);
  if (hash(text) !== receipt.digest || snapshot.candidateFeed?.runId !== receipt.runId) {
    throw new RunError("candidate-pending-mismatch", "Pending candidate snapshot content changed.", { blocked: true });
  }
  const { queue, excludedIds } = await reviewContext(root);
  const rejected = rejectedCandidateIds(queue, excludedIds);
  if (snapshot.jobs.some((job) => rejected.has(job.id))) {
    throw new RunError("candidate-pending-excluded", "A pending record was explicitly rejected; do not push or confirm the stale snapshot.", { blocked: true });
  }
  const filtered = filterRoleCandidates(snapshot, queue, roleContext);
  if (filtered.removals.length) {
    await rememberRoleExclusions(root, roleContext, filtered.removals);
    throw new RunError("candidate-pending-role-excluded", "Current feedback excludes a pending candidate; stale publication is blocked.", { blocked: true });
  }
  const cwd = join(root, "publish"), target = join(cwd, path);
  if (await executeGit(runtime, ["remote", "get-url", "origin"], { cwd, signal }) !== `https://github.com/${runtime.repository}.git`
    || await executeGit(runtime, ["branch", "--show-current"], { cwd, signal }) !== "main") {
    throw new RunError("candidate-recovery-clone", "Recovery requires the exact task-owned main clone.", { blocked: true });
  }
  let head = await executeGit(runtime, ["rev-parse", "HEAD"], { cwd, signal });
  if (head === receipt.baseSha && receipt.phase === "prepared") {
    const dirty = await executeGit(runtime, ["status", "--porcelain=v1"], { cwd, signal });
    if (dirty.split("\n").filter(Boolean).some((line) => ![
      `M ${path}`, `MM ${path}`, `?? ${path}.scheduler-tmp`,
    ].includes(line.trim().replace(/\s+/g, " ")))) throw new RunError("candidate-recovery-dirty", "Recovery will not touch unexpected clone changes.");
    const original = await executeGit(runtime, ["show", `${head}:${path}`], { cwd, signal });
    const current = await readFile(target, "utf8");
    const staged = await executeGit(runtime, ["show", `:${path}`], { cwd, signal });
    if (![original.trim(), text.trim()].includes(current.trim()) || ![original.trim(), text.trim()].includes(staged.trim())) {
      throw new RunError("candidate-recovery-changed", "Snapshot edits do not match the pending publication.");
    }
    const remote = (await executeGit(runtime, ["ls-remote", "origin", "refs/heads/main"], { cwd, signal })).split(/\s+/)[0];
    if (remote !== head) throw new RunError("candidate-recovery-conflict", "Remote main advanced before candidate recovery.");
    try {
      const info = await lstat(`${target}.scheduler-tmp`);
      if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(`${target}.scheduler-tmp`, "utf8")) !== receipt.digest) {
        throw new RunError("candidate-recovery-temp", "Unexpected temporary snapshot requires inspection.");
      }
      await unlink(`${target}.scheduler-tmp`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    signal.throwIfAborted();
    await atomicJson(target, snapshot);
    await executeGit(runtime, ["add", "--", path], { cwd, signal });
    if (await executeGit(runtime, ["diff", "--cached", "--name-only"], { cwd, signal }) !== path) {
      throw new RunError("candidate-recovery-paths", "Only the pending public snapshot may be committed.");
    }
    await executeGit(runtime, ["diff", "--cached", "--check"], { cwd, signal });
    await executeGit(runtime, ["-c", "user.name=Job Shortlist Scheduler", "-c", "user.email=job-shortlist-scheduler@users.noreply.github.com",
      "commit", "--quiet", "-m", "Update captured job candidates",
      "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"], { cwd, signal });
    head = await executeGit(runtime, ["rev-parse", "HEAD"], { cwd, signal });
  }
  if ((receipt.sha && receipt.sha !== head)
    || await executeGit(runtime, ["rev-parse", "HEAD^"], { cwd, signal }) !== receipt.baseSha
    || await executeGit(runtime, ["status", "--porcelain=v1"], { cwd, signal })
    || await executeGit(runtime, ["diff-tree", "--no-commit-id", "--name-only", "-r", head], { cwd, signal }) !== path
    || hash(await readFile(target, "utf8")) !== receipt.digest) {
    throw new RunError("candidate-recovery-mismatch", "The clean commit does not match the pending candidate snapshot.", { blocked: true });
  }
  receipt.sha = head;
  receipt.phase = "committed";
  await atomicJson(join(root, "pending.json"), receipt);
  const remote = (await executeGit(runtime, ["ls-remote", "origin", "refs/heads/main"], { cwd, signal })).split(/\s+/)[0];
  if (![head, receipt.baseSha].includes(remote)) throw new RunError("candidate-recovery-conflict", "Remote main advanced beyond the pending candidate commit.");
  signal.throwIfAborted();
  if (remote !== head) await executeGit(runtime, ["push", "--quiet", `git@github.com:${runtime.repository}.git`, "HEAD:main"], { cwd, signal });
  return recordPublication(root, receipt, await verify(runtime, text, signal));
}
