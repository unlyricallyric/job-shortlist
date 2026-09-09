import { mkdir, cp, writeFile, chmod, lstat, access, unlink, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { command } from "./process.mjs";
import { atomicJson, privateDirectory, readJson, RunError, acquireLock } from "./io.mjs";
import { defaultRoot, defaultQueries, defaultLimits, label, awakeLabel } from "./config.mjs";
import { validateLedger } from "./snapshot.mjs";
import { initialState } from "./runner.mjs";
import { git } from "./publish.mjs";
import { defaultIntentPolicy, validateIntentPolicy, assertCollectionMode, collectionMode } from "./intent.mjs";
import { emptyReviewQueue } from "./review.mjs";
import { activateNextSlot } from "./clock.mjs";

const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export const serviceDomain = () => `gui/${process.getuid()}`;
export const agentPath = (name) => join(homedir(), "Library", "LaunchAgents", `${name}.plist`);
export const probeLabel = "com.job-shortlist.access-probe";

export function launchAgentPlist({ root, nodePath, acOnly = false, probe = false }) {
  const args = acOnly ? ["/usr/bin/caffeinate", "-s"]
    : probe ? [nodePath, join(root, "app", "scheduler", "access-probe.mjs"), root]
    : [nodePath, join(root, "app", "scheduler", "cli.mjs"), "tick", "--root", root];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${acOnly ? awakeLabel : probe ? probeLabel : label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>
<key>HOME</key><string>${xml(homedir())}</string>
<key>PATH</key><string>${xml(dirname(nodePath))}:/usr/bin:/bin:/usr/sbin:/sbin</string>
</dict>
<key>RunAtLoad</key><true/>
${acOnly ? "<key>KeepAlive</key><true/>" : probe ? "" : "<key>StartInterval</key><integer>60</integer>"}
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>ExitTimeOut</key><integer>30</integer>
</dict></plist>
`;
}

export async function installAccessProbe({ root = defaultRoot(), runtime, tab }) {
  await privateDirectory(root);
  if (await readJson(join(root, "runtime.json"), null)) throw new RunError("probe-existing-install", "Use installed preflight after installation.");
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await privateDirectory(join(root, "app", "scheduler"));
  await privateDirectory(join(root, "app", "docs"));
  for (const name of ["access-probe.mjs", "browser.mjs", "coverage.mjs", "publish.mjs", "process.mjs", "io.mjs"]) {
    await cp(join(source, "scheduler", name), join(root, "app", "scheduler", name));
  }
  await cp(join(source, "docs", "model.mjs"), join(root, "app", "docs", "model.mjs"));
  await atomicJson(join(root, "runtime.json"), runtime);
  await atomicJson(join(root, "browser.json"), tab);
  await mkdir(dirname(agentPath(probeLabel)), { recursive: true });
  await writeFile(agentPath(probeLabel), launchAgentPlist({ root, nodePath: runtime.nodePath, probe: true }), { mode: 0o600 });
  await command("/usr/bin/plutil", ["-lint", agentPath(probeLabel)]);
  await bootstrap(probeLabel);
  return { label: probeLabel, requested: true };
}

export async function isLoaded(name) {
  try {
    await command("/bin/launchctl", ["print", `${serviceDomain()}/${name}`], { timeout: 10000 });
    return true;
  } catch (error) {
    if (error.exitCode && /Could not find service|Could not find specified service/i.test(error.stderr)) return false;
    throw error;
  }
}

export async function bootout(name) {
  if (await isLoaded(name)) await command("/bin/launchctl", ["bootout", `${serviceDomain()}/${name}`]);
}

async function bootstrap(name) {
  if (!await isLoaded(name)) await command("/bin/launchctl", ["bootstrap", serviceDomain(), agentPath(name)]);
}

export async function install({ root = defaultRoot(), matchingPath, ledgerPath, sshKeyPath, knownHostsPath, repository,
  nodePath = process.execPath, gitPath = "/usr/bin/git", adoptWindow, adoptTab, mode }) {
  if (mode !== collectionMode) throw new RunError("collection-mode-required", "Installation requires explicit mode collection-only.");
  process.umask(0o077);
  root = resolve(root);
  await privateDirectory(root);
  const release = await acquireLock(root, "installation");
  try {
    const { validateMatchingConfig } = await import("./screening.mjs");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new RunError("install-arguments", "A GitHub owner/repository is required.");
    const matching = validateMatchingConfig(await readJson(matchingPath));
    const ledger = validateLedger(await readJson(ledgerPath));
    const previousRuntime = await readJson(join(root, "runtime.json"), null);
    const intent = validateIntentPolicy(await readJson(join(root, "intent-policy.json"), defaultIntentPolicy()));
    const runtime = {
      ...(previousRuntime ?? {}),
      version: 1, repository, branch: "main", nodePath: resolve(nodePath), gitPath: await realpath(gitPath),
      sshKeyPath: resolve(sshKeyPath), knownHostsPath: resolve(knownHostsPath), queries: intent.queries,
      limits: { ...(previousRuntime?.limits ?? defaultLimits), maxNewJobs: 0 },
      mode: collectionMode, autoPublish: false, reviewRequired: true,
    };
    for (const path of [runtime.sshKeyPath, runtime.knownHostsPath]) {
      const info = await lstat(path);
      if (!path.startsWith(join(root, "keys") + "/") || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) {
        throw new RunError("deploy-key-path", "Deployment keys and pinned hosts must be task-owned private regular files.");
      }
    }
    await command(runtime.nodePath, ["--version"]);
    await command(runtime.gitPath, ["--version"]);
    await command("/usr/bin/perl", ["-MFcntl=:flock", "-e", "exit 0"]);
    await access("/usr/sbin/lsof");
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const installed = join(root, "app");
    if (source === installed) throw new RunError("install-source", "Run installation from the repository, not the installed runtime.");
    await privateDirectory(installed);
    await cp(join(source, "scheduler"), join(installed, "scheduler"), { recursive: true, dereference: false });
    await privateDirectory(join(installed, "docs"));
    await cp(join(source, "docs", "model.mjs"), join(installed, "docs", "model.mjs"));
    await atomicJson(join(root, "runtime.json"), runtime);
    await atomicJson(join(root, "intent-policy.json"), intent);
    const previousMatching = await readJson(join(root, "matching.json"), null);
    if (!previousMatching) await atomicJson(join(root, "matching.json"), matching);
    const previousLedger = await readJson(join(root, "ledger.json"), null);
    if (!previousLedger) await atomicJson(join(root, "ledger.json"), ledger);
    const oldState = await readJson(join(root, "state.json"), initialState());
    await atomicJson(join(root, "state.json"), oldState.collectionActivatedAt
      ? oldState : activateNextSlot(oldState));
    if (!await readJson(join(root, "review-queue.json"), null)) {
      await atomicJson(join(root, "review-queue.json"), emptyReviewQueue());
    }
    await atomicJson(join(root, "control.json"), { paused: true, cancelRunId: null });
    if (adoptWindow !== undefined || adoptTab !== undefined) {
      if (!Number.isSafeInteger(adoptWindow) || !Number.isSafeInteger(adoptTab)) throw new RunError("install-tab", "Both task-owned browser IDs are required.");
      await atomicJson(join(root, "browser.json"), { windowId: adoptWindow, tabId: adoptTab });
    }
    const clone = join(root, "publish");
    try {
      await access(join(clone, ".git"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await git(runtime, ["clone", "--quiet", "--branch", "main", `https://github.com/${repository}.git`, clone], { timeout: 120000 });
    }
    await privateDirectory(clone);
    await mkdir(dirname(agentPath(label)), { recursive: true });
    for (const [name, acOnly] of [[label, false], [awakeLabel, true]]) {
      const path = agentPath(name);
      await writeFile(path, launchAgentPlist({ root, nodePath: runtime.nodePath, acOnly }), { mode: 0o600 });
      await chmod(path, 0o600);
      await command("/usr/bin/plutil", ["-lint", path]);
    }
    await bootout(awakeLabel);
    await bootout(probeLabel);
    await unlink(agentPath(probeLabel)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await bootout(label);
    await bootstrap(label);
    return { root, label, installed: true, paused: true, mode: collectionMode, autoPublish: false,
      collectionNeedsCredentials: false, explicitPublishingAuthentication: "task-repository-deploy-key" };
  } finally {
    await release();
  }
}

export async function pause(root) {
  const state = await readJson(join(root, "state.json"));
  await atomicJson(join(root, "control.json"), { paused: true, cancelRunId: state.lastRun?.status === "running" ? state.lastRun.id : null });
  await bootout(awakeLabel);
  return { paused: true, activeRunCancellationRequested: state.lastRun?.status === "running" };
}

export async function resume(root) {
  const release = await acquireLock(root, "resume-collection-only");
  try {
    const runtime = await readJson(join(root, "runtime.json"));
    assertCollectionMode(runtime);
    validateIntentPolicy(await readJson(join(root, "intent-policy.json")));
    const state = await readJson(join(root, "state.json"));
    await atomicJson(join(root, "state.json"), activateNextSlot(state));
    await atomicJson(join(root, "control.json"), { paused: false, cancelRunId: null });
  } finally {
    await release();
  }
  await bootstrap(label);
  await bootstrap(awakeLabel);
  await command("/bin/launchctl", ["kickstart", `${serviceDomain()}/${label}`]);
  return { enabled: true, mode: collectionMode, autoPublish: false, acOnlyAwakeHelper: true,
    activation: "next-future-slot" };
}

export async function uninstall(root) {
  await pause(root);
  await bootout(label);
  await bootout(probeLabel);
  for (const name of [label, awakeLabel, probeLabel]) {
    await unlink(agentPath(name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { uninstalled: true, privateDataRetained: true, deployKey: "Revoke the repository deploy key in GitHub settings when no longer needed." };
}
