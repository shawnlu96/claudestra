/**
 * bridge/fleet/runner.ts：用真实画面（tests/fixtures/lp/）回放，每次发键后切到下一段画面，钉死发键顺序与安全边界：
 * 任何菜单 / 对话框一个键都不按（含 Esc）；草稿、排队、忙、状态不明一律不发键；Esc 只在两帧都确认有回合时按；
 * Esc 放回来的字只在两帧都正好是 /low-priority 时按同样多的退格。压缩走真的 injectCompact（T36），按键和画面接同一个假 tmux。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { injectCompact, liveInjectDeps, resetInjectState, type InjectDeps } from "../src/bridge/ctx-boundary-inject.js";
import { runOne, type PaneIO, type RunCtx } from "../src/bridge/fleet/runner.js";
import type { CompactKeep } from "../src/lib/ctx-boundary-policy.js";
import type { FleetAction } from "../src/lib/fleet-plan.js";
import { stripAnsi } from "../src/lib/lp-state.js";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "lp", `${name}.ansi`), "utf8");

/**
 * frames[0] 是初始画面；每次 sendLine / erase / escape（injectCompact 的敲字 / 回车 / 退格也算）之后换成下一段（没有下一段就停在最后一段）。
 * 一段可以是一组帧：段内每抓一次屏往后走一帧、停在最后一帧——用来模拟两次抓屏之间画面变了
 */
function fakeIO(frames: (string | string[])[]) {
  const keys: string[] = [];
  let i = 0;
  let j = 0;
  const step = (k: string) => {
    keys.push(k);
    i = Math.min(i + 1, frames.length - 1);
    j = 0;
  };
  const capture = async () => {
    const seg = frames[i]!;
    if (typeof seg === "string") return seg;
    return seg[Math.min(j++, seg.length - 1)]!;
  };
  const io: PaneIO = {
    capture,
    sendLine: async (_w, t) => step(`line:${t.split(" ")[0]}`),
    erase: async (_w, n) => step(`erase:${n}`),
    escape: async () => step("escape"),
    sleep: async () => {},
  };
  const deps: InjectDeps = {
    now: () => Date.now(),
    capture: async () => {
      const esc = await capture();
      return { plain: stripAnsi(esc), esc, inMode: false, command: "claude" };
    },
    readPane: liveInjectDeps.readPane,
    type: async (_t, text) => step(`type:${text.split(" ")[0]}`),
    enter: async () => step("enter"),
    erase: async (_t, n) => step(`erase:${n}`),
    sleep: async () => {},
  };
  return { io, keys, deps };
}

type Fake = { io: PaneIO; deps: InjectDeps };
/** CompactKeep 只有 normalizeCompactKeep 产得出：测试里的字面量按它标一下 */
const K = (s: string) => s as CompactKeep;
function ctxOf(f: Fake, text: RunCtx["deliverText"] = async () => ({ ok: true, queued: false }), over: Partial<RunCtx> = {}): RunCtx {
  const target = (agent: string) => ({ name: agent, target: `master:=${agent}`, executor: agent.startsWith("agent-task-") });
  return {
    io: f.io,
    keep: K("保留测试"),
    deliverText: text,
    compact: (agent, action, keep) => injectCompact(target(agent), { action, keep }, f.deps),
    compactedRecently: async () => false,
    ...over,
  };
}
const run = (a: FleetAction, frames: (string | string[])[], text?: RunCtx["deliverText"], agent = "agent-x", over?: Partial<RunCtx>) => {
  const f = fakeIO(frames);
  return runOne(a, agent, `master:=${agent}`, ctxOf(f, text, over)).then((r) => ({ ...r, keys: f.keys }));
};
beforeEach(() => resetInjectState()); // 15 分钟注入守卫是模块级的，每条用例从空表开始

