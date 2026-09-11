import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { acquireLock, atomicJson, readJson, appendLog, RunError, privateDirectory, pruneEvidence } from "./io.mjs";
import { dueSlot, nextSlots, latestSlot } from "./clock.mjs";
import { loadConfiguration, rotatingQueries } from "./config.mjs";
import { collectBoss, discoverBoss, evaluatePage, cardsInPage } from "./browser.mjs";
import { validateLedger, updateLedger } from "./snapshot.mjs";
import { emptyReadHistory, validateReadHistory, updateReadHistory } from "./coverage.mjs";
import { loadManualExclusions, manualExcludedIds } from "./exclusions.mjs";
import { assertRuntimeMode, collectionMode, candidateMode, modeSettings, assessForReview, prefilterIntentCard, intentCardPriority } from "./intent.mjs";
import { loadReviewQueue, updateReviewQueue, saveReviewQueue, reviewCounts } from "./review.mjs";
import { candidateEvidence, rejectedCandidateIds } from "./candidates.mjs";
import { assessRoleExclusion, loadRoleContext, emptyRoleHistory } from "./role-exclusions.mjs";

export function initialState(now = new Date()) {
  return { version: 1, activatedAt: latestSlot(now).at, lastScheduledSlot: null, queryCursor: 0, lastRun: null, lastPublished: null };
}

export function finalStatus({ error, dryRun, publication, mode }) {
  if (error) return error.code === "cancelled" || error.name === "AbortError" ? "cancelled" : error.blocked ? "blocked" : "failed";
  if (dryRun) return "dry-run";
  if (mode === collectionMode) {
    if (publication !== null) throw new RunError("unexpected-publication", "A collection-only run must never publish.");
    return "collected";
  }
  if (!publication?.sha) throw new RunError("publication-unconfirmed", "A run cannot succeed without a verified publication.");
  return "succeeded";
}

export function validateRunRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || typeof request.id !== "string" || !/^[a-z0-9-]{8,90}$/.test(request.id)
    || typeof request.dryRun !== "boolean"
    || (request.controlled !== undefined && typeof request.controlled !== "boolean")
    || (request.retryOf !== undefined && (typeof request.retryOf !== "string" || !/^[a-z0-9-]{8,90}$/.test(request.retryOf)))
    || (request.queryCursor !== undefined && (!Number.isSafeInteger(request.queryCursor) || request.queryCursor < 0))) {
    throw new RunError("invalid-request", "Manual run request is invalid.", { blocked: true });
  }
  return request;
}

function sanitizeCode(error) {
  return typeof error.code === "string" && /^[a-z0-9-]{1,60}$/.test(error.code) ? error.code : "internal-error";
}

export async function status(root) {
  const state = await readJson(join(root, "state.json"));
  const control = await readJson(join(root, "control.json"));
  const runtime = await readJson(join(root, "runtime.json"));
  const collectionReady = runtime.mode === collectionMode && runtime.autoPublish === false && runtime.reviewRequired === true
    && (runtime.manualApprovalRequiredForVisibility === undefined || runtime.manualApprovalRequiredForVisibility === true);
  const candidateReady = runtime.mode === candidateMode && runtime.autoPublish === true && runtime.reviewRequired === false
    && runtime.manualApprovalRequiredForVisibility === false;
  const modeReady = collectionReady || candidateReady;
  const excludedIds = manualExcludedIds(await loadManualExclusions(root));
  const roleContext = await loadRoleContext(root, runtime);
  const pending = await readJson(join(root, "pending.json"), null);
  return { enabled: !control.paused && modeReady,
    ...modeSettings(candidateReady ? candidateMode : collectionMode),
    mode: modeReady ? runtime.mode : "migration-required",
    queueBlocksVisibility: !candidateReady, qualificationVerified: false,
    roleExclusions: { policy: roleContext.policy?.id ?? null, version: roleContext.policy?.version ?? null,
      blockedIds: new Set(roleContext.history.entries.map((entry) => entry.id)).size },
    next: nextSlots(), activationBoundary: state.collectionActivatedAt ?? null,
    reviewQueue: reviewCounts(await loadReviewQueue(root), excludedIds),
    lastRun: state.lastRun, lastCollection: state.lastCollection ?? null, lastPublished: state.lastPublished,
    lastRecovery: state.lastRecovery ?? null,
    pendingReviewedPublication: await readJson(join(root, "review-publication-pending.json"), null),
    pending: pending ? Object.fromEntries(Object.entries(pending).filter(([key]) => key !== "snapshot")) : null,
    prerequisite: "Logged-in macOS session and ordinary Chrome; AC for idle awake helper. Manual sleep, closed lid and logout are not bypassed." };
}

