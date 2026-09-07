import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatShanghaiTime, selectJobs } from "../docs/model.mjs";
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

async function boot(t, { responses = [snapshotOf(testJobs)], mobile = false } = {}) {
  const document = pageDocument(html);
  const originals = new Map(["document", "window", "Option", "fetch"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  globalThis.document = document;
  globalThis.window = { matchMedia: () => ({ matches: mobile }) };
  globalThis.Option = OptionDouble;
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
    get, requests, errors,
    cards: () => get("job-list").children,
    change: (id, value) => {
      const node = get(id);
      if (typeof value === "boolean") node.checked = value;
      else node.value = value;
      (id === "sort-by" ? node : get("filter-form")).dispatchEvent(new Event("change"));
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

test("the public snapshot renders all source records and counts without changing observations", async (t) => {
  const data = JSON.parse(await readFile(new URL("../docs/data/jobs.json", import.meta.url), "utf8"));
  const before = structuredClone(data);
  const app = await boot(t, { responses: [data] });
  assert.equal(app.cards().length, data.jobs.length);
  assert.equal(app.get("new-count").textContent, String(data.run.newCount));
  assert.equal(app.get("reviewed-count").textContent, String(data.run.cardsReviewed));
  assert.equal(app.get("details-count").textContent, String(data.run.detailsRead));
  assert.equal(app.get("run-source").textContent, `${data.run.source} · ${data.run.mode}`);
  assert.equal(app.get("generated-at").textContent, formatShanghaiTime(data.generatedAt));
  for (const [index, job] of selectJobs(data.jobs).entries()) {
    const field = (name) => app.cards()[index].querySelector(`[data-field="${name}"]`);
    assert.equal(field("title").textContent, job.title ?? "岗位名称无法获取");
    assert.equal(field("source").textContent, `来源 · ${job.source}`);
    assert.equal(field("link").href, job.url);
    assert.equal(field("salary").textContent, job.salaryText ?? "薪资无法获取");
    assert.equal(field("first-seen").getAttribute("datetime"), job.firstSeen);
    assert.equal(field("last-seen").getAttribute("datetime"), job.lastSeen);
    assert.equal(field("new").hidden, !job.isNew);
  }
  app.change("new-only", true);
  assert.equal(app.cards().length, data.jobs.filter((job) => job.isNew).length);
  app.click("reset-filters");
  assert.equal(app.cards().length, data.jobs.length);
  assert.deepEqual(data, before);
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
  assert.equal(app.requests[0].url.search, "?rev=20260907-2");
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
  const cases = [
    { customResponse: { ok: false, status: 404 } },
    { customResponse: { ok: true, json: async () => { throw new SyntaxError("TEST_ONLY_JSON_ERROR"); } } },
    unsafe,
    snapshotOf([bytedanceFixture({ url: fixture().url })], "字节跳动招聘官网"),
    snapshotOf([liepinFixture({ url: bytedanceFixture().url })], "猎聘"),
  ];
  for (const [index, response] of cases.entries()) {
    await t.test(`failure ${index + 1}`, async (subtest) => {
      const app = await boot(subtest, { responses: [response] });
      assert.equal(app.get("result-count").textContent, "数据不可用");
      assert.equal(app.get("filter-controls").disabled, true);
      assert.equal(app.get("results-area").getAttribute("aria-busy"), "false");
      assert.equal(app.cards().length, 0);
      assert.equal(app.get("state-action").hidden, false);
      assert.equal(app.errors.mock.callCount(), 1);
    });
  }
});
