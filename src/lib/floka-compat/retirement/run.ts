/**
 * 一次收兼容运行。off 什么都不做；observe 出分项计划，路径上没有任何 io 调用（tests/floka-retirement.test.ts 用一碰就抛的 io 钉住）；
 * on 是临时执行：PM 逐项点名、每项都可退出、阶段 1 不落下，才把收掉后的允许表、原表恢复包与计划新建写进一个空的临时目录。
 * 前后各对状态目录里受保护的文件（身份 / peer / token / pin / 撤销 / transcript）算一遍哈希，不一致就报错——本模块不写状态目录、不删任何旧入口。
 */
import { join, relative, sep } from "node:path";
import { parseSample } from "../../floka-observation/sample.js";
import { parseAllowlist, protectedBy, retireItems, type RetainEntry } from "./allowlist.js";
import { parseRetireGear, type RetireGear } from "./gear.js";
import { isRetireItem, type RetireItem } from "./items.js";
import { buildPlan, sha256Text, type RetirementPlan } from "./plan.js";

export class RetireError extends Error {}

export interface RetireIo {
  realpath: (p: string) => string;
  isDir: (p: string) => boolean;
  /** 目录下全部普通文件的绝对路径（递归，不跟软链） */
  listFiles: (dir: string) => string[];
  readBytes: (p: string) => Uint8Array;
  /** 只新建；目标已存在必须抛错 */
  writeNew: (p: string, text: string) => void;
}

export interface RetireInput {
  config: unknown;
  sampleText: string | null;
  allowlistText: string;
  now: number;
  items?: readonly string[];
  target?: string;
  stateDir?: string;
  /** 目标不许与之重叠的目录（仓库根等）；状态目录自动算进去 */
  protectRoots?: readonly string[];
  tmpRoots: readonly string[];
  io: RetireIo;
}

interface Executed { retired: RetireItem[]; written: string[]; protectedFiles: number; protectedSha256: string }
export type RetireResult =
  | { gear: "off"; problems: string[] }
  | { gear: Exclude<RetireGear, "off">; problems: string[]; plan: RetirementPlan; executed?: Executed };

const under = (root: string, p: string): boolean => p.startsWith(root.endsWith(sep) ? root : root + sep);
const overlap = (a: string, b: string): boolean => a === b || under(a, b) || under(b, a);

function realRoots(roots: readonly string[], io: RetireIo): string[] {
  return roots.flatMap((r) => { try { return [io.realpath(r)]; } catch { return []; /* 本机没有这个根，少一个候选只会让判定更严 */ } });
}

function checkTarget(input: RetireInput, stateReal: string): string {
  const { io } = input;
  let real: string;
  try { real = io.realpath(input.target as string); } catch { throw new RetireError("目标目录不存在（on 档不替你建目录）"); }
  if (!io.isDir(real)) throw new RetireError("目标不是目录");
  if (!realRoots(input.tmpRoots, io).some((r) => r !== real && under(r, real))) throw new RetireError("on 档只许写到系统临时目录下的子目录");
  for (const r of [stateReal, ...realRoots(input.protectRoots ?? [], io)]) if (overlap(r, real)) throw new RetireError("目标与状态目录或仓库重叠");
  if (io.listFiles(real).length) throw new RetireError("目标目录要是空的");
  return real;
}

/** 受保护文件的相对路径 → sha256；整份清单再算一个摘要，执行前后必须相等 */
function protectedHashes(stateReal: string, retain: readonly RetainEntry[], io: RetireIo): Map<string, string> {
  const out = new Map<string, string>();
  for (const abs of io.listFiles(stateReal)) {
    const rel = relative(stateReal, abs).split(sep).join("/");
    if (protectedBy(rel, retain)) out.set(rel, sha256Text(io.readBytes(abs)));
  }
  return out;
}
const digest = (m: Map<string, string>): string => sha256Text([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}\0${v}`).join("\n"));

function requested(raw: readonly string[] | undefined, plan: RetirementPlan): RetireItem[] {
  if (!raw?.length) throw new RetireError("on 档要用 --items 逐项点名（PM 核过样本的项），不收未点名的项");
  const bad = raw.filter((i) => !isRetireItem(i));
  if (bad.length) throw new RetireError(`不认识的退出项：${bad.join(", ")}`);
  const items = [...new Set(raw as RetireItem[])];
  const refused: string[] = [];
  for (const item of items) {
    const p = plan.items.find((x) => x.item === item);
    if (!p || p.state !== "active") refused.push(`${item}(${p?.state ?? "missing"})`);
    else {
      // 阶段 1 的项在同一次点名里一起收（且它自己可收），对应的 phase_order 抵消；其他理由一条都不抵
      const left = p.reasons.filter((r) => !(r.code === "phase_order" && items.includes(r.subject as RetireItem)));
      if (left.length) refused.push(`${item}(${left.map((r) => r.subject ? `${r.code}:${r.subject}` : r.code).join(",")})`);
    }
  }
  if (refused.length) throw new RetireError(`拒绝执行，一个文件都不写：${refused.join("; ")}`);
  return items;
}

function execute(input: RetireInput, plan: RetirementPlan): Executed {
  const { io } = input;
  if (input.stateDir === undefined) throw new RetireError("on 档要给 --state <状态目录>，用来核身份与历史哈希（只读）");
  if (input.target === undefined) throw new RetireError("on 档要给 --target <空临时目录>");
  const list = parseAllowlist(input.allowlistText);
  const items = requested(input.items, plan);
  let stateReal: string;
  try { stateReal = io.realpath(input.stateDir); } catch { throw new RetireError("状态目录不存在"); }
  const target = checkTarget(input, stateReal);
  const before = protectedHashes(stateReal, list.retain, io);
  const next = retireItems(list, new Set(items), input.now);
  const files: [string, string][] = [
    ["compat-allowlist.json", JSON.stringify(next, null, 2) + "\n"],
    ["compat-allowlist.recovery.json", input.allowlistText],
    ["retirement-plan.json", JSON.stringify({ ...plan, retired: items, protectedBefore: digest(before) }, null, 2) + "\n"],
  ];
  const written = files.map(([name, text]) => { const p = join(target, name); io.writeNew(p, text); return p; });
  const after = protectedHashes(stateReal, list.retain, io);
  if (digest(after) !== digest(before)) throw new RetireError("受保护文件的哈希在执行前后不一致：停止，恢复包已在目标目录");
  return { retired: items, written, protectedFiles: before.size, protectedSha256: digest(before) };
}

export function runRetirement(input: RetireInput): RetireResult {
  const { gear, problems } = parseRetireGear(input.config);
  if (gear === "off") return { gear, problems };
  if (gear !== "on" && (input.target !== undefined || input.items !== undefined)) {
    throw new RetireError("--target / --items 只在 rename.retireCompat=on 时可用；observe 档零写入");
  }
  if (input.sampleText === null) throw new RetireError("要显式给 --sample <脱敏样本.json>；本工具不读生产统计");
  const list = parseAllowlist(input.allowlistText);
  const plan = buildPlan(parseSample(input.sampleText), list, input.allowlistText, gear, input.now);
  if (gear !== "on") return { gear, problems, plan };
  return { gear, problems, plan, executed: execute(input, plan) };
}