/**
 * 真实画面拼一个「输入框里是 text」的帧（默认 LP 开着、空闲）：换掉底边框上面那一行提示符行。
 * 真 CC 的输入框是 ❯ + NBSP（样本 draft.ansi），sep 换成普通空格测旧画法
 */
function typed(text: string, sep = "\u00a0", base = "lp-on-interrupted"): string {
  const box = /\n((?:\x1b\[[\d;]*m)*)❯[^\S\n]*(?:\x1b\[39m)?(?=\n(?:\x1b\[[\d;]*m)*─{20,})/;
  const raw = fx(base).replace(box, (_m, pre: string) => `\n${pre}❯${sep}${text}`);
  if (!raw.includes(`❯${sep}${text}`)) throw new Error(`${base} 的输入框行变了，拼不出输入框里的字`);
  return raw;
}
const KEEP_LINE = "/compact 保留测试";
const restoredDraft = typed("/low-priority");

describe("设成开 / 设成关", () => {
  test("撞墙中 → 敲 /low-priority → 状态栏变成开", async () => {
    const r = await run({ kind: "lp-on" }, [fx("walled"), fx("lp-on-autocontinue")]);
    expect(r).toMatchObject({ outcome: "done", detail: "已开，到 3:20am" });
    expect(r.keys).toEqual(["line:/low-priority"]);
  });

  test("已经是开 → 不发任何键", async () => {
    const r = await run({ kind: "lp-on" }, [fx("lp-on-allowance")]);
    expect(r).toMatchObject({ outcome: "skipped", detail: "已经是开" });
    expect(r.keys).toEqual([]);
  });

  test("开着 → 关", async () => {
    const r = await run({ kind: "lp-off" }, [fx("lp-on-allowance"), fx("lp-off-offer")]);
    expect(r).toMatchObject({ outcome: "done", detail: "已关" });
    expect(r.keys).toEqual(["line:/low-priority"]);
  });

  test("忙 → 报「忙，未发」，不发键", async () => {
    const r = await run({ kind: "lp-off" }, [fx("lp-on-autocontinue")]);
    expect(r.outcome).toBe("failed");
    expect(r.detail).toContain("忙，未发");
    expect(r.keys).toEqual([]);
  });

  test("输入框有草稿 → 不动", async () => {
    const r = await run({ kind: "lp-on" }, [fx("walled-typing")]);
    expect(r.outcome).toBe("failed");
    expect(r.keys).toEqual([]);
  });

  test("发完刚好开始忙、开关排队了 → 已排队，并提醒回合结束前有人手动切过会切反（adv3）", async () => {
    const r = await run({ kind: "lp-off" }, [fx("lp-on-allowance"), fx("busy-queued")]);
    expect(r).toMatchObject({ outcome: "queued", keys: ["line:/low-priority"] });
    expect(r.detail).toContain("回合结束才生效");
    expect(r.detail).toContain("会切反");
  });

  test("发了但 CC 回 isn't available → 失败并带回显原文", async () => {
    const r = await run({ kind: "lp-on" }, [fx("lp-off-resumable"), fx("fresh-unavailable")]);
    expect(r.outcome).toBe("failed");
    expect(r.detail).toContain("isn't available right now");
  });
});

describe("额度菜单", () => {
  test("任何额度菜单（光标在 credits 上 / 有 LP 项 / 没有 LP 项）：开关 LP、开 LP 再压缩都一个键不按，Esc 也不按", async () => {
    for (const name of ["menu-on-credits", "menu-on-lp", "menu-5-items", "menu-no-lp"]) {
      for (const kind of ["lp-on", "lp-off", "lp-compact"] as const) {
        const r = await run({ kind }, [fx(name)]);
        expect([name, kind, r.keys]).toEqual([name, kind, []]);
        expect(r.outcome).toBe(kind === "lp-off" ? "skipped" : "failed");
      }
    }
  });

  test("压缩类动作遇到菜单 → 不发键", async () => {
    const r = await run({ kind: "compact" }, [fx("menu-5-items")]);
    expect(r.outcome).toBe("failed");
    expect(r.keys).toEqual([]);
  });
});

describe("压缩", () => {
  test("空闲 → 敲 /compact 清单 → 输入框正好是这条才回车 → 看到开始压缩", async () => {
    const r = await run({ kind: "compact" }, [fx("lp-on-interrupted"), typed(KEEP_LINE), fx("compacting")]);
    expect(r).toMatchObject({ outcome: "done", detail: "已开始压缩", keys: ["type:/compact", "enter"] });
  });

  test("LP 下压缩先排队等算力（spinner 是 Working at lower priority，不是 Compacting）→ 也算已开始", async () => {
    const waiting = fx("lp-on-interrupted").replace(
      /\n[^\n]*─{20,}[^\n]*\n[^\n]*❯[^\n]*\n/,
      (m) => `\n❯ /compact 保留测试\n✻ Working at lower priority … · next try in 15s · attempt 2 · esc to interrupt${m}`,
    );
    expect(waiting).toContain("next try in 15s");
    const r = await run({ kind: "compact" }, [fx("lp-on-interrupted"), typed(KEEP_LINE), waiting]);
    expect(r).toMatchObject({ outcome: "done", detail: "已开始压缩" });
  });

  test("对话太短 → 已跳过", async () => {
    const r = await run({ kind: "compact" }, [fx("lp-on-interrupted"), typed(KEEP_LINE), fx("compact-too-short")]);
    expect(r).toMatchObject({ outcome: "skipped", detail: "对话太短，不用压缩" });
  });

  test("回合在跑、输入框是空的 → 照发，报已排队", async () => {
    const r = await run({ kind: "compact" }, [fx("lp-on-autocontinue"), typed(KEEP_LINE, "\u00a0", "lp-on-autocontinue"), fx("busy-queued")]);
    expect(r).toMatchObject({ outcome: "queued", detail: "忙，已排队，回合结束后执行", keys: ["type:/compact", "enter"] });
  });

  test("输入框里已有排队的消息 → 不发，原因写「排队的消息」，和草稿分开（PM 09-29 口径）", async () => {
    const r = await run({ kind: "compact" }, [fx("busy-queued"), fx("busy-queued")]);
    expect(r).toMatchObject({ outcome: "failed", keys: [] });
    expect(r.detail).toContain("排队的消息");
    expect(r.detail).not.toContain("草稿");
  });

  test("正在压缩 → 跳过", async () => {
    const r = await run({ kind: "save-compact" }, [fx("compacting")]);
    expect(r).toMatchObject({ outcome: "skipped", detail: "正在压缩" });
    expect(r.keys).toEqual([]);
  });
});

describe("开 LP 再压缩", () => {
  test("开 → 自动续跑开始 → Esc 打断 → /compact", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-autocontinue"), fx("lp-on-interrupted"), typed(KEEP_LINE), fx("compacting")]);
    expect(r).toMatchObject({ outcome: "done", detail: "LP 已开，已开始压缩" });
    expect(r.keys).toEqual(["line:/low-priority", "escape", "type:/compact", "enter"]);
  });

  test("Esc 放回输入框的 /low-priority：按 13 次退格（不用 C-u 清整行），清干净才压缩", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-autocontinue"), restoredDraft, fx("lp-on-interrupted"), typed(KEEP_LINE), fx("compacting")]);
    expect(r.outcome).toBe("done");
    expect(r.keys).toEqual(["line:/low-priority", "escape", "erase:13", "type:/compact", "enter"]);
  });

  test("续跑已经自己结束了（没看到忙）→ 不按 Esc", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-allowance"), typed(KEEP_LINE), fx("compacting")]);
    expect(r.outcome).toBe("done");
    expect(r.keys).toEqual(["line:/low-priority", "type:/compact", "enter"]);
  });

  test("开了 LP、但对话太短没压缩 → 仍算已执行（LP 确实开了）", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-allowance"), typed(KEEP_LINE), fx("compact-too-short")]);
    expect(r).toMatchObject({ outcome: "done", detail: "LP 已开，对话太短，不用压缩" });
  });

  test("LP 已经开着 → 直接压缩", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("lp-on-allowance"), typed(KEEP_LINE), fx("compacting")]);
    expect(r).toMatchObject({ outcome: "done", detail: "LP 开着，已开始压缩", keys: ["type:/compact", "enter"] });
  });

  test("LP 开不了（没撞墙）→ 不压缩", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("fresh-placeholder")]);
    expect(r.outcome).toBe("failed");
    expect(r.detail).toStartWith("开 LP：");
    expect(r.keys).toEqual([]);
  });
});

