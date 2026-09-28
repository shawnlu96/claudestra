/**
 * 编排班子的事件路由（docs 10-ledger「附：编排班子」）：每 TICK_MS 看一眼台账，游标之后的新事件交给 lib/team-route.ts 定收件人，
 * 以 bridge_synth 通知投给调度助理 / PM / 执行者。对台账只读（独立的 LedgerReader 只读连接），写台账仍只有 CLI。
 *
 * 至多一次：游标（最后处理到的 seq + 台账文件标识）落盘在 CURSOR_PATH，先推进游标、再投递，bridge 重启不重发。
 * 代价：写完游标、投完这一批之前进程崩溃，这一批没投的就丢了（日志里有游标位置；补救见 10-ledger 附录）。
 * 单条投递失败不连累同批：失败 / 没送到的进押后队列（messageId 稳定），逐条记日志。
 * 首次运行没有游标、库比游标短、或台账换了一份文件（恢复备份、备机接管）：从当前最大 seq 起，历史不补发。
 * 不抢占：目标在回合中 / 压缩中 / 不在线就进押后队列（落盘，回合结束或连上后再投），和 agent→agent 消息同一条路；
 * 消息来源（回合结束 @ 不 @ owner）只在真正送达时才标。
 */
import type { ServerWebSocket } from "bun";
import { LedgerReader } from "../lib/ledger-read.js";
import { getMeta, getTask, listEvents } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { specPolicyOf } from "../lib/task-spec.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { readJsonStateSync, writeJsonAtomicSync } from "../lib/state-file.js";
import { routeEvents, type RouteNotice } from "../lib/team-route.js";
import { MANAGER_PATH } from "./config.js";
import { onHeldDelivered } from "./held-flush.js";
import { newThreadId, type Delivery, type Envelope } from "./router.js";

const TICK_MS = 2000;
const CURSOR_PATH = statePath("team-router.json");

interface Client {
  ws: ServerWebSocket<unknown>;
  cwd?: string;
}

export interface TeamRouterDeps {
  clients: Map<string, Client>;
  deliver(env: Envelope): Promise<Delivery>;
  /** 进押后队列（落盘） */
  hold(env: Envelope): void;
  /** 目标此刻在回合中 / 压缩中：agent→agent 消息同一判定 */
  working(channelId: string, agentName: string): Promise<boolean>;
  /** 标记「这条是 bridge 发的」：回合结束不去 @ 用户；只在真正送达时调 */
  markBridgeSource?(channelId: string): void;
}

/** 班子通知的信封特征：押后队列送达时据此标「bridge 发的」（回合中押后靠 envelopeOf 的 waitForIdle） */
function isLedgerNotice(env: Envelope): boolean {
  return env.from.kind === "bridge" && env.from.label === "ledger";
}

export interface TickerDeps {
  reader: LedgerReader;
  cursorPath: string;
  /** registry 键 → 频道；找不到 = 不在 registry（已删 / 拼错） */
  channelOf(agent: string): string | null;
  /** 投一条；返回给日志看的结果。抛错只影响这一条 */
  send(n: RouteNotice, channelId: string): Promise<string>;
  log(msg: string): void;
}

interface Cursor {
  seq: number;
  /** 台账文件标识（dev:ino）；老游标没有 */
  file: string | null;
}

function readCursor(path: string): Cursor | null {
  const r = readJsonStateSync(path);
  if (r.status !== "ok") return null;
  const c = r.data as { seq?: unknown; file?: unknown } | null;
  if (typeof c?.seq !== "number" || !Number.isInteger(c.seq) || c.seq < 0) return null;
  return { seq: c.seq, file: typeof c.file === "string" ? c.file : null };
}

const maxSeq = (db: NonNullable<ReturnType<LedgerReader["get"]>>): number =>
  (db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number }).m;

/** 游标能不能接着用；不能就说明原因（从当前最大 seq 起算） */
function staleReason(c: Cursor | null, top: number, file: string | null): string | null {
  if (!c) return "没有游标";
  if (c.seq > top) return `台账库比游标短（${top} < ${c.seq}）`;
  if (c.file && file && c.file !== file) return "台账换了一份文件（恢复备份 / 备机接管）";
  return null;
}

async function sendAll(d: TickerDeps, notices: RouteNotice[]): Promise<void> {
  for (const n of notices) {
    const what = `${n.taskId || "项目级"} ${n.kind} → ${n.to}（seq ${n.seq}）`;
    const ch = d.channelOf(n.to);
    if (!ch) {
      d.log(`⚠️ 班子路由：${n.to} 不在 registry，${what} 没投`);
      continue;
    }
    try {
      d.log(`📮 ${what}：${await d.send(n, ch)}`);
    } catch (e) {
      d.log(`⚠️ 班子路由：${what}投递出错，这一条没投：${(e as Error).message}`);
    }
  }
}

