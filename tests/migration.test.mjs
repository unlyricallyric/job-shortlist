import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readFile, writeFile, lstat, readdir, rm, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createCipheriv } from "node:crypto";
import {
  captureMigration, exportMigration, restoreMigration, inspectMigration, verifyRestoredMigration,
  sealMigration, openMigration, migrationInstallation,
} from "../scheduler/migration.mjs";
import { migrationJson, migrationHash, validateMigrationPayload } from "../scheduler/migration-schema.mjs";
import { atomicJson, readJson, acquireLock, RunError } from "../scheduler/io.mjs";
import { modeSettings, candidateMode, defaultIntentPolicy } from "../scheduler/intent.mjs";
import { candidateLimits, loadConfiguration, label, awakeLabel } from "../scheduler/config.mjs";
import { feedbackRolePolicy } from "../scheduler/role-exclusions.mjs";
import { emptyReviewQueue, updateReviewQueue, approveReviews } from "../scheduler/review.mjs";
import { cardFingerprint } from "../scheduler/coverage.mjs";
import { fixture } from "./helpers/fixtures.mjs";
import { install } from "../scheduler/install.mjs";
import { command } from "../scheduler/process.mjs";

const runId = "manual-test-migration-source";
const seen = "2026-01-02T01:00:00.000Z", published = "2026-01-02T01:02:00.000Z";
const baseSha = "a".repeat(40), sourceCommit = "b".repeat(40);

