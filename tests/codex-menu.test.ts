/**
 * T63 Codex 选择菜单护栏：菜单在屏上时，程序化的路径一个键都不发（不回车、不按 Esc / 数字 / 方向键 / C-u），消息押住、命令拒绝。
 * 画面用 2026-09-28 codex 额度用完那晚的真实原屏（tests/auq-pane.test.ts 同一份）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { codexMenuShown, codexMenuState } from "../src/lib/codex-menu.js";
import { clearRefusal, wallWaitOf } from "../src/lib/wall-screen.js";
import { detectCodexRuntimeDialog } from "../src/lib/runtime-dialogs.js";
import { composerState, typeIntoCodex, type TypeInIO } from "../src/lib/codex-tui-submit.js";
import { createInterruptGate, type InterruptGateDeps } from "../src/lib/interrupt-gate.js";
import { handleSlashPassthrough, type SlashDeps } from "../src/bridge/api-slash.js";
import { holdAtCodexMenu } from "../src/bridge/codex-menu-hold.js";
import { injectCompact } from "../src/bridge/ctx-boundary-inject.js";
import { harness as boundaryHarness, tgt } from "./ctx-boundary-harness.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";

const MENU = [
  "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 8:41 AM.",
  "",
  "  Approaching rate limits",
  "  Switch to gpt-5.6-luna for lower credit usage?",
  "",
  "› 1. Switch to gpt-5.6-luna                 Older fast and efficient model.",
  "  2. Keep current model",
  "  3. Keep current model (never show again)  Hide future rate limit reminders about switching models.",
  "",
  "  Press enter to confirm or esc to go back",
  "",
].join("\n");
/** AUQ 认不出的菜单（选项行里混了一行说明）：只有页脚认得出 */
const ODD_MENU = ["  Pick a sandbox", "", "› 1. read-only", "     (recommended)", "  2. workspace-write", "", "  Press enter to confirm or esc to cancel"].join("\n");
const COMPOSER = "• Done.\n\n\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n  gpt-5.6-sol medium · ~/w\n";
const HISTORY = ["  Press enter to confirm or esc to go back", "(上面是我在解释 Codex 菜单长什么样)", "a", "b", "c", "d", "e", "f", "› "].join("\n");

describe("判定", () => {
  test("真实原屏：菜单在（AUQ 认得出）；认不出选项的菜单也算在；输入框、历史里提到这句都不算", () => {
    expect(codexMenuState(MENU)).toBe("parsed");
    expect(codexMenuState(`\x1b[2m${MENU}\x1b[0m`)).toBe("parsed");
    expect(codexMenuState(ODD_MENU)).toBe("unparsed");
    expect(codexMenuShown(COMPOSER)).toBe(false);
    expect(codexMenuShown(HISTORY)).toBe(false);
  });

  test("只对 Codex 窗口认：CC 窗口画面里有这句不算 Codex 菜单", () => {
    expect(wallWaitOf(MENU, "codex")).toBe("codex_menu");
    expect(wallWaitOf(COMPOSER, "codex")).toBeNull();
    expect(wallWaitOf(MENU, "claude-code")).not.toBe("codex_menu");
  });

  test("⑤ /clear：菜单在 → 拒绝并说明；空闲 → 放行", () => {
    expect(clearRefusal(MENU, "codex")).toContain("Codex 的选择菜单");
    expect(clearRefusal("done\n❯ \n", "claude-code")).toBeNull();
  });

  test("卡片：AUQ 认得出的菜单不另出运行时卡（真实原屏上那张是额度用完的卡）；认不出的兜底出「Codex 停在选择菜单」", () => {
    expect(detectCodexRuntimeDialog(MENU, "codex", "/nonexistent")?.title).not.toContain("选择菜单");
    expect(detectCodexRuntimeDialog(MENU.replace(/^■.*\n/, ""), "codex", "/nonexistent")).toBeNull();
    expect(detectCodexRuntimeDialog(ODD_MENU, "codex", "/nonexistent")?.title).toContain("选择菜单");
    expect(detectCodexRuntimeDialog(ODD_MENU, "claude-code", "/nonexistent")).toBeNull();
  });
});

