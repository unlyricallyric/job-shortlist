import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "./process.mjs";
import { RunError, atomicJson, readJson } from "./io.mjs";

const searchOrigin = "https://www.zhipin.com";
const searchPath = "/web/geek/jobs";

export function searchUrl(query) {
  if (!query || typeof query.term !== "string" || !/[\u3400-\u9fff]/u.test(query.term)
    || /[A-Za-z]/.test(query.term) || query.term.length > 40) {
    throw new RunError("invalid-query", "Search queries must use bounded Chinese duty terms.");
  }
  const url = new URL(searchPath, searchOrigin);
  url.searchParams.set("query", query.term);
  url.searchParams.set("city", "101020100");
  if (query.industry !== null && query.industry !== undefined) {
    if (!["100021", "100029", "100016"].includes(query.industry)) throw new RunError("invalid-query", "Unsupported industry filter.");
    url.searchParams.set("industry", query.industry);
  }
  return url.href;
}

export function pageGuard(expectedUrl) {
  if (location.origin !== "https://www.zhipin.com" || location.pathname !== "/web/geek/jobs") {
    return { state: "blocked", code: "unexpected-page" };
  }
  if (expectedUrl) {
    const wanted = new URL(expectedUrl);
    if (["query", "city", "industry"].some((key) => new URL(location.href).searchParams.get(key) !== wanted.searchParams.get(key))) {
      return { state: "waiting", code: "navigation-pending" };
    }
  }
  const visible = (node) => node && node.getClientRects().length > 0;
  for (const selector of [".verify-wrap", ".captcha-box", "#captcha", "[class*='geetest']", ".verify-page"]) {
    if ([...document.querySelectorAll(selector)].some(visible)) return { state: "blocked", code: "captcha" };
  }
  for (const selector of [".sign-dialog", ".login-dialog", ".login-register", ".login-page"]) {
    if ([...document.querySelectorAll(selector)].some(visible)) return { state: "blocked", code: "login-required" };
  }
  // Only inspect public result/error containers; never read the account panel or body text.
  const text = [...document.querySelectorAll(".job-list-box,.job-list-container,.job-empty-wrapper,.job-empty-box,.error-content,.error-page,.tip-box,.search-job-result")]
    .map((node) => node.innerText).join("\n");
  if (/安全验证|访问过于频繁|请完成验证|操作频繁|异常访问/.test(text)) return { state: "blocked", code: "captcha" };
  if (/网络异常|服务异常|系统繁忙|加载失败/.test(text)) return { state: "error", code: "source-error" };
  return { state: "ok" };
}

export function cardsInPage() {
  const cards = [];
  for (const anchor of document.querySelectorAll("a.job-name")) {
    const card = anchor.closest("li.job-card-box");
    if (!card) return { state: "error", code: "card-structure-changed" };
    const url = new URL(anchor.href);
    const id = /^\/job_detail\/([A-Za-z0-9_~-]+)\.html$/.exec(url.pathname)?.[1];
    if (url.origin !== "https://www.zhipin.com" || !id) return { state: "error", code: "unexpected-job-link" };
    const tags = [...card.querySelectorAll("li")].map((node) => node.innerText.trim());
    const salary = card.querySelector(".job-salary")?.innerText.trim() ?? null;
    cards.push({
      id: `boss-${id}`, title: anchor.innerText.trim(),
      company: card.querySelector(".boss-name")?.innerText.trim() ?? null,
      location: card.querySelector(".company-location")?.innerText.trim() ?? null,
      experienceText: tags.find((text) => /年|经验不限|应届/.test(text)) ?? null,
      educationText: tags.find((text) => /本科|大专|专科|硕士|博士|高中|中专|学历/.test(text)) ?? null,
      url: url.origin + url.pathname,
      salaryText: salary && !/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(salary) ? salary : null,
    });
  }
  if (cards.length) return { state: "ready", cards, retrievedAt: new Date().toISOString() };
  const emptyText = [...document.querySelectorAll(".job-list-box,.job-list-container,.job-empty,.job-empty-wrapper,.job-empty-box,.data-empty,.search-job-result")]
    .filter((node) => node.getClientRects().length > 0)
    .map((node) => node.innerText).join("\n");
  if (/没有找到相关职位|暂无符合条件的职位|暂无相关职位/.test(emptyText)) {
    return { state: "ready", cards: [], empty: true, retrievedAt: new Date().toISOString() };
  }
  return { state: "waiting" };
}

