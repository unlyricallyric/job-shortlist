import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { atomicJson, readJson, RunError } from "./io.mjs";
import { prepareClone, git, verifyPublication } from "./publish.mjs";
import { reviewContext, buildReviewedSnapshot } from "./review.mjs";
import { validateLedger } from "./snapshot.mjs";
import { assertRuntimeMode } from "./intent.mjs";
import { validateSnapshot } from "../docs/model.mjs";
import { loadRoleContext, assessRoleExclusion, rememberRoleExclusions } from "./role-exclusions.mjs";
import { filterRoleCandidates } from "./candidates.mjs";

function requireRoleOverride(queue, ids, context, overrides = []) {
  const blocked = ids.filter((id) => context.history.entries.some((entry) => entry.id === id)
    || assessRoleExclusion(queue.entries.find((entry) => entry.id === id).evidence, context.policy));
  if (blocked.some((id) => !overrides.includes(id))) {
    throw new RunError("role-override-required", "Current feedback excludes this role; publication needs an explicit human role override.");
  }
  return blocked;
}

async function recordPublication(root, receipt, verified) {
  const result = { ...receipt, status: "published", publishedAt: new Date().toISOString(), ...verified };
  await atomicJson(join(root, "review-publication.json"), result);
  const state = await readJson(join(root, "state.json"));
  state.lastPublished = { at: result.publishedAt, sha: receipt.sha, url: verified.url, type: "explicit-human-review", ids: receipt.ids };
  await atomicJson(join(root, "state.json"), state);
  await unlink(join(root, "review-publication-pending.json"));
  return result;
}

function verifyApprovalBindings(queue, ids, excludedIds, bindings) {
  for (const id of ids) {
    const entry = queue.entries.find((item) => item.id === id);
    if (!entry || entry.status !== "approved" || entry.evidenceHash !== entry.approval?.evidenceHash || excludedIds.has(id)
      || (bindings && bindings[id] !== entry.evidenceHash) || entry.qualification.status === "not-met") {
      throw new RunError("manual-approval-required", "Every publication ID requires current explicit human approval.");
    }
  }
}

// Caller holds the scheduler mutex. This entry point is never called by tick/run-once.
export async function publishReviewed(root, ids, signal, services = {}, { roleOverride = false } = {}) {
  const operations = { prepareClone, git, verifyPublication, ...services };
  const runtime = await readJson(join(root, "runtime.json"));
  assertRuntimeMode(runtime);
  const { queue, excludedIds } = await reviewContext(root);
  // Check approval before touching any Git/network state.
  verifyApprovalBindings(queue, ids, excludedIds);
  const roleContext = await loadRoleContext(root, runtime);
  const roleOverrideIds = requireRoleOverride(queue, ids, roleContext, roleOverride ? ids : []);
  if (!ids.length || new Set(ids).size !== ids.length) throw new RunError("invalid-reviewed-selection", "Supply unique approved IDs.");
  if (await readJson(join(root, "review-publication-pending.json"), null)) {
    throw new RunError("review-publication-pending", "Inspect the previous unconfirmed reviewed publication before another push.", { blocked: true });
  }
  const ledger = validateLedger(await readJson(join(root, "ledger.json")));
  const prepared = await operations.prepareClone(root, runtime, signal);
  const reviewed = buildReviewedSnapshot(prepared.snapshot, queue, ids, ledger, excludedIds);
  const { snapshot, removals } = filterRoleCandidates(reviewed, queue, roleContext);
  await rememberRoleExclusions(root, roleContext, removals);
  const remote = await operations.git(runtime, ["ls-remote", "origin", "refs/heads/main"], { cwd: prepared.cwd, signal });
  if (remote.split(/\s+/)[0] !== prepared.head) throw new RunError("publish-conflict", "Remote main changed before the explicit publication.");
  signal.throwIfAborted();
  const path = join(prepared.cwd, "docs/data/jobs.json");
  await atomicJson(path, snapshot);
  const text = await readFile(path, "utf8");
  await operations.git(runtime, ["add", "--", "docs/data/jobs.json"], { cwd: prepared.cwd, signal });
  if (await operations.git(runtime, ["diff", "--cached", "--name-only"], { cwd: prepared.cwd, signal }) !== "docs/data/jobs.json") {
    throw new RunError("publish-paths", "Reviewed publication must change only the public snapshot.");
  }
  await operations.git(runtime, [
    "-c", "user.name=Job Shortlist Curator", "-c", "user.email=job-shortlist-curator@users.noreply.github.com",
    "commit", "--quiet", "-m", "Publish explicitly reviewed shortlist additions",
    "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>",
  ], { cwd: prepared.cwd, signal });
  const sha = await operations.git(runtime, ["rev-parse", "HEAD"], { cwd: prepared.cwd, signal });
  const receipt = { version: 1, status: "pending", sha, ids, digest: createHash("sha256").update(text).digest("hex"),
    ...(roleContext.policy ? { rolePolicyId: roleContext.policy.id, roleOverrideIds } : {}),
    approvalHashes: Object.fromEntries(ids.map((id) => [id, queue.entries.find((entry) => entry.id === id).evidenceHash])),
    approvalJobHashes: Object.fromEntries(ids.map((id) => [id, createHash("sha256").update(JSON.stringify(queue.entries.find((entry) => entry.id === id).approval.job)).digest("hex")])) };
  await atomicJson(join(root, "review-publication-pending.json"), receipt);
  signal.throwIfAborted();
  await operations.git(runtime, ["push", "--quiet", `git@github.com:${runtime.repository}.git`, "HEAD:main"], { cwd: prepared.cwd, signal });
  const verified = await operations.verifyPublication(runtime, text, signal);
  return recordPublication(root, receipt, verified);
}