describe("同一个 agent 同时只跑一个批量动作", () => {
  test("第一个还没跑完，第二个直接跳过、不发键", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = fakeIO([fx("walled"), fx("lp-on-autocontinue")]);
    const slow: PaneIO = { ...first.io, capture: async (w) => (await gate, first.io.capture(w)) };
    const a = runOne({ kind: "lp-on" }, "agent-x", "master:=agent-x", ctxOf({ ...first, io: slow }));
    const second = fakeIO([fx("walled")]);
    const b = await runOne({ kind: "compact" }, "agent-x", "master:=agent-x", ctxOf(second));
    expect(b).toMatchObject({ outcome: "skipped", detail: "另一个批量动作正在处理它" });
    expect(second.keys).toEqual([]);
    release();
    expect((await a).outcome).toBe("done");
    const again = await runOne({ kind: "lp-on" }, "agent-x", "master:=agent-x", ctxOf(fakeIO([fx("lp-on-allowance")])));
    expect(again.outcome).toBe("skipped"); // 占用在第一个结束后释放：这次是「已经是开」
    expect(again.detail).toBe("已经是开");
  });
});

describe("自定义文本走 deliver", () => {
  test("送达 / 排队 / 失败", async () => {
    expect((await run({ kind: "text", text: "hi" }, [""])).outcome).toBe("done");
    expect((await run({ kind: "text", text: "hi" }, [""], async () => ({ ok: true, queued: true }))).outcome).toBe("queued");
    const f = await run({ kind: "text", text: "hi" }, [""], async () => ({ ok: false, error: "不在线" }));
    expect(f).toMatchObject({ outcome: "failed", detail: "不在线" });
    expect(f.keys).toEqual([]);
  });

  test("排队的说明按押后原因写：在忙 / 额度闸 / 停在额度菜单，都写明还没送到", async () => {
    const queued = async (heldBy?: "quota_wall" | "wall_menu") => (await run({ kind: "text", text: "hi" }, [""], async () => ({ ok: true, queued: true, heldBy }))).detail;
    expect(await queued()).toBe("它正在忙，这一轮结束后再投，还没送到");
    expect(await queued("quota_wall")).toBe("额度闸内（撞墙中），出闸后再投，还没送到");
    expect(await queued("wall_menu")).toBe("它停在额度菜单 / 撞墙等待上，没发键，之后再投，还没送到");
  });

  test("窗口不在时 CC 动作直接失败", async () => {
    const f = fakeIO([fx("walled")]);
    const r = await runOne({ kind: "lp-on" }, "agent-x", null, ctxOf(f));
    expect(r.outcome).toBe("failed");
    expect(f.keys).toEqual([]);
  });
});

