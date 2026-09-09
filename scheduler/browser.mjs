import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "./process.mjs";
import { RunError, atomicJson, readJson } from "./io.mjs";
import { emptyReadHistory, planDetailReads, isDueRecheck } from "./coverage.mjs";

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
    if (!["100021", "100029", "100016", "100023"].includes(query.industry)) throw new RunError("invalid-query", "Unsupported industry filter.");
    url.searchParams.set("industry", query.industry);
  }
  if (query.position !== null && query.position !== undefined) {
    if (!["140101", "140109", "140506", "140505", "140111"].includes(query.position)) {
      throw new RunError("invalid-query", "Unsupported native position filter.");
    }
    url.searchParams.set("position", query.position);
  }
  return url.href;
}

export function pageGuard(expectedUrl) {
  if (location.origin !== "https://www.zhipin.com" || location.pathname !== "/web/geek/jobs") {
    return { state: "blocked", code: "unexpected-page" };
  }
  if (expectedUrl) {
    const wanted = new URL(expectedUrl);
    if (["query", "city", "industry", "position"].some((key) => new URL(location.href).searchParams.get(key) !== wanted.searchParams.get(key))) {
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
    || !actualTitle) return { state: "waiting" };
  if (actualTitle !== title) return { state: "identity-conflict", code: "detail-title-conflict", actualTitle };
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

export async function ownedTab(root, initialUrl, signal, services = {}) {
  const execute = services.apple ?? apple;
  const discover = services.discoverBoss ?? discoverBoss;
  const existing = await readJson(join(root, "browser.json"), null);
  if (existing) {
    tabLines(existing);
    const target = await execute([
      `if not (exists window id ${existing.windowId}) then return "missing-window"`,
      `if not (exists tab id ${existing.tabId} of window id ${existing.windowId}) then return "missing-tab"`,
      `return URL of tab id ${existing.tabId} of window id ${existing.windowId}`,
    ], signal);
    if (!["missing-window", "missing-tab"].includes(target)) {
      let url;
      try {
        url = new URL(target);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new RunError("unexpected-owned-tab", "The task-owned tab is no longer on the public BOSS search page.", { blocked: true });
      }
      if (url.origin !== searchOrigin || url.pathname !== searchPath) {
        throw new RunError("unexpected-owned-tab", "The task-owned tab was navigated elsewhere; no other tab will be reused.", { blocked: true });
      }
      return existing;
    }
  }
  // Only a missing handle is recoverable. Permission, login and navigation failures are not.
  const source = await discover(signal);
  const result = await execute([
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

export async function waitPage(read, timeoutMs, signal, { allowIdentityConflict = false, intervalMs = 1200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let conflictTitle = null, conflicts = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await read();
    if (result.state === "ready") return result;
    if (allowIdentityConflict && result.state === "identity-conflict") {
      conflicts = result.actualTitle === conflictTitle ? conflicts + 1 : 1;
      conflictTitle = result.actualTitle;
      if (conflicts >= 3) return { state: "identity-conflict", code: result.code };
    } else {
      conflictTitle = null;
      conflicts = 0;
    }
    await delay(intervalMs, undefined, { signal });
  }
  throw new RunError("source-timeout", "No complete public result became readable; previous data is retained.", { blocked: true });
}

export async function collectBoss({
  root, queries, limits, prefilter, signal, onEvidence,
  knownDetailIds = [], readHistory = emptyReadHistory(), priorityFor = () => 0, services = {},
}) {
  const operations = {
    ownedTab,
    search: async (tab, url) => {
      await apple([...tabLines(tab), `set URL of targetTab to ${JSON.stringify(url)}`], signal);
      await delay(1800, undefined, { signal });
      return waitPage(() => evaluatePage(tab, url, cardsInPage, [], signal), 45000, signal);
    },
    detail: async (tab, url, card) => {
      await evaluatePage(tab, url, openCardInPage, [card.id, card.title], signal);
      return waitPage(() => evaluatePage(tab, url, detailInPage, [card.id, card.title], signal), 40000, signal,
        { allowIdentityConflict: true });
    },
    pause: () => delay(1500, undefined, { signal }),
    ...services,
  };
  const tab = await operations.ownedTab(root, searchUrl(queries[0]), signal);
  const cards = new Map(), details = new Map(), detailConflicts = new Map(), queryResults = [];
  const querySeen = queries.map(() => new Set());
  const pools = [];
  const knownIds = new Set(knownDetailIds);
  const now = Date.now();
  let recheckDone = false;
  const progress = (complete) => ({ cards: [...cards.values()], details: [...details.values()],
    detailConflicts: [...detailConflicts.values()], queries: queryResults, complete });
  const inspect = (result, index) => {
    if (result.state !== "ready" || !Array.isArray(result.cards) || (!result.cards.length && result.empty !== true)) {
      throw new RunError("source-not-ready", "A query did not reach a verified cards or explicit empty state.", { blocked: true });
    }
    const inspected = [];
    for (const card of result.cards.slice(0, limits.cardsPerQuery)) {
      if (!querySeen[index].has(card.id) && querySeen[index].size >= limits.cardsPerQuery) continue;
      if (!cards.has(card.id) && cards.size >= limits.maxCards) continue;
      querySeen[index].add(card.id);
      const observation = { ...card, retrievedAt: result.retrievedAt };
      cards.set(card.id, observation);
      inspected.push(observation);
    }
    return inspected;
  };
  for (const [index, query] of queries.entries()) {
    signal.throwIfAborted();
    const result = await operations.search(tab, searchUrl(query));
    const inspected = inspect(result, index);
    pools.push(inspected.filter((card) => prefilter(card).eligible));
    queryResults.push({ term: query.term, industry: query.industry ?? null, position: query.position ?? null, count: inspected.length,
      empty: result.empty === true, allocated: 0, detailsRead: 0, unreadDetails: 0, recheckedDetails: 0, detailConflicts: 0, visits: 1 });
    await onEvidence(progress(false));
    await operations.pause();
  }
  // Visit every query before assigning the shared budget. One bounded refill pass borrows unused allocations.
  for (let pass = 0; pass < 2 && details.size < limits.maxDetails; pass++) {
    const plan = planDetailReads(pools, limits.maxDetails - details.size, {
      knownIds, history: readHistory, now, priorityFor, recheckDone,
      readCounts: queryResults.map((query) => query.detailsRead),
      excluded: new Set([...details.keys(), ...detailConflicts.keys()]),
    });
    if (plan.every((pool) => !pool.length)) break;
    for (const [index, assigned] of plan.entries()) {
      if (!assigned.length) continue;
      signal.throwIfAborted();
      const url = searchUrl(queries[index]);
      const fresh = inspect(await operations.search(tab, url), index);
      pools[index] = fresh.filter((card) => prefilter(card).eligible);
      const available = new Map(fresh.map((card) => [card.id, card]));
      const queryResult = queryResults[index];
      queryResult.count = querySeen[index].size;
      queryResult.visits++;
      queryResult.allocated += assigned.length;
      for (const planned of assigned) {
        if (details.size >= limits.maxDetails) break;
        const card = available.get(planned.id);
        const detail = card && card.title === planned.title
          ? await operations.detail(tab, url, card)
          : { state: "identity-conflict", code: "card-changed-on-revisit" };
        if (detail.state === "identity-conflict") {
          detailConflicts.set(planned.id, { id: planned.id, code: detail.code });
          queryResult.detailConflicts++;
        } else if (detail.state === "ready") {
          details.set(card.id, { ...card, jd: detail.jd, retrievedAt: detail.retrievedAt });
          queryResult.detailsRead++;
          if (knownIds.has(card.id)) queryResult.recheckedDetails++;
          else queryResult.unreadDetails++;
          if (isDueRecheck(card, knownIds, readHistory, now)) recheckDone = true;
        } else {
          throw new RunError("source-not-ready", "A full JD did not pass the exact identity/readiness checks.", { blocked: true });
        }
        await onEvidence(progress(false));
        await operations.pause();
      }
      await onEvidence(progress(false));
    }
  }
  const result = progress(true);
  await onEvidence(result);
  return result;
}
