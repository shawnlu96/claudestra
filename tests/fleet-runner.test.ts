/**
 * bridge/fleet/runner.ts：用真实画面（tests/fixtures/lp/）回放，每次发键后切到下一帧，钉死发键顺序与安全边界：
 * 菜单只在高亮项精确等于「Continue now at lower priority」时回车；草稿、忙、状态不明一律不发键；Esc 只在确认有回合时按。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOne, type PaneIO, type RunCtx } from "../src/bridge/fleet/runner.js";
import type { FleetAction } from "../src/lib/fleet-plan.js";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "lp", `${name}.ansi`), "utf8");

/** frames[0] 是初始画面；每次 sendLine / press / escape 之后换成下一帧（没有下一帧就停在最后一帧） */
function fakeIO(frames: string[]) {
  const keys: string[] = [];
  let i = 0;
  const step = (k: string) => {
    keys.push(k);
    i = Math.min(i + 1, frames.length - 1);
  };
  const io: PaneIO = {
    capture: async () => frames[i]!,
    sendLine: async (_w, t) => step(`line:${t.split(" ")[0]}`),
    press: async (_w, k) => step(`press:${k}`),
    escape: async () => step("escape"),
    sleep: async () => {},
  };
  return { io, keys };
}

function ctxOf(io: PaneIO, text: RunCtx["deliverText"] = async () => ({ ok: true, queued: false })): RunCtx {
  return { io, keep: "保留测试", deliverText: text };
}
const run = (a: FleetAction, frames: string[], text?: RunCtx["deliverText"]) => {
  const f = fakeIO(frames);
  return runOne(a, "agent-x", "master:=agent-x", ctxOf(f.io, text)).then((r) => ({ ...r, keys: f.keys }));
};

/** 真实画面拼一个「LP 开着、输入框里有 Esc 放回来的字」的帧 */
const restoredDraft = fx("lp-on-interrupted").replace(/\x1b\[39m❯[^\S\n]*\n/, "\x1b[39m❯ /low-priority\n");
if (restoredDraft === fx("lp-on-interrupted")) throw new Error("fixture 的输入框行变了，restoredDraft 没拼出来");

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

  test("发了但 CC 回 isn't available → 失败并带回显原文", async () => {
    const r = await run({ kind: "lp-on" }, [fx("lp-off-resumable"), fx("fresh-unavailable")]);
    expect(r.outcome).toBe("failed");
    expect(r.detail).toContain("isn't available right now");
  });
});

describe("额度菜单", () => {
  test("光标在 Switch to usage credits → Up 一次、核对高亮是 LP 才回车", async () => {
    const r = await run({ kind: "lp-on" }, [fx("menu-on-credits"), fx("menu-on-lp"), fx("lp-on-autocontinue")]);
    expect(r.outcome).toBe("done");
    expect(r.keys).toEqual(["press:Up", "press:Enter"]);
  });

  test("导航后高亮还是 usage credits（菜单重绘了）→ Esc 退出，绝不回车", async () => {
    const r = await run({ kind: "lp-on" }, [fx("menu-on-credits"), fx("menu-on-credits"), fx("walled")]);
    expect(r.outcome).toBe("failed");
    expect(r.keys).toEqual(["press:Up", "escape"]);
    expect(r.keys).not.toContain("press:Enter");
  });

  test("菜单里没有 LP 项（只剩 Stop and wait / usage credits）→ 只按 Esc", async () => {
    const r = await run({ kind: "lp-on" }, [fx("menu-no-lp"), fx("walled")]);
    expect(r.outcome).toBe("failed");
    expect(r.keys).toEqual(["escape"]);
  });

  test("压缩类动作遇到菜单 → 不发键", async () => {
    const r = await run({ kind: "compact" }, [fx("menu-5-items")]);
    expect(r.outcome).toBe("failed");
    expect(r.keys).toEqual([]);
  });
});

describe("压缩", () => {
  test("空闲 → /compact → 看到开始压缩", async () => {
    const r = await run({ kind: "compact" }, [fx("lp-on-interrupted"), fx("compacting")]);
    expect(r).toMatchObject({ outcome: "done", detail: "已开始压缩" });
  });

  test("LP 下压缩先排队等算力（spinner 是 Working at lower priority，不是 Compacting）→ 也算已开始", async () => {
    const waiting = fx("lp-on-interrupted").replace(
      /\n[^\n]*─{20,}[^\n]*\n[^\n]*❯[^\n]*\n/,
      (m) => `\n❯ /compact 保留测试\n✻ Working at lower priority … · next try in 15s · attempt 2 · esc to interrupt${m}`,
    );
    expect(waiting).toContain("next try in 15s");
    const r = await run({ kind: "compact" }, [fx("lp-on-interrupted"), waiting]);
    expect(r).toMatchObject({ outcome: "done", detail: "已开始压缩" });
  });

  test("对话太短 → 已跳过", async () => {
    const r = await run({ kind: "compact" }, [fx("lp-on-interrupted"), fx("compact-too-short")]);
    expect(r).toMatchObject({ outcome: "skipped", detail: "对话太短，不用压缩" });
  });

  test("忙 → 照发，报已排队", async () => {
    const r = await run({ kind: "compact" }, [fx("busy-queued"), fx("busy-queued")]);
    expect(r.outcome).toBe("queued");
  });

  test("正在压缩 → 跳过", async () => {
    const r = await run({ kind: "save-compact" }, [fx("compacting")]);
    expect(r).toMatchObject({ outcome: "skipped", detail: "正在压缩" });
    expect(r.keys).toEqual([]);
  });
});

describe("开 LP 再压缩", () => {
  test("开 → 自动续跑开始 → Esc 打断 → /compact", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-autocontinue"), fx("lp-on-interrupted"), fx("compacting")]);
    expect(r).toMatchObject({ outcome: "done", detail: "LP 开着，已开始压缩" });
    expect(r.keys).toEqual(["line:/low-priority", "escape", "line:/compact"]);
  });

  test("Esc 放回输入框的字要先 C-u 清掉，清干净才压缩", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-autocontinue"), restoredDraft, fx("lp-on-interrupted"), fx("compacting")]);
    expect(r.outcome).toBe("done");
    expect(r.keys).toEqual(["line:/low-priority", "escape", "press:C-u", "line:/compact"]);
  });

  test("续跑已经自己结束了（没看到忙）→ 不按 Esc", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-allowance"), fx("compacting")]);
    expect(r.outcome).toBe("done");
    expect(r.keys).toEqual(["line:/low-priority", "line:/compact"]);
  });

  test("开了 LP、但对话太短没压缩 → 仍算已执行（LP 确实开了）", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("walled"), fx("lp-on-allowance"), fx("compact-too-short")]);
    expect(r).toMatchObject({ outcome: "done", detail: "LP 已开，对话太短，不用压缩" });
  });

  test("LP 已经开着 → 直接压缩", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("lp-on-allowance"), fx("compacting")]);
    expect(r.keys).toEqual(["line:/compact"]);
  });

  test("LP 开不了（没撞墙）→ 不压缩", async () => {
    const r = await run({ kind: "lp-compact" }, [fx("fresh-placeholder")]);
    expect(r.outcome).toBe("failed");
    expect(r.detail).toStartWith("开 LP：");
    expect(r.keys).toEqual([]);
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

  test("窗口不在时 CC 动作直接失败", async () => {
    const f = fakeIO([fx("walled")]);
    const r = await runOne({ kind: "lp-on" }, "agent-x", null, ctxOf(f.io));
    expect(r.outcome).toBe("failed");
    expect(f.keys).toEqual([]);
  });
});
