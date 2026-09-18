import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "./process.mjs";
import { RunError, atomicJson, readJson, appendLog } from "./io.mjs";
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
  if (!jd || /^(?:正在)?加载|请稍(?:候|等)/u.test(jd)) return { state: "waiting" };
  if (jd.length < 80) return { state: "incomplete-detail", code: "jd-content-incomplete", incompleteText: jd };
  if (jd.length > 60000) return { state: "error", code: "jd-too-large" };
  return { state: "ready", jd, retrievedAt: new Date().toISOString() };
}

export function appleErrorCode(error) {
  const detail = error.stderr ?? "";
  if (/JavaScript.*Apple|Apple.*JavaScript/i.test(detail)) return "apple-events-javascript-disabled";
  if (/not authorized|not permitted|1002|1743|Apple events.*not allowed/i.test(detail)) return "apple-events-denied";
  if (/chrome-not-running/.test(detail)) return "chrome-not-running";
  if (/unexpected-owned-tab/.test(detail)) return "unexpected-owned-tab";
  if (/preserved-(?:chat|source)-changed/.test(detail)) return "browser-preserved-page-changed";
  if (/source-login-required/.test(detail)) return "login-required";
  if (/source-captcha-required/.test(detail)) return "captcha";
  if (/non-normal-window/.test(detail)) return "browser-context-unavailable";
  if (/owner-window-missing|Can't get (?:window|tab)|Can’t get (?:window|tab)/i.test(detail)) return "chrome-window-unavailable";
  if (error.code === "command-timeout" || /connection.*invalid|not responding|timed out|application isn.t running|\(-609\)|\(-600\)/i.test(detail)) return "chrome-gui-unavailable";
  return "browser-access-failed";
}

async function apple(lines, signal, { timeout = 20000 } = {}) {
  try {
    return await command("/usr/bin/osascript", ["-"], {
      input: [
        'if application "Google Chrome" is not running then error "chrome-not-running"',
        'tell application "Google Chrome"', ...lines, "end tell",
      ].join("\n"),
      signal, timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const code = appleErrorCode(error);
    throw new RunError(code, "Ordinary Chrome source access is unavailable; check the local browser permissions.", { blocked: true, cause: error });
  }
}

export async function ordinaryChromeInstance(signal, execute = command) {
  let ids;
  try { ids = await execute("/usr/bin/pgrep", ["-x", "Google Chrome"], { signal, timeout: 5000 }); }
  catch (error) {
    if (error.exitCode === 1 && !error.stderr?.trim()) throw new RunError("chrome-not-running", "Open ordinary Chrome before source collection.", { blocked: true });
    throw error;
  }
  const pids = ids.split(/\s+/).map(Number);
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] < 1) {
    throw new RunError("browser-context-ambiguous", "A single ordinary Chrome instance is required; no browser was opened.", { blocked: true });
  }
  const pid = pids[0], options = { signal, timeout: 5000, env: { LC_ALL: "C" } };
  const [identity, args] = await Promise.all([
    execute("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,comm="], options),
    execute("/bin/ps", ["-p", String(pid), "-o", "args="], options),
  ]);
  const match = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(identity);
  if (!match || Number(match[1]) !== process.getuid() || !match[3].endsWith("/Google Chrome.app/Contents/MacOS/Google Chrome")
    || /--(?:user-data-dir|headless|remote-debugging|enable-automation|test-type)\b/.test(args)) {
    throw new RunError("browser-context-ambiguous", "Chrome's ordinary user context cannot be confirmed; no profile was launched or changed.", { blocked: true });
  }
  return { pid, startedAt: match[2].replace(/\s+/g, " ") };
}

