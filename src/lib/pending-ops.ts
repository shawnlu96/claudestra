/**
 * 做到一半的 manager 操作：registry 条目上的 `pending` 标记 + 残留判定（纯函数，tests/pending-ops.test.ts）。
 *
 * create / kill / rename 动手前先在条目上写 pending（与 registry 同一次原子写），做完才清。进程被
 * kill -9 时标记留在原地，再跑同一条命令或 `manager repair` 据此补完。「残留」= 写标记的进程已死，
 * 或标记超过 PENDING_STALE_MS（防 pid 复用）；持有者还活着 = 另一次操作正在进行，一律不碰。
 */

export type PendingOp =
  | {
      op: "create"; pid: number; startedAt: string; channelName: string;
      /** 建频道后立刻写回；没有 = 砍在「建频道」与「写回」之间，频道只报不删（不按名字猜） */
      channelId?: string;
      /** 建窗口后立刻写回 tmux 窗口 id：残留清理只按 id 关，不按名字杀到别人的同名窗口 */
      windowId?: string;
      /** 同名旧条目（kill 过的 agent）：create 失败时原样恢复，不抹掉它的历史 */
      prev?: Record<string, unknown>;
    }
  | { op: "kill"; pid: number; startedAt: string; /** 已置 stopped 但还欠的步骤（bridge 不在时） */ left?: string[] }
  | { op: "rename"; pid: number; startedAt: string; from: string };

/** create 就绪预算 120s + shell 15s；10 分钟还没清的标记不可能属于一次正常操作 */
export const PENDING_STALE_MS = 10 * 60_000;

export function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 活着但不是我们的进程
  }
}

export function isPendingLive(p: { pid: number; startedAt: string }, now: number, alive: (pid: number) => boolean): boolean {
  const t = Date.parse(p.startedAt);
  if (!(p.pid > 0) || !Number.isFinite(t) || now - t > PENDING_STALE_MS) return false; // pid 0 = 已置 stopped 的欠账，永不算在途
  return alive(p.pid);
}

/**
 * restart / resume 能不能碰这个条目：在途的一律不碰；残留的 kill 可以（重新拉起 = kill 的意图作废，调用方清标记）；
 * 残留的 create / rename 不行——窗口 / 频道还挂在标记上，拉起来会多出第二个会话或丢掉线索。
 */
export function pendingRefusal(p: PendingOp | undefined, verb: string, now: number, alive: (pid: number) => boolean): string | null {
  if (!p) return null;
  if (isPendingLive(p, now, alive)) return `${verb} 不了：正在 ${p.op}（pid ${p.pid}），等它结束再试`;
  return p.op === "kill" ? null : `有做到一半的 ${p.op}，先跑 manager repair --apply 收尾再 ${verb}`;
}

export function newPending<T extends PendingOp["op"]>(op: T, extra: Omit<Extract<PendingOp, { op: T }>, "op" | "pid" | "startedAt">, now = Date.now()): Extract<PendingOp, { op: T }> {
  return { op, pid: process.pid, startedAt: new Date(now).toISOString(), ...extra } as Extract<PendingOp, { op: T }>;
}

export function isLocalChannel(id: string | undefined): boolean {
  return !id || id.startsWith("local-");
}

/** Discord 的「频道已不存在」——删频道时视同已删 */
export function isUnknownChannelError(msg: string): boolean {
  return /Unknown Channel|10003/i.test(msg);
}

export type Residue =
  | { kind: "stale-create"; agent: string; channelId?: string; channelName: string }
  | { kind: "stale-kill"; agent: string }
  | { kind: "stale-rename"; agent: string; from: string }
  | { kind: "busy"; agent: string; op: PendingOp["op"]; pid: number }
  | { kind: "orphan-window"; agent: string; registered: boolean }
  | { kind: "orphan-channel"; agent: string; channelId: string };

export interface ScanInput {
  agents: Record<string, { status?: string; channelId?: string; pending?: PendingOp }>;
  /** master session 里的 agent-* 窗口；null = 列不出来（窗口类、频道类检查都跳过，宁可漏报不误删） */
  windows: string[] | null;
  /** 平台上还存在的频道 id；null = 查不到（bridge 不在），跳过孤儿频道 */
  channels: Set<string> | null;
  now: number;
  alive: (pid: number) => boolean;
}

/**
 * 找出四类残留。只认 registry 里有据可查的东西：没登记的窗口只报不修（registered:false），
 * 没登记的频道完全不看（按名字猜会误删 owner 手工建的同名频道）。
 */
export function scanResidues(inp: ScanInput): Residue[] {
  const out: Residue[] = [];
  const handled = new Set<string>();
  const liveChannelOwners = new Set<string>();
  for (const [name, a] of Object.entries(inp.agents)) {
    if (a.status === "active" && a.channelId) liveChannelOwners.add(a.channelId);
    const p = a.pending;
    if (!p) continue;
    handled.add(name);
    if (p.op === "rename") handled.add(p.from); // 窗口可能还是旧名：属于这次 rename，不另报未登记窗口
    if (isPendingLive(p, inp.now, inp.alive)) {
      out.push({ kind: "busy", agent: name, op: p.op, pid: p.pid });
      if (p.op === "create" && p.channelId) liveChannelOwners.add(p.channelId);
    } else if (p.op === "create") out.push({ kind: "stale-create", agent: name, channelId: p.channelId, channelName: p.channelName });
    else if (p.op === "kill") out.push({ kind: "stale-kill", agent: name });
    else out.push({ kind: "stale-rename", agent: name, from: p.from });
  }
  for (const w of inp.windows ?? []) {
    if (handled.has(w)) continue;
    const a = inp.agents[w];
    if (!a) out.push({ kind: "orphan-window", agent: w, registered: false });
    else if (a.status === "stopped") out.push({ kind: "orphan-window", agent: w, registered: true });
  }
  if (inp.channels && inp.windows) {
    for (const [name, a] of Object.entries(inp.agents)) {
      // 窗口还在 = agent 可能正在用（registry 漏写 active），它的频道不算孤儿
      if (handled.has(name) || a.status !== "stopped" || isLocalChannel(a.channelId) || inp.windows.includes(name)) continue;
      if (inp.channels.has(a.channelId!) && !liveChannelOwners.has(a.channelId!)) {
        out.push({ kind: "orphan-channel", agent: name, channelId: a.channelId! });
      }
    }
  }
  return out;
}

/** 给人看的一行描述（doctor detail / repair 计划共用） */
export function describeResidue(r: Residue): string {
  switch (r.kind) {
    case "stale-create": return `${r.agent}：create 做到一半（${r.channelId ? `频道 ${r.channelId}` : `没记到频道 id，名为 #${r.channelName} 的频道要人工核对`}）`;
    case "stale-kill": return `${r.agent}：kill 做到一半`;
    case "stale-rename": return `${r.agent}：rename（从 ${r.from}）做到一半，频道 / 台账可能还是旧名`;
    case "busy": return `${r.agent}：${r.op} 正在进行（pid ${r.pid}）`;
    case "orphan-window": return r.registered ? `${r.agent}：registry 是 stopped，窗口却还在（只剩 shell 才会被 repair 关掉）` : `${r.agent}：窗口没登记在 registry`;
    case "orphan-channel": return `${r.agent}：已 stopped，频道 ${r.channelId} 还在`;
  }
}

/** repair --apply 会不会自动处理它（其余只报） */
export function isAutoRepairable(r: Residue): boolean {
  return r.kind !== "busy" && !(r.kind === "orphan-window" && !r.registered);
}
