import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, updateLedger, validateLedger } from "../scheduler/snapshot.mjs";
import { validateSnapshot } from "../docs/model.mjs";
import { fixture, bytedanceFixture, liepinFixture, snapshotOf } from "./helpers/fixtures.mjs";

test("scheduler preserves prior manual decisions, salary and old observations unless actually seen", () => {
  const jobs = [fixture({ salaryText: "15-30K", salaryMinK: 15, salaryMaxK: 30 }), bytedanceFixture(), liepinFixture()];
  const previous = snapshotOf(jobs, "BOSS直聘 + 字节跳动招聘官网 + 猎聘");
  const before = structuredClone(previous);
  const ledger = { version: 1, reviewedIds: jobs.map((job) => job.id), detailIds: jobs.map((job) => job.id) };
  const observedAt = "2026-09-07T12:00:00Z";
  const evidence = { cards: [{ ...jobs[0], salaryText: null, retrievedAt: observedAt }], details: [] };
  const result = buildSnapshot(previous, evidence, [], ledger, {
    runId: "2026-09-07-1230", startedAt: "2026-09-07T04:30:00Z", generatedAt: "2026-09-07T12:00:01Z",
  });
  assert.equal(result.jobs.length, 3);
  assert.equal(result.run.newCount, 0);
  assert.equal(result.jobs[0].salaryText, "15-30K");
  assert.equal(result.jobs[0].firstSeen, jobs[0].firstSeen);
  assert.equal(result.jobs[0].lastSeen, observedAt);
  assert.equal(result.jobs[1].lastSeen, jobs[1].lastSeen);
  assert.equal(result.jobs[2].lastSeen, jobs[2].lastSeen);
  assert.deepEqual(Object.values(result.assessmentMethods), ["human-assisted", "human-assisted", "human-assisted"]);
  assert.deepEqual(result.automation.freshSources, ["BOSS直聘"]);
  assert.deepEqual(result.automation.retainedSources, ["字节跳动招聘官网", "猎聘"]);
  assert.deepEqual(previous, before);
});

test("unique evidence counts do not accumulate duplicates and new selections alone get rules provenance", () => {
  const old = fixture();
  const newJob = fixture({ id: "boss-unit-test-added", url: "https://www.zhipin.com/job_detail/unit-test-added.html" });
  const evidence = { cards: [newJob, newJob, old], details: [newJob, newJob] };
  const initial = { version: 1, reviewedIds: [old.id], detailIds: [old.id] };
  const ledger = updateLedger(initial, evidence);
  assert.equal(ledger.reviewedIds.length, 2);
  assert.equal(ledger.detailIds.length, 2);
  assert.deepEqual(updateLedger(ledger, evidence), ledger);
  const result = buildSnapshot(snapshotOf([old]), { cards: [], details: [] },
    [{ decision: "select", job: newJob }], ledger, {
      runId: "2026-09-07-1230", startedAt: "2026-09-07T04:30:00Z", generatedAt: "2026-09-07T12:00:01Z",
    });
  assert.equal(result.run.newCount, 1);
  assert.equal(result.assessmentMethods[old.id], "human-assisted");
  assert.equal(result.assessmentMethods[newJob.id], "rules-v1");
  assert.equal(validateSnapshot(result), result);
  const missingProvenance = { ...result };
  delete missingProvenance.automation;
  delete missingProvenance.assessmentMethods;
  assert.throws(() => validateSnapshot(missingProvenance), /缺少采样/);
  assert.throws(() => validateSnapshot({ ...result, automation: { ...result.automation, status: "succeeded" } }));
  assert.throws(() => validateSnapshot({ ...result, assessmentMethods: { ...result.assessmentMethods, privateProfile: "data" } }));
  assert.throws(() => validateLedger({ version: 1, reviewedIds: [old.id], detailIds: [newJob.id] }));
});
