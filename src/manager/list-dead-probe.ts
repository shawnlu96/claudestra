import { deadShellVerdict, isAtShell, tmuxCapture, windowHasChildProcess, windowTarget } from "../lib/tmux-helper.js";

export interface DeadProbeDeps {
  capture(name: string): Promise<string>;
  hasChild(name: string): Promise<boolean | null>;
  sleep(ms: number): Promise<void>;
}

const liveDeps: DeadProbeDeps = {
  capture: (name) => tmuxCapture(windowTarget(name), 5),
  hasChild: (name) => windowHasChildProcess(windowTarget(name)),
  sleep: (ms) => Bun.sleep(ms),
};

/** 两次采样间隔：CC 全屏重绘（web 终端 resize）期间 capture-pane 会抓到 scrollback 里的旧 shell 行，隔一段再看一次才算数 */
export const DEAD_RESAMPLE_MS = 800;

/**
 * 「窗口在但停在裸 shell 且无子进程」= dead（判据见 deadShellVerdict）。所有候选窗口先一起采样、只睡一次、再一起复核：
 * ACP 运行时的窗口 pane 本来就是 shell，逐个睡 800ms 时 25 个窗口就让 `manager list` 拖到 20 秒以上，
 * 网页 /api/v1/agents 12 秒超时、会话列表整片加载失败（tests/list-dead-probe.test.ts）。
 */
export async function probeDeadShellWindows(candidates: string[], deps: DeadProbeDeps = liveDeps): Promise<Set<string>> {
  const atShell = async (name: string) => isAtShell(await deps.capture(name));
  const first = await Promise.all(candidates.map(async (name) => ((await atShell(name)) ? name : null)));
  const suspects = first.filter((n): n is string => n !== null);
  if (suspects.length === 0) return new Set();
  await deps.sleep(DEAD_RESAMPLE_MS);
  const verdicts = await Promise.all(suspects.map(async (name) => {
    const stillShell = await atShell(name);
    // stillShell 为真才去 spawn ps；否则 hasChild 留 null，判据为 false
    const hasChild = stillShell ? await deps.hasChild(name) : null;
    return deadShellVerdict(stillShell, hasChild) ? name : null;
  }));
  return new Set(verdicts.filter((n): n is string => n !== null));
}
