/**
 * 项目组「协作视图」选源：每台机器读一份 bridge `/shared-ledger/context`（本人有读凭据的绑定），
 * 已绑定的本机项目改开中心视图（key 与侧栏 N5 列表同字节），未绑定 / 个人项目照旧走本机台账。
 * 只按 `(localProjectId ?? project) === 本机项目 id` 匹配，不看名字 / git / 目录。
 */
import { api, ApiError } from "./api/client";
import { machines } from "./machines";
import type { Identity } from "./api/shared-ledger";
import { sharedCollabProject } from "@/features/collab/team-source-key";

export interface ContextIdentity { center: string; team: string; person: string; project: string; localProjectId?: string; homeInstanceId: string }
export type BlockedReason = "ambiguous" | "checking" | "revoked";
export type CollabSourceChoice =
  | { kind: "local" }
  | { kind: "center"; identity: Identity; key: string }
  | { kind: "blocked"; reason: BlockedReason };

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** 缺字段的条目丢掉：没有完整身份就拼不出中心 key，也不能授权任何共享请求 */
export function parseContext(body: unknown): ContextIdentity[] {
  const list = (body as { identities?: unknown } | null)?.identities;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v: Record<string, unknown> | null) => {
    if (!v || ![v.center, v.team, v.person, v.project, v.homeInstanceId].every(str)) return [];
    return [{ center: v.center as string, team: v.team as string, person: v.person as string, project: v.project as string,
      homeInstanceId: v.homeInstanceId as string, ...(str(v.localProjectId) ? { localProjectId: v.localProjectId } : {}) }];
  });
}

/**
 * identities = null 表示这台机器的 context 从没读成功过（checking）。
 * 同一中心 projectId 出现在多条绑定里：bridge 只凭 projectId 头选绑定会 409，按 ambiguous 停用（同 shared-projects-bindings.ts）。
 */
export function resolveCollabSource(identities: readonly ContextIdentity[] | null, localProjectId: string, machine: string,
  revoked: (key: string) => boolean = () => false, lost: string | null = null): CollabSourceChoice {
  if (!identities) return { kind: "blocked", reason: "checking" };
  const bound = identities.filter((i) => (i.localProjectId ?? i.project) === localProjectId);
  // 身份从 context 里消失（bridge 只列仍有读凭据的）而之前的中心 key 已确认 403：仍按撤权停用，不回退本机
  if (!bound.length) return lost && revoked(lost) ? { kind: "blocked", reason: "revoked" } : { kind: "local" };
  const [b] = bound;
  if (bound.length > 1 || identities.filter((i) => i.project === b!.project).length > 1) return { kind: "blocked", reason: "ambiguous" };
  const identity: Identity = { machine, center: b!.center, team: b!.team, project: b!.project, person: b!.person, homeInstanceId: b!.homeInstanceId };
  const key = sharedCollabProject(identity);
  return revoked(key) ? { kind: "blocked", reason: "revoked" } : { kind: "center", identity, key };
}

/** settled = 至少回过一轮（成功或失败）；第一轮回来前入口先不出现，免得每个项目组闪一下「正在核对」 */
export interface BindingState { fp: string; identities: ContextIdentity[] | null; settled: boolean }
export type ContextRequest = (fp: string, signal: AbortSignal) => Promise<unknown>;
export const REFRESH_MS = 15_000;

const defaultRequest: ContextRequest = (fp, signal) => api("/shared-ledger/context", { signal }, { fp });
/** 401/403/404：这台设备没有 / 读不了共享绑定 → 按未绑定走本机 */
const unbound = (e: unknown) => e instanceof ApiError && [401, 403, 404].includes(e.status);

/** 每个本机项目当前能打开的中心 key（ambiguous 的不算） */
function centerKeys(identities: readonly ContextIdentity[] | null, fp: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of identities ?? []) {
    const lp = i.localProjectId ?? i.project, r = resolveCollabSource(identities, lp, fp);
    if (r.kind === "center") out.set(lp, r.key);
  }
  return out;
}

