import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardsInPage, detailInPage, pageGuard, searchUrl, ownedTab, waitPage } from "../scheduler/browser.mjs";
import { atomicJson, readJson, RunError } from "../scheduler/io.mjs";

const evaluate = (fn, globals, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, {
  URL, Date, ...globals, args,
});
const location = new URL("https://www.zhipin.com/web/geek/jobs?query=渠道市场&city=101020100");
const visible = (innerText = "") => ({ innerText, getClientRects: () => [{}] });

test("Chinese searches have the exact city/industry restrictions and never an experience filter", () => {
  const url = new URL(searchUrl({ term: "市场活动", industry: "100021" }));
  assert.equal(url.origin, "https://www.zhipin.com");
  assert.equal(url.searchParams.get("city"), "101020100");
  assert.equal(url.searchParams.get("experience"), null);
  assert.equal(new URL(searchUrl({ term: "市场经理", industry: "100023" })).searchParams.get("industry"), "100023");
  assert.throws(() => searchUrl({ term: "市场经理", industry: "101404" }), /Unsupported industry/);
  for (const query of [{ term: "Field Marketing" }, { term: "市场", industry: "123456" }, { term: "" }]) {
    assert.throws(() => searchUrl(query));
  }
});

test("native position filters are limited to observed codes and verified as part of exact page identity", () => {
  const query = { term: "市场", industry: "100021", position: "140101" };
  const expected = searchUrl(query);
  const filtered = new URL(expected);
  assert.equal(filtered.searchParams.get("position"), "140101");
  assert.equal(filtered.searchParams.get("experience"), null);
  const document = { querySelectorAll: () => [] };
  assert.equal(evaluate(pageGuard, { document, location: filtered }, expected).state, "ok");
  const missing = new URL(expected);
  missing.searchParams.delete("position");
  assert.equal(evaluate(pageGuard, { document, location: missing }, expected).state, "waiting");
  const wrong = new URL(expected);
  wrong.searchParams.set("position", "140109");
  assert.equal(evaluate(pageGuard, { document, location: wrong }, expected).state, "waiting");
  assert.equal(evaluate(pageGuard, { document, location: filtered }, searchUrl({ term: "市场", industry: "100021" })).state, "waiting");
  for (const position of ["999999", "140101,140109", "14010", 140101, ""]) {
    assert.throws(() => searchUrl({ ...query, position }), /Unsupported native position/);
  }
});

