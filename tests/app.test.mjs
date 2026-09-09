import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatShanghaiTime, groupJobsByFirstSeen } from "../docs/model.mjs";
import { bytedanceFixture, fixture, liepinFixture, snapshotOf } from "./helpers/fixtures.mjs";
import { OptionDouble, pageDocument } from "./helpers/dom.mjs";

const html = await readFile(new URL("../docs/index.html", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));
let importNumber = 0;
const job = (name, overrides) => fixture({
  id: `boss-unit-test-${name}`,
  url: `https://www.zhipin.com/job_detail/unit-test-${name}.html`,
  ...overrides,
});
const testJobs = [
  job("literal", {
    title: '<img src="x" onerror="alert(1)">', summary: ["<script>TEST_ONLY_TEXT</script>"],
    matchScore: 90, firstSeen: "2026-09-07T07:00:00+08:00", category: "商务拓展",
  }),
  job("known", {
    title: "TEST_ONLY_SaaS", salaryText: "20-30K", salaryMinK: 20, salaryMaxK: 30,
    firstSeen: "2026-09-07T09:00:00+08:00", matchScore: 60, isNew: false,
  }),
  job("lower", {
    title: "TEST_ONLY_CRM", salaryText: "10-15K", salaryMinK: 10, salaryMaxK: 15,
    matchScore: 30, priority: "进一步确认",
  }),
];

function scheduledSnapshot(jobs, {
  generatedAt = "2026-09-07T10:45:00+08:00", startedAt = generatedAt,
  enabled = true, rules = [],
} = {}) {
  const data = snapshotOf(jobs, "BOSS直聘 + 字节跳动招聘官网 + 猎聘");
  data.generatedAt = generatedAt;
  data.run.mode = "定时规则初筛 · 累计快照";
  data.run.cardsReviewed = 123;
  data.run.detailsRead = 45;
  data.automation = {
    version: 1, enabled, timeZone: "Asia/Shanghai", times: ["09:30", "12:30"],
    runId: "test-scheduled-run-001", startedAt, completedAt: generatedAt, status: "sampled",
    freshSources: ["BOSS直聘"], retainedSources: ["字节跳动招聘官网", "猎聘"],
    reviewedThisRun: 17, detailsThisRun: 5,
  };
  data.assessmentMethods = Object.fromEntries(jobs.map(({ id }) => [id, rules.includes(id) ? "rules-v1" : "human-assisted"]));
  return data;
}

