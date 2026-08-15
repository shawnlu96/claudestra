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
const msg = (id: string, content = "hi") => ({ id, channelId: "chan1", content, author: { id: ME } });

beforeEach(() => {
  _resetSelfEchoState();
  setBotUserId(ME);
});

describe("noteSelfMessage", () => {
  test("本实例自己发的消息 → 不计账、不告警", () => {
    for (const id of ["m1", "m2", "m3", "m4"]) {
      trackSentMessage(id);
      expect(noteSelfMessage(msg(id))).toBeNull();
    }
  });

  test("别人拿同一个 token 发的：不到阈值不报，第 3 条才报", () => {
    expect(noteSelfMessage(msg("x1"))).toBeNull();
    expect(noteSelfMessage(msg("x2"))).toBeNull();
    const alert = noteSelfMessage(msg("x3", "🔌 agent-foo 的 Claude Code 已退出（掉线）"));
    expect(alert).not.toBeNull();
    expect(alert!.count).toBe(3);
    expect(alert!.samples.length).toBe(3);
    expect(alert!.samples[2].preview).toContain("已退出");
  });

  test("报过之后进冷却，不会每来一条报一条", () => {
    for (const id of ["y1", "y2"]) noteSelfMessage(msg(id));
    expect(noteSelfMessage(msg("y3"))).not.toBeNull();
    expect(noteSelfMessage(msg("y4"))).toBeNull();
    expect(noteSelfMessage(msg("y5"))).toBeNull();
  });

  test("别人（真人/别的 bot）的消息完全不参与", () => {
    expect(noteSelfMessage({ id: "z1", channelId: "c", content: "hi", author: { id: "999" } })).toBeNull();
  });

  test("自己发的和外来的混在一起：只有外来的计数", () => {
    trackSentMessage("ok1");
    expect(noteSelfMessage(msg("ok1"))).toBeNull();
    expect(noteSelfMessage(msg("f1"))).toBeNull();
    trackSentMessage("ok2");
    expect(noteSelfMessage(msg("ok2"))).toBeNull();
    expect(noteSelfMessage(msg("f2"))).toBeNull();
    expect(noteSelfMessage(msg("f3"))).not.toBeNull(); // 第 3 条外来
  });

  test("预览会压掉换行,避免一条消息把日志撑成一屏", () => {
    for (const id of ["p1", "p2"]) noteSelfMessage(msg(id));
    const a = noteSelfMessage(msg("p3", "第一行\n第二行\n\n第三行"));
    expect(a!.samples[2].preview).toBe("第一行 第二行 第三行");
  });
});
