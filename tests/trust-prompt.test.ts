import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { managedFor } from "../src/lib/runtimes/index.ts";
import type { WindowOps } from "../src/lib/runtimes/types.ts";
import { belowTrustLeftover, trustPromptKey, trustPromptMoves, trustPromptWorkspace, trustRefusal } from "../src/lib/trust-prompt.ts";

// CC 2.1.284 在沙箱新 git 目录里实抓（2026-09-30，capture-pane -S -40，行首空格照抄）
function dialog(dir: string, selectedYes = false): string {
  return [
    "shawn@macmini repo % claude --dangerously-skip-permissions --session-id x",
    "────────────────────────────────────────────────────────────────────────────────",
    " Accessing workspace:",
    "",
    ` ${dir}`,
    "",
    " Quick safety check: Is this a project you created or one you trust? (Like your",
    " own code, a well-known open source project, or work from your team). If not,",
    " take a moment to review what's in this folder first.",
    "",
    " Claude Code'll be able to read, edit, and execute files here.",
    "",
    " Security guide",
    "",
    selectedYes ? "   No, exit" : " ❯ No, exit",
    selectedYes ? " ❯ Yes, I trust this folder" : "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
    "",
    "",
  ].join("\n");
}

const DIR = "/private/tmp/sbx-t44/work/pre-g1";
const HOME = "/Users/someone";

describe("trustPromptMoves", () => {
  test("默认高亮 No → 往下 1 格；高亮已在 Yes → 0", () => {
    expect(trustPromptMoves(dialog(DIR))).toBe(1);
    expect(trustPromptMoves(dialog(DIR, true))).toBe(0);
  });

  test("CC 选了 No 退回 shell 后，回滚区里的旧弹窗不算（修前会对着 shell 连发 Down / Enter）", () => {
    // 沙箱第 5 次 create 实录：弹窗下面接着 shell 提示符
    const stale = `${dialog(DIR)}\nshawn@macmini pre-g5 %\nshawn@macmini pre-g5 %\n`;
    expect(trustPromptMoves(stale)).toBeNull();
  });

  test("只截到 10 行（看不到 Accessing workspace）也认得出", () => {
    expect(trustPromptMoves(dialog(DIR).split("\n").slice(-10).join("\n"))).toBe(1);
  });

  test("正文提到 trust this folder 不算", () => {
    expect(trustPromptMoves("⏺ 说明:trust this folder 是 CC 的弹窗文案\n❯ \n  ⏵⏵ bypass permissions on")).toBeNull();
  });
});

describe("trustPromptKey：一轮只发一个键", () => {
  test("高亮在 Yes 才回车，否则只挪一格", () => {
    expect(trustPromptKey(0)).toBe("Enter");
    expect(trustPromptKey(1)).toBe("Down");
    expect(trustPromptKey(2)).toBe("Down");
    expect(trustPromptKey(-1)).toBe("Up");
  });
});

describe("trustPromptWorkspace", () => {
  test("读出弹窗里的目录", () => {
    expect(trustPromptWorkspace(dialog(DIR))).toBe(DIR);
  });
  test("超过 pane 宽被折行的路径拼回去", () => {
    const long = "/private/tmp/claude-501/-Users-someone-repos-x/51fef248/scratchpad/wt-t44-very-long";
    const wrapped = dialog(long).replace(` ${long}`, ` ${long.slice(0, 40)}\n ${long.slice(40)}`);
    expect(trustPromptWorkspace(wrapped)).toBe(long);
  });
  test("截不到 Accessing workspace → null", () => {
    expect(trustPromptWorkspace(dialog(DIR).split("\n").slice(-10).join("\n"))).toBeNull();
  });
});

describe("trustRefusal：只信任本次启动自己的目录", () => {
  test("弹窗目录 = agent 目录 → 可以点", () => {
    expect(trustRefusal(dialog(DIR), DIR, HOME)).toBeNull();
  });
  test("弹窗问的是上级 git 根 → 可以点", () => {
    expect(trustRefusal(dialog("/private/tmp/sbx-t44/work"), DIR, HOME)).toBeNull();
  });
  test("家目录、家目录的上级、/ → 拒绝", () => {
    expect(trustRefusal(dialog(HOME), HOME, HOME)).toContain("家目录和根目录不自动信任");
    expect(trustRefusal(dialog(`${HOME}/`), `${HOME}/proj`, HOME)).toContain("家目录和根目录不自动信任");
    expect(trustRefusal(dialog("/Users"), `${HOME}/proj`, HOME)).toContain("家目录和根目录不自动信任");
    expect(trustRefusal(dialog("/"), "/", HOME)).toContain("家目录和根目录不自动信任");
  });
  test("弹窗问的不是这个 agent 的目录 → 拒绝", () => {
    expect(trustRefusal(dialog("/private/tmp/other"), DIR, HOME)).toContain("不是这个 agent 的目录");
    expect(trustRefusal(dialog("/private/tmp/sbx-t44/work/pre-g10"), `${DIR}`, HOME)).toContain("不是这个 agent 的目录");
  });
  test("截不到目录时按 agent 目录判；两样都没有 → 拒绝", () => {
    const short = dialog(DIR).split("\n").slice(-10).join("\n");
    expect(trustRefusal(short, DIR, HOME)).toBeNull();
    expect(trustRefusal(short, HOME, HOME)).toContain("家目录");
    expect(trustRefusal(short, undefined, HOME)).toContain("认不出");
  });
});