async function setup(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "shortlist-migration-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "source"), repo = join(directory, "repo");
  const full = fixture({ firstSeen: seen, lastSeen: seen, location: "上海", isNew: true });
  const unread = fixture({ id: "boss-migration-unread", url: "https://www.zhipin.com/job_detail/migration-unread.html",
    firstSeen: seen, lastSeen: seen, location: "上海", matchScore: null, category: null, priority: "采样候选 · 待你判断", jdRead: false });
  const asCard = (job) => Object.fromEntries(["id", "source", "title", "company", "location", "experienceText", "educationText", "url", "salaryText"]
    .map((key) => [key, job[key]]).concat([["retrievedAt", seen]]));
  const detail = { ...asCard(full), jd: "TEST_ONLY_SOURCE_DUTIES_AND_REQUIREMENTS ".repeat(4) };
  const queued = updateReviewQueue(emptyReviewQueue(), [detail], [{
    id: full.id, intent: { decision: "primary", family: "channel-management", reasons: ["test-only"] },
    qualification: { status: "pending", reasons: ["test-only-unknown"] },
  }], runId);
  const queue = approveReviews(queued, { version: 1, approvals: [{ id: full.id, evidenceHash: queued.entries[0].evidenceHash, job: full }] },
    new Set(), seen);
  const snapshot = {
    version: 1, generatedAt: published,
    run: { source: "BOSS直聘", scope: "TEST_ONLY", mode: "采样候选 · 累计快照", cardsReviewed: 2, detailsRead: 1, selectedCount: 2, newCount: 2 },
    jobs: [full, unread], assessmentMethods: { [full.id]: "human-assisted", [unread.id]: "source-only" },
    firstPublishedAtById: { [full.id]: published, [unread.id]: published },
    candidateStatesById: { [unread.id]: { evidence: "card-only", direction: "unclear", evidenceObservedAt: seen } },
    candidateFeed: { version: 1, mode: candidateMode, publicationKind: "controlled", runId, sampleRunId: runId,
      sampledAt: seen, cardsThisSample: 2, detailsThisSample: 1, timeZone: "Asia/Shanghai", times: ["09:30", "12:30"] },
  };
  const evidence = { cards: [asCard(full), asCard(unread)], details: [detail], detailConflicts: [], incompleteDetails: [],
    queries: [{ term: "渠道经理", industry: "100021", position: null, count: 2, empty: false,
      allocated: 1, detailsRead: 1, unreadDetails: 1, recheckedDetails: 0, detailConflicts: 0, incompleteDetails: 0, visits: 1 }], complete: true };
  const publication = { type: candidateMode, status: "published", sha: baseSha, at: published, generatedAt: published, runId, sampleRunId: runId,
    url: "https://test_owner.github.io/TEST_REPO/", publicationKind: "controlled", digest: migrationHash(migrationJson(snapshot)) };
  const result = { id: runId, trigger: "launchd-manual", pid: 123456, ...modeSettings(candidateMode), controlled: false,
    dryRun: false, startedAt: seen, finishedAt: published, status: "succeeded", queryCursor: 0, sampledAt: seen, code: null,
    summary: { reviewed: 2, details: 1, publicAdmissions: 2, qualificationPending: 1 }, publication };
  const state = { version: 1, activatedAt: "2026-01-01T00:00:00.000Z", collectionActivatedAt: "2026-01-01T01:30:00.000Z",
    lastScheduledSlot: "2026-01-01-1230", queryCursor: 3, lastRun: result,
    lastCollection: { ...result, status: "collected", publication: null }, lastPublished: publication };
  const settings = { version: 1, repository: "TEST_OWNER/TEST_REPO", branch: "main", ...modeSettings(candidateMode),
    queries: defaultIntentPolicy().queries, limits: candidateLimits, roleExclusionsVersion: 2,
    nodePath: "/DO_NOT_MIGRATE/node", gitPath: "/DO_NOT_MIGRATE/git", sshKeyPath: "/DO_NOT_READ/key", knownHostsPath: "/DO_NOT_READ/hosts" };
  const files = {
    "runtime.json": settings, "state.json": state, "control.json": { paused: false, cancelRunId: null },
    "matching.json": { version: 1, directions: ["伙伴发展"], confirmedCapabilities: [], education: null,
      years: { marketing: null, b2b: null, partner: null, events: null, management: null, technical: null } },
    "intent-policy.json": defaultIntentPolicy(),
    "manual-exclusions.json": { version: 1, entries: [{ id: "boss-excluded-test", excludedAt: seen, reasonCode: "user-direction-rejection" }] },
    "role-exclusions.json": feedbackRolePolicy(2),
    "role-exclusions-history.json": { version: 1, entries: [{
      id: "boss-excluded-role-test", category: "procurement", reasonCode: "role-procurement", basis: "title",
      policyId: "role-feedback-v1", policyVersion: 1, observedAt: seen, filteredAt: seen,
    }] },
    "ledger.json": { version: 1, reviewedIds: [full.id, unread.id], detailIds: [full.id] },
    "read-history.json": { version: 1, entries: { [full.id]: { readAt: seen, fingerprint: cardFingerprint(detail) } } },
    "review-queue.json": queue, [`runs/${runId}/evidence.json`]: evidence, [`runs/${runId}/result.json`]: result,
  };
  for (const [path, value] of Object.entries(files)) await atomicJson(join(root, path), value);
  await atomicJson(join(repo, "docs/data/jobs.json"), snapshot);
  await mkdir(join(repo, "scheduler"), { mode: 0o700 });
  await writeFile(join(repo, "scheduler", "TEST_ONLY.mjs"), "// TEST_ONLY installation fixture\n", { mode: 0o600 });
  await writeFile(join(repo, "docs/model.mjs"), "// TEST_ONLY installation fixture\n", { mode: 0o600 });
  const contextPath = join(directory, "context.json");
  await atomicJson(contextPath, { schemaVersion: 1, documentType: "test-private-context", profile: { note: "TEST_PRIVATE_CONTEXT_NOT_PUBLIC" } });
  const services = { command: async (_program, args) => {
    if (args[0] === "show") return migrationJson(snapshot).trimEnd();
    if (args[0] === "rev-parse") return sourceCommit;
    assert.fail("Migration must not run any Git write/network command.");
  } };
  const options = { root, repo, contextPath, services, bundlePath: join(directory, "bundles", "test.shortlist.enc"),
    keyPath: join(directory, "keys", "test.shortlist.key") };
  return { directory, root, repo, files, snapshot, state, options, services };
}

