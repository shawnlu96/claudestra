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

function nonBlankTail(pane: string, n: number): string[] {
  const lines = pane.split("\n");
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.slice(-n);
}

/**
 * 到「Yes」还要按几次 Down（负数 = Up，0 = 已高亮）；不是这个弹窗返回 null。
 * 弹窗必须还贴在 pane 底部（「Enter to confirm」是最后两行之一）：CC 退出后它会留在回滚区，
 * 再当真就会对着 shell 连发方向键和回车。
 */
export function trustPromptMoves(pane: string): number | null {
  const tail = nonBlankTail(pane, 25);
  const confirmAt = tail.findLastIndex((l) => /Enter to confirm/i.test(l));
  if (confirmAt < 0 || confirmAt < tail.length - 2) return null;
  if (!/trust this folder/i.test(tail.join("\n"))) return null;
  const opts: Array<{ yes: boolean; selected: boolean }> = [];
  for (const raw of tail.slice(0, confirmAt)) {
    const m = raw.match(TRUST_OPTION_RE);
    if (m) opts.push({ yes: /^yes/i.test(m[2]!), selected: !!m[1] });
  }
  const yesIdx = opts.findIndex((o) => o.yes);
  const selIdx = opts.findIndex((o) => o.selected);
  if (yesIdx < 0 || selIdx < 0) return null;
  return yesIdx - selIdx;
}

/**
 * 信任弹窗的残影还在、但已经不在最底下时，返回残影下面的那段屏幕（比如 CC 选 No 退出后的 shell 提示符）；
 * 否则 null。只拿下面那段判 shell：残影里的「Esc to cancel」会让 isAtShell 以为 CC 还在跑。
 */
export function belowTrustLeftover(pane: string): string | null {
  const tail = nonBlankTail(pane, 25);
  const confirmAt = tail.findLastIndex((l) => /Enter to confirm/i.test(l));
  if (confirmAt < 0 || confirmAt >= tail.length - 2) return null;
  if (!tail.slice(0, confirmAt).some((l) => TRUST_OPTION_RE.test(l))) return null;
  return tail.slice(confirmAt + 1).join("\n");
}

/** 这一轮该发的唯一一个键：高亮已在 Yes 才回车，否则只挪一格 */
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
  return path.startsWith("/") ? path : null;
}

function withoutTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * 能不能替用户点「信任」。只信任这次启动自己的目录（或它的上级 git 根），家目录、它的上级和 / 一律不替人点：
 * 那等于把整个家目录交给 agent，得本人决定。cwd / home 由调用方先 realpath（弹窗显示的是真实路径，
 * 如 /tmp → /private/tmp）。返回 null = 可以点，否则是拒绝原因。
 */
export function trustRefusal(pane: string, realCwd: string | undefined, realHome: string): string | null {
  const shown = trustPromptWorkspace(pane);
  const target = withoutTrailingSlash(shown ?? realCwd ?? "");
  if (!target) return "认不出信任弹窗问的是哪个目录";
  const home = withoutTrailingSlash(realHome);
  if (target === "/" || target === home || home.startsWith(`${target}/`)) {
    return `目录信任弹窗问的是 ${target}：家目录和根目录不自动信任，请换一个项目目录，或自己 attach 进 tmux 确认后再 restart`;
  }
  const cwd = realCwd ? withoutTrailingSlash(realCwd) : undefined;
  if (cwd && cwd !== target && !cwd.startsWith(`${target}/`)) {
    return `目录信任弹窗问的是 ${target}，不是这个 agent 的目录 ${cwd}，不自动信任`;
  }
  return null;
}
