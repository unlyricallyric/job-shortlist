import {
  SnapshotError, filterOptions, formatShanghaiTime, hasSalaryRange,
  parseSalaryRange, safeJobUrl, selectJobs, validateSnapshot,
  shanghaiDateKey, nextShanghaiMidnight, selectArrivalView, groupJobsByFirstSeen,
} from "./model.mjs?rev=20260910-approved1";

const sourceLinkLabels = new Map([
  ["BOSS直聘", "查看原始岗位"],
  ["字节跳动招聘官网", "查看官网岗位"],
  ["猎聘", "查看猎聘岗位"],
]);
const byId = (id) => document.getElementById(id);
const form = byId("filter-form");
const controls = byId("filter-controls");
const salaryMin = byId("salary-min");
const salaryMax = byId("salary-max");
const salaryMode = byId("salary-mode");
const sortBy = byId("sort-by");
const list = byId("job-list");
const stateAction = byId("state-action");
const stateAllAction = byId("state-all-action");
const dateControls = byId("date-view-controls");
const dateInputs = new Map([
  ["today", byId("view-today")], ["week", byId("view-week")], ["all", byId("view-all")],
]);
const viewLabels = { today: "今日新增", week: "近7天新增", all: "全部岗位" };
const fields = {
  keyword: byId("keyword"), category: byId("category"),
  priority: byId("priority"), newOnly: byId("new-only"),
};
const manualGuidance = {
  assessment: byId("assessment-description").textContent,
  category: byId("category-help").textContent,
};
let snapshot = null;
let stateActionKind = "retry";
let arrivalView = "today";
let renderedDay = null;
let calendarTimer = null;
let renderedJobIds = [];

class DataLoadError extends Error {
  constructor(message) {
    super(message);
    this.name = "DataLoadError";
  }
}

function setState(title, description, action = null) {
  byId("data-state").hidden = false;
  byId("state-title").textContent = title;
  byId("state-description").textContent = description;
  stateAction.hidden = action === null;
  stateActionKind = action;
  stateAction.textContent = { reset: "重置筛选", week: "查看近7天", all: "查看全部岗位" }[action] ?? "重新读取";
  stateAllAction.hidden = action !== "week";
  byId("state-context").hidden = true;
}

function setTime(node, value) {
  node.textContent = formatShanghaiTime(value);
  if (value === null) node.removeAttribute("datetime");
  else node.setAttribute("datetime", value);
}

function fillList(node, items, fallback) {
  for (const text of items.length ? items : [fallback]) {
    const item = document.createElement("li");
    item.textContent = text;
    node.append(item);
  }
}

function isScheduleOverdue(data, now = Date.now()) {
  if (!data.automation?.enabled) return false;
  const day = shanghaiDateKey(now);
  const slots = data.automation.times.map((time) => Date.parse(`${day}T${time}:00+08:00`));
  const cutoff = now - 30 * 60_000;
  // Keep an earlier missed slot visible while the next slot is still within its grace period.
  const latestExpectedSlot = Math.max(...slots.map((slot) => slot < cutoff ? slot : slot - 24 * 60 * 60_000));
  return Date.parse(data.generatedAt) < latestExpectedSlot;
}