export async function retryReviewedPublication(root, signal, services = {}) {
  const executeGit = services.git ?? git;
  const verify = services.verifyPublication ?? verifyPublication;
  const runtime = await readJson(join(root, "runtime.json"));
  assertRuntimeMode(runtime);
  const receipt = await readJson(join(root, "review-publication-pending.json"));
  if (receipt.version !== 1 || !Array.isArray(receipt.ids) || !receipt.ids.length
    || new Set(receipt.ids).size !== receipt.ids.length || !/^[a-f0-9]{40}$/.test(receipt.sha)
    || !/^[a-f0-9]{64}$/.test(receipt.digest) || !receipt.approvalHashes) {
    throw new RunError("invalid-reviewed-receipt", "The pending reviewed publication receipt is invalid.");
  }
  const { queue, excludedIds } = await reviewContext(root);
  verifyApprovalBindings(queue, receipt.ids, excludedIds, receipt.approvalHashes);
  const roleContext = await loadRoleContext(root, runtime);
  requireRoleOverride(queue, receipt.ids, roleContext, receipt.rolePolicyId === roleContext.policy?.id ? receipt.roleOverrideIds ?? [] : []);
  const cwd = join(root, "publish");
  if (await executeGit(runtime, ["status", "--porcelain=v1"], { cwd, signal })
    || await executeGit(runtime, ["rev-parse", "HEAD"], { cwd, signal }) !== receipt.sha) {
    throw new RunError("reviewed-recovery-mismatch", "The publishing clone no longer matches the pending reviewed commit.");
  }
  const text = await readFile(join(cwd, "docs/data/jobs.json"), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== receipt.digest) throw new RunError("reviewed-recovery-mismatch", "Pending snapshot bytes changed.");
  const snapshot = validateSnapshot(JSON.parse(text));
  if (snapshot.jobs.some((job) => excludedIds.has(job.id))) throw new RunError("candidate-pending-excluded", "A pending reviewed snapshot contains an explicitly excluded record.");
  if (filterRoleCandidates(snapshot, queue, roleContext).removals.length) {
    throw new RunError("candidate-pending-role-excluded", "Current feedback excludes a retained candidate in the reviewed snapshot.");
  }
  for (const id of receipt.ids) {
    const approved = queue.entries.find((entry) => entry.id === id).approval.job;
    if (receipt.approvalJobHashes
      ? receipt.approvalJobHashes[id] !== createHash("sha256").update(JSON.stringify(approved)).digest("hex")
      : JSON.stringify(snapshot.jobs.find((job) => job.id === id)) !== JSON.stringify(approved)) {
      throw new RunError("reviewed-approval-changed", "The approval payload changed after the pending commit.");
    }
  }
  if (await executeGit(runtime, ["diff-tree", "--no-commit-id", "--name-only", "-r", receipt.sha], { cwd, signal }) !== "docs/data/jobs.json") {
    throw new RunError("reviewed-recovery-paths", "Pending commit includes unexpected files.");
  }
  const remote = (await executeGit(runtime, ["ls-remote", `https://github.com/${runtime.repository}.git`, "refs/heads/main"], { cwd, signal })).split(/\s+/)[0];
  const parent = await executeGit(runtime, ["rev-parse", "HEAD^"], { cwd, signal });
  if (remote !== receipt.sha && remote !== parent) throw new RunError("reviewed-recovery-conflict", "Remote main advanced beyond the pending reviewed publication.");
  signal.throwIfAborted();
  if (remote !== receipt.sha) await executeGit(runtime, ["push", "--quiet", `git@github.com:${runtime.repository}.git`, "HEAD:main"], { cwd, signal });
  return recordPublication(root, receipt, await verify(runtime, text, signal));
}