/**
 * 一次轮询：data_version 没变就不查；变了按游标取新事件、定收件人、先写游标再投递。
 * 游标文件损坏按「没有游标」处理（从当前最大 seq 起），并打一行日志——宁可漏，不重发整段历史。
 */
export function teamRouterTicker(d: TickerDeps): () => Promise<void> {
  let dv: number | null = null;
  let gen = -1;
  let failing = false;
  return async () => {
    try {
      const db = d.reader.get();
      if (!db) return;
      if (d.reader.generation !== gen) {
        gen = d.reader.generation;
        dv = null;
      }
      const v = (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
      if (v === dv) return;
      dv = v;
      const top = maxSeq(db);
      const file = d.reader.file;
      const saved = readCursor(d.cursorPath);
      const stale = staleReason(saved, top, file);
      if (stale) {
        if (saved) d.log(`📮 班子路由：${stale}，从当前位置 ${top} 起算，不补发`);
        writeJsonAtomicSync(d.cursorPath, { seq: top, file });
      }
      const cursor = stale ? top : (saved as Cursor).seq;
      if (top === cursor) return;
      const batch = listEvents(db, { afterSeq: cursor });
      const notices = routeEvents(batch, {
        task: (id) => getTask(db, id),
        team: (project) => {
          const m = getMeta(db, project);
          return { pms: m.pms, team: m.team };
        },
        events: (id) => listEvents(db, { target: id }),
        policy: (t) => specPolicyOf(t, getMeta(db, t.project).docsDir),
        managerCmd: `bun ${MANAGER_PATH}`,
        warn: (m) => d.log(`⚠️ 班子路由：${m}`),
      });
      writeJsonAtomicSync(d.cursorPath, { seq: batch.at(-1)?.seq ?? cursor, file });
      await sendAll(d, notices);
      if (failing) d.log("📮 班子路由恢复");
      failing = false;
    } catch (e) {
      if (!failing) d.log(`⚠️ 班子路由出错（恢复前不再重复报）: ${(e as Error).message}`);
      failing = true;
      d.reader.close();
      dv = null;
    }
  };
}

function envelopeOf(n: RouteNotice, channelId: string, client: Client | undefined): Envelope {
  return {
    from: { kind: "bridge", label: "ledger" },
    // 不在线时没有可用的 ws：押后队列落盘本来就剥掉 ws、投递时换最新连接（同 pushBackToCaller）
    to: { kind: "local", agentName: n.to, channelId, ws: client?.ws as ServerWebSocket<unknown>, cwd: client?.cwd },
    intent: "notification",
    content: n.text,
    // waitForIdle：目标主回合在跑就押到 Stop、永不抢占（bridge.ts deliverToLocal 判忙）；不带的话回合开头投进去会被静默丢掉
    meta: { messageId: n.messageId, triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId(), waitForIdle: true },
  };
}

/**
 * 真实投递：在线且空闲就直接投，否则进押后队列。deliver 报错、丢弃或抛错也进押后队列（下次 Stop / 扫描再投）；
 * deliver 自己押回（queued）的由押后队列送达时再标来源。
 */
export function makeSender(deps: TeamRouterDeps): (n: RouteNotice, channelId: string) => Promise<string> {
  return async (n, channelId) => {
    const client = deps.clients.get(channelId);
    const env = envelopeOf(n, channelId, client);
    if (!client || (await deps.working(channelId, n.to))) {
      deps.hold(env);
      return `${client ? "回合中" : "不在线"}，进押后队列`;
    }
    const r = await deps.deliver(env).catch((e: Error): Delivery => ({ envelope: env, outcome: { kind: "error", error: e } }));
    if (r.outcome.kind === "sent") {
      if (r.outcome.note === "queued") return "目标刚进回合，deliver 已押后";
      deps.markBridgeSource?.(channelId);
      return "已送达";
    }
    deps.hold(env);
    return `没送到（${r.outcome.kind === "error" ? r.outcome.error.message : r.outcome.reason}），进押后队列`;
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** bridge 启动时调一次（幂等） */
export function initTeamRouter(deps: TeamRouterDeps): void {
  if (timer) return;
  const log = (m: string) => console.log(m);
  onHeldDelivered((channelId, env) => {
    if (isLedgerNotice(env)) deps.markBridgeSource?.(channelId);
  });
  const tick = teamRouterTicker({
    reader: new LedgerReader(),
    cursorPath: CURSOR_PATH,
    channelOf: (agent) => readRegistryAgentsSync().find((a) => a.name === agent && a.status === "active")?.channelId ?? null,
    send: makeSender(deps),
    log,
  });
  let running = false;
  timer = setInterval(() => {
    if (running) return; // 上一轮还在投（await working 探测）：跳过，别并发读同一段游标
    running = true;
    void tick().finally(() => (running = false));
  }, TICK_MS);
  timer.unref?.();
}
