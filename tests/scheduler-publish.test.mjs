import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishSnapshot, verifyPublication } from "../scheduler/publish.mjs";
import { buildSnapshot } from "../scheduler/snapshot.mjs";
import { RunError } from "../scheduler/io.mjs";
import { fixture, snapshotOf } from "./helpers/fixtures.mjs";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-publish-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs", "data"), { recursive: true });
  const previous = snapshotOf([fixture()]);
  const snapshot = buildSnapshot(previous, { cards: [], details: [] }, [],
    { version: 1, reviewedIds: [fixture().id], detailIds: [fixture().id] }, {
      runId: "manual-test-run", startedAt: "2026-09-07T10:00:00Z", generatedAt: "2026-09-07T11:00:00Z",
    });
  await writeFile(join(root, "docs/data/jobs.json"), JSON.stringify(previous));
  const calls = [];
  let committed = false;
  const services = {
    git: async (_runtime, args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return committed ? "new-sha" : "old-sha";
      if (args[0] === "ls-remote") return "old-sha\trefs/heads/main";
      if (args.includes("--name-only")) return "docs/data/jobs.json";
      if (args.includes("commit")) committed = true;
      return "";
    },
    verifyPublication: async () => ({ url: "https://example.invalid/" }),
  };
  return { root, snapshot, previous, calls, services, prepared: { cwd: root, head: "old-sha" }, runtime: { repository: "TEST_ONLY/repository" } };
}

test("publishing stages only the snapshot, includes coauthor and requires matching live bytes", async (t) => {
  const data = await setup(t);
  const pending = [];
  let verified = false;
  data.services.verifyPublication = async (_runtime, text) => {
    verified = true;
    assert.equal(text, await readFile(join(data.root, "docs/data/jobs.json"), "utf8"));
    return { url: "https://example.invalid/" };
  };
  const result = await publishSnapshot(data.root, data.runtime, data.snapshot, data.prepared,
    new AbortController().signal, async (value) => pending.push(value), data.services);
  assert.equal(result.sha, "new-sha");
  assert.ok(verified);
  assert.equal(pending.length, 1);
  assert.deepEqual(data.calls.find((args) => args[0] === "add"), ["add", "--", "docs/data/jobs.json"]);
  assert.ok(data.calls.find((args) => args.includes("commit")).some((value) => value.startsWith("Co-authored-by:")));
});

test("remote race or dirty clone blocks publication before touching local snapshot", async (t) => {
  for (const kind of ["remote", "dirty"]) {
    await t.test(kind, async (subtest) => {
      const data = await setup(subtest);
      const original = await readFile(join(data.root, "docs/data/jobs.json"), "utf8");
      const git = data.services.git;
      data.services.git = async (runtime, args) => {
        if (kind === "remote" && args[0] === "ls-remote") return "changed-sha\trefs/heads/main";
        if (kind === "dirty" && args[0] === "status") return " M unrelated.txt";
        return git(runtime, args);
      };
      await assert.rejects(publishSnapshot(data.root, data.runtime, data.snapshot, data.prepared,
        new AbortController().signal, async () => {}, data.services));
      assert.equal(await readFile(join(data.root, "docs/data/jobs.json"), "utf8"), original);
      assert.ok(!data.calls.some((args) => args[0] === "push"));
    });
  }
});

test("cancellation after commit persists a pending result but prevents a push and success", async (t) => {
  const data = await setup(t);
  const controller = new AbortController();
  let pending;
  await assert.rejects(publishSnapshot(data.root, data.runtime, data.snapshot, data.prepared, controller.signal,
    async (value) => { pending = value; controller.abort(new RunError("cancelled", "Cancelled.")); }, data.services), { code: "cancelled" });
  assert.equal(pending.sha, "new-sha");
  assert.ok(!data.calls.some((args) => args[0] === "push"));
});

test("Pages verification succeeds only on exact expected bytes", async (t) => {
  const expected = '{"TEST_ONLY":true}\n';
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(expected, { status: 200 }));
  const result = await verifyPublication({ repository: "TEST_ONLY/repository" }, expected, new AbortController().signal);
  assert.equal(result.attempts, 1);
  assert.ok(fetch.mock.calls[0].arguments[0].searchParams.has("snapshot"));
  assert.equal(fetch.mock.calls[0].arguments[1].cache, "no-store");
  fetch.mock.mockImplementation(async () => new Response("wrong snapshot", { status: 200 }));
  await assert.rejects(verifyPublication({ repository: "TEST_ONLY/repository" }, expected, new AbortController().signal, { timeoutMs: 0 }), { code: "pages-timeout" });
});
