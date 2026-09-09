import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState, run, finalStatus, validateRunRequest } from "../scheduler/runner.mjs";
import { dueSlot } from "../scheduler/clock.mjs";
import { atomicJson, readJson, RunError } from "../scheduler/io.mjs";
import { defaultLimits, defaultQueries } from "../scheduler/config.mjs";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";
import { launchAgentPlist } from "../scheduler/install.mjs";
import { command } from "../scheduler/process.mjs";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = snapshotOf([fixture()]);
  await atomicJson(join(root, "state.json"), { ...initialState(new Date("2026-01-01T00:00:00Z")) });
  await atomicJson(join(root, "control.json"), { paused: false, cancelRunId: null });
  await atomicJson(join(root, "ledger.json"), { version: 1, reviewedIds: [fixture().id], detailIds: [fixture().id] });
  const calls = [];
  const services = {
    rules: { prefilterCard: () => ({ eligible: false }), screenJob: () => ({ decision: "review", reasons: [], job: null }) },
    loadConfiguration: async () => ({ runtime: { limits: defaultLimits, queries: defaultQueries }, matching: {} }),
    preflightGithub: async () => { calls.push("preflight"); },
    prepareClone: async () => ({ snapshot: previous }),
    collectBoss: async ({ onEvidence }) => {
      calls.push("collection");
      const evidence = { cards: [], details: [], queries: [{ empty: true }], complete: true };
      await onEvidence(evidence);
      return evidence;
    },
    publishSnapshot: async (_root, _runtime, _snapshot, _prepared, _signal, pending) => {
      calls.push("publish");
      await pending({ sha: "test-only-sha" });
      return { sha: "test-only-sha", url: "https://example.invalid/" };
    },
    notifyFailure: async () => { calls.push("notification"); },
    caffeinate: () => null,
  };
  return { root, services, calls, previous };
}

test("dry run has collection evidence but zero publication, and terminal success requires live publication", async (t) => {
  const { root, services, calls } = await setup(t);
  const result = await run(root, { dryRun: true, services });
  assert.equal(result.status, "dry-run");
  assert.deepEqual(calls, ["preflight", "collection"]);
  assert.equal((await readJson(join(root, "state.json"))).lastPublished, null);
  assert.throws(() => finalStatus({ dryRun: false, publication: null }), /cannot succeed/);
});

test("private manual exclusions are applied before detailed screening and again at publication merge", async (t) => {
  const { root, services } = await setup(t);
  const excluded = fixture();
  await atomicJson(join(root, "manual-exclusions.json"), { version: 1, entries: [{
    id: excluded.id, excludedAt: "2026-09-09T03:00:00Z", reasonCode: "user-direction-rejection",
  }] });
  services.rules = {
    prefilterCard: () => ({ eligible: true }),
    screenJob: () => assert.fail("Explicitly excluded records must not be screened for readmission."),
  };
  services.collectBoss = async ({ prefilter }) => {
    assert.deepEqual(prefilter(excluded), { eligible: false, reason: "manual-excluded" });
    return { cards: [{ ...excluded, retrievedAt: new Date().toISOString() }], details: [], queries: [], complete: true };
  };
  const result = await run(root, { dryRun: true, services });
  assert.equal(result.status, "dry-run");
  const candidate = await readJson(join(root, "runs", result.id, "candidate.json"));
  assert.equal(candidate.jobs.length, 0);
  assert.ok(!JSON.stringify(candidate).includes(excluded.id));
  assert.ok(!JSON.stringify(candidate).includes("user-direction-rejection"));
});

test("late first installation has only the latest noon catch-up, while an explicit run consumes that slot", async (t) => {
  const initialized = initialState(new Date("2026-09-07T15:00:00Z"));
  assert.equal(dueSlot(initialized, new Date("2026-09-07T15:00:00Z")).id, "2026-09-07-1230");
  const { root, services } = await setup(t);
  const result = await run(root, { services });
  assert.equal(result.status, "succeeded");
  assert.equal((await run(root, { tick: true, services })).status, "idle");
});

test("blocked source is attempted once per due slot, including after restart", async (t) => {
  const { root, services, calls } = await setup(t);
  services.collectBoss = async () => { calls.push("blocked"); throw new RunError("captcha", "Source needs user verification.", { blocked: true }); };
  const result = await run(root, { tick: true, services });
  assert.equal(result.status, "blocked");
  assert.equal(calls.includes("publish"), false);
  const next = await run(root, { tick: true, services });
  assert.equal(next.status, "idle");
  assert.equal(calls.filter((call) => call === "blocked").length, 1);
});

test("invalid runtime configuration is recorded once for the slot without starting a browser", async (t) => {
  const { root, services, calls } = await setup(t);
  services.loadConfiguration = async () => { throw new RunError("invalid-config", "Config invalid.", { blocked: true }); };
  const result = await run(root, { tick: true, services });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "invalid-config");
  assert.equal(calls.includes("collection"), false);
  assert.equal((await run(root, { tick: true, services })).status, "idle");
});
test("pause/cancellation during collection never advances to publication or succeeded", async (t) => {
  const { root, services, calls } = await setup(t);
  const collect = services.collectBoss;
  services.collectBoss = async (options) => {
    const result = await collect(options);
    await atomicJson(join(root, "control.json"), { paused: true, cancelRunId: null });
    return result;
  };
  const result = await run(root, { services });
  assert.equal(result.status, "cancelled");
  assert.equal(calls.includes("publish"), false);
  assert.equal((await readJson(join(root, "state.json"))).lastPublished, null);
});

