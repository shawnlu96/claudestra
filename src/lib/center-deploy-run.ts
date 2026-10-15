/** Script output goes straight to private local files, with no truncation or return through ledger-facing results. */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { runBounded } from "./run-bounded.js";

export function centerScriptRunner(log: string): typeof runBounded {
  return async (argv, opts) => {
    mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
    const fd = openSync(log, "ax", 0o600);
    try {
      return await new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ["ignore", fd, fd], detached: true });
        let done = false;
        const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* The group already exited. */ } } };
        const finish = (code: number | null, timedOut: boolean) => {
          if (done) return;
          done = true; clearTimeout(timer); kill();
          process.off("exit", kill); process.off("SIGTERM", terminate); process.off("SIGINT", terminate);
          resolve({ code, timedOut, stdout: "", stderr: "" });
        };
        const terminate = () => finish(null, false);
        const timer = setTimeout(() => finish(null, true), opts.timeoutMs);
        process.once("exit", kill); process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
        child.once("error", () => finish(null, false));
        child.once("exit", (code) => finish(code, false));
      });
    } finally { closeSync(fd); }
  };
}
