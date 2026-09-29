/**
 * 批量管理的发键执行器：一个 agent 一个动作，每一步发完都重抓画面复核，结果归成 已执行 / 已排队 / 已跳过 / 失败。
 * 发键只经注入的 PaneIO（生产实现在 service.ts，全走 tmux-helper），判态全在 lib/lp-state.ts；这里只排步骤。
 * 压缩（compact / save-compact / 开 LP 再压缩的最后一步）交给 T36 的 injectCompact，和自动压缩、手动按钮同一套闸门、15 分钟守卫与长短档。
 * 发键的动作整串（开 LP → Esc → 清字 → 压缩）都拿着窗口执行权（ctx-boundary-inject.ts withWindow），自动压缩和手动按钮插不进来。
 * 安全边界：画面上有任何菜单 / 对话框一个键都不按（含 Esc）；输入框里有别人的字就不动、绝不清；
 * 发键前隔一小段再抓一次屏，两次都过才发，按键只看这两帧；Esc 只在两帧都确认有回合在跑时才按（空闲时按两下会弹 Rewind）。
 * 用例见 tests/fleet-runner.test.ts。
 */
import type { CompactAction, CompactKeep } from "../../lib/ctx-boundary-policy.js";
import { ccOnly, type FleetAction, type FleetResult } from "../../lib/fleet-plan.js";
import { decideLp, lastLpEcho, readLpPane, stripAnsi, type LpRead } from "../../lib/lp-state.js";
import { withWindow, type InjectResult } from "../ctx-boundary-inject.js";

