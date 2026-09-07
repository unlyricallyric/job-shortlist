import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SnapshotError, filterOptions, formatShanghaiTime, hasSalaryRange,
  isIsoDate, parseSalaryRange, safeJobUrl, selectJobs, validateSnapshot,
} from "../docs/model.mjs";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";

test("the actual public snapshot follows the complete data contract", async () => {
  const data = JSON.parse(await readFile(new URL("../docs/data/jobs.json", import.meta.url), "utf8"));
  assert.equal(validateSnapshot(data), data);
  assert.ok(data.jobs.every((job) => !job.id.includes("unit-test")));
});

test("empty and complete snapshots are valid without inventing unknown fields", () => {
  const empty = snapshotOf([]);
  assert.equal(validateSnapshot(empty), empty);
  const complete = snapshotOf([fixture()]);
  assert.equal(validateSnapshot(complete), complete);
  assert.equal(complete.jobs[0].salaryText, null);
  assert.equal(complete.jobs[0].publishedAt, null);
});

test("invalid schema, missing fields, extraneous fields and contradictory counts are rejected", () => {
  const mutations = [
    (data) => { data.version = 2; },
    (data) => { data.generatedAt = "2026-09-07T12:00:00"; },
    (data) => { data.run.selectedCount = 9; },
    (data) => { data.run.newCount = 0; },
    (data) => { data.run.cardsReviewed = 0; },
    (data) => { data.run.detailsRead = 0; },
    (data) => { data.run.source = "unexpected"; },
    (data) => { data.extra = "not allowed"; },
    (data) => { data.run.extra = "not allowed"; },
    (data) => { data.jobs[0].extra = "not allowed"; },
    (data) => { delete data.jobs[0].isNew; },
    (data) => { data.jobs[0].salaryMinK = 0; },
    (data) => { data.jobs[0].salaryMinK = "10"; },
    (data) => { data.jobs[0].salaryMinK = Infinity; },
    (data) => { data.jobs[0].salaryMinK = 20; data.jobs[0].salaryMaxK = 10; },
    (data) => { data.jobs[0].matchScore = 101; },
    (data) => { data.jobs[0].matchScore = -1; },
    (data) => { data.jobs[0].jdRead = "true"; },
    (data) => { data.jobs[0].summary = [""]; },
    (data) => { data.jobs[0].company = ""; },
    (data) => { data.jobs[0].lastSeen = "2026-09-06"; },
    (data) => { data.jobs[0].firstSeen = "2026-02-30"; },
    (data) => { data.jobs[0].lastSeen = "2026-09-08"; },
    (data) => { data.jobs[0].url = "https://www.zhipin.com/job_detail/different.html"; },
  ];
  for (const mutate of mutations) {
    const data = snapshotOf([fixture()]);
    mutate(data);
    assert.throws(() => validateSnapshot(data), SnapshotError, mutate.toString());
  }
  assert.throws(() => validateSnapshot(snapshotOf([fixture(), fixture()])), /重复/);
  for (const invalid of [null, [], "string", {}, { version: 1 }]) {
    assert.throws(() => validateSnapshot(invalid), SnapshotError);
  }
});

test("only safe, direct, non-tracking HTTPS source URLs are accepted", () => {
  for (const host of ["zhipin.com", "www.zhipin.com", "m.zhipin.com"]) {
    const url = `https://${host}/job_detail/unit-test-only~.html`;
    assert.equal(safeJobUrl(url), url);
  }
  for (const value of [
    null, "", "javascript:alert(1)", "data:text/html,test",
    "http://www.zhipin.com/job_detail/unit-test.html",
    "https://zhipin.com.attacker.test/job_detail/unit-test.html",
    "https://notzhipin.com/job_detail/unit-test.html",
    "https://www.zhipin.com@attacker.test/job_detail/unit-test.html",
    "https://user:password@www.zhipin.com/job_detail/unit-test.html",
    "https://www.zhipin.com:444/job_detail/unit-test.html",
    "https://www.zhipin.com/job_detail/unit-test.html?token=test",
    "https://www.zhipin.com/job_detail/unit-test.html#test",
    "https://www.zhipin.com/job_detail/%3Ctest%3E.html",
    "https://www.zhipin.com/other/unit-test.html",
    "https://www.zhipin.com/job_detail/unit-test.html\n",
    "https://www.zhipin.com\\@attacker.test/job_detail/unit-test.html",
    "//www.zhipin.com/job_detail/unit-test.html",
  ]) assert.equal(safeJobUrl(value), null, String(value));
});

test("Chinese timestamps respect Shanghai rollover and do not invent date-only times", () => {
  assert.equal(formatShanghaiTime("2026-09-06T17:08:00Z"), "2026.09.07 01:08");
  assert.equal(formatShanghaiTime("2026-09-07T08:09:00+08:00"), "2026.09.07 08:09");
  assert.equal(formatShanghaiTime("2026-09-07"), "2026.09.07");
  assert.equal(formatShanghaiTime(null), "无法获取");
  assert.ok(isIsoDate("2024-02-29"));
  for (const value of ["2026-02-29", "2026-04-31", "2026-09-07T24:00:00Z", "2026-09-07T12:00:00", "2026-09-07T12:00:00+24:00"]) {
    assert.equal(isIsoDate(value), false);
  }
  assert.throws(() => formatShanghaiTime("bad"), SnapshotError);
  assert.doesNotThrow(() => validateSnapshot(snapshotOf([fixture({ firstSeen: "2026-09-07" })])));
});

