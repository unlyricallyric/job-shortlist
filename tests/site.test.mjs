import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const docs = new URL("../docs/", import.meta.url);

test("static entry points and assets work beneath a GitHub Pages repository path", async () => {
  const html = await readFile(new URL("index.html", docs), "utf8");
  const deployment = new URL("https://unlyricallyric.github.io/job-shortlist/");
  const assetPaths = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(assetPaths.length >= 3);
  for (const path of assetPaths) {
    assert.ok(new URL(path, deployment).pathname.startsWith("/job-shortlist/"));
    await access(new URL(path, docs));
  }
  await access(new URL(".nojekyll", docs));
  await access(new URL("data/jobs.json", docs));
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('content="no-referrer"'));
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("<noscript>"));
  assert.ok(html.includes("初筛参考分"));
  assert.ok(html.includes("人工辅助"));
  assert.ok(html.includes("不代表已满足全部任职要求"));
  assert.ok(html.includes("招聘页标注"));
  assert.ok(!html.includes("规则匹配分"));
  assert.ok(!html.includes('src="https://'));
  assert.ok(!html.includes('href="/'));
});

test("HTML assets, dependent modules and no-store data share one explicit release revision", async () => {
  const html = await readFile(new URL("index.html", docs), "utf8");
  const app = await readFile(new URL("app.mjs", docs), "utf8");
  const references = [
    ...[...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1]),
    ...[...app.matchAll(/\bfrom "(\.\/[^"]+)"/g)].map((match) => match[1]),
    ...[...app.matchAll(/new URL\("(\.\/[^"]+)", import\.meta\.url\)/g)].map((match) => match[1]),
  ];
  const base = new URL("https://unlyricallyric.github.io/job-shortlist/");
  const resolved = references.map((path) => new URL(path, base));
  for (const url of resolved) {
    assert.equal(url.origin, base.origin);
    assert.ok(url.pathname.startsWith(base.pathname));
    assert.equal(url.search, "?rev=20260909-paused1", url.href);
    await access(new URL(url.pathname.slice(base.pathname.length), docs));
  }
  for (const file of ["app.mjs", "model.mjs", "styles.css", "favicon.svg", "data/jobs.json"]) {
    assert.ok(resolved.some((url) => url.pathname === `${base.pathname}${file}`), `Missing versioned reference to ${file}`);
  }
  assert.ok(app.includes('cache: "no-store"'));
});

test("all app element hooks exist exactly once and all card fields exist", async () => {
  const html = await readFile(new URL("index.html", docs), "utf8");
  const app = await readFile(new URL("app.mjs", docs), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of app.matchAll(/byId\("([^"]+)"\)/g)) {
    assert.ok(ids.includes(id), `Missing element #${id}`);
  }
  const fields = [...html.matchAll(/data-field="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(fields).size, fields.length);
  for (const [, field] of app.matchAll(/(?:field|put)\("([^"]+)"/g)) {
    assert.ok(fields.includes(field), `Missing card field ${field}`);
  }
  for (const [, label] of html.matchAll(/\bfor="([^"]+)"/g)) {
    assert.ok(ids.includes(label), `Missing labeled input ${label}`);
  }
  for (const [, description] of html.matchAll(/\baria-describedby="([^"]+)"/g)) {
    for (const id of description.split(/\s+/)) assert.ok(ids.includes(id), `Missing accessible description ${id}`);
  }
});

test("discovery guidance and counters describe JD-based directions and cumulative review accurately", async () => {
  const html = await readFile(new URL("index.html", docs), "utf8");
  assert.ok(html.includes("按工作内容选方向"));
  assert.ok(html.includes("原标题保留，方向按JD实际职责归类；同一岗位名可能做不同工作"));
  assert.ok(html.includes('placeholder="如：渠道市场、区域市场…"'));
  assert.ok(html.includes("也可搜需求生成"));
  assert.ok(html.includes("英文别名仅作本站查找已归类方向的可选辅助"));
  assert.ok(!/Field Marketing|PDR/.test(html));
  assert.ok(html.includes("不自动分类"));
  assert.ok(html.includes("当前收录"));
  assert.ok(html.includes("累计初筛"));
  assert.ok(html.includes("累计精读"));
  assert.ok(html.includes("按来源及岗位记录去重"));
  assert.ok(html.includes("非平台总量或招聘名额"));
  assert.ok(html.includes("本轮新增"));
  assert.ok(html.includes("后续更新保留原记录"));
  assert.ok(html.includes("薪资仅作参考，默认不过滤"));
  assert.ok(html.includes("未公开或不可比较的岗位默认保留"));
  assert.ok(html.includes("只看可比较月薪"));
  assert.ok(html.includes("只看未公开或不可比较"));
  assert.ok(html.includes('option value="priority"'));
  assert.ok(!/本次首次收录|本次实际查看|仅本次新增|全部类别/.test(html));
});