function forgedEnvelope(payload, key) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("job-shortlist-migration:1:aes-256-gcm"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return migrationJson({ format: "job-shortlist-migration", version: 1, cipher: "aes-256-gcm",
    nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
}

test("allowlisted export preserves decisions/dates/queue/source evidence but never reads credentials, handles or all old runs", async (t) => {
  const data = await setup(t);
  for (const name of ["browser.json", "cookies", "keys", "app", "publish", "logs"]) {
    await symlink("/DO_NOT_READ_OR_FOLLOW", join(data.root, name));
  }
  await mkdir(join(data.root, "runs", "old-unrelated-run"), { mode: 0o000 });
  const payload = await captureMigration(data.options);
  assert.equal(payload.manifest.files.length, 14);
  assert.deepEqual(payload.manifest.counts, { publicJobs: 2, firstDisplayDates: 2, manualExclusions: 1, roleHistory: 1,
    reviewQueue: 1, reviewedIds: 2, detailIds: 1, readHistory: 1, sourceSamples: 1 });
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /DO_NOT_|"pid"|"browser.json"|"sshKeyPath"|"nodePath"|"gitPath"|"knownHostsPath"|old-unrelated-run/);
  for (const name of ["matching.json", "intent-policy.json", "manual-exclusions.json", "role-exclusions-history.json",
    "review-queue.json", "ledger.json", "read-history.json"]) assert.equal(payload.files[name], await readFile(join(data.root, name), "utf8"));
  assert.deepEqual(JSON.parse(payload.files["saved-snapshot.json"]), data.snapshot);
  assert.equal(JSON.parse(payload.files["state.json"]).queryCursor, 3);
  assert.equal(JSON.parse(payload.files["state.json"]).lastRun.pid, undefined);
  for (const [name, value] of Object.entries(data.files)) assert.deepEqual(await readJson(join(data.root, name)), value);
});

test("real encrypted package round trip creates a private paused target and retains first-publication/history hashes", async (t) => {
  const data = await setup(t), exported = await exportMigration(data.options);
  assert.equal((await lstat(data.options.bundlePath)).mode & 0o777, 0o600);
  assert.equal((await lstat(data.options.keyPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(data.directory, "bundles"))).mode & 0o777, 0o700);
  const encrypted = await readFile(data.options.bundlePath, "utf8");
  assert.doesNotMatch(encrypted, /TEST_PRIVATE_CONTEXT|TEST_ONLY_SOURCE|TEST_ONLY_COMPANY|firstPublishedAtById/);
  const target = join(data.directory, "restored"), result = await restoreMigration({ ...data.options, target });
  assert.equal(result.status, "restored-paused");
  assert.deepEqual(await readJson(join(target, "control.json")), { paused: true, cancelRunId: null });
  assert.equal((await lstat(target)).mode & 0o777, 0o700);
  const verified = await verifyRestoredMigration(target);
  assert.deepEqual(verified.manifest, exported.manifest);
  for (const entry of exported.manifest.files) {
    assert.equal(migrationHash(await readFile(join(target, entry.path))), entry.sha256);
    assert.equal((await lstat(join(target, entry.path))).mode & 0o777, 0o600);
  }
  for (const name of ["runtime.json", "browser.json", "keys", "app", "publish", "run.lock", "run.guard"]) {
    await assert.rejects(lstat(join(target, name)), { code: "ENOENT" });
  }
  assert.deepEqual(verified.snapshot.firstPublishedAtById, data.snapshot.firstPublishedAtById);
  const inspected = await command(process.execPath, [new URL("../scheduler/migration.mjs", import.meta.url).pathname,
    "inspect", "--bundle", data.options.bundlePath, "--key-file", data.options.keyPath]);
  assert.equal(JSON.parse(inspected).manifest.counts.publicJobs, 2);
  assert.doesNotMatch(inspected, /TEST_PRIVATE_CONTEXT|TEST_ONLY_SOURCE|key-v1:/);
});

test("wrong key, nonce/tag/ciphertext corruption and unsupported envelope versions fail before creating state", async (t) => {
  const data = await setup(t), payload = await captureMigration(data.options);
  const key = randomBytes(32), envelope = sealMigration(payload, key);
  assert.deepEqual(openMigration(envelope, key), payload);
  assert.notEqual(sealMigration(payload, key), envelope);
  assert.throws(() => openMigration(envelope, randomBytes(32)), { code: "migration-authentication" });
  for (const field of ["nonce", "tag", "ciphertext"]) {
    const copy = JSON.parse(envelope), buffer = Buffer.from(copy[field], "base64");
    buffer[0] ^= 1; copy[field] = buffer.toString("base64");
    assert.throws(() => openMigration(JSON.stringify(copy), key), { code: "migration-authentication" });
  }
  assert.throws(() => openMigration(JSON.stringify({ ...JSON.parse(envelope), version: 99 }), key), { code: "unsupported-migration-version" });
  await exportMigration(data.options);
  const wrong = join(data.directory, "wrong.shortlist.key");
  await writeFile(wrong, `job-shortlist-recovery-key-v1:${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  const target = join(data.directory, "wrong-key-target");
  await assert.rejects(restoreMigration({ ...data.options, keyPath: wrong, target }), { code: "migration-authentication" });
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("authenticated malformed archives cannot inject runtime paths, traversal, extra files, duplicates or corrupt state", async (t) => {
  const data = await setup(t), payload = await captureMigration(data.options), key = randomBytes(32);
  for (const path of ["../escape.json", "/tmp/escape.json", "runs/../../keys/key", "browser.json", "runtime.json", "keys/deploy.json", "other.json"]) {
    const copy = structuredClone(payload);
    const entry = { path, bytes: 2, sha256: migrationHash("{}") };
    copy.files[path] = "{}"; copy.manifest.files.push(entry);
    assert.throws(() => openMigration(forgedEnvelope(copy, key), key));
  }
  for (const mutate of [
    (copy) => { copy.manifest.files[1] = copy.manifest.files[0]; },
    (copy) => { delete copy.files["manual-exclusions.json"]; },
    (copy) => { copy.files["ledger.json"] = '{"version":1,"reviewedIds":[],"detailIds":["bad"]}'; },
    (copy) => { copy.files["migration-settings.json"] = '{"version":1,"nodePath":"/OLD_MACHINE/node"}'; },
    (copy) => { copy.manifest.counts.publicJobs = 999; },
    (copy) => { copy.manifest.exportedAt = "not-a-date"; },
  ]) {
    const copy = structuredClone(payload); mutate(copy);
    assert.throws(() => openMigration(forgedEnvelope(copy, key), key));
  }
});

test("source permissions, symlinks, unfinished publication and a valid kernel lock prevent export without changing services", async (t) => {
  const data = await setup(t);
  const release = await acquireLock(data.root, "test-held-lock");
  try { await assert.rejects(captureMigration(data.options), { code: "locked" }); }
  finally { await release(); }
  await atomicJson(join(data.root, "state.json"), { ...data.state, lastRun: { ...data.state.lastRun, status: "running" } });
  await assert.rejects(captureMigration(data.options), { code: "migration-run-active" });
  await atomicJson(join(data.root, "state.json"), data.state);
  for (const name of ["pending.json", "review-publication-pending.json", "request.json"]) {
    await writeFile(join(data.root, name), "TEST_DO_NOT_NEED_TO_READ", { mode: 0o600 });
    await assert.rejects(captureMigration(data.options), { code: "migration-publication-pending" });
    await rm(join(data.root, name));
  }
  await chmod(join(data.root, "matching.json"), 0o644);
  await assert.rejects(captureMigration(data.options), { code: "migration-permissions" });
  await chmod(join(data.root, "matching.json"), 0o600);
  await rm(join(data.root, "matching.json"));
  await symlink(join(data.root, "intent-policy.json"), join(data.root, "matching.json"));
  await assert.rejects(captureMigration(data.options), { code: "migration-symlink" });
  assert.deepEqual(await readJson(join(data.root, "control.json")), { paused: false, cancelRunId: null });
});

test("output collisions and existing/symlinked restore targets are never overwritten", async (t) => {
  const data = await setup(t);
  await exportMigration(data.options);
  const before = await readFile(data.options.bundlePath);
  await assert.rejects(exportMigration(data.options), { code: "migration-target-exists" });
  assert.deepEqual(await readFile(data.options.bundlePath), before);
  const target = join(data.directory, "existing");
  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, "keep.txt"), "TEST_USER_CONTENT");
  await assert.rejects(restoreMigration({ ...data.options, target }), { code: "migration-target-exists" });
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "TEST_USER_CONTENT");
  const linked = join(data.directory, "symlink-parent");
  await symlink(target, linked);
  await assert.rejects(restoreMigration({ ...data.options, target: join(linked, "new-target") }), { code: "migration-symlink" });
  await assert.rejects(lstat(join(target, "new-target")), { code: "ENOENT" });
  await assert.rejects(exportMigration({ ...data.options, bundlePath: join(data.repo, "other.shortlist.enc"),
    keyPath: join(data.directory, "other-keys", "other.shortlist.key") }), { code: "migration-private-output" });
});

test("a failed restore rolls back only its own new files; incomplete imports cannot be installed", async (t) => {
  const data = await setup(t);
  await exportMigration(data.options);
  const target = join(data.directory, "failed-restore");
  let writes = 0;
  await assert.rejects(restoreMigration({ ...data.options, target, services: {
    writeExclusive: async (path, text) => {
      if (++writes === 4) throw new RunError("test-write-failed", "TEST_ONLY");
      await writeFile(path, text, { mode: 0o600, flag: "wx" });
    },
  } }), { code: "test-write-failed" });
  await assert.rejects(lstat(target), { code: "ENOENT" });
  const incomplete = join(data.directory, "interrupted-restore");
  await mkdir(incomplete, { mode: 0o700 });
  await writeFile(join(incomplete, ".migration-incomplete"), "TEST_ONLY", { mode: 0o600 });
  await assert.rejects(migrationInstallation(incomplete, {
    repository: "TEST_OWNER/TEST_REPO", mode: candidateMode, sourceSnapshot: migrationJson(data.snapshot),
  }), { code: "migration-incomplete" });
});

test("migrated installation rebuilds machine paths, preserves policies/dates/cursor, and never loads services", async (t) => {
  const data = await setup(t);
  await exportMigration(data.options);
  const target = join(data.directory, "destination");
  await restoreMigration({ ...data.options, target });
  const snapshotText = migrationJson(data.snapshot);
  await assert.rejects(migrationInstallation(target, { repository: "WRONG/repo", mode: candidateMode, sourceSnapshot: snapshotText }),
    { code: "migration-install-mismatch" });
  await assert.rejects(migrationInstallation(target, { repository: "TEST_OWNER/TEST_REPO", mode: candidateMode, sourceSnapshot: `${snapshotText}\n` }),
    { code: "migration-public-snapshot-changed" });
  const keys = join(target, "keys");
  await mkdir(keys, { mode: 0o700 });
  for (const name of ["deploy", "hosts"]) await writeFile(join(keys, name), "TEST_ONLY_NEW_MACHINE_METADATA", { mode: 0o600 });
  const calls = [];
  const installOptions = {
    root: target, repository: "TEST_OWNER/TEST_REPO", mode: candidateMode,
    matchingPath: join(target, "matching.json"), ledgerPath: join(target, "ledger.json"),
    sshKeyPath: join(keys, "deploy"), knownHostsPath: join(keys, "hosts"), nodePath: process.execPath, gitPath: "/usr/bin/git",
    services: {
      sourceRoot: data.repo, agentPath: (name) => join(data.directory, "agents", `${name}.plist`),
      command: async (_program, args) => { calls.push(args); return ""; },
      isLoaded: async () => false,
      bootout: async () => assert.fail("A migrated install must not modify any existing service."),
      bootstrap: async () => assert.fail("A migrated install must not load any service."),
      git: async (_runtime, args) => {
        assert.equal(args[0], "clone");
        await mkdir(join(target, "publish", ".git"), { recursive: true, mode: 0o700 });
        return "";
      },
    },
  };
  await assert.rejects(install({ ...installOptions, services: {
    ...installOptions.services, isLoaded: async () => true,
  } }), { code: "migration-active-service" });
  await assert.rejects(lstat(join(target, "runtime.json")), { code: "ENOENT" });
  const result = await install(installOptions);
  assert.equal(result.paused, true);
  assert.equal(result.servicesLoaded, false);
  assert.equal(result.restoredState, true);
  const configured = await loadConfiguration(target);
  assert.equal(configured.runtime.nodePath, process.execPath);
  assert.equal(configured.runtime.sshKeyPath, join(keys, "deploy"));
  assert.equal(configured.runtime.roleExclusionsVersion, 2);
  assert.equal(configured.runtime.migrationSetupPending, true);
  for (const name of ["matching.json", "intent-policy.json", "manual-exclusions.json", "role-exclusions.json",
    "role-exclusions-history.json", "ledger.json", "read-history.json", "review-queue.json"]) {
    assert.equal(await readFile(join(target, name), "utf8"), await readFile(join(data.root, name), "utf8"));
  }
  const restoredState = await readJson(join(target, "state.json"));
  assert.equal(restoredState.queryCursor, data.state.queryCursor);
  assert.equal(restoredState.lastScheduledSlot, data.state.lastScheduledSlot);
  assert.equal(restoredState.collectionActivatedAt, data.state.collectionActivatedAt);
  assert.deepEqual(await readJson(join(target, "saved-snapshot.json")), data.snapshot);
  assert.deepEqual(await readJson(join(target, "control.json")), { paused: true, cancelRunId: null });
  assert.deepEqual((await readdir(join(data.directory, "agents"))).sort(), [`${awakeLabel}.plist`, `${label}.plist`].sort());
  assert.ok(!calls.some((args) => args.includes("bootstrap") || args.includes("kickstart")));
  const repeated = await install(installOptions);
  assert.equal(repeated.servicesLoaded, false);
  assert.equal((await readJson(join(target, "control.json"))).paused, true);
});

test("private context cannot introduce credentials or old-machine paths, and manifest corruption is caught", async (t) => {
  const data = await setup(t);
  for (const value of [
    { schemaVersion: 1, privateKey: "TEST_ONLY" },
    { schemaVersion: 1, project: { token: "TEST_ONLY" } },
    { schemaVersion: 1, statePath: "/Users/TEST_ONLY/runtime" },
  ]) {
    await atomicJson(data.options.contextPath, value);
    await assert.rejects(captureMigration(data.options));
  }
  await atomicJson(data.options.contextPath, { schemaVersion: 1, note: "TEST_ONLY_PRIVATE" });
  const exported = await exportMigration(data.options), target = join(data.directory, "tampered-restore");
  await restoreMigration({ ...data.options, target });
  await writeFile(join(target, "manual-exclusions.json"), '{"version":1,"entries":[]}\n', { mode: 0o600 });
  await assert.rejects(verifyRestoredMigration(target), { code: "migration-integrity" });
  assert.throws(() => validateMigrationPayload({ manifest: { ...exported.manifest, version: 0 }, files: {} }),
    { code: "unsupported-migration-version" });
});

test("migration artifact ignores are narrow and leave the legitimate published JSON tracked", async () => {
  const ignored = await command("/usr/bin/git", ["check-ignore", "--no-index", "handoff.shortlist.enc", "handoff.shortlist.key", ".private/context.json"]);
  assert.equal(ignored.split("\n").length, 3);
  await assert.rejects(command("/usr/bin/git", ["check-ignore", "--no-index", "docs/data/jobs.json", "scheduler/migration-schema.mjs"]),
    (error) => error.exitCode === 1);
});