test("public page guard rejects wrong host, stale query and explicit visible login/captcha states", () => {
  const document = { querySelectorAll: () => [] };
  assert.equal(evaluate(pageGuard, { document, location: new URL("https://example.invalid/") }).state, "blocked");
  assert.equal(evaluate(pageGuard, { document, location }, searchUrl({ term: "需求生成" })).state, "waiting");
  for (const [selector, code] of [[".captcha-box", "captcha"], [".sign-dialog", "login-required"]]) {
    const result = evaluate(pageGuard, {
      location, document: { querySelectorAll: (name) => name === selector ? [visible()] : [] },
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.code, code);
  }
});

test("card extraction never decodes private-use salary glyphs or reads recruiter details", () => {
  const make = (salary) => {
    const values = {
      ".boss-name": { innerText: "TEST_ONLY_COMPANY" },
      ".company-location": { innerText: "上海·TEST_ONLY" },
      ".job-salary": { innerText: salary },
    };
    return {
      href: "https://www.zhipin.com/job_detail/test-only.html?tracking=ignored",
      innerText: "市场经理",
      closest: () => ({
        querySelector: (selector) => {
          assert.ok(Object.hasOwn(values, selector), `Unexpected private selector: ${selector}`);
          return values[selector];
        },
        querySelectorAll: () => [{ innerText: "3-5年" }, { innerText: "本科" }],
      }),
    };
  };
  const result = evaluate(cardsInPage, {
    document: { querySelectorAll: (selector) => selector === "a.job-name" ? [make("\ue123-\ue234K"), make("8-12K")] : [] },
  });
  assert.equal(result.cards[0].salaryText, null);
  assert.equal(result.cards[1].salaryText, "8-12K");
  assert.equal(result.cards[0].url, "https://www.zhipin.com/job_detail/test-only.html");
  assert.ok(!Object.hasOwn(result.cards[0], "salaryMinK"));
});

test("full JD requires both matching public ID and exact heading before acceptance", () => {
  const page = (id, title) => ({
    document: {
      querySelector: (selector) => ({
        ".job-detail-body a.more-job-btn": { href: `https://www.zhipin.com/job_detail/${id}.html` },
        ".job-detail-body .desc": { innerText: "TEST_ONLY_DESCRIPTION ".repeat(10) },
        ".job-detail-info": { innerText: `${title}\nTEST_ONLY` },
      })[selector],
    },
  });
  assert.equal(evaluate(detailInPage, page("a", "市场经理"), "boss-a", "市场经理").state, "ready");
  assert.equal(evaluate(detailInPage, page("stale", "市场经理"), "boss-a", "市场经理").state, "waiting");
  assert.equal(evaluate(detailInPage, page("a", "其他职位"), "boss-a", "市场经理").state, "identity-conflict");
});

test("same-ID conflicting detail title never exposes the JD and needs repeated stable observations", async () => {
  const document = {
    querySelector: (selector) => ({
      ".job-detail-body a.more-job-btn": { href: "https://www.zhipin.com/job_detail/test-only.html" },
      ".job-detail-body .desc": { get innerText() { assert.fail("Conflicting detail text must not be read."); } },
      ".job-detail-info": { innerText: "海外大客户经理（出差马来西亚等）" },
    })[selector],
  };
  const conflict = evaluate(detailInPage, { document }, "boss-test-only", "海外大客户经理");
  assert.equal(conflict.state, "identity-conflict");
  assert.equal(conflict.jd, undefined);
  let reads = 0;
  const result = await waitPage(async () => { reads++; return conflict; }, 500, undefined,
    { allowIdentityConflict: true, intervalMs: 1 });
  assert.equal(reads, 3);
  assert.deepEqual(result, { state: "identity-conflict", code: "detail-title-conflict" });
  let changed = 0;
  const recovered = await waitPage(async () => ++changed < 3 ? conflict : { state: "ready", jd: "TEST_ONLY" },
    500, undefined, { allowIdentityConflict: true, intervalMs: 1 });
  assert.equal(recovered.state, "ready");
  await assert.rejects(waitPage(async () => ({ state: "waiting" }), 5, undefined,
    { allowIdentityConflict: true, intervalMs: 1 }), { code: "source-timeout" });
});

test("a legitimate empty result differs from an unknown or broken page", () => {
  assert.equal(evaluate(cardsInPage, { document: { querySelectorAll: () => [] } }).state, "waiting");
  const result = evaluate(cardsInPage, {
    document: { querySelectorAll: (selector) => selector === "a.job-name" ? [] : [visible("没有找到相关职位")] },
  });

  assert.equal(result.state, "ready");
  assert.equal(result.empty, true);
  const currentBossEmpty = evaluate(cardsInPage, {
    document: { querySelectorAll: (selector) => selector.includes(".job-empty-wrapper")
      ? [visible("没有找到相关职位，打开 APP，查看全部职位库，优质职位随心聊。")] : [] },
  });
  assert.equal(currentBossEmpty.state, "ready");
  assert.equal(currentBossEmpty.empty, true);
  const hiddenEmpty = evaluate(cardsInPage, {
    document: { querySelectorAll: (selector) => selector.includes(".job-empty-wrapper")
      ? [{ innerText: "没有找到相关职位", getClientRects: () => [] }] : [] },
  });
  assert.equal(hiddenEmpty.state, "waiting");
});

test("missing owned window or tab after Chrome restart creates a new task tab, never reuses the discovered tab", async (t) => {
  for (const missing of ["missing-window", "missing-tab"]) {
    await t.test(missing, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), "shortlist-browser-test-"));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      await atomicJson(join(root, "browser.json"), { windowId: 10, tabId: 11 });
      const calls = [];
      const fresh = await ownedTab(root, searchUrl({ term: "渠道市场" }), undefined, {
        discoverBoss: async () => ({ windowId: 20, tabId: 21 }),
        apple: async (lines) => {
          calls.push(lines);
          return calls.length === 1 ? missing : "20,22";
        },
      });
      assert.deepEqual(fresh, { windowId: 20, tabId: 22 });
      assert.deepEqual(await readJson(join(root, "browser.json")), fresh);
      assert.ok(calls[0].some((line) => line.includes("exists window")));
      assert.ok(calls[0].some((line) => line.includes("exists tab")));
      assert.ok(calls[1].some((line) => line.includes("make new tab at end")));
      assert.ok(calls[1].some((line) => line.includes("active tab index of sourceWindow to originalIndex")));
      assert.ok(!calls.flat().some((line) => /activate|set URL of.*21/.test(line)));
    });
  }
});

test("unexpected navigation and Apple Events denial do not trigger tab recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-browser-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const existing = { windowId: 10, tabId: 11 };
  await atomicJson(join(root, "browser.json"), existing);
  for (const url of ["https://example.invalid/", "https://www.zhipin.com/web/geek/jobs-other", "https://www.zhipin.com/web/user/login"]) {
    await assert.rejects(ownedTab(root, searchUrl({ term: "市场" }), undefined, {
      apple: async () => url,
      discoverBoss: async () => assert.fail("Unexpected navigation must not discover a replacement."),
    }), { code: "unexpected-owned-tab" });
  }
  await assert.rejects(ownedTab(root, searchUrl({ term: "市场" }), undefined, {
    apple: async () => { throw new RunError("apple-events-denied", "Permission denied.", { blocked: true }); },
    discoverBoss: async () => assert.fail("Permission denial must not create a replacement."),
  }), { code: "apple-events-denied" });
  assert.deepEqual(await readJson(join(root, "browser.json")), existing);
});
