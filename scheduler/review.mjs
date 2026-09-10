import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { isIsoDate, safeJobUrl, validateSnapshot } from "../docs/model.mjs";
import { atomicJson, readJson, RunError } from "./io.mjs";
import { loadManualExclusions, manualExcludedIds } from "./exclusions.mjs";

const recordKeys = ["id", "source", "title", "company", "location", "experienceText", "educationText", "salaryText", "url", "jd"];
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const idPattern = /^(?:boss-[A-Za-z0-9_~-]+|bytedance-\d+|liepin-\d+)$/;
const hashPattern = /^[a-f0-9]{64}$/;
const reasonsValid = (value) => Array.isArray(value) && value.every((reason) => typeof reason === "string" && /^[a-z0-9-]+$/.test(reason));

export const emptyReviewQueue = () => ({ version: 1, entries: [] });

export function reviewEvidence(record) {
  const evidence = Object.fromEntries(recordKeys.map((key) => [key,
    key === "source" ? record.source ?? "BOSS直聘" : record[key] ?? null]));
  const url = safeJobUrl(evidence.url, evidence.source);
  const expectedId = url && (evidence.source === "BOSS直聘" ? `boss-${new URL(url).pathname.match(/^\/job_detail\/(.+)\.html$/)?.[1]}`
    : evidence.source === "字节跳动招聘官网" ? `bytedance-${new URL(url).pathname.split("/")[3]}`
    : `liepin-${new URL(url).pathname.match(/^\/job\/(\d+)\.shtml$/)?.[1]}`);
  if (typeof evidence.id !== "string" || idPattern.exec(evidence.id)?.[0] !== evidence.id
    || !url || evidence.id !== expectedId || typeof evidence.jd !== "string"
    || evidence.jd.length < 80 || evidence.jd.length > 60000) {
    throw new RunError("invalid-review-evidence", "Only complete identified source records may enter the review queue.");
  }
  return evidence;
}

export function evidenceHash(evidence) {
  return createHash("sha256").update(JSON.stringify(recordKeys.map((key) => {
    const value = evidence[key];
    return typeof value === "string" ? value.normalize("NFKC").replace(/\r\n/g, "\n").trim() : value;
  }))).digest("hex");
}

export function validateReviewQueue(queue) {
  if (!exact(queue, ["version", "entries"]) || queue.version !== 1 || !Array.isArray(queue.entries)) {
    throw new RunError("invalid-review-queue", "The private review queue is invalid.", { blocked: true });
  }
  const ids = new Set();
  for (const entry of queue.entries) {
    if (!exact(entry, ["id", "firstSeen", "lastSeen", "runId", "evidenceHash", "evidence", "intent", "qualification", "status", "reviewedAt", "approval"])
      || ids.has(entry.id) || !isIsoDate(entry.firstSeen, false) || !isIsoDate(entry.lastSeen, false)
      || Date.parse(entry.firstSeen) > Date.parse(entry.lastSeen) || typeof entry.runId !== "string" || !/^[a-z0-9-]{8,90}$/.test(entry.runId)
      || !exact(entry.evidence, recordKeys) || entry.id !== entry.evidence.id
      || evidenceHash(reviewEvidence(entry.evidence)) !== entry.evidenceHash
      || !exact(entry.intent, ["decision", "family", "reasons"])
      || !["primary", "secondary", "outside", "unclear"].includes(entry.intent.decision)
      || (entry.intent.family !== null && typeof entry.intent.family !== "string") || !reasonsValid(entry.intent.reasons)
      || !exact(entry.qualification, ["status", "reasons"]) || !["pending", "not-met"].includes(entry.qualification.status)
      || !reasonsValid(entry.qualification.reasons) || !["pending", "approved", "rejected"].includes(entry.status)
      || (entry.reviewedAt !== null && !isIsoDate(entry.reviewedAt, false))) {
      throw new RunError("invalid-review-queue", "A private review entry is invalid.", { blocked: true });
    }
    if (entry.status === "approved") {
      if (!exact(entry.approval, ["evidenceHash", "approvedAt", "job"]) || entry.approval.evidenceHash !== entry.evidenceHash
        || !isIsoDate(entry.approval.approvedAt, false)) throw new RunError("invalid-review-approval", "Review approval is missing or stale.");
      validateApprovedJob(entry, entry.approval.job);
    } else if (entry.approval !== null) throw new RunError("invalid-review-approval", "Only explicitly approved records may carry publication data.");
    ids.add(entry.id);
  }
  return queue;
}

