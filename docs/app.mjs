import {
  SnapshotError, filterOptions, formatShanghaiTime, hasSalaryRange,
  parseSalaryRange, safeJobUrl, selectJobs, validateSnapshot,
} from "./model.mjs";

const byId = (id) => document.getElementById(id);
const form = byId("filter-form");
const controls = byId("filter-controls");
const salaryMin = byId("salary-min");
const salaryMax = byId("salary-max");
const salaryMode = byId("salary-mode");
const sortBy = byId("sort-by");
const list = byId("job-list");
const stateAction = byId("state-action");
const fields = {
  keyword: byId("keyword"), category: byId("category"),
  priority: byId("priority"), newOnly: byId("new-only"),
};
let snapshot = null;
let stateActionKind = "retry";

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
  stateAction.textContent = action === "reset" ? "清除筛选条件" : "重新读取";
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

function createCard(job, index) {
  const card = byId("job-card-template").content.firstElementChild.cloneNode(true);
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  const put = (name, value) => { field(name).textContent = value ?? "无法获取"; };
  const title = job.title ?? "岗位名称无法获取";
  field("title").id = `job-title-${index}`;
  card.setAttribute("aria-labelledby", field("title").id);
  put("title", title);
  put("category", job.category ?? "待确认");
  put("priority", job.priority ?? "优先级待确认");
  field("new").hidden = !job.isNew;
  put("score", job.matchScore ?? "待确认");
  field("score-total").hidden = job.matchScore === null;
  field("score-box").classList.toggle("is-unknown", job.matchScore === null);
  field("score-box").setAttribute("aria-label", job.matchScore === null
    ? "初筛参考分无法获取" : `初筛参考分 ${job.matchScore}，满分 100；仅用于排序，不代表满足全部要求或录用概率`);
  put("company", job.company ?? "公司名称无法获取");
  put("salary", job.salaryText ?? "薪资无法获取");
  field("salary").classList.toggle("is-unknown", job.salaryText === null);
  field("salary-note").hidden = hasSalaryRange(job);
  put("location", job.location ?? (job.city ? `${job.city} · 具体地点待确认` : "无法获取"));
  put("experience", job.experienceText);
  put("education", job.educationText);
  fillList(field("summary"), job.summary, "岗位摘要无法获取，请查看原文。");
  fillList(field("reasons"), job.matchReasons, "入选参考无法获取，不应仅凭分数判断。");
  fillList(field("concerns"), job.concerns, "待确认事项无法获取，请进一步核实岗位条件。");
  fillList(field("requirements"), job.requirements, "任职要求无法获取，请查看原文或向招聘方确认。");
  put("language", job.languageNote ?? "工作语言待确认");
  put("months", job.salaryMonths === null ? "待确认" : `${job.salaryMonths} 薪`);
  put("jd-read", job.jdRead ? "已阅读源站职位详情" : "仅获得职位卡片，详情未读取");
  put("source", `来源 · ${job.source}`);
  setTime(field("first-seen"), job.firstSeen);
  setTime(field("last-seen"), job.lastSeen);
  setTime(field("published"), job.publishedAt);
  const url = safeJobUrl(job.url);
  if (url === null) throw new SnapshotError("岗位来源链接无效。");
  field("link").href = url;
  field("link").setAttribute("aria-label", `${title}：在 ${job.source} 查看原始岗位（新窗口，可能需要登录）`);
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

function renderResults() {
  if (snapshot === null) throw new Error("Cannot render before the snapshot is loaded.");
  const { filters, error } = readFilters();
  list.replaceChildren();
  byId("results-footnote").hidden = true;
  if (error) {
    byId("result-count").textContent = "薪资区间需要调整";
    setState("请调整薪资区间", error, "reset");
    return;
  }
  const jobs = selectJobs(snapshot.jobs, filters);
  byId("result-count").textContent = `显示 ${jobs.length} / ${snapshot.jobs.length} 个岗位`;
  if (snapshot.jobs.length === 0) {
    setState("这份快照尚未收录岗位", "当前数据为空，没有示例或推测岗位。本页不会自动抓取或更新职位。");
    return;
  }
  if (jobs.length === 0) {
    setState("暂时没有符合条件的岗位", "试试减少关键词、放宽薪资区间，或保留薪资待确认的岗位。", "reset");
    return;
  }
  byId("data-state").hidden = true;
  const fragment = document.createDocumentFragment();
  for (const [index, job] of jobs.entries()) fragment.append(createCard(job, index));
  list.append(fragment);
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
    response = await fetch(new URL("./data/jobs.json", import.meta.url), {
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
  sortBy.disabled = true;
  stateAction.disabled = true;
  byId("results-area").setAttribute("aria-busy", "true");
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
    setFilterOptions("category", "category", "全部类别");
    setFilterOptions("priority", "priority", "全部优先级");
    renderResults();
    controls.disabled = false;
    sortBy.disabled = false;
  } catch (error) {
    console.error("Unable to display the job snapshot.", error);
    snapshot = null;
    list.replaceChildren();
    byId("results-footnote").hidden = true;
    byId("result-count").textContent = "数据不可用";
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
  renderResults();
}

form.addEventListener("submit", (event) => event.preventDefault());
form.addEventListener("input", () => renderResults());
form.addEventListener("change", () => renderResults());
byId("reset-filters").addEventListener("click", resetFilters);
sortBy.addEventListener("change", () => renderResults());
stateAction.addEventListener("click", () => {
  if (stateActionKind === "reset") resetFilters();
  else if (stateActionKind === "retry") void loadSnapshot();
});
if (window.matchMedia("(max-width: 760px)").matches) byId("filters-panel").open = false;
void loadSnapshot();
