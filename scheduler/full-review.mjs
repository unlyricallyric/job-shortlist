import { createHash } from "node:crypto";
import { validateSnapshot, isIsoDate } from "../docs/model.mjs";
import { withoutSnapshotJobs } from "./candidates.mjs";
import { validateRolePolicy, feedbackRolePolicy } from "./role-exclusions.mjs";
import { RunError } from "./io.mjs";

const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function validateFullReview(payload, snapshotText, policy) {
  validateRolePolicy(policy);
  if (!exact(payload, ["version", "publicSha256", "decisions"]) || payload.version !== 1
    || typeof payload.publicSha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.publicSha256)
    || !Array.isArray(payload.decisions)) {
    throw new RunError("invalid-full-review", "Full review requires an exact snapshot digest and one decision per current public ID.");
  }
  if (createHash("sha256").update(snapshotText).digest("hex") !== payload.publicSha256) {
    throw new RunError("full-review-stale", "The public snapshot changed since this review; no exclusions were applied.", { blocked: true });
  }
  const snapshot = validateSnapshot(JSON.parse(snapshotText));
  if (!snapshot.candidateFeed || payload.decisions.length !== snapshot.jobs.length) {
    throw new RunError("full-review-incomplete", "Full review must cover every current selected and candidate record.", { blocked: true });
  }
  const ids = new Set(snapshot.jobs.map((job) => job.id));
  for (const item of payload.decisions) {
    if (!exact(item, ["id", "decision", "category"]) || !ids.delete(item.id)
      || !["remove", "retain", "uncertain"].includes(item.decision)
      || (item.decision === "remove" ? !policy.categories.includes(item.category) : item.category !== null)) {
      throw new RunError("invalid-full-review-decision", "Each current ID needs a unique typed decision; removals require a supported category.");
    }
  }
  if (ids.size) throw new RunError("full-review-incomplete", "Some current records were not reviewed.");
  return snapshot;
}

export function buildFullReviewSnapshot(snapshotText, payload, policy, now = new Date().toISOString()) {
  const previous = validateFullReview(payload, snapshotText, policy);
  const removals = payload.decisions.filter((item) => item.decision === "remove");
  const removedIds = new Set(removals.map((item) => item.id));
  const filtered = withoutSnapshotJobs(previous, removedIds);
  const snapshot = validateSnapshot({
    ...filtered, generatedAt: now,
    candidateFeed: { ...filtered.candidateFeed, publicationKind: "full-review", runId: `fullreview-${now.replace(/\D/g, "")}` },
  });
  return { snapshot, removedIds, counts: {
    removed: removals.length,
    removedSelected: removals.filter((item) => !Object.hasOwn(previous.candidateStatesById, item.id)).length,
    removedCandidates: removals.filter((item) => Object.hasOwn(previous.candidateStatesById, item.id)).length,
    retained: payload.decisions.filter((item) => item.decision === "retain").length,
    uncertain: payload.decisions.filter((item) => item.decision === "uncertain").length,
    removedByCategory: Object.fromEntries(policy.categories.map((category) =>
      [category, removals.filter((item) => item.category === category).length])),
  } };
}

export function validateFullReviewReceipt(value, snapshot) {
  const policy = feedbackRolePolicy(2);
  if (!exact(value, ["version", "status", "publicSha256", "decisions", "policyId", "reviewedAt", "counts"])
    || value.version !== 1 || value.status !== "pending" || value.policyId !== policy.id
    || typeof value.publicSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.publicSha256)
    || !isIsoDate(value.reviewedAt, false) || snapshot.candidateFeed?.publicationKind !== "full-review"
    || value.reviewedAt !== snapshot.generatedAt || !Array.isArray(value.decisions)) {
    throw new RunError("full-review-receipt-invalid", "The pending full-review audit is invalid.", { blocked: true });
  }
  const ids = new Set(), retained = new Set(snapshot.jobs.map((job) => job.id));
  for (const item of value.decisions) {
    if (!exact(item, ["id", "decision", "category"]) || typeof item.id !== "string"
      || !/^(?:boss-[A-Za-z0-9_~-]+|bytedance-\d+|liepin-\d+)$/.test(item.id) || ids.has(item.id)
      || !["remove", "retain", "uncertain"].includes(item.decision)
      || (item.decision === "remove" ? !policy.categories.includes(item.category) || retained.has(item.id)
        : item.category !== null || !retained.delete(item.id))) {
      throw new RunError("full-review-receipt-invalid", "Pending full-review decisions do not match the withdrawal snapshot.", { blocked: true });
    }
    ids.add(item.id);
  }
  if (retained.size) throw new RunError("full-review-receipt-invalid", "Some retained jobs are absent from the full-review receipt.");
  return value;
}