test("keyword search uses all requested words, Unicode normalization, and public descriptive fields", () => {
  const jobs = [
    fixture({ id: "a", title: "SaaS 渠道销售", company: "TEST_ONLY_COMPANY_A", requirements: ["生态合作"] }),
    fixture({ id: "b", title: "云业务", summary: ["渠道销售"], concerns: ["出差待确认"] }),
    fixture({ id: "c", title: "渠道销售", company: "TEST_ONLY_COMPANY_C" }),
  ];
  assert.deepEqual(selectJobs(jobs, { keyword: "  ｓａａｓ  渠道  " }).map((job) => job.id), ["a"]);
  assert.deepEqual(selectJobs(jobs, { keyword: "生态" }).map((job) => job.id), ["a"]);
  assert.deepEqual(selectJobs(jobs, { keyword: "云 出差" }).map((job) => job.id), ["b"]);
  assert.equal(selectJobs(jobs, { keyword: "<script>" }).length, 0);
});

test("category, priority and explicit new-in-run filters compose without score exclusions", () => {
  const jobs = [
    fixture({ id: "a", category: "渠道销售", priority: "优先了解", matchScore: 0 }),
    fixture({ id: "b", category: "渠道销售", priority: "进一步确认", isNew: false }),
    fixture({ id: "c", category: "商务拓展", priority: "优先了解" }),
    fixture({ id: "d", category: null, priority: null, isNew: false }),
  ];
  assert.equal(selectJobs(jobs).length, 4);
  assert.deepEqual(selectJobs(jobs, { category: "渠道销售", priority: "优先了解", newOnly: true }).map((job) => job.id), ["a"]);
  assert.equal(selectJobs(jobs, { category: "待确认", priority: "待确认" })[0].id, "d");
  assert.deepEqual(new Map(filterOptions(jobs, "category")).get("渠道销售"), 2);
  assert.throws(() => filterOptions(jobs, "source"), RangeError);
});

test("salary interval overlap is inclusive and unknown salary is handled explicitly", () => {
  const jobs = [
    fixture({ id: "low", salaryMinK: 5, salaryMaxK: 10 }),
    fixture({ id: "middle", salaryMinK: 10, salaryMaxK: 20 }),
    fixture({ id: "high", salaryMinK: 20, salaryMaxK: 30 }),
    fixture({ id: "unknown" }),
    fixture({ id: "text-only", salaryText: "SOURCE_TEXT_WITHOUT_NUMERIC_RANGE" }),
    fixture({ id: "open-upper", salaryMinK: 25 }),
  ];
  const ids = (options) => selectJobs(jobs, options).map((job) => job.id).sort();
  assert.deepEqual(ids({ salaryMin: 10, salaryMax: 20 }), ["high", "low", "middle", "text-only", "unknown"]);
  assert.deepEqual(ids({ salaryMin: 10, salaryMax: 20, salaryMode: "known" }), ["high", "low", "middle"]);
  assert.deepEqual(ids({ salaryMin: 10, salaryMax: 20, salaryMode: "unknown" }), ["text-only", "unknown"]);
  assert.deepEqual(ids({ salaryMin: 30, salaryMode: "known" }), ["high", "open-upper"]);
  assert.equal(hasSalaryRange(fixture()), false);
  assert.equal(hasSalaryRange(fixture({ salaryMaxK: 10 })), true);
  assert.equal(selectJobs([fixture({ salaryMaxK: 10 })], { salaryMin: 11, salaryMode: "known" }).length, 0);
  assert.equal(selectJobs([fixture({ salaryMinK: 20 })], { salaryMax: 19, salaryMode: "known" }).length, 0);
});

test("invalid salary input is surfaced instead of silently ignored", () => {
  assert.deepEqual(parseSalaryRange("", ""), { min: null, max: null, error: null });
  assert.deepEqual(parseSalaryRange(" 8.5 ", "20"), { min: 8.5, max: 20, error: null });
  assert.equal(parseSalaryRange("0", "0").error, null);
  for (const [minimum, maximum] of [["-1", ""], ["NaN", "20"], ["10", "9"], ["Infinity", ""]]) {
    assert.ok(parseSalaryRange(minimum, maximum).error);
  }
  for (const options of [{ salaryMin: -1 }, { salaryMin: 20, salaryMax: 10 }, { salaryMin: "10" }, { salaryMode: "invalid" }, { sortBy: "publishedAt" }]) {
    assert.throws(() => selectJobs([fixture()], options), RangeError);
  }
});

test("sorting is deterministic, non-mutating, and uses observation rather than publication", () => {
  const jobs = [
    fixture({ id: "low", matchScore: 10, firstSeen: "2026-09-07T10:00:00+08:00", publishedAt: "2026-01-01" }),
    fixture({ id: "high-old", matchScore: 90, firstSeen: "2026-09-07T08:00:00+08:00" }),
    fixture({ id: "high-new", matchScore: 90, firstSeen: "2026-09-07T09:00:00+08:00" }),
    fixture({ id: "unknown", matchScore: null, firstSeen: "2026-09-06T08:00:00+08:00", publishedAt: "2026-09-07" }),
  ];
  const before = structuredClone(jobs);
  assert.deepEqual(selectJobs(jobs).map((job) => job.id), ["high-new", "high-old", "low", "unknown"]);
  assert.deepEqual(selectJobs(jobs, { sortBy: "firstSeen" }).map((job) => job.id), ["low", "high-new", "high-old", "unknown"]);
  assert.deepEqual(jobs, before);
  assert.deepEqual(selectJobs([fixture({ id: "b" }), fixture({ id: "a" })]).map((job) => job.id), ["a", "b"]);
});
