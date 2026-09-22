import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildNotifyMessage, notify, notifyTargetVerdict } from "../src/lib/notify";

const CTRL = "111111111111111111";
const AGENT = "222222222222222222";

describe("notifyTargetVerdict", () => {
  const ctx = { controlChannelId: CTRL, knownChannelIds: [AGENT, "local-abc"] };

  test("control / 已登记频道放行且 known", () => {
    expect(notifyTargetVerdict(CTRL, ctx)).toEqual({ ok: true, known: true });
    expect(notifyTargetVerdict(AGENT, ctx)).toEqual({ ok: true, known: true });
    expect(notifyTargetVerdict("local-abc", ctx)).toEqual({ ok: true, known: true });
  });

  test("未登记的 Discord 频道（cron --channel）放行但 known=false——bridge 不发 SSE", () => {
    expect(notifyTargetVerdict("333333333333333333", ctx)).toEqual({ ok: true, known: false });
  });

  test("api:* / 未登记 local-* / 空值一律拒（bce6351 堵的洞不重开）", () => {
    expect(notifyTargetVerdict("api:tok123", ctx).ok).toBe(false);
    expect(notifyTargetVerdict("local-zzz", ctx).ok).toBe(false);
    expect(notifyTargetVerdict("", ctx).ok).toBe(false);
    expect(notifyTargetVerdict(undefined, ctx).ok).toBe(false);
  });
});

describe("notify", () => {
  test("消息体是 notify 而不是 reply", () => {
    const m = buildNotifyMessage({ source: "launcher", chatId: CTRL, text: "hi" });
    expect(m.type).toBe("notify");
    expect(m).not.toHaveProperty("components");
  });

  test("发送成功返回 true，不留未送达记录", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-"));
    const logFile = join(dir, "undelivered.log");
    const sent: any[] = [];
    const ok = await notify({ source: "cron", chatId: CTRL, text: "t" }, { send: async (m) => { sent.push(m); }, logFile });
    expect(ok).toBe(true);
    expect(sent[0].type).toBe("notify");
    expect(existsSync(logFile)).toBe(false);
  });

  test("发送失败不抛、返回 false、写一行 JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-"));
    const logFile = join(dir, "sub", "undelivered.log");
    const origErr = console.error;
    console.error = () => {};
    try {
      const ok = await notify(
        { source: "launcher", chatId: CTRL, text: "金丝雀失败" },
        { send: async () => { throw new Error("已拒绝投递"); }, logFile },
      );
      expect(ok).toBe(false);
    } finally {
      console.error = origErr;
    }
    const rec = JSON.parse(readFileSync(logFile, "utf-8").trim());
    expect(rec.source).toBe("launcher");
    expect(rec.reason).toContain("已拒绝投递");
    expect(rec.text).toBe("金丝雀失败");
  });

  test("chatId 为空也留痕", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-"));
    const logFile = join(dir, "undelivered.log");
    const ok = await notify({ source: "launcher", chatId: "", text: "x" }, { send: async () => {}, logFile });
    expect(ok).toBe(false);
    expect(readFileSync(logFile, "utf-8")).toContain("chatId 为空");
  });
});

describe("守门：daemon 不许再用 reply 发系统通知", () => {
  // reply 要求可识别的来源 agent（bce6351），daemon 连接没有——用了就会被拒并静默丢失
  for (const f of ["launcher.ts", "cron.ts", "manager.ts"]) {
    test(f, () => {
      const src = readFileSync(join(import.meta.dir, "..", "src", f), "utf-8");
      expect(src).not.toMatch(/type:\s*"reply"/);
    });
  }
});
