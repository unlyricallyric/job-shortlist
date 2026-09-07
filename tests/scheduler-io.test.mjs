import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, utimes, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock, atomicJson, readJson } from "../scheduler/io.mjs";

test("manual and scheduled execution share an exclusive lock and private atomic state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireLock(root, "2026-09-07-0930");
  await assert.rejects(acquireLock(root, "manual"), { code: "locked" });
  const path = join(root, "state.json");
  await atomicJson(path, { status: "blocked" });
  assert.equal((await readJson(path)).status, "blocked");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await release();
  const nextRelease = await acquireLock(root, "manual");
  await nextRelease();
});

test("old empty and partial initialization claims and abandoned recovery markers are recoverable", async (t) => {
  for (const content of ["", '{"token":', '{"protocol":"legacy",']) {
    await t.test(content || "empty", async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), "shortlist-lock-crash-test-"));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const old = new Date(Date.now() - 180000);
      for (const name of ["run.lock", "lock-recovery"]) {
        await writeFile(join(root, name), content, { mode: 0o600 });
        await utimes(join(root, name), old, old);
      }
      const release = await acquireLock(root, "recovered-test");
      assert.equal((await readJson(join(root, "run.lock"))).protocol, "flock-v1");
      assert.equal(await readJson(join(root, "lock-recovery"), null), null);
      await release();
    });
  }
});

test("recent incomplete claims and live legacy owners are never removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-lock-live-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "run.lock");
  await writeFile(path, "", { mode: 0o600 });
  await assert.rejects(acquireLock(root, "recent-test"), { code: "locked" });
  const partial = `{"pid":${process.pid},`;
  await writeFile(path, partial);
  const old = new Date(Date.now() - 180000);
  await utimes(path, old, old);
  await assert.rejects(acquireLock(root, "live-pid-test"), { code: "locked" });
  assert.equal(await readFile(path, "utf8"), partial);
});

test("an old incomplete claim with an open descriptor is not an abandoned owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-lock-descriptor-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "run.lock");
  const handle = await open(path, "w", 0o600);
  await utimes(path, new Date(0), new Date(0));
  try {
    await assert.rejects(acquireLock(root, "descriptor-test"), { code: "locked" });
  } finally {
    await handle.close();
  }
  const release = await acquireLock(root, "after-descriptor-close");
  await release();
});

test("simultaneous acquisitions cannot both become owners", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-lock-race-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => acquireLock(root, `test-${index}`)));
  const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.ok(attempts.filter((attempt) => attempt.status === "rejected").every((attempt) => attempt.reason.code === "locked"));
  await winners[0].value();
});

test("process death releases the kernel claim without a recovery marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shortlist-lock-death-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL("../scheduler/io.mjs", import.meta.url).href;
  const script = `import {acquireLock} from ${JSON.stringify(moduleUrl)}; await acquireLock(process.argv[1], "crash-test"); console.log("ready"); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root], { stdio: ["ignore", "pipe", "pipe"] });
  await once(child.stdout, "data");
  const exited = once(child, "close");
  child.kill("SIGKILL");
  await exited;
  await delay(50);
  const release = await acquireLock(root, "after-crash");
  assert.equal((await readJson(join(root, "run.lock"))).pid, process.pid);
  await release();
});
