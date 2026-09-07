import { join } from "node:path";
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { acquireLock, atomicJson, readJson, appendLog, RunError, privateDirectory, pruneEvidence } from "./io.mjs";
import { dueSlot, nextSlots, latestSlot } from "./clock.mjs";
import { loadConfiguration, rotatingQueries } from "./config.mjs";
import { collectBoss, discoverBoss, evaluatePage, cardsInPage } from "./browser.mjs";
import { validateLedger, updateLedger, buildSnapshot } from "./snapshot.mjs";
import { preflightGithub, prepareClone, publishSnapshot } from "./publish.mjs";
import { notifyFailure } from "./process.mjs";

export function initialState(now = new Date()) {
  return { version: 1, activatedAt: latestSlot(now).at, lastScheduledSlot: null, queryCursor: 0, lastRun: null, lastPublished: null };
}

export function finalStatus({ error, dryRun, publication }) {
  if (error) return error.code === "cancelled" || error.name === "AbortError" ? "cancelled" : error.blocked ? "blocked" : "failed";
  if (dryRun) return "dry-run";
  if (!publication?.sha) throw new RunError("publication-unconfirmed", "A run cannot succeed without a verified publication.");
  return "succeeded";
}

export function validateRunRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || typeof request.id !== "string" || !/^[a-z0-9-]{8,90}$/.test(request.id)
    || typeof request.dryRun !== "boolean"
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
  return { enabled: !control.paused, next: nextSlots(), lastRun: state.lastRun, lastPublished: state.lastPublished,
    lastRecovery: state.lastRecovery ?? null,
    pending: await readJson(join(root, "pending.json"), null), prerequisite: "Logged-in macOS session and ordinary Chrome; AC for idle awake helper. Manual sleep, closed lid and logout are not bypassed." };
}

export async function preflight(root, { browser = true } = {}) {
  const { runtime } = await loadConfiguration(root);
  validateLedger(await readJson(join(root, "ledger.json")));
  const github = await preflightGithub(runtime);
  let source = "not-probed";
  if (browser) {
    const tab = await readJson(join(root, "browser.json"), null) ?? await discoverBoss();
    const page = await evaluatePage(tab, null, cardsInPage);
    if (page.state !== "ready") throw new RunError("source-not-ready", "The BOSS search tab has no readable result state.", { blocked: true });
    source = `ready:${page.cards.length}`;
  }
  return { github: "ready", pagesUrl: github.pagesUrl, browser: source, publicationAttempted: false };
}

