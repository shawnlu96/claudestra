/**
 * 终端 viewer 的 tmux 小工具与尺寸适配（从 web-terminal.ts 搬出，term-viewer.ts / web-shell.ts 共用）。
 * 目标一律是完整的 tmux target（master:=agent-x / =webshell:=sh-…），这里不再拼 session 名。
 */

import { TMUX_SOCK, sandboxTmuxArgv } from "../lib/tmux-helper.js";
import { sandboxVerifyNewWindow } from "../lib/sandbox-tmux.js";

// ---------- tmux 小工具（独立于 tmux-helper 的 tmuxRaw：这里需要 exitCode） ----------

export function tmuxArgs(args: string[]): string[] {
  return sandboxTmuxArgv(["tmux", "-f", "/dev/null", "-S", TMUX_SOCK, ...args]); // 沙箱：socket 是软链 / 指向生产就抛错
}

export async function tmuxRun(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(tmuxArgs(args), { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  // 沙箱：目录 stat 得到但进不去（chmod 000）时 tmux 建窗口照样成功、回落 $HOME——读实际 cwd，不在根下就关掉并抛（同 tmuxRawStrict）
  if (code === 0) await sandboxVerifyNewWindow(args, async (a) => (await tmuxRun(a)).out);
  return { code, out: out.trim(), err: err.trim() };
}

/** iTerm -CC 钳制解除记录：断开时按原尺寸改写回去，桌面端恢复原状。 */
export interface ClampLift {
  windowId: string;
  /** 被改写申报尺寸的控制客户端（iTerm -CC） */
  clients: string[];
  origCols: number;
  origRows: number;
}

export function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = v === null ? NaN : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 解除 iTerm2 -CC 的 per-tab 尺寸钳制。
 *
 * 控制客户端会为每个窗口申报自己 tab 的尺寸,tmux 把 window 钳到 ≤ 该申报值——
 * resize-window / window-size manual 都顶不动（2026-07-13 实验:exit=0、manual
 * 已置,尺寸纹丝不动）。唯一有效的杠杆是 refresh-client -C <windowId>:WxH 改写
 * 控制客户端的申报值（同实验:改写后立即生效且不回弹,iTerm 只在自己 tab 几何
 * 变化时才重新申报）。返回原尺寸供断开时改写回去;无控制客户端时返回 null
 * （没有钳制来源,不需要解除）。
 */
async function liftControlClamp(
  windowRef: string,
  cols: number,
  rows: number,
  origCols: number,
  origRows: number,
): Promise<ClampLift | null> {
  const idRes = await tmuxRun([
    "display-message", "-p", "-t", windowRef, "#{window_id}",
  ]);
  const wid = idRes.out.trim();
  if (idRes.code !== 0 || !/^@\d+$/.test(wid)) return null;
  const clientsRes = await tmuxRun(["list-clients", "-F", "#{client_name}\t#{client_control_mode}"]);
  if (clientsRes.code !== 0) return null;
  const clients = clientsRes.out
    .split("\n")
    .filter((l) => l.endsWith("\t1"))
    .map((l) => l.split("\t")[0])
    .filter(Boolean);
  if (!clients.length) return null;
  for (const c of clients) {
    await tmuxRun(["refresh-client", "-t", c, "-C", `${wid}:${cols}x${rows}`]).catch(() => {});
  }
  return { windowId: wid, clients, origCols, origRows };
}

/** 把控制客户端的申报尺寸改写回解除前的值（断开 / 失败清理路径共用）。 */
export function restoreControlClamp(lift: ClampLift | undefined | null): void {
  if (!lift) return;
  for (const c of lift.clients) {
    tmuxRun(["refresh-client", "-t", c, "-C", `${lift.windowId}:${lift.origCols}x${lift.origRows}`]).catch(() => {});
  }
}

/**
 * 把 window 拉到 viewer 视口尺寸：先普通 resize-window;window 仍比请求小
 * = 有控制客户端钳制 → liftControlClamp 改写申报值后再拉一次。返回实际
 * eff/win 尺寸与 lift 记录（open 和 resize 端点共用）。
 */
export async function fitWindow(
  viewerTarget: string,
  windowRef: string,
  cols: number,
  rows: number,
  existingLift?: ClampLift,
): Promise<{ effCols: number; effRows: number; winCols: number; winRows: number; lift?: ClampLift }> {
  const read = async () => {
    const r = await tmuxRun(["display-message", "-p", "-t", viewerTarget, "#{window_width}x#{window_height}"]);
    const m = /^(\d+)x(\d+)$/.exec(r.out.trim());
    return r.code === 0 && m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
  };
  // 原始尺寸必须在任何 resize 之前捕获——resize 可能已经动了宽度，事后读到的
  // 不再是 iTerm tab 的真实原值，断开还原就还错了
  const before = await read();
  await tmuxRun(["resize-window", "-t", viewerTarget, "-x", String(cols), "-y", String(rows)]).catch(() => {});
  let win = await read();
  let lift = existingLift;
  if (win && (win.w < cols || win.h < rows)) {
    if (lift) {
      // 已解除过（同一 viewer 再次 resize）→ 直接改写到新尺寸，orig 保持首捕值
      for (const c of lift.clients) {
        await tmuxRun(["refresh-client", "-t", c, "-C", `${lift.windowId}:${cols}x${rows}`]).catch(() => {});
      }
    } else {
      const orig = before ?? win;
      lift = (await liftControlClamp(windowRef, cols, rows, orig.w, orig.h)) ?? undefined;
    }
    if (lift) {
      await tmuxRun(["resize-window", "-t", viewerTarget, "-x", String(cols), "-y", String(rows)]).catch(() => {});
      win = (await read()) ?? win;
    }
  }
  const winCols = win?.w ?? cols;
  const winRows = win?.h ?? rows;
  return { effCols: Math.min(cols, winCols), effRows: Math.min(rows, winRows), winCols, winRows, lift };
}
