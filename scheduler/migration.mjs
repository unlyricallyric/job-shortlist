#!/usr/bin/env node
import { constants } from "node:fs";
import { open, lstat, mkdir, link, unlink, rmdir } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { acquireLock, RunError } from "./io.mjs";
import { command } from "./process.mjs";
import { defaultRoot } from "./config.mjs";
import {
  migrationFormat, migrationVersion, maxMigrationBytes, migrationHash, migrationJson, stateFiles,
  migrationSettings, portableState, portableRun, portableEvidence, migrationRunIds,
  buildMigrationPayload, validateMigrationPayload, validateMigrationFiles, allowedMigrationPath,
} from "./migration-schema.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aad = Buffer.from(`${migrationFormat}:${migrationVersion}:aes-256-gcm`, "utf8");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (code, message) => { throw new RunError(code, message, { blocked: true }); };
const within = (path, root) => {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !remainder.startsWith(sep));
};

async function noSymlinkPath(path) {
  let cursor = resolve(path);
  const paths = [];
  while (dirname(cursor) !== cursor) { paths.unshift(cursor); cursor = dirname(cursor); }
  for (const part of paths) {
    const info = await lstat(part);
    if (info.isSymbolicLink()) fail("migration-symlink", "Migration paths must not contain symbolic links.");
  }
}

async function privateDirectory(path, { create = false } = {}) {
  const full = resolve(path);
  if (create) {
    let existing = full;
    const missing = [];
    for (;;) {
      try { await lstat(existing); break; }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        missing.unshift(existing);
        existing = dirname(existing);
      }
    }
    await noSymlinkPath(existing);
    for (const next of missing) await mkdir(next, { mode: 0o700 });
  }
  await noSymlinkPath(full);
  const info = await lstat(full);
  if (!info.isDirectory() || (info.mode & 0o077)) fail("migration-permissions", "Migration directories must be owner-only directories.");
  return full;
}

async function absent(path) {
  try { await lstat(path); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail("migration-target-exists", "Migration never overwrites an existing file or destination.");
}

export async function readMigrationFile(path, { privateFile = true, limit = maxMigrationBytes * 2 } = {}) {
  await noSymlinkPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || (privateFile && (info.mode & 0o077))) {
      fail("migration-permissions", "Migration inputs must be bounded regular files with owner-only private-state permissions.");
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

function parse(text) {
  try { return JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail("migration-json", "Migration input is not valid JSON.");
  }
}

async function writeExclusive(path, text) {
  await noSymlinkPath(dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const identity = await handle.stat();
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  catch (error) {
    const current = await lstat(path);
    if (current.ino !== identity.ino || current.dev !== identity.dev) {
      fail("migration-cleanup-required", "An output path changed during writing; inspect the private destination.");
    }
    await unlink(path);
    throw error;
  } finally { await handle.close(); }
}

function decode(value, expectedLength) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("migration-encoding", "Migration encryption fields use invalid encoding.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    fail("migration-encoding", "Migration encryption fields have invalid sizes.");
  }
  return bytes;
}

export function sealMigration(payload, key) {
  validateMigrationPayload(payload);
  if (!Buffer.isBuffer(key) || key.length !== 32) fail("migration-key", "A 256-bit migration recovery key is required.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return migrationJson({
      format: migrationFormat, version: migrationVersion, cipher: "aes-256-gcm",
      nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
    });
  } finally { plaintext.fill(0); }
}