describe("权限框 / AUQ / Rewind 挡着：五种按键动作一个键都不按", () => {
  for (const name of ["modal-permission", "modal-auq", "modal-rewind"]) {
    test(name, async () => {
      for (const kind of ["lp-on", "lp-off", "compact", "save-compact", "lp-compact"] as const) {
        const r = await run({ kind }, [fx(name)]);
        expect([kind, r.outcome, r.keys]).toEqual([kind, "failed", []]);
      }
    });
  }
});

test("撞墙等待、LP 没开：/compact 不发（发了也跑不动），与 T36 注入闸门同口径", async () => {
  const r = await run({ kind: "compact" }, [fx("walled")]);
  expect(r.outcome).toBe("failed");
  expect(r.keys).toEqual([]);
});

describe("可见区里有一段像输入框的文字（adv1 P0-1）：底部的菜单照样认得出，一个键都不发", () => {
  const rule = "─".repeat(60);
  const fakeBoxes = {
    缩进: [`  ${rule}`, "  ❯ ", `  ${rule}`, "  /low-priority to continue now at lower priority · uses your weekly limit"],
    顶格: [rule, "❯ ", rule, "  /low-priority to continue now at lower priority · uses your weekly limit"],
  };
  for (const [how, box] of Object.entries(fakeBoxes)) {
    for (const menu of ["menu-on-credits", "menu-no-lp", "menu-5-items"]) {
      test(`${how}假框 + ${menu}`, async () => {
        const raw = fx(menu).replace(/\n([^\n]*▔{8,})/, (_m, bar: string) => `\n${box.join("\n")}\n${bar}`);
        expect(raw).toContain("▔");
        expect(raw).toContain(box[1]!);
        for (const kind of ["compact", "save-compact", "lp-on", "lp-compact"] as const) {
          const r = await run({ kind, keep: K("保留 T35 的进度 3") }, [raw]);
          expect([kind, r.outcome, r.keys]).toEqual([kind, "failed", []]);
        }
      });
    }
  }
});