describe("belowTrustLeftover", () => {
  test("弹窗贴底 → null；下面接了 shell → 返回下面那段", () => {
    expect(belowTrustLeftover(dialog(DIR))).toBeNull();
    expect(belowTrustLeftover(`${dialog(DIR)}\nshawn@macmini pre-g5 %\n`)?.trim()).toBe("shawn@macmini pre-g5 %");
    expect(belowTrustLeftover("shawn@macmini x %\n")).toBeNull();
  });
});

/**
 * CC 就绪轮询里的信任弹窗。假窗口按 CC 的真实行为演：弹窗刚画出来时第一个方向键会丢（沙箱复现的根因），
 * Enter 落在哪一项就走哪条路——No = 退回 shell，Yes = 进 TUI。
 */
describe("claude-code waitReady：信任弹窗", () => {
  const RULE = "─".repeat(40);
  const READY = [RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
  const budget = (cwd: string) => ({ rounds: 30, pollMs: 1, cwd });

  function ccWindow(dir: string, opts: { swallowFirstKey?: boolean } = {}) {
    let state: "dialog" | "ready" | "shell" = "dialog";
    let yes = false;
    let swallow = !!opts.swallowFirstKey;
    const keys: string[] = [];
    const enterOnNo: number[] = [];
    const win: WindowOps = {
      name: "agent-t", target: "@1",
      capture: async () => (state === "ready" ? READY : state === "shell" ? `${dialog(dir, yes)}\nuser@host repo %` : dialog(dir, yes)),
      sendLine: async () => {}, sendLiteral: async () => {},
      sendKey: async (k) => {
        keys.push(k);
        if (swallow) { swallow = false; return; }
        if (k === "Down") yes = true;
        if (k === "Up") yes = false;
        if (k === "Enter") { if (!yes) enterOnNo.push(keys.length); state = yes ? "ready" : "shell"; }
      },
      sendEscape: async () => {}, getOption: async () => null, setOption: async () => true,
      childPids: async () => [], sleep: async () => {},
    };
    return { win, keys, enterOnNo };
  }

  const cc = managedFor("claude-code")!;
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/t44-trust-`));

  test("第一个 Down 被吞：不会在 No 上按 Enter，重看高亮后再挪，最终就绪", async () => {
    const w = ccWindow(dir, { swallowFirstKey: true });
    expect(await cc.waitReady(w.win, budget(dir))).toMatchObject({ ready: true });
    expect(w.enterOnNo).toEqual([]);
    expect(w.keys).toEqual(["Down", "Down", "Enter"]);
  });

  test("家目录：一个键都不发，直接报被弹窗挡住", async () => {
    const home = realpathSync(homedir());
    const w = ccWindow(home);
    const r = await cc.waitReady(w.win, budget(home));
    expect(r).toMatchObject({ ready: false, reason: "blocked-dialog" });
    expect((r as { detail?: string }).detail).toContain("家目录和根目录不自动信任");
    expect(w.keys).toEqual([]);
  });

  test("弹窗问的不是本次启动的目录：不点", async () => {
    const w = ccWindow("/private/tmp/somewhere-else");
    expect(await cc.waitReady(w.win, budget(dir))).toMatchObject({ ready: false, reason: "blocked-dialog" });
    expect(w.keys).toEqual([]);
  });

  test("CC 在弹窗上退出后：不再对着 shell 发键，立刻报退出", async () => {
    const w = ccWindow(dir);
    let n = 0;
    const cap = w.win.capture;
    w.win.capture = async (l) => (n++ === 0 ? cap(l) : `${dialog(dir)}\nuser@host repo %`);
    // 第一轮看到弹窗、发 Down；之后屏幕上是残影 + shell（有人按了 No）
    const r = await cc.waitReady(w.win, budget(dir));
    expect(r).toMatchObject({ ready: false, reason: "exited" });
    expect(w.keys).toEqual(["Down"]);
  });
});
