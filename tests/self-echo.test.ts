/**
 * v2.19.0 自我消息对账单测。
 *
 * 2026-08-15：另一台机器拿着同一个 bot token 往本机频道发了 8 条假告警，定位
 * 花了两个多小时。Discord 会把 bot 自己发的消息也推给**每一条**网关连接，所以
 * 「author 是我、但 id 不在我刚发出去的集合里」是一个免费且确定的第二实例信号。
 *
 * 这里锁住两个方向：
 *  - 自己发的绝不能被当成外来（否则天天假警，很快就没人看了）；
 *  - 攒够阈值才报，且报完进冷却（不能自己变成新的刷屏源）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { noteSelfMessage, _resetSelfEchoState } from "../src/bridge/self-echo.js";
import { trackSentMessage, setBotUserId } from "../src/bridge/discord-api.js";

const ME = "1485860782322356244";
const NO_WAIT = { recheckMs: 0 };
const msg = (id: string, content = "hi") => ({ id, channelId: "chan1", content, author: { id: ME } });

beforeEach(() => {
  _resetSelfEchoState();
  setBotUserId(ME);
  // 告警在生产里默认关着（记账修好前只观察）；单测要验的正是告警判定本身
  process.env.CLAUDESTRA_SELF_ECHO_ALERT = "1";
});

describe("noteSelfMessage", () => {
  test("本实例自己发的消息 → 不计账、不告警", async () => {
    for (const id of ["m1", "m2", "m3", "m4"]) {
      trackSentMessage(id);
      expect(await noteSelfMessage(msg(id), NO_WAIT)).toBeNull();
    }
  });

  test("别人拿同一个 token 发的：不到阈值不报，第 3 条才报", async () => {
    expect(await noteSelfMessage(msg("x1"), NO_WAIT)).toBeNull();
    expect(await noteSelfMessage(msg("x2"), NO_WAIT)).toBeNull();
    const alert = await noteSelfMessage(msg("x3", "🔌 agent-foo 的 Claude Code 已退出（掉线）"), NO_WAIT);
    expect(alert).not.toBeNull();
    expect(alert!.count).toBe(3);
    expect(alert!.samples.length).toBe(3);
    expect(alert!.samples[2].preview).toContain("已退出");
  });

  test("报过之后进冷却，不会每来一条报一条", async () => {
    for (const id of ["y1", "y2"]) await noteSelfMessage(msg(id), NO_WAIT);
    expect(await noteSelfMessage(msg("y3"), NO_WAIT)).not.toBeNull();
    expect(await noteSelfMessage(msg("y4"), NO_WAIT)).toBeNull();
    expect(await noteSelfMessage(msg("y5"), NO_WAIT)).toBeNull();
  });

  test("别人（真人/别的 bot）的消息完全不参与", async () => {
    expect(await noteSelfMessage({ id: "z1", channelId: "c", content: "hi", author: { id: "999" } }, NO_WAIT)).toBeNull();
  });

  test("自己发的和外来的混在一起：只有外来的计数", async () => {
    trackSentMessage("ok1");
    expect(await noteSelfMessage(msg("ok1"), NO_WAIT)).toBeNull();
    expect(await noteSelfMessage(msg("f1"), NO_WAIT)).toBeNull();
    trackSentMessage("ok2");
    expect(await noteSelfMessage(msg("ok2"), NO_WAIT)).toBeNull();
    expect(await noteSelfMessage(msg("f2"), NO_WAIT)).toBeNull();
    expect(await noteSelfMessage(msg("f3"), NO_WAIT)).not.toBeNull(); // 第 3 条外来
  });

  test("预览会压掉换行,避免一条消息把日志撑成一屏", async () => {
    for (const id of ["p1", "p2"]) await noteSelfMessage(msg(id), NO_WAIT);
    const a = await noteSelfMessage(msg("p3", "第一行\n第二行\n\n第三行"), NO_WAIT);
    expect(a!.samples[2].preview).toBe("第一行 第二行 第三行");
  });
});

// ── 2026-08-16 上线当天的回归：网关回声比 HTTP 响应先到 ────────────────
// `channel.send()` 的 await 还没返回(拿不到 id,也就无从记账),MESSAGE_CREATE
// 已经推过来了。于是「id 不在集合里」对**每一条**自己发的消息都成立——
// 探测器把自己发出的告警也算成了第二实例。修法是延迟复核。
describe("回声先于 HTTP 响应到达（真实竞态）", () => {
  test("回声到达时还没记账，但复核窗口内补上了 → 不算外来", async () => {
    const late = "late-1";
    // 模拟：50ms 后 HTTP 响应才回来并记账
    setTimeout(() => trackSentMessage(late), 50);
    expect(await noteSelfMessage(msg(late), { recheckMs: 200 })).toBeNull();
  });

  test("复核窗口过后仍然没记账 → 才算外来", async () => {
    expect(await noteSelfMessage(msg("never-tracked"), { recheckMs: 20 })).toBeNull(); // 第 1 条,未到阈值
  });
});
