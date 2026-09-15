import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardsInPage, detailInPage, pageGuard, searchUrl, ownedTab, waitPage, ordinaryChromeInstance, appleErrorCode } from "../scheduler/browser.mjs";
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

test("stable short matching detail is private incomplete content, never a full JD or blank-page success", async () => {
  const documentFor = (text) => ({
    querySelector: (selector) => ({
      ".job-detail-body a.more-job-btn": { href: "https://www.zhipin.com/job_detail/test-short.html" },
      ".job-detail-body .desc": { innerText: text },
      ".job-detail-info": { innerText: "TEST_ONLY_TITLE" },
    })[selector],
  });
  const result = evaluate(detailInPage, { document: documentFor("TEST_ONLY_SHORT_DESCRIPTION") }, "boss-test-short", "TEST_ONLY_TITLE");
  assert.equal(result.state, "incomplete-detail");
  assert.equal(result.jd, undefined);
  let reads = 0;
  const stable = await waitPage(async () => { reads++; return result; }, 500, undefined,
    { allowIncompleteDetail: true, intervalMs: 1 });
  assert.equal(reads, 3);
  assert.deepEqual(stable, { state: "incomplete-detail", code: "jd-content-incomplete" });
  let changing = 0;
  const updated = await waitPage(async () => ++changing < 4
    ? { ...result, incompleteText: changing % 2 ? "TEST_ONLY_A" : "TEST_ONLY_B" }
    : { state: "ready", jd: "TEST_ONLY_FULL_DESCRIPTION" }, 500, undefined,
  { allowIncompleteDetail: true, intervalMs: 1 });
  assert.equal(updated.state, "ready", "Changing same-length content must not be quarantined as stable.");
  await assert.rejects(waitPage(async () => { throw new RunError("captcha", "TEST_ONLY", { blocked: true }); }, 500,
    undefined, { allowIncompleteDetail: true, intervalMs: 1 }), { code: "captcha" });
  for (const text of ["", "正在加载，请稍候"]) {
    assert.equal(evaluate(detailInPage, { document: documentFor(text) }, "boss-test-short", "TEST_ONLY_TITLE").state, "waiting");
  }
  assert.equal(evaluate(detailInPage, { document: documentFor("TEST_ONLY_SHORT_DESCRIPTION") }, "boss-wrong-id", "TEST_ONLY_TITLE").state, "waiting");
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

const chromeProcess = { pid: 12345, startedAt: "Mon Sep 14 09:00:00 2026" };
const initialUrl = searchUrl({ term: "渠道经理", industry: "100021" });
const originalTab = { windowId: 10, tabId: 11 };
const observed = (tab = originalTab, url = initialUrl) => `owned|${tab.windowId}|${tab.tabId}|${url}`;
const servicesFor = (overrides = {}) => ({
  instance: async () => chromeProcess, contextTimeoutMs: 30, sourceTimeoutMs: 100, sourceIntervalMs: 1,
  pause: async () => {}, discoverBoss: async () => assert.fail("A saved task window must not depend on another BOSS seed."),
  ...overrides,
});
async function browserFixture(t, handle = originalTab) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-browser-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (handle) await atomicJson(join(root, "browser.json"), handle);
  return root;
}

test("a valid owned page creates nothing and does not inspect unrelated tab URLs or change focus", async (t) => {
  const root = await browserFixture(t);
  const calls = [];
  const services = servicesFor({ apple: async (lines) => { calls.push(lines); return observed(); } });
  assert.deepEqual(await ownedTab(root, initialUrl, undefined, services), originalTab);
  assert.deepEqual(await ownedTab(root, initialUrl, undefined, services), originalTab);
  assert.equal(calls.length, 2);
  assert.ok(!calls.flat().some((line) => /make new|set URL|activate|URL of browserTab/.test(line)));
  const context = await readJson(join(root, "browser-context.json"));
  assert.deepEqual(context, { version: 1, process: chromeProcess, phase: "bound", tab: originalTab });
});

test("missing task tab in its saved normal window recovers once with no BOSS seed, preserving focus and reentry", async (t) => {
  const root = await browserFixture(t), fresh = { windowId: 10, tabId: 12 };
  const calls = [];
  let creations = 0, checks = 0;
  const services = servicesFor({
    apple: async (lines) => {
      calls.push(lines);
      if (lines.some((line) => line.includes("make new tab"))) { creations++; return "10,12"; }
      return creations ? observed(fresh) : "missing-tab|10";
    },
    sourceReady: async (tab) => {
      checks++;
      assert.deepEqual(tab, fresh);
      assert.deepEqual(await readJson(join(root, "browser.json")), fresh);
      assert.equal((await readJson(join(root, "browser-context.json"))).phase, "created");
      return { state: "ready" };
    },
  });
  assert.deepEqual(await ownedTab(root, initialUrl, undefined, services), fresh);
  assert.deepEqual(await ownedTab(root, initialUrl, undefined, services), fresh);
  assert.equal(creations, 1);
  assert.equal(checks, 1);
  const script = calls.find((lines) => lines.some((line) => line.includes("make new tab"))).join("\n");
  assert.match(script, /if mode of sourceWindow is not "normal"/);
  assert.match(script, /if \(id of active tab of sourceWindow\) is createdId then/);
  assert.match(script, /set active tab index of sourceWindow to tabIndex/);
  assert.doesNotMatch(script, /activate|make new window|set URL/);
  assert.match(await readFile(join(root, "logs/scheduler.jsonl"), "utf8"), /browser-task-tab-recovered/);
});

test("a moved owned tab is found before replacing it whether its old window survives or disappears", async (t) => {
  const root = await browserFixture(t), moved = { windowId: 20, tabId: 11 };
  await atomicJson(join(root, "browser-context.json"), { version: 1, process: chromeProcess, phase: "bound", tab: originalTab });
  const result = await ownedTab(root, initialUrl, undefined, servicesFor({
    apple: async (lines) => {
      assert.ok(lines.some((line) => line.includes("exists tab id 11 of sourceWindow")));
      assert.ok(lines.findIndex((line) => line.includes('return "missing-tab')) > lines.indexOf("end repeat"));
      assert.ok(!lines.some((line) => line.includes("make new tab")));
      return observed(moved);
    },
  }));
  assert.deepEqual(result, moved);
  assert.deepEqual(await readJson(join(root, "browser.json")), moved);
});

test("unavailable GUI or missing original window never falls back to an unproven window/profile", async (t) => {
  for (const [result, code] of [["no-windows", "chrome-gui-unavailable"], ["missing-window", "browser-owner-window-missing"]]) {
    const root = await browserFixture(t);
    await assert.rejects(ownedTab(root, initialUrl, undefined, servicesFor({
      contextTimeoutMs: 0, apple: async (lines) => {
        assert.ok(!lines.some((line) => line.includes("make new")));
        return result;
      },
    })), { code });
    assert.deepEqual(await readJson(join(root, "browser.json")), originalTab);
    assert.equal(await readJson(join(root, "browser-context.json"), null), null);
  }
});

test("transient GUI restoration is rechecked boundedly rather than interpreted as a missing tab", async (t) => {
  const root = await browserFixture(t);
  let calls = 0;
  const result = await ownedTab(root, initialUrl, undefined, servicesFor({
    apple: async (lines) => {
      assert.ok(!lines.some((line) => line.includes("make new")));
      if (++calls === 1) throw new RunError("chrome-gui-unavailable", "TEST_ONLY");
      if (calls === 2) return "no-windows";
      return observed();
    },
  }));
  assert.equal(calls, 3);
  assert.deepEqual(result, originalTab);
});

test("unexpected navigation and Apple Events denial do not trigger tab recovery", async (t) => {
  const root = await browserFixture(t);
  for (const url of ["https://example.invalid/", "https://www.zhipin.com/web/geek/jobs-other", "https://www.zhipin.com/web/user/login"]) {
    await assert.rejects(ownedTab(root, initialUrl, undefined, servicesFor({
      apple: async () => observed(originalTab, url),
    })), { code: "unexpected-owned-tab" });
  }
  for (const code of ["apple-events-denied", "apple-events-javascript-disabled", "browser-access-failed", "browser-context-unavailable"]) {
    await assert.rejects(ownedTab(root, initialUrl, undefined, servicesFor({
      apple: async () => { throw new RunError(code, "TEST_ONLY", { blocked: true }); },
    })), { code });
  }
  assert.deepEqual(await readJson(join(root, "browser.json")), originalTab);
});

test("new task pages verify source login/captcha and keep a safe handle instead of creating another on failure", async (t) => {
  for (const code of ["login-required", "captcha", "source-error"]) {
    const root = await browserFixture(t), fresh = { windowId: 10, tabId: 12 };
    let creations = 0, blocked = true;
    const services = servicesFor({
      apple: async (lines) => {
        if (lines.some((line) => line.includes("make new tab"))) { creations++; return "10,12"; }
        return creations ? observed(fresh) : "missing-tab|10";
      },
      sourceReady: async () => {
        if (blocked) throw new RunError(code, "TEST_ONLY", { blocked: true });
        return { state: "ready" };
      },
    });
    await assert.rejects(ownedTab(root, initialUrl, undefined, services), { code });
    assert.equal((await readJson(join(root, "browser-context.json"))).phase, "created");
    assert.deepEqual(await readJson(join(root, "browser.json")), fresh);
    await assert.rejects(ownedTab(root, initialUrl, undefined, services), { code });
    assert.equal(creations, 1);
    blocked = false;
    assert.deepEqual(await ownedTab(root, initialUrl, undefined, services), fresh);
    assert.equal(creations, 1);
  }
});

test("blank navigation is not a source-ready success and normal source guards run only on the created public page", async (t) => {
  const root = await browserFixture(t), fresh = { windowId: 10, tabId: 12 };
  let creations = 0, reads = 0, evaluations = 0;
  const result = await ownedTab(root, initialUrl, undefined, servicesFor({
    apple: async (lines) => {
      if (lines.some((line) => line.includes("make new tab"))) { creations++; return "10,12"; }
      if (!creations) return "missing-tab|10";
      return observed(fresh, ++reads === 1 ? "about:blank" : initialUrl);
    },
    evaluatePage: async (tab, _url, fn) => {
      evaluations++;
      assert.deepEqual(tab, fresh);
      assert.equal(fn, cardsInPage);
      return { state: "ready" };
    },
  }));
  assert.deepEqual(result, fresh);
  assert.equal(reads, 2);
  assert.equal(evaluations, 1);
  assert.equal(creations, 1);
});

test("ambiguous creation failure is durable and cannot leak duplicate tabs on later calls", async (t) => {
  const root = await browserFixture(t);
  let creations = 0;
  const services = servicesFor({
    apple: async (lines) => {
      if (lines.some((line) => line.includes("make new tab"))) {
        creations++;
        throw new RunError("chrome-gui-unavailable", "TEST_ONLY ambiguous reply");
      }
      return "missing-tab|10";
    },
  });
  await assert.rejects(ownedTab(root, initialUrl, undefined, services), { code: "chrome-gui-unavailable" });
  assert.equal((await readJson(join(root, "browser-context.json"))).phase, "creating");
  await assert.rejects(ownedTab(root, initialUrl, undefined, services), { code: "browser-recovery-unconfirmed" });
  assert.equal(creations, 1);
  assert.deepEqual(await readJson(join(root, "browser.json")), originalTab);
});

test("cancellation after confirmed creation retains only that task handle for later verification", async (t) => {
  const root = await browserFixture(t), controller = new AbortController(), fresh = { windowId: 10, tabId: 12 };
  let created = 0;
  const services = servicesFor({
    apple: async (lines) => {
      if (lines.some((line) => line.includes("make new tab"))) { created++; return "10,12"; }
      return created ? observed(fresh) : "missing-tab|10";
    },
    sourceReady: async () => {
      controller.abort(new RunError("cancelled", "TEST_ONLY"));
      return { state: "waiting" };
    },
  });
  await assert.rejects(ownedTab(root, initialUrl, controller.signal, services), { code: "cancelled" });
  assert.deepEqual(await readJson(join(root, "browser.json")), fresh);
  assert.equal((await readJson(join(root, "browser-context.json"))).phase, "created");
  assert.deepEqual(await ownedTab(root, initialUrl, undefined, {
    ...services, sourceReady: async () => ({ state: "ready" }),
  }), fresh);
  assert.equal(created, 1);
});

test("initial task binding still uses an explicitly opened source window and validates the new page", async (t) => {
  const root = await browserFixture(t, null);
  let discovered = 0, created = 0, checked = 0;
  const fresh = await ownedTab(root, initialUrl, undefined, servicesFor({
    discoverBoss: async () => { discovered++; return { windowId: 20, tabId: 21 }; },
    apple: async (lines) => {
      assert.ok(lines.some((line) => line.includes("set sourceWindow to window id 20")));
      assert.ok(!lines.some((line) => /set URL|activate|make new window/.test(line)));
      created++;
      return "20,22";
    },
    sourceReady: async () => { checked++; return { state: "ready" }; },
  }));
  assert.deepEqual(fresh, { windowId: 20, tabId: 22 });
  assert.equal(discovered, 1);
  assert.equal(created, 1);
  assert.equal(checked, 1);
});

test("Chrome restart, insecure context metadata and missing initial user context fail closed", async (t) => {
  const root = await browserFixture(t);
  await atomicJson(join(root, "browser-context.json"), {
    version: 1, process: { ...chromeProcess, pid: 22222 }, phase: "bound", tab: originalTab,
  });
  await assert.rejects(ownedTab(root, initialUrl, undefined, servicesFor({
    apple: async () => assert.fail("A restarted process must not silently inherit an old binding."),
  })), { code: "browser-context-changed" });
  await chmod(join(root, "browser-context.json"), 0o644);
  await assert.rejects(ownedTab(root, initialUrl, undefined, servicesFor()), { code: "private-permissions" });
  const fresh = await browserFixture(t, null);
  await assert.rejects(ownedTab(fresh, initialUrl, undefined, servicesFor({
    discoverBoss: async () => { throw new RunError("boss-tab-required", "Initial source context is missing."); },
  })), { code: "boss-tab-required" });
});

test("ordinary Chrome instance probe rejects absent, multiple, automation-profile and wrong-user processes", async () => {
  const probe = async (_program, args) => {
    if (args[0] === "-x") return String(chromeProcess.pid);
    if (args.at(-1) === "args=") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return `${process.getuid()} ${chromeProcess.startedAt} /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
  };
  assert.deepEqual(await ordinaryChromeInstance(undefined, probe), chromeProcess);
  await assert.rejects(ordinaryChromeInstance(undefined, async () => {
    const error = new Error("TEST_ONLY"); error.exitCode = 1; error.stderr = ""; throw error;
  }), { code: "chrome-not-running" });
  await assert.rejects(ordinaryChromeInstance(undefined, async () => "11\n22"), { code: "browser-context-ambiguous" });
  for (const flag of ["--headless", "--user-data-dir=/TEST_ONLY", "--remote-debugging-port=1234", "--enable-automation"]) {
    await assert.rejects(ordinaryChromeInstance(undefined, async (program, args) =>
      args.at(-1) === "args=" ? `Google Chrome ${flag}` : probe(program, args)), { code: "browser-context-ambiguous" });
  }
  await assert.rejects(ordinaryChromeInstance(undefined, async (program, args) =>
    args.at(-1) === "uid=,lstart=,comm=" ? `999999 ${chromeProcess.startedAt} /Applications/Google Chrome.app/Contents/MacOS/Google Chrome` : probe(program, args)),
  { code: "browser-context-ambiguous" });
});

test("Apple Events errors distinguish GUI unavailability from permission and navigation failures", () => {
  for (const [error, code] of [
    [{ stderr: "Not authorized to send Apple events. (-1743)" }, "apple-events-denied"],
    [{ stderr: "Executing JavaScript through AppleScript is turned off" }, "apple-events-javascript-disabled"],
    [{ stderr: "Connection is invalid (-609)" }, "chrome-gui-unavailable"],
    [{ code: "command-timeout" }, "chrome-gui-unavailable"],
    [{ stderr: "Can't get window id 123 (-1728)" }, "chrome-window-unavailable"],
    [{ stderr: "unexpected-owned-tab" }, "unexpected-owned-tab"],
    [{ stderr: "non-normal-window" }, "browser-context-unavailable"],
  ]) assert.equal(appleErrorCode(error), code);
});
