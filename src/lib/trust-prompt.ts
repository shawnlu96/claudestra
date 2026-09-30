/**
 * Claude Code 的目录信任弹窗（纯逻辑）。新目录里启动、带 --dangerously-skip-permissions 也照弹：
 *   Accessing workspace:
 *   /private/tmp/x/repo
 *   Quick safety check: Is this a project you created or one you trust? …
 *   ❯ No, exit
 *     Yes, I trust this folder
 *   Enter to confirm · Esc to cancel
 * 默认高亮 No, exit，没有数字编号。弹窗刚画出来时 CC 可能还没接键盘，一口气发「Down + Enter」
 * 时 Down 会丢，Enter 落在 No 上，CC 当场退出（沙箱 10 次 create 里复现过）。所以一次只发一个键，
 * 下一轮重新截屏看高亮在哪，高亮停在 Yes 上才按 Enter。测试：tests/trust-prompt.test.ts。
 */

const TRUST_OPTION_RE = /^\s*(❯)?\s*(No, exit|Yes, I trust this folder)\s*$/i;
/** 弹窗块里出现这些 = 叠着别的框（Bypass 首启框、编号菜单、另一个确认尾注），不是干净的信任框 */
const FOREIGN_RE = /Enter to confirm|Accessing workspace|Bypass Permissions|WARNING|Yes, I accept|^\s*(❯\s*)?\d+\.\s/i;
/** 截整个弹窗要的行数（弹窗约 17 行，给长路径折行留余量） */
export const TRUST_CAPTURE_LINES = 40;

function trimTrailingBlank(pane: string): string[] {
  const lines = pane.split("\n");
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines;
}

/** 底部 25 行里有信任框的选项行：粗判，只用来决定要不要截整屏细看、以及不许当普通弹窗按 Enter */
export function hasTrustOption(pane: string): boolean {
  return trimTrailingBlank(pane).slice(-25).some((l) => TRUST_OPTION_RE.test(l));
}

/**
 * 当前画面底部一个完整、干净的信任框里，高亮的是第几项（0 = No, exit，1 = Yes）；否则 null。
 * 要求：「Enter to confirm」是最后一个非空行；往上最近的「Accessing workspace:」到它之间有 Quick safety check、
 * 恰好两行相邻的选项（No 在上、Yes 在下、只一个 ❯），选项下面只有空行，且块里没有别的框的特征。
 * 残影下面多一行 shell、只截到半个框、旧框和新框拼在一起，都不算——对着它们按键会落到 shell 或别的框上。
 */
function trustSelection(pane: string): 0 | 1 | null {
  const lines = trimTrailingBlank(pane);
  const last = lines.length - 1;
  if (last < 0 || !/^\s*Enter to confirm\b.*Esc to cancel\s*$/i.test(lines[last]!)) return null;
  const head = lines.findLastIndex((l) => /^\s*Accessing workspace:\s*$/i.test(l));
  if (head < 0) return null;
  const block = lines.slice(head + 1, last);
  if (!block.some((l) => /^\s*Quick safety check\b/i.test(l))) return null;
  const optAt = block.flatMap((l, i) => (TRUST_OPTION_RE.test(l) || /^\s*❯/.test(l) ? [i] : []));
  if (optAt.length !== 2 || optAt[1] !== optAt[0]! + 1) return null;
  const [no, yes] = optAt.map((i) => block[i]!.match(TRUST_OPTION_RE));
  if (!no || !yes || !/^no/i.test(no[2]!) || !/^yes/i.test(yes[2]!) || !!no[1] === !!yes[1]) return null;
  if (block.slice(optAt[1]! + 1).some((l) => l.trim())) return null;
  if (block.some((l, i) => !optAt.includes(i) && FOREIGN_RE.test(l))) return null;
  return yes[1] ? 1 : 0;
}

/**
 * 高亮挪到目标项还要按几次 Down（负数 = Up，0 = 已高亮）；不是完整信任框返回 null。
 * 就绪轮询要 Yes；退出阶段要 No（不替用户接受新的目录信任，No 本来就是退出）。
 */