/** 假 pane：screens 依次出现（capture 一次推进一帧，到最后一帧停住），记下每个按键 */
function fakeIO(screens: string[]) {
  const keys: string[] = [];
  let i = 0;
  const io: TypeInIO = {
    capture: async () => screens[Math.min(i++, screens.length - 1)]!,
    paste: async () => (keys.push("paste"), true),
    enter: async () => void keys.push("Enter"),
    clear: async () => void keys.push("C-u"),
    sleep: async () => {},
  };
  return { io, keys };
}

describe("② 打断后粘进 TUI（codex-tui-submit）", () => {
  test("菜单的光标行不算输入框有字", () => expect(composerState(MENU)).toBe("dialog"));

  test("粘之前菜单就在：一个键都不发", async () => {
    const f = fakeIO([MENU]);
    expect((await typeIntoCodex(f.io, "<channel>hi</channel>")).ok).toBe(false);
    expect(f.keys).toEqual([]);
  });

  test("粘完菜单才弹出来：不回车、不按 C-u 清，报 unconfirmed（调用方不再退回 queue 重投）", async () => {
    const f = fakeIO([COMPOSER, MENU]);
    expect(await typeIntoCodex(f.io, "<channel>hi</channel>")).toEqual({ ok: true, unconfirmed: true, menu: true });
    expect(f.keys).toEqual(["paste"]);
  });
});

describe("③ 打断（interrupt-gate 的 wallWait 对 Codex 窗口认菜单）", () => {
  test("抢占与手动停止都不发键，手动停止回报 wall", async () => {
    const keys: string[] = [];
    const deps: InterruptGateDeps = {
      resolve: async () => ({ win: "master:=agent-c", runtime: "codex" }),
      probe: async () => ({ main: "busy", bg: false }),
      wallWait: async () => wallWaitOf(MENU, "codex") !== null,
      interrupt: async () => (keys.push("Escape"), ["Escape"]),
      onPreempted: () => {},
      sleep: async () => {},
    };
    const gate = createInterruptGate(deps);
    expect(await gate.preempt("c1", "agent-c")).toEqual({ fired: false, why: "wall_wait" });
    expect(await gate.manual("c1", "master:=agent-c", "codex")).toEqual({ keys: [], wall: true });
    expect(keys).toEqual([]);
  });
});

describe("④ 斜杠直通（api-slash）", () => {
  test("Codex 停在菜单：409 拒绝、不注入", async () => {
    const sent: string[] = [];
    const deps: SlashDeps = {
      sendLine: async (_w, t) => void sent.push(t), mirror: async () => {}, scheduleClearRotation: () => {}, markThinking: () => {}, record: () => {},
      wallWait: async () => wallWaitOf(MENU, "codex"), runManager: async () => ({ ok: true }),
    };
    const owner = { id: "owner:self", name: "owner", agents: ["*"], role: "owner" } as never;
    const agent = { name: "agent-c", channelId: "c1", cwd: "/w", runtime: "codex" } as never;
    const res = await handleSlashPassthrough({ principal: owner, tokenId: "self", agent, text: "/compact", hasAttachments: false }, deps);
    expect(res?.status).toBe(409);
    expect(((await res!.json()) as { error: string }).error).toContain("Codex 的选择菜单");
    expect(sent).toEqual([]);
  });
});

describe("① 投递押住（codex-menu-hold）", () => {
  const meta = { messageId: "m1", triggerKind: "discord", ts: "", threadId: "t" };
  const env = { from: { kind: "user", userId: "u", name: "owner" }, to: {}, intent: "request", content: "hi", meta } as unknown as Envelope;
  const to = { kind: "local", channelId: "c1", agentName: "agent-c" } as unknown as LocalEndpoint;
  test("菜单在：进押后队列、heldBy=codex_menu；菜单关了：照常投（返回 null）", async () => {
    const held: Envelope[] = [];
    const queue = { holdEnv: (e: Envelope) => (held.push(e), held.length), rewrite: () => {}, get: () => undefined };
    const r = await holdAtCodexMenu(env, to, "agent-c", "master:=agent-c", queue, undefined, async () => "codex_menu");
    expect(r?.outcome).toEqual({ kind: "sent", note: "queued", heldBy: "codex_menu" });
    expect(held.length).toBe(1);
    expect(await holdAtCodexMenu(env, to, "agent-c", "master:=agent-c", queue, undefined, async () => null)).toBeNull();
    expect(held.length).toBe(1);
  });
});

