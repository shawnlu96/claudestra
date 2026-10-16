/**
 * CC 回合中途投递实测（JRT-3）：回合中到达的 channel 通知在「推理流 / 工具执行 / 回合尾」三个窗口丢不丢，
 * 以及 CC 原生「输入框排队」（回合中往输入框提交，Press up to edit queued messages）能不能当插队通道。
 *
 * 隔离：一次性临时目录 + 独立 tmux socket（CLAUDESTRA_RUNTIME_DIR 指过去，tmux-helper 的 TMUX_SOCK 跟着走，不碰线上 master.sock）、
 * --strict-mcp-config 只挂本脚本的假 channel 服务（不拉起线上 channel-server）、disableAllHooks（Stop 等 hook 不打到线上 bridge）。
 * 会真花模型额度（每个场景一两个小回合）。结论与版本号记在 docs/architecture/inbound-route.md。
 *
 *   bun scripts/cc-midturn-probe.ts [--model sonnet] [--effort high] [--only idle,reason,tool,tail,box-tool,box-reason,esc-queued] [--repeat 1] [--keep]
 *   bun scripts/cc-midturn-probe.ts serve <dir>     # 内部用：假 channel MCP 服务（CC 拉起）
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 假 channel 服务：轮询 <dir>/send/*.json，每个文件发一条 notifications/claude/channel ─────────────
async function serve(dir: string): Promise<void> {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const mcp = new Server({ name: "probe", version: "1.0.0" }, {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions: "Messages from this channel arrive as <channel source=\"probe\">. Follow the instruction inside each one.",
  });
  await mcp.connect(new StdioServerTransport());
  const box = join(dir, "send");
  mkdirSync(box, { recursive: true });
  for (;;) {
    for (const f of readdirSync(box).filter((n) => n.endsWith(".json")).sort()) {
      const { content, meta } = JSON.parse(readFileSync(join(box, f), "utf8")) as { content: string; meta: Record<string, string> };
      await mcp.notification({ method: "notifications/claude/channel", params: { content, meta } });
      renameSync(join(box, f), join(box, `${f}.sent`));
      appendFileSync(join(dir, "sent.log"), `${new Date().toISOString()} ${f}\n`);
    }
    await sleep(50);
  }
}

// ── 驱动 ──────────────────────────────────────────────────────────────────
export interface Rec { type?: string; operation?: string; timestamp?: string; content?: unknown; attachment?: unknown; message?: { role?: string; content?: unknown } }
type Tmux = (args: string[]) => Promise<string>;
interface Ctx { dir: string; sid: string; tmux: Tmux; busy: (pane: string) => boolean; seq: number }

const SESSION = "probe";
/** CC 的工作目录固定一个（首次要过信任框，之后不再问）；socket / 投递箱每次在一次性目录里 */
const WORK_DIR = join(tmpdir(), "cc-midturn-probe-work");
const pane = (c: Ctx) => c.tmux(["capture-pane", "-p", "-t", SESSION]);

function jsonlPath(sid: string): string | null {
  const root = join(homedir(), ".claude", "projects");
  for (const d of readdirSync(root)) if (existsSync(join(root, d, `${sid}.jsonl`))) return join(root, d, `${sid}.jsonl`);
  return null;
}
function records(sid: string): Rec[] {
  const p = jsonlPath(sid);
  if (!p) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l) as Rec;
    } catch {
      return {}; // 写到一半的最后一行：下一轮轮询再读到完整的
    }
  });
}
// 回合中途插进来的那条是 attachment（type queued_command），正文在 attachment.prompt
const text = (r: Rec): string => JSON.stringify(r.message?.content ?? r.content ?? r.attachment ?? "");
const isAssistant = (r: Rec) => r.type === "assistant";
const hasToolUse = (r: Rec) => isAssistant(r) && text(r).includes("\"tool_use\"");

