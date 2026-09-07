import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState, run, finalStatus } from "../scheduler/runner.mjs";
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
