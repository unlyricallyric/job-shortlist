import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SnapshotError, filterOptions, formatShanghaiTime, hasSalaryRange,
  isIsoDate, parseSalaryRange, safeJobUrl, selectJobs, validateSnapshot,
} from "../docs/model.mjs";
import { bytedanceFixture, fixture, liepinFixture, snapshotOf } from "./helpers/fixtures.mjs";

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

test("legacy and cumulative snapshot modes are explicit and remain schema version one", () => {
  for (const mode of ["单次采集", "累计精选 · 第二轮快照", "人工扩展复核 · 累计快照"]) {
    const data = snapshotOf([fixture()]);
    data.run.mode = mode;
    assert.equal(validateSnapshot(data), data);
    assert.equal(data.version, 1);
  }
});

test("a human expansion preserves per-job provenance without claiming automatic sampling coverage", () => {
  const data = snapshotOf([fixture()]);
  data.run.mode = "人工扩展复核 · 累计快照";
  data.assessmentMethods = { [data.jobs[0].id]: "human-assisted" };
  assert.equal(validateSnapshot(data), data);
  assert.equal(Object.hasOwn(data, "automation"), false);
  data.assessmentMethods[data.jobs[0].id] = "rules-v1";
  assert.equal(validateSnapshot(data), data, "Retained automatic assessments must not be relabeled manual.");
  data.assessmentMethods["boss-unrelated"] = "human-assisted";
  assert.throws(() => validateSnapshot(data), /初筛方式/);
});

