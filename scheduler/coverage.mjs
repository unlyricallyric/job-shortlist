import { createHash } from "node:crypto";
import { isIsoDate } from "../docs/model.mjs";
import { RunError } from "./io.mjs";

const historyLimit = 2000;
const recheckAgeMs = 7 * 86400000;

export function emptyReadHistory() {
  return { version: 1, entries: {} };
}

export function validateReadHistory(history) {
  if (!history || history.version !== 1 || !history.entries || typeof history.entries !== "object"
    || Array.isArray(history.entries) || Object.keys(history).length !== 2
    || Object.keys(history.entries).length > historyLimit) {
    throw new RunError("invalid-read-history", "Private read history is invalid.");
  }
  for (const [id, entry] of Object.entries(history.entries)) {
    if (!/^boss-[A-Za-z0-9_~-]+$/.test(id) || /[\r\n]/.test(id) || !entry || Object.keys(entry).length !== 2
      || !isIsoDate(entry.readAt, false) || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) {
      throw new RunError("invalid-read-history", "Private read-history entry is invalid.");
    }
  }
  return history;
}

export function cardFingerprint(card) {
  return createHash("sha256").update(JSON.stringify(
    ["title", "company", "location", "experienceText", "educationText"].map((key) => card[key] ?? null),
  )).digest("hex");
}

export function updateReadHistory(history, records) {
  validateReadHistory(history);
  const entries = { ...history.entries };
  for (const record of records) {
    if (!isIsoDate(record.retrievedAt, false)) throw new RunError("invalid-read-history", "A full read needs an observation timestamp.");
    const previous = entries[record.id];
    if (!previous || Date.parse(record.retrievedAt) >= Date.parse(previous.readAt)) {
      entries[record.id] = { readAt: record.retrievedAt, fingerprint: cardFingerprint(record) };
    }
  }
  const retained = Object.entries(entries).sort(([, a], [, b]) => Date.parse(b.readAt) - Date.parse(a.readAt)).slice(0, historyLimit);
  return validateReadHistory({ version: 1, entries: Object.fromEntries(retained) });
}

function observationPriority(card, knownIds, history, now) {
  const entry = history.entries[card.id];
  const known = knownIds.has(card.id) || entry !== undefined;
  const changed = entry !== undefined && entry.fingerprint !== cardFingerprint(card);
  const due = known && (!entry || now - Date.parse(entry.readAt) >= recheckAgeMs);
  return { rank: changed ? 0 : !known ? 1 : due ? 2 : 3, known, recheck: changed || due,
    readAt: entry ? Date.parse(entry.readAt) : 0 };
}

export function planDetailReads(pools, budget, {
  knownIds = new Set(), history = emptyReadHistory(), now = Date.now(),
  priorityFor = () => 0, excluded = new Set(), readCounts = pools.map(() => 0), recheckDone = false,
} = {}) {
  validateReadHistory(history);
  if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isFinite(now)) throw new RunError("invalid-read-budget", "Full-JD budget is invalid.");
  const queues = pools.map((cards) => cards.map((card, index) => ({
    card, index, ...observationPriority(card, knownIds, history, now), purpose: priorityFor(card),
  })).sort((a, b) => a.rank - b.rank || (a.rank >= 2 ? a.readAt - b.readAt : 0)
    || b.purpose - a.purpose || a.index - b.index));
  const plan = pools.map(() => []);
  const used = new Set(excluded);
  for (let remaining = budget; remaining > 0; remaining--) {
    const available = queues.map((queue, index) => ({
      index, count: (readCounts[index] ?? 0) + plan[index].length,
      queue: queue.filter(({ card }) => !used.has(card.id)),
    })).filter(({ queue }) => queue.length);
    if (!available.length) break;
    available.sort((a, b) => a.count - b.count || a.index - b.index);
    const next = available[0];
    let candidate = next.queue[0];
    // Reserve one ageing recheck after that query's first opportunity; recent reads never get this reserve.
    if (!recheckDone && candidate.rank > 0 && (next.count > 0 || remaining === 1)) {
      candidate = next.queue.find((item) => item.recheck) ?? candidate;
    }
    used.add(candidate.card.id);
    if (candidate.recheck) recheckDone = true;
    plan[next.index].push(candidate.card);
  }
  return plan;
}

export function isDueRecheck(card, knownIds, history, now = Date.now()) {
  return observationPriority(card, knownIds, history, now).recheck;
}
