import { createHash } from "node:crypto";
import { isIsoDate, safeJobUrl, validateSnapshot } from "../docs/model.mjs";
import { assessIntent, validateIntentPolicy } from "./intent.mjs";
import { parseJobSections } from "./screening.mjs";
import { validateReviewQueue } from "./review.mjs";
import { validateLedger } from "./snapshot.mjs";
import { RunError } from "./io.mjs";
import { assessRoleExclusion, validateRolePolicy, validateRoleHistory, emptyRoleHistory } from "./role-exclusions.mjs";

const metadata = ["id", "source", "url", "title", "company", "location", "experienceText", "educationText", "salaryText"];
const unsafe = /[\p{Co}\p{Cc}\p{Cf}]|https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?86[- ]?)?1[3-9](?:[- ]?\d){9}|0\d{2,3}[- ]?\d{7,8}|securityid|(?:token|cookie|authorization)\s*[:=]|(?<!企业)微信|(?:加|添加|联系|扫码).{0,8}企业微信|企业微信\s*[:：]|手机号|简历|验证码|扫码登录/iu;
const normalize = (value) => typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/gu, " ") : null;
const safeText = (value, limit = 120) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || unsafe.test(value)) return null;
  const text = normalize(value);
  return text && text.length <= limit && !unsafe.test(text) ? text : null;
};
const categories = {
  "partner-development": "伙伴发展", "channel-management": "渠道销售", "business-ecosystem": "生态商业化",
  "customer-success": "客户成功", "account-sales": "大客户销售",
};

export function sourceCard(record, now) {
  if (!record || typeof record !== "object") return { code: "invalid-card" };
  const source = record.source ?? "BOSS直聘";
  const url = safeJobUrl(record.url, source);
  if (source !== "BOSS直聘" || !url || typeof record.id !== "string"
    || record.id !== `boss-${new URL(url).pathname.slice(12, -5)}`) return { code: "invalid-card-identity" };
  if (!isIsoDate(record.retrievedAt, false) || Date.parse(record.retrievedAt) > Date.parse(now)) return { code: "invalid-card-observation" };
  const title = safeText(record.title);
  if (!title) return { code: "unsafe-or-missing-title" };
  return { card: {
    id: record.id, source, url, title, company: safeText(record.company),
    location: safeText(record.location), experienceText: safeText(record.experienceText, 60),
    educationText: safeText(record.educationText, 60), salaryText: safeText(record.salaryText, 80),
    metadataHash: cardMetadataHash({ ...Object.fromEntries(metadata.map((key) => [key, record[key]])), source, url }),
    retrievedAt: record.retrievedAt,
  } };
}

export function cardMetadataHash(card) {
  return createHash("sha256").update(JSON.stringify(metadata.map((key) => normalize(card[key])))).digest("hex");
}

export function rejectedCandidateIds(queue, excludedIds = new Set()) {
  return new Set([...excludedIds, ...validateReviewQueue(queue).entries.filter((entry) => entry.status === "rejected").map((entry) => entry.id)]);
}

export function candidateEvidence(evidence, now = new Date().toISOString()) {
  if (!evidence || !Array.isArray(evidence.cards) || !Array.isArray(evidence.details)
    || [evidence.detailConflicts, evidence.incompleteDetails].some((items) => items !== undefined && !Array.isArray(items))) {
    throw new RunError("invalid-candidate-evidence", "Candidate evidence requires typed source-card and detail lists.");
  }
  const cards = evidence.cards.filter((record) => sourceCard(record, now).card);
  const byId = new Map(cards.map((record) => [record.id, sourceCard(record, now).card]));
  const conflicts = new Set([...(evidence.detailConflicts ?? []), ...(evidence.incompleteDetails ?? [])].map((item) => item?.id));
  const details = evidence.details.filter((record) => {
    const checked = sourceCard(record, now).card, card = byId.get(record?.id);
    return checked && card && !conflicts.has(record.id) && checked.metadataHash === card.metadataHash
      && typeof record.jd === "string" && record.jd.length >= 80 && record.jd.length <= 60000;
  });
  return { ...evidence, cards, details };
}