function renderAutomation() {
  const automation = snapshot.automation;
  const pausedPublication = snapshot.publication?.scheduler === "paused";
  const collectionOnly = snapshot.publication?.scheduler === "collection-only";
  byId("paused-notice").hidden = !pausedPublication;
  byId("collection-only-notice").hidden = !collectionOnly;
  if (pausedPublication) setTime(byId("maintenance-at"), snapshot.publication.publishedAt);
  const hasRulesAssessment = Boolean(automation) || Object.values(snapshot.assessmentMethods ?? {}).includes("rules-v1");
  byId("automation-panel").hidden = !automation;
  byId("review-queue-summary").hidden = !automation;
  byId("automation-warning").hidden = !isScheduleOverdue(snapshot);
  byId("snapshot-label").textContent = collectionOnly ? "只读 · 采集待人工复核" : pausedPublication ? "只读 · 采集已暂停"
    : automation ? "只读 · 定时采样快照" : "只读 · 人工辅助快照";
  byId("assessment-description").textContent = hasRulesAssessment
    ? "初筛方式以各卡片标记为准：人工辅助初筛沿用原有判断；规则初筛由固定规则计算，未经人工复核。再次观察到岗位不会改变其初筛方式。分数与优先级仅用于清单排序，不代表已满足全部任职要求，也不是录用概率。"
    : manualGuidance.assessment;
  byId("category-help").textContent = hasRulesAssessment
    ? "原标题保留，方向按 JD 实际职责归类；规则初筛岗位由固定规则归类，仍需核实具体职责。同一岗位名可能做不同工作。"
    : manualGuidance.category;
  if (!automation) return;
  byId("automation-status").textContent = automation.enabled ? "上次发布：计划开启" : "上次发布：计划暂停";
  byId("schedule-times").textContent = `每天 ${automation.times.join(" / ")}（${automation.timeZone}）`;
  byId("run-reviewed-count").textContent = automation.reviewedThisRun;
  byId("run-details-count").textContent = automation.detailsThisRun;
  byId("automation-sources").textContent = `本轮仅对 ${automation.freshSources.join("、")} 进行新采样；${automation.retainedSources.join("、")} 为保留记录，沿用原始收录与最近观察日期，未在本轮重新核验。`;
  byId("review-queue-summary").textContent = automation.reviewPendingThisRun === undefined
    ? "本轮初筛待复核数未记录，不能由“新增 0”推断没有其他机会。"
    : `本轮初筛待复核 ${automation.reviewPendingThisRun} 个，其中结构解析待复核 ${automation.parsePendingThisRun} 个。待复核不等于不适合，也不等于已入选新增；本页不公开这些记录的内容。`;
}

function createCard(job, index) {
  const card = byId("job-card-template").content.firstElementChild.cloneNode(true);
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  const put = (name, value) => { field(name).textContent = value ?? "无法获取"; };
  const rulesBased = snapshot.assessmentMethods?.[job.id] === "rules-v1";
  const title = job.title ?? "岗位名称无法获取";
  field("title").id = `job-title-${index}`;
  card.setAttribute("aria-labelledby", field("title").id);
  put("title", title);
  put("category", job.category ?? "待确认");
  put("priority", job.priority ?? "优先级待确认");
  field("new").hidden = !job.isNew;
  put("assessment", rulesBased ? "规则初筛 · rules-v1" : "人工辅助初筛");
  field("assessment").classList.toggle("is-rules", rulesBased);
  field("assessment-note").hidden = !rulesBased;
  put("score", job.matchScore ?? "待确认");
  field("score-total").hidden = job.matchScore === null;
  field("score-box").classList.toggle("is-unknown", job.matchScore === null);
  field("score-box").setAttribute("aria-label", job.matchScore === null
    ? "初筛参考分无法获取" : `初筛参考分 ${job.matchScore}，满分 100；${rulesBased ? "固定规则计算，" : ""}仅用于排序，不代表满足全部要求或录用概率`);
  put("company", job.company ?? "公司名称无法获取");
  put("salary", job.salaryText ?? "薪资无法获取");
  field("salary").classList.toggle("is-unknown", job.salaryText === null);
  field("salary-note").hidden = hasSalaryRange(job);
  put("salary-note", job.salaryText === null
    ? "月薪未公开或无法获取，不据此推算"
    : "保留招聘页原文，月薪不可比较，不据此推算");
  put("location", job.location ?? (job.city ? `${job.city} · 具体地点待确认` : "无法获取"));
  put("experience", job.experienceText);
  put("education", job.educationText);
  fillList(field("summary"), job.summary, "岗位摘要无法获取，请查看原文。");
  fillList(field("reasons"), job.matchReasons, "入选参考无法获取，不应仅凭分数判断。");
  fillList(field("concerns"), job.concerns, "待确认事项无法获取，请进一步核实岗位条件。");
  fillList(field("requirements"), job.requirements, "任职要求无法获取，请查看原文或向招聘方确认。");
  put("language", job.languageNote ?? "工作语言待确认");
  put("months", job.salaryMonths === null ? "待确认" : `${job.salaryMonths} 薪`);
  put("jd-read", job.jdRead
    ? (rulesBased ? "已读取源站完整职位详情" : "已阅读源站职位详情")
    : "仅获得职位卡片，详情未读取");
  put("source", `来源 · ${job.source}`);
  field("source-retention").hidden = !snapshot.automation?.retainedSources.includes(job.source);
  setTime(field("first-seen"), job.firstSeen);
  setTime(field("last-seen"), job.lastSeen);
  setTime(field("published"), job.publishedAt);
  field("admission-row").hidden = !snapshot.firstPublishedAtById?.[job.id];
  if (snapshot.firstPublishedAtById?.[job.id]) setTime(field("admitted"), snapshot.firstPublishedAtById[job.id]);
  const url = safeJobUrl(job.url, job.source);
  const linkLabel = sourceLinkLabels.get(job.source);
  if (url === null || linkLabel === undefined) throw new SnapshotError("岗位来源链接无效。");
  put("link-label", linkLabel);
  field("link").href = url;
  field("link").setAttribute("aria-label", `${title}：在 ${job.source} ${linkLabel}（新窗口，可能需要登录）`);
  return card;
}

