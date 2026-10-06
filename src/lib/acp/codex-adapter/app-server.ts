/**
 * codex app-server 的传输层：起进程（独立进程组）、app-server 方言的 JSON-RPC、initialize 握手、带 schema 校验和时限的调用、
 * 通知按 USED 分 L / C / O 三类交给上层、反向请求注册（没注册的回 -32601）、退出事件。
 * 只管线路和校验：坏消息怎么处置（让回合失败还是作废连接，I10）由上层按 cls 和 corr 决定。tests/codex-adapter-transport.test.ts。
 */
import type { z } from "zod";
import { type AdapterProc, spawnAdapter } from "../adapter-proc.js";
import { createRpcPeer, type RpcWire } from "../rpc.js";
import { type ClientMethod, type NotificationMethod, type ParamsOf, type ResultOf, type ServerMethod, type ServerParamsOf, type ServerResultOf, USED } from "./protocol.js";

/** app-server 回的东西过不了我们的入站 schema（调用的回包） */
export class ProtocolError extends Error {
  constructor(
    readonly method: string,
    readonly problem: string,
    readonly raw: unknown,
  ) {
    super(`app-server 发来不合格的 ${method}：${problem}`);
    this.name = "ProtocolError";
  }
}

/** 校验之前先松散读出的关联字段：校验失败时上层靠它判断能不能归到某个回合 */
interface Corr {
  threadId?: string;
  turnId?: string;
}
type Cls = "L" | "C";
/** 入站消息：过了校验带类型化的 params，没过带原因和原始内容 */
type Checked<P> = { ok: true; params: P; corr: Corr } | { ok: false; problem: string; raw: unknown; corr: Corr };
type Params<M extends NotificationMethod> = z.infer<(typeof USED.notifications)[M]["params"]["schema"]>;
/** item/* 的 item 在信封合格后已按成员 schema 校验过（itemEvent），类型跟着收窄 */
type ItemParams<M extends NotificationMethod> = M extends "item/started" | "item/completed" ? Omit<Params<M>, "item"> & { item: z.infer<typeof ITEM> } : Params<M>;
export type NotificationEvent = { [M in NotificationMethod]: { method: M; cls: Cls } & Checked<ItemParams<M>> }[NotificationMethod];

export interface AppServerOpts {
  log?: (msg: string) => void;
  /** 握手后发不发 `initialized`（缺省发，D-d） */
  sendInitialized?: boolean;
  /** 覆盖 USED 里的缺省时限（单测注入短值） */
  timeouts?: Partial<Record<ClientMethod, number>>;
}

export interface AppServer {
  initialize(clientInfo: { name: string; version: string; title?: string }): Promise<ResultOf<"initialize">>;
  /**
   * 出站参数按严格 schema 校验（我们自己构造错了当场抛，不发出去），回包按入站 schema 校验，不合格的以 ProtocolError 失败。
   * onResult 在回包到达时同步调用（处理下一行之前），只在校验通过时调。
   */
  call<M extends ClientMethod>(method: M, params: ParamsOf<M>, opts?: { timeoutMs?: number; onResult?: (r: ResultOf<M>) => void }): Promise<ResultOf<M>>;
  onNotification(cb: (ev: NotificationEvent) => void): void;
  /** 反向请求：处理器的返回值按严格 schema 校验后才回出去，不合格的回 -32603 */
  handle<M extends ServerMethod>(method: M, fn: (req: Checked<ServerParamsOf<M>>) => ServerResultOf<M> | Promise<ServerResultOf<M>>): void;
  /** 连接没了（进程退出 / 线路作废）：在途调用已经全部失败 */
  onExit(cb: (why: string) => void): void;
  /** O 类（不认识的通知、开放联合里不认识的成员）各自被忽略了几次 */
  ignored(): Record<string, number>;
  readonly closed: boolean;
}

