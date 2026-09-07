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
});

test("rendering uses text nodes, no storage or external data services", async () => {
  const app = await readFile(new URL("app.mjs", docs), "utf8");
  assert.ok(app.includes("textContent"));
  assert.ok(app.includes('new URL("./data/jobs.json", import.meta.url)'));
  assert.ok(app.includes('credentials: "omit"'));
  assert.ok(!/\b(?:innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|eval)\b/.test(app));
  assert.ok(!/document\.(?:write|cookie)/.test(app));
  assert.equal([...app.matchAll(/\bfetch\(/g)].length, 1);
});
