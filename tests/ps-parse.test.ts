/** tmux-helper 的 ps 输出解析单测：判 claude 进程死活（windowHasChildProcess / deadShellVerdict）、强杀时找子进程（childPidsInPsOutput）。 */
import { describe, test, expect } from "bun:test";
import { childPidsInPsOutput } from "../src/lib/tmux-helper.js";

// ── v2.19.0 windowHasChildProcess 的 ppid 比对（pgrep 祖先排除坑）──────
// macOS/BSD 的 pgrep 会把「调用者自身及其祖先」排除在匹配之外(pkill 自保设计)。
// 于是跑在某个 agent 窗口里的 Claudestra 代码去查自己那个窗口,会得到「没有
// 子进程」= claude 已死的错误结论——而这个判据的下游是重启/重建窗口。
// 2026-08-16 实测:ps 列出 `30650 ppid=30638`,`pgrep -P 30638` 却返回空,
// 30650 正是调用方的祖先。改成自己解析 ps 输出,不再依赖 pgrep 的过滤语义。
import { hasChildInPsOutput, deadShellVerdict, isAtShell } from "../src/lib/tmux-helper.js";

describe("hasChildInPsOutput", () => {
  const PS = ["    1", " 3068", "30638", "  502", "30638"].join("\n");

  test("存在该 ppid → true", () => {
    expect(hasChildInPsOutput(PS, 30638)).toBe(true);
  });

  test("不存在 → false", () => {
    expect(hasChildInPsOutput(PS, 99999)).toBe(false);
  });

  test("祖先进程也必须能查到(pgrep 正是在这里骗了我们)", () => {
    expect(hasChildInPsOutput("30638\n", 30638)).toBe(true);
  });

  test("空输出 / 垃圾行不误判", () => {
    expect(hasChildInPsOutput("", 30638)).toBe(false);
    expect(hasChildInPsOutput("PPID\n\n  \n", 30638)).toBe(false);
  });

  test("不做子串匹配(306 不能命中 30638)", () => {
    expect(hasChildInPsOutput("30638\n", 306)).toBe(false);
  });
});

// ── dead 判据:null(探测失败)绝不能当 false(peer 2026-08-23 P0 误杀实证) ──────
// web 终端 resize 触发 CC 全屏重绘,capture-pane 抓到 scrollback 里的旧裸 shell
// 行 → isAtShell 成立;若此时把 windowHasChildProcess 的 null 当 false,就会把正在
// 干活的 agent 误判 dead 后重启杀掉。判据必须「atShell 且确无子进程(===false)」。
describe("deadShellVerdict", () => {
  test("裸 shell 且确无子进程 → dead", () => {
    expect(deadShellVerdict(true, false)).toBe(true);
  });
  test("有子进程(claude 活着) → 不 dead,哪怕 pane 看着像 shell", () => {
    expect(deadShellVerdict(true, true)).toBe(false);
  });
  test("探测失败 null → 不确定,绝不 dead(核心防误杀)", () => {
    expect(deadShellVerdict(true, null)).toBe(false);
  });
  test("pane 不是 shell → 无论子进程如何都不 dead", () => {
    expect(deadShellVerdict(false, false)).toBe(false);
    expect(deadShellVerdict(false, null)).toBe(false);
    expect(deadShellVerdict(false, true)).toBe(false);
  });
  test("ACP 窗口的会话末行像提示符（工具输出以 $ 收尾）：屏幕判 shell，宿主还在跑就不算回到 shell（链路哨兵不能因此吞掉掉线告警）", () => {
    const pane = "[09:00:01] 💻 ssh box\n[09:00:02]   ↳ Last login: Mon\n    he@box ~ $";
    expect(isAtShell(pane)).toBe(true);
    expect(deadShellVerdict(isAtShell(pane), true)).toBe(false);
  });
});

describe("childPidsInPsOutput", () => {
  const ps = ["  100   1", " 19174 200", "19175   200", "  300 19174", "垃圾行", "  400 999"].join("\n");
  test("按 ppid 过滤出直接子进程", () => {
    expect(childPidsInPsOutput(ps, 200)).toEqual([19174, 19175]);
  });
  test("死锁进程自己的孩子不掺进来", () => {
    expect(childPidsInPsOutput(ps, 19174)).toEqual([300]);
  });
  test("无子进程返回空", () => {
    expect(childPidsInPsOutput(ps, 12345)).toEqual([]);
  });
});
