#!/usr/bin/env node
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultRoot, label, awakeLabel } from "./config.mjs";
import { RunError, atomicJson, readJson, appendLog, acquireLock } from "./io.mjs";
import { loadConfiguration } from "./config.mjs";
import { run, status, preflight } from "./runner.mjs";
import { install, pause, resume, uninstall, isLoaded, serviceDomain } from "./install.mjs";
import { command } from "./process.mjs";
import { assertRuntimeMode } from "./intent.mjs";
import { reviewContext, reviewCounts, listReviews, showReview, approveReviews, rejectReview, saveReviewQueue } from "./review.mjs";
import { publishReviewed, retryReviewedPublication } from "./publish-reviewed.mjs";
import { loadManualExclusions, validateManualExclusions } from "./exclusions.mjs";
import { publishCaptured, retryCandidatePublication, publishRoleCleanup, publishFullReview } from "./publish-candidates.mjs";

process.umask(0o077);
const [action, ...args] = process.argv.slice(2);
const values = new Map();
const flags = new Set();
const known = new Set(["root", "matching", "ledger", "ssh-key", "known-hosts", "repository", "node", "git", "adopt-window", "adopt-tab",
  "mode", "file", "id", "ids", "evidence-hash", "limit", "status", "run-id"]);
for (let index = 0; index < args.length; index++) {
  const name = args[index].replace(/^--/, "");
  if (!args[index].startsWith("--")) throw new Error("Expected a named command option.");
  if (name === "dry-run" || name === "no-browser" || name === "controlled" || name === "override-role-exclusions") flags.add(name);
  else if (known.has(name) && args[index + 1] && !args[index + 1].startsWith("--")) values.set(name, args[++index]);
  else throw new Error("Unknown or missing command option.");
}
const root = values.get("root") ?? defaultRoot();
try {
  let result;
  if (action === "install") {
    result = await install({
      root, matchingPath: values.get("matching"), ledgerPath: values.get("ledger"),
      sshKeyPath: values.get("ssh-key"), knownHostsPath: values.get("known-hosts"),
      repository: values.get("repository"), nodePath: values.get("node") ?? process.execPath,
      gitPath: values.get("git") ?? "/usr/bin/git",
      adoptWindow: values.has("adopt-window") ? Number(values.get("adopt-window")) : undefined,
      adoptTab: values.has("adopt-tab") ? Number(values.get("adopt-tab")) : undefined,
      mode: values.get("mode"),
    });
  } else if (action === "status") {
    const power = await command("/usr/bin/pmset", ["-g", "batt"]);
    result = { ...await status(root), launchdLoaded: await isLoaded(label), acOnlyHelperLoaded: await isLoaded(awakeLabel),
      powerSource: /AC Power/.test(power) ? "AC" : /Battery Power/.test(power) ? "battery" : "unknown" };
  } else if (action === "pause") result = await pause(root);
  else if (action === "resume") result = await resume(root);
  else if (action === "uninstall") result = await uninstall(root);
  else if (action === "preflight") result = await preflight(root, { browser: !flags.has("no-browser") });
  else if (action === "retry-publication") {
    throw new RunError("manual-approval-required", "Legacy automatic publication recovery is disabled; use current human review approvals.");
  } else if (["review-list", "review-show"].includes(action)) {
    const { queue, excludedIds } = await reviewContext(root);
    result = action === "review-list" ? { counts: reviewCounts(queue, excludedIds), entries: listReviews(queue, {
      limit: values.has("limit") ? Number(values.get("limit")) : 20, status: values.get("status") ?? "pending", excludedIds,
    }) } : showReview(queue, values.get("id"));
  } else if (["publish-captured", "retry-candidate-publication", "filter-candidates", "publish-full-review"].includes(action)) {
    const release = await acquireLock(root, action);
    try {
      const signal = AbortSignal.any([release.signal, AbortSignal.timeout(300000)]);
      result = action === "publish-full-review" ? await publishFullReview(root, await readJson(values.get("file")), signal)
        : action === "publish-captured" ? await publishCaptured(root, values.get("run-id"), signal)
        : action === "filter-candidates" ? await publishRoleCleanup(root, signal) : await retryCandidatePublication(root, signal);
    } finally { await release(); }
  } else if (["review-approve", "review-reject", "publish-reviewed", "retry-reviewed-publication"].includes(action)) {
    const release = await acquireLock(root, action);
    try {
      assertRuntimeMode(await readJson(join(root, "runtime.json")));
      const { queue, excludedIds } = await reviewContext(root);
      if (action === "retry-reviewed-publication") {
        result = await retryReviewedPublication(root, AbortSignal.any([release.signal, AbortSignal.timeout(300000)]));
      } else if (action === "review-approve") {
        const payload = await readJson(values.get("file"));
        const updated = approveReviews(queue, payload, excludedIds);
        await saveReviewQueue(root, updated);
        result = { approved: payload.approvals.map((item) => item.id), published: false };
      } else if (action === "review-reject") {
        const id = values.get("id"), now = new Date().toISOString();
        const updated = rejectReview(queue, id, values.get("evidence-hash"), now);
        const exclusions = await loadManualExclusions(root);
        if (!exclusions.entries.some((entry) => entry.id === id)) exclusions.entries.push({ id, excludedAt: now, reasonCode: "user-direction-rejection" });
        await atomicJson(join(root, "manual-exclusions.json"), validateManualExclusions(exclusions));
        await saveReviewQueue(root, updated);
        result = { rejected: id, published: false };
      } else {
        const ids = (values.get("ids") ?? "").split(",").filter(Boolean);
        result = await publishReviewed(root, ids, AbortSignal.any([release.signal, AbortSignal.timeout(300000)]), {},
          { roleOverride: flags.has("override-role-exclusions") });
      }
    } finally {
      await release();
    }
  }
  else if (action === "tick" || action === "run-once") {
    result = await run(root, { tick: action === "tick", dryRun: flags.has("dry-run") });
    if (["failed", "blocked", "cancelled"].includes(result.status)) process.exitCode = 1;
  } else if (action === "request-run" || action === "retry-slot" || action === "retry-run") {
    if (!await isLoaded(label)) throw new RunError("service-not-loaded", "The installed LaunchAgent is not loaded.", { blocked: true });
    const requestLock = await acquireLock(root, "request-collection");
    let request, settings;
    try {
    const { runtime } = await loadConfiguration(root);
    settings = assertRuntimeMode(runtime);
    const state = await readJson(join(root, "state.json"));
    const control = await readJson(join(root, "control.json"));
    if (await readJson(join(root, "request.json"), null)) throw new RunError("request-pending", "A run request is already pending.");
    if (control.paused && !flags.has("controlled") && !flags.has("dry-run")) {
      throw new RunError("paused", "Use an explicit controlled run while collection is paused.", { blocked: true });
    }
    if (state.lastRun?.status === "running") {
      throw new RunError("locked", "A scheduled run is already active.", { blocked: true });
    }
    if (action === "retry-slot" || action === "retry-run") {
      const failed = state.lastRun;
      if (!failed || !["failed", "blocked"].includes(failed.status)
        || !/^[a-z0-9-]{8,90}$/.test(failed.id)
        || (action === "retry-slot" && (!/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(failed.id) || state.lastScheduledSlot !== failed.id))
        || await readJson(join(root, "pending.json"), null)) {
        throw new RunError("retry-not-available", "Only the last failed run without a pending publication can be explicitly retried; retry-slot requires its scheduled slot.");
      }
      let cursor = failed.queryCursor;
      if (!Number.isSafeInteger(cursor)) {
        const evidence = await readJson(join(root, "runs", failed.id, "evidence.json"), null);
        const first = evidence?.queries?.[0];
        cursor = first ? runtime.queries.findIndex((query) => query.term === first.term
          && (query.industry ?? null) === (first.industry ?? null)
          && (query.position ?? null) === (first.position ?? null)) : -1;
      }
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= runtime.queries.length) {
        throw new RunError("retry-query-unknown", "The failed slot's exact query rotation cannot be confirmed.");
      }
      request = { id: `retry-${new Date().toISOString().replace(/\D/g, "")}-${randomUUID().slice(0, 8)}`, dryRun: flags.has("dry-run"),
        retryOf: failed.id, queryCursor: cursor, requestedAt: new Date().toISOString() };
    } else {
      request = { id: `manual-${new Date().toISOString().replace(/\D/g, "")}-${randomUUID().slice(0, 8)}`,
        dryRun: flags.has("dry-run"), requestedAt: new Date().toISOString() };
    }
    request.controlled = flags.has("controlled");
    await atomicJson(join(root, "request.json"), request);
    } finally {
      await requestLock();
    }
    await command("/bin/launchctl", ["kickstart", `${serviceDomain()}/${label}`]);
    result = { requested: request.id, retryOf: request.retryOf ?? null, via: "installed-launchd", dryRun: request.dryRun,
      ...settings, controlled: request.controlled };
  } else {
    throw new RunError("usage", "Use install --mode collection-only|candidate-feed, preflight, request-run [--controlled], run-once, status, publish-captured --run-id, retry-candidate-publication, review-list, review-show --id, review-approve --file, review-reject --id --evidence-hash, publish-reviewed --ids, pause, resume, or uninstall.");
  }
  if (action !== "tick") console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const code = error instanceof RunError ? error.code : "internal-error";
  if (action !== "tick") console.error(JSON.stringify({ status: error.blocked ? "blocked" : "failed", code, message: error instanceof RunError ? error.message : "Scheduler command failed; inspect task configuration and local logs." }));
  if (action === "tick") await appendLog(root, { event: "tick-failed", code });
  process.exitCode = 1;
}
