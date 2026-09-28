/**
 * 批量管理的发键执行器：一个 agent 一个动作，每一步发完都重抓画面复核，结果归成 已执行 / 已排队 / 已跳过 / 失败。
 * 发键只经注入的 PaneIO（生产实现在 io.ts，全走 tmux-helper），判态全在 lib/lp-state.ts；这里只排步骤。
 * 安全边界：输入框里有别人没发的草稿就不动；额度菜单只在高亮项精确等于允许文案时才按回车；
 * Esc 只在确认有回合在跑时才按（空闲时按两下会弹 Rewind）。用例见 tests/fleet-runner.test.ts。
 */
import { ccOnly, compactCommand, type FleetAction, type FleetResult } from "../../lib/fleet-plan.js";
import { decideLp, lastLpEcho, LP_MENU_LABEL, menuKeysTo, readLpPane, selectedLabel, stripAnsi, type LpRead } from "../../lib/lp-state.js";

type PaneKey = "Enter" | "Up" | "Down" | "C-u";
export interface PaneIO {
  /** capture-pane -p -e */
  capture(win: string): Promise<string>;
  /** 打字 + 回车（生产实现是 tmuxSendLine，带 copy-mode 守卫） */
  sendLine(win: string, text: string): Promise<void>;
  press(win: string, key: PaneKey): Promise<void>;
  /** 走 tmuxSendEscape（带双击护栏） */
  escape(win: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type TextOutcome = { ok: true; queued: boolean } | { ok: false; error: string };
export interface RunCtx {
  io: PaneIO;
  keep: string;
  deliverText: (agent: string, text: string) => Promise<TextOutcome>;
}

type Step = Omit<FleetResult, "agent">;
const done = (detail: string): Step => ({ outcome: "done", detail });
const failed = (detail: string): Step => ({ outcome: "failed", detail });

const POLL_MS = 400;

async function read(io: PaneIO, win: string): Promise<{ raw: string; r: LpRead }> {
  const raw = await io.capture(win);
  return { raw, r: readLpPane(raw) };
}

/** 等到 pred 成立，最多 ms 毫秒；返回最后一次读到的画面 */
async function waitFor(io: PaneIO, win: string, ms: number, pred: (x: { raw: string; r: LpRead }) => boolean) {
  let x = await read(io, win);
  for (let t = 0; !pred(x) && t < ms; t += POLL_MS) {
    await io.sleep(POLL_MS);
    x = await read(io, win);
  }
  return { ...x, ok: pred(x) };
}

/** 额度菜单里走到「Continue now at lower priority」：只有高亮项精确等于它才回车，否则 Esc 退出报失败 */
async function pickLpInMenu(io: PaneIO, win: string, r: LpRead): Promise<Step | null> {
  const keys = r.menu ? menuKeysTo(r.menu, LP_MENU_LABEL) : null;
  if (keys) for (const k of keys) {
    await io.press(win, k);
    await io.sleep(250);
  }
  const now = await read(io, win);
  if (!keys || selectedLabel(now.r.menu) !== LP_MENU_LABEL) {
    await io.escape(win);
    return failed(`菜单高亮项不是「${LP_MENU_LABEL}」（是「${selectedLabel(now.r.menu) ?? "?"}」），已 Esc 退出，没选任何项`);
  }
  await io.press(win, "Enter");
  return null;
}

/** 「设成开 / 设成关」：先判态，已是目标态不发；发完等状态栏变过来 */
async function setLp(io: PaneIO, win: string, want: "on" | "off"): Promise<Step> {
  const { r } = await read(io, win);
  const d = decideLp(want, r);
  if (d.kind === "skip") return { outcome: "skipped", detail: d.reason };
  if (d.kind === "busy" || d.kind === "refuse") return failed(d.reason);
  if (d.kind === "escape-fail") {
    await io.escape(win);
    return failed(`${d.reason}，已 Esc 退出菜单`);
  }
  if (d.via === "menu") {
    const bad = await pickLpInMenu(io, win, r);
    if (bad) return bad;
  } else {
    await io.sendLine(win, "/low-priority");
  }
  const end = await waitFor(io, win, 8000, (x) => x.r.lowPriority === want || badEcho(x.raw) !== null || x.r.input === "queued");
  if (end.r.lowPriority === want) return done(want === "on" ? `已开${end.r.resetsAt ? `，到 ${end.r.resetsAt}` : ""}` : "已关");
  const echo = badEcho(end.raw);
  if (echo) return failed(`CC 回：${echo}`);
  if (end.r.input === "queued") return { outcome: "queued", detail: "刚好开始忙，/low-priority 排队了，回合结束才生效" };
  return failed("发了 /low-priority，8 秒内状态栏没变，需要人工看");
}

function badEcho(raw: string): string | null {
  const e = lastLpEcho(raw);
  return e && (e.echo === "unavailable" || e.echo === "break" || e.echo === "exhausted") ? e.text : null;
}

/** 最后一次提交 prefix 开头的命令之后几行（判 /compact 的回显，scrollback 里更早的不算） */
function afterCommand(raw: string, prefix: string): string {
  const plain = stripAnsi(raw).split("\n");
  for (let i = plain.length - 1; i >= 0; i--) {
    if (plain[i]!.replace(/^\s*❯\s*/, "").startsWith(prefix) && /^\s*❯/.test(plain[i]!)) return plain.slice(i + 1, i + 12).join("\n");
  }
  return "";
}

/** 往输入框提交一条斜杠命令：忙就排队，空闲就等它真的开始 */
async function slash(io: PaneIO, win: string, cmd: string, started: (x: { raw: string; r: LpRead }) => boolean, what: string): Promise<Step> {
  const { r } = await read(io, win);
  if (r.menu) return failed("底部有选项菜单挡着，没发");
  if (r.lowPriority === "unknown" && r.reason === "没找到输入框和状态栏") return failed("没找到输入框，没发");
  if (r.compacting) return { outcome: "skipped", detail: "正在压缩" };
  if (r.input === "draft") return failed("输入框里有没发出去的文字，没动");
  if (r.input === "unknown") return failed("看不清输入框是否为空，没动");
  const busy = r.busy || r.input === "queued";
  await io.sendLine(win, cmd);
  if (busy) {
    const q = await waitFor(io, win, 3000, (x) => x.r.input === "queued");
    return { outcome: "queued", detail: q.ok ? "忙，已排队，回合结束后执行" : "忙，已发进输入框（没看到排队提示）" };
  }
  const name = cmd.split(" ")[0]!;
  const end = await waitFor(io, win, 10000, (x) => started(x) || /Not enough messages to compact|Unknown (?:skill|command)/.test(afterCommand(x.raw, name)));
  const tail = afterCommand(end.raw, name);
  if (/Not enough messages to compact/.test(tail)) return { outcome: "skipped", detail: "对话太短，不用压缩" };
  if (/Unknown (?:skill|command)/.test(tail)) return failed(`CC 不认识 ${name}`);
  return end.ok ? done(what) : failed(`发了 ${name}，10 秒内没看到开始，需要人工看`);
}

/**
 * 压缩开始的样子不止一种：「Compacting conversation…」，或 low-priority 下先排队等算力（「Working at lower priority … next try in 15s」，
 * 十几秒后才换成 Compacting）。发之前验过是空闲的，所以发完出现回合 spinner 就是 /compact 在跑。
 */
const compactStarted = (x: { raw: string; r: LpRead }) => x.r.compacting || x.r.busy || /Compacting conversation|Compacted/.test(afterCommand(x.raw, "/compact"));

function compact(io: PaneIO, win: string, keep: string): Promise<Step> {
  return slash(io, win, compactCommand(keep), compactStarted, "已开始压缩");
}

function saveCompact(io: PaneIO, win: string): Promise<Step> {
  return slash(io, win, "/save-compact", (x) => x.r.busy || x.r.compacting, "已开始（先存记忆再压缩）");
}

/** 开 LP → 打断它自动开的续跑 → 清掉 Esc 放回输入框的字 → 压缩 */
async function lpThenCompact(io: PaneIO, win: string, keep: string): Promise<Step> {
  const before = (await read(io, win)).r;
  if (before.lowPriority !== "on") {
    const lp = await setLp(io, win, "on");
    if (lp.outcome !== "done") return { ...lp, detail: `开 LP：${lp.detail}` };
    const turn = await waitFor(io, win, 3000, (x) => x.r.busy);
    if (turn.ok) {
      await io.escape(win);
      const idle = await waitFor(io, win, 5000, (x) => !x.r.busy);
      if (!idle.ok) return failed("LP 已开，但 Esc 没打断自动续跑，没压缩");
    }
    // 开 LP 前输入框是空的（decideLp 验过），现在里面的字只能是 Esc 放回来的；C-u 之后要等画面重绘，立刻重读会看到旧字
    if ((await read(io, win)).r.input !== "empty") {
      await io.press(win, "C-u");
      if (!(await waitFor(io, win, 2000, (x) => x.r.input === "empty")).ok) return failed("LP 已开，但清不掉 Esc 放回输入框的字，没压缩");
    }
    if ((await read(io, win)).r.lowPriority !== "on") return failed("打断后 LP 不在了，没压缩");
  }
  const c = await compact(io, win, keep);
  // 这次确实把 LP 打开了、只是压缩那步跳过（对话太短 / 正在压缩）：整体算执行过，不能报「已跳过」让人以为什么都没做
  if (before.lowPriority !== "on" && c.outcome === "skipped") return done(`LP 已开，${c.detail}`);
  return { ...c, detail: `LP 开着，${c.detail}` };
}

/** 正在被批量动作处理的 agent：网页和 CLI 同时对同一个窗口发，两串按键会交错（半截命令、Esc 打到别人的回合上） */
const inFlight = new Set<string>();

/** 单个 agent 跑一个动作；win 为 null（窗口不在）只允许 text */
export async function runOne(action: FleetAction, agent: string, win: string | null, ctx: RunCtx): Promise<FleetResult> {
  const out = (s: Step): FleetResult => ({ agent, ...s });
  if (ccOnly(action.kind) && !win) return out(failed("找不到它的 tmux 窗口"));
  if (inFlight.has(agent)) return out({ outcome: "skipped", detail: "另一个批量动作正在处理它" });
  inFlight.add(agent);
  try {
    return await runAction(action, agent, win ?? "", ctx, out);
  } finally {
    inFlight.delete(agent);
  }
}

async function runAction(action: FleetAction, agent: string, w: string, ctx: RunCtx, out: (s: Step) => FleetResult): Promise<FleetResult> {
  try {
    switch (action.kind) {
      case "lp-on": return out(await setLp(ctx.io, w, "on"));
      case "lp-off": return out(await setLp(ctx.io, w, "off"));
      case "compact": return out(await compact(ctx.io, w, action.keep ?? ctx.keep));
      case "save-compact": return out(await saveCompact(ctx.io, w));
      case "lp-compact": return out(await lpThenCompact(ctx.io, w, action.keep ?? ctx.keep));
      case "text": {
        const r = await ctx.deliverText(agent, action.text ?? "");
        return out(r.ok ? (r.queued ? { outcome: "queued", detail: "忙，消息已排队" } : done("已送达")) : failed(r.error));
      }
    }
  } catch (e) {
    return out(failed(`出错：${(e as Error).message}`));
  }
}
