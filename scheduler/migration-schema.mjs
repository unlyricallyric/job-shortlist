import { createHash } from "node:crypto";
import { isIsoDate, safeJobUrl, validateSnapshot } from "../docs/model.mjs";
import { validateMatchingConfig } from "./screening.mjs";
import { validateIntentPolicy, assertRuntimeMode } from "./intent.mjs";
import { validateManualExclusions } from "./exclusions.mjs";
import { validateRolePolicy, validateRoleHistory } from "./role-exclusions.mjs";
import { validateReviewQueue } from "./review.mjs";
import { validateLedger } from "./snapshot.mjs";
import { validateReadHistory } from "./coverage.mjs";
import { defaultLimits, candidateLimits } from "./config.mjs";
import { schedule } from "./clock.mjs";
import { RunError } from "./io.mjs";

export const migrationFormat = "job-shortlist-migration";
export const migrationVersion = 1;
export const maxMigrationBytes = 32 * 1024 * 1024;
export const migrationHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const migrationJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const stateFiles = [
  "matching.json", "intent-policy.json", "manual-exclusions.json", "role-exclusions.json",
  "role-exclusions-history.json", "review-queue.json", "ledger.json", "read-history.json",
];
const baseFiles = [...stateFiles, "state.json", "migration-settings.json", "saved-snapshot.json", "private-context.json"];
export const allowedMigrationPath = (path) => typeof path === "string"
  && (baseFiles.includes(path) || /^runs\/[a-z0-9-]{8,90}\/(?:evidence|result)\.json$/.test(path));
