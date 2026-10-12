/**
 * 本机 Codex 的共享槽位（agents-PMJOB1）：ask_codex（bridge 进程）和 PM 处理员（worker 进程）合计不超过 CODEX_SLOT_MAX。
 * 两个入口不在一个进程里，计数放在 statePath("codex-slots.json")，读-改-写在 file-lock 里。每个槽位记 pid 和到期时间：
 * 持有进程死了或过了期就回收，崩溃不会把槽位永久占住。锁拿不到 / 文件损坏 = 拿不到槽位（不放行），调用方稍后再试。
 */
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

export const CODEX_SLOT_MAX = 3;
/** 一轮 codex 最长 12 分钟（lib/codex.ts CODEX_TIMEOUT_MS），留出收尾 */
const CODEX_SLOT_TTL_MS = 15 * 60_000;

export interface CodexSlot { id: string; owner: string; pid: number; until: number }
export interface CodexSlotDeps { path: string; now(): number; alive(pid: number): boolean; max: number; pid: number }
export interface CodexSlotHandle { id: string; release(): Promise<void> }

/** 进程还在不在：ESRCH = 没了；没权限发信号（EPERM）说明它在 */
function pidAlive(pid: number): boolean {
  try { return process.kill(pid, 0), true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

const live = (): CodexSlotDeps => ({ path: statePath("codex-slots.json"), now: Date.now, alive: pidAlive, max: CODEX_SLOT_MAX, pid: process.pid });
const validSlots = (v: unknown): boolean => Array.isArray(v) && v.every((s) => !!s && typeof s === "object" && typeof (s as CodexSlot).id === "string"
  && typeof (s as CodexSlot).owner === "string" && Number.isInteger((s as CodexSlot).pid) && Number.isFinite((s as CodexSlot).until));

async function edit<T>(d: CodexSlotDeps, fn: (held: CodexSlot[]) => { slots: CodexSlot[]; out: T } | null): Promise<T | null> {
  const lock = await acquireLock(`${d.path}.lock`, 5_000, 30_000);
  if (!lock) return null;
  try {
    const r = readJsonStateSync(d.path, validSlots);
    if (r.status === "corrupt") return null;
    const now = d.now(), held = (r.status === "ok" ? r.data as CodexSlot[] : []).filter((s) => s.until > now && d.alive(s.pid));
    const next = fn(held);
    if (!next) return null;
    writeJsonAtomicSync(d.path, next.slots);
    return next.out;
  } finally { lock.release(); }
}

/** 还占着的槽位（过期 / 持有者已死的不算） */
export async function codexSlotsHeld(deps: Partial<CodexSlotDeps> = {}): Promise<CodexSlot[] | null> {
  const d = { ...live(), ...deps };
  return edit(d, (held) => ({ slots: held, out: held }));
}

/** 拿一个槽位；满了 / 状态读写不了 = null */
export async function acquireCodexSlot(owner: string, deps: Partial<CodexSlotDeps> = {}, ttlMs = CODEX_SLOT_TTL_MS): Promise<CodexSlotHandle | null> {
  const d = { ...live(), ...deps }, id = `${owner}.${d.pid}.${d.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  const got = await edit(d, (held) => held.length >= d.max ? null : { slots: [...held, { id, owner, pid: d.pid, until: d.now() + ttlMs }], out: id });
  if (!got) return null;
  let released = false;
  return { id, release: async () => {
    if (released) return;
    released = true;
    await edit(d, (held) => ({ slots: held.filter((s) => s.id !== id), out: true }));
  } };
}

/** 占一个槽位跑 fn；满了不跑，返回 { ran: false }（bridge 的 ask_codex 入口用它替换进程内计数） */
export async function withCodexSlot<T>(owner: string, fn: () => Promise<T>, deps: Partial<CodexSlotDeps> = {}): Promise<{ ran: true; value: T } | { ran: false }> {
  const slot = await acquireCodexSlot(owner, deps);
  if (!slot) return { ran: false };
  try { return { ran: true, value: await fn() }; } finally { await slot.release().catch(() => { /* 归还没写上：到期 / 进程退出后自动回收 */ }); }
}