function sourceSummary(parsed) {
  const templates = [
    [/伙伴|渠道|代理商/u, "职责涉及合作伙伴或渠道业务，具体分工请核对原岗位。"],
    [/联合打单|商机互荐|联合销售/u, "职责涉及商机协同或联合销售。"],
    [/独立.{0,12}(?:开发|谈判|签约)|回款/u, "职责含独立客户推进、商务环节或回款责任，需进一步确认边界。"],
    [/战略|研究报告|高管/u, "职责同时涉及研究、战略或管理层支持。"],
  ];
  const summary = templates.filter(([pattern]) => pattern.test(parsed.duties)).map(([, text]) => text);
  return summary.length ? summary : ["已读取可分离的岗位职责与要求，仅作为来源记录展示，不表示适合。"];
}

export function buildCandidateSnapshot(previous, evidence, queue, ledger, {
  policy, excludedIds = new Set(), runId, sampleRunId = runId, sampledAt,
  publicationKind = "scheduled", now = new Date().toISOString(),
  roleContext = { policy: null, history: emptyRoleHistory() },
}) {
  validateSnapshot(previous);
  validateReviewQueue(queue);
  validateLedger(ledger);
  validateIntentPolicy(policy);
  if (!evidence || evidence.complete !== true || !Array.isArray(evidence.cards) || !Array.isArray(evidence.details)
    || !isIsoDate(sampledAt, false) || Date.parse(sampledAt) > Date.parse(now)) {
    throw new RunError("incomplete-candidate-sample", "Only an actually completed source sample can update the candidate feed.");
  }
  const verifiedSample = candidateEvidence(evidence, sampledAt);
  const rejected = rejectedCandidateIds(queue, excludedIds);
  const observations = new Map(), details = new Map(), firstSeen = new Map(), rejectedRecords = [];
  const ingest = (record, first = record?.retrievedAt, includeDetail = false) => {
    const checked = sourceCard(record, now);
    if (!checked.card) { rejectedRecords.push({ code: checked.code }); return; }
    const card = checked.card;
    if (rejected.has(card.id)) return;
    if (!isIsoDate(first, false) || Date.parse(first) > Date.parse(card.retrievedAt)) {
      throw new RunError("invalid-candidate-first-seen", "A candidate must retain its genuine first observation.");
    }
    if (!firstSeen.has(card.id) || Date.parse(first) < Date.parse(firstSeen.get(card.id))) firstSeen.set(card.id, first);
    if (!observations.has(card.id) || Date.parse(card.retrievedAt) >= Date.parse(observations.get(card.id).retrievedAt)) observations.set(card.id, card);
    if (includeDetail && typeof record.jd === "string") {
      const old = details.get(card.id);
      if (!old || Date.parse(card.retrievedAt) >= Date.parse(old.card.retrievedAt)) details.set(card.id, { card, jd: record.jd });
    }
  };
  for (const entry of queue.entries) ingest({ ...entry.evidence, retrievedAt: entry.lastSeen }, entry.firstSeen, true);
  for (const record of evidence.cards) {
    if (verifiedSample.cards.includes(record)) ingest(record);
    else rejectedRecords.push({ code: sourceCard(record, sampledAt).code });
  }
  for (const record of evidence.details) {
    if (record && evidence.cards.some((card) => card?.id === record.id)) {
      // A detail never replaces the source card identity selected in the authenticated search.
      const checked = sourceCard(record, sampledAt);
      if (checked.card) {
        const old = details.get(record.id);
        if (!old || Date.parse(checked.card.retrievedAt) >= Date.parse(old.card.retrievedAt)) details.set(record.id, { card: checked.card, jd: record.jd });
      }
    }
  }
  const jobs = new Map(previous.jobs.filter((job) => !rejected.has(job.id)).map((job) => [job.id, { ...job, isNew: false }]));
  const methods = Object.fromEntries([...jobs.values()].map((job) => [job.id, previous.assessmentMethods?.[job.id] ?? "human-assisted"]));
  const states = Object.fromEntries(Object.entries(previous.candidateStatesById ?? {}).filter(([id]) => jobs.has(id)));
  const dates = Object.fromEntries(Object.entries(previous.firstPublishedAtById ?? {}).filter(([id]) => jobs.has(id)));
  const conflicts = new Set((evidence.detailConflicts ?? []).map((item) => item?.id));
  const incomplete = new Set((evidence.incompleteDetails ?? []).map((item) => item?.id));
  const ledgerIds = new Set(ledger.reviewedIds), ledgerDetails = new Set(ledger.detailIds);
  for (const [id, card] of observations) {
    if (!ledgerIds.has(id)) throw new RunError("candidate-evidence-missing", "A candidate card has no authenticated observation ledger entry.");
    const old = jobs.get(id), oldState = states[id];
    if (old && !oldState) continue;
    if (old && Date.parse(old.lastSeen) > Date.parse(card.retrievedAt)) continue;
    const detail = details.get(id);
    let evidenceState = conflicts.has(id) ? "identity-conflict" : incomplete.has(id) ? "incomplete-jd" : "card-only";
    let parsed = null, direction = { decision: "unclear", family: null };
    if (detail && evidenceState === "card-only") {
      if (detail.card.metadataHash !== card.metadataHash) evidenceState = "identity-conflict";
      else if (typeof detail.jd !== "string" || detail.jd.length < 80 || detail.jd.length > 60000) evidenceState = "incomplete-jd";
      else if (oldState && ["identity-conflict", "incomplete-jd"].includes(oldState.evidence)
        && Date.parse(detail.card.retrievedAt) < Date.parse(oldState.evidenceObservedAt)) evidenceState = oldState.evidence;
      else {
        parsed = parseJobSections({ jd: detail.jd });
        if (!parsed?.duties || !parsed.requirements) evidenceState = "incomplete-jd";
        else {
          if (!ledgerDetails.has(id)) throw new RunError("candidate-detail-missing", "A full-JD candidate has no matching detail ledger entry.");
          evidenceState = "full-jd";
          direction = assessIntent({ jd: detail.jd }, policy);
        }
      }
    }
    const full = evidenceState === "full-jd";
    const lastSeen = full && Date.parse(detail.card.retrievedAt) > Date.parse(card.retrievedAt) ? detail.card.retrievedAt : card.retrievedAt;
    jobs.set(id, {
      id, title: card.title, company: card.company, city: card.location?.startsWith("上海") ? "上海" : null,
      location: card.location, source: card.source, url: card.url,
      salaryText: card.salaryText, salaryMinK: null, salaryMaxK: null, salaryMonths: null,
      experienceText: card.experienceText, educationText: card.educationText, category: full ? categories[direction.family] ?? null : null,
      matchScore: null, priority: "采样候选 · 待你判断",
      summary: full ? sourceSummary(parsed) : ["尚未取得可完整核对的 JD，请查看原岗位。"],
      requirements: [], matchReasons: [],
      concerns: ["来自有限搜索采样，尚未人工选入；方向、任职资格、岗位有效性及实际条件均需自行核对。"],
      languageNote: null, publishedAt: null, firstSeen: old?.firstSeen ?? firstSeen.get(id), lastSeen,
      jdRead: full, isNew: !old,
    });
    states[id] = { evidence: evidenceState, direction: direction.decision, evidenceObservedAt: full ? detail.card.retrievedAt : card.retrievedAt };
    methods[id] = "source-only";
    if (!old) dates[id] = now;
  }
  const result = validateSnapshot({
    version: 1, generatedAt: now,
    run: { ...previous.run, mode: "采样候选 · 累计快照", cardsReviewed: ledger.reviewedIds.length,
      detailsRead: ledger.detailIds.length, selectedCount: jobs.size, newCount: [...jobs.values()].filter((job) => job.isNew).length },
    jobs: [...jobs.values()], assessmentMethods: methods, candidateStatesById: states, firstPublishedAtById: dates,
    candidateFeed: { version: 1, mode: "candidate-feed", publicationKind, runId, sampleRunId, sampledAt,
      cardsThisSample: new Set(verifiedSample.cards.map((card) => card.id)).size,
      detailsThisSample: new Set(verifiedSample.details.map((record) => record.id)).size, timeZone: "Asia/Shanghai", times: ["09:30", "12:30"] },
  });
  const filtered = filterRoleCandidates(result, queue, roleContext, evidence.details);
  return { ...filtered, rejectedRecords };
}

