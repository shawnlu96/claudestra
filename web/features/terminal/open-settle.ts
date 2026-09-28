/**
 * 终端连上后先不揭开，等输出停下来再跳到底部显示。打开终端会把 agent 的 tmux 窗口改成本机视口尺寸，
 * Claude Code 收到尺寸变化会从头重画整段对话——边画边揭开，用户就看到一段「往下滚」的过程才落到最新消息。
 * 输出静默 quietMs 算画完；最多等 maxMs，防着一直有输出（agent 正在跑）时永远不揭开。tests/term-open-settle.test.ts。
 */
export interface OpenSettle {
  /** open 帧到了（尺寸已定）：开始计时 */
  start(): void;
  /** 收到一帧输出 */
  data(bytes: number): void;
  cancel(): void;
}

export function createOpenSettle(onSettled: (bytes: number, ms: number) => void, quietMs = 300, maxMs = 2500): OpenSettle {
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let max: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  let bytes = 0;
  let done = false;
  const clear = () => {
    if (quiet !== null) clearTimeout(quiet);
    if (max !== null) clearTimeout(max);
    quiet = max = null;
  };
  const fire = () => {
    if (done) return;
    done = true;
    clear();
    onSettled(bytes, Date.now() - startedAt);
  };
  return {
    start() {
      if (done || startedAt) return;
      startedAt = Date.now();
      quiet = setTimeout(fire, quietMs);
      max = setTimeout(fire, maxMs);
    },
    data(n) {
      bytes += n;
      if (done || !startedAt) return;
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(fire, quietMs);
    },
    cancel() {
      done = true;
      clear();
    },
  };
}