export async function loadReviewQueue(root) {
  const path = join(root, "review-queue.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new RunError("private-permissions", "Review queue requires owner-only permissions.");
  } catch (error) {
    if (error.code === "ENOENT") return emptyReviewQueue();
    throw error;
  }
  const queue = await readJson(path);
  return validateReviewQueue(queue);
}

export function updateReviewQueue(queue, records, assessments, runId, excludedIds = new Set()) {
  validateReviewQueue(queue);
  const entries = new Map(queue.entries.map((entry) => [entry.id, entry]));
  for (const record of records) {
    if (excludedIds.has(record.id)) continue;
    if (!isIsoDate(record.retrievedAt, false)) throw new RunError("invalid-review-evidence", "Observation time is required.");
    const assessment = assessments.find((item) => item.id === record.id);
    if (!assessment) throw new RunError("missing-review-assessment", "Every full JD requires separate intent and qualification assessment.");
    const evidence = reviewEvidence(record), hash = evidenceHash(evidence), old = entries.get(record.id);
    if (old && Date.parse(record.retrievedAt) < Date.parse(old.lastSeen)) continue;
    const unchanged = old?.evidenceHash === hash;
    const rejected = old?.status === "rejected";
    const preserveApproval = unchanged && old?.status === "approved" && assessment.qualification.status !== "not-met"
      && ["primary", "secondary"].includes(assessment.intent.decision);
    entries.set(record.id, {
      id: record.id, firstSeen: old?.firstSeen ?? record.retrievedAt, lastSeen: record.retrievedAt,
      runId, evidenceHash: hash, evidence: unchanged ? old.evidence : evidence,
      intent: assessment.intent, qualification: assessment.qualification,
      status: rejected ? "rejected" : preserveApproval ? "approved" : "pending",
      reviewedAt: rejected || preserveApproval ? old.reviewedAt : null,
      approval: preserveApproval ? old.approval : null,
    });
  }
  return validateReviewQueue({ version: 1, entries: [...entries.values()] });
}

export function reviewCounts(queue, excludedIds = new Set()) {
  const entries = validateReviewQueue(queue).entries.filter((entry) => !excludedIds.has(entry.id));
  return {
    total: entries.length,
    pending: entries.filter((entry) => entry.status === "pending" && entry.intent.decision !== "outside").length,
    primary: entries.filter((entry) => entry.status === "pending" && entry.intent.decision === "primary").length,
    secondary: entries.filter((entry) => entry.status === "pending" && entry.intent.decision === "secondary").length,
    unclear: entries.filter((entry) => entry.status === "pending" && entry.intent.decision === "unclear").length,
    outside: entries.filter((entry) => entry.intent.decision === "outside").length,
    approved: entries.filter((entry) => entry.status === "approved").length,
    rejected: entries.filter((entry) => entry.status === "rejected").length,
  };
}

export function listReviews(queue, { limit = 20, status = "pending", excludedIds = new Set() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !["pending", "approved", "rejected", "all"].includes(status)) {
    throw new RunError("invalid-review-selector", "Review listing requires a valid status and a limit between 1 and 50.");
  }
  const order = { primary: 0, secondary: 1, unclear: 2, outside: 3 };
  return validateReviewQueue(queue).entries.filter((entry) => !excludedIds.has(entry.id)
    && (status === "all" || entry.status === status) && (status !== "pending" || entry.intent.decision !== "outside"))
    .sort((a, b) => order[a.intent.decision] - order[b.intent.decision] || Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, limit).map((entry) => ({
      id: entry.id, title: entry.evidence.title, company: entry.evidence.company, url: entry.evidence.url,
      intent: entry.intent, qualification: entry.qualification, status: entry.status,
      firstSeen: entry.firstSeen, lastSeen: entry.lastSeen, evidenceHash: entry.evidenceHash,
    }));
}

