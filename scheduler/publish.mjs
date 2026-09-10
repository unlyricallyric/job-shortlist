import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "./process.mjs";
import { RunError, readJson } from "./io.mjs";
import { validateSnapshot } from "../docs/model.mjs";

const jsonPath = "docs/data/jobs.json";
const trailer = "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>";
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function liveUrl(repository) {
  const [owner, name] = repository.split("/");
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
}

export async function git(runtime, args, options = {}) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  if (/["\r\n]/.test(runtime.knownHostsPath)) throw new RunError("ssh-path", "Pinned host path contains unsupported characters.");
  const ssh = [
    "/usr/bin/ssh", "-F", "/dev/null", "-i", runtime.sshKeyPath,
    "-o", `UserKnownHostsFile="${runtime.knownHostsPath}"`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "HostKeyAlgorithms=ssh-ed25519",
    "-o", "ConnectTimeout=15",
  ].map(quote).join(" ");
  return command(runtime.gitPath, [
    "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", ...args,
  ], { timeout: 60000, ...options, env: {
    GIT_SSH_COMMAND: ssh, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  } });
}

export async function preflightGithub(runtime, signal) {
  await git(runtime, ["ls-remote", `git@github.com:${runtime.repository}.git`, "refs/heads/main"], { signal });
  const response = await fetch(new URL("data/jobs.json", liveUrl(runtime.repository)), {
    cache: "no-store", redirect: "error",
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new RunError("pages-unavailable", "Public GitHub Pages is unavailable.", { blocked: true });
  validateSnapshot(await response.json());
  return { pagesUrl: liveUrl(runtime.repository), authentication: "repository-deploy-key" };
}

export async function prepareClone(root, runtime, signal) {
  const cwd = join(root, "publish");
  if (await readJson(join(root, "pending.json"), null)) {
    throw new RunError("pending-publication", "An earlier publication remains unconfirmed; inspect local status before retrying.", { blocked: true });
  }
  if (await git(runtime, ["status", "--porcelain=v1"], { cwd, signal })) {
    throw new RunError("publish-clone-dirty", "The isolated publishing clone has unexpected local changes.", { blocked: true });
  }
  const remote = await git(runtime, ["remote", "get-url", "origin"], { cwd, signal });
  if (remote !== `https://github.com/${runtime.repository}.git`) {
    throw new RunError("publish-remote", "The isolated publishing clone has an unexpected origin.", { blocked: true });
  }
  if (await git(runtime, ["branch", "--show-current"], { cwd, signal }) !== "main") {
    throw new RunError("publish-branch", "The isolated publishing clone is not on main.", { blocked: true });
  }
  await git(runtime, ["fetch", "--quiet", "origin", "main"], { cwd, signal });
  const local = await git(runtime, ["rev-parse", "HEAD"], { cwd, signal });
  const remoteHead = await git(runtime, ["rev-parse", "origin/main"], { cwd, signal });
  if (local !== remoteHead) {
    try {
      await git(runtime, ["merge-base", "--is-ancestor", local, remoteHead], { cwd, signal });
    } catch (error) {
      if (error.exitCode === 1) throw new RunError("publish-clone-ahead", "Publishing clone is ahead or diverged; inspect pending publication before retrying.", { blocked: true });
      throw error;
    }
    await git(runtime, ["merge", "--ff-only", "origin/main"], { cwd, signal });
  }
  const text = await readFile(join(cwd, jsonPath), "utf8");
  return { cwd, head: remoteHead, text, snapshot: validateSnapshot(JSON.parse(text)) };
}

export async function verifyPublication(runtime, expectedText, signal, { timeoutMs = 240000 } = {}) {
  const url = new URL("data/jobs.json", liveUrl(runtime.repository));
  url.searchParams.set("snapshot", digest(expectedText).slice(0, 16));
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    attempts++;
    try {
      const response = await fetch(url, {
        cache: "no-store", redirect: "error",
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15000)]),
      });
      if (response.ok && await response.text() === expectedText) return { url: liveUrl(runtime.repository), attempts };
      if (response.status === 401 || response.status === 403) throw new RunError("pages-access", "Published Pages data cannot be read.");
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
    }
    await delay(6000, undefined, { signal });
  }
  throw new RunError("pages-timeout", "Git push completed but the expected Pages snapshot was not confirmed.");
}