function readFilters() {
  const unknownOnly = salaryMode.value === "unknown";
  salaryMin.disabled = unknownOnly;
  salaryMax.disabled = unknownOnly;
  const range = parseSalaryRange(unknownOnly ? "" : salaryMin.value, unknownOnly ? "" : salaryMax.value);
  if (!unknownOnly && (salaryMin.validity.badInput || salaryMax.validity.badInput)) {
    range.error = "请输入有效的非负月薪金额。";
  }
  byId("salary-error").textContent = range.error ?? "";
  byId("salary-error").hidden = range.error === null;
  salaryMin.setAttribute("aria-invalid", String(range.error !== null));
  salaryMax.setAttribute("aria-invalid", String(range.error !== null));
  const filters = {
    keyword: fields.keyword.value, category: fields.category.value, priority: fields.priority.value,
    newOnly: fields.newOnly.checked, salaryMin: range.min, salaryMax: range.max,
    salaryMode: salaryMode.value, sortBy: sortBy.value,
  };
  byId("filter-indicator").hidden = !(
    filters.keyword.trim() || filters.category || filters.priority || filters.newOnly
    || filters.salaryMin !== null || filters.salaryMax !== null || filters.salaryMode !== "all" || range.error
  );
  return { filters, error: range.error };
}

function clearResults() {
  list.replaceChildren();
  renderedJobIds = [];
}