export function showReview(queue, id) {
  const entry = validateReviewQueue(queue).entries.find((item) => item.id === id);
  if (!entry) throw new RunError("review-not-found", "The requested private review record does not exist.");
  return entry;
}

function validateApprovedJob(entry, job) {
  const snapshot = {
    version: 1, generatedAt: entry.lastSeen,
    run: { source: entry.evidence.source, scope: "人工复核", mode: "单次采集",
      cardsReviewed: 1, detailsRead: 1, selectedCount: 1, newCount: 1 },
    jobs: [job],
  };
  validateSnapshot(snapshot);
  for (const key of ["id", "source", "url", "title", "company", "location", "experienceText", "educationText"]) {
    if (job[key] !== entry.evidence[key]) throw new RunError("approval-identity-mismatch", "Approved public metadata must match the reviewed evidence.");
  }
  if (!job.jdRead || !job.isNew || job.firstSeen !== entry.firstSeen || Date.parse(job.lastSeen) > Date.parse(entry.lastSeen)
    || job.publishedAt !== null || (job.salaryText !== null && job.salaryText !== entry.evidence.salaryText)) {
    throw new RunError("approval-observation-mismatch", "Approved observations must match the current private evidence.");
  }
  if ([job.summary, job.requirements, job.matchReasons, job.concerns].some((items) =>
    items.some((text) => text.length > 300 || /[\p{Co}]|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|1[3-9]\d{9}/iu.test(text)
      || (text.length >= 50 && entry.evidence.jd.normalize("NFKC").includes(text.normalize("NFKC")))))) {
    throw new RunError("approval-not-sanitized", "Public summaries must be concise sanitized paraphrases, not raw source dumps or contact data.");
  }
  return job;
}

export function approveReviews(queue, payload, excludedIds = new Set(), now = new Date().toISOString()) {
  validateReviewQueue(queue);
  if (!exact(payload, ["version", "approvals"]) || payload.version !== 1
    || !Array.isArray(payload.approvals) || !payload.approvals.length || payload.approvals.length > 20) {
    throw new RunError("invalid-approval-file", "An explicit versioned human approval file is required.");
  }
  const approvals = new Map();
  for (const item of payload.approvals) {
    if (!exact(item, ["id", "evidenceHash", "job"]) || approvals.has(item.id) || !hashPattern.test(item.evidenceHash)) {
      throw new RunError("invalid-approval-file", "Each approval must include a unique ID, exact evidence hash and sanitized public job.");
    }
    const entry = showReview(queue, item.id);
    if (excludedIds.has(item.id) || entry.status === "rejected" || !["primary", "secondary"].includes(entry.intent.decision)
      || entry.qualification.status === "not-met") throw new RunError("approval-blocked", "Excluded, rejected or unresolved-direction records cannot be published.");
    if (entry.evidenceHash !== item.evidenceHash) throw new RunError("approval-stale", "The JD changed; read the current revision before approving.");
    if (item.job.lastSeen !== entry.lastSeen) throw new RunError("approval-observation-mismatch", "New approval must use the latest confirmed observation.");
    validateApprovedJob(entry, item.job);
    approvals.set(item.id, { evidenceHash: item.evidenceHash, approvedAt: now, job: item.job });
  }
  return validateReviewQueue({ version: 1, entries: queue.entries.map((entry) =>
    approvals.has(entry.id) ? { ...entry, status: "approved", reviewedAt: now, approval: approvals.get(entry.id) } : entry) });
}

