import test from "node:test";
import assert from "node:assert/strict";
import {
  firstSeenGroupLabel, groupJobsByFirstSeen, nextShanghaiMidnight,
  selectArrivalView, selectJobs, shanghaiDateKey,
} from "../docs/model.mjs";
import { fixture } from "./helpers/fixtures.mjs";

const record = (id, firstSeen, overrides = {}) => fixture({ id, firstSeen, ...overrides });
const ids = (jobs) => jobs.map((job) => job.id);

test("Shanghai date changes exactly at UTC 16:00 regardless of a different US local calendar", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["America/Los_Angeles", "America/New_York", "UTC", "Asia/Shanghai"]) {
      process.env.TZ = zone;
      const before = "2026-09-07T15:59:59Z", after = "2026-09-07T16:00:00Z";
      assert.equal(shanghaiDateKey(before), "2026-09-07");
      assert.equal(shanghaiDateKey(new Date(after)), "2026-09-08");
      assert.equal(nextShanghaiMidnight(before), Date.parse(after));
      assert.equal(nextShanghaiMidnight(after), Date.parse("2026-09-08T16:00:00Z"));
      const jobs = [record("before", before), record("after", after)];
      assert.deepEqual(ids(selectArrivalView(jobs, "today", before)), ["before"]);
      assert.deepEqual(ids(selectArrivalView(jobs, "today", after)), ["after"]);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("morning arrivals survive the noon isNew reset and date views compose with optional filters", () => {
  const jobs = [
    ...[1, 2, 3].map((id) => record(`morning-${id}`, "2026-09-08T09:30:00+08:00", { isNew: false })),
    ...[1, 2].map((id) => record(`noon-${id}`, "2026-09-08T12:30:00+08:00", { isNew: true })),
    record("older", "2026-09-07T09:30:00+08:00", { isNew: false }),
  ];
  const now = "2026-09-08T13:00:00+08:00";
  const before = structuredClone(jobs);
  const today = selectArrivalView(jobs, "today", now);
  assert.equal(today.length, 5);
  assert.equal(selectJobs(today, { newOnly: true }).length, 2);
  assert.equal(selectJobs(today, { salaryMode: "unknown", keyword: "Channel Sales" }).length, 5);
  assert.equal(selectJobs(today, { salaryMode: "known" }).length, 0);
  assert.equal(selectJobs(jobs).length, 6, "Existing callers still default to all jobs.");
  assert.deepEqual(jobs, before);
});

test("recent means exactly today and the previous six Shanghai calendar dates, not 168 hours", () => {
  const now = "2026-09-08T12:00:00+08:00";
  const jobs = [
    record("old", "2026-09-01T23:59:59.999+08:00"),
    record("six-days-midnight", "2026-09-02T00:00:00+08:00"),
    record("today", "2026-09-08T00:00:00+08:00"),
    record("at-now", now),
    record("future-same-day", "2026-09-08T12:00:00.001+08:00"),
    record("tomorrow", "2026-09-09T00:00:00+08:00"),
    record("same-instant-offset", "2026-09-08T00:00:00-04:00"),
  ];
  assert.deepEqual(ids(selectArrivalView(jobs, "week", now)),
    ["six-days-midnight", "today", "at-now", "same-instant-offset"]);
  assert.deepEqual(ids(selectArrivalView(jobs, "today", now)), ["today", "at-now", "same-instant-offset"]);
  assert.deepEqual(selectArrivalView(jobs, "all", now), jobs);
  assert.notEqual(selectArrivalView(jobs, "all", now), jobs);
  assert.deepEqual(selectArrivalView(jobs), jobs);
});

test("date-only firstSeen is a Shanghai calendar date and never gains an invented time", () => {
  const jobs = [record("old", "2026-09-01"), record("first", "2026-09-02"),
    record("today", "2026-09-08"), record("future", "2026-09-09")];
  const now = "2026-09-07T16:00:00Z";
  assert.deepEqual(ids(selectArrivalView(jobs, "today", now)), ["today"]);
  assert.deepEqual(ids(selectArrivalView(jobs, "week", now)), ["first", "today"]);
  assert.equal(shanghaiDateKey("2026-09-08"), "2026-09-08");
  assert.equal(jobs[2].firstSeen, "2026-09-08");
});

test("groups descend by Shanghai date and preserve each requested within-group sort without duplicates", () => {
  const jobs = [
    record("old-high", "2026-09-07T08:00:00+08:00", { matchScore: 100 }),
    record("today-low", "2026-09-07T16:05:00Z", { matchScore: 10, priority: "优先了解" }),
    record("today-high", "2026-09-08T07:00:00+08:00", { matchScore: 90, priority: "转型备选" }),
    record("old-low", "2026-09-07T09:00:00+08:00", { matchScore: 5 }),
  ];
  const now = "2026-09-08T12:00:00+08:00";
  const before = structuredClone(jobs);
  const scored = groupJobsByFirstSeen(jobs, { now });
  assert.deepEqual(scored.map((group) => group.date), ["2026-09-08", "2026-09-07"]);
  assert.deepEqual(scored.map((group) => group.label), ["今天 · 09月08日", "昨天 · 09月07日"]);
  assert.deepEqual(ids(scored[0].jobs), ["today-high", "today-low"]);
  assert.deepEqual(ids(groupJobsByFirstSeen(jobs, { now, sortBy: "priority" })[0].jobs), ["today-low", "today-high"]);
  assert.deepEqual(ids(groupJobsByFirstSeen(jobs, { now, sortBy: "firstSeen" })[1].jobs), ["old-low", "old-high"]);
  const allIds = scored.flatMap((group) => ids(group.jobs));
  assert.equal(new Set(allIds).size, jobs.length);
  assert.deepEqual([...allIds].sort(), ids(jobs).sort());
  assert.deepEqual(jobs, before);
});

test("older year headings remain unambiguous including yesterday across New Year", () => {
  const now = "2027-01-01T04:00:00Z";
  assert.equal(firstSeenGroupLabel("2027-01-01", now), "今天 · 01月01日");
  assert.equal(firstSeenGroupLabel("2026-12-31", now), "昨天 · 2026年12月31日");
  assert.equal(firstSeenGroupLabel("2026-09-07", now), "2026年09月07日");
  assert.equal(firstSeenGroupLabel("2025-01-01", now), "2025年01月01日");
  assert.throws(() => selectArrivalView([], "unsupported", now), RangeError);
  assert.throws(() => selectArrivalView([], "today", "not-a-date"), RangeError);
  assert.throws(() => shanghaiDateKey("2026-02-30"), RangeError);
  assert.throws(() => firstSeenGroupLabel("2026-02-30", now), RangeError);
});
