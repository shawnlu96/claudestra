/**
 * 后台任务随会话重启被杀 → 给执行者发一条信息类提醒（BGW-1）。每 15s 增量读执行者主会话 jsonl，认出 CC 的
 * 「上一轮后台任务没跑完」通知就经 deliver 投给该 agent；忙就进押后队列（回合结束再投）。判据 / 去重 / 冷却在 lib/bg-killed.ts。
 * 自带定时器、不挂在 bg-activity-watcher 里：turn-probe 依赖 watcher，挂进去会成环。tests/bg-killed-notice.test.ts
 */
import type { ServerWebSocket } from "bun";
import { stat } from "fs/promises";
import { readCcSessionAgents } from "../lib/cc-session-agents.js";
import { projectJsonlPath } from "../lib/jsonl-cost.js";
import { newReadCursor, readCursor, type ReadCursor } from "../lib/jsonl-read-cursor.js";
import { agentMsgMustWait } from "../lib/turn-state.js";
import { BG_KILLED_FRESH_MS, bgKilledNoticeText, isExecutorAgent, KilledNoticeGate, parseKilledNotice } from "../lib/bg-killed.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";
import { probeTurn } from "./turn-probe.js";

const POLL_MS = 15_000;
/** 首次读一个会话文件只看尾部这么多：通知就在重启后头几行，不必从头扫几十 MB */
const TAIL_BYTES = 512_000;

interface Client { ws: ServerWebSocket<unknown>; channelId: string; cwd?: string }
export interface BgKilledAgent { name: string; channelId: string; cwd: string; sessionId: string }

export interface BgKilledDeps {
  clients: Map<string, Client>;
  deliver: (env: Envelope) => Promise<unknown>;
  hold: (env: Envelope) => void;
  lastMessageSource: { set(channelId: string, src: "agent"): unknown };
  /** 单测注入；不给 = registry 里的 Claude Code agent */
  agents?: () => Promise<BgKilledAgent[]>;
  /** 单测注入；不给 = 抓屏 + 事件态（bridge/turn-probe.ts） */
  busy?: (channelId: string, agent: string) => Promise<boolean>;
  now?: () => number;
  /** 单测注入；不给 = ~/.claude/projects 下的主会话 jsonl */
  jsonlPath?: (a: BgKilledAgent) => string;
}

/** 一轮：读新增记录 → 攒 taskId → 冷却过了就投。导出给单测；同一时刻只跑一轮 */
export function bgKilledTicker(d: BgKilledDeps): () => Promise<void> {
  const gate = new KilledNoticeGate();
  const cursors = new Map<string, ReadCursor>();
  const now = d.now ?? (() => Date.now());
  const busy = d.busy ?? (async (ch, agent) => agentMsgMustWait(await probeTurn(ch, agent, process.env.CONTROL_CHANNEL_ID || "")));
  const agentsOf = d.agents ?? readCcSessionAgents;
  const pathOf = d.jsonlPath ?? ((a: BgKilledAgent) => projectJsonlPath(a.cwd, a.sessionId));
  let running = false;

  async function scan(a: BgKilledAgent): Promise<void> {
    const path = pathOf(a);
    let cur = cursors.get(path);
    if (!cur) {
      const size = (await stat(path).catch(() => null))?.size; // 会话文件还没落盘：下轮再看
      if (size === undefined) return;
      cursors.set(path, (cur = newReadCursor(Math.max(0, size - TAIL_BYTES))));
    }
    const chunk = await readCursor(path, cur).catch((e) => {
      console.error(`🧵 后台被杀提醒：读会话失败 (${a.name}):`, String(e)); // 位置没动，下轮重读
      return null;
    });
    for (const { line } of chunk?.lines ?? []) {
      const n = parseKilledNotice(line);
      if (n && now() - n.ts <= BG_KILLED_FRESH_MS) gate.offer(a.name, n.ids);
    }
  }

  async function send(a: BgKilledAgent, ids: string[]): Promise<boolean> {
    const client = d.clients.get(a.channelId);
    if (!client) return false; // 会话刚重启、channel-server 还没连上：下轮再投
    const env: Envelope = {
      from: { kind: "bridge", label: "bg-killed" },
      to: { kind: "local", channelId: a.channelId, ws: client.ws, cwd: client.cwd, agentName: a.name },
      intent: "notification",
      content: bgKilledNoticeText(ids),
      meta: { messageId: newMessageId("bgkill"), triggerKind: "bridge_synth", ts: new Date(now()).toISOString(), threadId: newThreadId(), waitForIdle: true },
    };
    if (await busy(a.channelId, a.name)) {
      d.hold(env); // 正在干活：回合结束再投，不打断
    } else {
      d.lastMessageSource.set(a.channelId, "agent"); // 它处理完这条的 Stop 不去 @ owner
      const kind = ((await d.deliver(env)) as { outcome?: { kind?: string } } | undefined)?.outcome?.kind;
      if (kind !== "sent") return false;
    }
    console.log(`🧵 后台任务被杀提醒已发: ${a.name}（${ids.join(", ")}）`);
    return true;
  }

  return async () => {
    if (running) return;
    running = true;
    try {
      const agents = (await agentsOf()).filter((a) => isExecutorAgent(a.name));
      for (const a of agents) await scan(a);
      const live = new Set(agents.map(pathOf));
      for (const p of cursors.keys()) if (!live.has(p)) cursors.delete(p);
      for (const { agent, ids } of gate.due(now())) {
        const a = agents.find((x) => x.name === agent);
        if (a && (await send(a, ids).catch((e) => (console.error(`🧵 后台被杀提醒投递失败 (${agent}):`, String(e)), false)))) gate.done(agent, ids, now());
      }
    } finally {
      running = false;
    }
  };
}

let started = false;

/** bridge 启动时调一次 */
export function initBgKilledNotice(d: BgKilledDeps): void {
  if (started) return;
  started = true;
  const tick = bgKilledTicker(d);
  setInterval(() => void tick().catch((e) => console.error("🧵 后台被杀提醒一轮失败:", String(e))), POLL_MS).unref?.();
  console.log(`🧵 后台任务被杀提醒启动（每 ${POLL_MS / 1000}s 扫执行者会话）`);
}