export function trustPromptMoves(pane: string, want: "yes" | "no" = "yes"): number | null {
  const sel = trustSelection(pane);
  return sel === null ? null : (want === "yes" ? 1 : 0) - sel;
}

/**
 * 信任弹窗的残影还在、但下面已经接了别的东西时，返回残影下面的那段屏幕（比如 CC 选 No 退出后的 shell 提示符）；
 * 否则 null。只拿下面那段判 shell：残影里的「Esc to cancel」会让 isAtShell 以为 CC 还在跑。
 */
export function belowTrustLeftover(pane: string): string | null {
  const tail = trimTrailingBlank(pane).slice(-25);
  const confirmAt = tail.findLastIndex((l) => /Enter to confirm/i.test(l));
  if (confirmAt < 0 || confirmAt === tail.length - 1) return null;
  if (!tail.slice(0, confirmAt).some((l) => TRUST_OPTION_RE.test(l))) return null;
  return tail.slice(confirmAt + 1).join("\n");
}

/** 这一轮该发的唯一一个键：高亮已在目标项才回车，否则只挪一格 */
export function trustPromptKey(moves: number): "Enter" | "Down" | "Up" {
  return moves === 0 ? "Enter" : moves > 0 ? "Down" : "Up";
}

/** 弹窗里「Accessing workspace:」下面那个目录（前后各隔一个空行）。超过 pane 宽的路径会折成几行，拼回去；认不出返回 null */
export function trustPromptWorkspace(pane: string): string | null {
  const lines = pane.split("\n");
  const at = lines.findLastIndex((l) => /Accessing workspace:/i.test(l));
  if (at < 0) return null;
  let path = "";
  for (const raw of lines.slice(at + 1)) {
    const l = raw.trim();
    if (!l && !path) continue;
    if (!l || /^Quick safety check/i.test(l)) break;
    path += l;
  }
  return path.startsWith("/") || path === "~" || path.startsWith("~/") ? path : null;
}

export interface TrustPathOpts {
  /** 解开符号链接（调用方传 realpath；目录不在时原样返回） */
  resolve?: (p: string) => string;
  /** 大小写不敏感的文件系统（macOS / Windows 默认）上统一成小写再比 */
  foldCase?: boolean;
}

/**
 * 能不能替用户点「信任」。只信任恰好等于这次启动目录的那个目录：上级目录、家目录、它的上级和 / 一律不点——
 * 那等于把更大一片交给 agent，得本人决定。弹窗里的路径读不全（被截断、折行拼不回来）也不点。
 * 返回 null = 可以点，否则是拒绝原因（调用方原样报给人）。
 */
export function trustRefusal(pane: string, cwd: string | undefined, home: string, opts: TrustPathOpts = {}): string | null {
  const foldCase = opts.foldCase ?? (process.platform === "darwin" || process.platform === "win32");
  const norm = (p: string) => {
    const r = (opts.resolve ?? ((x: string) => x))(p);
    const s = r.length > 1 ? r.replace(/\/+$/, "") : r;
    return foldCase ? s.toLowerCase() : s;
  };
  const manual = "请自己 attach 进 tmux 确认后再 restart";
  const raw = trustPromptWorkspace(pane);
  if (!raw) return `目录信任弹窗里的路径读不全，确认不了是这个 agent 的目录，不自动信任；${manual}`;
  const shown = raw === "~" || raw.startsWith("~/") ? home + raw.slice(1) : raw;
  const target = norm(shown);
  const h = norm(home);
  if (target === "/" || target === h || h.startsWith(`${target}/`)) {
    return `目录信任弹窗问的是 ${shown}：家目录和根目录不自动信任，请换一个项目目录，或${manual}`;
  }
  if (!cwd) return `目录信任弹窗问的是 ${shown}，但不知道这个 agent 的目录，不自动信任；${manual}`;
  if (norm(cwd) !== target) {
    return `目录信任弹窗问的是 ${shown}，不是这个 agent 的目录 ${cwd}（上级目录也不自动信任）；${manual}`;
  }
  return null;
}