export function boundRoleEvidence(job, state, queue, records = []) {
  if (!job.jdRead || (state && state.evidence !== "full-jd")) return null;
  const observedAt = state?.evidenceObservedAt ?? job.lastSeen;
  const publicCard = sourceCard({ ...job, retrievedAt: observedAt }, job.lastSeen).card;
  if (!publicCard) return null;
  const entry = queue.entries.find((item) => item.id === job.id);
  const candidates = [...records, ...(entry ? [{ ...entry.evidence, retrievedAt: entry.lastSeen }] : [])];
  return candidates.find((record) => {
    if (!record || record.id !== job.id || record.retrievedAt !== observedAt) return false;
    const source = sourceCard(record, job.lastSeen).card;
    return source && source.metadataHash === publicCard.metadataHash && typeof record.jd === "string";
  }) ?? null;
}

export function filterRoleCandidates(snapshot, queue, context, records = []) {
  validateSnapshot(snapshot);
  validateReviewQueue(queue);
  if (context.policy === null) return { snapshot, removals: [], selectionConflicts: [] };
  validateRolePolicy(context.policy);
  validateRoleHistory(context.history);
  const removals = [], selectionConflicts = [];
  for (const job of snapshot.jobs) {
    const state = snapshot.candidateStatesById?.[job.id];
    const historic = state && context.history.entries.find((entry) => entry.id === job.id);
    const detail = boundRoleEvidence(job, state, queue, records);
    const decision = historic ?? assessRoleExclusion({ title: job.title, jd: detail?.jd }, context.policy);
    if (!decision) continue;
    const item = { id: job.id, category: decision.category, reasonCode: decision.reasonCode, basis: decision.basis,
      observedAt: historic?.observedAt ?? (decision.basis === "duties" ? detail.retrievedAt : job.lastSeen) };
    (state ? removals : selectionConflicts).push(item);
  }
  const blocked = new Set(removals.map((item) => item.id));
  if (!blocked.size) return { snapshot, removals, selectionConflicts };
  return { snapshot: withoutSnapshotJobs(snapshot, blocked), removals, selectionConflicts };
}

export function withoutSnapshotJobs(snapshot, blocked) {
  const jobs = snapshot.jobs.filter((job) => !blocked.has(job.id));
  return validateSnapshot({
    ...snapshot, jobs, run: { ...snapshot.run, selectedCount: jobs.length, newCount: jobs.filter((job) => job.isNew).length },
    assessmentMethods: Object.fromEntries(Object.entries(snapshot.assessmentMethods ?? {}).filter(([id]) => !blocked.has(id))),
    firstPublishedAtById: Object.fromEntries(Object.entries(snapshot.firstPublishedAtById ?? {}).filter(([id]) => !blocked.has(id))),
    ...(snapshot.candidateStatesById ? {
      candidateStatesById: Object.fromEntries(Object.entries(snapshot.candidateStatesById).filter(([id]) => !blocked.has(id))),
    } : {}),
  });
}
