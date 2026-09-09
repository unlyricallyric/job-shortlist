import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "../scheduler/process.mjs";

async function inheritedPipes(t, options) {
  const root = await mkdtemp(join(tmpdir(), "shortlist-process-test-"));
  const pidPath = join(root, "test-descendant.pid");
  t.after(async () => {
    try {
      const pid = Number(await readFile(pidPath, "utf8"));
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rm(root, { recursive: true, force: true });
  });
  const program = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:['ignore','inherit','inherit']});
fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`;
  const started = Date.now();
  await assert.rejects(command(process.execPath, ["-e", program, pidPath], options));
  assert.ok(Date.now() - started < 2500, "A descendant's inherited pipes must not defeat the command deadline.");
  const pid = Number(await readFile(pidPath, "utf8"));
  let gone = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      gone = true;
      break;
    }
    await delay(20);
  }
  assert.ok(gone, "Only the owned test descendant should be terminated along with its command.");
}

test("timeouts reap owned descendants that keep stdout or stderr open", async (t) => {
  await inheritedPipes(t, { timeout: 250 });
});

test("cancellation reaps owned inherited-pipe descendants without waiting for their natural exit", async (t) => {
  await inheritedPipes(t, { timeout: 5000, signal: AbortSignal.timeout(250) });
});

test("normal subprocess output and missing-executable failures remain explicit", async () => {
  assert.equal(await command(process.execPath, ["-e", "console.log('TEST_ONLY_OK')"]), "TEST_ONLY_OK");
  await assert.rejects(command("/TEST_ONLY/not-an-executable", []), { code: "ENOENT" });
});
