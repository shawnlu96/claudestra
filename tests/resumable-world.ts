/**
 * resumable-ops 测试用的内存世界：registry / tmux 窗口 / 平台频道 / bridge 欠账都在内存里，
 * 任一副作用做完之后可以「砍掉进程」（抛 Crash），模拟 kill -9 落在那一步之后。
 */
import type { OpsDeps } from "../src/manager/ops-deps";
import type { Registry } from "../src/manager/core";

export class Crash extends Error {}

export interface WorldState {
  reg: Registry;
  windows: string[];
  channels: Set<string>;
  bridgeUp: boolean;
  cleanups: string[];
  archived: string[];
  ledgerRenames: string[];
  channelNames: Map<string, string>;
  /** 里面还有进程在跑的窗口（repair 不许关） */
  busyWindows: string[];
}

export function makeWorld(init: Partial<WorldState> = {}) {
  const st: WorldState = {
    reg: { socket: "s", agents: {} },
    windows: [],
    channels: new Set(),
    bridgeUp: true,
    cleanups: [],
    archived: [],
    ledgerRenames: [],
    channelNames: new Map(),
    busyWindows: [],
    ...structuredClone(init),
  };
  /** 进程被砍之后，它后面的任何副作用都不会发生：所有假件一律抛 Crash（被调用方 catch 吞掉也无妨） */
  let dead = false;
  /** 「新进程」接手时时钟跳过 PENDING_STALE_MS：旧标记变残留，新写的标记是新鲜的（同一个测试进程 pid 不变） */
  let clock = Date.parse("2026-09-28T12:00:00Z");
  let crashAt: string | null = null;
  const trace: string[] = [];
  const counts = new Map<string, number>();
  const hit = (label: string) => {
    const n = (counts.get(label) ?? 0) + 1;
    counts.set(label, n);
    const key = `${label}#${n}`;
    trace.push(key);
    if (crashAt === key) {
      crashAt = null;
      dead = true;
      throw new Crash(key);
    }
  };
  const live = () => { if (dead) throw new Crash("dead"); };
  let nextChannel = 1;
  const deps: OpsDeps = {
    loadRegistry: async () => { live(); return structuredClone(st.reg); },
    saveRegistry: async (r) => { live(); st.reg = structuredClone(r); hit("save"); },
    listWindows: async () => { live(); return [...st.windows]; },
    killWindow: async (n) => { live(); st.windows = st.windows.filter((w) => w !== n); hit("killWindow"); },
    windowIsBareShell: async (n) => { live(); return !st.busyWindows.includes(n); },
    renameWindow: async (a, b) => { live(); st.windows = st.windows.map((w) => (w === a ? b : w)); hit("renameWindow"); },
    deleteChannel: async (id) => {
      live();
      if (!st.bridgeUp) return { error: "Bridge 请求超时 (10s)" };
      const had = st.channels.delete(id);
      hit("deleteChannel");
      return had ? "ok" : "gone";
    },
    renameChannel: async (id, name) => {
      live();
      if (!st.bridgeUp) return { error: "Bridge 请求超时 (10s)" };
      if (!st.channels.has(id)) return "gone";
      st.channelNames.set(id, name);
      hit("renameChannel");
      return "ok";
    },
    listChannels: async () => (st.bridgeUp ? new Set(st.channels) : null),
    agentCleanup: async (id) => { live(); st.cleanups.push(id); hit("agentCleanup"); return st.bridgeUp; },
    archive: async (a) => { live(); st.archived.push(a); hit("archive"); },
    rescan: async () => { live(); hit("rescan"); },
    renameLedger: async (a, b) => { live(); st.ledgerRenames.push(`${a}>${b}`); hit("renameLedger"); },
    now: () => clock,
    alive: () => true,
  };
  return {
    st,
    deps,
    trace,
    /** 在第 n 次 label 之后砍（key 形如 "save#2"） */
    crashAfter(key: string) { crashAt = key; },
    /** 新进程接手：pid 判活恢复（新 pending 属于新进程） */
    restart() { dead = false; clock += 11 * 60_000; counts.clear(); trace.length = 0; },
    /** 模拟 create 里「建频道」这一步（bridge 的 create_channel） */
    createChannel(name: string): string {
      live();
      const id = `ch${nextChannel++}`;
      st.channels.add(id);
      st.channelNames.set(id, name);
      hit("createChannel");
      return id;
    },
    openWindow(name: string) { live(); st.windows.push(name); hit("openWindow"); },
  };
}

/** 比较终态时去掉时间戳 / pid 这类每次都不同的字段 */
export function normalize(st: WorldState) {
  const agents = Object.fromEntries(Object.entries(st.reg.agents).map(([k, v]) => {
    const { created: _c, ...rest } = v as unknown as Record<string, unknown>;
    return [k, rest];
  }));
  return { agents, windows: [...st.windows].sort(), channels: [...st.channels].sort() };
}