async function boot(t, { responses = [snapshotOf(testJobs)], mobile = false, now = "2026-09-07T12:00:00+08:00" } = {}) {
  const document = pageDocument(html);
  document.visibilityState = "visible";
  const originals = new Map(["document", "window", "Option", "fetch"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  globalThis.document = document;
  const timers = new Map();
  let timerId = 0;
  globalThis.window = Object.assign(new EventTarget(), {
    matchMedia: () => ({ matches: mobile }),
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  globalThis.Option = OptionDouble;
  let clock = Date.parse(now);
  t.mock.method(Date, "now", () => clock);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    assert.ok(responses.length, "Unexpected additional data request");
    const response = await responses.shift();
    if (response instanceof Error) throw response;
    if (response?.customResponse) return response.customResponse;
    return { ok: true, json: async () => response };
  };
  const errors = t.mock.method(console, "error", () => {});
  await import(new URL(`../docs/app.mjs?test=${++importNumber}`, import.meta.url));
  await settle();
  const get = (id) => document.getElementById(id);
  return {
    get, requests, errors, timers, document,
    setNow: (value) => { clock = Date.parse(value); },
    visibility: (value) => { document.visibilityState = value; document.dispatchEvent(new Event("visibilitychange")); },
    fireTimer: () => {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
    },
    groups: () => get("job-list").children,
    cards: () => [...get("job-list").descendants()].filter((node) => node.tagName === "ARTICLE"),
    change: (id, value) => {
      const node = get(id);
      if (typeof value === "boolean") node.checked = value;
      else node.value = value;
      if (node.getAttribute("type") === "radio" && node.checked) {
        for (const input of get("date-view-controls").descendants()) {
          if (input.tagName === "INPUT" && input !== node) input.checked = false;
        }
      }
      (id === "sort-by" ? node : node.getAttribute("type") === "radio" ? get("date-view-controls") : get("filter-form"))
        .dispatchEvent(new Event("change"));
    },
    click: (id) => get(id).dispatchEvent(new Event("click")),
  };
}

test("the app shows loading, then a truthful empty state and Shanghai snapshot time", async (t) => {
  let finish;
  const response = new Promise((resolve) => { finish = resolve; });
  const app = await boot(t, { responses: [response], mobile: true });
  assert.equal(app.get("results-area").getAttribute("aria-busy"), "true");
  assert.equal(app.get("filter-controls").disabled, true);
  assert.equal(app.get("filters-panel").open, false);
  assert.equal(app.get("automation-panel").hidden, true);
  assert.equal(app.get("automation-warning").hidden, true);
  assert.equal(app.get("snapshot-label").textContent, "只读 · 岗位快照");
  finish(snapshotOf([]));
  await settle();
  assert.equal(app.get("total-count").textContent, "00");
  assert.equal(app.get("generated-at").textContent, "2026.09.07 12:00");
  assert.equal(app.get("filter-controls").disabled, false);
  assert.equal(app.get("results-area").getAttribute("aria-busy"), "false");
  assert.match(app.get("state-title").textContent, /尚未收录/);
  assert.equal(app.cards().length, 0);
  assert.equal(app.get("state-action").hidden, true);
});

test("default today uses browser Shanghai date, offers explicit recent/all navigation and preserves the snapshot", async (t) => {
  const data = scheduledSnapshot(testJobs, { generatedAt: "2026-09-07T16:21:15Z" });
  const before = structuredClone(data);
  const app = await boot(t, { responses: [data], now: "2026-09-07T16:38:44Z", mobile: true });
  assert.equal(app.get("view-today").checked, true);
  assert.equal(app.get("view-week").checked, false);
  assert.equal(app.get("view-all").checked, false);
  assert.equal(app.get("date-view-controls").disabled, false);
  assert.equal(app.get("view-today-count").textContent, "0");
  assert.equal(app.get("view-week-count").textContent, "3");
  assert.equal(app.get("view-all-count").textContent, "3");
  assert.equal(app.get("arrival-date").textContent, "2026.09.08");
  assert.equal(app.get("state-title").textContent, "今日暂无新增");
  assert.equal(app.get("state-action").textContent, "查看近7天");
  assert.equal(app.get("state-all-action").hidden, false);
  assert.match(app.get("state-context").textContent, /最近快照：2026\.09\.08 00:21/);
  assert.match(app.get("state-context").textContent, /本轮采样 17 条记录、5 份完整 JD/);
  assert.equal(app.cards().length, 0);
  app.click("state-action");
  assert.equal(app.get("view-week").checked, true);
  assert.equal(app.get("view-today").checked, false);
  assert.equal(app.cards().length, 3);
  assert.equal(app.groups().length, 1);
  assert.equal(app.groups()[0].querySelector("h3").textContent, "昨天 · 09月07日");
  assert.equal(app.groups()[0].querySelector("p").textContent, "3 个匹配岗位");
  assert.equal(new Set(app.cards().map((card) => card.querySelector('[data-field="link"]').href)).size, 3);
  app.click("reset-filters");
  assert.equal(app.get("view-today").checked, true);
  assert.equal(app.get("state-title").textContent, "今日暂无新增");
  app.click("state-all-action");
  assert.equal(app.get("view-all").checked, true);
  assert.equal(app.cards().length, 3);
  assert.equal(app.requests.length, 1);
  assert.deepEqual(data, before);
});

test("five today arrivals remain after noon while the secondary new-only filter selects only two", async (t) => {
  const morning = [1, 2, 3].map((id) => job(`morning-${id}`, {
    firstSeen: "2026-09-08T09:30:00+08:00", lastSeen: "2026-09-08T09:30:00+08:00", isNew: false,
  }));
  const noon = [1, 2].map((id) => job(`noon-${id}`, {
    firstSeen: "2026-09-08T12:30:00+08:00", lastSeen: "2026-09-08T12:30:00+08:00", isNew: true,
  }));
  const old = job("older", { isNew: false, matchScore: 100 });
  const data = snapshotOf([...morning, ...noon, old]);
  data.generatedAt = "2026-09-08T12:45:00+08:00";
  const app = await boot(t, { responses: [data], now: "2026-09-08T13:00:00+08:00" });
  assert.equal(app.cards().length, 5);
  assert.equal(app.get("view-today-count").textContent, "5");
  assert.equal(app.get("new-count").textContent, "2");
  assert.equal(app.get("total-count").textContent, "06");
  app.change("new-only", true);
  assert.equal(app.cards().length, 2);
  assert.equal(app.get("view-today-count").textContent, "5");
  assert.equal(app.get("result-count").textContent, "筛选结果 2 / 本视图 5 个");
  app.change("keyword", "definitely-no-match");
  assert.equal(app.cards().length, 0);
  assert.equal(app.get("state-title").textContent, "当前视图没有符合筛选条件的岗位");
  app.click("reset-filters");
  assert.equal(app.get("view-today").checked, true);
  assert.equal(app.get("keyword").value, "");
  assert.equal(app.get("new-only").checked, false);
  assert.equal(app.cards().length, 5);
  app.change("view-all", true);
  assert.equal(app.cards().length, 6);
  assert.equal(app.groups().length, 2);
  assert.equal(app.cards().at(-1).querySelector('[data-field="title"]').id, "job-title-5");
  assert.equal(app.cards().at(-1).querySelector('[data-field="link"]').href, old.url, "Chronology outranks global score.");
});

test("future firstSeen timestamps are excluded from today and recent without removing them from all", async (t) => {
  const jobs = [
    job("current", { firstSeen: "2026-09-08T10:00:00+08:00", lastSeen: "2026-09-08T10:00:00+08:00" }),
    job("future-hour", { firstSeen: "2026-09-08T13:00:00+08:00", lastSeen: "2026-09-08T13:00:00+08:00" }),
    job("future-day", { firstSeen: "2026-09-09T00:00:00+08:00", lastSeen: "2026-09-09T00:00:00+08:00" }),
  ];
  const data = snapshotOf(jobs);
  data.generatedAt = "2026-09-09T01:00:00+08:00";
  const app = await boot(t, { responses: [data], now: "2026-09-08T12:00:00+08:00" });
  assert.equal(app.get("view-today-count").textContent, "1");
  assert.equal(app.get("view-week-count").textContent, "1");
  assert.equal(app.get("view-all-count").textContent, "3");
  assert.equal(app.cards()[0].querySelector('[data-field="link"]').href, jobs[0].url);
  app.change("view-week", true);
  assert.equal(app.cards().length, 1);
  app.change("view-all", true);
  assert.equal(app.cards().length, 3);
  assert.equal(app.groups()[0].querySelector("h3").textContent, "2026年09月09日");
});

test("recent date-empty state differs from an empty dataset and links explicitly to all", async (t) => {
  const app = await boot(t, { responses: [snapshotOf(testJobs)], now: "2026-09-20T04:00:00Z" });
  app.click("state-action");
  assert.equal(app.get("view-week").checked, true);
  assert.equal(app.get("state-title").textContent, "近7天暂无新增");
  assert.equal(app.get("state-action").textContent, "查看全部岗位");
  app.click("state-action");
  assert.equal(app.get("view-all").checked, true);
  assert.equal(app.cards().length, 3);
  assert.equal(app.groups()[0].querySelector("h3").textContent, "2026年09月07日");
});

test("midnight timer recalculates today without fetching, clearing filters or moving focus", async (t) => {
  const app = await boot(t, { now: "2026-09-07T15:59:59Z" });
  app.change("keyword", "TEST_ONLY");
  app.get("keyword").focus();
  assert.equal(app.cards().length, 3);
  assert.equal(app.timers.size, 1);
  assert.equal([...app.timers.values()][0].delay, 1050);
  app.setNow("2026-09-07T16:00:00.050Z");
  app.fireTimer();
  assert.equal(app.get("view-today").checked, true);
  assert.equal(app.get("state-title").textContent, "今日暂无新增");
  assert.equal(app.cards().length, 0);
  assert.equal(app.get("keyword").value, "TEST_ONLY");
  assert.equal(app.document.activeElement, app.get("keyword"));
  assert.equal(app.get("arrival-date").textContent, "2026.09.08");
  assert.equal(app.requests.length, 1);
  assert.equal(app.timers.size, 1);
  assert.ok([...app.timers.values()][0].delay > 23 * 3600000);
});

test("visibility return updates a chosen recent view and relative headings without re-rendering on same-day returns", async (t) => {
  const app = await boot(t, { now: "2026-09-07T15:59:59Z" });
  app.change("view-week", true);
  app.change("priority", "优先了解");
  app.get("priority").focus();
  const group = app.groups()[0];
  assert.equal(group.querySelector("h3").textContent, "今天 · 09月07日");
  app.visibility("hidden");
  app.visibility("visible");
  assert.equal(app.groups()[0], group, "Same-day visibility events must not rebuild results.");
  app.visibility("hidden");
  const sourceLink = app.cards()[0].querySelector('[data-field="link"]');
  sourceLink.focus();
  const details = app.cards()[0].querySelector("details");
  details.open = true;
  app.setNow("2026-09-07T16:00:00Z");
  app.visibility("visible");
  assert.equal(app.get("view-week").checked, true);
  assert.equal(app.get("priority").value, "优先了解");
  assert.equal(app.groups()[0].querySelector("h3").textContent, "昨天 · 09月07日");
  assert.equal(app.groups()[0].querySelector("p").textContent, "2 个匹配岗位");
  assert.equal(app.document.activeElement, sourceLink);
  assert.equal(app.groups()[0], group, "Same records keep their DOM nodes across midnight.");
  assert.equal(details.open, true);
  assert.equal(app.requests.length, 1);
  assert.equal(app.timers.size, 1);
});

test("the recent window drops day seven after midnight without changing the selected view", async (t) => {
  const old = job("boundary", { firstSeen: "2026-09-01T00:00:00+08:00", isNew: false });
  const app = await boot(t, { responses: [snapshotOf([old, ...testJobs])], now: "2026-09-07T15:59:59Z" });
  app.change("view-week", true);
  assert.equal(app.cards().length, 4);
  app.setNow("2026-09-07T16:00:00Z");
  app.visibility("visible");
  assert.equal(app.get("view-week").checked, true);
  assert.equal(app.cards().length, 3);
  assert.equal(app.get("view-week-count").textContent, "3");
  assert.equal(app.get("view-all-count").textContent, "4");
  assert.equal(app.requests.length, 1);
});

test("the public snapshot renders all source records and counts without changing observations", async (t) => {
  const data = JSON.parse(await readFile(new URL("../docs/data/jobs.json", import.meta.url), "utf8"));
  const before = structuredClone(data);
  const app = await boot(t, { responses: [data] });
  app.change("view-all", true);
  assert.equal(app.cards().length, data.jobs.length);
  assert.equal(app.get("new-count").textContent, String(data.run.newCount));
  assert.equal(app.get("reviewed-count").textContent, String(data.run.cardsReviewed));
  assert.equal(app.get("details-count").textContent, String(data.run.detailsRead));
  assert.equal(app.get("run-source").textContent, `${data.run.source} · ${data.run.mode}`);
  assert.equal(app.get("generated-at").textContent, formatShanghaiTime(data.generatedAt));
  assert.equal(app.get("automation-panel").hidden, !data.automation);
  assert.equal(app.get("snapshot-label").textContent, data.automation ? "只读 · 定时采样快照" : "只读 · 人工辅助快照");
  if (!data.automation) {
    assert.equal(app.get("automation-warning").hidden, true);
    assert.equal(app.get("schedule-times").textContent, "");
    assert.match(app.get("assessment-description").textContent, /人工辅助的启发式初筛/);
    assert.doesNotMatch(app.get("category-help").textContent, /固定规则/);
  }
  for (const [index, job] of groupJobsByFirstSeen(data.jobs).flatMap((group) => group.jobs).entries()) {
    const field = (name) => app.cards()[index].querySelector(`[data-field="${name}"]`);
    const rulesBased = data.assessmentMethods?.[job.id] === "rules-v1";
    assert.equal(field("title").textContent, job.title ?? "岗位名称无法获取");
    assert.equal(field("source").textContent, `来源 · ${job.source}`);
    assert.equal(field("link").href, job.url);
    assert.equal(field("salary").textContent, job.salaryText ?? "薪资无法获取");
    assert.equal(field("first-seen").getAttribute("datetime"), job.firstSeen);
    assert.equal(field("last-seen").getAttribute("datetime"), job.lastSeen);
    assert.equal(field("new").hidden, !job.isNew);
    assert.equal(field("assessment").textContent, rulesBased ? "规则初筛 · rules-v1" : "人工辅助初筛");
    assert.equal(field("assessment-note").hidden, !rulesBased);
    assert.equal(field("source-retention").hidden, !data.automation?.retainedSources.includes(job.source));
  }
  app.change("new-only", true);
  assert.equal(app.cards().length, data.jobs.filter((job) => job.isNew).length);
  app.click("reset-filters");
  assert.equal(app.get("view-today").checked, true);
  app.change("view-all", true);
  assert.equal(app.cards().length, data.jobs.length);
  assert.deepEqual(data, before);
});

test("legacy single and cumulative snapshots never advertise an active schedule", async (t) => {
  for (const mode of ["单次采集", "累计精选 · 第二轮快照"]) {
    await t.test(mode, async (subtest) => {
      const data = snapshotOf(testJobs);
      data.run.mode = mode;
      const app = await boot(subtest, { responses: [data], now: "2027-01-01T20:00:00+08:00" });
      app.change("view-all", true);
      assert.equal(app.get("automation-panel").hidden, true);
      assert.equal(app.get("automation-warning").hidden, true);
      assert.equal(app.get("schedule-times").textContent, "");
      assert.equal(app.get("run-reviewed-count").textContent, "—");
      assert.equal(app.get("snapshot-label").textContent, "只读 · 人工辅助快照");
      assert.match(app.get("assessment-description").textContent, /人工辅助的启发式初筛/);
      for (const card of app.cards()) {
        assert.equal(card.querySelector('[data-field="assessment"]').textContent, "人工辅助初筛");
        assert.equal(card.querySelector('[data-field="assessment-note"]').hidden, true);
      }
    });
  }
});

test("scheduled snapshots separate sampled counts, retained sources and each job's assessment method", async (t) => {
  const manual = job("observed-again", {
    matchScore: 95, isNew: false, firstSeen: "2026-09-06T08:00:00+08:00",
    lastSeen: "2026-09-07T10:40:00+08:00",
  });
  const automated = job("rules", {
    title: "TEST_ONLY_需求生成", category: "需求生成", matchScore: 80,
    firstSeen: "2026-09-07T10:35:00+08:00", lastSeen: "2026-09-07T10:35:00+08:00",
  });
  const official = bytedanceFixture({
    isNew: false, firstSeen: "2026-09-05", lastSeen: "2026-09-06",
  });
  const listing = liepinFixture({
    isNew: false, firstSeen: "2026-09-04T14:00:00+08:00", lastSeen: "2026-09-05T15:00:00+08:00",
  });
  const data = scheduledSnapshot([manual, automated, official, listing], {
    startedAt: "2026-09-07T09:30:00+08:00", rules: [automated.id],
  });
  const before = structuredClone(data);
  const app = await boot(t, { responses: [data], now: "2026-09-07T11:15:00+08:00", mobile: true });
  app.change("view-all", true);
  assert.equal(app.errors.mock.callCount(), 0);
  assert.equal(app.get("automation-panel").hidden, false);
  assert.equal(app.get("automation-warning").hidden, true);
  assert.equal(app.get("snapshot-label").textContent, "只读 · 定时采样快照");
  assert.equal(app.get("automation-status").textContent, "上次发布：计划开启");
  assert.equal(app.get("schedule-times").textContent, "每天 09:30 / 12:30（Asia/Shanghai）");
  assert.equal(app.get("generated-at").textContent, "2026.09.07 10:45");
  assert.equal(app.get("generated-at").getAttribute("datetime"), data.generatedAt);
  assert.equal(app.get("run-reviewed-count").textContent, "17");
  assert.equal(app.get("run-details-count").textContent, "5");
  assert.equal(app.get("reviewed-count").textContent, "123");
  assert.equal(app.get("details-count").textContent, "45");
  assert.equal(app.get("new-count").textContent, "1");
  assert.equal(app.get("run-source").textContent, `${data.run.source} · 定时规则初筛 · 累计快照`);
  assert.equal(app.get("automation-sources").textContent,
    "本轮仅对 BOSS直聘 进行新采样；字节跳动招聘官网、猎聘 为保留记录，沿用原始收录与最近观察日期，未在本轮重新核验。");
  assert.match(app.get("assessment-description").textContent, /人工辅助初筛沿用原有判断/);
  assert.match(app.get("assessment-description").textContent, /再次观察到岗位不会改变其初筛方式/);
  assert.match(app.get("category-help").textContent, /规则初筛岗位由固定规则归类/);
  assert.equal(app.cards().length, 4);
  for (const [index, job] of groupJobsByFirstSeen(data.jobs).flatMap((group) => group.jobs).entries()) {
    const field = (name) => app.cards()[index].querySelector(`[data-field="${name}"]`);
    const rulesBased = job.id === automated.id;
    assert.equal(field("assessment").textContent, rulesBased ? "规则初筛 · rules-v1" : "人工辅助初筛");
    assert.equal(field("assessment-note").hidden, !rulesBased);
    assert.equal(field("assessment").getAttribute("class").includes("is-rules"), rulesBased);
    assert.equal(field("source-retention").hidden, job.source === "BOSS直聘");
    assert.equal(field("first-seen").getAttribute("datetime"), job.firstSeen);
    assert.equal(field("last-seen").getAttribute("datetime"), job.lastSeen);
    assert.equal(field("score").textContent, String(job.matchScore));
    assert.equal(field("score-box").getAttribute("aria-label").includes("固定规则计算"), rulesBased);
    assert.equal(field("new").hidden, !job.isNew);
  }
  const automatedCard = app.cards().find((card) => card.querySelector('[data-field="link"]').href === automated.url);
  assert.match(automatedCard.querySelector('[data-field="assessment-note"]').textContent, /固定规则计算.*未经人工复核/);
  assert.equal(automatedCard.querySelector('[data-field="jd-read"]').textContent, "已读取源站完整职位详情");
  app.change("new-only", true);
  assert.equal(app.cards().length, 1);
  app.change("keyword", "demand generation");
  assert.equal(app.cards().length, 1);
  assert.equal(app.cards()[0].querySelector('[data-field="title"]').textContent, automated.title);
  assert.equal(app.get("run-reviewed-count").textContent, "17");
  app.click("reset-filters");
  assert.equal(app.get("salary-mode").value, "all");
  assert.equal(app.get("sort-by").value, "score");
  app.change("sort-by", "firstSeen");
  assert.equal(app.cards()[0].querySelector('[data-field="title"]').textContent, automated.title);
  assert.equal(app.get("total-count").textContent, "04");
  assert.equal(app.get("reviewed-count").textContent, "123");
  assert.equal(app.requests.length, 1);
  assert.deepEqual(data, before);
});

test("rules-based cards keep missing scalars, unread details and zero run counts explicit", async (t) => {
  const unknown = fixture({
    title: null, company: null, city: null, category: null, priority: null,
    matchScore: null, jdRead: false, isNew: false,
  });
  const data = scheduledSnapshot([unknown], { rules: [unknown.id], enabled: false });
  data.automation.reviewedThisRun = 0;
  data.automation.detailsThisRun = 0;
  const app = await boot(t, { responses: [data], now: "2026-09-09T20:00:00+08:00" });
  app.change("view-all", true);
  const field = (name) => app.cards()[0].querySelector(`[data-field="${name}"]`);
  assert.equal(field("assessment").textContent, "规则初筛 · rules-v1");
  assert.equal(field("assessment-note").hidden, false);
  for (const name of ["title", "company", "location", "experience", "education", "salary"]) {
    assert.match(field(name).textContent, /无法获取/);
  }
  for (const name of ["category", "priority", "score", "language", "months"]) {
    assert.match(field(name).textContent, /待确认/);
  }
  assert.equal(field("score-total").hidden, true);
  assert.equal(field("score-box").getAttribute("aria-label"), "初筛参考分无法获取");
  assert.equal(field("jd-read").textContent, "仅获得职位卡片，详情未读取");
  assert.equal(app.get("automation-panel").hidden, false);
  assert.equal(app.get("automation-status").textContent, "上次发布：计划暂停");
  assert.equal(app.get("automation-warning").hidden, true);
  assert.equal(app.get("run-reviewed-count").textContent, "0");
  assert.equal(app.get("run-details-count").textContent, "0");
  assert.equal(app.get("schedule-times").textContent, "每天 09:30 / 12:30（Asia/Shanghai）");
});

test("public generic pending counts do not present structural parsing failures as rejected or selected jobs", async (t) => {
  const data = scheduledSnapshot(testJobs);
  data.automation.reviewPendingThisRun = 4;
  data.automation.parsePendingThisRun = 2;
  const app = await boot(t, { responses: [data] });
  assert.equal(app.get("review-queue-summary").hidden, false);
  assert.match(app.get("review-queue-summary").textContent, /待复核 4 个.*结构解析待复核 2 个/);
  assert.match(app.get("review-queue-summary").textContent, /待复核不等于不适合/);
  assert.equal(app.get("total-count").textContent, "03");
  assert.equal(app.get("new-count").textContent, "2");
  assert.equal(app.cards().length, 3);
});

test("legacy snapshots without review counters do not imply a zero-length queue", async (t) => {
  const app = await boot(t, { responses: [scheduledSnapshot(testJobs)] });
  assert.match(app.get("review-queue-summary").textContent, /待复核数未记录/);
  assert.doesNotMatch(app.get("review-queue-summary").textContent, /待复核 0/);
});

test("human expansion can retain earlier automatic assessments without claiming fresh automatic sampling", async (t) => {
  const data = snapshotOf(testJobs);
  data.run.mode = "人工扩展复核 · 累计快照";
  data.assessmentMethods = Object.fromEntries(testJobs.map((record, index) => [record.id, index === 0 ? "rules-v1" : "human-assisted"]));
  const app = await boot(t, { responses: [data] });
  assert.equal(app.get("automation-panel").hidden, true);
  assert.equal(app.get("review-queue-summary").hidden, true);
  assert.equal(app.cards()[0].querySelector('[data-field="assessment"]').textContent, "规则初筛 · rules-v1");
  assert.equal(app.cards()[1].querySelector('[data-field="assessment"]').textContent, "人工辅助初筛");
  assert.match(app.get("assessment-description").textContent, /初筛方式以各卡片标记为准/);
  assert.match(app.get("category-help").textContent, /规则初筛岗位由固定规则归类/);
});

test("scheduled freshness uses Shanghai slots, a 30-minute grace and a generic snapshot-only warning", async (t) => {
  const cases = [
    ["previous noon covered before morning slot", "2026-09-06T12:45:00+08:00", "2026-09-07T09:29:59+08:00", false],
    ["previous noon missed before morning slot", "2026-09-06T09:45:00+08:00", "2026-09-07T09:29:59+08:00", true],
    ["morning slot is within grace", "2026-09-07T09:00:00+08:00", "2026-09-07T09:45:00+08:00", false],
    ["morning grace includes its exact boundary", "2026-09-07T09:00:00+08:00", "2026-09-07T10:00:00+08:00", false],
    ["morning grace elapsed", "2026-09-07T09:00:00+08:00", "2026-09-07T10:00:00.001+08:00", true],
    ["snapshot exactly at morning slot", "2026-09-07T09:30:00+08:00", "2026-09-07T10:15:00+08:00", false],
    ["snapshot just before morning slot", "2026-09-07T09:29:59+08:00", "2026-09-07T10:15:00+08:00", true],
    ["noon grace includes its exact boundary", "2026-09-07T09:45:00+08:00", "2026-09-07T13:00:00+08:00", false],
    ["noon grace elapsed with UTC clock", "2026-09-07T09:45:00+08:00", "2026-09-07T05:00:00.001Z", true],
    ["earlier missed slot remains during noon grace", "2026-09-07T09:00:00+08:00", "2026-09-07T12:45:00+08:00", true],
    ["Shanghai midnight retains the previous noon slot", "2026-09-07T09:45:00+08:00", "2026-09-07T16:15:00Z", true],
    ["noon snapshot covers Shanghai midnight", "2026-09-07T12:45:00+08:00", "2026-09-07T16:15:00Z", false],
  ];
  for (const [name, generatedAt, now, warning] of cases) {
    await t.test(name, async (subtest) => {
      const data = scheduledSnapshot([], { generatedAt });
      const app = await boot(subtest, { responses: [data], now });
      assert.equal(app.errors.mock.callCount(), 0);
      assert.equal(app.get("automation-panel").hidden, false);
      assert.equal(app.get("automation-warning").hidden, !warning);
      assert.equal(app.get("automation-warning").textContent,
        "本时段尚未确认新快照，可能未运行或更新失败；请查看本机状态");
      assert.equal(app.get("automation-warning").getAttribute("role"), "status");
      assert.equal(app.get("generated-at").getAttribute("datetime"), generatedAt);
      assert.equal(app.requests.length, 1);
    });
  }
});

test("real card rendering preserves literal strings, safe links, nulls and observation labels", async (t) => {
  const app = await boot(t);
  assert.equal(app.cards().length, 3);
  const card = app.cards()[0];
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  assert.equal(field("title").textContent, testJobs[0].title);
  assert.equal(field("title").children.length, 0);
  assert.equal(field("summary").firstElementChild.textContent, testJobs[0].summary[0]);
  assert.equal(card.querySelector("img"), null);
  assert.equal(card.querySelector("script"), null);
  assert.equal(field("link").href, testJobs[0].url);
  assert.equal(field("link").getAttribute("rel"), "noopener noreferrer");
  assert.equal(field("link").getAttribute("target"), "_blank");
  assert.equal(field("salary").textContent, "薪资无法获取");
  assert.equal(field("published").textContent, "无法获取");
  assert.equal(field("published").getAttribute("datetime"), null);
  assert.equal(field("first-seen").textContent, "2026.09.07 07:00");
  assert.equal(app.get("new-count").textContent, "2");
  assert.equal(app.requests.length, 1);
  assert.ok(app.requests[0].url.pathname.endsWith("/docs/data/jobs.json"));
  assert.equal(app.requests[0].url.search, "?rev=20260909-coverage1");
  assert.equal(app.requests[0].options.credentials, "omit");
  assert.equal(app.requests[0].options.cache, "no-store");
});

test("mixed snapshots use each source's own labels and safe CTA while retaining unknown salary", async (t) => {
  const official = bytedanceFixture({ matchScore: 90 });
  const boss = fixture({ matchScore: 50, isNew: false, salaryText: "10-20K", salaryMinK: 10, salaryMaxK: 20 });
  const data = snapshotOf([boss, official], "BOSS直聘 + 字节跳动招聘官网");
  data.run.cardsReviewed = 80;
  data.run.detailsRead = 20;
  const app = await boot(t, { responses: [data], mobile: true });
  assert.equal(app.cards().length, 2);
  assert.equal(app.get("run-source").textContent, "BOSS直聘 + 字节跳动招聘官网 · 单次采集");
  assert.equal(app.get("reviewed-count").textContent, "80");
  assert.equal(app.get("details-count").textContent, "20");
  assert.equal(app.get("new-count").textContent, "1");
  const field = (index, name) => app.cards()[index].querySelector(`[data-field="${name}"]`);
  assert.equal(field(0, "source").textContent, "来源 · 字节跳动招聘官网");
  assert.equal(field(0, "link-label").textContent, "查看官网岗位");
  assert.equal(field(0, "link").href, official.url);
  assert.match(field(0, "link").getAttribute("aria-label"), /字节跳动招聘官网 查看官网岗位/);
  assert.equal(field(0, "link").getAttribute("target"), "_blank");
  assert.equal(field(0, "link").getAttribute("rel"), "noopener noreferrer");
  assert.equal(field(0, "salary").textContent, "薪资无法获取");
  assert.equal(field(0, "salary-note").hidden, false);
  assert.equal(field(0, "months").textContent, "待确认");
  assert.equal(field(0, "jd-read").textContent, "已阅读源站职位详情");
  assert.equal(field(1, "source").textContent, "来源 · BOSS直聘");
  assert.equal(field(1, "link-label").textContent, "查看原始岗位");
  assert.equal(field(1, "link").href, boss.url);
  app.change("salary-mode", "unknown");
  assert.equal(app.cards().length, 1);
  assert.equal(field(0, "link").href, official.url);
  app.change("keyword", "Partner Marketing");
  assert.equal(app.cards().length, 1);
  assert.equal(app.requests.length, 1);
});

test("three-source cards preserve incomparable salary quotes, conditional labels and source CTAs", async (t) => {
  const listing = liepinFixture({ salaryText: "20-40k·15薪", salaryMonths: 15, matchScore: 80 });
  const official = bytedanceFixture({ matchScore: 90 });
  const boss = fixture({ matchScore: 50, isNew: false, salaryText: "10-20K", salaryMinK: 10, salaryMaxK: 20 });
  const data = snapshotOf([boss, official, listing], "BOSS直聘 + 字节跳动招聘官网 + 猎聘");
  const before = structuredClone(data);
  const app = await boot(t, { responses: [data], mobile: true });
  assert.equal(app.cards().length, 3);
  assert.equal(app.get("run-source").textContent, "BOSS直聘 + 字节跳动招聘官网 + 猎聘 · 单次采集");
  assert.equal(app.get("salary-mode").value, "all");
  assert.deepEqual(app.get("salary-mode").children.map((option) => option.textContent),
    ["保留在结果中", "只看可比较月薪", "只看未公开或不可比较"]);
  const field = (index, name) => app.cards()[index].querySelector(`[data-field="${name}"]`);
  assert.equal(field(1, "source").textContent, "来源 · 猎聘");
  assert.equal(field(1, "link-label").textContent, "查看猎聘岗位");
  assert.equal(field(1, "link").href, listing.url);
  assert.match(field(1, "link").getAttribute("aria-label"), /猎聘 查看猎聘岗位/);
  assert.equal(field(1, "link").getAttribute("target"), "_blank");
  assert.equal(field(1, "link").getAttribute("rel"), "noopener noreferrer");
  assert.equal(field(1, "priority").textContent, "有条件匹配");
  assert.equal(field(1, "salary").textContent, "20-40k·15薪");
  assert.equal(field(1, "months").textContent, "15 薪");
  assert.equal(field(1, "salary-note").hidden, false);
  assert.equal(field(1, "salary-note").textContent, "保留招聘页原文，月薪不可比较，不据此推算");
  assert.equal(field(0, "salary-note").textContent, "月薪未公开或无法获取，不据此推算");
  assert.equal(field(2, "salary-note").hidden, true);
  app.change("salary-min", "50");
  assert.equal(app.cards().length, 2);
  app.change("salary-mode", "known");
  assert.equal(app.cards().length, 0);
  app.change("salary-mode", "unknown");
  assert.equal(app.cards().length, 2);
  assert.equal(app.get("salary-min").disabled, true);
  app.change("keyword", "活动营销");
  assert.equal(app.cards().length, 1);
  assert.equal(field(0, "salary").textContent, "20-40k·15薪");
  app.click("reset-filters");
  assert.equal(app.cards().length, 3);
  assert.equal(app.get("salary-mode").value, "all");
  assert.equal(app.get("salary-min").value, "");
  assert.deepEqual(data, before);
  assert.equal(app.requests.length, 1);
});

test("category, priority, keyword, new-only, sorting and no-match reset are wired", async (t) => {
  const app = await boot(t);
  app.change("category", "渠道销售");
  app.change("priority", "进一步确认");
  app.change("new-only", true);
  assert.equal(app.cards().length, 1);
  assert.equal(app.cards()[0].querySelector('[data-field="title"]').textContent, "TEST_ONLY_CRM");
  app.change("keyword", "SaaS");
  assert.equal(app.cards().length, 0);
  assert.match(app.get("state-title").textContent, /没有符合/);
  app.click("state-action");
  await settle();
  assert.equal(app.cards().length, 3);
  assert.equal(app.get("filter-indicator").hidden, true);
  app.change("sort-by", "firstSeen");
  assert.equal(app.cards()[0].querySelector('[data-field="title"]').textContent, "TEST_ONLY_SaaS");
  app.click("reset-filters");
  assert.equal(app.get("sort-by").value, "score");
  assert.equal(app.cards()[0].querySelector('[data-field="title"]').textContent, testJobs[0].title);
  assert.equal(app.requests.length, 1);
});

test("reviewed direction aliases and transition priorities work with salary and reset controls", async (t) => {
  const jobs = [
    job("field", { title: "业务经理", category: "区域市场", priority: "转型备选", matchScore: 90 }),
    job("partner", { title: "业务经理", category: "伙伴营销", priority: "有条件匹配", matchScore: 50 }),
    job("operations", { title: "业务经理", category: "销售运营", priority: "优先了解", matchScore: 10 }),
  ];
  const before = structuredClone(jobs);
  const app = await boot(t, { responses: [snapshotOf(jobs)], mobile: true });
  assert.equal(app.get("filters-panel").open, false);
  assert.equal(app.get("category").firstElementChild.textContent, "全部方向");
  assert.deepEqual(app.get("priority").children.map((option) => option.value),
    ["", "优先了解", "有条件匹配", "转型备选"]);
  assert.equal(app.get("category").children.length, 4);
  assert.equal(app.get("salary-mode").value, "all");
  assert.equal(app.get("salary-min").value, "");
  assert.equal(app.get("salary-max").value, "");
  assert.equal(app.cards().length, 3);

  app.change("keyword", "  fIeLd   MARKETING ");
  app.change("priority", "转型备选");
  app.change("category", "区域市场");
  assert.equal(app.cards().length, 1);
  const card = app.cards()[0];
  assert.equal(card.querySelector('[data-field="title"]').textContent, "业务经理");
  assert.equal(card.querySelector('[data-field="category"]').textContent, "区域市场");
  assert.equal(card.querySelector('[data-field="priority"]').textContent, "转型备选");
  assert.equal(card.querySelector('[data-field="salary"]').textContent, "薪资无法获取");
  app.change("salary-mode", "known");
  assert.equal(app.cards().length, 0);
  app.click("state-action");
  assert.equal(app.get("keyword").value, "");
  assert.equal(app.get("category").value, "");
  assert.equal(app.get("priority").value, "");
  assert.equal(app.get("salary-mode").value, "all");
  assert.equal(app.get("sort-by").value, "score");
  assert.equal(app.cards().length, 3);
  app.change("sort-by", "priority");
  assert.deepEqual(app.cards().map((node) => node.querySelector('[data-field="priority"]').textContent),
    ["优先了解", "有条件匹配", "转型备选"]);
  app.click("reset-filters");
  assert.equal(app.get("sort-by").value, "score");
  assert.equal(app.cards()[0].querySelector('[data-field="priority"]').textContent, "转型备选");
  assert.equal(app.requests.length, 1);
  assert.deepEqual(jobs, before);
});

test("cumulative counters and current-run badges preserve old first-seen observations", async (t) => {
  const data = snapshotOf([
    job("old", { firstSeen: "2026-09-06T08:00:00+08:00", isNew: false, matchScore: 90 }),
    job("added", { firstSeen: "2026-09-05T08:00:00+08:00", isNew: true }),
  ]);
  data.run.cardsReviewed = 123;
  data.run.detailsRead = 45;
  const before = structuredClone(data);
  const app = await boot(t, { responses: [data] });
  app.change("view-all", true);
  assert.equal(app.get("total-count").textContent, "02");
  assert.equal(app.get("reviewed-count").textContent, "123");
  assert.equal(app.get("details-count").textContent, "45");
  assert.equal(app.get("new-count").textContent, "1");
  assert.match(app.get("reviewed-count").parentElement.textContent, /累计初筛/);
  assert.match(app.get("details-count").parentElement.textContent, /累计精读/);
  assert.match(app.get("new-count").parentElement.textContent, /本轮新增/);
  assert.equal(app.get("new-filter-count").textContent, "（1）");
  assert.equal(app.cards()[0].querySelector('[data-field="first-seen"]').textContent, "2026.09.06 08:00");
  assert.equal(app.cards()[0].querySelector('[data-field="new"]').hidden, true);
  assert.equal(app.cards()[1].querySelector('[data-field="new"]').textContent, "本轮新增");
  app.change("new-only", true);
  assert.equal(app.cards().length, 1);
  assert.equal(app.cards()[0].querySelector('[data-field="new"]').hidden, false);
  assert.equal(app.cards()[0].querySelector('[data-field="first-seen"]').textContent, "2026.09.05 08:00");
  assert.equal(app.get("reviewed-count").textContent, "123");
  assert.equal(app.get("details-count").textContent, "45");
  assert.equal(app.get("total-count").textContent, "02");
  assert.equal(app.get("new-count").textContent, "1");
  assert.deepEqual(data, before);
});

test("unknown fields remain explicit rather than being replaced with invented facts", async (t) => {
  const app = await boot(t, { responses: [snapshotOf([fixture({
    title: null, company: null, city: null, category: null, priority: null,
    matchScore: null, jdRead: false,
  })])] });
  const field = (name) => app.cards()[0].querySelector(`[data-field="${name}"]`);
  for (const name of ["title", "company", "location", "experience", "education", "salary"]) {
    assert.match(field(name).textContent, /无法获取/);
  }
  for (const name of ["category", "priority", "score", "language", "months"]) {
    assert.match(field(name).textContent, /待确认/);
  }
  assert.equal(field("score-total").hidden, true);
  assert.match(field("jd-read").textContent, /详情未读取/);
});

test("salary filtering, unknown-only disabling, invalid input and reset work together", async (t) => {
  const app = await boot(t);
  app.change("salary-min", "20");
  app.change("salary-max", "30");
  assert.equal(app.cards().length, 2);
  app.change("salary-mode", "known");
  assert.equal(app.cards().length, 1);
  app.change("salary-mode", "unknown");
  assert.equal(app.cards().length, 1);
  assert.equal(app.get("salary-min").disabled, true);
  assert.equal(app.get("salary-min").value, "20");
  app.change("salary-mode", "all");
  app.change("salary-max", "10");
  assert.equal(app.cards().length, 0);
  assert.equal(app.get("salary-error").hidden, false);
  assert.equal(app.get("salary-min").getAttribute("aria-invalid"), "true");
  app.click("state-action");
  await settle();
  assert.equal(app.get("salary-min").value, "");
  assert.equal(app.get("salary-min").disabled, false);
  assert.equal(app.get("salary-error").hidden, true);
  assert.equal(app.cards().length, 3);
  app.get("salary-min").validity.badInput = true;
  app.change("salary-min", "");
  assert.equal(app.cards().length, 0);
  assert.match(app.get("salary-error").textContent, /有效/);
});

test("network errors are visible and retry recovers without stale or fabricated cards", async (t) => {
  const app = await boot(t, { responses: [new TypeError("TEST_ONLY_NETWORK_ERROR"), snapshotOf(testJobs)] });
  assert.equal(app.get("filter-controls").disabled, true);
  assert.equal(app.get("result-count").textContent, "数据不可用");
  assert.equal(app.cards().length, 0);
  assert.equal(app.get("total-count").textContent, "—");
  assert.equal(app.errors.mock.callCount(), 1);
  assert.equal(app.get("state-action").hidden, false);
  app.click("state-action");
  await settle();
  assert.equal(app.requests.length, 2);
  assert.equal(app.get("filter-controls").disabled, false);
  assert.equal(app.cards().length, 3);
  assert.equal(app.get("data-state").hidden, true);
});

test("HTTP, JSON and schema failures are surfaced as errors rather than empty success", async (t) => {
  const unsafe = snapshotOf([job("unsafe", { url: "https://example.invalid/" })]);
  const incompleteAutomation = scheduledSnapshot([fixture()]);
  delete incompleteAutomation.assessmentMethods;
  const cases = [
    { customResponse: { ok: false, status: 404 } },
    { customResponse: { ok: true, json: async () => { throw new SyntaxError("TEST_ONLY_JSON_ERROR"); } } },
    unsafe,
    snapshotOf([bytedanceFixture({ url: fixture().url })], "字节跳动招聘官网"),
    snapshotOf([liepinFixture({ url: bytedanceFixture().url })], "猎聘"),
    incompleteAutomation,
  ];
  for (const [index, response] of cases.entries()) {
    await t.test(`failure ${index + 1}`, async (subtest) => {
      const app = await boot(subtest, { responses: [response] });
      assert.equal(app.get("result-count").textContent, "数据不可用");
      assert.equal(app.get("filter-controls").disabled, true);
      assert.equal(app.get("results-area").getAttribute("aria-busy"), "false");
      assert.equal(app.cards().length, 0);
      assert.equal(app.get("automation-panel").hidden, true);
      assert.equal(app.get("automation-warning").hidden, true);
      assert.equal(app.get("state-action").hidden, false);
      assert.equal(app.errors.mock.callCount(), 1);
    });
  }
});
