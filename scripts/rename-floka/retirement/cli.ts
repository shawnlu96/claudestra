#!/usr/bin/env bun
/**
 * 分项收兼容（rename-floka-CLEAN1）。只读显式给的脱敏样本，不接生产统计、日志或台账：
 *   bun scripts/rename-floka/retirement/cli.ts --sample <样本.json> [--config <config.json>] [--allowlist <表.json>]
 *     [--items legacy-send,install-alias --target <空临时目录> --state <状态目录>]   # 仅 on 档
 * 档位读 config 的 rename.retireCompat（缺省 off）；--config 不给时读本机配置，只读。
 * 退出码：0 = 计划已出 / on 已写入；1 = on 档拒绝执行（一个文件都没写）；2 = 用法 / 输入错误。说明见同目录 README.md。
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AllowlistError } from "../../../src/lib/floka-compat/retirement/allowlist.js";
import { RetireError, runRetirement, type RetireIo, type RetireResult } from "../../../src/lib/floka-compat/retirement/run.js";
import { SampleError } from "../../../src/lib/floka-observation/sample.js";

const REPO = resolve(import.meta.dir, "../../..");
const DEFAULT_ALLOWLIST = join(REPO, "scripts/rename-floka/codemod/compat-allowlist.json");
const FLAGS = ["--sample", "--config", "--allowlist", "--items", "--target", "--state"] as const;
type Flag = (typeof FLAGS)[number];

function parseArgs(argv: string[]): Partial<Record<Flag, string>> {
  const out: Partial<Record<Flag, string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as Flag, value = argv[i + 1];
    if (!FLAGS.includes(flag)) throw new RetireError(`不认识的参数 ${flag}；可用 ${FLAGS.join(" ")}`);
    if (value === undefined || value.startsWith("--")) throw new RetireError(`${flag} 缺值`);
    out[flag] = value;
  }
  return out;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name), st = lstatSync(p);
    return st.isDirectory() ? listFiles(p) : st.isFile() ? [p] : [];
  });
}

const nodeIo: RetireIo = {
  realpath: (p) => realpathSync(p),
  isDir: (p) => statSync(p).isDirectory(),
  listFiles,
  readBytes: (p) => readFileSync(p),
  writeNew: (p, text) => writeFileSync(p, text, { flag: "wx", mode: 0o600 }),
};

async function loadConfig(path: string | undefined): Promise<unknown> {
  if (path !== undefined) return JSON.parse(readFileSync(path, "utf8"));
  const { readConfigSync } = await import("../../../src/lib/config-store.js");
  return readConfigSync();
}

export async function retireMain(argv: string[], now = Date.now()): Promise<{ code: number; result?: RetireResult; error?: string }> {
  try {
    const a = parseArgs(argv);
    const result = runRetirement({
      config: await loadConfig(a["--config"]),
      sampleText: a["--sample"] === undefined ? null : readFileSync(a["--sample"], "utf8"),
      allowlistText: readFileSync(a["--allowlist"] ?? DEFAULT_ALLOWLIST, "utf8"),
      now, items: a["--items"]?.split(",").map((s) => s.trim()).filter(Boolean), target: a["--target"], stateDir: a["--state"],
      protectRoots: [REPO], tmpRoots: [tmpdir(), "/tmp"], io: nodeIo,
    });
    return { code: 0, result };
  } catch (e) {
    if (e instanceof RetireError && e.message.startsWith("拒绝执行")) return { code: 1, error: e.message };
    // 只报自己的判断；系统错误只报类别，不回显文件内容
    const mine = e instanceof RetireError || e instanceof AllowlistError || e instanceof SampleError;
    return { code: 2, error: mine ? (e as Error).message : `读取失败：${(e as NodeJS.ErrnoException).code ?? (e as Error).name}` };
  }
}

if (import.meta.main) {
  const { code, result, error } = await retireMain(process.argv.slice(2));
  if (error) console.error(`[floka-retirement] ${error}`);
  if (result) {
    for (const p of result.problems) console.error(`[floka-retirement] ${p}`);
    console.log(JSON.stringify(result.gear === "off" ? { gear: "off" } : { plan: result.plan, executed: result.executed }, null, 2));
  }
  process.exit(code);
}
