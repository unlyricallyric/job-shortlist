import { spawn } from "node:child_process";
import { RunError } from "./io.mjs";

export async function command(executable, args, { cwd, input, timeout = 30000, signal, env = {}, maxBytes = 4 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ownProcessGroup = process.platform !== "win32";
    const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", ...env };
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "SSH_AGENT_PID"]) delete environment[name];
    for (const name of Object.keys(environment)) {
      if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(name)) delete environment[name];
    }
    const child = spawn(executable, args, {
      cwd, env: environment,
      stdio: ["pipe", "pipe", "pipe"], signal, killSignal: "SIGTERM", detached: ownProcessGroup,
    });
    // Keep task subprocess descendants from holding inherited pipes after their parent exits.
    const terminate = (terminationSignal) => {
      if (!child.pid) return;
      try {
        process.kill(ownProcessGroup ? -child.pid : child.pid, terminationSignal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const out = [], err = [];
    let bytes = 0, killed = false, abortError = null, escalation = null;
    const timer = setTimeout(() => {
      killed = true;
      terminate("SIGKILL");
    }, timeout);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        killed = true;
        terminate("SIGKILL");
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (error) => {
      if (error.name === "AbortError" && child.pid) {
        abortError = error;
        terminate("SIGTERM");
        escalation = setTimeout(() => {
          if (ownProcessGroup || (child.exitCode === null && child.signalCode === null)) terminate("SIGKILL");
        }, 1500);
        escalation.unref();
      } else {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      const stdout = Buffer.concat(out).toString("utf8"), stderr = Buffer.concat(err).toString("utf8");
      if (abortError) reject(abortError);
      else if (killed) reject(new RunError("command-timeout", "A subprocess exceeded its time or output limit."));
      else if (code !== 0) {
        const error = new RunError("command-failed", "A required subprocess failed.");
        error.exitCode = code;
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      } else resolve(stdout.trim());
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

export async function notifyFailure(code) {
  const message = `岗位精选更新未完成（${code.replace(/[^a-z0-9-]/g, "")}）。上次有效清单已保留，请查看本机状态。`;
  await command("/usr/bin/osascript", ["-e", `display notification ${JSON.stringify(message)} with title "岗位精选"`],
    { timeout: 10000 });
}