describe("开 LP 再压缩：Esc 放回输入框的字只清我们自己敲的 /low-priority（adv2 P2-1）", () => {
  const head = [fx("walled"), fx("lp-on-autocontinue")];
  const OTHER = "LP 已开；输入框里有别的内容，没清也没压缩";

  test("放回来的是别的字（可能是有人在打）→ 不按退格、不压缩，报失败（LP 那步成了，活没干完）", async () => {
    const r = await run({ kind: "lp-compact" }, [...head, typed("owner half typed")]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["line:/low-priority", "escape"] });
    expect(r.detail).toStartWith(OTHER);
  });

  test("多一个字、少一个字都不算：/low-priority 等一下、/low-priorit", async () => {
    for (const text of ["/low-priority 等一下", "/low-priorit"]) {
      const r = await run({ kind: "lp-compact" }, [...head, typed(text)]);
      expect([text, r.outcome, r.keys]).toEqual([text, "failed", ["line:/low-priority", "escape"]]);
      expect(r.detail).toStartWith(OTHER);
    }
  });

  test("提示符后面是 NBSP（真 CC）或普通空格，都认得出是我们的 /low-priority → 按 13 次退格", async () => {
    for (const sep of ["\u00a0", " "]) {
      const r = await run({ kind: "lp-compact" }, [...head, typed("/low-priority", sep), fx("lp-on-interrupted")]);
      expect([JSON.stringify(sep), r.keys.includes("erase:13")]).toEqual([JSON.stringify(sep), true]);
    }
  });

  test("行首多一个空格也不算（逐字比，不去空格）→ 不按退格（adv3 P2-1）", async () => {
    const r = await run({ kind: "lp-compact" }, [...head, typed(" /low-priority")]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["line:/low-priority", "escape"] });
    expect(r.detail).toStartWith(OTHER);
  });

  test("闸门第一帧是空、第二帧才冒出 /low-priority → 不是两帧都看到，不按退格（adv3 P2-2）", async () => {
    const empty = fx("lp-on-interrupted");
    const r = await run({ kind: "lp-compact" }, [...head, [empty, empty, restoredDraft]]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["line:/low-priority", "escape"] });
    expect(r.detail).toBe(`${OTHER}（两次抓屏之间输入框变了）`);
  });

  test("闸门第一帧是 /low-priority、第二帧有人接着打了字 → 不按退格", async () => {
    // Esc 之后这一段：等空闲读一帧，闸门再读两帧
    const r = await run({ kind: "lp-compact" }, [...head, [restoredDraft, restoredDraft, typed("/low-priority 我先补一句别清")]]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["line:/low-priority", "escape"] });
    expect(r.detail).toStartWith(OTHER);
  });

  test("按了退格没清干净（有人在同一瞬间打字）→ 报失败并带上剩下的字，不压缩、不报已执行", async () => {
    const r = await run({ kind: "lp-compact" }, [...head, restoredDraft, typed("/l")]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["line:/low-priority", "escape", "erase:13"] });
    expect(r.detail).toContain("还剩「/l」");
  });

  test("Esc 之后弹了权限框 → 一个键都不按", async () => {
    const r = await run({ kind: "lp-compact" }, [...head, fx("modal-permission")]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["line:/low-priority", "escape"] });
  });

  test("排队的消息 → 不清、不压缩，原因写「排队的消息」", async () => {
    const r = await run({ kind: "lp-compact" }, [...head, [fx("lp-on-interrupted"), fx("busy-queued")]]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["line:/low-priority", "escape"] });
    expect(r.detail).toContain("排队的消息");
  });
});

