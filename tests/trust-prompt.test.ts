import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { managedFor } from "../src/lib/runtimes/index.ts";
import type { WindowOps } from "../src/lib/runtimes/types.ts";
import { belowTrustLeftover, hasTrustOption, trustPromptKey, trustPromptMoves, trustPromptWorkspace, trustRefusal } from "../src/lib/trust-prompt.ts";

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

  test("退出阶段往 No 挪：默认高亮 No → 0；高亮在 Yes → -1", () => {
    expect(trustPromptMoves(dialog(DIR), "no")).toBe(0);
    expect(trustPromptMoves(dialog(DIR, true), "no")).toBe(-1);
  });

  test("正文提到 trust this folder 不算", () => {
    expect(trustPromptMoves("⏺ 说明:trust this folder 是 CC 的弹窗文案\n❯ \n  ⏵⏵ bypass permissions on")).toBeNull();
  });
});

describe("trustPromptMoves：只认当前画面底部完整、干净的框（审查 r1 P1-1）", () => {
  test("残影下面只多一行 shell 提示符 → 不认（修前 Yes 高亮时会对着 shell 按 Enter）", () => {
    const one = `${dialog(DIR, true)}\nuser@host repo %`;
    expect(trustPromptMoves(one)).toBeNull();
    expect(belowTrustLeftover(one)?.trim()).toBe("user@host repo %");
  });

  test("旧信任框残影 + 新的 Bypass 首启框拼在一起 → 不认（修前拿旧框的 Yes 高亮去按新框）", () => {
    const bypass = [
      "",
      " WARNING: Claude Code running in Bypass Permissions mode",
      "",
      " ❯ No, exit",
      "   Yes, I accept",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(trustPromptMoves(`${dialog(DIR, true)}\n${bypass}`)).toBeNull();
    expect(hasTrustOption(`${dialog(DIR, true)}\n${bypass}`)).toBe(true); // 所以 isAutoConfirmableModal 也不会按它
  });

  test("只截到半个框（看不到 Accessing workspace）→ 不认，但粗判仍认得出、不许当普通弹窗按", () => {
    const half = dialog(DIR).split("\n").slice(-10).join("\n");
    expect(trustPromptMoves(half)).toBeNull();
    expect(hasTrustOption(half)).toBe(true);
  });

  test("选项不齐、多一个 ❯ 行、带编号、两个都高亮 → 不认", () => {
    expect(trustPromptMoves(dialog(DIR).replace("   Yes, I trust this folder\n", ""))).toBeNull();
    expect(trustPromptMoves(dialog(DIR).replace(" Security guide", " ❯ 3. Something else"))).toBeNull();
    expect(trustPromptMoves(dialog(DIR).replace(" ❯ No, exit", " ❯ 1. No, exit").replace("   Yes, I trust", "   2. Yes, I trust"))).toBeNull();
    expect(trustPromptMoves(dialog(DIR).replace("   Yes, I trust", " ❯ Yes, I trust"))).toBeNull();
  });

  test("选项和尾注之间夹了别的内容 → 不认", () => {
    expect(trustPromptMoves(dialog(DIR).replace(" Enter to confirm", " stray output\n Enter to confirm"))).toBeNull();
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

describe("trustRefusal：只信任恰好等于本次 cwd 的目录（审查 r1 P1-2）", () => {
  const nofold = { foldCase: false };
  test("弹窗目录 = agent 目录 → 可以点；尾斜杠不影响", () => {
    expect(trustRefusal(dialog(DIR), DIR, HOME, nofold)).toBeNull();
    expect(trustRefusal(dialog(`${DIR}/`), DIR, HOME, nofold)).toBeNull();
  });
  test("上级目录（哪怕是 git 根）一律不点", () => {
    expect(trustRefusal(dialog("/private/tmp/sbx-t44/work"), DIR, HOME, nofold)).toContain("上级目录也不自动信任");
    expect(trustRefusal(dialog("/private/tmp"), "/private/tmp/repo", HOME, nofold)).toContain("不是这个 agent 的目录");
  });
  test("家目录、家目录的上级、/、~ → 拒绝", () => {
    expect(trustRefusal(dialog(HOME), HOME, HOME, nofold)).toContain("家目录和根目录不自动信任");
    expect(trustRefusal(dialog(`${HOME}/`), `${HOME}/proj`, HOME, nofold)).toContain("家目录和根目录不自动信任");
    expect(trustRefusal(dialog("/Users"), `${HOME}/proj`, HOME, nofold)).toContain("家目录和根目录不自动信任");
    expect(trustRefusal(dialog("/"), "/", HOME, nofold)).toContain("家目录和根目录不自动信任");
    expect(trustRefusal(dialog("~"), HOME, HOME, nofold)).toContain("家目录和根目录不自动信任");
    expect(trustRefusal(dialog("~/proj"), `${HOME}/proj`, HOME, nofold)).toBeNull();
  });
  test("弹窗问的不是这个 agent 的目录、或不知道 agent 目录 → 拒绝", () => {
    expect(trustRefusal(dialog("/private/tmp/other"), DIR, HOME, nofold)).toContain("不是这个 agent 的目录");
    expect(trustRefusal(dialog("/private/tmp/sbx-t44/work/pre-g10"), DIR, HOME, nofold)).toContain("不是这个 agent 的目录");
    expect(trustRefusal(dialog(DIR), undefined, HOME, nofold)).toContain("不知道这个 agent 的目录");
  });
  test("路径读不到（被截断、只截到半个框、显示成省略号）→ 拒绝，不再按 cwd 盲信", () => {
    const short = dialog(DIR).split("\n").slice(-10).join("\n");
    expect(trustRefusal(short, DIR, HOME, nofold)).toContain("路径读不全");
    expect(trustRefusal(dialog("…/sbx-t44/work/pre-g1"), DIR, HOME, nofold)).toContain("路径读不全");
    expect(trustRefusal(dialog("/private/tmp/sbx-t44/wo…/pre-g1"), DIR, HOME, nofold)).toContain("不是这个 agent 的目录");
  });
  test("先解开符号链接再比；大小写不敏感的盘上统一大小写", () => {
    const resolve = (p: string) => p.replace(/^\/tmp\//, "/private/tmp/");
    expect(trustRefusal(dialog("/tmp/sbx-t44/work/pre-g1"), DIR, HOME, { resolve, foldCase: false })).toBeNull();
    expect(trustRefusal(dialog("/Private/Tmp/sbx-t44/work/pre-g1"), DIR, HOME, { foldCase: true })).toBeNull();
    expect(trustRefusal(dialog("/Private/Tmp/sbx-t44/work/pre-g1"), DIR, HOME, { foldCase: false })).toContain("不是这个 agent 的目录");
    expect(trustRefusal(dialog("/users/SOMEONE"), `${HOME}/proj`, HOME, { foldCase: true })).toContain("家目录和根目录不自动信任");
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

  test("弹窗问的是 cwd 的上级：不点（审查 r1 P1-2）", async () => {
    const w = ccWindow(dir.replace(/\/[^/]+$/, ""));
    expect(await cc.waitReady(w.win, budget(dir))).toMatchObject({ ready: false, reason: "blocked-dialog" });
    expect(w.keys).toEqual([]);
  });

  test("旧框残影下只多一行 shell（高亮在 Yes）：一个键都不发（审查 r1 P1-1）", async () => {
    const w = ccWindow(dir);
    w.win.capture = async () => `${dialog(dir, true)}\nuser@host repo %`;
    expect(await cc.waitReady(w.win, budget(dir))).toMatchObject({ ready: false, reason: "timeout" });
    expect(w.keys).toEqual([]);
  });

  test("只看得到半个框：一个键都不发，超时说明里写明认不全", async () => {
    const w = ccWindow(dir);
    w.win.capture = async () => dialog(dir).split("\n").slice(-10).join("\n");
    const r = await cc.waitReady(w.win, budget(dir));
    expect(r).toMatchObject({ ready: false, reason: "timeout" });
    expect((r as { detail?: string }).detail).toContain("认不全");
    expect(w.keys).toEqual([]);
  });

  test("退出阶段遇到信任框：往 No, exit 走，不替用户接受", async () => {
    const w = ccWindow(dir);
    expect(await cc.onExitPane!(dialog(dir), w.win)).toBe("handled");
    expect(w.keys).toEqual(["Enter"]);
    expect(w.enterOnNo).toEqual([1]);
  });

  test("CC 在弹窗上退出后：不再对着 shell 发键，立刻报退出", async () => {
    const w = ccWindow(dir);
    let n = 0;
    const cap = w.win.capture;
    w.win.capture = async (l) => (n++ < 2 ? cap(l) : `${dialog(dir)}\nuser@host repo %`);
    // 第一轮看到弹窗（粗判 10 行 + 整框 40 行各截一次）、发 Down；之后屏幕上是残影 + shell（有人按了 No）
    const r = await cc.waitReady(w.win, budget(dir));
    expect(r).toMatchObject({ ready: false, reason: "exited" });
    expect(w.keys).toEqual(["Down"]);
  });
});
