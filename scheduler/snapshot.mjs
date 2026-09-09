import { validateSnapshot } from "../docs/model.mjs";
import { schedule } from "./clock.mjs";
import { RunError } from "./io.mjs";

const idPattern = /^(?:boss-[A-Za-z0-9_~-]+|bytedance-[0-9]+|liepin-[0-9]+)$/;
const parsingReasons = new Set([
  "requirements-unseparated", "sections-invalid", "sections-too-complex", "requirements-unreadable", "full-jd-missing-or-invalid",
]);

export function pendingReviewCounts(decisions, detailConflicts = []) {
  const pending = new Set(detailConflicts.map((item) => item.id));
  const parsing = new Set();
  for (const item of decisions) {
    if (item.decision !== "review") continue;
    pending.add(item.id);
    if (item.reasons.some((reason) => parsingReasons.has(reason))) parsing.add(item.id);
  }
  return { reviewPendingThisRun: pending.size, parsePendingThisRun: parsing.size };
}

export function validateLedger(ledger) {
  if (!ledger || ledger.version !== 1 || !Array.isArray(ledger.reviewedIds) || !Array.isArray(ledger.detailIds)) {
    throw new RunError("invalid-ledger", "A private unique-ID evidence ledger is required.");
  }
  for (const key of ["reviewedIds", "detailIds"]) {
    if (new Set(ledger[key]).size !== ledger[key].length || ledger[key].some((id) =>
      typeof id !== "string" || !idPattern.test(id) || idPattern.exec(id)[0] !== id)) {
      throw new RunError("invalid-ledger", "The evidence ledger contains invalid or duplicate IDs.");
    }
  }
  const reviewed = new Set(ledger.reviewedIds);
  if (ledger.detailIds.some((id) => !reviewed.has(id))) throw new RunError("invalid-ledger", "Detail IDs must be included among reviewed IDs.");
  return ledger;
}

export function updateLedger(ledger, evidence) {
  validateLedger(ledger);
  const reviewed = new Set(ledger.reviewedIds), details = new Set(ledger.detailIds);
  for (const card of evidence.cards) reviewed.add(card.id);
  for (const detail of evidence.details) {
    reviewed.add(detail.id);
    details.add(detail.id);
  }
  return validateLedger({ version: 1, reviewedIds: [...reviewed].sort(), detailIds: [...details].sort() });
}

export function buildSnapshot(previous, evidence, decisions, ledger, {
  runId, startedAt, generatedAt, maxNewJobs = 3, enabled = true, excludedIds = new Set(),
}) {
  validateSnapshot(previous);
  validateLedger(ledger);
  if (!(excludedIds instanceof Set)) throw new RunError("invalid-manual-exclusions", "Manual exclusions must be validated before merging.");
  const seen = new Map(evidence.cards.map((card) => [card.id, card.retrievedAt]));
  for (const detail of evidence.details) seen.set(detail.id, detail.retrievedAt);
  const retained = previous.jobs.filter((job) => !excludedIds.has(job.id));
  const ids = new Set(retained.map((job) => job.id));
  const methods = Object.fromEntries(retained.map((job) => [job.id, previous.assessmentMethods?.[job.id] ?? "human-assisted"]));
  const jobs = retained.map((job) => ({
    ...job, isNew: false, lastSeen: seen.has(job.id) && Date.parse(seen.get(job.id)) > Date.parse(job.lastSeen)
      ? seen.get(job.id) : job.lastSeen,
  }));
  for (const decision of decisions) {
    if (jobs.length - retained.length >= maxNewJobs) break;
    if (decision.decision !== "select" || !decision.job || ids.has(decision.job.id) || excludedIds.has(decision.job.id)) continue;
    ids.add(decision.job.id);
    jobs.push(decision.job);
    methods[decision.job.id] = "rules-v1";
  }
  const publicLedger = new Set(ledger.detailIds);
  if (jobs.some((job) => !publicLedger.has(job.id))) throw new RunError("ledger-missing-job", "A selected record has no corresponding detail evidence.");
  const result = {
    version: 1, generatedAt,
    run: {
      ...previous.run, mode: "定时规则初筛 · 累计快照",
      cardsReviewed: ledger.reviewedIds.length, detailsRead: ledger.detailIds.length,
      selectedCount: jobs.length, newCount: jobs.filter((job) => job.isNew).length,
    },
    jobs, assessmentMethods: methods,
    automation: {
      version: 1, enabled, timeZone: schedule.timeZone, times: [...schedule.times],
      runId, startedAt, completedAt: generatedAt, status: "sampled",
      freshSources: ["BOSS直聘"], retainedSources: ["字节跳动招聘官网", "猎聘"],
      reviewedThisRun: new Set(evidence.cards.map((card) => card.id)).size,
      detailsThisRun: new Set(evidence.details.map((detail) => detail.id)).size,
      ...pendingReviewCounts(decisions, [...(evidence.detailConflicts ?? []), ...(evidence.incompleteDetails ?? [])]),
    },
  };
  return validateSnapshot(result);
}
