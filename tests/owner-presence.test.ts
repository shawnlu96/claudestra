/** owner 在不在（lib/owner-presence.ts） */
import { expect, test } from "bun:test";
import { ACTIVE_WINDOW_MS, HEARTBEAT_STALE_MS, OwnerPresence } from "../src/lib/owner-presence.js";

function clock() {
  let now = 1_000_000;
  return { now: () => now, tick: (ms: number) => void (now += ms) };
}

test("没有任何信号 → away（bridge 刚重启时宁可多推）", () => {
  expect(new OwnerPresence(clock().now).state()).toBe("away");
});

test("动作后 5 分钟内算在；过了就不在", () => {
  const c = clock();
  const p = new OwnerPresence(c.now);
  p.touch();
  c.tick(ACTIVE_WINDOW_MS - 1);
  expect(p.state()).toBe("active");
  c.tick(1);
  expect(p.state()).toBe("away");
});

test("任一设备可见且心跳没过期 → 在；心跳断了（锁屏时 JS 冻住）就不算", () => {
  const c = clock();
  const p = new OwnerPresence(c.now);
  p.setVisible("desk", true);
  p.setVisible("phone", false);
  expect(p.state()).toBe("active");
  c.tick(HEARTBEAT_STALE_MS);
  expect(p.state()).toBe("away");
});

test("刚发完消息就切后台 → 不在（hidden 晚于最后一次动作）；之后在 Discord 说话又算在", () => {
  const c = clock();
  const p = new OwnerPresence(c.now);
  p.touch();
  c.tick(1000);
  p.setVisible("phone", false);
  expect(p.state()).toBe("away");
  c.tick(1000);
  p.touch();
  expect(p.state()).toBe("active");
});