function renderResults(now = Date.now(), { preserveCards = false } = {}) {
  if (snapshot === null) throw new Error("Cannot render before the snapshot is loaded.");
  const { filters, error } = readFilters();
  renderedDay = shanghaiDateKey(now);
  byId("arrival-date").textContent = renderedDay.replaceAll("-", ".");
  byId("arrival-date").setAttribute("datetime", renderedDay);
  const viewJobs = selectArrivalView(snapshot.jobs, arrivalView, now, snapshot.firstPublishedAtById);
  for (const view of dateInputs.keys()) {
    byId(`view-${view}-count`).textContent = selectArrivalView(snapshot.jobs, view, now, snapshot.firstPublishedAtById).length;
  }
  byId("view-count").textContent = `${viewLabels[arrivalView]} ${viewJobs.length} 个 · 不含其他筛选条件`;
  byId("results-footnote").hidden = true;
  if (error) {
    clearResults();
    byId("result-count").textContent = "薪资区间需要调整";
    setState("请调整薪资区间", error, "reset");
    return;
  }
  const jobs = selectJobs(viewJobs, filters);
  byId("result-count").textContent = `筛选结果 ${jobs.length} / 本视图 ${viewJobs.length} 个`;
  if (snapshot.jobs.length === 0) {
    clearResults();
    setState("这份快照尚未收录岗位", "当前数据为空，没有示例或推测岗位。本页不采集岗位，也不自动刷新；刷新页面读取最新已发布数据。");
    return;
  }
  if (viewJobs.length === 0 && arrivalView !== "all") {
    clearResults();
    setState(arrivalView === "today" ? "今日暂无新增" : "近7天暂无新增",
      "按本站首次收录的上海日期统计，历史岗位仍保留在累计清单中；没有新增不代表没有岗位。",
      arrivalView === "today" ? "week" : "all");
    const automation = snapshot.automation;
    byId("state-context").textContent = `最近快照：${formatShanghaiTime(snapshot.generatedAt)}（上海）。${automation
      ? `本轮采样 ${automation.reviewedThisRun} 条记录、${automation.detailsThisRun} 份完整 JD；最新运行状态以本机为准。`
      : "这是已发布的静态快照，刷新页面可读取最新数据。"}`;
    byId("state-context").hidden = false;
    return;
  }
  if (jobs.length === 0) {
    clearResults();
    setState("当前视图没有符合筛选条件的岗位",
      `${viewLabels[arrivalView]}原有 ${viewJobs.length} 个岗位。可减少关键词、放宽薪资范围，或取消“仅本轮新增”。重置会返回今日视图。`, "reset");
    return;
  }
  byId("data-state").hidden = true;
  const groups = groupJobsByFirstSeen(jobs, { sortBy: filters.sortBy, now, firstPublishedAtById: snapshot.firstPublishedAtById });
  const ids = groups.flatMap((group) => group.jobs.map((job) => job.id));
  if (preserveCards && ids.length === renderedJobIds.length && ids.every((id, index) => id === renderedJobIds[index])) {
    for (const [index, group] of groups.entries()) list.children[index].querySelector("h3").textContent = group.label;
    byId("results-footnote").hidden = false;
    return;
  }
  clearResults();
  const fragment = document.createDocumentFragment();
  let cardIndex = 0;
  for (const group of groups) {
    const section = document.createElement("section");
    section.setAttribute("class", "date-group");
    const heading = document.createElement("div");
    heading.setAttribute("class", "date-group-heading");
    const title = document.createElement("h3");
    title.id = `arrival-${group.date}`;
    title.textContent = group.label;
    section.setAttribute("aria-labelledby", title.id);
    const count = document.createElement("p");
    count.textContent = `${group.jobs.length} 个匹配岗位`;
    heading.append(title, count);
    const grid = document.createElement("div");
    grid.setAttribute("class", "job-grid");
    for (const job of group.jobs) grid.append(createCard(job, cardIndex++));
    section.append(heading, grid);
    fragment.append(section);
  }
  list.append(fragment);
  renderedJobIds = ids;
  byId("results-footnote").hidden = false;
}

function setFilterOptions(id, key, defaultText) {
  const select = byId(id);
  select.replaceChildren(new Option(defaultText, ""));
  for (const [name, count] of filterOptions(snapshot.jobs, key)) {
    select.add(new Option(`${name}（${count}）`, name));
  }
}

async function fetchSnapshot() {
  let response;
  try {
    response = await fetch(new URL("./data/jobs.json?rev=20260910-approved1", import.meta.url), {
      cache: "no-store", credentials: "omit", redirect: "error",
    });
  } catch (error) {
    if (error instanceof TypeError) throw new DataLoadError("网络连接或访问方式异常。请通过网站地址访问，确认网络连接后重试。");
    throw error;
  }
  if (!response.ok) throw new DataLoadError(`岗位数据请求未成功（HTTP ${response.status}），请稍后重试。`);
  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new DataLoadError("岗位数据不是有效的 JSON，暂时无法展示。");
    if (error instanceof TypeError) throw new DataLoadError("岗位数据传输未完成，请重新读取。");
    throw error;
  }
  return validateSnapshot(data);
}