export interface PaneIO {
  /** capture-pane -p -e */
  capture(win: string): Promise<string>;
  /** 打字 + 回车（带 copy-mode 守卫）；tmux 发送失败要抛，不能当成发了 */
  sendLine(win: string, text: string): Promise<void>;
  /** 按 n 次退格（失败同样要抛） */
  erase(win: string, n: number): Promise<void>;
  /** 走 tmuxSendEscape（带双击护栏） */
  escape(win: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type TextOutcome = { ok: true; queued: boolean } | { ok: false; error: string };
export interface RunCtx {
  io: PaneIO;
  /** null：默认清单也不合格（单测保证走不到），交给 injectCompact 退到它自己的默认档 */
  keep: CompactKeep | null;
  deliverText: (agent: string, text: string) => Promise<TextOutcome>;
  /** 生产是 injectCompact(await injectTargetFor(agent), { action, keep })：画面判定、守卫、按窗口大小挑长短档都在它里面 */
  compact: (agent: string, action: CompactAction, keep: CompactKeep | null) => Promise<InjectResult>;
  /** 15 分钟注入守卫还在不在（compactInjectedRecently） */
  compactedRecently: (agent: string) => Promise<boolean>;
}

type Step = Omit<FleetResult, "agent">;
type Frame = { raw: string; r: LpRead };
const done = (detail: string): Step => ({ outcome: "done", detail });
const failed = (detail: string): Step => ({ outcome: "failed", detail });
const skipped = (detail: string): Step => ({ outcome: "skipped", detail });

const POLL_MS = 400;
/** 敲字前第二次抓屏的间隔：两次之间画面变了（有人在打字、弹了对话框、回合开始）就不发 */
const RECHECK_MS = 300;

async function read(io: PaneIO, win: string): Promise<Frame> {
  const raw = await io.capture(win);
  return { raw, r: readLpPane(raw) };
}

/** 等到 pred 成立，最多 ms 毫秒；返回最后一次读到的画面 */
async function waitFor(io: PaneIO, win: string, ms: number, pred: (x: Frame) => boolean) {
  let x = await read(io, win);
  for (let t = 0; !pred(x) && t < ms; t += POLL_MS) {
    await io.sleep(POLL_MS);
    x = await read(io, win);
  }
  return { ...x, ok: pred(x) };
}

/** 发键前的闸：抓一次屏判一次，过了隔 RECHECK_MS 再抓一次再判；返回拦下的理由（null = 两次都过）和最后一帧 */
async function gateTwice<T>(io: PaneIO, win: string, check: (r: LpRead) => T | null): Promise<{ block: T | null; x: Frame }> {
  let x = await read(io, win);
  const first = check(x.r);
  if (first) return { block: first, x };
  await io.sleep(RECHECK_MS);
  x = await read(io, win);
  return { block: check(x.r), x };
}

/** 「设成开 / 设成关」：先判态，已是目标态不发；发完等状态栏变过来 */
async function setLp(io: PaneIO, win: string, want: "on" | "off"): Promise<Step> {
  const { block } = await gateTwice(io, win, (r): Step | null => {
    const d = decideLp(want, r);
    return d.kind === "send" ? null : d.kind === "skip" ? skipped(d.reason) : failed(d.reason);
  });
  if (block) return block;
  await io.sendLine(win, "/low-priority");
  const end = await waitFor(io, win, 8000, (x) => x.r.lowPriority === want || badEcho(x.raw) !== null || x.r.input === "queued");
  if (end.r.lowPriority === want) return done(want === "on" ? `已开${end.r.resetsAt ? `，到 ${end.r.resetsAt}` : ""}` : "已关");
  const echo = badEcho(end.raw);
  if (echo) return failed(`CC 回：${echo}`);
  if (end.r.input === "queued") return { outcome: "queued", detail: "刚好开始忙，/low-priority 排队了，回合结束才生效；那之前有人手动切过 LP 的话它会切反，请回头看一眼" };
  return failed("发了 /low-priority，8 秒内状态栏没变，需要人工看");
}

function badEcho(raw: string): string | null {
  const e = lastLpEcho(raw);
  return e && (e.echo === "unavailable" || e.echo === "break" || e.echo === "exhausted") ? e.text : null;
}

const isCmdLine = (l: string, prefix: string) => l.startsWith("❯") && l.slice(1).trimStart().startsWith(prefix);

/** 画面上 prefix 开头的已提交命令行有几条：发之前数一次，之后只认多出来的那条的回显（scrollback 里更早的不算） */
function cmdCount(raw: string, prefix: string): number {
  return stripAnsi(raw).split("\n").filter((l) => isCmdLine(l, prefix)).length;
}

/** 最后一条 prefix 开头的命令行之后几行（它的回显） */
function afterCommand(raw: string, prefix: string): string {
  const plain = stripAnsi(raw).split("\n");
  for (let i = plain.length - 1; i >= 0; i--) if (isCmdLine(plain[i]!, prefix)) return plain.slice(i + 1, i + 12).join("\n");
  return "";
}

/**
 * 能不能往输入框敲压缩命令（回合在跑、输入框是空的可以，会排队）：null = 能。injectCompact 敲之前只抓一帧，这里先隔 RECHECK_MS
 * 抓两帧都过才交给它（r2 P2-6：两帧之间有人开始打字就不敲）；copy-mode、不是 CC、API 重试、15 分钟守卫由它再判
 */
function slashBlock(r: LpRead): Step | null {
  if (r.modal) return failed(`${r.reason ?? "底部没有输入框"}，没按任何键`);
  if (r.compacting) return skipped("正在压缩");
  // 与 T36 注入闸门同一口径：撞墙没开 LP，命令发进去也跑不动，只会一直挂在输入框里
  if (r.lowPriority === "exhausted" || (r.walled && r.lowPriority !== "on")) return failed("撞墙等待中、没开 low-priority，没发（先开 LP，或用「开 LP 再压缩」）");
  // 草稿和排队分开写：owner 要分得清是有人在打字，还是前面已经有消息在排队（PM 09-29 口径：两种都不发）
  if (r.input === "draft") return failed("输入框里有没发出去的文字（草稿），没动");
  if (r.input === "queued") return failed("输入框里已有排队的消息，没发（等它们发出去再试）");
  if (r.input === "unknown") return failed("看不清输入框是否为空，没动");
  return null;
}

/**
 * injectCompact 没敲 / 没提交：正在压缩、15 分钟内刚压过算跳过（不用做），窗口小到连 /compact 都放不下也算跳过（它的说明里写了拉大窗口）；
 * 其余被挡算失败（想做没做成）；字还留在输入框里的写明
 */
function notInjected(r: Extract<InjectResult, { status: "skipped" | "failed" }>): Step {
  if (r.status === "failed") return failed(r.leftover && !/留在输入框/.test(r.error) ? `${r.error}；敲进去的字（或其中一段）还留在输入框里，请看一眼` : r.error);
  return r.reason === "compacting" || r.reason === "recent" || r.reason === "window-small" ? skipped(r.text) : failed(`${r.text}，没发`);
}

/**
 * 压缩交给 injectCompact；它说已执行之后，这边再等压缩真的开始：回合 spinner（low-priority 下会先显示「Working at lower priority」），
 * 或这次新命令下面出现 Compacting / 太短 / 不认识。只认发之后多出来的那条命令行，scrollback 里更早的不算
 */
async function compact(ctx: RunCtx, agent: string, win: string, action: CompactAction, keep: CompactKeep | null): Promise<Step> {
  const { block, x: x0 } = await gateTwice(ctx.io, win, slashBlock);
  if (block) return block;
  const r = await ctx.compact(agent, action, keep);
  if (r.status === "skipped" || r.status === "failed") return notInjected(r);
  const name = r.line.split(" ")[0]!;
  const note = r.note ? `${r.note}；` : ""; // 窗口放不下自定清单、退了档：写明敲的是哪一档
  if (r.status === "queued") return { outcome: "queued", detail: `${note}忙，已排队，回合结束后执行` };
  const before = cmdCount(x0.raw, name);
  const echo = (x: Frame) => (cmdCount(x.raw, name) > before ? afterCommand(x.raw, name) : "");
  const started = (x: Frame) => x.r.compacting || x.r.busy || /Compacting conversation|Compacted/.test(echo(x));
  const end = await waitFor(ctx.io, win, 10000, (x) => started(x) || /Not enough messages to compact|Unknown (?:skill|command)/.test(echo(x)));
  const tail = echo(end);
  if (/Not enough messages to compact/.test(tail)) return skipped(`${note}对话太短，不用压缩`);
  if (/Unknown (?:skill|command)/.test(tail)) return failed(`CC 不认识 ${name}`);
  if (!end.ok) return failed(`发了 ${name}，10 秒内没看到开始，需要人工看`);
  return done(`${note}${name === "/compact" ? "已开始压缩" : "已开始（先存记忆再压缩）"}`);
}

const OWN_ECHO = "/low-priority";
const OTHER_TEXT = "LP 已开；输入框里有别的内容，没清也没压缩";

/**
 * 打断自动续跑后，Esc 可能把我们敲的 /low-priority 放回输入框：两帧都正好是这几个字，才按同样多的退格（不用 C-u 清整行）；
 * 多一个字少一个字、排队消息、任何对话框都不动。按键只看闸门的第二帧，不再多抓：从这一帧到退格落地的几十毫秒里
 * 有人接着打字，是抓屏再按键固有的竞态（docs/architecture/fleet-ops.md），事后没清干净就报失败，绝不报已执行
 */
async function clearOwnEcho(io: PaneIO, win: string): Promise<Step | null> {
  let sawEmpty = false;
  const { block, x } = await gateTwice(io, win, (r): Step | null => {
    if (r.modal) return failed(`LP 已开，但${r.reason ?? "底部没有输入框"}，没按任何键、没压缩`);
    if (r.input === "queued") return failed("LP 已开；输入框里已有排队的消息，没清也没压缩");
    const own = r.input === "draft" && r.inputText === OWN_ECHO;
    if (r.input !== "empty" && !own) return failed(`${OTHER_TEXT}（看到的是「${r.inputText.slice(0, 40) || "看不清"}」）`);
    // 第一帧空、第二帧才冒出这几个字：不是两帧都看到，照样不按
    if (own && sawEmpty) return failed(`${OTHER_TEXT}（两次抓屏之间输入框变了）`);
    sawEmpty = r.input === "empty";
    return null;
  });
  if (block) return block;
  if (x.r.input === "empty") return null;
  await io.erase(win, OWN_ECHO.length);
  const end = await waitFor(io, win, 2000, (y) => y.r.input === "empty");
  if (end.ok) return null;
  return failed(`LP 已开；按了 ${OWN_ECHO.length} 次退格清 /low-priority，输入框里还剩「${end.r.inputText.slice(0, 40) || "看不清"}」，没压缩（可能有人同时在打字，请看一眼）`);
}

/**
 * 开 LP → 打断它自动开的续跑 → 清掉 Esc 放回来的 /low-priority → 压缩。
 * 这次确实把 LP 打开了：压缩不用做（对话太短 / 正在压缩）算已执行；被人的字、排队消息、对话框挡住算失败（活没干完，要人看），
 * 和单独压缩同一口径；detail 都以「LP 已开」开头，看得出 LP 那步成了
 */
async function lpThenCompact(ctx: RunCtx, agent: string, win: string, keep: CompactKeep | null): Promise<Step> {
  const io = ctx.io;
  const before = (await read(io, win)).r;
  if (before.lowPriority !== "on") {
    const lp = await setLp(io, win, "on");
    if (lp.outcome !== "done") return { ...lp, detail: `开 LP：${lp.detail}` };
    // 15 分钟内刚注入过压缩，这次压不了：那就别打断 LP 自动开的续跑，打断了又不压，agent 会停在那儿干等
    if (await ctx.compactedRecently(agent)) return done(`LP ${lp.detail}；15 分钟内刚注入过压缩，这次不压，也没打断它自动开的续跑`);
    const turn = await waitFor(io, win, 3000, (x) => x.r.busy);
    // 空闲窗口上一个键都不按：隔一小段再看一次，两帧都在忙才按 Esc
    if (turn.ok && !(await gateTwice(io, win, (r) => (r.busy && !r.modal ? null : "idle"))).block) {
      await io.escape(win);
      const idle = await waitFor(io, win, 5000, (x) => !x.r.busy);
      if (!idle.ok) return failed("LP 已开，但 Esc 没打断自动续跑，没压缩");
    }
    const bad = await clearOwnEcho(io, win);
    if (bad) return bad;
    if ((await read(io, win)).r.lowPriority !== "on") return failed("打断后 LP 不在了，没压缩");
  }
  const c = await compact(ctx, agent, win, "compact", keep);
  if (before.lowPriority !== "on") return { ...c, outcome: c.outcome === "skipped" ? "done" : c.outcome, detail: `LP 已开，${c.detail}` };
  return { ...c, detail: `LP 开着，${c.detail}` };
}

/** 正在被批量动作处理的 agent：网页和 CLI 同时对同一个窗口发，两串按键会交错（半截命令、Esc 打到别人的回合上） */
const inFlight = new Set<string>();

/** 单个 agent 跑一个动作；win 为 null（窗口不在）只允许 text。发键的动作先拿窗口执行权，自动压缩 / 手动按钮正拿着就跳过 */
export async function runOne(action: FleetAction, agent: string, win: string | null, ctx: RunCtx): Promise<FleetResult> {
  const out = (s: Step): FleetResult => ({ agent, ...s });
  if (ccOnly(action.kind) && !win) return out(failed("找不到它的 tmux 窗口"));
  if (inFlight.has(agent)) return out({ outcome: "skipped", detail: "另一个批量动作正在处理它" });
  inFlight.add(agent);
  try {
    if (!win || !ccOnly(action.kind)) return await runAction(action, agent, win ?? "", ctx, out);
    return await withWindow(win, "批量动作", () => runAction(action, agent, win, ctx, out), (who) => out(skipped(`${who}正在操作这个窗口，没发`)));
  } finally {
    inFlight.delete(agent);
  }
}

async function runAction(action: FleetAction, agent: string, w: string, ctx: RunCtx, out: (s: Step) => FleetResult): Promise<FleetResult> {
  try {
    switch (action.kind) {
      case "lp-on": return out(await setLp(ctx.io, w, "on"));
      case "lp-off": return out(await setLp(ctx.io, w, "off"));
      case "compact": return out(await compact(ctx, agent, w, "compact", action.keep ?? ctx.keep));
      case "save-compact": return out(await compact(ctx, agent, w, "save-compact", ctx.keep));
      case "lp-compact": return out(await lpThenCompact(ctx, agent, w, action.keep ?? ctx.keep));
      case "text": {
        const r = await ctx.deliverText(agent, action.text ?? "");
        return out(r.ok ? (r.queued ? { outcome: "queued", detail: "它正在忙，这一轮结束后再投，还没送到" } : done("已送达")) : failed(r.error));
      }
    }
  } catch (e) {
    return out(failed(`出错：${(e as Error).message.slice(0, 200)}`)); // tmux 失败的报错带整条命令（含保留清单），截短
  }
}
