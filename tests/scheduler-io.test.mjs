import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
