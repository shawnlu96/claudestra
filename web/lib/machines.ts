import { browserBackend } from "./floka-storage/browser";
import { browserStorage } from "./floka-storage/config";
import { writeCompatible } from "./floka-storage/local";

/**
 * 已配对机器清单（docs/design-hosted-frontend.md §5、§8.5）：IndexedDB 只存 `{fp, name, addedAt, lastUsedAt, principalId?}`，
 * **绝不存凭据**——凭据是 bridge 发的 HttpOnly cookie（Path=/m/<fp>/），JS 拿不到也不该拿。
 * 「当前机器」同时镜像到 IDB 的 meta 表（Service Worker 点通知时读）和 localStorage（public/boot.js 打点时读）。
 * 纯逻辑（upsert / 排序 / 选当前）与 MachineStore 用内存后端可测（tests/web-api-client.test.ts）。
 */
export interface MachineRecord {
  fp: string;
  name: string;
  addedAt: number;
  lastUsedAt: number;
  /** guest 配对时 bridge 回的 principalId（「哪条是我发的」按它认）；owner 设备不存，默认 owner:self */
  principalId?: string;
}
/** repair = 凭据被拒（401 device_invalid），要重新配对；机器记录保留，别把用户的机器列表删了 */
export type MachineHealth = "ok" | "repair";

export interface MachineRef {
  fp: string;
}

/** 某一刻的当前机器 + 代际（lib/machine-guard.ts captureMachine）；fp 为 null = 当时还没选机器 */
export interface MachineStamp {
  fp: string | null;
  gen: number;
}

export interface MachinesBackend {
  getAll(): Promise<MachineRecord[]>;
  put(rec: MachineRecord): Promise<void>;
  delete(fp: string): Promise<void>;
  /** 当前机器（fp + API 基址）——SW 读同一份 */
  getCurrent(): Promise<{ fp: string; base: string } | null>;
  setCurrent(cur: { fp: string; base: string } | null): Promise<void>;
}

export const DB_NAME = "cstra";
export const MACHINES_STORE = "machines";
export const META_STORE = "meta";
export const CURRENT_KEY = "current";
/** localStorage 镜像（public/boot.js 的 client-log 打点拼基址用；不是凭据） */
export const API_BASE_LS_KEY = "cstra_api_base";

export function upsertRecord(list: MachineRecord[], rec: MachineRecord): MachineRecord[] {
  const rest = list.filter((m) => m.fp !== rec.fp);
  return sortMachines([...rest, rec]);
}

/** 最近用过的在前；同时刻按名字，稳定 */
export function sortMachines(list: MachineRecord[]): MachineRecord[] {
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
}

/** 记住的当前机器还在就用它，否则最近用过的那台；没有机器 → null */
export function pickCurrent(list: MachineRecord[], savedFp: string | null): MachineRecord | null {
  return list.find((m) => m.fp === savedFp) ?? sortMachines(list)[0] ?? null;
}

export function memoryBackend(seed: MachineRecord[] = []): MachinesBackend {
  const map = new Map(seed.map((m) => [m.fp, m] as const));
  let current: { fp: string; base: string } | null = null;
  return {
    getAll: async () => [...map.values()],
    put: async (rec) => void map.set(rec.fp, rec),
    delete: async (fp) => void map.delete(fp),
    getCurrent: async () => current,
    setCurrent: async (cur) => void (current = cur),
  };
}

type SwitchListener = (prevFp: string | null, nextFp: string | null) => void;

export class MachineStore {
  private list: MachineRecord[] = [];
  private cur: MachineRecord | null = null;
  private health = new Map<string, MachineHealth>();
  private gen = 0;
  private subs = new Set<() => void>();
  private switchSubs = new Set<SwitchListener>();
  private loading: Promise<void> | null = null;
  /** 基址由 app-config 决定（lib/app-config.ts machineBase）；这里只保存算好的值，避免 machines → app-config 的依赖 */
  private baseOf: (fp: string) => string = () => "";

  constructor(private backend: MachinesBackend) {}

  setBaseResolver(fn: (fp: string) => string): void {
    this.baseOf = fn;
  }

