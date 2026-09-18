import test from "node:test";
import assert from "node:assert/strict";
import { assessRoleExclusion, feedbackRolePolicy, emptyRoleHistory } from "../scheduler/role-exclusions.mjs";
import { buildCandidateSnapshot, filterRoleCandidates } from "../scheduler/candidates.mjs";
import { defaultIntentPolicy } from "../scheduler/intent.mjs";
import { emptyReviewQueue, updateReviewQueue } from "../scheduler/review.mjs";
import { snapshotOf } from "./helpers/fixtures.mjs";

const policy = feedbackRolePolicy(4);
const observedAt = "2026-09-10T01:00:00Z", now = "2026-09-12T01:00:00Z";
const jd = (duties) => `岗位职责：\n${duties}\n任职要求：\n需要岗位相关经验和沟通协作能力，实际条件仍需要向来源确认；这是用于验证职责边界的简短合成文本，不是真实招聘描述。`;
const partnerDuties = "负责招募代理伙伴，推进伙伴准入。\n负责伙伴赋能、联合销售和伙伴转售指标。";
const assistanceDuties = "协助领导安排日常行程和会议预约。\n负责汇总部门报表及资料整理。\n处理上下级之间的事务传达。\n协助外部联系并维护渠道关系。";
const card = (id, title, details) => ({
  id: `boss-broad-boundary-${id}`, title, company: "TEST_ONLY_COMPANY", source: "BOSS直聘",
  url: `https://www.zhipin.com/job_detail/broad-boundary-${id}.html`, retrievedAt: observedAt,
  location: "上海", salaryText: null, experienceText: null, educationText: null,
  ...(details ? { jd: details } : {}),
});
const records = [
  card("ads", "媒.介/广/告销/售+40-50W"), card("direct", "直营销售经理"),
  card("assistant", "中层协助管理", jd(assistanceDuties)), card("unknown", "机构业务经理"), card("test", "测试"),
];
const queue = updateReviewQueue(emptyReviewQueue(), [records[2]], [{
  id: records[2].id, intent: { decision: "unclear", family: null, reasons: ["test-only"] },
  qualification: { status: "pending", reasons: ["test-only"] },
}], "test-broad-boundary");
const evidence = { cards: records, details: [records[2]], queries: [], complete: true };
const ledger = { version: 1, reviewedIds: records.map((item) => item.id), detailIds: [records[2].id] };
const build = (roleContext) => buildCandidateSnapshot(snapshotOf([]), evidence, queue, ledger, {
  policy: defaultIntentPolicy(), roleContext, runId: "test-broad-boundary", sampledAt: observedAt, now,
});

test("explicit media/direct sales does not depend on full JD availability or imply that every terse title is known", () => {
  for (const [title, category] of [["媒.介/广/告销/售+40-50W", "frontline-sales"],
    ["广告销售经理", "frontline-sales"], ["直营销售经理", "frontline-sales"]]) {
    assert.deepEqual(assessRoleExclusion({ title }, policy),
      { category, reasonCode: `role-${category}`, basis: "title" });
    assert.equal(assessRoleExclusion({ title }, feedbackRolePolicy(3)), null);
  }
  for (const title of ["广告科技伙伴经理", "媒体渠道销售经理", "测试设备渠道销售", "直营渠道运营",
    "广告销售支持", "广告销售助理", "销售运营", "机构业务经理", "测试"]) {
    assert.equal(assessRoleExclusion({ title }, policy), null, title);
  }
  assert.equal(assessRoleExclusion({ title: "广告销售经理", jd: jd(partnerDuties) }, policy), null);
});

test("an assistant's own internal administration differs from incidental coordination for real partners", () => {
  assert.deepEqual(assessRoleExclusion(records[2], policy),
    { category: "internal-operations", reasonCode: "role-internal-operations", basis: "duties" });
  assert.equal(assessRoleExclusion({ title: records[2].title }, policy), null);
  assert.equal(assessRoleExclusion(records[2], feedbackRolePolicy(3)), null);
  for (const duties of [
    partnerDuties,
    `${partnerDuties}\n${assistanceDuties}`,
    "负责安排伙伴培训行程。\n负责整理伙伴业务报表和联合商机资料。",
    "负责管理渠道伙伴，并协同销售团队开展客户测试。\n负责偶尔整理联合商机报表。",
    "不负责领导日程预约。\n不承担部门报表汇总或资料整理。\n负责协助伙伴获取市场资料。",
    "负责协调领导日程。\n负责产品业务沟通，但不承担内部资料整理。",
  ]) assert.equal(assessRoleExclusion({ title: "商业伙伴协作", jd: jd(duties) }, policy), null, duties);
});

test("current, maintenance and history-backed candidate merges preserve unknowns and exact retained dates", () => {
  const original = build({ policy: null, history: emptyRoleHistory() }).snapshot;
  const filtered = filterRoleCandidates(original, queue, { policy, history: emptyRoleHistory() }, evidence.details);
  assert.deepEqual(new Set(filtered.removals.map((item) => item.id)), new Set(records.slice(0, 3).map((item) => item.id)));
  assert.deepEqual(filtered.snapshot.jobs, original.jobs.slice(3));
  assert.equal(filtered.snapshot.firstPublishedAtById[records[4].id], original.firstPublishedAtById[records[4].id]);
  assert.deepEqual(filtered.snapshot.candidateFeed, original.candidateFeed);
  assert.deepEqual(build({ policy, history: emptyRoleHistory() }).snapshot.jobs, filtered.snapshot.jobs);
  const history = { version: 1, entries: filtered.removals.map((item) => ({
    ...item, policyId: policy.id, policyVersion: policy.version, filteredAt: now,
  })) };
  const sparse = { ...evidence, cards: records.map((record) => ({ ...record, title: "渠道合作", jd: undefined })), details: [] };
  const replay = buildCandidateSnapshot(filtered.snapshot, sparse, emptyReviewQueue(), ledger, {
    policy: defaultIntentPolicy(), roleContext: { policy, history }, runId: "test-sparse-reobservation", sampledAt: observedAt, now,
  });
  assert.deepEqual(replay.snapshot.jobs.map((item) => item.id), records.slice(3).map((item) => item.id));
});

test("administrative duties cannot be borrowed from a conflicting or unread detail", () => {
  const conflicted = buildCandidateSnapshot(snapshotOf([]), {
    ...evidence, detailConflicts: [{ id: records[2].id, code: "detail-title-conflict" }],
  }, queue, ledger, {
    policy: defaultIntentPolicy(), roleContext: { policy, history: emptyRoleHistory() },
    runId: "test-conflicted-assistance", sampledAt: observedAt, now,
  });
  assert.equal(conflicted.snapshot.jobs.find((job) => job.id === records[2].id)?.jdRead, false);
  assert.deepEqual(conflicted.removals.map((item) => item.id), records.slice(0, 2).map((item) => item.id));
  assert.ok(conflicted.snapshot.jobs.some((job) => job.id === records[4].id));
});