export async function publishSnapshot(root, runtime, snapshot, prepared, signal, onPending, services = {}) {
  const executeGit = services.git ?? git;
  const verify = services.verifyPublication ?? verifyPublication;
  validateSnapshot(snapshot);
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  const cwd = prepared.cwd;
  const current = await executeGit(runtime, ["rev-parse", "HEAD"], { cwd, signal });
  if (current !== prepared.head || await executeGit(runtime, ["status", "--porcelain=v1"], { cwd, signal })) {
    throw new RunError("publish-changed", "Publishing clone changed during collection; no data was written.", { blocked: true });
  }
  const remote = await executeGit(runtime, ["ls-remote", "origin", "refs/heads/main"], { cwd, signal });
  if (remote.split(/\s+/)[0] !== prepared.head) throw new RunError("publish-conflict", "Remote main changed during collection; no publication attempted.", { blocked: true });
  const candidate = Boolean(snapshot.candidateFeed);
  const runId = snapshot.candidateFeed?.runId ?? snapshot.automation?.runId;
  if (candidate) await onPending({ phase: "prepared", sha: null, baseSha: prepared.head, digest: digest(text), runId });
  signal.throwIfAborted();
  const target = join(cwd, jsonPath);
  await writeFile(`${target}.scheduler-tmp`, text, { mode: 0o600, flag: "wx" });
  await rename(`${target}.scheduler-tmp`, target);
  signal.throwIfAborted();
  await executeGit(runtime, ["add", "--", jsonPath], { cwd, signal });
  const changed = await executeGit(runtime, ["diff", "--cached", "--name-only"], { cwd, signal });
  if (changed !== jsonPath) throw new RunError("publish-paths", "Publication must change only the validated job snapshot.", { blocked: true });
  await executeGit(runtime, ["diff", "--cached", "--check"], { cwd, signal });
  await executeGit(runtime, [
    "-c", "user.name=Job Shortlist Scheduler", "-c", "user.email=job-shortlist-scheduler@users.noreply.github.com",
    "commit", "--quiet", "-m", candidate ? "Update captured job candidates" : "Update scheduled job shortlist snapshot", "-m", trailer,
  ], { cwd, signal });
  const sha = await executeGit(runtime, ["rev-parse", "HEAD"], { cwd, signal });
  await onPending({ sha, digest: digest(text), runId, ...(candidate ? { phase: "committed", baseSha: prepared.head } : {}) });
  signal.throwIfAborted();
  await executeGit(runtime, ["push", "--quiet", `git@github.com:${runtime.repository}.git`, "HEAD:main"], { cwd, signal });
  const publication = await verify(runtime, text, signal);
  return { sha, ...publication };
}

export async function retryPending(root, runtime, signal) {
  const pending = await readJson(join(root, "pending.json"));
  const cwd = join(root, "publish");
  const sha = await git(runtime, ["rev-parse", "HEAD"], { cwd, signal });
  const text = await readFile(join(cwd, jsonPath), "utf8");
  const snapshot = validateSnapshot(JSON.parse(text));
  if (sha !== pending.sha || digest(text) !== pending.digest || snapshot.automation?.runId !== pending.runId
    || await git(runtime, ["status", "--porcelain=v1"], { cwd, signal })) {
    throw new RunError("pending-mismatch", "Pending publication does not match the clean task-owned commit.", { blocked: true });
  }
  const paths = await git(runtime, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], { cwd, signal });
  if (paths !== jsonPath) throw new RunError("pending-paths", "Pending commit includes unexpected files.", { blocked: true });
  const remote = (await git(runtime, ["ls-remote", "origin", "refs/heads/main"], { cwd, signal })).split(/\s+/)[0];
  const parent = await git(runtime, ["rev-parse", "HEAD^"], { cwd, signal });
  if (remote !== sha && remote !== parent) throw new RunError("pending-conflict", "Remote advanced beyond the pending publication; inspect before proceeding.", { blocked: true });
  signal.throwIfAborted();
  if (remote !== sha) await git(runtime, ["push", "--quiet", `git@github.com:${runtime.repository}.git`, "HEAD:main"], { cwd, signal });
  const result = await verifyPublication(runtime, text, signal);
  return { ...result, sha, runId: pending.runId, generatedAt: snapshot.generatedAt, at: new Date().toISOString() };
}
