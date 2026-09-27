import { describe, expect, test } from "bun:test";
import { dropAgentFromPeerScopes, peersSharingAgent, scopeGateError } from "../src/lib/peer-scope-gate";

const reg = { "agent-open": { external: true }, "agent-priv": { external: null }, "agent-off": { external: false } };

describe("scopeGateError（peer 共享的 external 正式闸门）", () => {
  test("全部已开闸 → 通过；裸名与带前缀都认", () => {
    expect(scopeGateError(["open"], reg)).toBeNull();
    expect(scopeGateError(["agent-open"], reg)).toBeNull();
  });
  test("未开闸（null / false）→ 拦，且指向会话详情", () => {
    expect(scopeGateError(["open", "priv"], reg)).toContain('"priv" 未开启 external');
    expect(scopeGateError(["off"], reg)).toContain("会话详情");
  });
  test("* 与 master 一律拦；不存在的 agent 报不存在", () => {
    expect(scopeGateError(["*"], reg)).toContain('"*"');
    expect(scopeGateError(["master"], reg)).toContain("大总管");
    expect(scopeGateError(["ghost"], reg)).toContain("不存在");
  });
});

describe("peersSharingAgent / dropAgentFromPeerScopes", () => {
  const mk = () => [
    { peer: "A", agents: ["open", "priv"] },
    { peer: "B", agents: ["*"] },
    { peer: "C", agents: ["agent-open"], disabled: true },
    { peer: null, agents: ["open"] },
    { peer: "D", agents: ["other"] },
  ];
  test("列出有效 peer scope 里含它的 peer（含 *），禁用的与非 peer 的 token 不算", () => {
    expect(peersSharingAgent(mk(), "open")).toEqual(["A", "B"]);
    expect(peersSharingAgent(mk(), "agent-priv")).toEqual(["A", "B"]);
    expect(peersSharingAgent(mk(), "nobody")).toEqual(["B"]);
  });
  test("摘除只动显式列名的有效 peer token；* 不动；返回改过的 peer", () => {
    const ps = mk();
    expect(dropAgentFromPeerScopes(ps, "open")).toEqual(["A"]);
    expect(ps[0].agents).toEqual(["priv"]);
    expect(ps[1].agents).toEqual(["*"]);
    expect(ps[2].agents).toEqual(["agent-open"]);
  });
});
