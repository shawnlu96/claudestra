import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { cliWrapperScript } from "../../cli-wrapper.js";
import { writeTextAtomicSync } from "../../state-file.js";
import { shellEscape } from "../../claude-launch.js";
import { WRAPPER_POLICY_PATH } from "./wrapper-policy.js";
import { TMUX_SOCK } from "../../paths.js";
import { basename, join } from "node:path";

export interface CliBefore { path: string; kind: "missing" | "file" | "symlink"; value?: string; mode?: number }

/** Reuse the hardened wrapper; migrated launchers never bootstrap jobs on an ordinary attach. */
export function serviceWrapperScript(repo: string, bun: string, labels: readonly string[], context?: {
  root: string; stateDir: string; runtimeDir: string;
}): string {
  if (labels.length !== 4 || labels.some(l => !/^(ai\.floka|com\.claudestra)\.(bridge|cron|scheduler|launcher)$/.test(l))) throw new Error("Invalid service labels");
  let script = cliWrapperScript(repo, bun, labels, !!context)
    .replace(`REPO=${JSON.stringify(repo)}`, `REPO=${shellEscape(repo)}`)
    .replace(`BUN=${JSON.stringify(bun)}`, `BUN=${shellEscape(bun)}`);
  if (context) {
    const policy = WRAPPER_POLICY_PATH;
    const settings = ["STATE_DIR", "RUNTIME_DIR"].flatMap(k => ["CLAUDESTRA", "FLOKA"].map(prefix =>
      `export ${prefix}_${k}=${shellEscape(k === "STATE_DIR" ? context.stateDir : context.runtimeDir)}`)).join("\n");
    const select = `LABELS=$("$BUN" ${shellEscape(policy)} ${shellEscape(context.root)} ${shellEscape(`${context.stateDir}/config.json`)}) || exit 1`;
    const opposite = `case "\${DAEMONS[0]}" in ai.floka.*) OTHER=com.claudestra ;; *) OTHER=ai.floka ;; esac
for name in bridge cron scheduler launcher; do
  /bin/launchctl list "$OTHER.$name" >/dev/null 2>&1 && { echo "另一套服务仍已注册，拒绝 bootstrap" >&2; exit 1; }
done`;
    script = script.replace("MODE=auto", `${settings}\nMODE=auto`)
      .replace(/^SOCK=.*$/m, `SOCK=${shellEscape(join(context.runtimeDir, basename(TMUX_SOCK)))}`)
      .replace("UID_NUM=", `${select}\nread -r -a DAEMONS <<< "$LABELS"\n${opposite}\nUID_NUM=`);
  }
  return script;
}

export function captureCli(path: string): CliBefore {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return { path, kind: "symlink", value: readlinkSync(path) };
    if (!st.isFile()) throw new Error("CLI path is not a file or symlink");
    return { path, kind: "file", value: readFileSync(path).toString("base64"), mode: st.mode & 0o777 };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "missing" };
    throw e;
  }
}

export function restoreCli(before: CliBefore): void {
  if (before.kind === "file") {
    writeTextAtomicSync(before.path, Buffer.from(before.value!, "base64"), { mode: before.mode, noFollow: true });
    return;
  }
  try { unlinkSync(before.path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (before.kind === "symlink") symlinkSync(before.value!, before.path);
}

export function installCli(paths: readonly string[], script: string): void {
  for (const path of paths) writeTextAtomicSync(path, script, { mode: 0o755, noFollow: true });
}