export async function run(root, { tick = false, dryRun = false, signal: outerSignal, services = {} } = {}) {
  const operations = {
    loadConfiguration, preflightGithub, prepareClone, collectBoss, publishSnapshot, notifyFailure,
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
    if (control.paused && !dryRun) {
      if (request) await unlink(join(root, "request.json"));
      if (tick) return { status: "paused" };
      throw new RunError("paused", "Scheduler is paused; resume before starting a publication.", { blocked: true });
    }
    const scheduled = tick && !request;
    const id = scheduled ? slot.id : request?.id ?? `manual-${new Date().toISOString().replace(/\D/g, "")}-${randomUUID().slice(0, 8)}`;
    active = { id, trigger: scheduled ? "scheduled" : request?.retryOf ? "launchd-retry" : request ? "launchd-manual" : "manual",
      pid: process.pid, startedAt: new Date().toISOString(), status: "running", dryRun };
    if (request?.retryOf) active.retryOf = request.retryOf;
    state.lastRun = active;
    if (!dryRun && slot) state.lastScheduledSlot = slot.id;
    if (request) await unlink(join(root, "request.json"));
    await atomicJson(join(root, "state.json"), state);
    await appendLog(root, { runId: id, event: "started", trigger: active.trigger, dryRun });
    controller = new AbortController();
    if (outerSignal) outerSignal.addEventListener("abort", () => controller.abort(outerSignal.reason), { once: true });
    timer = setTimeout(() => controller.abort(new RunError("run-timeout", "The bounded run deadline was reached.")), 30 * 60000);
    const signal = controller.signal;
    monitor = setInterval(() => {
      readJson(join(root, "control.json")).then((latest) => {
        if (latest.cancelRunId === id || (latest.paused && !dryRun)) controller.abort(new RunError("cancelled", "Scheduler paused or run cancelled."));
      }, (error) => controller.abort(error));
    }, 1000);
    caffeine = operations.caffeinate();
    caffeine?.once("error", (error) => controller.abort(error));
    const runDirectory = join(root, "runs", id);
    await privateDirectory(runDirectory);
    let publication = null, failure = null, summary = null;
    try {
      const { runtime, matching } = await operations.loadConfiguration(root);
      const { screenJob, prefilterCard } = services.rules ?? await import("./screening.mjs");
      let ledger = validateLedger(await readJson(join(root, "ledger.json")));
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new RunError("run-timeout", "The bounded run deadline was reached.")), runtime.limits.timeoutMinutes * 60000);
      await operations.preflightGithub(runtime, signal);
      const prepared = await operations.prepareClone(root, runtime, signal);
      const queryCursor = request?.queryCursor ?? state.queryCursor;
      active.queryCursor = queryCursor;
      const queries = rotatingQueries(runtime.queries, queryCursor, runtime.limits.queriesPerRun);
      if (!request?.retryOf) state.queryCursor = (queryCursor + queries.length) % runtime.queries.length;
      await atomicJson(join(root, "state.json"), state);
      const evidence = await operations.collectBoss({
        root, queries, limits: runtime.limits, signal, prefilter: (card) => prefilterCard(card, matching),
        onEvidence: async (partial) => {
          await atomicJson(join(runDirectory, "evidence.json"), partial);
          ledger = updateLedger(ledger, partial);
          await atomicJson(join(root, "ledger.json"), ledger);
        },
      });
      if (!evidence.complete || (!evidence.details.length && evidence.cards.some((card) => prefilterCard(card, matching).eligible))) {
        throw new RunError("no-complete-jds", "No full matching JD was read; the dataset is unchanged.", { blocked: true });
      }
      const decisions = evidence.details.map((record) => ({ id: record.id, ...screenJob(record, matching) }));
      await atomicJson(join(runDirectory, "review.json"), decisions.filter((item) => item.decision !== "select")
        .map(({ id: recordId, decision, reasons }) => ({ id: recordId, decision, reasons })));
      const snapshot = buildSnapshot(prepared.snapshot, evidence, decisions, ledger, {
        runId: id, startedAt: active.startedAt, generatedAt: new Date().toISOString(), maxNewJobs: runtime.limits.maxNewJobs,
      });
      await atomicJson(join(runDirectory, "candidate.json"), snapshot);
      summary = {
        reviewed: evidence.cards.length, details: evidence.details.length, selected: snapshot.jobs.length,
        new: snapshot.run.newCount, review: decisions.filter((decision) => decision.decision === "review").length,
        rejected: decisions.filter((decision) => decision.decision === "reject").length,
      };
      signal.throwIfAborted();
      if (!dryRun) {
        const latestControl = await readJson(join(root, "control.json"));
        if (latestControl.paused || latestControl.cancelRunId === id) throw new RunError("cancelled", "Publication cancelled before writing.");
        publication = await operations.publishSnapshot(root, runtime, snapshot, prepared, signal,
          (pending) => atomicJson(join(root, "pending.json"), pending));
        signal.throwIfAborted();
        await unlink(join(root, "pending.json"));
        state.lastPublished = { runId: id, at: new Date().toISOString(), ...publication, generatedAt: snapshot.generatedAt };
      }
    } catch (error) {
      failure = signal.aborted ? signal.reason : error;
    }
    const outcome = {
      ...active, status: finalStatus({ error: failure, dryRun, publication }), finishedAt: new Date().toISOString(),
      code: failure ? sanitizeCode(failure) : null, summary, publication,
    };
    state.lastRun = outcome;
    await atomicJson(join(root, "state.json"), state);
    await atomicJson(join(runDirectory, "result.json"), outcome);
    await appendLog(root, { event: "finished", runId: id, status: outcome.status, code: outcome.code, summary });
    if (failure) {
      await operations.notifyFailure(outcome.code).catch((error) => appendLog(root, { event: "notification-failed", code: sanitizeCode(error) }));
    }
    await pruneEvidence(root);
    return outcome;
  } finally {
    clearInterval(monitor);
    clearTimeout(timer);
    if (caffeine && caffeine.exitCode === null) caffeine.kill("SIGTERM");
    process.removeListener("SIGTERM", stopFromSignal);
    process.removeListener("SIGINT", stopFromSignal);
    await release();
  }
}
