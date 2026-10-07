/**
 * ACP 窗口底部的状态行（tty-screen.ts 画）：只看宿主已经知道的回合态（AcpHost.turnState），不另外猜。
 * 审批优先于思考中（审批时回合也在跑，但卡住它的是审批）；排队数跟在后面。tests/acp-tty.test.ts。
 */
export interface TurnState {
  busy: boolean;
  queued: number;
  permissions: number;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function statusText(s: TurnState, busyMs: number): string {
  const queue = s.queued > 0 ? ` · 排队 ${s.queued} 条` : "";
  if (s.permissions > 0) return `⏸ 等待审批（到网页卡片作答）${queue}`;
  if (s.busy) return `✻ 思考中… ${elapsed(busyMs)}${queue}（Esc 打断）`;
  return `· 空闲${queue}`;
}

/** 按显示宽度截到 cols - 1（中文两格；留一格免得光标停在行尾的待折行状态，下一次 \r 回不到行首） */
export function fitWidth(text: string, cols: number): string {
  let w = 0, out = "";
  for (const ch of text) {
    w += Bun.stringWidth(ch);
    if (w > Math.max(1, cols - 1)) return out;
    out += ch;
  }
  return out;
}

/**
 * 窗口变窄后旧状态行被 tmux 折成几行再减一（tmux 把光标留在原来那行 = 最后一折，前面几折往上推，要往上擦这么多行）。
 * tmux 3.6a 重排时宽字按 UTF-8 字节数占格（直接打印才按 2 格；实测「等」×20 在 22 列折成 3 行），这里照它算。
 * 两个入口（tmux attach、网页终端连 tmux）都经过 tmux；ponytail: 不经 tmux 的真终端按显示宽度折，会多擦一两行旧内容
 */
export function foldsOf(text: string, cols: number): number {
  return Math.max(0, Math.ceil(Buffer.byteLength(text) / Math.max(1, cols)) - 1);
}
