/** Shared one-shot launchd submission: launchd owns the responsibility chain, never the invoking daemon. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runBounded } from "./run-bounded.js";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export interface OneshotInput { label: string; argv: string[]; cwd: string; env: Record<string, string>; dir: string }

/** The directory is an at-most-once claim, even when submission has an uncertain result. */
export function claimLaunchdJob(dir: string): boolean {
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); return true; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

/** Persist only execution context, never inherited tokens or credentials. */
export function launchdJobEnv(env: NodeJS.ProcessEnv, extra: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SSH_AUTH_SOCK", "BRIDGE_PORT",
    "CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR", "CLAUDESTRA_SANDBOX", "CLAUDESTRA_SANDBOX_ROOT",
    "CLAUDESTRA_SANDBOX_DENY_DIRS", "CLAUDESTRA_SANDBOX_DENY_PORTS", ...extra]) if (env[key]) out[key] = env[key]!;
  return out;
}

function renderLaunchdJob({ label, argv, cwd, env: values, dir }: OneshotInput): string {
  const env = Object.entries(values).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key><dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${xml(join(dir, "stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(dir, "stderr.log"))}</string>
</dict></plist>
`;
}

export async function submitLaunchdJob(input: OneshotInput, domain: string, command = runBounded): Promise<void> {
  const plistPath = join(input.dir, "job.plist");
  writeFileSync(plistPath, renderLaunchdJob(input), { mode: 0o600 });
  const r = await command(["/bin/launchctl", "bootstrap", domain, plistPath], { timeoutMs: 15_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`launchctl bootstrap ${r.timedOut ? "timeout" : `exit ${r.code}`}: ${r.stderr.trim().slice(0, 200)}`);
}

export async function removeLaunchdJob(label: string, domain: string, command = runBounded): Promise<boolean> {
  const r = await command(["/bin/launchctl", "bootout", `${domain}/${label}`], { timeoutMs: 30_000 });
  // 3 / 113 = no such service: already gone, which is the goal.
  return !r.timedOut && (r.code === 0 || r.code === 3 || r.code === 113 || /could not find|no such process/i.test(r.stderr));
}
