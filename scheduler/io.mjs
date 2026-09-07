import { mkdir, open, readFile, rename, chmod, lstat, unlink, readdir, stat, rmdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

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

export async function acquireLock(root, runId) {
  await privateDirectory(root);
  const path = join(root, "run.lock");
  const owner = { pid: process.pid, token: randomUUID(), runId, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = await readJson(path);
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        if (readError instanceof SyntaxError) throw new RunError("locked", "Another run is acquiring the scheduler lock.", { blocked: true });
        throw readError;
      }
      if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0 || processAlive(existing.pid)) {
        throw new RunError("locked", "Another run owns the scheduler lock.", { blocked: true });
      }
      const recoveryPath = join(root, "lock-recovery");
      let recovery;
      try {
        recovery = await open(recoveryPath, "wx", 0o600);
      } catch (recoveryError) {
        if (recoveryError.code === "EEXIST") throw new RunError("locked", "Another process is recovering an abandoned run.", { blocked: true });
        throw recoveryError;
      }
      try {
        const latest = await readJson(path, null);
        if (latest?.token !== existing.token || (latest && processAlive(latest.pid))) {
          throw new RunError("locked", "Scheduler lock changed during recovery.", { blocked: true });
        }
        if (latest) await unlink(path);
      } finally {
        await recovery.close();
        await unlink(recoveryPath);
      }
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return async () => {
      const current = await readJson(path, null);
      if (current?.token !== owner.token) throw new RunError("lock-lost", "Scheduler lock ownership changed.");
      await unlink(path);
    };
  }
  throw new RunError("locked", "Could not acquire scheduler lock.", { blocked: true });
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