async function waitFor<T>(what: string, ms: number, f: () => Promise<T | undefined | false> | T | undefined | false): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error(`等「${what}」超时（${ms / 1000}s）`);
    await sleep(200);
  }
}
async function waitIdle(c: Ctx, ms = 180_000): Promise<void> {
  let calm = 0; // 连续 3 帧不忙才算：回合刚开始几百毫秒 spinner 还没出来
  await waitFor("回合结束", ms, async () => ((calm = c.busy(await pane(c)) ? 0 : calm + 1) >= 3));
}
async function typeLine(c: Ctx, line: string): Promise<void> {
  await c.tmux(["send-keys", "-t", SESSION, "-l", line]);
  await sleep(300);
  await c.tmux(["send-keys", "-t", SESSION, "Enter"]);
}
function notify(c: Ctx, token: string): number {
  const body = `${token}: please reply with the single word ACK-${token} (this is a probe message).`;
  const f = join(c.dir, "send", `${String(++c.seq).padStart(4, "0")}.json`);
  writeFileSync(`${f}.tmp`, JSON.stringify({ content: body, meta: { user: "probe", message_id: token } }));
  renameSync(`${f}.tmp`, f);
  return Date.now();
}

interface Outcome {
  scenario: string; token: string; channel: "notify" | "inputbox";
  /** 投的那一刻原回合进行到哪：assistant 已有几条输出、在不在工具里 */
  at: string;
  /** 正文作为用户消息落进会话记录了没有 / 只有排队记录（enqueue）/ 完全没有 */
  landed: "user" | "enqueue-only" | "lost";
  /** 落进会话记录的位置：原回合结束（结束标记那条 assistant 文本）之前 = 插进了回合；之后 = 回合结束才浮出 */
  where: "mid-turn" | "after-turn" | "n/a";
  /** 模型有没有照正文回 ACK：插进回合时模型可能只顾手上的事不理它（落进记录 = 模型上下文里有它） */
  acked: boolean;
  queuedHint?: boolean;
}

/** 一段会话记录（投递之后的部分）→ 这条落没落、落在原回合结束前还是后、模型照没照做。纯函数，单测 tests/steer-cc-probe.test.ts（夹具是实测记录摘录） */
export function classifyRecords(rs: readonly Rec[], token: string, endMark: string | null): Pick<Outcome, "landed" | "where" | "acked"> {
  const userAt = rs.findIndex((r) => (r.type === "user" || r.type === "attachment") && text(r).includes(token));
  const enq = rs.some((r) => r.type === "queue-operation" && text(r).includes(token));
  const acked = rs.some((r) => isAssistant(r) && text(r).includes(`ACK-${token}`));
  const endAt = endMark ? rs.findIndex((r) => isAssistant(r) && text(r).includes(endMark)) : -1;
  const landed = userAt >= 0 ? "user" : enq ? "enqueue-only" : "lost";
  const where = userAt < 0 || endAt < 0 ? "n/a" : userAt < endAt ? "mid-turn" : "after-turn";
  return { landed, where, acked };
}
const classify = (c: Ctx, from: number, token: string, endMark: string | null) => classifyRecords(records(c.sid).slice(from), token, endMark);

async function settle(c: Ctx): Promise<void> {
  await waitIdle(c);
  await sleep(4_000); // 回合结束才浮出的那条会再开一轮
  await waitIdle(c);
}

type Deliver = (c: Ctx, token: string) => Promise<void>;
const viaNotify: Deliver = async (c, token) => void notify(c, token);
const viaBox: Deliver = async (c, token) => typeLine(c, `${token}: please reply with the single word ACK-${token} (this is a probe message).`);

