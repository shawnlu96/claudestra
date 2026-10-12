/**
 * 后台任务随会话重启被杀 → 给执行者发一条信息类提醒（BGW-1）。每 15s 增量读执行者主会话 jsonl，认出 CC 的
 * 「上一轮后台任务没跑完」通知就经 deliver 投给该 agent；忙就进押后队列（回合结束再投）。判据 / 去重 / 冷却在 lib/bg-killed.ts。
 * 首次挂上一个会话往回读满新鲜窗口（lib/bg-killed-scan.ts）；去重 / 冷却落盘，bridge 重启不重发同一 taskId。
 * 自带定时器、不挂在 bg-activity-watcher 里：turn-probe 依赖 watcher，挂进去会成环。tests/bg-killed-notice.test.ts
 */
import type { ServerWebSocket } from "bun";
import { join } from "path";
import { readCcSessionAgents } from "../lib/cc-session-agents.js";
import { projectJsonlPath } from "../lib/jsonl-cost.js";
import { newReadCursor, readCursor, type ReadCursor } from "../lib/jsonl-read-cursor.js";
import { agentMsgMustWait } from "../lib/turn-state.js";
import { BG_KILLED_FRESH_MS, bgKilledNoticeText, isExecutorAgent, isKilledNoticeState, KilledNoticeGate, parseKilledNotice } from "../lib/bg-killed.js";
import { readRecentLines } from "../lib/bg-killed-scan.js";
import { STATE_DIR } from "../lib/paths.js";
import { readJsonState, writeJsonAtomic } from "../lib/state-file.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";
import { probeTurn } from "./turn-probe.js";

const POLL_MS = 15_000;

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
  /** 单测注入；不给 = 状态目录下的 bg-killed-notices.json（已提醒的 taskId + 冷却起点） */
  statePath?: string;
}

/** 一轮：读新增记录 → 攒 taskId → 冷却过了就投。导出给单测；同一时刻只跑一轮 */
export function bgKilledTicker(d: BgKilledDeps): () => Promise<void> {
  const statePath = d.statePath ?? join(STATE_DIR, "bg-killed-notices.json");
  let gate: KilledNoticeGate | null = null;
  const cursors = new Map<string, ReadCursor>();
  const now = d.now ?? (() => Date.now());
  const busy = d.busy ?? (async (ch, agent) => agentMsgMustWait(await probeTurn(ch, agent, process.env.CONTROL_CHANNEL_ID || "")));
  const agentsOf = d.agents ?? readCcSessionAgents;
  const pathOf = d.jsonlPath ?? ((a: BgKilledAgent) => projectJsonlPath(a.cwd, a.sessionId));
  let running = false;

  async function loadGate(): Promise<KilledNoticeGate> {
    const r = await readJsonState(statePath, isKilledNoticeState);
    if (r.status === "corrupt") console.error(`🧵 后台被杀提醒：状态文件坏了，按空的来（${statePath}）:`, r.error);
    return new KilledNoticeGate(undefined, r.status === "ok" && isKilledNoticeState(r.data) ? r.data : undefined);
  }

  /** 首次挂上：往回读满新鲜窗口，之后从最后一个完整行接着增量读 */
  async function firstLines(path: string): Promise<string[] | null> {
    const r = await readRecentLines(path, now() - BG_KILLED_FRESH_MS).catch(() => null); // 会话文件还没落盘 / 读不了：下轮再看
    if (!r) return null;
    cursors.set(path, newReadCursor(r.end));
    return r.lines;
  }

  async function scan(g: KilledNoticeGate, a: BgKilledAgent): Promise<void> {
    const path = pathOf(a);
    const cur = cursors.get(path);
    const lines = cur
      ? (await readCursor(path, cur).catch((e) => {
          console.error(`🧵 后台被杀提醒：读会话失败 (${a.name}):`, String(e)); // 位置没动，下轮重读
          return null;
        }))?.lines.map((l) => l.line)
      : await firstLines(path);
    for (const line of lines ?? []) {
      const n = parseKilledNotice(line);
      if (n && now() - n.ts <= BG_KILLED_FRESH_MS) g.offer(a.name, n.ids);
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
      const g = (gate ??= await loadGate());
      const agents = (await agentsOf()).filter((a) => isExecutorAgent(a.name));
      for (const a of agents) await scan(g, a);
      const live = new Set(agents.map(pathOf));
      for (const p of cursors.keys()) if (!live.has(p)) cursors.delete(p);
      for (const { agent, ids } of g.due(now())) {
        const a = agents.find((x) => x.name === agent);
        if (!a || !(await send(a, ids).catch((e) => (console.error(`🧵 后台被杀提醒投递失败 (${agent}):`, String(e)), false)))) continue;
        g.done(agent, ids, now());
        // 落盘失败只影响「bridge 重启后会不会再提醒一次」，不影响这次投递：记日志不抛
        await writeJsonAtomic(statePath, g.snapshot(now())).catch((e) => console.error("🧵 后台被杀提醒：状态落盘失败:", String(e)));
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