test("exclusive date views are accessible and chronology, counts and run-new semantics are explicit", async () => {
  const html = await readFile(new URL("index.html", docs), "utf8");
  const controls = [...html.matchAll(/<input id="view-(today|week|all)"[^>]+>/g)].map((match) => match[0]);
  assert.equal(controls.length, 3);
  assert.ok(controls.every((input) => input.includes('type="radio"') && input.includes('name="arrivalView"')));
  assert.equal(controls.filter((input) => input.includes("checked")).length, 1);
  assert.ok(controls[0].includes("checked"));
  assert.ok(html.includes("近7天含今天及前6天"));
  assert.ok(html.includes("同来源、同岗位 ID 重复观察不重复计新"));
  assert.ok(html.includes("同日早些时候收录的岗位仍算今日新增"));
  assert.ok(html.includes('for="sort-by">组内排序'));
  assert.ok(html.includes('id="state-all-action"'));
});

test("rendering uses text nodes, no storage or external data services", async () => {
  const app = await readFile(new URL("app.mjs", docs), "utf8");
  assert.ok(app.includes("textContent"));
  assert.ok(app.includes('new URL("./data/jobs.json?rev=20260909-paused1", import.meta.url)'));
  assert.ok(app.includes('credentials: "omit"'));
  assert.ok(!/\b(?:innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|eval)\b/.test(app));
  assert.ok(!/document\.(?:write|cookie)/.test(app));
  assert.ok(!/\b(?:setInterval|WebSocket|EventSource)\b/.test(app));
  assert.equal([...app.matchAll(/\bsetTimeout\(/g)].length, 1);
  assert.ok(app.includes("nextShanghaiMidnight(now)"));
  assert.equal([...app.matchAll(/\bfetch\(/g)].length, 1);
});

test("schedule disclosures default hidden and distinguish local configuration from a read-only snapshot", async () => {
  const html = await readFile(new URL("index.html", docs), "utf8");
  const app = await readFile(new URL("app.mjs", docs), "utf8");
  assert.match(html, /<section[^>]*id="automation-panel"[^>]*hidden>/);
  assert.match(html, /<p[^>]*id="automation-warning"[^>]*role="status"[^>]*hidden>/);
  assert.ok(html.includes("最近快照 · 上海"));
  assert.ok(html.includes("上次发布的计划"));
  assert.ok(html.includes("本轮查看卡片"));
  assert.ok(html.includes("本轮完整 JD"));
  assert.ok(html.includes('id="review-queue-summary"'));
  assert.ok(html.includes('id="paused-notice"'));
  assert.ok(html.includes("定时采集已暂停，当前显示已保存岗位"));
  assert.ok(html.includes("没有已入选新增，不代表市场没有机会"));
  assert.ok(html.includes("本机暂停后页面可能仍保留旧计划"));
  assert.ok(html.includes("并非实时运行状态"));
  assert.ok(html.includes("准确状态请查看本机"));
  assert.ok(html.includes("Mac 必须保持唤醒、用户已登录、Chrome 已登录 BOSS直聘且网络可用"));
  assert.ok(html.includes("睡眠或合盖时不保证执行"));
  assert.ok(html.includes("仅说明采样完成，不代表任务成功退出"));
  assert.ok(html.includes("推送与公开页面核验结果请查看本机状态"));
  assert.ok(html.includes("本页不轮询"));
  assert.ok(html.includes("页面不自动刷新；刷新页面读取最新已发布数据"));
  assert.ok(html.includes("跨上海午夜或返回页面时仅重算日期视图与时段提示"));
  assert.ok(html.includes("固定规则计算，仅供排序参考；未经人工复核"));
  assert.ok(html.includes("保留记录 · 沿用原观察日期"));
  assert.ok(app.includes("规则初筛 · rules-v1"));
  assert.ok(app.includes("规则初筛岗位由固定规则归类"));
  assert.ok(app.includes("再次观察到岗位不会改变其初筛方式"));
});