/** 原回合：发 prompt → 等到 when 说可以投 → 投 → 等两轮都结束 → 判 */
async function scenario(
  c: Ctx, name: string, channel: Outcome["channel"], prompt: string, endMark: string | null, when: (rs: Rec[]) => string | false,
  after?: (c: Ctx, token: string) => Promise<Partial<Outcome>>,
): Promise<Outcome> {
  const token = `T${Date.now().toString(36).toUpperCase()}`;
  const from = records(c.sid).length;
  if (prompt) await typeLine(c, prompt);
  const at = await waitFor(`${name} 的投递时机`, 120_000, () => when(records(c.sid).slice(from)));
  await (channel === "notify" ? viaNotify : viaBox)(c, token);
  await sleep(1_500);
  const queuedHint = channel === "inputbox" ? /Press up to edit queued messages/.test(await pane(c)) : undefined;
  const extra = after ? await after(c, token) : {};
  await settle(c);
  return { scenario: name, token, channel, at, ...classify(c, from, token, endMark), ...(queuedHint === undefined ? {} : { queuedHint }), ...extra };
}

const REASON_PROMPT = "ultrathink. Without using any tools, reason carefully in your head before writing anything: count the lattice paths from (0,0) to (7,7) " +
  "using unit steps right/up that never go above the diagonal, then the number of domino tilings of a 4x6 board; double-check each by a second method. " +
  "Then reply with exactly: END-REASON <paths> <tilings>";
// 单独的 sleep 会被 CC 拦下（模型随后改成后台跑，回合就没有工具执行窗口了）：用 python 在前台睡
const TOOL_PROMPT = (mark: string) => `Run this exact bash command in the foreground (not in the background): python3 -c "import time; time.sleep(25); print('slept')" ` +
  `— then, after it prints slept, reply with exactly ${mark}`;

/** 推理流窗口：prompt 已落、assistant 还一条都没有，再等 1.5 秒（回合起始的思考流里） */
const inReasoning = (t0: { at?: number }) => (rs: Rec[]): string | false => {
  if (!rs.some((r) => r.type === "user")) return false;
  if (rs.some(isAssistant)) return false;
  t0.at ??= Date.now();
  return Date.now() - t0.at >= 1_500 ? "prompt 落盘 1.5s、assistant 尚无输出" : false;
};
/** 工具窗口：sleep 的 tool_use 已出、tool_result 还没回，再等 2 秒 */
const inTool = (t0: { at?: number }) => (rs: Rec[]): string | false => {
  const i = rs.findIndex(hasToolUse);
  if (i < 0 || rs.slice(i + 1).some((r) => r.type === "user" && text(r).includes("tool_result"))) return false;
  t0.at ??= Date.now();
  return Date.now() - t0.at >= 2_000 ? "Bash sleep 25 执行中" : false;
};

const SCENARIOS: Record<string, (c: Ctx) => Promise<Outcome>> = {
  idle: (c) => scenario(c, "idle", "notify", "", null, () => "空闲（对照：通道本身是通的）"),
  reason: (c) => scenario(c, "reason", "notify", REASON_PROMPT, "END-REASON", inReasoning({})),
  tool: (c) => scenario(c, "tool", "notify", TOOL_PROMPT("END-TOOL"), "END-TOOL", inTool({})),
  tail: (c) => scenario(c, "tail", "notify", "Reply with exactly END-TAIL and nothing else.", "END-TAIL",
    (rs) => (rs.some((r) => isAssistant(r) && text(r).includes("END-TAIL")) ? "最后一条 assistant 文本已落盘（回合尾）" : false)),
  "box-tool": (c) => scenario(c, "box-tool", "inputbox", TOOL_PROMPT("END-BOXTOOL"), "END-BOXTOOL", inTool({})),
  "box-reason": (c) => scenario(c, "box-reason", "inputbox", REASON_PROMPT, "END-REASON", inReasoning({})),
  // 插队排在 CC 自己队列里时 owner 按 Escape（bridge 抢占 / 叫停发的就是这个键）：这条被丢，还是叫停后 CC 自己接着投（2.1.302：接着投）。
  // 原回合被取消、没有 END 标记，所以 where 恒为 n/a；看 landed / acked
  "esc-queued": (c) => scenario(c, "esc-queued", "notify", REASON_PROMPT, null, inReasoning({}), async (cx) => {
    await cx.tmux(["send-keys", "-t", SESSION, "Escape"]);
    return {};
  }),
};