describe("⑦ 压缩注入（ctx-boundary / fleet / 手动压缩按钮）", () => {
  test("Codex 窗口在敲字前就被 not-cc 挡住，菜单画面下一个键都没发", async () => {
    const h = boundaryHarness([], { panes: { "master:c": MENU } });
    h.win("master:c").command = "codex";
    expect(await injectCompact(tgt("c"), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "not-cc" });
    expect(h.win("master:c").box).toBe("");
    expect(h.sent).toEqual([]);
  });
});

// ── T63 复审（outer-codex @f21b51a7：P1×1、P2×3）──
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import { keysBlockedAt, KeysBlockedError } from "../src/lib/codex-key-guard.js";
import { createEscGuard, type EscGuardDeps } from "../src/lib/esc-guard.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { onCodexTypeInFailed } from "../src/bridge/codex-menu-hold.js";
import { CodexQueueSink } from "../src/lib/codex-thread.js";

describe("复审 P1：最底层发键在所有等待之后再查菜单", () => {
  // 测试进程共用一个状态目录：写进去的 registry 用完要还原，不然后面按 registry 选目标的测试（fleet-routes）会看到 agent-c / agent-k
  let prior: string | null = null;
  beforeAll(() => {
    prior = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : null;
    writeFileSync(REGISTRY_PATH, JSON.stringify({ socket: "s", agents: { "agent-c": { runtime: "codex", channelId: "c1", status: "active" }, "agent-k": { channelId: "k1", status: "active" } } }));
  });
  afterAll(() => (prior === null ? unlinkSync(REGISTRY_PATH) : writeFileSync(REGISTRY_PATH, prior)));
  test("只对 Codex 窗口抓屏判定；CC 窗口不抓", async () => {
    let captures = 0;
    const cap = async () => (captures++, MENU);
    expect(await keysBlockedAt("master:=agent-c", cap)).toBeInstanceOf(KeysBlockedError);
    expect(await keysBlockedAt("master:=agent-k", cap)).toBeNull();
    expect(captures).toBe(1);
  });

  test("Esc：初始没菜单，节流等待期间菜单弹出来 → 不发（strict 抛 KeysBlockedError）；生命周期退出（unguarded）照发", async () => {
    let clock = 10_000;
    let menu = false;
    const sent: string[] = [];
    const deps: EscGuardDeps = {
      windowId: async () => "@1",
      lock: async () => ({ release: () => {} }),
      readShared: () => clock - 100, // 刚发过一次：这一发要等双击间隔
      writeShared: () => {},
      send: async (t) => void sent.push(t),
      sleep: async (ms) => { clock += ms; menu = true; }, // 等的时候菜单弹出来了
      now: () => clock,
      blocked: async (t) => (menu ? new KeysBlockedError(t) : null),
    };
    const esc = createEscGuard(deps);
    await expect(esc("master:=agent-c", { strict: true })).rejects.toBeInstanceOf(KeysBlockedError);
    await esc("master:=agent-c"); // 非 strict：记日志、不发
    expect(sent).toEqual([]);
    await esc("master:=agent-c", { unguarded: true });
    expect(sent).toEqual(["master:=agent-c"]);
  });
});

