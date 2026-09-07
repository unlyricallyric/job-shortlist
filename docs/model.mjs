export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotError";
  }
}

const rootKeys = ["version", "generatedAt", "run", "jobs"];
const runKeys = ["source", "scope", "mode", "cardsReviewed", "detailsRead", "selectedCount", "newCount"];
const snapshotModes = new Set(["单次采集", "累计精选 · 第二轮快照", "定时规则初筛 · 累计快照"]);
const runSources = new Map([
  ["BOSS直聘", ["BOSS直聘"]],
  ["字节跳动招聘官网", ["字节跳动招聘官网"]],
  ["猎聘", ["猎聘"]],
  ["BOSS直聘 + 字节跳动招聘官网", ["BOSS直聘", "字节跳动招聘官网"]],
  ["BOSS直聘 + 字节跳动招聘官网 + 猎聘", ["BOSS直聘", "字节跳动招聘官网", "猎聘"]],
]);
const sourceRoutes = new Map([
  ["BOSS直聘", {
    idPattern: /^boss-([A-Za-z0-9_~-]+)$/,
    pathFor: (id) => `/job_detail/${id}.html`,
  }],
  ["字节跳动招聘官网", {
    idPattern: /^bytedance-([0-9]+)$/,
    pathFor: (id) => `/experienced/position/${id}/detail`,
  }],
  ["猎聘", {
    idPattern: /^liepin-([0-9]+)$/,
    pathFor: (id) => `/job/${id}.shtml`,
  }],
]);
const jobKeys = [
  "id", "title", "company", "city", "location", "source", "url",
  "salaryText", "salaryMinK", "salaryMaxK", "salaryMonths",
  "experienceText", "educationText", "category", "matchScore", "priority",
  "summary", "requirements", "matchReasons", "concerns", "languageNote",
  "publishedAt", "firstSeen", "lastSeen", "jdRead", "isNew",
];
const textKeys = [
  "title", "company", "city", "location", "salaryText", "experienceText",
  "educationText", "category", "priority", "languageNote",
];
const listKeys = ["summary", "requirements", "matchReasons", "concerns"];
const roleAliases = new Map([
  ["区域市场", ["field marketing", "regional marketing"]],
  ["伙伴营销", ["partner marketing", "channel marketing", "渠道市场", "生态市场"]],
  ["需求生成", ["demand generation", "demand gen", "pipeline marketing"]],
  ["伙伴发展", ["partner development", "pdr"]],
  ["生态商业化", ["ecosystem"]],
  ["销售开发", ["sales development", "bdr", "sdr"]],
  ["销售运营", ["sales operations", "revops"]],
  ["客户成功", ["customer success", "csm"]],
  ["产品市场", ["产品营销", "product marketing", "pmm"]],
  ["品牌活动", ["品牌活动", "活动营销", "活动策划", "event marketing"]],
  ["渠道销售", ["channel sales"]],
  ["大客户销售", ["account executive", "key account", "ae"]],
]);
const aliasPhrases = [...roleAliases].flatMap(([category, aliases]) =>
  aliases.map((alias) => ({ category, tokens: alias.split(" ") }))
).sort((a, b) => b.tokens.length - a.tokens.length);
const wordAliasPatterns = new Map(aliasPhrases
  .filter(({ tokens }) => tokens.length === 1 && /^[a-z]+$/.test(tokens[0]))
  .map(({ tokens: [word] }) => [
    word, new RegExp(`(^|[^\\p{Script=Latin}\\p{N}\\p{M}_])${word}(?=$|[^\\p{Script=Latin}\\p{N}\\p{M}_])`, "u"),
  ]));
