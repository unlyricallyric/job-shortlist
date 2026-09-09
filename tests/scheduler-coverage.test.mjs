import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectBoss } from "../scheduler/browser.mjs";
import { emptyReadHistory, updateReadHistory, planDetailReads, cardFingerprint } from "../scheduler/coverage.mjs";
import { defaultLimits } from "../scheduler/config.mjs";
import { fixture } from "./helpers/fixtures.mjs";
import { RunError, readJson, atomicJson } from "../scheduler/io.mjs";

const now = Date.parse("2026-09-09T04:00:00Z");
const card = (name, overrides = {}) => ({
  ...fixture({ id: `boss-test-${name}`, url: `https://www.zhipin.com/job_detail/test-${name}.html` }),
  retrievedAt: new Date(now).toISOString(), ...overrides,
});
const pool = (prefix, count) => Array.from({ length: count }, (_, index) => card(`${prefix}-${index}`));
const queries = [{ term: "伙伴赋能", industry: "100021" }, { term: "市场", industry: "100016" },
  { term: "生态合作", industry: "100029" }];

test("budget allocation visits each eligible nonempty query instead of exhausting the first page", () => {
  for (const [sizes, expected] of [
    [[0, 15, 15], [0, 4, 4]],
    [[15, 15, 15], [3, 3, 2]],
    [[1, 15, 15], [1, 4, 3]],
    [[15, 0, 0], [8, 0, 0]],
    [[0, 0, 0], [0, 0, 0]],
  ]) {
    const result = planDetailReads(sizes.map((count, index) => pool(String(index), count)), 8, { now });
    assert.deepEqual(result.map((records) => records.length), expected);
    assert.equal(new Set(result.flat().map((record) => record.id)).size, result.flat().length);
  }
  const shared = card("shared");
  const result = planDetailReads([[shared], [shared, card("second")], [shared, card("third")]], 8, { now });
  assert.equal(result.flat().length, 3);
  assert.equal(result.flat().filter((record) => record.id === shared.id).length, 1);
});

test("fresh unread IDs are preferred over recent repeats while generic titles remain eligible", () => {
  const repeated = pool("recent", 8);
  const unread = pool("unread", 5).map((record) => ({ ...record, title: "市场经理" }));
  const history = updateReadHistory(emptyReadHistory(), repeated);
  const result = planDetailReads([[...repeated, ...unread]], 8, {
    knownIds: new Set(repeated.map((record) => record.id)), history, now,
    priorityFor: (record) => record.title === "市场经理" ? 1 : 0,
  })[0];
  assert.deepEqual(result.slice(0, 5).map((record) => record.id), unread.map((record) => record.id));
  assert.equal(result.length, 8, "Recent review candidates are not permanently blacklisted.");
});

test("changed and aged records get bounded rechecks without discarding unread candidates", () => {
  const aged = card("aged", { retrievedAt: "2026-08-31T04:00:00Z" });
  const changed = card("changed");
  const recent = card("recent");
  const history = updateReadHistory(emptyReadHistory(), [aged, changed, recent]);
  const changedCard = { ...changed, title: "市场经理（新增职责）" };
  const unread = pool("new", 8);
  const result = planDetailReads([[recent, aged, ...unread]], 8, {
    knownIds: new Set([recent.id, aged.id]), history, now,
  })[0];
  assert.equal(result[0].id, unread[0].id);
  assert.ok(result.some((record) => record.id === aged.id));
  assert.equal(result.filter((record) => record.id.startsWith("boss-test-new")).length, 7);
  assert.ok(!result.some((record) => record.id === recent.id));
  const changedPlan = planDetailReads([[recent, ...unread, changedCard]], 3, {
    knownIds: new Set([recent.id, changed.id]), history, now,
  })[0];
  assert.equal(changedPlan[0].id, changed.id);
  assert.equal(changedPlan.filter((record) => record.id.startsWith("boss-test-new")).length, 2);
  const legacy = card("legacy");
  assert.ok(planDetailReads([[...unread, legacy]], 3, { knownIds: new Set([legacy.id]), now })[0]
    .some((record) => record.id === legacy.id), "Legacy IDs without timestamps remain available for rechecks.");
});

