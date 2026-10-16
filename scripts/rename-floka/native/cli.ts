/**
 * rename.native 的命令行入口。开关 rename.native = off / observe / on,缺省 off,只从 --mode 读。
 *   identity [--platform <平台配置.json>]          新 App 身份计划;on 缺签名 / APNs 前提就拒绝发布步骤(退出码 1)
 *   import --old <旧壳配置> --new <新壳配置> [--plan <observe 输出>]   配置导入;on 必须给 --plan
 *   rollback --new <新壳配置>                      删导入出的新壳配置,核旧壳配置与推送凭据仍在
 *   check                                          仓库构建配置静态校验(只读,与 mode 无关)
 * 不签名、不发布、不碰设备、不连 APNs;构建配置不由本工具切换。
 * 用法:bun scripts/rename-floka/native/cli.ts <子命令> [--mode off|observe|on] [--root <仓库>] ...
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkStaticConfig, planNativeIdentity, type NativeMode, type PlatformConfig } from "./identity.ts";
import { applyImport, planImport, rollbackImport } from "./import.ts";

interface CliResult { code: number; stdout: string; stderr: string }

const COMMANDS = new Set(["identity", "import", "rollback", "check"]);
const VALUE_FLAGS = new Set(["mode", "platform", "old", "new", "plan", "root"]);

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.has(cmd ?? "")) throw new Error(`invalid_arguments: 子命令只能是 ${[...COMMANDS].join(" / ")}`);
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].startsWith("--") ? rest[i].slice(2) : "";
    const value = rest[i + 1];
    if (!VALUE_FLAGS.has(key) || value === undefined || Object.hasOwn(opts, key)) throw new Error(`invalid_arguments: ${rest[i]}`);
    opts[key] = value;
  }
  return { cmd, opts };
}

const readJson = (cwd: string, p: string): unknown => JSON.parse(readFileSync(resolve(cwd, p), "utf8"));

export async function runNativeCli(argv: string[], cwd = process.cwd()): Promise<CliResult> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs(argv); } catch (e) { return { code: 2, stdout: "", stderr: (e as Error).message }; }
  const { cmd, opts } = parsed;
  const mode = (opts.mode ?? "off") as NativeMode;
  if (mode !== "off" && mode !== "observe" && mode !== "on") return { code: 2, stdout: "", stderr: "invalid_mode: --mode 只能是 off / observe / on" };
  const emit = (r: { status?: string; ok?: boolean }): CliResult =>
    ({ code: r.status === "blocked" || r.ok === false ? 1 : 0, stdout: `${JSON.stringify(r, null, 2)}\n`, stderr: "" });
  try {
    if (cmd === "check") return emit(checkStaticConfig(resolve(cwd, opts.root ?? ".")));
    if (cmd === "identity") {
      const platform = opts.platform ? readJson(cwd, opts.platform) as PlatformConfig : undefined;
      return emit(planNativeIdentity({ mode, platform }));
    }
    if (!opts.new) return { code: 2, stdout: "", stderr: "invalid_arguments: 缺 --new" };
    const newPath = resolve(cwd, opts.new);
    if (cmd === "rollback") return emit(rollbackImport({ mode, newPath }));
    if (!opts.old) return { code: 2, stdout: "", stderr: "invalid_arguments: 缺 --old" };
    const oldPath = resolve(cwd, opts.old);
    if (mode !== "on") return emit(planImport({ mode, oldPath, newPath }));
    const plan = opts.plan ? readJson(cwd, opts.plan) as Parameters<typeof applyImport>[0]["plan"] : undefined;
    return emit(applyImport({ mode, oldPath, newPath, plan }));
  } catch (e) {
    return { code: 1, stdout: "", stderr: (e as Error).message };
  }
}

if (import.meta.main) {
  const r = await runNativeCli(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exit(r.code);
}