const priorityOrder = new Map(["优先了解", "有条件匹配", "转型备选"].map((name, index) => [name, index]));
const collator = new Intl.Collator("zh-CN", { numeric: true });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function requireValue(condition, message) {
  if (!condition) throw new SnapshotError(message);
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isIsoDate(value, allowDateOnly = true) {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!parts || (!allowDateOnly && !parts[4])) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return false;
  if (hourText && (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59)) return false;
  if (offset && offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function formatShanghaiTime(value) {
  if (value === null) return "无法获取";
  if (!isIsoDate(value)) throw new SnapshotError("时间格式无效。");
  if (value.length === 10) return value.replaceAll("-", ".");
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}

function referenceTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value
    : isIsoDate(value, false) ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new RangeError("参考时间必须是有效时间点。");
  return timestamp;
}

export function shanghaiDateKey(value = Date.now()) {
  if (typeof value === "string" && value.length === 10 && isIsoDate(value)) return value;
  const parts = Object.fromEntries(dateFormatter.formatToParts(referenceTimestamp(value))
    .map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function nextShanghaiMidnight(now = Date.now()) {
  return Date.parse(`${shanghaiDateKey(referenceTimestamp(now))}T00:00:00+08:00`) + 86400000;
}

export function selectArrivalView(jobs, view = "all", now = Date.now()) {
  if (!["today", "week", "all"].includes(view)) throw new RangeError("不支持的收录日期视图。");
  if (view === "all") return [...jobs];
  const timestamp = referenceTimestamp(now);
  const today = shanghaiDateKey(timestamp);
  const earliest = view === "today" ? today : shanghaiDateKey(nextShanghaiMidnight(timestamp) - 7 * 86400000);
  return jobs.filter((job) => {
    const day = shanghaiDateKey(job.firstSeen);
    return day >= earliest && day <= today
      && (job.firstSeen.length === 10 || Date.parse(job.firstSeen) <= timestamp);
  });
}

export function firstSeenGroupLabel(day, now = Date.now()) {
  if (!isIsoDate(day) || day.length !== 10) throw new RangeError("分组日期必须是有效日历日期。");
  const timestamp = referenceTimestamp(now);
  const today = shanghaiDateKey(timestamp);
  const yesterday = shanghaiDateKey(nextShanghaiMidnight(timestamp) - 2 * 86400000);
  const fullDate = `${day.slice(0, 4)}年${day.slice(5, 7)}月${day.slice(8)}日`;
  const date = day.slice(0, 4) === today.slice(0, 4) ? fullDate.slice(5) : fullDate;
  if (day === today) return `今天 · ${date}`;
  if (day === yesterday) return `昨天 · ${date}`;
  return fullDate;
}

export function groupJobsByFirstSeen(jobs, { sortBy = "score", now = Date.now() } = {}) {
  const groups = new Map();
  for (const job of selectJobs(jobs, { sortBy })) {
    const day = shanghaiDateKey(job.firstSeen);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(job);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a))
    .map(([date, groupedJobs]) => ({ date, label: firstSeenGroupLabel(date, now), jobs: groupedJobs }));
}

export function safeJobUrl(value, source = "BOSS直聘") {
  if (typeof value !== "string" || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  if (source === "字节跳动招聘官网") {
    return /^https:\/\/jobs\.bytedance\.com\/experienced\/position\/[0-9]+\/detail$/.test(value) ? value : null;
  }
  if (source === "猎聘") {
    return /^https:\/\/www\.liepin\.com\/job\/[0-9]+\.shtml$/.test(value) ? value : null;
  }
  if (source !== "BOSS直聘") return null;
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.hostname !== "zhipin.com" && !url.hostname.endsWith(".zhipin.com")) return null;
  if (!/^\/job_detail\/[A-Za-z0-9_~-]+\.html$/.test(url.pathname)) return null;
  return url.href;
}

function observationOrder(first, last) {
  if (first.length === 10 || last.length === 10) {
    return formatShanghaiTime(first).slice(0, 10).localeCompare(formatShanghaiTime(last).slice(0, 10));
  }
  return Date.parse(first) - Date.parse(last);
}

export function validateSnapshot(value) {
  const scheduled = value !== null && typeof value === "object" && Object.hasOwn(value, "automation");
  requireValue(hasExactKeys(value, scheduled ? [...rootKeys, "automation", "assessmentMethods"] : rootKeys), "快照字段不完整或包含不支持的字段。");
  requireValue(value.version === 1, "不支持的快照版本。");
  requireValue(isIsoDate(value.generatedAt, false), "快照生成时间必须包含时区。");
  requireValue(hasExactKeys(value.run, runKeys), "采集概览字段不完整或包含不支持的字段。");
  const { run, jobs } = value;
  const allowedSources = runSources.get(run.source);
  requireValue(allowedSources !== undefined && snapshotModes.has(run.mode) && isText(run.scope), "采集来源、范围或模式无效。");
  requireValue(run.mode !== "定时规则初筛 · 累计快照" || scheduled, "定时快照缺少采样与初筛方式说明。");
  for (const key of ["cardsReviewed", "detailsRead", "selectedCount", "newCount"]) {
    requireValue(Number.isSafeInteger(run[key]) && run[key] >= 0, `采集计数 ${key} 无效。`);
  }
  requireValue(Array.isArray(jobs) && run.selectedCount === jobs.length, "收录数量与岗位数据不一致。");
  requireValue(run.newCount <= run.selectedCount && run.selectedCount <= run.cardsReviewed
    && run.detailsRead <= run.cardsReviewed, "采集计数相互矛盾。");
  const ids = new Set();
  for (const [index, job] of jobs.entries()) {
    const label = `第 ${index + 1} 个岗位`;
    requireValue(hasExactKeys(job, jobKeys), `${label}字段不完整或包含不支持的字段。`);
    requireValue(allowedSources.includes(job.source), `${label}来源不受支持或与快照不一致。`);
    const route = sourceRoutes.get(job.source);
    const idMatch = typeof job.id === "string" ? route.idPattern.exec(job.id) : null;
    requireValue(idMatch !== null && idMatch[0] === job.id && !ids.has(job.id), `${label}标识无效或重复。`);
    ids.add(job.id);
    const expectedPath = route.pathFor(idMatch[1]);
    const url = safeJobUrl(job.url, job.source);
    requireValue(url !== null && new URL(url).pathname === expectedPath, `${label}必须使用与来源及标识一致、无跟踪参数的原始岗位链接。`);
    for (const key of textKeys) {
      requireValue(job[key] === null || isText(job[key]), `${label}的 ${key} 必须是文字或 null。`);
    }
    for (const key of listKeys) {
      requireValue(Array.isArray(job[key]) && job[key].every(isText), `${label}的 ${key} 必须是文字列表。`);
    }
    for (const key of ["salaryMinK", "salaryMaxK", "salaryMonths"]) {
      requireValue(job[key] === null || (typeof job[key] === "number" && Number.isFinite(job[key]) && job[key] > 0), `${label}的 ${key} 必须是正数或 null。`);
    }
    requireValue(job.salaryMinK === null || job.salaryMaxK === null || job.salaryMinK <= job.salaryMaxK, `${label}薪资区间顺序无效。`);
    requireValue(job.matchScore === null || (typeof job.matchScore === "number" && Number.isFinite(job.matchScore) && job.matchScore >= 0 && job.matchScore <= 100), `${label}初筛参考分必须在 0–100 之间或为 null。`);
    requireValue(typeof job.jdRead === "boolean" && typeof job.isNew === "boolean", `${label}阅读或新增标记无效。`);
    requireValue(isIsoDate(job.firstSeen) && isIsoDate(job.lastSeen), `${label}收录时间无效。`);
    requireValue(job.publishedAt === null || isIsoDate(job.publishedAt), `${label}源站发布时间无效。`);
    requireValue(observationOrder(job.firstSeen, job.lastSeen) <= 0 && observationOrder(job.lastSeen, value.generatedAt) <= 0, `${label}观察时间顺序无效。`);
  }
  requireValue(jobs.filter((job) => job.isNew).length === run.newCount, "本轮新增数量与岗位标记不一致。");
  requireValue(jobs.filter((job) => job.jdRead).length <= run.detailsRead, "详情阅读数量与岗位标记不一致。");
  if (scheduled) {
    const automation = value.automation;
    requireValue(hasExactKeys(automation, [
      "version", "enabled", "timeZone", "times", "runId", "startedAt", "completedAt", "status",
      "freshSources", "retainedSources", "reviewedThisRun", "detailsThisRun",
    ]), "定时采样说明字段无效。");
    requireValue(automation.version === 1 && typeof automation.enabled === "boolean"
      && automation.timeZone === "Asia/Shanghai" && JSON.stringify(automation.times) === '["09:30","12:30"]'
      && automation.status === "sampled" && typeof automation.runId === "string"
      && /^[a-z0-9-]{8,90}$/.test(automation.runId), "定时采样标记无效。");
    requireValue(isIsoDate(automation.startedAt, false) && isIsoDate(automation.completedAt, false)
      && Date.parse(automation.startedAt) <= Date.parse(automation.completedAt)
      && automation.completedAt === value.generatedAt, "定时采样时间无效。");
    requireValue(JSON.stringify(automation.freshSources) === '["BOSS直聘"]'
      && JSON.stringify(automation.retainedSources) === '["字节跳动招聘官网","猎聘"]', "采样来源说明无效。");
    requireValue(Number.isSafeInteger(automation.reviewedThisRun) && automation.reviewedThisRun >= 0
      && automation.reviewedThisRun <= run.cardsReviewed
      && Number.isSafeInteger(automation.detailsThisRun) && automation.detailsThisRun >= 0
      && automation.detailsThisRun <= automation.reviewedThisRun, "定时采样计数无效。");
    requireValue(hasExactKeys(value.assessmentMethods, jobs.map((job) => job.id))
      && Object.values(value.assessmentMethods).every((method) => ["human-assisted", "rules-v1"].includes(method)), "岗位初筛方式说明无效。");
  }
  return value;
}

export function hasSalaryRange(job) {
  return job.salaryMinK !== null || job.salaryMaxK !== null;
}

export function parseSalaryRange(minimum, maximum) {
  const parse = (value) => value.trim() === "" ? null : Number(value);
  const min = parse(minimum), max = parse(maximum);
  if ([min, max].some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
    return { min, max, error: "请输入有效的非负月薪金额。" };
  }
  if (min !== null && max !== null && min > max) {
    return { min, max, error: "最低月薪不能高于最高月薪。" };
  }
  return { min, max, error: null };
}

function normalizeText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

function searchableText(job) {
  return normalizeText([
    ...textKeys.map((key) => job[key] ?? ""), job.source,
    ...listKeys.flatMap((key) => job[key]),
  ].join(" "));
}

function searchTerms(keyword) {
  const tokens = normalizeText(keyword).split(/\s+/u).filter(Boolean);
  const terms = [];
  for (let index = 0; index < tokens.length;) {
    const alias = aliasPhrases.find((phrase) =>
      phrase.tokens.every((token, offset) => token === tokens[index + offset]));
    const term = alias ?? { category: null, tokens: [tokens[index]] };
    terms.push(term);
    index += term.tokens.length;
  }
  return terms;
}

function matchesSearch(job, terms) {
  const text = searchableText(job);
  // Aliases target the reviewed category, never infer a category from the title.
  return terms.every(({ category, tokens }) => (category !== null && job.category === category)
    || tokens.every((token) => {
      const pattern = wordAliasPatterns.get(token);
      return pattern ? pattern.test(text) : text.includes(token);
    }));
}

function priorityRank(priority) {
  return priorityOrder.get(priority) ?? priorityOrder.size;
}

export function selectJobs(jobs, {
  keyword = "", category = "", priority = "", newOnly = false,
  salaryMin = null, salaryMax = null, salaryMode = "all", sortBy = "score",
} = {}) {
  if (!["all", "known", "unknown"].includes(salaryMode) || !["score", "firstSeen", "priority"].includes(sortBy)) {
    throw new RangeError("不支持的筛选或排序方式。");
  }
  if ([salaryMin, salaryMax].some((value) => value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
    || (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax)) {
    throw new RangeError("薪资筛选区间无效。");
  }
  const terms = searchTerms(keyword);
  const selected = jobs.filter((job) => {
    if (category && (job.category ?? "待确认") !== category) return false;
    if (priority && (job.priority ?? "待确认") !== priority) return false;
    if (newOnly && !job.isNew) return false;
    if (terms.length && !matchesSearch(job, terms)) return false;
    const knownSalary = hasSalaryRange(job);
    if (salaryMode === "unknown") return !knownSalary;
    if (!knownSalary) return salaryMode === "all";
    if (salaryMin !== null && job.salaryMaxK !== null && job.salaryMaxK < salaryMin) return false;
    if (salaryMax !== null && job.salaryMinK !== null && job.salaryMinK > salaryMax) return false;
    return true;
  });
  return selected.sort((a, b) => {
    if (sortBy === "priority") {
      const priorityDifference = priorityRank(a.priority) - priorityRank(b.priority);
      if (priorityDifference) return priorityDifference;
    }
    if (sortBy !== "firstSeen") {
      const scoreOrder = (b.matchScore ?? -1) - (a.matchScore ?? -1);
      if (scoreOrder) return scoreOrder;
    }
    return Date.parse(b.firstSeen) - Date.parse(a.firstSeen) || collator.compare(a.id, b.id);
  });
}

export function filterOptions(jobs, key) {
  if (!["category", "priority"].includes(key)) throw new RangeError("不支持的筛选字段。");
  const counts = new Map();
  for (const job of jobs) {
    const name = job[key] ?? "待确认";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) =>
    (key === "priority" ? priorityRank(a) - priorityRank(b) : 0) || collator.compare(a, b));
}