test("publication failure preserves lastPublished and cannot become a successful slot", async (t) => {
  const { root, services } = await setup(t);
  services.publishSnapshot = async () => { throw new RunError("pages-timeout", "Expected live bytes not confirmed."); };
  const result = await run(root, { tick: true, services });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "pages-timeout");
  assert.equal((await readJson(join(root, "state.json"))).lastPublished, null);
  assert.equal((await run(root, { tick: true, services })).status, "idle");
});

test("persistent detail identity conflicts are private review only and never count as full JDs or selections", async (t) => {
  const { root, services } = await setup(t);
  const verified = { ...fixture(), retrievedAt: new Date().toISOString(), jd: "TEST_ONLY_VERIFIED_DETAIL" };
  const conflict = { ...fixture(), id: "boss-test-conflict", url: "https://www.zhipin.com/job_detail/test-conflict.html" };
  let screened = 0;
  services.rules = {
    prefilterCard: () => ({ eligible: true }),
    screenJob: (record) => {
      assert.equal(record.id, verified.id);
      screened++;
      return { decision: "review", reasons: ["TEST_ONLY"], job: null };
    },
  };
  services.collectBoss = async ({ onEvidence }) => {
    const evidence = { cards: [verified, conflict], details: [verified], queries: [], complete: true,
      detailConflicts: [{ id: conflict.id, code: "detail-title-conflict" }] };
    await onEvidence(evidence);
    return evidence;
  };
  const result = await run(root, { services });
  assert.equal(result.status, "succeeded");
  assert.equal(screened, 1);
  assert.equal(result.summary.details, 1);
  assert.equal(result.summary.detailConflicts, 1);
  assert.equal(result.summary.new, 0);
  const ledger = await readJson(join(root, "ledger.json"));
  assert.ok(!ledger.detailIds.includes(conflict.id));
  const review = await readJson(join(root, "runs", result.id, "review.json"));
  assert.ok(review.some((item) => item.id === conflict.id && item.reasons.includes("detail-title-conflict")));
});

test("launchd request executes with an explicit provenance and does not replay on next tick", async (t) => {
  const { root, services, calls } = await setup(t);
  await atomicJson(join(root, "request.json"), { id: "manual-test-request", dryRun: true });
  const result = await run(root, { tick: true, services });
  assert.equal(result.trigger, "launchd-manual");
  assert.equal(result.id, "manual-test-request");
  assert.equal(result.status, "dry-run");
  assert.equal(await readJson(join(root, "request.json"), null), null);
  assert.equal(calls.includes("publish"), false);
});

test("explicit slot retry uses the failed query rotation without clearing its failure or advancing the rotation", async (t) => {
  const { root, services } = await setup(t);
  const state = await readJson(join(root, "state.json"));
  state.lastScheduledSlot = "2099-01-01-1230";
  state.queryCursor = 6;
  await atomicJson(join(root, "state.json"), state);
  await atomicJson(join(root, "request.json"), {
    id: "retry-2099-01-01-1230-testonly", dryRun: false, retryOf: "2099-01-01-1230", queryCursor: 3,
  });
  const originalCollect = services.collectBoss;
  services.collectBoss = async (options) => {
    assert.equal(options.queries[0].term, defaultQueries[3].term);
    return originalCollect(options);
  };
  const result = await run(root, { tick: true, services });
  assert.equal(result.status, "succeeded");
  assert.equal(result.trigger, "launchd-retry");
  assert.equal(result.retryOf, "2099-01-01-1230");
  assert.equal((await readJson(join(root, "state.json"))).queryCursor, 6);
  assert.equal((await run(root, { tick: true, services })).status, "idle");
  for (const request of [{ id: "../unsafe", dryRun: false }, { id: "manual-request", dryRun: "false" },
    { id: "manual-request", dryRun: false, queryCursor: -1 }]) {
    assert.throws(() => validateRunRequest(request), { code: "invalid-request" });
  }
});

test("LaunchAgents use durable explicit executable arguments, bounded ticks and AC-only awake support", () => {
  const options = { root: "/TEST_ONLY/job-shortlist", nodePath: "/TEST_ONLY/bin/node" };
  const plist = launchAgentPlist(options);
  assert.ok(plist.includes("<integer>60</integer>"));
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(plist.includes("/TEST_ONLY/job-shortlist/app/scheduler/cli.mjs"));
  assert.ok(!/session-state|GH_TOKEN|GITHUB_TOKEN|copilot-desktop-gh|osascript/.test(plist));
  const awake = launchAgentPlist({ ...options, acOnly: true });
  assert.ok(awake.includes("<string>/usr/bin/caffeinate</string><string>-s</string>"));
  assert.ok(!/<string>-(d|u|i)<\/string>/.test(awake));
});

test("scheduler subprocesses cannot inherit injected GitHub app tokens", async () => {
  const output = await command(process.execPath, ["-e",
    "console.log(['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'].every(key=>process.env[key]===undefined))"],
  { env: { GH_TOKEN: "TEST_ONLY", GITHUB_TOKEN: "TEST_ONLY", GH_ENTERPRISE_TOKEN: "TEST_ONLY", GITHUB_ENTERPRISE_TOKEN: "TEST_ONLY" } });
  assert.equal(output, "true");
});