describe("发键前两次抓屏：第二帧变了就不发（r2 P2-6）", () => {
  test("压缩：第一帧空闲、输入框空，第二帧有人打了字 → 不发", async () => {
    const r = await run({ kind: "compact" }, [[fx("lp-on-interrupted"), typed("owner half typed")]]);
    expect(r).toMatchObject({ outcome: "failed", keys: [] });
    expect(r.detail).toContain("草稿");
  });

  test("关 LP：第一帧空闲，第二帧回合开始了 → 不发", async () => {
    const r = await run({ kind: "lp-off" }, [[fx("lp-on-allowance"), fx("lp-on-autocontinue")]]);
    expect(r).toMatchObject({ outcome: "failed", keys: [] });
    expect(r.detail).toContain("忙，未发");
  });

  test("开 LP 后只有一帧像在忙、复核两帧都空闲 → 不按 Esc", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), [fx("lp-on-autocontinue"), fx("lp-on-autocontinue"), fx("lp-on-allowance")], typed(KEEP_LINE), fx("compacting")]);
    expect(r.keys).toEqual(["line:/low-priority", "type:/compact", "enter"]);
  });

  test("空闲窗口正文里有「esc to interrupt」：开 LP 再压缩不按 Esc（adv2 P2-3）", async () => {
    const noisy = fx("lp-on-allowance").replace(/\n[^\n]*─{20,}[^\n]*\n[^\n]*❯[^\n]*\n/, (m) => `\n⏺ 判忙正则里有 esc to interrupt${m}`);
    expect(noisy).toContain("判忙正则");
    const r = await run({ kind: "lp-compact" }, [fx("walled"), noisy, typed(KEEP_LINE), fx("compacting")]);
    expect(r.keys).toEqual(["line:/low-priority", "type:/compact", "enter"]);
    expect(r.outcome).toBe("done");
  });
});

test("scrollback 里更早那条 /compact 的「Compacted」不能冒充这次的结果（adv1 P2-5）", async () => {
  // compacted 样本的画面上已经有一条带 Compacted 回显的 /compact；这次回车后画面没变（命令没进去）→ 不能报已开始
  const r = await run({ kind: "compact" }, [fx("compacted"), typed(KEEP_LINE, "\u00a0", "compacted"), fx("compacted")]);
  expect(r.keys).toEqual(["type:/compact", "enter"]);
  expect(r).toMatchObject({ outcome: "failed", detail: "发了 /compact，10 秒内没看到开始，需要人工看" });
});

