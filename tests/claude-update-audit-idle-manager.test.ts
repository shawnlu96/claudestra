/**
 * hardening-CCIDLE1 manager 侧：`restart --idle-only <身份> -- <名>` 在重启锁里、开始退出前的复核（src/manager/restart-idle.ts）。
 * 合成端口，不碰真 registry / tmux / bridge。
 */
import { describe, expect, test } from "bun:test";
import { idleOnlyArg, idleSkip, restartArgsRefusal, markIdleSkips, paneActivity, type Activity, type IdlePorts } from "../src/manager/restart-idle.js";

const RULE = "─".repeat(52);
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const CC_BUSY = ["✶ Processing… (2m 12s · ↓ 7.8k tokens)", "", CC_IDLE].join("\n");
const WANT = JSON.stringify({ sessionId: "s-1", windows: ["@7"] });

/** 读取序列可编程的端口：每次读 session / windows / activity 时先跑 hook(第 n 次读) */
function ports(init: { session?: string; windows?: string[]; activity?: Activity }) {
  const st = { session: init.session ?? "s-1", windows: init.windows ?? ["@7"], activity: init.activity ?? ("idle" as Activity), reads: 0 };
  let hook: (n: number) => void = () => {};
  const p: IdlePorts = {
    session: () => (hook(++st.reads), st.session),
    windows: async () => (hook(++st.reads), st.windows),
    activity: async () => (hook(++st.reads), st.activity),
  };
  return { st, p, onRead: (h: (n: number) => void) => { hook = h; } };
}

describe("[验收线 2] 复核：身份 → 活动 → 身份 → 活动，任何一步不对都跳过", () => {
  test("稳定空闲：放行（null），读满四步", async () => {
    const f = ports({});
    expect(await idleSkip("agent-a", WANT, f.p)).toBeNull();
    expect(f.st.reads).toBe(6); // session+windows、activity、session+windows、activity
  });

  test("在忙 / 读不出 → 跳过", async () => {
    expect((await idleSkip("agent-a", WANT, ports({ activity: "busy" }).p))?.skipped).toContain("在忙");
    expect((await idleSkip("agent-a", WANT, ports({ activity: "unknown" }).p))?.skipped).toContain("读不出");
  });

  test("会话 / 窗口跟计划时不一样 → 跳过", async () => {
    expect((await idleSkip("agent-a", WANT, ports({ session: "s-2" }).p))?.skipped).toContain("会话换了");
    expect((await idleSkip("agent-a", WANT, ports({ windows: ["@8"] }).p))?.skipped).toContain("窗口换了");
    expect((await idleSkip("agent-a", WANT, ports({ windows: ["@7", "@9"] }).p))?.skipped).toContain("窗口换了");
  });

  test("最后一次读取期间换 session → 跳过", async () => {
    const f = ports({});
    f.onRead((n) => { if (n === 4) f.st.session = "s-new"; }); // 第二轮身份读取
    expect((await idleSkip("agent-a", WANT, f.p))?.skipped).toContain("会话换了");
  });

  test("最后一次活动读取期间开始回合 → 跳过", async () => {
    const f = ports({});
    f.onRead((n) => { if (n === 6) f.st.activity = "busy"; });
    expect((await idleSkip("agent-a", WANT, f.p))?.skipped).toContain("在忙");
  });

  test("读失败一律跳过；身份 JSON 坏了也跳过", async () => {
    const f = ports({});
    f.p.activity = async () => { throw new Error("tmux 没响应"); };
    expect((await idleSkip("agent-a", WANT, f.p))?.skipped).toContain("复核读失败");
    expect((await idleSkip("agent-a", "{bad", ports({}).p))?.skipped).toContain("不合法");
  });

  test("没带 --idle-only：什么都不读（人工 restart 语义不变）", async () => {
    const f = ports({});
    expect(await idleSkip("agent-a", undefined, f.p)).toBeNull();
    expect(f.st.reads).toBe(0);
  });

  test("复核通过前就被拒（锁被占）记 skipped；通过之后的失败照旧是失败；不带标志原样返回", async () => {
    await idleSkip("agent-ok", WANT, ports({}).p);
    const rows: { name: string; ok: boolean; error?: string; skipped?: string }[] = [{ name: "agent-lock", ok: false, error: "另一个 restart 正在进行，已跳过" }, { name: "agent-ok", ok: false, error: "启动超时" }];
    const out = markIdleSkips(rows, WANT);
    expect(out[0].skipped).toContain("复核前已拒");
    expect(out[1].skipped).toBeUndefined();
    expect(markIdleSkips(rows, undefined)).toBe(rows);
  });
});

describe("参数：只认单个名字，不做全员、不混用别的重启模式", () => {
  test("idleOnlyArg / restartArgsRefusal（不带 --idle-only 时原有拒绝原样）", () => {
    const idleOnlyRefusal = (a: string[]) => restartArgsRefusal(a, a[a.indexOf("--") + 1] || undefined, a.includes("--include-master"), false);
    expect(idleOnlyArg(["restart-x"])).toBeUndefined();
    expect(idleOnlyArg(["--idle-only", WANT, "--", "a"])).toBe(WANT);
    expect(idleOnlyArg(["--idle-only", WANT])).toBe(""); // 没有 `-- <名>` = 全员，拒
    expect(idleOnlyRefusal(["--idle-only", WANT])).toContain("单个 agent");
    expect(idleOnlyRefusal(["--idle-only", WANT, "--include-master", "--", "a"])).toContain("不能和");
    expect(idleOnlyRefusal(["--idle-only", WANT, "--expect", "{}", "--", "a"])).toContain("不能和");
    expect(idleOnlyRefusal(["--idle-only", WANT, "--", "a"])).toBeNull();
    expect(restartArgsRefusal(["a"], "a", false, false)).toBeNull();
    expect(restartArgsRefusal(["--include-master", "a"], "a", true, false)).toContain("只能用于全体重启");
    expect(restartArgsRefusal(["master"], "master", false, true)).toContain("大总管由 launcher 守护");
    expect(restartArgsRefusal(["--include-master"], undefined, true, false)).toBeNull();
  });
});

describe("画面活动：说不准就不算空闲", () => {
  test("CC 空闲 / 在跑 / 空画面", () => {
    expect(paneActivity(undefined, CC_IDLE)).toBe("idle");
    expect(paneActivity(undefined, CC_BUSY)).toBe("busy");
    expect(paneActivity(undefined, "  \n")).toBe("unknown");
  });
});
