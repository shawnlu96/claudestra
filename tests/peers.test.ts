/**
 * lib/peers.ts 的纯逻辑测试：encodePeerEvent / parsePeerEvent /
 * effectivePeerMode。
 *
 * 其他涉及 ~/.claude-orchestrator/peers.json 读写的函数（readPeers /
 * addExposure 等）依赖文件系统，不在这里测。
 */

import { describe, test, expect } from "bun:test";
import {
  encodePeerEvent,
  parsePeerEvent,
  effectivePeerMode,
  DEFAULT_PEER_MODE,
  type PeerEvent,
} from "../src/lib/peers.ts";

describe("effectivePeerMode", () => {
  test("mode='direct' → direct", () => {
    expect(effectivePeerMode({ mode: "direct" })).toBe("direct");
  });

  test("mode='via_master' → via_master", () => {
    expect(effectivePeerMode({ mode: "via_master" })).toBe("via_master");
  });

  test("没有 mode 字段 → via_master（旧 exposure 兼容）", () => {
    expect(effectivePeerMode({})).toBe("via_master");
  });

  test("mode 是未知值 → via_master", () => {
    expect(effectivePeerMode({ mode: "weird" })).toBe("via_master");
  });

  test("DEFAULT_PEER_MODE 跟老 entry 兼容默认不是同一个", () => {
    // 设计意图：新写入 exposure 默认 "direct"，但读取无 mode 字段的老 exposure
    // 行为还是 "via_master"（向下兼容）
    expect(DEFAULT_PEER_MODE).toBe("direct");
    expect(effectivePeerMode({})).toBe("via_master");
  });
});

describe("encodePeerEvent", () => {
  test("基本 grant 带 exchange + mode", () => {
    const s = encodePeerEvent({
      kind: "grant",
      local: "orchestrator",
      peer: "123",
      purpose: "咨询",
      exchange: "456",
      mode: "direct",
    });
    expect(s).toContain("kind=grant");
    expect(s).toContain("local=orchestrator");
    expect(s).toContain("peer=123");
    expect(s).toContain(`purpose="咨询"`);
    expect(s).toContain("exchange=456");
    expect(s).toContain("mode=direct");
    expect(s.startsWith("<!-- CLAUDESTRA_PEER_EVENT ")).toBe(true);
    expect(s.endsWith(" -->")).toBe(true);
  });

  test("revoke 不带 exchange / purpose / mode", () => {
    const s = encodePeerEvent({
      kind: "revoke",
      local: "orchestrator",
      peer: "all",
    });
    expect(s).toContain("kind=revoke");
    expect(s).toContain("peer=all");
    expect(s).not.toContain("purpose=");
    expect(s).not.toContain("exchange=");
    expect(s).not.toContain("mode=");
  });

  test("purpose 里的 `\"` 会被替换成 `'`（防破坏引号解析）", () => {
    const s = encodePeerEvent({
      kind: "grant",
      local: "foo",
      peer: "bar",
      purpose: `含 "双引号" 的描述`,
    });
    expect(s).toContain(`purpose="含 '双引号' 的描述"`);
  });
});

describe("parsePeerEvent", () => {
  test("解析 grant 完整字段", () => {
    const src = encodePeerEvent({
      kind: "grant",
      local: "orchestrator",
      peer: "123",
      purpose: "咨询",
      exchange: "456",
      mode: "direct",
    });
    const parsed = parsePeerEvent(src);
    expect(parsed).toEqual({
      kind: "grant",
      local: "orchestrator",
      peer: "123",
      purpose: "咨询",
      exchange: "456",
      mode: "direct",
    });
  });

  test("解析 revoke", () => {
    const src = encodePeerEvent({ kind: "revoke", local: "foo", peer: "all" });
    const parsed = parsePeerEvent(src);
    expect(parsed?.kind).toBe("revoke");
    expect(parsed?.local).toBe("foo");
    expect(parsed?.peer).toBe("all");
  });

  test("解析 hello", () => {
    const src = encodePeerEvent({ kind: "hello", local: "mybot", peer: "all" });
    expect(parsePeerEvent(src)?.kind).toBe("hello");
  });

  test("未知 kind 返回 null", () => {
    expect(parsePeerEvent(
      `<!-- CLAUDESTRA_PEER_EVENT kind=blah local=x peer=y -->`
    )).toBeNull();
  });

  test("缺必需字段（kind/local/peer）返回 null", () => {
    expect(parsePeerEvent(
      `<!-- CLAUDESTRA_PEER_EVENT kind=grant local=x -->`
    )).toBeNull();
    expect(parsePeerEvent(
      `<!-- CLAUDESTRA_PEER_EVENT local=x peer=y -->`
    )).toBeNull();
  });

  test("不含 event marker 的文本返回 null", () => {
    expect(parsePeerEvent("普通消息")).toBeNull();
    expect(parsePeerEvent("<!-- 别的 HTML 注释 -->")).toBeNull();
    expect(parsePeerEvent("")).toBeNull();
  });

  test("mode 是未知值时 → mode=undefined（而非抛错）", () => {
    const parsed = parsePeerEvent(
      `<!-- CLAUDESTRA_PEER_EVENT kind=grant local=x peer=y mode=weird -->`
    );
    expect(parsed?.mode).toBeUndefined();
  });

  test("event marker 在文本中间也能解析到", () => {
    const msg = `<@12345> 普通问候\n\n<!-- CLAUDESTRA_PEER_EVENT kind=grant local=foo peer=bar -->\n\n 尾巴`;
    const parsed = parsePeerEvent(msg);
    expect(parsed?.kind).toBe("grant");
    expect(parsed?.local).toBe("foo");
  });

  test("encode → parse round trip 保字段", () => {
    const original: PeerEvent = {
      kind: "grant",
      local: "a",
      peer: "b",
      purpose: "c",
      exchange: "d",
      mode: "via_master",
    };
    const decoded = parsePeerEvent(encodePeerEvent(original));
    expect(decoded).toEqual(original);
  });
});
