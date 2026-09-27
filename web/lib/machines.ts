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

/** 根 tsconfig 无 dom lib（tests/ 直接编译本文件）：IndexedDB 只按用到的成员做结构声明，从 globalThis 取 */
interface IdbRequest<T = unknown> {
  result: T;
  error: { message?: string } | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface IdbStore {
  getAll(): IdbRequest<MachineRecord[]>;
  get(key: string): IdbRequest<unknown>;
  put(value: unknown, key?: string): IdbRequest;
  delete(key: string): IdbRequest;
}
interface IdbDatabase {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, opts?: { keyPath: string }): unknown;
  transaction(name: string, mode: "readonly" | "readwrite"): { objectStore(name: string): IdbStore };
}
interface IdbFactory {
  open(name: string, version: number): IdbRequest<IdbDatabase> & { onupgradeneeded: (() => void) | null };
}
const idb = (globalThis as unknown as { indexedDB?: IdbFactory }).indexedDB;

function openDb(): Promise<IdbDatabase> {
  return new Promise((resolve, reject) => {
    if (!idb) return reject(new Error("indexedDB unavailable"));
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MACHINES_STORE)) db.createObjectStore(MACHINES_STORE, { keyPath: "fp" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(req.error?.message ?? "indexedDB open failed"));
  });
}

function tx<T>(store: string, mode: "readonly" | "readwrite", run: (s: IdbStore) => IdbRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error(req.error?.message ?? `indexedDB ${store} ${mode} failed`));
      }),
  );
}

function idbBackend(): MachinesBackend {
  return {
    getAll: () => tx<MachineRecord[]>(MACHINES_STORE, "readonly", (s) => s.getAll()),
    put: (rec) => tx(MACHINES_STORE, "readwrite", (s) => s.put(rec)).then(() => undefined),
    delete: (fp) => tx(MACHINES_STORE, "readwrite", (s) => s.delete(fp)).then(() => undefined),
    getCurrent: () => tx(META_STORE, "readonly", (s) => s.get(CURRENT_KEY)).then((v) => (v as { fp: string; base: string } | undefined) ?? null),
    setCurrent: (cur) =>
      (cur ? tx(META_STORE, "readwrite", (s) => s.put(cur, CURRENT_KEY)) : tx(META_STORE, "readwrite", (s) => s.delete(CURRENT_KEY))).then(() => undefined),
  };
}

type SwitchListener = (prevFp: string | null, nextFp: string | null) => void;

export class MachineStore {
  private list: MachineRecord[] = [];
  private cur: MachineRecord | null = null;
  private health = new Map<string, MachineHealth>();
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

  /** 切机器：先通知（API 客户端中止旧机器的在途请求 / SSE），再换当前，再持久化镜像 */
  async setCurrent(fp: string | null): Promise<void> {
    const next = fp ? this.get(fp) ?? null : null;
    const prevFp = this.cur?.fp ?? null;
    if (prevFp !== (next?.fp ?? null)) for (const f of this.switchSubs) f(prevFp, next?.fp ?? null);
    this.cur = next;
    if (next) {
      next.lastUsedAt = Date.now();
      this.list = sortMachines(this.list);
      await this.backend.put(next).catch(() => undefined); // lastUsedAt 只是排序依据，写不进去无碍
    }
    const cur = next ? { fp: next.fp, base: this.baseOf(next.fp) } : null;
    await this.backend.setCurrent(cur).catch(() => undefined); // SW 读不到就退回 payload 里的 fp（sw.js）
    try {
      if (cur) localStorage.setItem(API_BASE_LS_KEY, cur.base);
      else localStorage.removeItem(API_BASE_LS_KEY);
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

export const machines = new MachineStore(idb ? idbBackend() : memoryBackend());