describe("压缩走 T36 的 injectCompact：执行者、15 分钟守卫、长短档、字留在输入框", () => {
  const idle = fx("lp-on-interrupted");

  test("执行者的 save-compact 漏到这里也不会发：injectCompact 兜底改成带清单的 /compact（说明由 service 的 actionFor 加，见 fleet-plan.test.ts）", async () => {
    const r = await run({ kind: "save-compact" }, [idle, typed(KEEP_LINE), fx("compacting")], undefined, "agent-task-x");
    expect(r).toMatchObject({ outcome: "done", detail: "已开始压缩", keys: ["type:/compact", "enter"] });
  });

  test("窗口小到连 /compact 都放不下 → 跳过，一个键都不按，说明里写了拉大窗口", async () => {
    const f = fakeIO([idle]);
    const cap = f.deps.capture;
    f.deps.capture = async (t) => ({ ...(await cap(t))!, size: { width: 8, height: 3 } });
    const r = await runOne({ kind: "compact" }, "agent-x", "master:=agent-x", ctxOf(f));
    expect(r).toMatchObject({ outcome: "skipped", detail: "窗口 8×3太小，连 /compact 都放不下，已跳过（把窗口拉大就行）" });
    expect(f.keys).toEqual([]);
  });

  test("injectCompact 退了档（窗口放不下自定清单）：结果前面写明敲的是哪一档", async () => {
    const note = "窗口 60×10 放不下自定保留清单，退到默认保留清单";
    const r = await run({ kind: "compact" }, [[idle, idle, fx("compacting")]], undefined, "agent-x", {
      compact: async () => ({ status: "executed", line: "/compact 默认清单", note }),
    });
    expect(r).toMatchObject({ outcome: "done", detail: `${note}；已开始压缩`, keys: [] });
  });

  test("不是执行者：照发 /save-compact", async () => {
    const r = await run({ kind: "save-compact" }, [idle, typed("/save-compact"), fx("compacting")]);
    expect(r).toMatchObject({ outcome: "done", detail: "已开始（先存记忆再压缩）", keys: ["type:/save-compact", "enter"] });
  });

  test("15 分钟内刚注入过（自动压缩、手动按钮、上一次批量都算）→ 跳过，一个键都不按", async () => {
    expect((await run({ kind: "compact" }, [idle, typed(KEEP_LINE), fx("compacting")])).outcome).toBe("done");
    const r = await run({ kind: "compact" }, [idle]);
    expect(r).toMatchObject({ outcome: "skipped", detail: "15 分钟内刚注入过压缩，还要等 15 分钟", keys: [] });
    const lp = await run({ kind: "lp-compact" }, [fx("lp-on-allowance")]);
    expect(lp).toMatchObject({ outcome: "skipped", detail: "LP 开着，15 分钟内刚注入过压缩，还要等 15 分钟", keys: [] });
  });

  test("开 LP 再压缩、刚压过：只开 LP，不按 Esc 打断它自动开的续跑（打断了又不压，agent 会停着）", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-autocontinue")], undefined, "agent-x", { compactedRecently: async () => true });
    expect(r).toMatchObject({ outcome: "done", keys: ["line:/low-priority"] });
    expect(r.detail).toStartWith("LP 已开");
    expect(r.detail).toContain("15 分钟内刚注入过压缩，这次不压，也没打断它自动开的续跑");
  });

  test("敲完字输入框里对不上（有人同时在打）→ 不回车，失败并写明字还留在输入框里", async () => {
    const r = await run({ kind: "compact" }, [idle, typed(`${KEEP_LINE} owner 接着打的`)]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["type:/compact"] });
    expect(r.detail).toContain("没按回车");
    expect(r.detail).toContain("还留在输入框里");
  });

  test("敲完字弹了权限框 → 不回车；injectCompact 的原话已写明字留在输入框里，不再重复", async () => {
    const r = await run({ kind: "compact" }, [idle, fx("modal-permission")]);
    expect(r).toMatchObject({ outcome: "failed", keys: ["type:/compact"] });
    expect(r.detail.match(/留在输入框/g)).toHaveLength(1);
  });
});