const id = (value) => typeof value === "string" && /^[a-z0-9-]{8,90}$/.test(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const subset = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
const timestamp = (value) => isIsoDate(value, false);
const requireValue = (condition, code = "invalid-migration-state") => {
  if (!condition) throw new RunError(code, "Migration data is invalid or incompatible; no state was restored.", { blocked: true });
};

export function migrationSettings(runtime) {
  const settings = pick(runtime, [
    "version", "repository", "branch", "mode", "autoPublish", "reviewRequired", "manualApprovalRequiredForVisibility",
    "queries", "limits", "roleExclusionsVersion",
  ]);
  return validateMigrationSettings({ ...settings, schedule });
}

export function validateMigrationSettings(value) {
  requireValue(exact(value, ["version", "repository", "branch", "mode", "autoPublish", "reviewRequired",
    "manualApprovalRequiredForVisibility", "queries", "limits", "roleExclusionsVersion", "schedule"]));
  requireValue(value.version === 1 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
    && value.branch === "main" && [1, 2].includes(value.roleExclusionsVersion));
  assertRuntimeMode(value);
  requireValue(JSON.stringify(value.schedule) === JSON.stringify(schedule));
  const bounds = value.mode === "candidate-feed" ? candidateLimits : defaultLimits;
  requireValue(exact(value.limits, Object.keys(bounds)) && Object.entries(bounds).every(([key, bound]) =>
    nonnegative(value.limits[key]) && value.limits[key] <= bound && (key === "maxNewJobs" || value.limits[key] > 0)));
  requireValue(Array.isArray(value.queries) && value.queries.length > 0);
  return value;
}

const publicationKeys = ["type", "at", "sha", "url", "runId", "sampleRunId", "generatedAt", "publicationKind",
  "status", "digest", "attempts", "total", "newCount", "candidates", "selected", "cardOnly", "newCandidates", "ids", "publishedAt"];
const countKeys = ["reviewed", "details", "publicAdmissions", "intentPrimary", "intentSecondary", "intentOutside",
  "intentUnclear", "qualificationPending", "detailConflicts", "incompleteDetails", "visibleCandidates", "manuallySelected"];
const queueCountKeys = ["total", "pending", "primary", "secondary", "unclear", "outside", "approved", "rejected"];
const runKeys = ["id", "trigger", "startedAt", "finishedAt", "status", "dryRun", "mode", "autoPublish", "controlled",
  "reviewRequired", "manualApprovalRequiredForVisibility", "queryCursor", "retryOf", "sampledAt", "code", "summary", "publication"];
const stateKeys = ["version", "activatedAt", "collectionActivatedAt", "lastScheduledSlot", "queryCursor",
  "lastRun", "lastCollection", "lastPublished", "lastRecovery"];
const triggers = ["scheduled", "manual", "launchd-manual", "launchd-controlled", "launchd-retry"];
const runStatuses = ["succeeded", "collected", "dry-run", "failed", "blocked", "cancelled"];

function portablePublication(value) {
  return value === null || value === undefined ? null : pick(value, publicationKeys);
}

function portableSummary(value) {
  if (value === null || value === undefined) return null;
  return { ...pick(value, countKeys),
    ...(value.queue ? { queue: pick(value.queue, queueCountKeys) } : {}),
    ...(value.coverage ? { coverage: value.coverage.map((item) => pick(item, ["term", "industry", "position", "cards", "details", "unread", "rechecked"])) } : {}),
  };
}

export function portableRun(value) {
  if (value === null || value === undefined) return null;
  const result = pick(value, runKeys);
  if (Object.hasOwn(value, "summary")) result.summary = portableSummary(value.summary);
  if (Object.hasOwn(value, "publication")) result.publication = portablePublication(value.publication);
  return result;
}

export function portableState(value) {
  requireValue(subset(value, stateKeys), "unsupported-migration-state");
  return { ...pick(value, stateKeys), lastRun: portableRun(value.lastRun), lastCollection: portableRun(value.lastCollection),
    lastPublished: portablePublication(value.lastPublished),
    ...(value.lastRecovery ? { lastRecovery: portablePublication(value.lastRecovery) } : {}) };
}

function validatePublication(value, repository) {
  if (value === null) return;
  const [owner, repo] = repository.split("/");
  requireValue(subset(value, publicationKeys) && /^[a-f0-9]{40}$/.test(value.sha)
    && (value.url === undefined || value.url === `https://${owner.toLowerCase()}.github.io/${repo}/`));
  for (const key of ["at", "generatedAt", "publishedAt"]) if (value[key] !== undefined) requireValue(timestamp(value[key]));
  for (const key of ["runId", "sampleRunId"]) if (value[key] !== undefined) requireValue(id(value[key]));
  if (value.type !== undefined) requireValue(["candidate-feed", "explicit-human-review"].includes(value.type));
  if (value.status !== undefined) requireValue(value.status === "published");
  if (value.publicationKind !== undefined) requireValue(["scheduled", "controlled", "manual-backfill", "manual-selection", "feedback-filter", "full-review"].includes(value.publicationKind));
  if (value.digest !== undefined) requireValue(/^[a-f0-9]{64}$/.test(value.digest));
  for (const key of ["attempts", "total", "newCount", "candidates", "selected", "cardOnly", "newCandidates"]) {
    if (value[key] !== undefined) requireValue(nonnegative(value[key]));
  }
  if (value.ids !== undefined) requireValue(Array.isArray(value.ids) && value.ids.every((jobId) => /^(?:boss-[A-Za-z0-9_~-]+|bytedance-\d+|liepin-\d+)$/.test(jobId)));
}

function validateSummary(value, queries) {
  if (value === null) return;
  requireValue(subset(value, [...countKeys, "queue", "coverage"]));
  for (const key of countKeys) if (value[key] !== undefined) requireValue(nonnegative(value[key]));
  if (value.queue) requireValue(subset(value.queue, queueCountKeys) && Object.values(value.queue).every(nonnegative));
  if (value.coverage) {
    requireValue(Array.isArray(value.coverage) && value.coverage.length <= 3);
    for (const item of value.coverage) {
      requireValue(subset(item, ["term", "industry", "position", "cards", "details", "unread", "rechecked"])
        && queries.some((query) => query.term === item.term && (query.industry ?? null) === (item.industry ?? null))
        && (item.position === undefined || item.position === null));
      for (const key of ["cards", "details", "unread", "rechecked"]) if (item[key] !== undefined) requireValue(nonnegative(item[key]));
    }
  }
}

export function validatePortableRun(value, settings) {
  if (value === null) return;
  requireValue(subset(value, runKeys) && id(value.id) && triggers.includes(value.trigger)
    && runStatuses.includes(value.status) && timestamp(value.startedAt) && timestamp(value.finishedAt)
    && Date.parse(value.finishedAt) >= Date.parse(value.startedAt));
  if (value.queryCursor !== undefined) requireValue(nonnegative(value.queryCursor) && value.queryCursor < settings.queries.length);
  if (value.retryOf !== undefined) requireValue(id(value.retryOf));
  if (value.sampledAt !== null && value.sampledAt !== undefined) requireValue(timestamp(value.sampledAt));
  if (value.code !== undefined && value.code !== null) requireValue(/^[a-z0-9-]{1,60}$/.test(value.code));
  for (const key of ["dryRun", "autoPublish", "controlled", "reviewRequired", "manualApprovalRequiredForVisibility"]) {
    if (value[key] !== undefined) requireValue(typeof value[key] === "boolean");
  }
  if (value.mode !== undefined) requireValue(["collection-only", "candidate-feed"].includes(value.mode));
  if (value.summary !== undefined) validateSummary(value.summary, settings.queries);
  if (value.publication !== undefined) validatePublication(value.publication, settings.repository);
}

export function validatePortableState(value, settings) {
  requireValue(subset(value, stateKeys) && value.version === 1 && timestamp(value.activatedAt)
    && (value.collectionActivatedAt === undefined || timestamp(value.collectionActivatedAt))
    && (value.lastScheduledSlot === null || /^\d{4}-\d{2}-\d{2}-(?:0930|1230)$/.test(value.lastScheduledSlot))
    && nonnegative(value.queryCursor) && value.queryCursor < settings.queries.length);
  validatePortableRun(value.lastRun, settings);
  validatePortableRun(value.lastCollection, settings);
  validatePublication(value.lastPublished, settings.repository);
  if (value.lastRecovery !== undefined) validatePublication(value.lastRecovery, settings.repository);
  return value;
}

const cardKeys = ["id", "source", "title", "company", "location", "experienceText", "educationText", "url", "salaryText", "retrievedAt"];
const queryKeys = ["term", "industry", "position", "count", "empty", "allocated", "detailsRead", "unreadDetails",
  "recheckedDetails", "detailConflicts", "incompleteDetails", "visits"];

export function portableEvidence(value) {
  requireValue(object(value) && Array.isArray(value.cards) && Array.isArray(value.details) && Array.isArray(value.queries));
  return {
    cards: value.cards.map((card) => pick(card, cardKeys)), details: value.details.map((card) => pick(card, [...cardKeys, "jd"])),
    detailConflicts: (value.detailConflicts ?? []).map((entry) => pick(entry, ["id", "code"])),
    incompleteDetails: (value.incompleteDetails ?? []).map((entry) => pick(entry, ["id", "code"])),
    queries: value.queries.map((query) => pick(query, queryKeys)), complete: value.complete,
  };
}

function validateEvidence(value, settings, result, ledger) {
  requireValue(exact(value, ["cards", "details", "detailConflicts", "incompleteDetails", "queries", "complete"])
    && value.complete === true && Array.isArray(value.cards) && value.cards.length <= settings.limits.maxCards
    && Array.isArray(value.details) && value.details.length <= settings.limits.maxDetails
    && Array.isArray(value.queries) && value.queries.length <= settings.limits.queriesPerRun);
  const seen = new Set();
  for (const [records, full] of [[value.cards, false], [value.details, true]]) {
    const unique = new Set();
    for (const card of records) {
      requireValue(subset(card, full ? [...cardKeys, "jd"] : cardKeys) && typeof card.id === "string"
        && /^boss-[A-Za-z0-9_~-]+$/.test(card.id)
        && safeJobUrl(card.url, card.source ?? "BOSS直聘") !== null
        && card.url === `https://www.zhipin.com/job_detail/${card.id.slice(5)}.html`
        && timestamp(card.retrievedAt) && Date.parse(card.retrievedAt) <= Date.parse(result.finishedAt)
        && ledger.reviewedIds.includes(card.id) && !unique.has(card.id));
      for (const key of ["title", "company", "location", "experienceText", "educationText", "salaryText"]) {
        requireValue(card[key] === null || (typeof card[key] === "string" && card[key].length <= 1000));
      }
      if (full) requireValue(seen.has(card.id) && ledger.detailIds.includes(card.id)
        && typeof card.jd === "string" && card.jd.length >= 80 && card.jd.length <= 60000);
      else seen.add(card.id);
      unique.add(card.id);
    }
  }
  for (const field of ["detailConflicts", "incompleteDetails"]) {
    requireValue(Array.isArray(value[field]) && value[field].every((entry) => exact(entry, ["id", "code"])
      && seen.has(entry.id) && /^[a-z0-9-]{1,60}$/.test(entry.code)));
  }
  for (const query of value.queries) {
    requireValue(subset(query, queryKeys) && settings.queries.some((item) => item.term === query.term
      && (item.industry ?? null) === (query.industry ?? null)) && query.position === null && typeof query.empty === "boolean");
    for (const key of queryKeys.filter((key) => !["term", "industry", "position", "empty"].includes(key))) {
      if (query[key] !== undefined) requireValue(nonnegative(query[key]));
    }
  }
}

export function validatePrivateContext(value) {
  requireValue(object(value) && value.schemaVersion === 1, "invalid-private-context");
  const text = JSON.stringify(value);
  requireValue(Buffer.byteLength(text) <= 65536
    && !/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:\/Users\/|\/home\/|[A-Z]:\\\\Users\\\\)/u.test(text), "nonportable-private-context");
  const check = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      requireValue(!/^(?:password|passwd|token|apiKey|privateKey|cookie|cookies|sessionHandle|browserProfile)$/iu.test(key), "credential-in-private-context");
      check(child);
    }
  };
  check(value);
  return value;
}