export async function preflight(root, { browser = true } = {}) {
  const { runtime } = await loadConfiguration(root);
  validateLedger(await readJson(join(root, "ledger.json")));
  await loadReviewQueue(root);
  let source = "not-probed";
  if (browser) {
    const tab = await readJson(join(root, "browser.json"), null) ?? await discoverBoss();
    const page = await evaluatePage(tab, null, cardsInPage);
    if (page.state !== "ready") throw new RunError("source-not-ready", "The BOSS search tab has no readable result state.", { blocked: true });
    source = `ready:${page.cards.length}`;
  }
  return { ...modeSettings(runtime.mode), browser: source, publicationAttempted: false, gitAccessed: false };
}

export async function run(root, { tick = false, dryRun = false, signal: outerSignal, services = {} } = {}) {
  const operations = {
    loadConfiguration, collectBoss, assessForReview, prefilterIntentCard,
    publishCandidates: async (...args) => (await import("./publish-candidates.mjs")).publishCandidates(...args),
    recoverCandidates: async (...args) => (await import("./publish-candidates.mjs")).retryCandidatePublication(...args),
    caffeinate: () => spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }),
    ...services,
  };
  await privateDirectory(root);
  const release = await acquireLock(root, "checking");
  let active = null, controller = null, monitor = null, timer = null, caffeine = null;
  const stopFromSignal = () => controller?.abort(new RunError("cancelled", "Run was interrupted."));
  process.once("SIGTERM", stopFromSignal);
  process.once("SIGINT", stopFromSignal);
  try {
    const control = await readJson(join(root, "control.json"));
    const state = await readJson(join(root, "state.json"));
    if (state.lastRun?.status === "running") {
      state.lastRun = { ...state.lastRun, status: "failed", code: "interrupted", finishedAt: new Date().toISOString() };
      await atomicJson(join(root, "state.json"), state);
      await appendLog(root, { event: "interrupted-run-recovered", runId: state.lastRun.id });
    }
    const request = tick ? await readJson(join(root, "request.json"), null) : null;
    if (request) validateRunRequest(request);
    const slot = dueSlot({ ...state, paused: control.paused });
    if (tick && !request && !slot) return { status: "idle" };
    if (request) dryRun = request.dryRun === true;
    const controlled = request?.controlled === true;
    if (control.paused && !dryRun && !controlled) {
      if (request) await unlink(join(root, "request.json"));
      if (tick) return { status: "paused" };
      throw new RunError("paused", "Collection is paused. Use an explicitly controlled acceptance run or resume the configured mode.", { blocked: true });
    }
    const scheduled = tick && !request;
    const id = scheduled ? slot.id : request?.id ?? `manual-${new Date().toISOString().replace(/\D/g, "")}-${randomUUID().slice(0, 8)}`;
    active = { id, trigger: scheduled ? "scheduled" : controlled ? "launchd-controlled" : request?.retryOf ? "launchd-retry" : request ? "launchd-manual" : "manual",
      pid: process.pid, startedAt: new Date().toISOString(), status: "running", dryRun, mode: collectionMode,
      autoPublish: false, controlled };
    if (request?.retryOf) active.retryOf = request.retryOf;
    state.lastRun = active;
    if (scheduled && !dryRun && slot) state.lastScheduledSlot = slot.id;
    if (request) await unlink(join(root, "request.json"));
    await atomicJson(join(root, "state.json"), state);
    await appendLog(root, { runId: id, event: "started", trigger: active.trigger, dryRun });
    controller = new AbortController();
    if (outerSignal?.aborted) controller.abort(outerSignal.reason);
    else if (outerSignal) outerSignal.addEventListener("abort", () => controller.abort(outerSignal.reason), { once: true });
    timer = setTimeout(() => controller.abort(new RunError("run-timeout", "The bounded run deadline was reached.")), 30 * 60000);
    const signal = AbortSignal.any([controller.signal, release.signal]);
    monitor = setInterval(() => {
      readJson(join(root, "control.json")).then((latest) => {
        if (latest.cancelRunId === id || (latest.paused && !dryRun && !controlled)) controller.abort(new RunError("cancelled", "Scheduler paused or run cancelled."));
      }, (error) => controller.abort(error));
    }, 1000);
    caffeine = operations.caffeinate();
    caffeine?.once("error", (error) => controller.abort(error));
    const runDirectory = join(root, "runs", id);
    await privateDirectory(runDirectory);
    let publication = null;
    let failure = null, summary = null, sampledAt = null;
    try {
      const { runtime, matching, intent, roleContext = { policy: null, history: emptyRoleHistory() } } = await operations.loadConfiguration(root);
      const settings = assertRuntimeMode(runtime);
      Object.assign(active, settings);
      const queue = await loadReviewQueue(root);
      const excludedIds = rejectedCandidateIds(queue, manualExcludedIds(await loadManualExclusions(root)));
      const roleBlocked = new Set(roleContext.history.entries.map((entry) => entry.id));
      const eligibleCard = (card) => {
        if (excludedIds.has(card.id)) return { eligible: false, reason: "manual-excluded" };
        if (roleBlocked.has(card.id)) return { eligible: false, reason: "role-feedback-excluded" };
        const decision = assessRoleExclusion({ title: card.title }, roleContext.policy);
        return decision ? { eligible: false, reason: decision.reasonCode }
          : operations.prefilterIntentCard(card, matching, intent, excludedIds);
      };
      let ledger = validateLedger(await readJson(join(root, "ledger.json")));
      let readHistory = validateReadHistory(await readJson(join(root, "read-history.json"), emptyReadHistory()));
      if (runtime.mode === candidateMode && !dryRun && await readJson(join(root, "pending.json"), null)) {
        await operations.recoverCandidates(root, signal);
        state.lastPublished = (await readJson(join(root, "state.json"))).lastPublished;
      }
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new RunError("run-timeout", "The bounded run deadline was reached.")), runtime.limits.timeoutMinutes * 60000);
      const queryCursor = request?.queryCursor ?? state.queryCursor;
      active.queryCursor = queryCursor;
      const queries = rotatingQueries(runtime.queries, queryCursor, runtime.limits.queriesPerRun);
      if (!request?.retryOf) state.queryCursor = (queryCursor + queries.length) % runtime.queries.length;
      await atomicJson(join(root, "state.json"), state);
      const evidence = await operations.collectBoss({
        root, queries, limits: runtime.limits, signal, prefilter: eligibleCard,
        knownDetailIds: ledger.detailIds, readHistory,
        priorityFor: intentCardPriority,
        onEvidence: async (partial) => {
          await atomicJson(join(runDirectory, "evidence.json"), partial);
          const verified = runtime.mode === candidateMode ? candidateEvidence(partial) : partial;
          ledger = updateLedger(ledger, verified);
          await atomicJson(join(root, "ledger.json"), ledger);
          readHistory = updateReadHistory(readHistory, verified.details);
          await atomicJson(join(root, "read-history.json"), readHistory);
        },
      });
      if (!evidence.complete) throw new RunError("source-incomplete", "The bounded source search did not complete; public data is unchanged.", { blocked: true });
      if (runtime.mode === collectionMode && !evidence.details.length && evidence.cards.some((card) => eligibleCard(card).eligible)) {
        throw new RunError("no-complete-jds", "No full matching JD was read; the dataset is unchanged.", { blocked: true });
      }
      sampledAt = new Date().toISOString();
      const verified = runtime.mode === candidateMode ? candidateEvidence(evidence, sampledAt) : evidence;
      const records = verified.details.filter((record) => !excludedIds.has(record.id));
      const decisions = records.map((record) => ({ id: record.id, ...operations.assessForReview(record, matching, intent) }));
      const detailConflicts = evidence.detailConflicts ?? [];
      const incompleteDetails = evidence.incompleteDetails ?? [];
      await atomicJson(join(runDirectory, "review.json"), [
        ...decisions,
        ...detailConflicts.map(({ id: recordId, code }) => ({ id: recordId, decision: "review", reasons: [code] })),
        ...incompleteDetails.map(({ id: recordId, code }) => ({ id: recordId, decision: "review", reasons: [code] })),
      ]);
      const updatedQueue = updateReviewQueue(queue, records, decisions, id, excludedIds);
      signal.throwIfAborted();
      const latestControl = await readJson(join(root, "control.json"));
      if (latestControl.cancelRunId === id || (latestControl.paused && !dryRun && !controlled)) {
        throw new RunError("cancelled", "Collection was paused before saving the review queue.");
      }
      await saveReviewQueue(root, updatedQueue);
      summary = {
        reviewed: evidence.cards.length, details: evidence.details.length, publicAdmissions: 0,
        intentPrimary: decisions.filter((item) => item.intent.decision === "primary").length,
        intentSecondary: decisions.filter((item) => item.intent.decision === "secondary").length,
        intentOutside: decisions.filter((item) => item.intent.decision === "outside").length,
        intentUnclear: decisions.filter((item) => item.intent.decision === "unclear").length,
        qualificationPending: decisions.filter((item) => item.qualification.status === "pending").length,
        queue: reviewCounts(updatedQueue, excludedIds),
        detailConflicts: detailConflicts.length, incompleteDetails: incompleteDetails.length,
        coverage: evidence.queries.map(({ term, industry, position, count, detailsRead, unreadDetails, recheckedDetails }) =>
          ({ term, industry, position: position ?? null, cards: count, details: detailsRead ?? 0, unread: unreadDetails ?? 0, rechecked: recheckedDetails ?? 0 })),
      };
      if (!dryRun) {
        state.lastCollection = { ...active, status: "collected", finishedAt: sampledAt, sampledAt, summary, publication: null };
        await atomicJson(join(root, "state.json"), state);
      }
      signal.throwIfAborted();
      if (runtime.mode === candidateMode && !dryRun) {
        publication = await operations.publishCandidates(root, {
          evidence, ledger, intent, runId: id, sampleRunId: id, sampledAt,
          publicationKind: scheduled ? "scheduled" : "controlled",
        }, signal);
        summary.publicAdmissions = publication.newCount;
        summary.visibleCandidates = publication.candidates;
        summary.manuallySelected = publication.selected;
      }
    } catch (error) {
      failure = signal.aborted ? signal.reason : error;
    }
    const outcome = {
      ...active, status: finalStatus({ error: failure, dryRun, publication, mode: active.mode }), finishedAt: new Date().toISOString(),
      code: failure ? sanitizeCode(failure) : null, sampledAt, summary, publication,
    };
    state.lastRun = outcome;
    if (outcome.status === "collected") state.lastCollection = outcome;
    state.lastPublished = (await readJson(join(root, "state.json"))).lastPublished;
    await atomicJson(join(root, "state.json"), state);
    await atomicJson(join(runDirectory, "result.json"), outcome);
    await appendLog(root, { event: "finished", runId: id, status: outcome.status, code: outcome.code, summary });
    await pruneEvidence(root);
    return outcome;
  } finally {
    clearInterval(monitor);
    clearTimeout(timer);
    if (caffeine && caffeine.exitCode === null && caffeine.signalCode === null) {
      const stopped = once(caffeine, "close");
      caffeine.kill("SIGTERM");
      await stopped;
    }
    process.removeListener("SIGTERM", stopFromSignal);
    process.removeListener("SIGINT", stopFromSignal);
    await release();
  }
}
