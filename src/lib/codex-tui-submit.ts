/**
 * Codex 被打断（Esc）之后，`codex queue` 进来的消息会一直卡在队列里：TUI 停在「Conversation interrupted」，
 * 要等有人在终端里提交一轮才重新取队列（0.153.4 实测；上游同类 openai/codex #17095、#37974）。
 * 所以打断之后的第一条入站改成粘进 TUI 再回车；这一轮结束后队列自然恢复。
 * 只在确认「回合没在跑、没有弹框、输入框是空的」时才打，判断不出来就返回失败，由调用方退回 codex queue：宁可再卡一次也不盲打。
 * 单测 tests/codex-tui-submit.test.ts；背景与实测见 docs/architecture/interrupts.md。
 */
import { realpathSync } from "node:fs";
import { BLOCKING_DIALOG_RE } from "./runtimes/codex-ready.js";
import { codexMenuShown } from "./codex-menu.js";
import { codexBusy, codexOverlayOpen } from "./runtimes/codex-exit.js";
import { ensurePaneInteractive, tmuxRawStrict, TMUX_SOCK } from "./tmux-helper.js";

/** capture-pane -e 输出里的 SGR / 光标序列 */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** 输入框那一行：粗体的 ›（历史里的用户消息是粗体加暗 ESC[1;2m›，不算） */
const COMPOSER_RE = /^\x1b\[1m›\x1b\[0m(.*)$/;
/** 输入框为空：› 后面什么都没有，或只有暗色的占位提示（「Ask Codex to do anything」等，文案会轮换，只认暗色） */
const EMPTY_REST_RE = /^ ?(\x1b\[2m.*)?$/;

export type ComposerState = "empty" | "has-text" | "busy" | "dialog" | "unknown";

/** 从 capture-pane -e 的画面判断输入框现在能不能直接粘贴提交 */
export function composerState(ansiPane: string): ComposerState {
  const plain = ansiPane.replace(ANSI_RE, "");
  if (codexBusy(plain)) return "busy";
  const tail = plain.split("\n").filter((l) => l.trim()).slice(-12).join("\n");
  // 选择菜单的光标行（› 1. Switch to …）长得像输入框里有字：不先认出来，下面会判成 has-text，回车就选中了第 1 项（T63）
  if (BLOCKING_DIALOG_RE.test(tail) || codexOverlayOpen(plain) || codexMenuShown(plain)) return "dialog";
  const lines = ansiPane.split("\n").filter((l) => l.replace(ANSI_RE, "").trim());
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const m = COMPOSER_RE.exec(lines[i]);
    if (m) return EMPTY_REST_RE.test(m[1]) ? "empty" : "has-text";
  }
  return "unknown";
}

export interface TypeInIO {
  /** capture-pane -e（带颜色序列）的画面 */
  capture(): Promise<string>;
  /** bracketed paste：多行、引号、$、反引号原样进输入框，不会被当成按键。false = 粘贴前最后一查看到菜单，一个字没进窗口 */
  paste(text: string): Promise<boolean>;
  enter(): Promise<void>;
  /** 清空输入框（Ctrl+U） */
  clear(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/**
 * 粘贴前去掉控制字符：内容里夹着 ESC[201~（括号粘贴的结束符）时，tmux 不会剥，结束符后面的字就成了按键
 * （能打出 !shell、连发 C-c）。只留换行和制表符；\r 统一成换行。ESC 没了，剩下的「[201~」只是普通文字。
 */
export function sanitizeForPaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** 现抓一屏：没有停在 Codex 选择菜单上 */
const menuFree = async (io: TypeInIO): Promise<boolean> => !codexMenuShown(await io.capture());

/** unconfirmed：粘进去了、回车后没看到提交，或回车前菜单弹出来了（不能再退回 queue，会重复；调用方记日志留给人看） */
export type TypeInResult = { ok: true; unconfirmed?: true; menu?: true } | { ok: false; why: string; menu?: true };

const SETTLE_MS = 300;
const SUBMIT_POLLS = 10;

/**
 * 粘贴并提交。失败时保证输入框里没有留下这条（粘了但没认出来就清掉），调用方退回 queue 不会重复。
 * 回车后等到「回合开始（busy）」或「输入框变空」才算提交成功；第一下回车被当成换行时再补一下。
 */
export async function typeIntoCodex(io: TypeInIO, raw: string): Promise<TypeInResult> {
  const text = sanitizeForPaste(raw);
  // TUI 里 / 开头是斜杠命令、! 开头是本机 shell：投递内容正常以 <channel 或 [ 开头，万一不是就别打
  if (/^\s*[/!]/.test(text)) return { ok: false, why: "内容以 / 或 ! 开头，TUI 会当成命令" };
  const first = await io.capture();
  // menu：Codex 停在选择菜单，一个键没发——调用方交回 bridge 押住，不退回 queue（T63）
  if (codexMenuShown(first)) return { ok: false, why: "Codex 停在选择菜单", menu: true };
  const before = composerState(first);
  if (before !== "empty") return { ok: false, why: `输入框状态 ${before}` };
  if (!(await io.paste(text))) return { ok: false, why: "Codex 停在选择菜单（粘贴前）", menu: true }; // 没发：同上交回 bridge 押住
  try {
    await io.sleep(SETTLE_MS);
    const shot = await io.capture();
    if (codexMenuShown(shot)) return { ok: true, unconfirmed: true, menu: true }; // 粘完菜单弹出来了：不回车、也不按 C-u 清（T63），同下
    const pasted = composerState(shot);
    if (pasted !== "has-text") {
      if (pasted !== "empty" && pasted !== "busy") await io.clear();
      return { ok: false, why: `粘贴后输入框状态 ${pasted}` };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      // 每次回车前再看一眼：粘完之后菜单才弹出来，这一下回车就会选中菜单项（T63）。字留在输入框里、不清（清也是按键），
      // 按 unconfirmed 报：调用方不会再退回 queue 重投，日志留给人看
      if (!(await menuFree(io))) return { ok: true, unconfirmed: true, menu: true };
      await io.enter();
      for (let i = 0; i < SUBMIT_POLLS; i++) {
        await io.sleep(SETTLE_MS);
        const s = composerState(await io.capture());
        if (s === "busy" || s === "empty") return { ok: true };
      }
    }
  } catch (e) {
    // 粘贴之后 tmux 出错：清掉输入框再报失败，退回 queue 才不会一条消息进两次
    if (await menuFree(io).catch(() => false)) await io.clear().catch(() => undefined); // 清不掉也只能这样：错误已经随返回值记日志；菜单在就不按
    return { ok: false, why: `粘贴后 tmux 出错：${(e as Error).message}` };
  }
  return { ok: true, unconfirmed: true };
}

/**
 * 自己所在的 pane（channel-server 从 Codex 继承的 TMUX_PANE）的 tmux 实现。只认精确的 pane id（%N），
 * 并且 TMUX 里的 socket 必须就是 Claudestra 的 tmux socket——对不上就不打，免得打进别的 tmux server 同号的 pane。
 */
export function ownPaneIO(env: NodeJS.ProcessEnv = process.env): TypeInIO | { error: string } {
  const pane = env.TMUX_PANE ?? "";
  if (!/^%\d+$/.test(pane)) return { error: `TMUX_PANE 不是 pane id（${pane || "空"}）` };
  const sock = (env.TMUX ?? "").split(",")[0];
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return `?${p}`; // 解析不了就用原串加标记比，只会判成「不一致」而拒绝打字
    }
  };
  if (!sock || real(sock) !== real(TMUX_SOCK)) return { error: `pane 不在 Claudestra 的 tmux socket 上（${sock || "无 TMUX"}）` };
  const buf = `claudestra-typein-${process.pid}`;
  const capture = () => tmuxRawStrict(["capture-pane", "-t", pane, "-p", "-e", "-J", "-S", "-40"]);
  return {
    capture,
    paste: async (text) => {
      await ensurePaneInteractive(pane);
      await tmuxRawStrict(["set-buffer", "-b", buf, "--", text]);
      // 上面两步都要等，等的时候菜单可能弹出来：最后一查紧贴 paste-buffer，中间不再有等待（T63）
      if (codexMenuShown(await capture())) {
        await tmuxRawStrict(["delete-buffer", "-b", buf]).catch(() => ""); // 删不掉只是留一个下次同名覆盖的缓冲区，窗口里什么都没进
        return false;
      }
      await tmuxRawStrict(["paste-buffer", "-p", "-d", "-b", buf, "-t", pane]);
      return true;
    },
    enter: async () => void (await tmuxRawStrict(["send-keys", "-t", pane, "Enter"])),
    clear: async () => void (await tmuxRawStrict(["send-keys", "-t", pane, "C-u"])),
    sleep: (ms) => Bun.sleep(ms),
  };
}

/** channel-server 用：打进自己的 pane；拿不到 pane 或 tmux 出错都按「没打」返回，调用方退回 queue */
export async function typeIntoOwnPane(text: string): Promise<TypeInResult> {
  const io = ownPaneIO();
  if ("error" in io) return { ok: false, why: io.error };
  try {
    return await typeIntoCodex(io, text);
  } catch (e) {
    return { ok: false, why: `tmux 出错：${(e as Error).message}` };
  }
}