describe("复审 P2：押住的顺序、误判、第二道闸退回", () => {
  const mk = (id: string) => ({
    from: { kind: "api", tokenId: "t", name: "dev" }, to: { kind: "local", channelId: "c9", agentName: "agent-c" }, intent: "request", content: id,
    meta: { messageId: id, triggerKind: "system", ts: "", threadId: id },
  }) as unknown as Envelope;
  const to = { kind: "local", channelId: "c9", agentName: "agent-c" } as unknown as LocalEndpoint;

  test("菜单期间押 A、B；菜单关了、补投前到的 C 排在后面；补投按 A、B、C", async () => {
    const q = new HeldQueue(null);
    const [a, b, c] = [mk("A"), mk("B"), mk("C")];
    const menuUp = async () => "codex_menu" as const;
    const menuGone = async () => null;
    expect((await holdAtCodexMenu(a, to, "agent-c", "w", q, undefined, menuUp))?.outcome).toMatchObject({ heldBy: "codex_menu" });
    await holdAtCodexMenu(b, to, "agent-c", "w", q, undefined, menuUp);
    expect((await holdAtCodexMenu(c, to, "agent-c", "w", q, undefined, menuGone))?.outcome).toMatchObject({ heldBy: "codex_menu" });
    expect((q.get("c9") ?? []).map((i) => i.env.meta.messageId)).toEqual(["A", "B", "C"]);
    const delivered: string[] = [];
    for (const item of [...(q.get("c9") ?? [])]) { // 模拟 flushHeld：逐条补投，投出去才出队
      if ((await holdAtCodexMenu(item.env, to, "agent-c", "w", q, undefined, menuGone)) === null) delivered.push(item.env.meta.messageId);
      q.set("c9", (q.get("c9") ?? []).filter((i) => i !== item));
    }
    expect(delivered).toEqual(["A", "B", "C"]);
    expect(await holdAtCodexMenu(mk("D"), to, "agent-c", "w", q, undefined, menuGone)).toBeNull(); // 补投完之后照常直投
  });

  test("页脚后面紧跟着正常输入框和状态栏：不是菜单（正文在讲这个菜单）", () => {
    const talk = ["• 菜单长这样：", "  Press enter to confirm or esc to go back", "", "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "", "  gpt-5.6-sol medium · ~/w"].join("\n");
    expect(codexMenuShown(talk)).toBe(false);
    expect(composerState(talk)).toBe("empty");
  });

  test("第二道闸：打字前看到菜单 → 不走 queue、按 id 交回 bridge；粘完才冒出来 → 报结果未知", async () => {
    const reports: unknown[] = [];
    const queued: string[] = [];
    const sink = (typeIn: () => Promise<{ ok: true; unconfirmed?: true; menu?: true } | { ok: false; why: string; menu?: true }>) => new CodexQueueSink({
      source: "claudestra", getSessionId: () => "019a0000-0000-7000-8000-000000000001", heldThreadIds: async () => ["019a0000-0000-7000-8000-000000000001"],
      onSwitch: () => {}, queue: async (_s, t) => (queued.push(t), { ok: true, out: "", err: "" }), notify: async () => {},
      typeIn, onTypeInFailed: (info) => void reports.push(info),
    });
    const meta = { chat_id: "1", message_id: "m7", after_interrupt: "true" };
    expect(await sink(async () => ({ ok: false, why: "Codex 停在选择菜单", menu: true })).deliver("hi", meta)).toEqual({ ok: true });
    expect(queued).toEqual([]);
    await sink(async () => ({ ok: true, unconfirmed: true, menu: true })).deliver("hi", meta);
    expect(reports).toEqual([{ menu: true, messageId: "m7" }, { unknown: true, messageId: "m7" }]);
    expect(queued).toEqual([]);
  });

  test("bridge 收到退回：按 id 找回原信封押回队首；结果未知的只记日志、不押", () => {
    const q = new HeldQueue(null);
    const later = mk("L");
    q.holdEnv(later);
    const typed = mk("m7");
    const cuts = { rearmAfterInterrupt: () => {}, takeTypedEnv: (_c: string, id: string) => (id === "m7" ? typed : undefined) } as never;
    onCodexTypeInFailed({ channelId: "c9", unknown: true, messageId: "m7" }, q, cuts);
    expect((q.get("c9") ?? []).map((i) => i.env.meta.messageId)).toEqual(["L"]);
    onCodexTypeInFailed({ channelId: "c9", menu: true, messageId: "m7" }, q, cuts);
    expect((q.get("c9") ?? []).map((i) => i.env.meta.messageId)).toEqual(["m7", "L"]);
  });
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

describe("复验 P1：最后一次菜单检查紧贴真正发送，中间没有等待（真 tmuxSendLine / ownPaneIO，假 tmux）", () => {
  const home = mkdtempSync(join(tmpdir(), "t63-send-"));
  const bin = join(home, "bin");
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  beforeAll(() => {
    mkdirSync(bin);
    mkdirSync(join(home, "state"));
    mkdirSync(join(home, "rt"));
    writeFileSync(join(home, "state", "registry.json"), JSON.stringify({ socket: "s", agents: { "agent-c": { runtime: "codex", channelId: "c1", status: "active" } } }));
    writeFileSync(join(home, "menu.txt"), MENU);
    writeFileSync(join(home, "composer.txt"), COMPOSER);
    // 假 tmux：每条命令记一行；命令里带 FLIP_ON 的那一步起画面换成菜单（模拟「等的时候菜单弹出来」）
    writeFileSync(join(bin, "tmux"), [
      "#!/bin/sh",
      `d='${home}'`,
      `printf '%s\\n' "$*" >> "$d/calls.log"`,
      `case " $* " in *" $FLIP_ON "*) : > "$d/menu" ;; esac`,
      `case " $* " in`,
      `  *" capture-pane "*) if [ -f "$d/menu" ]; then cat "$d/menu.txt"; else cat "$d/composer.txt"; fi ;;`,
      `  *"#{window_id}"*) echo @7 ;;`,
      `  *"#{pane_in_mode}"*) echo 0 ;;`,
      "esac",
    ].join("\n"), { mode: 0o755 });
  });
  // 子进程里跑真的 tmuxSendLine、真的 ownPaneIO + typeIntoCodex（生产里的全部等待都在）：路径在 import 时就落进临时目录，也不改测试进程的 PATH
  const lib = join(import.meta.dir, "..", "src", "lib");
  const script = (mode: "line" | "paste") => mode === "line"
    ? `const { tmuxSendLine } = await import(${JSON.stringify(join(lib, "tmux-helper.ts"))});
       console.log(JSON.stringify(await tmuxSendLine("master:=agent-c", "/clear").then(() => "sent", (e) => "blocked:" + e.name)));`
    : `const { TMUX_SOCK } = await import(${JSON.stringify(join(lib, "tmux-helper.ts"))});
       const { ownPaneIO, typeIntoCodex } = await import(${JSON.stringify(join(lib, "codex-tui-submit.ts"))});
       console.log(JSON.stringify(await typeIntoCodex(ownPaneIO({ TMUX_PANE: "%5", TMUX: TMUX_SOCK + ",1,0" }), "<channel>hi</channel>")));`;
  const run = (mode: "line" | "paste", flipOn: string) => {
    rmSync(join(home, "menu"), { force: true });
    writeFileSync(join(home, "calls.log"), "");
    const p = Bun.spawnSync([process.execPath, "-e", script(mode)], {
      env: testChildEnv({
        PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: home, FLIP_ON: flipOn,
        CLAUDESTRA_STATE_DIR: join(home, "state"), CLAUDESTRA_RUNTIME_DIR: join(home, "rt"),
      }),
      stdout: "pipe", stderr: "pipe",
    });
    const out = p.stdout.toString().trim().split("\n").pop() ?? "";
    if (p.exitCode !== 0 || !out) throw new Error(`runner 失败：${p.stderr.toString().slice(-800)}`);
    const calls = readFileSync(join(home, "calls.log"), "utf8").trim().split("\n").map((l) => l.replace(/^-f \/dev\/null -S \S+ /, ""));
    return { result: JSON.parse(out), calls };
  };

  test("tmuxSendLine：查窗口 id（记程序敲键要用）的等待里菜单弹出来 → 文字和回车都不发", () => {
    const { result, calls } = run("line", "#{window_id}");
    expect(result).toBe("blocked:KeysBlockedError");
    expect(calls.filter((c) => c.startsWith("send-keys"))).toEqual([]);
    // 顺序：先等完查窗口 id，再抓屏判定
    expect(calls.findIndex((c) => c.includes("#{window_id}"))).toBeLessThan(calls.findIndex((c) => c.startsWith("capture-pane")));
  });

  test("ownPaneIO.paste：set-buffer 的等待里菜单弹出来 → 不 paste-buffer，报「没发 / menu」（不是「粘了、结果未知」）", () => {
    const { result, calls } = run("paste", "set-buffer");
    expect(result).toEqual({ ok: false, why: "Codex 停在选择菜单（粘贴前）", menu: true });
    expect(calls.filter((c) => /^(paste-buffer|send-keys)/.test(c))).toEqual([]);
    expect(calls.slice(-3).map((c) => c.split(" ")[0])).toEqual(["set-buffer", "capture-pane", "delete-buffer"]);
  });

  test("对照：一直没有菜单 → 照常发字、回车、粘贴", () => {
    const line = run("line", "never");
    expect(line.result).toBe("sent");
    expect(line.calls.filter((c) => c.startsWith("send-keys"))).toEqual(["send-keys -t master:=agent-c -l -- /clear", "send-keys -t master:=agent-c Enter"]);
    expect(run("paste", "never").calls.some((c) => c.startsWith("paste-buffer"))).toBe(true);
  });
});
