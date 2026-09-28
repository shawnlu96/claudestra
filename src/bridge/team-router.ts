/**
 * 编排班子的事件路由（docs/team/orchestration-team.md）：每 TICK_MS 看一眼台账，游标之后的新事件交给 lib/team-route.ts 定收件人，
 * 以 bridge_synth 通知投给调度助理 / PM / 执行者。对台账只读（独立的 LedgerReader 只读连接），写台账仍只有 CLI。
 *
 * 只通知一次：游标（最后处理到的事件 seq）落盘在 CURSOR_PATH，先推进游标、再投递——崩溃窗口里最多漏一条（T29 巡检兜），
 * 不会在 bridge 重启后重发。首次运行没有游标就从当前最大 seq 起，库被换成更短的一份也从头起算最大 seq，历史不补发。
 * 不抢占：目标在回合中 / 压缩中 / 不在线就进押后队列（落盘，回合结束或连上后再投），和 agent→agent 消息同一条路。
 * 硬规则（P0、第 3 轮不通过）：用 runManager 调 `ledger escalate --auto` 由 CLI 记账（dedup 按 review 的 seq），PM 下一轮经 escalate 收到。
 */
import type { ServerWebSocket } from "bun";
import { LedgerReader } from "../lib/ledger-read.js";
import { getMeta, getTask, listEvents } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { readJsonStateSync, writeJsonAtomicSync } from "../lib/state-file.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { autoEscalations, routeEvents, type AutoEscalation, type RouteNotice } from "../lib/team-route.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";
import { newThreadId, type Envelope } from "./router.js";

const TICK_MS = 2000;
const CURSOR_PATH = statePath("team-router.json");

interface Client {
  ws: ServerWebSocket<unknown>;
  cwd?: string;
}

export interface TeamRouterDeps {
  clients: Map<string, Client>;
  deliver(env: Envelope): Promise<unknown>;
  /** 进押后队列（落盘） */
  hold(env: Envelope): void;
  /** 目标此刻在回合中 / 压缩中：agent→agent 消息同一判定 */
  working(channelId: string, agentName: string): Promise<boolean>;
  /** 标记「这条是 bridge 发的」：回合结束不去 @ 用户 */
  markBridgeSource?(channelId: string): void;
}

export interface TickerDeps {
  reader: LedgerReader;
  cursorPath: string;
  /** registry 键 → 频道；找不到 = 不在 registry（已删 / 拼错） */
  channelOf(agent: string): string | null;
  send(n: RouteNotice, channelId: string): Promise<void>;
  /** 记一条硬规则升级（CLI 写台账）；失败返回原因 */
  escalate(a: AutoEscalation): Promise<string | null>;
  log(msg: string): void;
}

function readCursor(path: string): number | null {
  const r = readJsonStateSync(path);
  if (r.status !== "ok") return null;
  const seq = (r.data as { seq?: unknown } | null)?.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : null;
}

const maxSeq = (db: NonNullable<ReturnType<LedgerReader["get"]>>): number =>
  (db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number }).m;

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
      let cursor = readCursor(d.cursorPath);
      if (cursor === null || cursor > top) {
        if (cursor !== null) d.log(`📮 班子路由：台账库比游标短（${top} < ${cursor}），从当前位置起算，不补发`);
        writeJsonAtomicSync(d.cursorPath, { seq: top });
        cursor = top;
      }
      if (top === cursor) return;
      const batch = listEvents(db, { afterSeq: cursor });
      const ctx = {
        task: (id: string) => getTask(db, id),
        team: (project: string) => {
          const m = getMeta(db, project);
          return { pms: m.pms, team: m.team };
        },
        managerCmd: `bun ${MANAGER_PATH}`,
      };
      const notices = routeEvents(batch, ctx);
      const escalations = autoEscalations(batch, ctx);
      writeJsonAtomicSync(d.cursorPath, { seq: batch.at(-1)?.seq ?? cursor });
      for (const a of escalations) {
        const why = await d.escalate(a);
        d.log(why ? `⚠️ 班子路由：${a.taskId} 的硬规则升级没记上（${why}），由巡检兜底` : `📮 ${a.taskId} 硬规则升级：${a.reason.split("；")[0]}`);
      }
      for (const n of notices) {
        const ch = d.channelOf(n.to);
        if (!ch) d.log(`⚠️ 班子路由：${n.to} 不在 registry，${n.taskId || "项目级"} 的 ${n.kind} 通知（seq ${n.seq}）没投`);
        else await d.send(n, ch);
      }
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
    meta: { messageId: n.messageId, triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId() },
  };
}

/** 真实投递：在线且空闲就直接投，否则进押后队列 */
function makeSender(deps: TeamRouterDeps, log: (m: string) => void): (n: RouteNotice, channelId: string) => Promise<void> {
  return async (n, channelId) => {
    const client = deps.clients.get(channelId);
    const env = envelopeOf(n, channelId, client);
    deps.markBridgeSource?.(channelId);
    if (!client || (await deps.working(channelId, n.to))) {
      deps.hold(env);
      log(`📮 ${n.taskId || "项目级"} ${n.kind} → ${n.to}：${client ? "回合中" : "不在线"}，进押后队列`);
      return;
    }
    await deps.deliver(env);
    log(`📮 ${n.taskId || "项目级"} ${n.kind} → ${n.to}`);
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** bridge 启动时调一次（幂等） */
export function initTeamRouter(deps: TeamRouterDeps): void {
  if (timer) return;
  const log = (m: string) => console.log(m);
  const tick = teamRouterTicker({
    reader: new LedgerReader(),
    cursorPath: CURSOR_PATH,
    channelOf: (agent) => readRegistryAgentsSync().find((a) => a.name === agent && a.status === "active")?.channelId ?? null,
    send: makeSender(deps, log),
    escalate: async (a) => {
      const args = ["ledger", "escalate", a.taskId, "--reason", a.reason, "--auto", "--dedup", a.dedup];
      const r = await runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV_WITH_BUN, timeoutMs: 30_000 }).catch((e: Error) => ({ ok: false, error: e.message }));
      return r && r.ok !== false ? null : String(r?.error ?? "无输出");
    },
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