async function loadSnapshot() {
  controls.disabled = true;
  dateControls.disabled = true;
  sortBy.disabled = true;
  stateAction.disabled = true;
  byId("results-area").setAttribute("aria-busy", "true");
  byId("automation-panel").hidden = true;
  byId("paused-notice").hidden = true;
  byId("collection-only-notice").hidden = true;
  byId("automation-warning").hidden = true;
  byId("snapshot-label").textContent = "只读 · 岗位快照";
  setState("正在读取岗位快照", "只读取本站的静态数据，不会实时访问招聘平台。");
  try {
    snapshot = await fetchSnapshot();
    byId("total-count").textContent = String(snapshot.jobs.length).padStart(2, "0");
    byId("new-count").textContent = snapshot.run.newCount;
    byId("reviewed-count").textContent = snapshot.run.cardsReviewed;
    byId("details-count").textContent = snapshot.run.detailsRead;
    byId("new-filter-count").textContent = `（${snapshot.run.newCount}）`;
    byId("run-scope").textContent = snapshot.run.scope;
    byId("run-source").textContent = `${snapshot.run.source} · ${snapshot.run.mode}`;
    setTime(byId("generated-at"), snapshot.generatedAt);
    renderAutomation();
    setFilterOptions("category", "category", "全部方向");
    setFilterOptions("priority", "priority", "全部优先级");
    renderResults();
    controls.disabled = false;
    dateControls.disabled = false;
    sortBy.disabled = false;
    scheduleCalendarRefresh();
  } catch (error) {
    console.error("Unable to display the job snapshot.", error);
    snapshot = null;
    window.clearTimeout(calendarTimer);
    clearResults();
    byId("automation-panel").hidden = true;
    byId("paused-notice").hidden = true;
    byId("collection-only-notice").hidden = true;
    byId("automation-warning").hidden = true;
    byId("snapshot-label").textContent = "只读 · 岗位快照";
    byId("results-footnote").hidden = true;
    byId("result-count").textContent = "数据不可用";
    byId("view-count").textContent = "日期视图不可用";
    if (error instanceof DataLoadError || error instanceof SnapshotError) {
      setState("岗位数据暂时无法读取", error.message, "retry");
    } else {
      setState("页面遇到了显示问题", "暂时无法展示岗位，请重新载入页面。");
      throw error;
    }
  } finally {
    stateAction.disabled = false;
    byId("results-area").setAttribute("aria-busy", "false");
  }
}

function resetFilters() {
  form.reset();
  sortBy.value = "score";
  setArrivalView("today");
}

function setArrivalView(view) {
  if (!dateInputs.has(view)) throw new RangeError("不支持的收录日期视图。");
  arrivalView = view;
  for (const [name, input] of dateInputs) input.checked = name === view;
  renderResults();
}

function scheduleCalendarRefresh() {
  window.clearTimeout(calendarTimer);
  const now = Date.now();
  calendarTimer = window.setTimeout(refreshCalendar, Math.max(1000, nextShanghaiMidnight(now) - now + 50));
}

function refreshCalendar() {
  if (snapshot === null) return;
  const now = Date.now();
  if (renderedDay !== shanghaiDateKey(now)) renderResults(now, { preserveCards: true });
  byId("automation-warning").hidden = !isScheduleOverdue(snapshot, now);
  scheduleCalendarRefresh();
}

dateControls.addEventListener("change", () => {
  const selected = [...dateInputs].find(([, input]) => input.checked);
  if (!selected) throw new Error("必须选择一个收录日期视图。");
  setArrivalView(selected[0]);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshCalendar();
});
window.addEventListener("pageshow", refreshCalendar);
window.addEventListener("pagehide", () => window.clearTimeout(calendarTimer));
form.addEventListener("submit", (event) => event.preventDefault());
form.addEventListener("input", () => renderResults());
form.addEventListener("change", () => renderResults());
byId("reset-filters").addEventListener("click", resetFilters);
sortBy.addEventListener("change", () => renderResults());
stateAction.addEventListener("click", () => {
  if (stateActionKind === "reset") resetFilters();
  else if (stateActionKind === "retry") void loadSnapshot();
  else if (stateActionKind === "week" || stateActionKind === "all") {
    setArrivalView(stateActionKind);
    dateInputs.get(arrivalView).focus();
  }
});
stateAllAction.addEventListener("click", () => {
  setArrivalView("all");
  dateInputs.get("all").focus();
});
if (window.matchMedia("(max-width: 760px)").matches) byId("filters-panel").open = false;
void loadSnapshot();