export function openCardInPage(id, title) {
  const rawId = id.slice("boss-".length);
  const anchor = [...document.querySelectorAll("a.job-name")].find((node) => {
    const url = new URL(node.href);
    return url.origin === "https://www.zhipin.com" && url.pathname === `/job_detail/${rawId}.html`
      && node.innerText.trim() === title;
  });
  if (!anchor) return { state: "error", code: "card-disappeared" };
  anchor.click();
  return { state: "opened" };
}

export function detailInPage(id, title) {
  const link = document.querySelector(".job-detail-body a.more-job-btn");
  const description = document.querySelector(".job-detail-body .desc");
  const header = document.querySelector(".job-detail-info");
  if (!link || !description || !header) return { state: "waiting" };
  const url = new URL(link.href);
  const actualTitle = header.innerText.split("\n")[0].trim();
  if (url.origin !== "https://www.zhipin.com" || url.pathname !== `/job_detail/${id.slice(5)}.html`
    || actualTitle !== title) return { state: "waiting" };
  const jd = description.innerText.trim();
  if (jd.length < 80) return { state: "waiting" };
  if (jd.length > 60000) return { state: "error", code: "jd-too-large" };
  return { state: "ready", jd, retrievedAt: new Date().toISOString() };
}

async function apple(lines, signal) {
  try {
    return await command("/usr/bin/osascript", ["-"], {
      input: [
        'if application "Google Chrome" is not running then error "chrome-not-running"',
        'tell application "Google Chrome"', ...lines, "end tell",
      ].join("\n"),
      signal, timeout: 20000,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const detail = error.stderr ?? "";
    const code = /not authorized|not permitted|1002|1743|Apple events.*not allowed/i.test(detail) ? "apple-events-denied"
      : /JavaScript.*Apple|Apple.*JavaScript/i.test(detail) ? "apple-events-javascript-disabled"
      : /chrome-not-running/.test(detail) ? "chrome-not-running" : "browser-access-failed";
    throw new RunError(code, "Ordinary Chrome source access is unavailable; check the local browser permissions.", { blocked: true, cause: error });
  }
}

function tabLines(tab) {
  if (!Number.isSafeInteger(tab.windowId) || !Number.isSafeInteger(tab.tabId)) throw new RunError("invalid-tab", "Invalid task-owned browser handle.");
  return [
    `set targetTab to tab id ${tab.tabId} of window id ${tab.windowId}`,
    'if (URL of targetTab) does not start with "https://www.zhipin.com/web/geek/jobs" then error "unexpected-owned-tab"',
  ];
}

export async function discoverBoss(signal) {
  const result = await apple([
    "repeat with browserWindow in windows",
    "repeat with browserTab in tabs of browserWindow",
    'if (URL of browserTab) starts with "https://www.zhipin.com/" then',
    'return (id of browserWindow as text) & "," & (id of browserTab as text)',
    "end if", "end repeat", "end repeat", 'return "not-found"',
  ], signal);
  if (result === "not-found") throw new RunError("boss-tab-required", "Open an authenticated BOSS public search tab in ordinary Chrome.", { blocked: true });
  const [windowId, tabId] = result.split(",").map(Number);
  if (!Number.isSafeInteger(windowId) || !Number.isSafeInteger(tabId)) throw new RunError("invalid-tab", "Chrome returned an invalid tab handle.");
  return { windowId, tabId };
}

async function ownedTab(root, initialUrl, signal) {
  const existing = await readJson(join(root, "browser.json"), null);
  if (existing) {
    // A user-navigated or closed owned tab is a blocker, not permission to reuse another tab.
    await apple([...tabLines(existing), "return URL of targetTab"], signal);
    return existing;
  }
  const source = await discoverBoss(signal);
  const result = await apple([
    `set sourceWindow to window id ${source.windowId}`,
    "set originalIndex to active tab index of sourceWindow",
    `set ownedTab to make new tab at end of tabs of sourceWindow with properties {URL:${JSON.stringify(initialUrl)}}`,
    "set createdId to id of ownedTab",
    "set active tab index of sourceWindow to originalIndex",
    'return (id of sourceWindow as text) & "," & (createdId as text)',
  ], signal);
  const [windowId, tabId] = result.split(",").map(Number);
  const tab = { windowId, tabId };
  tabLines(tab);
  await atomicJson(join(root, "browser.json"), tab);
  return tab;
}

export async function evaluatePage(tab, expectedUrl, fn, args = [], signal) {
  const script = `(() => { const guard = (${pageGuard.toString()})(${JSON.stringify(expectedUrl)}); if (guard.state !== "ok") return JSON.stringify(guard); return JSON.stringify((${fn.toString()})(...${JSON.stringify(args)})); })()`;
  const output = await apple([...tabLines(tab), `execute targetTab javascript ${JSON.stringify(script)}`], signal);
  let result;
  try {
    result = JSON.parse(output);
  } catch (error) {
    if (error instanceof SyntaxError) throw new RunError("browser-result-invalid", "The public source did not return a structured result.", { blocked: true });
    throw error;
  }
  if (result.state === "blocked" || result.state === "error") {
    throw new RunError(result.code, "The source blocked access or changed its public result structure.", { blocked: result.state === "blocked" });
  }
  return result;
}

async function waitPage(read, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await read();
    if (result.state === "ready") return result;
    await delay(1200, undefined, { signal });
  }
  throw new RunError("source-timeout", "No complete public result became readable; previous data is retained.", { blocked: true });
}

export async function collectBoss({ root, queries, limits, prefilter, signal, onEvidence }) {
  const tab = await ownedTab(root, searchUrl(queries[0]), signal);
  const cards = new Map(), details = new Map(), queryResults = [];
  for (const query of queries) {
    signal.throwIfAborted();
    const url = searchUrl(query);
    await apple([...tabLines(tab), `set URL of targetTab to ${JSON.stringify(url)}`], signal);
    await delay(1800, undefined, { signal });
    const result = await waitPage(() => evaluatePage(tab, url, cardsInPage, [], signal), 45000, signal);
    const inspected = result.cards.slice(0, Math.min(limits.cardsPerQuery, Math.max(0, limits.maxCards - cards.size)));
    for (const card of inspected) cards.set(card.id, { ...card, retrievedAt: result.retrievedAt });
    queryResults.push({ term: query.term, industry: query.industry ?? null, count: inspected.length, empty: result.empty === true });
    await onEvidence({ cards: [...cards.values()], details: [...details.values()], queries: queryResults, complete: false });
    for (const card of inspected) {
      if (details.size >= limits.maxDetails) break;
      if (details.has(card.id) || !prefilter(card).eligible) continue;
      await evaluatePage(tab, url, openCardInPage, [card.id, card.title], signal);
      const detail = await waitPage(() => evaluatePage(tab, url, detailInPage, [card.id, card.title], signal), 40000, signal);
      details.set(card.id, { ...card, jd: detail.jd, retrievedAt: detail.retrievedAt });
      await onEvidence({ cards: [...cards.values()], details: [...details.values()], queries: queryResults, complete: false });
      await delay(1500, undefined, { signal });
    }
    if (cards.size >= limits.maxCards) break;
    await delay(1800, undefined, { signal });
  }
  const result = { cards: [...cards.values()], details: [...details.values()], queries: queryResults, complete: true };
  await onEvidence(result);
  return result;
}