export function rejectReview(queue, id, hash, now = new Date().toISOString()) {
  const entry = showReview(queue, id);
  if (entry.evidenceHash !== hash) throw new RunError("review-stale", "Review the current evidence revision before rejecting.");
  return validateReviewQueue({ version: 1, entries: queue.entries.map((item) => item.id === id
    ? { ...item, status: "rejected", reviewedAt: now, approval: null } : item) });
}

export function buildReviewedSnapshot(previous, queue, ids, ledger, excludedIds, now = new Date().toISOString()) {
  validateSnapshot(previous);
  if (!ids.length || new Set(ids).size !== ids.length || ids.length > 20) throw new RunError("invalid-reviewed-selection", "Explicit unique approved IDs are required.");
  excludedIds = new Set([...excludedIds, ...queue.entries.filter((entry) => entry.status === "rejected").map((entry) => entry.id)]);
  const existing = new Map(previous.jobs.map((job) => [job.id, job]));
  const added = ids.map((id) => {
    const entry = showReview(queue, id);
    if (excludedIds.has(id) || entry.status !== "approved" || entry.approval?.evidenceHash !== entry.evidenceHash
      || entry.qualification.status === "not-met" || !["primary", "secondary"].includes(entry.intent.decision)) {
      throw new RunError("manual-approval-required", "Publication requires current explicit human approval for every record.");
    }
    if (existing.has(id) && !previous.candidateStatesById?.[id]) throw new RunError("already-published", "This record is already selected; do not duplicate or silently rewrite it.");
    validateApprovedJob(entry, entry.approval.job);
    if (!ledger.detailIds.includes(id)) throw new RunError("review-evidence-missing", "Approved record has no full-JD evidence ledger entry.");
    const old = existing.get(id);
    return old ? { ...entry.approval.job, firstSeen: old.firstSeen, isNew: false,
      lastSeen: Date.parse(old.lastSeen) > Date.parse(entry.approval.job.lastSeen) ? old.lastSeen : entry.approval.job.lastSeen } : entry.approval.job;
  });
  const jobs = [...previous.jobs.filter((job) => !excludedIds.has(job.id)).map((job) =>
    added.find((item) => item.id === job.id) ?? { ...job, isNew: false }), ...added.filter((job) => !existing.has(job.id))];
  const retainedIds = new Set(jobs.map((job) => job.id));
  const methods = Object.fromEntries(jobs.map((job) => [job.id, previous.assessmentMethods?.[job.id] ?? "human-assisted"]));
  const admissionDates = Object.fromEntries(Object.entries(previous.firstPublishedAtById ?? {}).filter(([id]) => retainedIds.has(id)));
  for (const job of added) {
    methods[job.id] = "human-assisted";
    if (!existing.has(job.id)) admissionDates[job.id] = now;
  }
  return validateSnapshot({
    version: 1, generatedAt: now,
    run: { ...previous.run, mode: "人工扩展复核 · 累计快照", selectedCount: jobs.length,
      newCount: jobs.filter((job) => job.isNew).length, cardsReviewed: ledger.reviewedIds.length, detailsRead: ledger.detailIds.length },
    jobs, assessmentMethods: methods, firstPublishedAtById: admissionDates,
    ...(previous.candidateFeed ? {
      candidateFeed: { ...previous.candidateFeed, publicationKind: "manual-selection", runId: `review-${now.replace(/\D/g, "")}` },
      candidateStatesById: Object.fromEntries(Object.entries(previous.candidateStatesById).filter(([id]) => retainedIds.has(id) && !ids.includes(id))),
    } : {}),
    ...(previous.publication ? { publication: { ...previous.publication, publishedAt: now } } : {}),
  });
}

export async function reviewContext(root) {
  const queue = await loadReviewQueue(root);
  return { queue, excludedIds: new Set([...manualExcludedIds(await loadManualExclusions(root)),
    ...queue.entries.filter((entry) => entry.status === "rejected").map((entry) => entry.id)]) };
}

export const saveReviewQueue = (root, queue) => atomicJson(join(root, "review-queue.json"), validateReviewQueue(queue));