async function launch(c: Ctx, model: string, effort: string, bun: string): Promise<void> {
  const mcp = join(c.dir, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { probe: { command: bun, args: [import.meta.path, "serve", c.dir] } } }));
  const settings = JSON.stringify({ disableAllHooks: true });
  const cmd = `claude --dangerously-load-development-channels server:probe --mcp-config '${mcp}' --strict-mcp-config ` +
    `--settings '${settings}' --dangerously-skip-permissions --session-id ${c.sid} --model ${model} --effort ${effort}`;
  mkdirSync(WORK_DIR, { recursive: true });
  await c.tmux(["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "-c", WORK_DIR, cmd]);
  // 开发版 channel 的警告框要按一次 Enter；之后等输入框出来
  const pressed = { trust: false, dev: false }; // 每个框只按一次：多按的 Down 可能绕回「No, exit」
  await waitFor("CC 启动", 60_000, async () => {
    const p = await pane(c);
    // 信任框默认项是「No, exit」：先下移一格再确认（只信任固定的 WORK_DIR 这一个目录）
    if (/Yes, I trust this folder/.test(p) && !pressed.trust && (pressed.trust = true)) {
      await c.tmux(["send-keys", "-t", SESSION, "Down"]);
      await sleep(300);
      await c.tmux(["send-keys", "-t", SESSION, "Enter"]);
    }
    else if (/I am using this for local development/i.test(p) && /Enter to confirm/.test(p) && !pressed.dev && (pressed.dev = true)) await c.tmux(["send-keys", "-t", SESSION, "Enter"]);
    return /❯/.test(p) && /bypass permissions/i.test(p) && !/Enter to confirm/.test(p);
  }).catch(async (e: Error) => { throw new Error(`${e.message}\n${await pane(c)}`); });
  await sleep(3_000);
}

function parseArgs(argv: string[]): { model: string; effort: string; only: string[]; repeat: number; keep: boolean } {
  const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const only = (val("--only") ?? Object.keys(SCENARIOS).join(",")).split(",");
  return { model: val("--model") ?? "sonnet", effort: val("--effort") ?? "high", only, repeat: Number(val("--repeat") ?? 1), keep: argv.includes("--keep") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), "cc-midturn-probe-"));
  process.env.CLAUDESTRA_RUNTIME_DIR = dir; // 先设再 import：tmux-helper 的 TMUX_SOCK = <dir>/master.sock
  const { tmuxRaw } = await import("../src/lib/tmux-helper.ts");
  const { paneMainTurnBusy } = await import("../src/lib/turn-state.ts");
  const { resolveBunPath } = await import("../src/lib/bun-path.ts");
  const version = Bun.spawnSync(["claude", "--version"]).stdout.toString().trim();
  const c: Ctx = { dir, sid: crypto.randomUUID(), tmux: (a) => tmuxRaw(a, { timeoutMs: 10_000 }), busy: paneMainTurnBusy, seq: 0 };
  console.error(`CC ${version}，模型 ${args.model}，临时目录 ${dir}`);
  const out: Outcome[] = [];
  try {
    await launch(c, args.model, args.effort, resolveBunPath());
    for (let k = 0; k < args.repeat; k++) {
      for (const s of args.only) {
        const run = SCENARIOS[s];
        if (!run) throw new Error(`没有场景 ${s}（可选 ${Object.keys(SCENARIOS).join(" / ")}）`);
        const o = await run(c).catch((e: Error) => ({ scenario: s, error: e.message }) as unknown as Outcome);
        console.error(JSON.stringify(o));
        out.push(o);
      }
    }
  } finally {
    await c.tmux(["kill-server"]);
    writeFileSync(join(dir, "report.json"), JSON.stringify({ version, model: args.model, out }, null, 2));
    if (!args.keep) rmSync(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ version, model: args.model, sessionId: c.sid, out }, null, 2));
}

if (import.meta.main) await (process.argv[2] === "serve" ? serve(process.argv[3]!) : main());
