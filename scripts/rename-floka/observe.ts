#!/usr/bin/env bun
/**
 * 旧格式观察报告（rename-floka-OBSERVE1）。只读显式给的脱敏样本，不接生产统计、日志或台账：
 *   bun scripts/rename-floka/observe.ts --sample <样本.json> [--config <config.json>] [--out <临时目录>]
 * 档位读 config 的 rename.observation（缺省 observe）；--config 不给时读本机配置，只读。
 * 退出码：0 = 退出条件全满足；1 = 报告已出但不许退出；2 = 用法 / 样本错误；off 档什么都不做，返回 0。
 * 用法与观察期见 scripts/rename-floka/rollout-runbook.md。
 */
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runObservation, type ObservationIo, type RunResult } from "../../src/lib/floka-observation/run.js";
import { SampleError } from "../../src/lib/floka-observation/sample.js";

interface Args { sample?: string; config?: string; out?: string }

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new SampleError(`${flag} 缺值`);
    if (flag === "--sample") out.sample = value;
    else if (flag === "--config") out.config = value;
    else if (flag === "--out") out.out = value;
    else throw new SampleError("用法：observe.ts --sample <样本.json> [--config <config.json>] [--out <临时目录>]");
  }
  return out;
}

const nodeIo: ObservationIo = {
  realpath: (p) => realpathSync(p),
  isDir: (p) => statSync(p).isDirectory(),
  writeNew: (p, text) => writeFileSync(p, text, { flag: "wx", mode: 0o600 }),
};

async function loadConfig(path: string | undefined): Promise<unknown> {
  if (path !== undefined) return JSON.parse(readFileSync(path, "utf8"));
  const { readConfigSync } = await import("../../src/lib/config-store.js");
  return readConfigSync();
}

export async function observeMain(argv: string[], now = Date.now()): Promise<{ code: number; result?: RunResult; error?: string }> {
  try {
    const args = parseArgs(argv);
    const result = runObservation({
      sampleText: args.sample === undefined ? null : readFileSync(args.sample, "utf8"),
      config: await loadConfig(args.config), now, outDir: args.out, tmpRoots: [tmpdir(), "/tmp"], io: nodeIo,
    });
    return { code: result.gear === "off" || result.report.exit.ok ? 0 : 1, result };
  } catch (e) {
    // 只报自己的判断；文件读失败等系统错误只报类别，不带路径以外的内容
    const msg = e instanceof SampleError ? e.message : `读取失败：${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`;
    return { code: 2, error: msg };
  }
}

if (import.meta.main) {
  const { code, result, error } = await observeMain(process.argv.slice(2));
  if (error) console.error(`[floka-observation] ${error}`);
  if (result) {
    for (const p of result.problems) console.error(`[floka-observation] ${p}`);
    console.log(JSON.stringify(result.gear === "off" ? { gear: "off" } : result.report, null, 2));
    if (result.gear === "on") console.error(`[floka-observation] 报告已写入 ${result.written}`);
  }
  process.exit(code);
}