interface Store {
  state: BindingState;
  /** 这台机器上出现过的中心 key；不在当前 context 里的 = 过期（改绑 / 解绑 / 停用），打开着就得关 */
  seen: Set<string>;
  stale: Set<string>;
  /** 本机项目 → 身份消失前最后的中心 key（判断「撤权后身份被移除」用）；再次绑定或 context 401/403/404 时清掉 */
  lost: Map<string, string>;
  subs: Set<() => void>;
  seq: number;
  inflight: AbortController | null;
  readAt: number;
  stop: (() => void) | null;
}
const stores = new Map<string, Store>();
let request: ContextRequest = defaultRequest;

/** 测试 / 合成 harness 换请求端口；同时清空所有机器的缓存 */
export function setContextRequestForTest(next: ContextRequest | null): void {
  for (const s of stores.values()) s.stop?.();
  stores.clear();
  request = next ?? defaultRequest;
}

function storeOf(fp: string): Store {
  let s = stores.get(fp);
  if (!s) stores.set(fp, (s = { state: { fp, identities: null, settled: false }, seen: new Set(), stale: new Set(), lost: new Map(), subs: new Set(), seq: 0, inflight: null, readAt: 0, stop: null }));
  return s;
}

/** 过期 key 与撤权记忆在 store 里算，不随可折叠的入口组件卸载而丢 */
function publish(s: Store, identities: ContextIdentity[] | null, forget = false) {
  const fp = s.state.fp, prev = centerKeys(s.state.identities, fp), next = centerKeys(identities, fp);
  for (const k of prev.values()) s.seen.add(k);
  for (const k of next.values()) s.seen.add(k);
  const live = new Set(next.values());
  s.stale = new Set([...s.seen].filter((k) => !live.has(k)));
  if (forget) s.lost.clear();
  else if (identities) {
    for (const [lp, key] of prev) if (!identities.some((i) => (i.localProjectId ?? i.project) === lp)) s.lost.set(lp, key);
    for (const i of identities) s.lost.delete(i.localProjectId ?? i.project);
  }
  s.state = { fp, identities, settled: true };
  for (const cb of s.subs) cb();
}

/** 单飞：在途时不再发；回包按序号 + 当前机器核对，晚到的（换过机器 / 已被新一轮取代）一律丢弃 */
export function refreshBindings(fp: string): Promise<void> {
  const s = storeOf(fp);
  if (s.inflight) return Promise.resolve();
  const seq = ++s.seq, ctrl = new AbortController();
  s.inflight = ctrl;
  const fresh = () => seq === s.seq && machines.currentFp() === fp;
  return request(fp, ctrl.signal).then(
    (body) => { if (fresh()) { s.readAt = Date.now(); publish(s, parseContext(body)); } },
    (e) => {
      if (!fresh()) return;
      if (unbound(e)) { s.readAt = Date.now(); return publish(s, [], true); }
      // 5xx / 网络错：成功过就保留上次解析结果，没成功过保持 checking，等下一轮
      console.warn(`[collab] 读共享绑定失败（${fp}）：${(e as Error).message}`);
      if (!s.state.settled) publish(s, null);
    },
  ).finally(() => { if (s.inflight === ctrl) s.inflight = null; });
}

/** 有订阅者时 15s 一轮 + 回到页面立即重读；最后一个订阅者走了就停表并作废在途请求 */
export function subscribeBindings(fp: string, cb: () => void): () => void {
  const s = storeOf(fp);
  s.subs.add(cb);
  if (s.subs.size === 1) {
    const tick = () => void refreshBindings(fp);
    const timer = setInterval(tick, REFRESH_MS);
    const win = (globalThis as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void });
    win.addEventListener?.("focus", tick);
    s.stop = () => {
      clearInterval(timer);
      win.removeEventListener?.("focus", tick);
      s.seq++;
      s.inflight?.abort();
      s.inflight = null;
      s.stop = null;
    };
    if (!s.readAt || Date.now() - s.readAt >= REFRESH_MS) tick();
  }
  return () => {
    s.subs.delete(cb);
    if (!s.subs.size) s.stop?.();
  };
}

export const bindingState = (fp: string): BindingState => storeOf(fp).state;
/** 这台机器上已经不再对应任何当前绑定的中心 key */
export const staleCenterKeys = (fp: string): ReadonlySet<string> => storeOf(fp).stale;
/** 本机项目的身份已从 context 消失时，消失前最后的中心 key */
export const lostCenterKey = (fp: string, localProjectId: string): string | null => storeOf(fp).lost.get(localProjectId) ?? null;
