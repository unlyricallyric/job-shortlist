#!/usr/bin/env node
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultRoot, label, awakeLabel } from "./config.mjs";
import { RunError, atomicJson, readJson, appendLog, acquireLock } from "./io.mjs";
import { loadConfiguration } from "./config.mjs";
import { retryPending } from "./publish.mjs";
import { unlink } from "node:fs/promises";
import { run, status, preflight } from "./runner.mjs";
import { install, pause, resume, uninstall, isLoaded, serviceDomain } from "./install.mjs";
import { command } from "./process.mjs";

process.umask(0o077);
const [action, ...args] = process.argv.slice(2);
const values = new Map();
const flags = new Set();
const known = new Set(["root", "matching", "ledger", "ssh-key", "known-hosts", "repository", "node", "git", "adopt-window", "adopt-tab"]);
for (let index = 0; index < args.length; index++) {
  const name = args[index].replace(/^--/, "");
  if (!args[index].startsWith("--")) throw new Error("Expected a named command option.");
  if (name === "dry-run" || name === "no-browser") flags.add(name);
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
    const release = await acquireLock(root, "retry-publication");
    try {
      const control = await readJson(join(root, "control.json"));
      if (control.paused) throw new RunError("paused", "Resume before explicitly retrying a publication.", { blocked: true });
      const { runtime } = await loadConfiguration(root);
      const recovered = await retryPending(root, runtime, AbortSignal.timeout(300000));
      const state = await readJson(join(root, "state.json"));
      state.lastPublished = recovered;
      // Preserve the old run's failed/cancelled state; recovery is a separate explicit action.
      state.lastRecovery = { status: "verified", ...recovered };
      await atomicJson(join(root, "state.json"), state);
      await unlink(join(root, "pending.json"));
      result = state.lastRecovery;
    } finally {
      await release();
    }
  }
  else if (action === "tick" || action === "run-once") {
    result = await run(root, { tick: action === "tick", dryRun: flags.has("dry-run") });
    if (["failed", "blocked", "cancelled"].includes(result.status)) process.exitCode = 1;
  } else if (action === "request-run" || action === "retry-slot") {
    if (!await isLoaded(label)) throw new RunError("service-not-loaded", "The installed LaunchAgent is not loaded.", { blocked: true });
    const state = await readJson(join(root, "state.json"));
    if (state.lastRun?.status === "running") {
      throw new RunError("locked", "A scheduled run is already active.", { blocked: true });
    }
    let request;
    if (action === "retry-slot") {
      const failed = state.lastRun;
      if (!failed || !["failed", "blocked"].includes(failed.status)
        || !/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(failed.id)
        || state.lastScheduledSlot !== failed.id || await readJson(join(root, "pending.json"), null)) {
        throw new RunError("retry-not-available", "Only the last failed scheduled slot without a pending publication can be explicitly retried.");
      }
      const { runtime } = await loadConfiguration(root);
      let cursor = failed.queryCursor;
      if (!Number.isSafeInteger(cursor)) {
        const evidence = await readJson(join(root, "runs", failed.id, "evidence.json"), null);
        const first = evidence?.queries?.[0];
        cursor = first ? runtime.queries.findIndex((query) => query.term === first.term
          && (query.industry ?? null) === (first.industry ?? null)) : -1;
      }
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= runtime.queries.length) {
        throw new RunError("retry-query-unknown", "The failed slot's exact query rotation cannot be confirmed.");
      }
      request = { id: `retry-${failed.id}-${randomUUID().slice(0, 8)}`, dryRun: false,
        retryOf: failed.id, queryCursor: cursor, requestedAt: new Date().toISOString() };
    } else {
      request = { id: `manual-${new Date().toISOString().replace(/\D/g, "")}-${randomUUID().slice(0, 8)}`,
        dryRun: flags.has("dry-run"), requestedAt: new Date().toISOString() };
    }
    await atomicJson(join(root, "request.json"), request);
    await command("/bin/launchctl", ["kickstart", `${serviceDomain()}/${label}`]);
    result = { requested: request.id, retryOf: request.retryOf ?? null, via: "installed-launchd", dryRun: request.dryRun };
  } else {
    throw new RunError("usage", "Use install, preflight, run-once [--dry-run], request-run [--dry-run], retry-slot, retry-publication, status, pause, resume, or uninstall.");
  }
  if (action !== "tick" || !["idle", "paused"].includes(result.status)) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const code = error instanceof RunError ? error.code : "internal-error";
  console.error(JSON.stringify({ status: error.blocked ? "blocked" : "failed", code, message: error instanceof RunError ? error.message : "Scheduler command failed; inspect task configuration and local logs." }));
  if (action === "tick") await appendLog(root, { event: "tick-failed", code });
  process.exitCode = 1;
}