  /** 从后端装入一次（幂等）；IDB 打不开（隐私模式等）就当空列表，页面仍可配对 */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const [all, saved] = await Promise.all([this.backend.getAll(), this.backend.getCurrent()]);
        this.list = sortMachines(all);
        this.cur = pickCurrent(this.list, saved?.fp ?? null);
      } catch (e) {
        console.warn("[machines] 读取机器列表失败，按空列表继续:", (e as Error).message);
      }
      this.emit();
    })();
    return this.loading;
  }

  all(): MachineRecord[] {
    return this.list;
  }
  current(): MachineRecord | null {
    return this.cur;
  }
  currentFp(): string | null {
    return this.cur?.fp ?? null;
  }
  healthOf(fp: string): MachineHealth {
    return this.health.get(fp) ?? "ok";
  }
  get(fp: string): MachineRecord | undefined {
    return this.list.find((m) => m.fp === fp);
  }

  async add(rec: Omit<MachineRecord, "addedAt" | "lastUsedAt"> & Partial<Pick<MachineRecord, "addedAt" | "lastUsedAt">>): Promise<MachineRecord> {
    const now = Date.now();
    const prev = this.get(rec.fp);
    const full: MachineRecord = { addedAt: prev?.addedAt ?? now, lastUsedAt: now, ...prev, ...rec };
    this.list = upsertRecord(this.list, full);
    this.health.delete(rec.fp); // 刚配对成功 = 凭据是新的
    await this.backend.put(full).catch((e) => console.warn("[machines] 写入失败:", (e as Error).message)); // 内存态已更新，本次会话照常用
    this.emit();
    return full;
  }

  async remove(fp: string): Promise<void> {
    this.list = this.list.filter((m) => m.fp !== fp);
    this.health.delete(fp);
    await this.backend.delete(fp).catch((e) => console.warn("[machines] 删除失败:", (e as Error).message)); // 同上，内存态为准
    if (this.cur?.fp === fp) await this.setCurrent(this.list[0]?.fp ?? null);
    else this.emit();
  }

  /**
   * 机器代际（lib/machine-guard.ts）：每次真正换机器同步 +1，只增不复用——A→B→A 后 A 第一次捕获的代际也不再有效。
   * 页面 / 请求捕获它，发请求前比对，切机持久化还没写完的窗口里旧页面的操作就发不到新机器上。
   */
  generation(): number {
    return this.gen;
  }

  /** 切机器：先换当前 + 代际 +1（旧代际立即失效），再通知（API 客户端中止旧机器的在途请求 / SSE），再持久化镜像；持久化失败不回滚代际 */
  async setCurrent(fp: string | null): Promise<void> {
    const next = fp ? this.get(fp) ?? null : null;
    const prevFp = this.cur?.fp ?? null;
    const changed = prevFp !== (next?.fp ?? null);
    if (changed) this.gen++;
    this.cur = next;
    if (changed) for (const f of this.switchSubs) f(prevFp, next?.fp ?? null);
    if (next) {
      next.lastUsedAt = Date.now();
      this.list = sortMachines(this.list);
      await this.backend.put(next).catch(() => undefined); // lastUsedAt 只是排序依据，写不进去无碍
    }
    const cur = next ? { fp: next.fp, base: this.baseOf(next.fp) } : null;
    await this.backend.setCurrent(cur).catch(() => undefined); // SW 读不到就退回 payload 里的 fp（sw.js）
    try {
      writeCompatible(browserStorage(), API_BASE_LS_KEY, cur?.base ?? null);
    } catch {
      /* 隐私模式没有 localStorage：boot.js 的打点会少基址，只影响排障日志 */
    }
    this.emit();
  }

  markRepair(fp: string): void {
    if (this.health.get(fp) === "repair") return;
    this.health.set(fp, "repair");
    this.emit();
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }
  onSwitch(cb: SwitchListener): () => void {
    this.switchSubs.add(cb);
    return () => void this.switchSubs.delete(cb);
  }
  private emit(): void {
    for (const f of this.subs) f();
  }
}

export const machines = new MachineStore(browserBackend() ?? memoryBackend());