function corrOf(p: unknown): Corr {
  const o = (p && typeof p === "object" ? p : {}) as Record<string, any>;
  const threadId = typeof o.threadId === "string" ? o.threadId : undefined;
  const turnId = typeof o.turnId === "string" ? o.turnId : typeof o.turn?.id === "string" ? o.turn.id : undefined;
  return { ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
}

const problemOf = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`).join("；");

function check<S extends z.ZodType>(schema: S, raw: unknown): Checked<z.infer<S>> {
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, params: r.data, corr: corrOf(raw) } : { ok: false, problem: problemOf(r.error), raw, corr: corrOf(raw) };
}

const ITEM = USED.extraInbound["v2/ThreadItem"];
const ITEM_TYPES = new Set<string>(ITEM.options.map((o) => o.shape.type.value));
const LIFECYCLE_ITEMS = new Set<string>(USED.lifecycleItems);

export function createAppServer(wire: RpcWire, opts: AppServerOpts = {}): AppServer {
  const log = opts.log ?? (() => {});
  const ignoredCounts: Record<string, number> = {};
  /** O 类：计数，每种只告警一次 */
  const ignore = (kind: string) => {
    ignoredCounts[kind] = (ignoredCounts[kind] ?? 0) + 1;
    if (ignoredCounts[kind] === 1) log(`codex app-server: 忽略不认识的 ${kind}（之后同类只计数）`);
  };
  const rpc = createRpcPeer(wire, { log, dialect: "app-server", onUnhandledNotification: (m) => ignore(`通知 ${m}`) });
  const listeners: ((ev: NotificationEvent) => void)[] = [];
  const emit = (ev: NotificationEvent) => listeners.forEach((cb) => cb(ev));

  /** item/* 事件：类别按松散读出的 item.type 定；信封合格后不认识的 type 归 O 类，认识的再按成员 schema 校验 */
  const itemEvent = (method: NotificationMethod, raw: any): NotificationEvent | null => {
    const type = typeof raw?.item?.type === "string" ? (raw.item.type as string) : undefined;
    const cls: Cls = type !== undefined && LIFECYCLE_ITEMS.has(type) ? "L" : "C";
    const env = check(USED.notifications[method].params.schema, raw);
    if (!env.ok) return { method, cls, ...env } as NotificationEvent;
    if (!ITEM_TYPES.has(type!)) {
      ignore(`item 类型 ${type}`);
      return null;
    }
    const item = check(ITEM, raw.item);
    const body = item.ok ? { ok: true as const, params: { ...env.params, item: item.params }, corr: env.corr } : { ...item, problem: `item：${item.problem}`, raw, corr: env.corr };
    return { method, cls, ...body } as NotificationEvent;
  };

  for (const method of Object.keys(USED.notifications) as NotificationMethod[]) {
    const entry = USED.notifications[method];
    rpc.onNotification(method, (raw) => {
      const ev = method === "item/started" || method === "item/completed" ? itemEvent(method, raw) : ({ method, cls: entry.cls, ...check(entry.params.schema, raw) } as NotificationEvent);
      if (ev) emit(ev);
    });
  }

  const call: AppServer["call"] = (method, params, copts) => {
    const entry = USED.client[method];
    const out = entry.params.schema.parse(params);
    let checked: Checked<any> | undefined;
    const timeoutMs = copts?.timeoutMs ?? opts.timeouts?.[method] ?? entry.timeoutMs;
    const onResult = (raw: unknown) => {
      checked = check(entry.result.schema, raw);
      if (checked.ok) copts?.onResult?.(checked.params);
    };
    return rpc.request(method, out, { timeoutMs, onResult }).then((raw) => {
      if (!checked?.ok) throw new ProtocolError(method, checked?.problem ?? "回包没经过校验", raw);
      return checked.params;
    });
  };

  return {
    async initialize(clientInfo) {
      const r = await call("initialize", { clientInfo, capabilities: { experimentalApi: true, requestAttestation: false } });
      if (opts.sendInitialized ?? true) rpc.notify("initialized");
      return r;
    },
    call,
    onNotification: (cb) => void listeners.push(cb),
    handle(method, fn) {
      const entry = USED.server[method];
      rpc.onRequest(method, async (raw) => {
        const result = await fn(check(entry.params.schema, raw) as Checked<any>);
        const r = entry.result.schema.safeParse(result);
        if (r.success) return r.data;
        log(`codex app-server: ${method} 的回包不合 schema（${problemOf(r.error)}），改回错误`);
        throw new Error(`${method} 的回包不合 schema`);
      });
    },
    onExit: (cb) => rpc.onClosed(cb),
    ignored: () => ({ ...ignoredCounts }),
    get closed() {
      return rpc.closed;
    },
  };
}

/** 起 `<codexPath> app-server`：独立进程组（收尾时整组清理），stdio 接成 app-server 方言的连接 */
export function spawnAppServer(spec: { codexPath: string; env: Record<string, string>; cwd: string; log: (msg: string) => void } & AppServerOpts): AppServer & { proc: AdapterProc } {
  const proc = spawnAdapter([spec.codexPath, "app-server"], spec.env, spec.cwd, spec.log, "codex-app-server", { detached: true });
  return Object.assign(createAppServer(proc.wire, spec), { proc });
}
