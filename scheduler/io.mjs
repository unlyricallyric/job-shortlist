import { mkdir, open, readFile, rename, chmod, lstat, unlink, readdir, stat, rmdir, link } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const executeFile = promisify(execFile);

export class RunError extends Error {
  constructor(code, message, { blocked = false, cause } = {}) {
    super(message, { cause });
    this.name = "RunError";
    this.code = code;
    this.blocked = blocked;
  }
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RunError("unsafe-path", "Runtime directory must not be a symbolic link.");
  await chmod(path, 0o700);
}

export async function atomicJson(path, value) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function readJson(path, missing = undefined) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new RunError("unsafe-path", "Runtime JSON must be a regular file.");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && missing !== undefined) return missing;
    throw error;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function kernelLock(root) {
  const lost = new AbortController();
  const child = spawn("/usr/bin/perl", [fileURLToPath(new URL("./lock-helper.pl", import.meta.url)), join(root, "run.guard")], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
  let releasing = false;
  const closed = new Promise((resolve) => child.once("close", (code) => {
    if (!releasing) lost.abort(new RunError("lock-lost", "Kernel lock helper exited unexpectedly."));
    resolve(code);
  }));
  child.stdin.on("error", () => lost.abort(new RunError("lock-lost", "Kernel lock pipe closed unexpectedly.")));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new RunError("lock-timeout", "Kernel lock helper did not respond."));
      }, 10000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new RunError(code === 73 ? "locked" : "lock-unavailable",
          code === 73 ? "Another run owns the kernel lock." : "Kernel locking is unavailable.", { blocked: true }));
      });
      child.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        if (chunk.toString("utf8") !== "locked\n") reject(new RunError("lock-unavailable", "Unexpected kernel lock response."));
        else resolve();
      });
    });
  } catch (error) {
    releasing = true;
    child.stdin.end();
    await closed;
    throw error;
  }
  return {
    signal: lost.signal,
    assertHeld: () => lost.signal.throwIfAborted(),
    release: async () => {
      releasing = true;
      child.stdin.end();
      await closed;
    },
  };
}

async function removeAbandonedLegacyClaim(path) {
  let info, text;
  try {
    info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new RunError("unsafe-path", "Lock metadata must be a regular file.");
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // An interrupted legacy write may still contain a usable owner PID.
    owner = { pid: Number(/"pid"\s*:\s*([1-9]\d*)(?=\s*[,}])/.exec(text)?.[1]) };
  }
  if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
    if (processAlive(owner.pid)) throw new RunError("locked", "A live process still owns legacy lock metadata.", { blocked: true });
  } else {
    if (Date.now() - info.mtimeMs < 120000) throw new RunError("locked", "A legacy lock claim is still initializing.", { blocked: true });
  }
  try {
    const result = await executeFile("/usr/sbin/lsof", ["-t", "--", path], { timeout: 10000, maxBuffer: 65536 });
    if (result.stdout.trim()) throw new RunError("locked", "A process still holds the legacy claim.", { blocked: true });
  } catch (error) {
    if (error.code !== 1 || error.stderr?.trim()) throw error;
  }
  const current = await lstat(path);
  if (current.ino !== info.ino || current.dev !== info.dev || current.mtimeMs !== info.mtimeMs
    || current.size !== info.size) throw new RunError("locked", "Legacy lock metadata changed during recovery.", { blocked: true });
  await unlink(path);
}

export async function publishExclusiveOwner(path, owner) {
  const temporary = `${path}.${owner.token}.claim`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Unlike rename, link never overwrites a legacy wx claimant that won the race.
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new RunError("locked", "Another process published its lock claim first.", { blocked: true });
    }
  } finally {
    await unlink(temporary);
  }
}

export async function acquireLock(root, runId) {
  await privateDirectory(root);
  const guard = await kernelLock(root);
  const path = join(root, "run.lock");
  const owner = { protocol: "flock-v1", pid: process.pid, token: randomUUID(), runId, startedAt: new Date().toISOString() };
  try {
    await removeAbandonedLegacyClaim(path);
    await removeAbandonedLegacyClaim(join(root, "lock-recovery"));
    guard.assertHeld();
    await publishExclusiveOwner(path, owner);
    guard.assertHeld();
  } catch (error) {
    await guard.release();
    throw error;
  }
  const release = async () => {
    try {
      const current = await readJson(path, null);
      if (current?.token !== owner.token) throw new RunError("lock-lost", "Scheduler lock ownership changed.");
      await unlink(path);
    } finally {
      await guard.release();
    }
  };
  release.signal = guard.signal;
  release.assertHeld = guard.assertHeld;
  return release;
}

export async function appendLog(root, event) {
  const logs = join(root, "logs");
  await privateDirectory(logs);
  const path = join(logs, "scheduler.jsonl");
  const info = await stat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info?.size > 512 * 1024) {
    await rename(path, join(logs, "scheduler.previous.jsonl"));
  }
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } finally {
    await handle.close();
  }
}

export async function pruneEvidence(root, keep = 30) {
  const runs = join(root, "runs");
  await privateDirectory(runs);
  const names = (await readdir(runs, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name)).map((entry) => entry.name).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    const directory = join(runs, name);
    // Evidence is flat JSON: only remove our known files, never recursively delete.
    for (const file of ["evidence.json", "review.json", "candidate.json", "result.json", "ledger.json"]) {
      await unlink(join(directory, file)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rmdir(directory);
  }
}