function tabLines(tab) {
  if (!Number.isSafeInteger(tab.windowId) || !Number.isSafeInteger(tab.tabId) || tab.windowId < 1 || tab.tabId < 1) throw new RunError("invalid-tab", "Invalid task-owned browser handle.");
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

function ownedInspection(tab) {
  return [
    "set originalWindowPresent to false",
    `if exists window id ${tab.windowId} then`,
    "set originalWindowPresent to true",
    `set sourceWindow to window id ${tab.windowId}`,
    'if mode of sourceWindow is not "normal" then error "non-normal-window"',
    `if exists tab id ${tab.tabId} of sourceWindow then`,
    `return "owned|" & (id of sourceWindow as text) & "|${tab.tabId}|" & URL of tab id ${tab.tabId} of sourceWindow`,
    "end if",
    "end if",
    // A moved task tab proves its context; unrelated tabs' URLs and content are not inspected.
    "repeat with sourceWindow in windows",
    `if exists tab id ${tab.tabId} of sourceWindow then`,
    'if mode of sourceWindow is not "normal" then error "non-normal-window"',
    `return "owned|" & (id of sourceWindow as text) & "|${tab.tabId}|" & URL of tab id ${tab.tabId} of sourceWindow`,
    "end if", "end repeat",
    `if originalWindowPresent then return "missing-tab|${tab.windowId}"`,
    'if (count of windows) is 0 then return "no-windows"',
    'return "missing-window"',
  ];
}

function parseInspection(value) {
  const match = /^owned\|(\d+)\|(\d+)\|([\s\S]+)$/.exec(value);
  if (match) {
    const tab = { windowId: Number(match[1]), tabId: Number(match[2]) };
    tabLines(tab);
    return { kind: "owned", tab, url: match[3] };
  }
  if (/^missing-tab\|\d+$/.test(value)) return { kind: "missing-tab" };
  if (["missing-window", "no-windows"].includes(value)) return { kind: value };
  throw new RunError("browser-result-invalid", "Unexpected Chrome window metadata; no task tab was created.", { blocked: true });
}

const sourceAuthRoutes = [
  { roots: ["/web/user", "/web/geek/login", "/web/geek/signup", "/passport"], code: "login-required", marker: "source-login-required" },
  { roots: ["/web/common/security-check", "/web/common/verify", "/web/common/captcha", "/web/geek/verify", "/web/geek/captcha"],
    code: "captcha", marker: "source-captcha-required" },
];
const authPathMatches = (path, root) => path === root || path.startsWith(`${root}/`) || path === `${root}.html`;

function ownedPageKind(value) {
  let url;
  try {
    if (typeof value !== "string" || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("Invalid source URL.");
    url = new URL(value);
  }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new RunError("unexpected-owned-tab", "The task tab is no longer on a public BOSS search page.", { blocked: true });
  }
  if (url.origin !== searchOrigin || url.username || url.password) {
    throw new RunError("unexpected-owned-tab", "The task tab was navigated elsewhere; it will not be overwritten.", { blocked: true });
  }
  const authentication = sourceAuthRoutes.find((route) => route.roots.some((root) => authPathMatches(url.pathname, root)));
  if (authentication) {
    throw new RunError(authentication.code, "The source route requires human authentication; no further replacement will be opened.", { blocked: true });
  }
  if (url.pathname === searchPath) return "search";
  return "source-page";
}

function requireSearchPage(value) {
  if (ownedPageKind(value) !== "search") {
    throw new RunError("unexpected-owned-tab", "A readable public search page is required; this page will not be navigated.", { blocked: true });
  }
}

function preservedSourceGuard(tab) {
  const origins = [searchOrigin, `${searchOrigin}:443`];
  return [
    `if not (exists tab id ${tab.tabId} of sourceWindow) then error "preserved-source-changed"`,
    `set preservedSourceUrl to URL of tab id ${tab.tabId} of sourceWindow`,
    "set preservedSourcePath to missing value",
    ...origins.flatMap((origin) => [
      `if preservedSourceUrl is ${JSON.stringify(origin)} then set preservedSourcePath to "/"`,
      `if preservedSourceUrl starts with ${JSON.stringify(`${origin}/`)} then set preservedSourcePath to text ${origin.length + 1} thru -1 of preservedSourceUrl`,
    ]),
    'if preservedSourcePath is missing value then error "preserved-source-changed"',
    "set savedDelimiters to AppleScript's text item delimiters",
    'set AppleScript\'s text item delimiters to "?"',
    "set preservedSourcePath to text item 1 of preservedSourcePath",
    'set AppleScript\'s text item delimiters to "#"',
    "set preservedSourcePath to text item 1 of preservedSourcePath",
    "set AppleScript's text item delimiters to savedDelimiters",
    ...sourceAuthRoutes.flatMap(({ roots, marker }) => roots.map((root) =>
      `if preservedSourcePath is ${JSON.stringify(root)} or preservedSourcePath starts with ${JSON.stringify(`${root}/`)} or preservedSourcePath is ${JSON.stringify(`${root}.html`)} then error ${JSON.stringify(marker)}`)),
  ];
}

const sameTab = (a, b) => a?.windowId === b?.windowId && a?.tabId === b?.tabId;
const sameProcess = (a, b) => a.pid === b.pid && a.startedAt === b.startedAt;

async function loadBrowserContext(root) {
  const path = join(root, "browser-context.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new RunError("private-permissions", "Browser recovery metadata must be a private regular file.");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const value = await readJson(path);
  if (!value || Object.keys(value).length !== 4 || value.version !== 1 || !["bound", "creating", "created"].includes(value.phase)
    || !value.process || Object.keys(value.process).length !== 2 || !Number.isSafeInteger(value.process.pid) || value.process.pid < 1
    || typeof value.process.startedAt !== "string" || !/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value.process.startedAt)
    || (value.phase === "creating" && value.tab !== null)
    || (value.phase !== "creating" && (!value.tab || !Number.isSafeInteger(value.tab.windowId) || !Number.isSafeInteger(value.tab.tabId)))) {
    throw new RunError("browser-context-invalid", "Browser recovery metadata is invalid; inspect the task binding.", { blocked: true });
  }
  return value;
}

// Caller holds the existing scheduler mutex. A saved normal window, not a BOSS seed, identifies recovery context.
export async function ownedTab(root, initialUrl, signal, services = {}) {
  const execute = services.apple ?? apple;
  const discover = services.discoverBoss ?? discoverBoss;
  const instance = services.instance ?? ordinaryChromeInstance;
  const pause = services.pause ?? ((ms) => delay(ms, undefined, { signal }));
  const contextTimeoutMs = services.contextTimeoutMs ?? 12000;
  const startedAt = Date.now(), process = await instance(signal);
  const existing = await readJson(join(root, "browser.json"), null);
  const context = await loadBrowserContext(root);
  if (context?.phase === "creating") {
    throw new RunError("browser-recovery-unconfirmed", "A previous tab-creation result is unknown; inspect it before creating another tab.", { blocked: true });
  }
  if (context && (context.phase === "created" || sameTab(existing, context.tab)) && !sameProcess(context.process, process)) {
    throw new RunError("browser-context-changed", "Chrome restarted or changed context; explicitly confirm the new task binding.", { blocked: true });
  }
  let tab = context?.phase === "created" ? context.tab : existing;
  const saveContext = (phase, handle) => atomicJson(join(root, "browser-context.json"), { version: 1, process, phase, tab: handle });
  const confirmProcess = async () => {
    if (!sameProcess(process, await instance(signal))) throw new RunError("browser-context-changed", "Chrome changed during recovery; no second tab will be created.", { blocked: true });
  };
  const waitContext = async (handle) => {
    const deadline = Date.now() + contextTimeoutMs;
    let last = null;
    do {
      signal?.throwIfAborted();
      try {
        const result = parseInspection(await execute(ownedInspection(handle), signal, { timeout: 5000 }));
        if (result.kind === "owned" || (result.kind === "missing-tab" && last?.kind === "missing-tab")) return result;
        last = result;
      } catch (error) {
        if (!["chrome-gui-unavailable", "chrome-window-unavailable"].includes(error.code)) throw error;
        last = { kind: "gui-unavailable" };
      }
      if (Date.now() >= deadline) break;
      await pause(Math.min(750, Math.max(0, deadline - Date.now())));
      await confirmProcess();
    } while (Date.now() <= deadline);
    throw new RunError(last?.kind === "missing-window" ? "browser-owner-window-missing" : "chrome-gui-unavailable",
      "The original normal Chrome window is unavailable. Sleeping/locked/restoring GUI or a different profile cannot be assumed safe.", { blocked: true });
  };
  try {
    let inspection, preservedPage = null;
    if (tab) {
      tabLines(tab);
      inspection = await waitContext(tab);
      if (inspection.kind === "owned" && context?.phase !== "created") {
        const kind = ownedPageKind(inspection.url);
        await confirmProcess();
        if (kind === "search") {
          if (!sameTab(existing, inspection.tab)) await atomicJson(join(root, "browser.json"), inspection.tab);
          if (!context || !sameTab(context.tab, inspection.tab) || !sameProcess(context.process, process)) await saveContext("bound", inspection.tab);
          return inspection.tab;
        }
        if (!context || context.phase !== "bound" || !sameTab(context.tab, existing)) {
          throw new RunError("browser-context-unavailable", "A confirmed original browser binding is required before preserving a source page.", { blocked: true });
        }
        preservedPage = inspection.tab;
      }
      if (inspection.kind === "owned") {
        tab = inspection.tab;
        if (!preservedPage && !sameTab(existing, tab)) await atomicJson(join(root, "browser.json"), tab);
      }
    }
    if (context?.phase !== "created") {
      requireSearchPage(initialUrl);
      const sourceWindow = tab?.windowId ?? (await discover(signal)).windowId;
      if (!Number.isSafeInteger(sourceWindow) || sourceWindow < 1) throw new RunError("invalid-tab", "Chrome returned an invalid source window.");
      await confirmProcess();
      if (preservedPage) {
        const current = parseInspection(await execute(ownedInspection(preservedPage), signal, { timeout: 5000 }));
        if (current.kind !== "owned" || !sameTab(current.tab, preservedPage)) {
          throw new RunError("browser-preserved-page-changed", "The original source window or tab changed during recovery; it was left untouched.", { blocked: true });
        }
        ownedPageKind(current.url);
        await confirmProcess();
      }
      await saveContext("creating", null);
      const creationLines = [
        `if not (exists window id ${sourceWindow}) then error "owner-window-missing"`,
        `set sourceWindow to window id ${sourceWindow}`,
        'if mode of sourceWindow is not "normal" then error "non-normal-window"',
        ...(preservedPage ? preservedSourceGuard(preservedPage) : []),
        "set originalActiveId to id of active tab of sourceWindow",
        `set newTaskTab to make new tab at end of tabs of sourceWindow with properties {URL:${JSON.stringify(initialUrl)}}`,
        "set createdId to id of newTaskTab",
        "if (id of active tab of sourceWindow) is createdId then",
        "repeat with tabIndex from 1 to count of tabs of sourceWindow",
        "if (id of tab tabIndex of sourceWindow) is originalActiveId then",
        "set active tab index of sourceWindow to tabIndex", "exit repeat",
        "end if", "end repeat", "end if",
        'return (id of sourceWindow as text) & "," & (createdId as text)',
      ];
      let created;
      try { created = await execute(creationLines, signal); }
      catch (error) {
        // This exact pre-creation guard proves that no new page was made; uncertain replies stay blocked.
        if (preservedPage && ["browser-preserved-page-changed", "login-required", "captcha"].includes(error.code)) await saveContext("bound", existing);
        throw error;
      }
      const match = /^(\d+),(\d+)$/.exec(created);
      if (!match) throw new RunError("browser-recovery-unconfirmed", "Chrome did not confirm the new task handle; inspect before trying again.", { blocked: true });
      tab = { windowId: Number(match[1]), tabId: Number(match[2]) };
      tabLines(tab);
      await saveContext("created", tab);
      await atomicJson(join(root, "browser.json"), tab);
    } else if (inspection?.kind === "missing-tab") {
      throw new RunError("browser-recovery-unconfirmed", "The unverified task page disappeared; inspect the existing binding before replacing it.", { blocked: true });
    }
    const ready = services.sourceReady ?? (async (handle) => {
      const current = parseInspection(await execute(ownedInspection(handle), signal, { timeout: 5000 }));
      if (current.kind !== "owned") return { state: "waiting" };
      if (current.url === "about:blank" || current.url === "chrome://newtab/") return { state: "waiting" };
      requireSearchPage(current.url);
      return (services.evaluatePage ?? evaluatePage)(current.tab, null, cardsInPage, [], signal);
    });
    await waitPage(() => ready(tab), services.sourceTimeoutMs ?? 45000, signal,
      { intervalMs: services.sourceIntervalMs ?? 1200 });
    await confirmProcess();
    await saveContext("bound", tab);
    await appendLog(root, { event: "browser-task-tab-recovered", context: "original-normal-window",
      reason: preservedPage ? "preserved-source-page" : "missing-task-tab",
      elapsedMs: Date.now() - startedAt });
    return tab;
  } catch (error) {
    const failure = signal?.aborted ? signal.reason ?? error : error;
    await appendLog(root, { event: "browser-recovery-blocked", code: failure instanceof RunError ? failure.code : "browser-access-failed",
      elapsedMs: Date.now() - startedAt });
    throw failure;
  }
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

export async function waitPage(read, timeoutMs, signal, {
  allowIdentityConflict = false, allowIncompleteDetail = false, intervalMs = 1200,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let conflictTitle = null, conflicts = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await read();
    if (result.state === "ready") return result;
    if ((allowIdentityConflict && result.state === "identity-conflict")
      || (allowIncompleteDetail && result.state === "incomplete-detail")) {
      const key = `${result.state}:${result.actualTitle ?? result.incompleteText}`;
      conflicts = key === conflictTitle ? conflicts + 1 : 1;
      conflictTitle = key;
      if (conflicts >= 3) return { state: result.state, code: result.code };
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
        { allowIdentityConflict: true, allowIncompleteDetail: true });
    },
    pause: () => delay(1500, undefined, { signal }),
    ...services,
  };
  const tab = await operations.ownedTab(root, searchUrl(queries[0]), signal);
  const cards = new Map(), details = new Map(), detailConflicts = new Map(), incompleteDetails = new Map(), queryResults = [];
  const querySeen = queries.map(() => new Set());
  const pools = [];
  const knownIds = new Set(knownDetailIds);
  const now = Date.now();
  let recheckDone = false;
  const progress = (complete) => ({ cards: [...cards.values()], details: [...details.values()],
    detailConflicts: [...detailConflicts.values()], incompleteDetails: [...incompleteDetails.values()], queries: queryResults, complete });
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
      empty: result.empty === true, allocated: 0, detailsRead: 0, unreadDetails: 0, recheckedDetails: 0,
      detailConflicts: 0, incompleteDetails: 0, visits: 1 });
    await onEvidence(progress(false));
    await operations.pause();
  }
  // Visit every query before assigning the shared budget. One bounded refill pass borrows unused allocations.
  for (let pass = 0; pass < 2 && details.size < limits.maxDetails; pass++) {
    const plan = planDetailReads(pools, limits.maxDetails - details.size, {
      knownIds, history: readHistory, now, priorityFor, recheckDone,
      readCounts: queryResults.map((query) => query.detailsRead),
      excluded: new Set([...details.keys(), ...detailConflicts.keys(), ...incompleteDetails.keys()]),
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
        } else if (detail.state === "incomplete-detail") {
          incompleteDetails.set(planned.id, { id: planned.id, code: detail.code });
          queryResult.incompleteDetails++;
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
