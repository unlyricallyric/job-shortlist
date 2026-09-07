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
    assert.equal(url.search, "?rev=20260907-2", url.href);
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

test("rendering uses text nodes, no storage or external data services", async () => {
  const app = await readFile(new URL("app.mjs", docs), "utf8");
  assert.ok(app.includes("textContent"));
  assert.ok(app.includes('new URL("./data/jobs.json?rev=20260907-2", import.meta.url)'));
  assert.ok(app.includes('credentials: "omit"'));
  assert.ok(!/\b(?:innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|eval)\b/.test(app));
  assert.ok(!/document\.(?:write|cookie)/.test(app));
  assert.equal([...app.matchAll(/\bfetch\(/g)].length, 1);
});