export function migrationRunIds(state, snapshot) {
  return [...new Set([state.lastCollection?.id, snapshot.candidateFeed?.sampleRunId ?? snapshot.automation?.runId].filter(Boolean))].sort();
}

function safeTree(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    requireValue(!["__proto__", "constructor", "prototype"].includes(key), "unsafe-migration-key");
    safeTree(child);
  }
}

export function validateMigrationFiles(files) {
  requireValue(object(files), "invalid-migration-files");
  const parsed = Object.fromEntries(Object.entries(files).map(([name, content]) => {
    requireValue(typeof content === "string" && Buffer.byteLength(content) <= maxMigrationBytes, "invalid-migration-file");
    let value;
    try { value = JSON.parse(content); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new RunError("invalid-migration-json", "A migration state file is not valid JSON.");
    }
    safeTree(value);
    return [name, value];
  }));
  const settings = validateMigrationSettings(parsed["migration-settings.json"]);
  const state = validatePortableState(parsed["state.json"], settings);
  const snapshot = validateSnapshot(parsed["saved-snapshot.json"]);
  const runIds = migrationRunIds(state, snapshot);
  const allowed = [...baseFiles, ...runIds.flatMap((runId) => [`runs/${runId}/evidence.json`, `runs/${runId}/result.json`])];
  requireValue(runIds.length <= 2 && runIds.every(id) && exact(parsed, allowed), "migration-file-not-allowed");
  validateMatchingConfig(parsed["matching.json"]);
  const intent = validateIntentPolicy(parsed["intent-policy.json"]);
  requireValue(JSON.stringify(intent.queries) === JSON.stringify(settings.queries));
  const exclusions = validateManualExclusions(parsed["manual-exclusions.json"]);
  const policy = validateRolePolicy(parsed["role-exclusions.json"]), history = validateRoleHistory(parsed["role-exclusions-history.json"]);
  requireValue(policy.version === settings.roleExclusionsVersion && history.entries.every((entry) => entry.policyVersion <= policy.version));
  const queue = validateReviewQueue(parsed["review-queue.json"]);
  const ledger = validateLedger(parsed["ledger.json"]);
  requireValue(exact(ledger, ["version", "reviewedIds", "detailIds"]));
  const reads = validateReadHistory(parsed["read-history.json"]);
  validatePrivateContext(parsed["private-context.json"]);
  requireValue(snapshot.jobs.every((job) => ledger.reviewedIds.includes(job.id) && (!job.jdRead || ledger.detailIds.includes(job.id))));
  requireValue(queue.entries.every((entry) => ledger.detailIds.includes(entry.id)));
  requireValue(Object.keys(reads.entries).every((jobId) => ledger.detailIds.includes(jobId)));
  for (const runId of runIds) {
    const result = parsed[`runs/${runId}/result.json`];
    validatePortableRun(result, settings);
    requireValue(result.id === runId && ["collected", "succeeded"].includes(result.status));
    validateEvidence(parsed[`runs/${runId}/evidence.json`], settings, result, ledger);
  }
  const rejected = new Set(exclusions.entries.map((entry) => entry.id));
  const roleRejected = new Set(history.entries.map((entry) => entry.id));
  requireValue(snapshot.jobs.every((job) => !rejected.has(job.id) && (!roleRejected.has(job.id) || !snapshot.candidateStatesById?.[job.id])));
  if (snapshot.candidateFeed) requireValue(snapshot.candidateFeed.runId === state.lastPublished?.runId
    && snapshot.generatedAt === state.lastPublished?.generatedAt);
  return { settings, state, snapshot, runIds, counts: {
    publicJobs: snapshot.jobs.length, firstDisplayDates: Object.keys(snapshot.firstPublishedAtById ?? {}).length,
    manualExclusions: exclusions.entries.length, roleHistory: history.entries.length, reviewQueue: queue.entries.length,
    reviewedIds: ledger.reviewedIds.length, detailIds: ledger.detailIds.length, readHistory: Object.keys(reads.entries).length,
    sourceSamples: runIds.length,
  } };
}

