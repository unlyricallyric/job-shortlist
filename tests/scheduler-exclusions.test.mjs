import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManualExclusions, loadManualExclusions, manualExcludedIds, validateManualExclusions, withdrawExcludedJobs } from "../scheduler/exclusions.mjs";
import { atomicJson } from "../scheduler/io.mjs";
import { buildSnapshot } from "../scheduler/snapshot.mjs";
import { validateSnapshot } from "../docs/model.mjs";
import { fixture, bytedanceFixture, liepinFixture, snapshotOf } from "./helpers/fixtures.mjs";

const excluded = (id) => ({ id, excludedAt: "2026-09-09T03:00:00Z", reasonCode: "user-direction-rejection" });

test("manual exclusions are exact source IDs, private, typed and never inferred from role keywords", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-exclusions-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await loadManualExclusions(root), emptyManualExclusions());
  const list = { version: 1, entries: [excluded(fixture().id), excluded(liepinFixture().id)] };
  await atomicJson(join(root, "manual-exclusions.json"), list);
  assert.deepEqual([...manualExcludedIds(await loadManualExclusions(root))], list.entries.map((entry) => entry.id));
  await chmod(join(root, "manual-exclusions.json"), 0o644);
  await assert.rejects(loadManualExclusions(root), { code: "private-permissions" });
  for (const invalid of [
    { version: 1, entries: [excluded("not-a-source-id")] },
    { version: 1, entries: [excluded(fixture().id), excluded(fixture().id)] },
    { version: 1, entries: [{ ...excluded(fixture().id), reasonCode: "automatically-inferred" }] },
    { version: 1, entries: [{ ...excluded(fixture().id), extra: "TEST_ONLY_PROFILE" }] },
    { version: 1, entries: [{ ...excluded(fixture().id), excludedAt: "yesterday" }] },
  ]) assert.throws(() => validateManualExclusions(invalid), { code: "invalid-manual-exclusions" });
});

test("withdrawal filters only exact excluded records and preserves all remaining evidence fields and counts", () => {
  const kept = fixture({ isNew: false });
  const removed = bytedanceFixture();
  const legitimateLater = liepinFixture({ isNew: true });
  const previous = snapshotOf([kept, removed, legitimateLater], "BOSS直聘 + 字节跳动招聘官网 + 猎聘");
  previous.run.cardsReviewed = 300;
  previous.run.detailsRead = 80;
  previous.assessmentMethods = { [kept.id]: "human-assisted", [removed.id]: "human-assisted", [legitimateLater.id]: "rules-v1" };
  const before = structuredClone(previous);
  const result = withdrawExcludedJobs(previous, { version: 1, entries: [excluded(removed.id)] }, "2026-09-09T03:00:00Z");
  assert.deepEqual(result.jobs, [kept, legitimateLater]);
  assert.equal(result.run.selectedCount, 2);
  assert.equal(result.run.newCount, 1);
  assert.equal(result.run.cardsReviewed, 300);
  assert.equal(result.run.detailsRead, 80);
  assert.equal(result.generatedAt, previous.generatedAt);
  assert.deepEqual(result.assessmentMethods, { [kept.id]: "human-assisted", [legitimateLater.id]: "rules-v1" });
  assert.equal(result.automation, undefined);
  assert.equal(result.publication.scheduler, "paused");
  assert.equal(validateSnapshot(result), result);
  assert.deepEqual(previous, before);
  assert.ok(!JSON.stringify(result).includes("user-direction-rejection"));
  assert.ok(!JSON.stringify(result).includes(removed.id));
});

test("future automatic merging cannot retain or re-admit an explicitly excluded ID", () => {
  const old = fixture();
  const rejected = bytedanceFixture();
  const newJob = liepinFixture();
  const previous = snapshotOf([old, rejected], "BOSS直聘 + 字节跳动招聘官网 + 猎聘");
  const ledger = { version: 1, reviewedIds: [old.id, rejected.id, newJob.id], detailIds: [old.id, rejected.id, newJob.id] };
  const result = buildSnapshot(previous, { cards: [], details: [] },
    [{ decision: "select", job: rejected }, { decision: "select", job: newJob }], ledger, {
      runId: "manual-test-exclusion", startedAt: "2026-09-09T01:00:00Z", generatedAt: "2026-09-09T02:00:00Z",
      maxNewJobs: 1, excludedIds: manualExcludedIds({ version: 1, entries: [excluded(rejected.id)] }),
    });
  assert.deepEqual(result.jobs.map((job) => job.id), [old.id, newJob.id]);
  assert.equal(result.run.newCount, 1);
  assert.ok(!Object.hasOwn(result.assessmentMethods, rejected.id));
});
