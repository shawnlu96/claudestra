/**
 * 一次观察：读档位 → 解析样本 → 出报告；on 档另把报告写进显式给出的临时目录。
 * 文件系统只经 io 注入；off / observe 的路径上没有任何 io 调用（tests/floka-observation.test.ts 用一碰就抛的 io 钉住）。
 * on 的输出目录必须已存在、真实路径落在系统临时根下，且只新建不覆盖：报告不会混进状态目录或仓库。
 */
import { join, sep } from "node:path";
import { parseObservationGear, type ObservationGear } from "./gear.js";
import { buildReport, type ObservationReport } from "./report.js";
import { parseSample, SampleError } from "./sample.js";

export interface ObservationIo {
  realpath: (p: string) => string;
  isDir: (p: string) => boolean;
  /** 只新建；目标已存在必须抛错 */
  writeNew: (path: string, text: string) => void;
}

export interface RunInput {
  sampleText: string | null;
  config: unknown;
  now: number;
  outDir?: string;
  /** 允许 on 档落盘的临时根（调用方给 os.tmpdir() 等） */
  tmpRoots: readonly string[];
  io: ObservationIo;
}

export type RunResult =
  | { gear: "off"; problems: string[] }
  | { gear: Exclude<ObservationGear, "off">; problems: string[]; report: ObservationReport; written?: string };

function under(root: string, p: string): boolean {
  return p !== root && p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** on 档的输出目录：已存在、是目录、真实路径（解开 symlink 后）严格位于某个临时根之下 */
function checkOutDir(dir: string, tmpRoots: readonly string[], io: ObservationIo): string {
  let real: string;
  try { real = io.realpath(dir); } catch { throw new SampleError("输出目录不存在（on 档不替你建目录）"); }
  if (!io.isDir(real)) throw new SampleError("输出路径不是目录");
  const roots = tmpRoots.flatMap((r) => { try { return [io.realpath(r)]; } catch { return []; /* 这个临时根本机没有，少一个候选不影响判定 */ } });
  if (!roots.some((r) => under(r, real))) throw new SampleError("on 档只许写到系统临时目录下的子目录");
  return real;
}

export function runObservation(input: RunInput): RunResult {
  const { gear, problems } = parseObservationGear(input.config);
  if (gear === "off") return { gear, problems };
  if (input.outDir !== undefined && gear !== "on") throw new SampleError("--out 只在 rename.observation=on 时可用；observe 档零写入");
  if (gear === "on" && input.outDir === undefined) throw new SampleError("rename.observation=on 要显式给 --out <临时目录>");
  if (input.sampleText === null) throw new SampleError("要显式给 --sample <脱敏样本.json>；本工具不读生产统计");
  const report = buildReport(parseSample(input.sampleText), gear, input.now);
  if (gear !== "on") return { gear, problems, report };
  const dir = checkOutDir(input.outDir as string, input.tmpRoots, input.io);
  const written = join(dir, `floka-observation-${input.now}.json`);
  input.io.writeNew(written, JSON.stringify(report, null, 2) + "\n");
  return { gear, problems, report, written };
}