export function openMigration(text, key) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maxMigrationBytes * 2) fail("migration-too-large", "Migration package exceeds the supported bound.");
  const value = parse(text);
  if (!exact(value, ["format", "version", "cipher", "nonce", "tag", "ciphertext"])
    || value.format !== migrationFormat || value.version !== migrationVersion || value.cipher !== "aes-256-gcm") {
    fail("unsupported-migration-version", "Unsupported migration package format or cipher.");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) fail("migration-key", "A 256-bit migration recovery key is required.");
  const decipher = createDecipheriv("aes-256-gcm", key, decode(value.nonce, 12), { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(decode(value.tag, 16));
  const partial = decipher.update(decode(value.ciphertext));
  let tail;
  try { tail = decipher.final(); }
  catch {
    partial.fill(0);
    fail("migration-authentication", "Wrong recovery key or damaged package; no plaintext was restored.");
  }
  const plaintext = Buffer.concat([partial, tail]);
  partial.fill(0);
  tail.fill(0);
  try { return validateMigrationPayload(parse(plaintext.toString("utf8"))); }
  finally { plaintext.fill(0); }
}

async function recoveryKey(path) {
  const text = await readMigrationFile(path, { limit: 256 });
  const match = /^job-shortlist-recovery-key-v1:([A-Za-z0-9+/=]+)\n$/.exec(text);
  if (!match) fail("migration-key", "Recovery key file format is invalid.");
  return decode(match[1], 32);
}

async function assertIdle(root) {
  const state = parse(await readMigrationFile(resolve(root, "state.json")));
  if (state.lastRun?.status === "running") fail("migration-run-active", "Finish the active collection before exporting; the scheduler was not paused or changed.");
  for (const file of ["pending.json", "review-publication-pending.json", "request.json"]) {
    try { await lstat(resolve(root, file)); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    fail("migration-publication-pending", "Resolve pending collection or publication before exporting.");
  }
  return state;
}

export async function captureMigration({ root = defaultRoot(), contextPath, repo = repositoryRoot, services = {} }) {
  root = await privateDirectory(root);
  repo = resolve(repo);
  if (!contextPath || within(resolve(contextPath), repo)) fail("migration-private-context", "Private context must be an explicit file outside the public repository.");
  await assertIdle(root);
  const release = await acquireLock(root, "state-export");
  try {
    const rawState = await assertIdle(root);
    const state = portableState(rawState);
    const runtime = parse(await readMigrationFile(resolve(root, "runtime.json")));
    if (runtime.migrationSetupPending === true) fail("migration-setup-pending", "This machine has not completed explicit migration setup.");
    const settings = migrationSettings(runtime);
    const files = {};
    for (const name of stateFiles) files[name] = await readMigrationFile(resolve(root, name));
    files["state.json"] = migrationJson(state);
    files["migration-settings.json"] = migrationJson(settings);
    files["saved-snapshot.json"] = await readMigrationFile(resolve(repo, "docs/data/jobs.json"), { privateFile: false });
    files["private-context.json"] = await readMigrationFile(resolve(contextPath), { limit: 65536 });
    const snapshot = parse(files["saved-snapshot.json"]);
    for (const runId of migrationRunIds(state, snapshot)) {
      if (!/^[a-z0-9-]{8,90}$/.test(runId)) fail("invalid-migration-run", "Source evidence reference is invalid.");
      const evidence = parse(await readMigrationFile(resolve(root, "runs", runId, "evidence.json")));
      const result = parse(await readMigrationFile(resolve(root, "runs", runId, "result.json")));
      files[`runs/${runId}/evidence.json`] = migrationJson(portableEvidence(evidence));
      files[`runs/${runId}/result.json`] = migrationJson(portableRun(result));
    }
    const localGit = services.command ?? command;
    if (!/^[a-f0-9]{40}$/.test(state.lastPublished?.sha)) fail("migration-publication-unknown", "A confirmed source publication is required for snapshot transfer.");
    const committed = await localGit("/usr/bin/git", ["show", `${state.lastPublished.sha}:docs/data/jobs.json`], { cwd: repo, timeout: 15000 });
    if (committed.trimEnd() !== files["saved-snapshot.json"].trimEnd()) fail("migration-snapshot-mismatch", "Local public data does not match the confirmed publication; update the clean checkout before export.");
    const sourceCommit = await localGit("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repo, timeout: 15000 });
    const payload = buildMigrationPayload(files, { sourceCommit });
    await assertIdle(root);
    release.assertHeld();
    return payload;
  } finally { await release(); }
}

export async function exportMigration({ root = defaultRoot(), contextPath, bundlePath, keyPath, repo = repositoryRoot, services }) {
  if (!bundlePath || !keyPath) fail("migration-output-required", "Supply separate package and recovery-key file paths.");
  bundlePath = resolve(bundlePath);
  keyPath = resolve(keyPath);
  if (!bundlePath.endsWith(".shortlist.enc") || !keyPath.endsWith(".shortlist.key")) {
    fail("migration-output-suffix", "Use .shortlist.enc for the package and .shortlist.key for its separate recovery key.");
  }
  if (dirname(bundlePath) === dirname(keyPath) || [bundlePath, keyPath].some((path) => within(path, resolve(root)) || within(path, resolve(repo)))) {
    fail("migration-private-output", "Use separate private package/key directories outside both the repository and runtime.");
  }
  await absent(bundlePath);
  await absent(keyPath);
  const payload = await captureMigration({ root, contextPath, repo, services });
  await privateDirectory(dirname(bundlePath), { create: true });
  await privateDirectory(dirname(keyPath), { create: true });
  const key = randomBytes(32), tempKey = `${keyPath}.${randomUUID()}.tmp`, tempBundle = `${bundlePath}.${randomUUID()}.tmp`;
  const created = [];
  let keyLinked = false, bundleLinked = false;
  try {
    const sealed = sealMigration(payload, key);
    await writeExclusive(tempKey, `job-shortlist-recovery-key-v1:${key.toString("base64")}\n`); created.push(tempKey);
    await writeExclusive(tempBundle, sealed); created.push(tempBundle);
    await link(tempKey, keyPath); keyLinked = true;
    await link(tempBundle, bundlePath); bundleLinked = true;
    return { bundlePath, keyPath, packageSha256: migrationHash(sealed), manifest: payload.manifest };
  } catch (error) {
    if (bundleLinked) await unlink(bundlePath);
    if (keyLinked) await unlink(keyPath);
    throw error;
  } finally {
    key.fill(0);
    for (const path of created) await unlink(path);
  }
}

export async function inspectMigration({ bundlePath, keyPath }) {
  const key = await recoveryKey(resolve(keyPath));
  try { return openMigration(await readMigrationFile(resolve(bundlePath)), key); }
  finally { key.fill(0); }
}

export async function restoreMigration({ bundlePath, keyPath, target, services = {} }) {
  if (!target) fail("migration-target-required", "Supply a new private restore directory.");
  target = resolve(target);
  if (within(target, repositoryRoot)) fail("migration-private-output", "Do not restore private state inside the public repository.");
  await absent(target);
  const payload = await inspectMigration({ bundlePath, keyPath });
  await noSymlinkPath(dirname(target));
  const write = services.writeExclusive ?? writeExclusive;
  const createdFiles = [], createdDirs = [];
  let rootIdentity;
  try {
    await mkdir(target, { mode: 0o700 });
    rootIdentity = await lstat(target); createdDirs.push(target);
    const incomplete = resolve(target, ".migration-incomplete");
    await write(incomplete, "Restore incomplete; do not install or enable.\n"); createdFiles.push(incomplete);
    for (const name of Object.keys(payload.files).sort()) {
      const path = resolve(target, name);
      if (dirname(path) !== target) {
        for (const directory of [resolve(target, "runs"), dirname(path)]) if (!createdDirs.includes(directory)) {
          await mkdir(directory, { mode: 0o700 }); createdDirs.push(directory);
        }
      }
      await write(path, payload.files[name]); createdFiles.push(path);
    }
    const control = resolve(target, "control.json");
    await write(control, migrationJson({ paused: true, cancelRunId: null })); createdFiles.push(control);
    const receipt = { format: migrationFormat, version: migrationVersion, status: "restored-paused",
      restoredAt: new Date().toISOString(), manifest: payload.manifest, manifestSha256: migrationHash(JSON.stringify(payload.manifest)) };
    const path = resolve(target, "migration-receipt.json");
    await write(path, migrationJson(receipt)); createdFiles.push(path);
    await unlink(incomplete); createdFiles.splice(createdFiles.indexOf(incomplete), 1);
    return { target, status: receipt.status, manifest: payload.manifest, machineSetupRequired: true };
  } catch (error) {
    if (rootIdentity) {
      const current = await lstat(target);
      if (current.ino !== rootIdentity.ino || current.dev !== rootIdentity.dev || current.isSymbolicLink()) {
        fail("migration-cleanup-required", "The restore target changed; inspect the incomplete private directory before retrying.");
      }
      for (const path of createdFiles.reverse()) {
        try { await unlink(path); }
        catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
      }
      for (const path of createdDirs.reverse()) await rmdir(path);
    }
    throw error;
  }
}

export async function verifyRestoredMigration(root) {
  root = await privateDirectory(root);
  try { await lstat(resolve(root, ".migration-incomplete")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const receipt = parse(await readMigrationFile(resolve(root, "migration-receipt.json")));
    if (!exact(receipt, ["format", "version", "status", "restoredAt", "manifest", "manifestSha256"])
      || receipt.format !== migrationFormat || receipt.version !== migrationVersion || receipt.status !== "restored-paused"
      || receipt.manifestSha256 !== migrationHash(JSON.stringify(receipt.manifest))) {
      fail("migration-receipt-invalid", "Restore receipt is invalid; do not install or enable.");
    }
    if (!Array.isArray(receipt.manifest?.files) || receipt.manifest.files.length > 16
      || receipt.manifest.files.some((entry) => !allowedMigrationPath(entry?.path))) {
      fail("migration-file-not-allowed", "Restore receipt contains an unsafe path.");
    }
    const files = {};
    for (const entry of receipt.manifest.files) files[entry.path] = await readMigrationFile(resolve(root, entry.path));
    const payload = validateMigrationPayload({ manifest: receipt.manifest, files });
    const control = parse(await readMigrationFile(resolve(root, "control.json")));
    if (!exact(control, ["paused", "cancelRunId"]) || control.paused !== true || control.cancelRunId !== null) {
      fail("migration-not-paused", "Restored state must remain paused until new-machine setup is complete.");
    }
    return { manifest: payload.manifest, ...validateMigrationFiles(files) };
  }
  fail("migration-incomplete", "A previous restore did not finish; no installation or activation is allowed.");
}

export async function isUnfinishedMigration(root) {
  try { await lstat(resolve(root, ".migration-incomplete")); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function migrationInstallation(root, { repository, mode, sourceSnapshot }) {
  try { await lstat(resolve(root, "migration-receipt.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { await lstat(resolve(root, ".migration-incomplete")); }
    catch (missing) { if (missing.code === "ENOENT") return null; throw missing; }
    fail("migration-incomplete", "Finish or remove the explicitly incomplete restore before installing.");
  }
  const restored = await verifyRestoredMigration(root);
  if (restored.settings.repository !== repository || restored.settings.mode !== mode) {
    fail("migration-install-mismatch", "Install repository and mode must match the explicitly restored settings.");
  }
  if (migrationHash(sourceSnapshot) !== restored.manifest.files.find((entry) => entry.path === "saved-snapshot.json").sha256) {
    fail("migration-public-snapshot-changed", "Repository job data changed after export; obtain a fresh handoff rather than overwriting newer public state.");
  }
  return restored.settings;
}

async function main() {
  const [action, ...args] = process.argv.slice(2), options = {};
  const fields = new Map([["root", "root"], ["context", "contextPath"], ["bundle", "bundlePath"],
    ["key-file", "keyPath"], ["target", "target"], ["repo", "repo"]]);
  for (let index = 0; index < args.length; index += 2) {
    const name = fields.get(args[index]?.replace(/^--/, ""));
    if (!args[index]?.startsWith("--") || !name || !args[index + 1] || args[index + 1].startsWith("--") || options[name]) {
      fail("migration-usage", "Use named migration options with explicit file paths; keys and passwords are never command arguments.");
    }
    options[name] = args[index + 1];
  }
  if (action === "export") return exportMigration(options);
  if (action === "restore") return restoreMigration(options);
  if (action === "inspect") return { manifest: (await inspectMigration(options)).manifest };
  if (action === "verify") return { status: "restored-paused", manifest: (await verifyRestoredMigration(options.root)).manifest };
  fail("migration-usage", "Use export --context --bundle --key-file, restore --bundle --key-file --target, inspect, or verify --root.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const result = await main();
    const { manifest, ...rest } = result;
    console.log(JSON.stringify({ ...rest, manifest: {
      format: manifest.format, version: manifest.version, exportedAt: manifest.exportedAt,
      sourceCommit: manifest.sourceCommit, repository: manifest.repository, counts: manifest.counts,
      snapshotGeneratedAt: manifest.snapshotGeneratedAt, sourceSampledAt: manifest.sourceSampledAt, fileCount: manifest.files.length,
    } }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", code: error instanceof RunError ? error.code : "migration-io-error",
      message: error instanceof RunError ? error.message : "Migration failed; no success was recorded. Inspect the private paths and retry only after resolving the error." }));
    process.exitCode = 1;
  }
}