export function buildMigrationPayload(files, { exportedAt = new Date().toISOString(), sourceCommit } = {}) {
  const checked = validateMigrationFiles(files);
  const manifest = {
    format: migrationFormat, version: migrationVersion, exportedAt, sourceCommit, repository: checked.settings.repository,
    snapshotGeneratedAt: checked.snapshot.generatedAt, sourceSampledAt: checked.snapshot.candidateFeed?.sampledAt ?? null,
    counts: checked.counts,
    files: Object.keys(files).sort().map((path) => ({ path, bytes: Buffer.byteLength(files[path]), sha256: migrationHash(files[path]) })),
  };
  return validateMigrationPayload({ manifest, files });
}

export function validateMigrationPayload(payload) {
  requireValue(exact(payload, ["manifest", "files"]), "invalid-migration-payload");
  safeTree(payload);
  const { manifest, files } = payload;
  requireValue(exact(manifest, ["format", "version", "exportedAt", "sourceCommit", "repository",
    "snapshotGeneratedAt", "sourceSampledAt", "counts", "files"])
    && manifest.format === migrationFormat && manifest.version === migrationVersion && timestamp(manifest.exportedAt)
    && /^[a-f0-9]{40}$/.test(manifest.sourceCommit) && Array.isArray(manifest.files), "unsupported-migration-version");
  requireValue(object(files) && manifest.files.length <= 16 && manifest.files.length === Object.keys(files).length);
  const names = new Set();
  for (const entry of manifest.files) {
    requireValue(exact(entry, ["path", "bytes", "sha256"]) && typeof entry.path === "string"
      && allowedMigrationPath(entry.path)
      && !names.has(entry.path) && Object.hasOwn(files, entry.path) && typeof files[entry.path] === "string"
      && entry.bytes === Buffer.byteLength(files[entry.path]) && entry.sha256 === migrationHash(files[entry.path]), "migration-integrity");
    names.add(entry.path);
  }
  requireValue(manifest.files.reduce((sum, entry) => sum + entry.bytes, 0) <= maxMigrationBytes, "migration-too-large");
  const checked = validateMigrationFiles(files);
  requireValue(manifest.repository === checked.settings.repository
    && manifest.snapshotGeneratedAt === checked.snapshot.generatedAt
    && manifest.sourceSampledAt === (checked.snapshot.candidateFeed?.sampledAt ?? null)
    && JSON.stringify(manifest.counts) === JSON.stringify(checked.counts)
    && Date.parse(manifest.exportedAt) >= Date.parse(checked.snapshot.generatedAt), "migration-manifest-mismatch");
  return payload;
}
