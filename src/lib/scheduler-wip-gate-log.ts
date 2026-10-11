/**
 * WIP 闸的观察记录（dispatch-recovery-WIPGATE1）：深度 ≥ 阈值时写专用日志 logs/wip-gate.out（每行一条 JSON：时间、项目、卡号、入口、深度、阈值、档位），
 * 可直接按卡号 grep。同项目同卡跨入口统一去重，滚动 60 分钟最多一条：最近一次写成的时间落状态目录（state-file.ts 原子读写），重启照样去重；
 * 只有调度服务（持调度租约）写，串行无竞争。日志没写成不算记过、也不拦开卡；去重状态写坏最多多记一条。
 * 测试经 setWipGateIo 注入日志路径、状态路径与时钟，不碰生产状态。
 */
import { appendLogLine, logPath } from "./log-paths.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

export interface WipGateIo { logPath(): string; statePath(): string; now(): number }
export interface WipGateRecord { project: string; task: string; entry: string; depth: number; threshold: number; mode: string }

export const WIP_GATE_WINDOW_MS = 60 * 60_000;
const DEFAULT_IO: WipGateIo = { logPath: () => logPath("wip-gate", "out"), statePath: () => statePath("scheduler-wip-gate.json"), now: () => Date.now() };
let io = DEFAULT_IO;

/** 测试注入；传 null 复原 */
export function setWipGateIo(next: Partial<WipGateIo> | null): void {
  io = next ? { ...DEFAULT_IO, ...next } : DEFAULT_IO;
}

const recent = (now: number, at: unknown): at is number => typeof at === "number" && now - at >= 0 && now - at < WIP_GATE_WINDOW_MS;

/** 记一条（窗口内已有同项目同卡的记录就不记）；返回这次是否写成 */
export function wipGateObserve(r: WipGateRecord): boolean {
  const now = io.now(), path = io.statePath(), key = `${r.project}/${r.task}`;
  const read = readJsonStateSync(path);
  const seen = read.status === "ok" && read.data && typeof read.data === "object" && !Array.isArray(read.data) ? read.data as Record<string, unknown> : {};
  if (recent(now, seen[key])) return false;
  if (!appendLogLine(io.logPath(), JSON.stringify({ at: new Date(now).toISOString(), ...r }))) return false;
  const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => recent(now, at)));
  try { writeJsonAtomicSync(path, { ...kept, [key]: now }); } catch { /* 去重状态没写上：下次最多多记一条 */ }
  return true;
}
