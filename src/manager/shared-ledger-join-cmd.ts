/**
 * `manager shared-ledger-join --url <center> --project <local> [--code-file <0600 file>] [--subject <principal>]`.
 * The join code is read from stdin or a 0600 file, never argv; the bearer and code never reach stdout/stderr.
 * Logic lives in lib/shared-ledger-join.ts so the bridge can drive the same flow behind a button.
 */
import { lstatSync, readFileSync } from "node:fs";
import { instanceKeySync } from "../lib/instance-key.js";
import { readProjects } from "../lib/projects.js";
import { joinSharedLedger, looksLikeSharedLedgerJoinCode, SharedLedgerJoinError } from "../lib/shared-ledger-join.js";
import { output } from "./core.js";

const USAGE = "usage: shared-ledger-join --url <中心根 URL> --project <本机项目> [--code-file <0600 文件>] [--subject <本机 principal>]（入组码从 stdin 或 --code-file 读）";
const VALUED = new Set(["url", "project", "code-file", "subject"]);

export function parseJoinArgs(args: string[]): Record<string, string> | string {
  if (args.some(looksLikeSharedLedgerJoinCode)) return "入组码不能放在命令行参数里：从 stdin 或 0600 文件读入";
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.startsWith("--") ? a.slice(2) : "";
    if (!VALUED.has(name) || args[i + 1] === undefined) return USAGE;
    flags[name] = args[++i]!;
  }
  return flags.url && flags.project ? flags : USAGE;
}

/** A code file must be a regular file owned by this user, readable by nobody else. */
export function readJoinCodeFile(path: string): string {
  const st = lstatSync(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
    throw new SharedLedgerJoinError("join code file must be a regular 0600 file owned by this user");
  }
  return readFileSync(path, "utf8");
}

export async function cmdSharedLedgerJoin(args: string[], stdin: () => Promise<string> = () => Bun.stdin.text()): Promise<void> {
  const flags = parseJoinArgs(args);
  if (typeof flags === "string") return output({ ok: false, error: flags });
  try {
    if (flags.project && !(await readProjects()).projects.some((p) => p.id === flags.project)) {
      return output({ ok: false, error: `projects.json 里没有项目 ${flags.project}` });
    }
    const code = flags["code-file"] ? readJoinCodeFile(flags["code-file"]) : await stdin();
    const key = instanceKeySync();
    if (!key) return output({ ok: false, error: "本机实例密钥不可用" });
    // The enrollment instance id is derived from the key (i28-JN2), so teammates cannot squat it.
    const result = await joinSharedLedger({ url: flags.url!, code, key, subject: flags.subject ?? "owner:self",
      ...(flags.project ? { localProjectId: flags.project } : {}) });
    output({ ok: true, ...result });
  } catch (e) {
    // Only fixed messages leave this process; arbitrary errors could quote the code or a center response.
    output({ ok: false, error: e instanceof SharedLedgerJoinError ? e.message : "shared ledger join failed" });
  }
}