test("a manual maintenance status is separate from original collection freshness and cannot claim resumed sampling", () => {
  const data = snapshotOf([fixture()]);
  data.run.mode = "人工维护 · 已保存快照";
  data.publication = { version: 1, type: "manual-maintenance", publishedAt: "2026-09-09T03:00:00Z", scheduler: "paused" };
  assert.equal(validateSnapshot(data), data);
  for (const changes of [{ scheduler: "enabled" }, { publishedAt: "2026-01-01T00:00:00Z" }, { reason: "TEST_ONLY_PRIVATE" }]) {
    assert.throws(() => validateSnapshot({ ...data, publication: { ...data.publication, ...changes } }), /发布状态/);
  }
  const missingStatus = { ...data };
  delete missingStatus.publication;
  assert.throws(() => validateSnapshot(missingStatus), /人工维护/);
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
    (data) => { data.run.mode = "自动采集"; },
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

test("ByteDance URLs require the exact official host, route and source without URL modifiers", () => {
  const { source, url } = bytedanceFixture();
  assert.equal(safeJobUrl(url, source), url);
  assert.equal(safeJobUrl(url), null);
  assert.equal(safeJobUrl(fixture().url, source), null);
  assert.equal(safeJobUrl(fixture().url, "BOSS直聘"), fixture().url);
  for (const invalid of [
    null, "", "javascript:alert(1)", url.replace("https:", "http:"),
    url.replace("jobs.bytedance.com", "jobs.bytedance.com.attacker.test"),
    url.replace("jobs.bytedance.com", "notjobs.bytedance.com"),
    url.replace("jobs.bytedance.com", "bytedance.com"),
    url.replace("jobs.bytedance.com", "jobs.bytedance.com@attacker.test"),
    url.replace("jobs.bytedance.com", "test-user@jobs.bytedance.com"),
    url.replace("jobs.bytedance.com", "jobs.bytedance.com:443"),
    url.replace("jobs.bytedance.com", "jobs.bytedance.com:8443"),
    url.replace("jobs.bytedance.com", "JOBS.BYTEDANCE.COM"),
    url.replace("experienced", "campus"),
    url.replace("9007199254740993", "not-a-numeric-id"),
    url.replace("9007199254740993", "%39" + "007199254740993"),
    url.replace("/detail", "/extra/../detail"),
    `${url}/`, `${url}?source=test`, `${url}?`, `${url}#test`, `${url}#`,
    `${url}\n`, ` ${url}`, url.replace("/experienced", "\\experienced"),
  ]) assert.equal(safeJobUrl(invalid, source), null, String(invalid));
  for (const unsupported of ["猎聘", "招聘官网", "BOSS直聘 + 字节跳动招聘官网", null]) {
    assert.equal(safeJobUrl(url, unsupported), null);
    assert.equal(safeJobUrl(fixture().url, unsupported), null);
  }
});

test("official and mixed snapshots preserve numeric-string IDs and optional salary", () => {
  const official = bytedanceFixture();
  const data = snapshotOf([official], "字节跳动招聘官网");
  assert.equal(validateSnapshot(data), data);
  assert.equal(data.jobs[0].id, "bytedance-9007199254740993");
  assert.equal(data.jobs[0].salaryText, null);
  assert.equal(data.jobs[0].salaryMinK, null);
  assert.equal(data.jobs[0].salaryMaxK, null);
  assert.equal(data.jobs[0].salaryMonths, null);
  assert.equal(selectJobs(data.jobs).length, 1);
  const mixed = snapshotOf([fixture({ isNew: false }), official], "BOSS直聘 + 字节跳动招聘官网");
  mixed.run.cardsReviewed = 80;
  mixed.run.detailsRead = 20;
  assert.equal(validateSnapshot(mixed), mixed);
  assert.equal(mixed.run.selectedCount, 2);
  assert.equal(mixed.run.newCount, 1);
});

test("source, namespace and exact route IDs must agree and no other sources are accepted", () => {
  const mutations = [
    (data) => { data.jobs[0].id = "boss-9007199254740993"; },
    (data) => { data.jobs[0].id = "bytedance-not-numeric"; },
    (data) => { data.jobs[0].id = "bytedance-123e4"; },
    (data) => { data.jobs[0].id = "bytedance-9007199254740992"; },
    (data) => { data.jobs[0].id = 123; },
    (data) => { data.jobs[0].url = fixture().url; },
    (data) => { data.jobs[0].source = "BOSS直聘"; },
    (data) => { data.jobs[0].source = "猎聘"; },
    (data) => { data.jobs[0].source = "招聘官网"; },
    (data) => { data.jobs[0].url += "?from=test"; },
    (data) => { data.jobs[0].url += "#detail"; },
    (data) => { data.run.source = "BOSS直聘"; },
    (data) => { data.run.source = "BOSS直聘 + 猎聘"; },
  ];
  for (const mutate of mutations) {
    const data = snapshotOf([bytedanceFixture()], "字节跳动招聘官网");
    mutate(data);
    assert.throws(() => validateSnapshot(data), SnapshotError, mutate.toString());
  }
  const wrongBossUrl = snapshotOf([fixture({ url: bytedanceFixture().url })]);
  assert.throws(() => validateSnapshot(wrongBossUrl), /原始岗位链接/);
  const wrongBossId = snapshotOf([fixture({ id: bytedanceFixture().id })]);
  assert.throws(() => validateSnapshot(wrongBossId), /标识/);
  const wrongRunSource = snapshotOf([fixture()], "字节跳动招聘官网");
  assert.throws(() => validateSnapshot(wrongRunSource), /来源/);
  const unsupportedMixedJob = snapshotOf([bytedanceFixture({ source: "猎聘" })], "BOSS直聘 + 字节跳动招聘官网");
  assert.throws(() => validateSnapshot(unsupportedMixedJob), /来源/);
  const duplicates = snapshotOf([bytedanceFixture(), bytedanceFixture()], "字节跳动招聘官网");
  assert.throws(() => validateSnapshot(duplicates), /重复/);
});

test("Liepin accepts only its explicit HTTPS host and numeric job route", () => {
  const { source, url } = liepinFixture();
  assert.equal(safeJobUrl(url, source), url);
  assert.equal(safeJobUrl(url), null);
  for (const invalid of [
    null, "", "javascript:alert(1)", url.replace("https:", "http:"),
    url.replace("www.liepin.com", "liepin.com"),
    url.replace("www.liepin.com", "m.liepin.com"),
    url.replace("www.liepin.com", "www.liepin.com.attacker.test"),
    url.replace("www.liepin.com", "notliepin.com"),
    url.replace("www.liepin.com", "www.liepin.com@attacker.test"),
    url.replace("www.liepin.com", "test-user@www.liepin.com"),
    url.replace("www.liepin.com", "www.liepin.com:443"),
    url.replace("www.liepin.com", "www.liepin.com:8443"),
    url.replace("www.liepin.com", "WWW.LIEPIN.COM"),
    url.replace("/job/", "/jobs/"),
    url.replace("/job/", "/extra/../job/"),
    url.replace("9007199254740995", "not-numeric"),
    url.replace("9007199254740995", "%39" + "007199254740995"),
    url.replace(".shtml", ".html"),
    `${url}/`, `${url}?source=test`, `${url}?`, `${url}#test`, `${url}#`,
    `${url}\n`, ` ${url}`, url.replace("/job/", "\\job\\"),
    fixture().url, bytedanceFixture().url,
  ]) assert.equal(safeJobUrl(invalid, source), null, String(invalid));
  for (const unsupported of ["BOSS直聘", "字节跳动招聘官网", "招聘官网", "BOSS直聘 + 字节跳动招聘官网 + 猎聘", null]) {
    assert.equal(safeJobUrl(url, unsupported), null);
  }
});

test("Liepin snapshots enforce source namespace and exact IDs in single and mixed releases", () => {
  const official = bytedanceFixture();
  const listing = liepinFixture();
  const single = snapshotOf([listing], "猎聘");
  assert.equal(validateSnapshot(single), single);
  assert.equal(single.jobs[0].id, "liepin-9007199254740995");
  const tripleSource = "BOSS直聘 + 字节跳动招聘官网 + 猎聘";
  const mixed = snapshotOf([fixture({ isNew: false }), official, listing], tripleSource);
  mixed.run.cardsReviewed = 100;
  mixed.run.detailsRead = 30;
  assert.equal(validateSnapshot(mixed), mixed);
  assert.equal(mixed.run.selectedCount, 3);
  assert.equal(mixed.run.newCount, 2);
  const mutations = [
    (data) => { data.jobs[0].id = "boss-9007199254740995"; },
    (data) => { data.jobs[0].id = "bytedance-9007199254740995"; },
    (data) => { data.jobs[0].id = "liepin-nonnumeric"; },
    (data) => { data.jobs[0].id = "liepin-123e4"; },
    (data) => { data.jobs[0].id = "liepin-9007199254740994"; },
    (data) => { data.jobs[0].id = 123; },
    (data) => { data.jobs[0].source = "BOSS直聘"; },
    (data) => { data.jobs[0].source = "字节跳动招聘官网"; },
    (data) => { data.jobs[0].source = "其他招聘站"; },
    (data) => { data.jobs[0].url = fixture().url; },
    (data) => { data.jobs[0].url = official.url; },
    (data) => { data.jobs[0].url += "?from=test"; },
    (data) => { data.jobs[0].url += "#detail"; },
    (data) => { data.run.source = "BOSS直聘 + 字节跳动招聘官网"; },
    (data) => { data.run.source = `${tripleSource} + 其他招聘站`; },
  ];
  for (const mutate of mutations) {
    const data = snapshotOf([liepinFixture()], tripleSource);
    mutate(data);
    assert.throws(() => validateSnapshot(data), SnapshotError, mutate.toString());
  }
  for (const other of [fixture(), official]) {
    assert.throws(() => validateSnapshot(snapshotOf([{ ...other, url: listing.url }], tripleSource)), /原始岗位链接/);
    assert.throws(() => validateSnapshot(snapshotOf([{ ...other, id: listing.id }], tripleSource)), /标识/);
  }
  for (const sourceJob of [fixture(), official, listing]) {
    for (const suffix of ["\n", "\r", "\u2028", " "]) {
      assert.throws(() => validateSnapshot(snapshotOf([{ ...sourceJob, id: sourceJob.id + suffix }], tripleSource)), /标识/);
    }
  }
  assert.throws(() => validateSnapshot(snapshotOf([listing, listing], "猎聘")), /重复/);
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

test("role aliases find generic original titles by the reviewed direction", () => {
  const directions = [
    ["区域市场", ["Field Marketing", "Regional Marketing"]],
    ["伙伴营销", ["Partner Marketing", "Channel Marketing", "渠道市场", "生态市场"]],
    ["需求生成", ["Demand Generation", "Demand Gen", "Pipeline Marketing"]],
    ["伙伴发展", ["Partner Development", "PDR"]],
    ["生态商业化", ["Ecosystem"]],
    ["销售开发", ["Sales Development", "BDR", "SDR"]],
    ["销售运营", ["Sales Operations", "RevOps"]],
    ["客户成功", ["Customer Success", "CSM"]],
    ["产品市场", ["产品营销", "Product Marketing", "PMM"]],
    ["品牌活动", ["品牌活动", "活动营销", "活动策划", "Event Marketing"]],
    ["内容营销", ["内容营销", "内容市场", "Content Marketing"]],
    ["渠道销售", ["Channel Sales"]],
    ["大客户销售", ["Account Executive", "Key Account", "AE"]],
  ];
  const jobs = directions.map(([category], index) => fixture({
    id: `direction-${index}`, title: "业务经理", category,
  }));
  const before = structuredClone(jobs);
  for (const [category, aliases] of directions) {
    for (const keyword of aliases) {
      assert.deepEqual(selectJobs(jobs, { keyword }).map((job) => job.category), [category], keyword);
    }
  }
  assert.deepEqual(jobs, before);
});

test("alias phrases handle English case and whitespace while additional keywords remain required", () => {
  const jobs = [
    fixture({ id: "shanghai", title: "市场经理", company: "Acme", category: "区域市场", summary: ["行业活动与商机培育"] }),
    fixture({ id: "other-city", title: "市场经理", company: "Acme", category: "区域市场", city: "深圳" }),
    fixture({ id: "other-company", title: "市场经理", company: "TEST_ONLY_COMPANY", category: "区域市场" }),
  ];
  const keyword = " \tＦｉＥＬＤ \n Ｍａｒｋｅｔｉｎｇ \t 上海  ＡＣＭＥ  活动 ";
  assert.deepEqual(selectJobs(jobs, { keyword }).map((job) => job.id), ["shanghai"]);
  assert.equal(selectJobs(jobs, { keyword: "Regional  Marketing 未提供的职责" }).length, 0);
  assert.equal(selectJobs(jobs, { keyword: "fieldmarketing" }).length, 0);
  assert.equal(selectJobs(jobs, { keyword: "ield Marketing" }).length, 0);
});

test("short English aliases use word boundaries and never match embedded name fragments", () => {
  for (const [abbreviation, category] of [
    ["AE", "大客户销售"], ["PDR", "伙伴发展"], ["BDR", "销售开发"],
    ["SDR", "销售开发"], ["CSM", "客户成功"], ["RevOps", "销售运营"], ["PMM", "产品市场"],
  ]) {
    const jobs = [
      fixture({ id: "assigned", title: "业务经理", category }),
      fixture({ id: "visible", title: `业务（${abbreviation}）`, category: null }),
      fixture({ id: "embedded", title: `x${abbreviation}y ${abbreviation}_team ${abbreviation}2 café${abbreviation}`, category: null }),
    ];
    assert.deepEqual(selectJobs(jobs, { keyword: ` ${abbreviation.toLowerCase()} ` }).map((job) => job.id),
      ["assigned", "visible"], abbreviation);
    assert.deepEqual(selectJobs(jobs, { keyword: `x${abbreviation}y` }).map((job) => job.id),
      ["embedded"], "A longer literal term must not activate the abbreviation's category.");
  }
  assert.equal(selectJobs([fixture({ title: "Caesar", company: "Maersk", category: null })], { keyword: "AE" }).length, 0);
  assert.equal(selectJobs([fixture({ title: "业务经理", category: "客户成功" })], { keyword: "SM" }).length, 0);
});

test("product marketing aliases are optional aids to the assigned category, not a title classifier", () => {
  const jobs = [
    fixture({ id: "assigned", title: "业务经理", category: "产品市场" }),
    fixture({ id: "title-only", title: "Product Marketing", category: "销售运营" }),
  ];
  for (const keyword of ["产品营销", "  pMm  "]) {
    assert.deepEqual(selectJobs(jobs, { keyword }).map((job) => job.id), ["assigned"]);
  }
  assert.deepEqual(selectJobs(jobs, { keyword: "  PrOdUcT \t Marketing  " }).map((job) => job.id), ["assigned", "title-only"]);
  assert.equal(selectJobs([jobs[1]], { keyword: "产品营销", category: "产品市场" }).length, 0);
  assert.equal(jobs[1].category, "销售运营");
});

test("brand event aliases find reviewed categories without inferring partner or demand duties", () => {
  const jobs = [
    fixture({ id: "assigned", title: "业务经理", category: "品牌活动" }),
    fixture({ id: "title-only", title: "Event Marketing", category: "销售运营" }),
    fixture({ id: "unclassified", title: "活动策划", category: null }),
  ];
  const before = structuredClone(jobs);
  assert.deepEqual(selectJobs(jobs, { keyword: "品牌活动" }).map((job) => job.id), ["assigned"]);
  assert.deepEqual(selectJobs(jobs, { keyword: "活动营销" }).map((job) => job.id), ["assigned"]);
  assert.deepEqual(selectJobs(jobs, { keyword: "活动策划" }).map((job) => job.id), ["assigned", "unclassified"]);
  assert.deepEqual(selectJobs(jobs, { keyword: "  eVeNt \t MARKETING " }).map((job) => job.id), ["assigned", "title-only"]);
  assert.equal(selectJobs(jobs, { keyword: "Partner Marketing" }).length, 0);
  assert.equal(selectJobs(jobs, { keyword: "Demand Generation" }).length, 0);
  assert.equal(selectJobs([jobs[1]], { category: "品牌活动" }).length, 0);
  assert.deepEqual(jobs, before);
});

test("titles and literal duties remain searchable without being used to classify jobs", () => {
  const jobs = [
    fixture({ id: "title", title: "Field Marketing", category: "销售运营" }),
    fixture({ id: "summary", title: "业务经理", category: null, summary: ["Partner Marketing collaboration"] }),
    fixture({ id: "requirements", title: "业务经理", category: null, requirements: ["Customer Success experience"] }),
    fixture({ id: "reasons", title: "业务经理", category: null, matchReasons: ["Demand Generation responsibilities"] }),
  ];
  const before = structuredClone(jobs);
  for (const [keyword, id] of [
    ["Field Marketing", "title"], ["Partner Marketing", "summary"],
    ["Customer Success", "requirements"], ["Demand Generation", "reasons"],
  ]) assert.deepEqual(selectJobs(jobs, { keyword }).map((job) => job.id), [id]);
  assert.equal(selectJobs(jobs, { keyword: "Regional Marketing" }).length, 0);
  assert.equal(selectJobs(jobs, { keyword: "Field Marketing", category: "区域市场" }).length, 0);
  assert.deepEqual(filterOptions(jobs, "category").map(([name]) => name).sort(), ["待确认", "销售运营"].sort());
  assert.deepEqual(jobs, before);
});

test("keyword search excludes identifiers, URLs, timestamps and unstructured metadata", () => {
  const jobs = [fixture({
    id: "boss-hidden-identifier", title: "业务经理", category: null,
    url: "https://www.zhipin.com/job_detail/private-metadata.html",
    extraMetadata: "Field Marketing PDR",
  })];
  for (const keyword of ["hidden-identifier", "private-metadata", "2026-09-07", "Field Marketing", "PDR"]) {
    assert.equal(selectJobs(jobs, { keyword }).length, 0, keyword);
  }
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

test("transition priorities are accepted, filterable and explicitly sortable without hiding any jobs", () => {
  assert.doesNotThrow(() => validateSnapshot(snapshotOf([fixture({ priority: "转型备选" })])));
  const jobs = [
    fixture({ id: "unknown", priority: null, matchScore: 100 }),
    fixture({ id: "transition", priority: "转型备选", matchScore: 90 }),
    fixture({ id: "conditional", priority: "有条件匹配", matchScore: 50 }),
    fixture({ id: "first", priority: "优先了解", matchScore: 0 }),
    fixture({ id: "transition-low", priority: "转型备选", matchScore: 40 }),
  ];
  const before = structuredClone(jobs);
  assert.deepEqual(selectJobs(jobs).map((job) => job.id),
    ["unknown", "transition", "conditional", "transition-low", "first"]);
  assert.deepEqual(selectJobs(jobs, { sortBy: "priority" }).map((job) => job.id),
    ["first", "conditional", "transition", "transition-low", "unknown"]);
  assert.deepEqual(selectJobs(jobs, { priority: "转型备选" }).map((job) => job.id), ["transition", "transition-low"]);
  assert.deepEqual(filterOptions(jobs, "priority"), [
    ["优先了解", 1], ["有条件匹配", 1], ["转型备选", 2], ["待确认", 1],
  ]);
  assert.deepEqual(jobs, before);
});

test("cumulative unique review counts may exceed current selections and new means the explicit flag", () => {
  const jobs = [
    fixture({
      id: "boss-unit-test-old", url: "https://www.zhipin.com/job_detail/unit-test-old.html",
      firstSeen: "2026-09-06T08:00:00+08:00", isNew: false,
    }),
    fixture({
      id: "boss-unit-test-added", url: "https://www.zhipin.com/job_detail/unit-test-added.html",
      firstSeen: "2026-09-05T08:00:00+08:00", isNew: true,
    }),
  ];
  const data = snapshotOf(jobs);
  data.run.cardsReviewed = 123;
  data.run.detailsRead = 45;
  const before = structuredClone(data);
  assert.equal(validateSnapshot(data), data);
  assert.equal(data.run.selectedCount, 2);
  assert.equal(data.run.newCount, 1);
  assert.deepEqual(selectJobs(jobs, { newOnly: true }).map((job) => job.id), ["boss-unit-test-added"]);
  assert.deepEqual(data, before);
  assert.throws(() => validateSnapshot({ ...data, run: { ...data.run, newCount: 2 } }), /本轮新增/);
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

test("raw salary and months never imply comparable monthly bounds or a salary threshold", () => {
  const listing = liepinFixture({ salaryText: "20-40k·15薪", salaryMonths: 15 });
  const data = snapshotOf([listing], "猎聘");
  const before = structuredClone(data);
  assert.equal(validateSnapshot(data), data);
  assert.equal(hasSalaryRange(listing), false);
  assert.equal(listing.salaryMinK, null);
  assert.equal(listing.salaryMaxK, null);
  for (const options of [
    {}, { salaryMin: 100 }, { salaryMax: 0 }, { salaryMin: 50, salaryMax: 60 },
    { salaryMode: "unknown" }, { salaryMin: 100, salaryMode: "unknown" },
  ]) {
    assert.deepEqual(selectJobs(data.jobs, options), [listing], JSON.stringify(options));
  }
  assert.deepEqual(selectJobs(data.jobs, { salaryMode: "known" }), []);
  assert.deepEqual(selectJobs(data.jobs, { salaryMin: 20, salaryMax: 40, salaryMode: "known" }), []);
  assert.equal(listing.salaryText, "20-40k·15薪");
  assert.equal(listing.salaryMonths, 15);
  assert.deepEqual(data, before);
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
