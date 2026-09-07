export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotError";
  }
}

const rootKeys = ["version", "generatedAt", "run", "jobs"];
const runKeys = ["source", "scope", "mode", "cardsReviewed", "detailsRead", "selectedCount", "newCount"];
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

export function safeJobUrl(value) {
  if (typeof value !== "string" || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
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
  requireValue(hasExactKeys(value, rootKeys), "快照字段不完整或包含不支持的字段。");
  requireValue(value.version === 1, "不支持的快照版本。");
  requireValue(isIsoDate(value.generatedAt, false), "快照生成时间必须包含时区。");
  requireValue(hasExactKeys(value.run, runKeys), "采集概览字段不完整或包含不支持的字段。");
  const { run, jobs } = value;
  requireValue(run.source === "BOSS直聘" && run.mode === "单次采集" && isText(run.scope), "采集来源、范围或模式无效。");
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
    requireValue(typeof job.id === "string" && /^boss-[A-Za-z0-9_~-]+$/.test(job.id) && !ids.has(job.id), `${label}标识无效或重复。`);
    ids.add(job.id);
    const url = safeJobUrl(job.url);
    requireValue(url !== null && new URL(url).pathname === `/job_detail/${job.id.slice(5)}.html`, `${label}必须使用无跟踪参数的 BOSS直聘原始岗位链接。`);
    requireValue(job.source === run.source, `${label}来源与快照不一致。`);
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
  requireValue(jobs.filter((job) => job.isNew).length === run.newCount, "本次新增数量与岗位标记不一致。");
  requireValue(jobs.filter((job) => job.jdRead).length <= run.detailsRead, "详情阅读数量与岗位标记不一致。");
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

export function selectJobs(jobs, {
  keyword = "", category = "", priority = "", newOnly = false,
  salaryMin = null, salaryMax = null, salaryMode = "all", sortBy = "score",
} = {}) {
  if (!["all", "known", "unknown"].includes(salaryMode) || !["score", "firstSeen"].includes(sortBy)) {
    throw new RangeError("不支持的筛选或排序方式。");
  }
  if ([salaryMin, salaryMax].some((value) => value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
    || (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax)) {
    throw new RangeError("薪资筛选区间无效。");
  }
  const tokens = normalizeText(keyword).split(/\s+/u).filter(Boolean);
  const selected = jobs.filter((job) => {
    if (category && (job.category ?? "待确认") !== category) return false;
    if (priority && (job.priority ?? "待确认") !== priority) return false;
    if (newOnly && !job.isNew) return false;
    if (tokens.length && !tokens.every((token) => searchableText(job).includes(token))) return false;
    const knownSalary = hasSalaryRange(job);
    if (salaryMode === "unknown") return !knownSalary;
    if (!knownSalary) return salaryMode === "all";
    if (salaryMin !== null && job.salaryMaxK !== null && job.salaryMaxK < salaryMin) return false;
    if (salaryMax !== null && job.salaryMinK !== null && job.salaryMinK > salaryMax) return false;
    return true;
  });
  return selected.sort((a, b) => {
    if (sortBy === "score") {
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
  return [...counts.entries()].sort(([a], [b]) => collator.compare(a, b));
}