test("read history stores only fingerprints/timestamps, preserves latest reads and has a fixed size bound", async (t) => {
  const records = pool("history", 2002).map((record, index) => ({
    ...record, retrievedAt: new Date(now - index * 1000).toISOString(), jd: "TEST_ONLY_PRIVATE_JD",
  }));
  const history = updateReadHistory(emptyReadHistory(), records);
  assert.equal(Object.keys(history.entries).length, 2000);
  assert.deepEqual(Object.keys(history.entries[records[0].id]).sort(), ["fingerprint", "readAt"]);
  assert.equal(history.entries[records[0].id].fingerprint, cardFingerprint(records[0]));
  assert.ok(!JSON.stringify(history).includes("TEST_ONLY_PRIVATE_JD"));
  assert.deepEqual(updateReadHistory(history, [{ ...records[0], retrievedAt: "2020-01-01T00:00:00Z" }]), history);
  const root = await mkdtemp(join(tmpdir(), "shortlist-history-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "read-history.json");
  await atomicJson(path, history);
  const restored = await readJson(path);
  assert.deepEqual(restored, history);
});

function sourceServices(groups, { conflictId = null, changedOnRevisit = false } = {}) {
  const calls = [], searches = new Map();
  return {
    calls,
    services: {
      ownedTab: async () => ({ windowId: 1, tabId: 1 }),
      pause: async () => {},
      search: async (_tab, url) => {
        const term = new URL(url).searchParams.get("query");
        const index = queries.findIndex((query) => query.term === term);
        searches.set(index, (searches.get(index) ?? 0) + 1);
        calls.push({ type: "search", index });
        const records = changedOnRevisit && searches.get(index) > 1 ? groups[index].slice(1) : groups[index];
        return { state: "ready", cards: records, empty: records.length === 0, retrievedAt: new Date(now).toISOString() };
      },
      detail: async (_tab, url, record) => {
        const index = queries.findIndex((query) => query.term === new URL(url).searchParams.get("query"));
        calls.push({ type: "detail", index, id: record.id });
        return record.id === conflictId ? { state: "identity-conflict", code: "detail-title-conflict" }
          : { state: "ready", jd: "TEST_ONLY_FULL_JD", retrievedAt: new Date(now).toISOString() };
      },
    },
  };
}

test("actual collector orchestration yields four/four full JDs across the archived empty/security/cloud pattern", async () => {
  const source = sourceServices([[], pool("security", 15), pool("cloud", 15)]);
  const results = [];
  const evidence = await collectBoss({
    root: "/TEST_ONLY", queries, limits: defaultLimits, prefilter: () => ({ eligible: true }),
    signal: new AbortController().signal, onEvidence: async (value) => results.push(structuredClone(value)),
    services: source.services,
  });
  assert.deepEqual(source.calls.slice(0, 3), [0, 1, 2].map((index) => ({ type: "search", index })));
  assert.equal(evidence.complete, true);
  assert.equal(evidence.details.length, 8);
  assert.deepEqual(evidence.queries.map((query) => query.detailsRead), [0, 4, 4]);
  assert.equal(evidence.cards.length, 30);
  assert.equal(evidence.queries[0].empty, true);
  assert.ok(results.slice(0, -1).every((result) => !result.complete));
  assert.ok(evidence.queries.every((query) => query.visits <= 3));
});

test("collector borrows conflict allocations, never counts mismatched or duplicate IDs as full reads", async () => {
  const groups = [pool("first", 6), pool("second", 6), pool("third", 6)];
  groups[1].unshift(groups[0][0]);
  const source = sourceServices(groups, { conflictId: groups[0][0].id });
  const evidence = await collectBoss({
    root: "/TEST_ONLY", queries, limits: defaultLimits, prefilter: () => ({ eligible: true }),
    signal: new AbortController().signal, onEvidence: async () => {}, services: source.services,
  });

  test("collector refills short-detail quota without treating incomplete descriptions as full reads", async () => {
    const groups = [pool("a", 5), pool("b", 5), pool("c", 5)];
    const source = sourceServices(groups);
    const detail = source.services.detail;
    const shortId = groups[2][0].id;
    source.services.detail = async (tab, url, record) => record.id === shortId
      ? { state: "incomplete-detail", code: "jd-content-incomplete" } : detail(tab, url, record);
    const evidence = await collectBoss({
      root: "/TEST_ONLY", queries, limits: defaultLimits, prefilter: () => ({ eligible: true }),
      signal: new AbortController().signal, onEvidence: async () => {}, services: source.services,
    });
    assert.equal(evidence.details.length, 8);
    assert.deepEqual(evidence.queries.map((query) => query.detailsRead), [3, 3, 2]);
    assert.equal(evidence.incompleteDetails.length, 1);
    assert.equal(evidence.incompleteDetails[0].id, shortId);
    assert.ok(!evidence.details.some((record) => record.id === shortId));
  });
  assert.equal(evidence.details.length, 8);
  assert.equal(evidence.detailConflicts.length, 1);
  assert.ok(!evidence.details.some((record) => record.id === groups[0][0].id));
  assert.equal(new Set(evidence.details.map((record) => record.id)).size, 8);
  assert.deepEqual(evidence.queries.map((query) => query.detailsRead), [3, 3, 2]);
});

test("whole-source errors still stop collection and zero cards without an explicit marker is not success", async () => {
  const source = sourceServices([pool("first", 15), [], pool("third", 15)]);
  const search = source.services.search;
  source.services.search = async (tab, url) => {
    if (new URL(url).searchParams.get("query") === queries[1].term) {
      throw new RunError("captcha", "TEST_ONLY", { blocked: true });
    }
    return search(tab, url);
  };
  const args = {
    root: "/TEST_ONLY", queries, limits: defaultLimits, prefilter: () => ({ eligible: true }),
    signal: new AbortController().signal, onEvidence: async () => {},
  };
  await assert.rejects(collectBoss({ ...args, services: source.services }), { code: "captcha" });
  assert.ok(!source.calls.some((call) => call.type === "detail"));
  await assert.rejects(collectBoss({ ...args, services: {
    ...source.services, search: async () => ({ state: "ready", cards: [] }),
  } }), { code: "source-not-ready" });
});
