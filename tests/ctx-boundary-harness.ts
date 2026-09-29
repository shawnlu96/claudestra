/**
 * 上下文边界测试共用的假终端：每个窗口一段底色画面 + 一个输入框（box）。敲字追加到 box，回车把 box 记成「已提交」并清空，
 * 退格从 box 尾部删。画面文字里带 `[menu]` / `Compacting conversation` 就当有对话框 / 在压缩；onType 模拟敲字那一刻画面变了。
 */
import type { BoundaryAgent, CtxBoundaryDeps } from "../src/bridge/ctx-boundary.js";
import type { PaneQuotaState } from "../src/lib/lp-state.js";

export const MIN = 60_000;
const IDLE_PANE = "some output\n❯ \n";
export const BUSY_PANE = "· Thinking… (esc to interrupt)\n❯ \n";

export interface FakeWin {
  pane: string | null;
  box: string;
  inMode: boolean;
  command: string;
  onType?: (w: FakeWin, text: string) => void;
}

export function harness(
  agents: BoundaryAgent[],
  opts: { panes?: Record<string, string | null>; state?: Partial<PaneQuotaState>; autoCompact?: Record<string, unknown> | null } = {},
) {
  let now = 1_000_000_000;
  const sent: { target: string; line: string }[] = [];
  const logs: string[] = [];
  const alerts: { agent: string; text: string; data: Record<string, unknown> }[] = [];
  const state: PaneQuotaState = { wall: false, lp: "off", exhausted: false, menu: false, compacting: false, draft: false, ...opts.state };
  const wins = new Map<string, FakeWin>();
  const win = (t: string): FakeWin => {
    let w = wins.get(t);
    if (!w) {
      w = { pane: opts.panes && t in opts.panes ? opts.panes[t] : IDLE_PANE, box: "", inMode: false, command: "claude.exe" };
      wins.set(t, w);
    }
    return w;
  };
  const deps: CtxBoundaryDeps = {
    now: () => now,
    agents: async () => agents,
    liveSession: async (a) => a,
    capture: async (t) => {
      const w = win(t);
      if (w.pane === null) return null;
      const text = `${w.pane}\n[box]${w.box}`;
      return { plain: text, esc: text, inMode: w.inMode, command: w.command };
    },
    readPane: (plain) => {
      const box = plain.split("[box]").pop() ?? "";
      return {
        ...state,
        menu: state.menu || plain.includes("[menu]"),
        compacting: state.compacting || plain.includes("Compacting conversation"),
        draft: state.draft || box !== "",
        inputText: box,
      };
    },
    type: async (t, text) => {
      const w = win(t);
      w.box += text;
      w.onType?.(w, text);
    },
    enter: async (t) => {
      const w = win(t);
      sent.push({ target: t, line: w.box });
      w.box = "";
    },
    erase: async (t, n) => {
      const w = win(t);
      const cs = [...w.box];
      w.box = cs.slice(0, Math.max(0, cs.length - n)).join("");
    },
    sleep: async () => {},
    autoCompact: () => (opts.autoCompact === null ? undefined : { inject: true, ...opts.autoCompact }),
    log: (l) => void logs.push(l),
    alert: (a, text, data) => void alerts.push({ agent: a.name, text, data }),
  };
  return { deps, sent, logs, alerts, state, win, advance: (ms: number) => (now += ms), get now() { return now; } };
}

export const agent = (o: Partial<BoundaryAgent>): BoundaryAgent => {
  const name = o.name ?? "agent-task-t1";
  return {
    name, projectId: "orch", channelId: null, cwd: null, sessionId: "s1", target: `master:${name}`, executor: name.startsWith("agent-task-"),
    ctx: 0, convTs: 0, mtime: 0, realWindow: null, ...o,
  };
};

export const tgt = (name: string, executor = false) => ({ name, target: `master:${name}`, executor });
