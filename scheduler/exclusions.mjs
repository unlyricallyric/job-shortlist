import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isIsoDate, validateSnapshot } from "../docs/model.mjs";
import { readJson, RunError } from "./io.mjs";

const idPattern = /^(?:boss-[A-Za-z0-9_~-]+|bytedance-[0-9]+|liepin-[0-9]+)$/;

export function emptyManualExclusions() {
  return { version: 1, entries: [] };
}

export function validateManualExclusions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new RunError("invalid-manual-exclusions", "Private manual exclusions are invalid.", { blocked: true });
  }
  const ids = new Set();
  for (const entry of value.entries) {
    if (!entry || Object.keys(entry).length !== 3 || typeof entry.id !== "string"
      || idPattern.exec(entry.id)?.[0] !== entry.id || ids.has(entry.id)
      || !isIsoDate(entry.excludedAt, false) || entry.reasonCode !== "user-direction-rejection") {
      throw new RunError("invalid-manual-exclusions", "Private manual-exclusion entry is invalid.", { blocked: true });
    }
    ids.add(entry.id);
  }
  return value;
}

export async function loadManualExclusions(root) {
  const path = join(root, "manual-exclusions.json");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return emptyManualExclusions();
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw new RunError("private-permissions", "Manual exclusions require a private regular file.", { blocked: true });
  }
  return validateManualExclusions(await readJson(path));
}

export function manualExcludedIds(exclusions) {
  return new Set(validateManualExclusions(exclusions).entries.map((entry) => entry.id));
}

export function withdrawExcludedJobs(snapshot, exclusions, publishedAt) {
  validateSnapshot(snapshot);
  const ids = manualExcludedIds(exclusions);
  const jobs = snapshot.jobs.filter((job) => !ids.has(job.id));
  const result = {
    version: snapshot.version,
    generatedAt: snapshot.generatedAt,
    run: { ...snapshot.run, mode: "人工维护 · 已保存快照", selectedCount: jobs.length,
      newCount: jobs.filter((job) => job.isNew).length },
    jobs,
    ...(snapshot.assessmentMethods ? { assessmentMethods: Object.fromEntries(
      jobs.map((job) => [job.id, snapshot.assessmentMethods[job.id]]),
    ) } : {}),
    ...(snapshot.firstPublishedAtById ? { firstPublishedAtById: Object.fromEntries(
      Object.entries(snapshot.firstPublishedAtById).filter(([id]) => !ids.has(id)),
    ) } : {}),
    publication: { version: 1, type: "manual-maintenance", publishedAt, scheduler: "paused" },
  };
  return validateSnapshot(result);
}
