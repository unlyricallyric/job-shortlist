import { join } from "node:path";
import { homedir } from "node:os";
import { lstat } from "node:fs/promises";
import { RunError, readJson } from "./io.mjs";

export const defaultRoot = () => join(homedir(), "Library", "Application Support", "job-shortlist");
export const label = "com.job-shortlist.scheduler";
export const awakeLabel = "com.job-shortlist.keep-awake";
export const defaultQueries = [
  { term: "渠道市场", industry: "100021" }, { term: "市场活动", industry: "100021" },
  { term: "市场推广", industry: "100021" }, { term: "市场营销", industry: "100029" },
  { term: "伙伴赋能", industry: "100021" }, { term: "市场", industry: "100016" },
  { term: "生态合作", industry: "100029" }, { term: "渠道运营", industry: "100021" },
  { term: "市场经理", industry: "100023" },
  { term: "市场", industry: "100021", position: "140101" },
];
export const defaultLimits = Object.freeze({
  queriesPerRun: 3, cardsPerQuery: 15, maxCards: 45, maxDetails: 8, maxNewJobs: 3, timeoutMinutes: 30,
});

export async function loadConfiguration(root) {
  for (const name of ["runtime.json", "matching.json", "ledger.json"]) {
    const info = await lstat(join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) {
      throw new RunError("private-permissions", "Private scheduler files require owner-only permissions.", { blocked: true });
    }
  }
  const runtime = await readJson(join(root, "runtime.json"));
  if (runtime.version !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(runtime.repository)
    || runtime.branch !== "main" || !runtime.nodePath?.startsWith("/") || !runtime.gitPath?.startsWith("/")
    || !runtime.sshKeyPath?.startsWith(join(root, "keys") + "/")
    || !runtime.knownHostsPath?.startsWith(join(root, "keys") + "/")) {
    throw new RunError("invalid-config", "Scheduler runtime configuration is invalid.", { blocked: true });
  }
  const limits = runtime.limits;
  if (!limits || Object.keys(defaultLimits).some((key) => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaultLimits[key])) {
    throw new RunError("invalid-config", "Collection limits exceed the bounded defaults.", { blocked: true });
  }
  if (!Array.isArray(runtime.queries) || runtime.queries.length < 1 || runtime.queries.length > 24) {
    throw new RunError("invalid-config", "A bounded query rotation is required.", { blocked: true });
  }
  const { validateMatchingConfig } = await import("./screening.mjs");
  return { runtime, matching: validateMatchingConfig(await readJson(join(root, "matching.json"))) };
}

export function rotatingQueries(queries, cursor, count) {
  return Array.from({ length: Math.min(count, queries.length) }, (_, index) => queries[(cursor + index) % queries.length]);
}
