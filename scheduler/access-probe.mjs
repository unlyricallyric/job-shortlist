import { join, resolve } from "node:path";
import { atomicJson, readJson } from "./io.mjs";
import { evaluatePage, cardsInPage } from "./browser.mjs";
import { preflightGithub } from "./publish.mjs";

const root = resolve(process.argv[2]);
const result = { trigger: "launchd-access-probe", pid: process.pid, at: new Date().toISOString() };
try {
  const runtime = await readJson(join(root, "runtime.json"));
  const tab = await readJson(join(root, "browser.json"));
  const page = await evaluatePage(tab, null, cardsInPage);
  if (page.state !== "ready") throw new Error("Source not ready.");
  await preflightGithub(runtime);
  Object.assign(result, { status: "ready", readableCards: page.cards.length, authenticated: true });
} catch (error) {
  Object.assign(result, { status: "blocked", code: typeof error.code === "string" ? error.code : "access-probe-failed" });
}
await atomicJson(join(root, "access-probe.json"), result);
