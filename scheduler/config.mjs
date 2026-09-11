import { join } from "node:path";
import { homedir } from "node:os";
import { lstat } from "node:fs/promises";
import { RunError, readJson } from "./io.mjs";
import { assertRuntimeMode, candidateMode, partnerQueries, validateIntentPolicy } from "./intent.mjs";
import { loadRoleContext } from "./role-exclusions.mjs";

export const defaultRoot = () => join(homedir(), "Library", "Application Support", "job-shortlist");
export const label = "com.job-shortlist.scheduler";
export const awakeLabel = "com.job-shortlist.keep-awake";
export const defaultQueries = partnerQueries;
export const defaultLimits = Object.freeze({
  queriesPerRun: 3, cardsPerQuery: 15, maxCards: 45, maxDetails: 8, maxNewJobs: 0, timeoutMinutes: 30,
});
export const candidateLimits = Object.freeze(Object.fromEntries(Object.entries(defaultLimits).filter(([key]) => key !== "maxNewJobs")));

export async function loadConfiguration(root) {
  for (const name of ["runtime.json", "matching.json", "ledger.json", "intent-policy.json"]) {
    const info = await lstat(join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) {
      throw new RunError("private-permissions", "Private scheduler files require owner-only permissions.", { blocked: true });
    }
  }
  const runtime = await readJson(join(root, "runtime.json"));
  assertRuntimeMode(runtime);
  if (runtime.version !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(runtime.repository)
    || runtime.branch !== "main" || !runtime.nodePath?.startsWith("/")) {
    throw new RunError("invalid-config", "Scheduler runtime configuration is invalid.", { blocked: true });
  }
  const limits = runtime.limits;
  const bounds = runtime.mode === candidateMode ? candidateLimits : defaultLimits;
  if (!limits || Object.keys(bounds).some((key) => !Number.isSafeInteger(limits[key])
    || limits[key] < (key === "maxNewJobs" ? 0 : 1) || limits[key] > bounds[key])
    || (runtime.mode === candidateMode && Object.hasOwn(limits, "maxNewJobs"))) {
    throw new RunError("invalid-config", "Collection limits exceed the bounded defaults.", { blocked: true });
  }
  const intent = validateIntentPolicy(await readJson(join(root, "intent-policy.json")));
  if (JSON.stringify(runtime.queries) !== JSON.stringify(intent.queries)) {
    throw new RunError("invalid-config", "Scheduled queries must match the explicit private career-intent policy.", { blocked: true });
  }
  const { validateMatchingConfig } = await import("./screening.mjs");
  return { runtime, matching: validateMatchingConfig(await readJson(join(root, "matching.json"))), intent,
    roleContext: await loadRoleContext(root, runtime) };
}

export function rotatingQueries(queries, cursor, count) {
  return Array.from({ length: Math.min(count, queries.length) }, (_, index) => queries[(cursor + index) % queries.length]);
}
