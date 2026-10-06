import { describe, expect, test } from "bun:test";
import { peerSecretHit } from "../src/lib/peer-secret-gate.js";
import { OrderRenderError, redactOrderForPeer, renderOrderWire } from "../src/lib/order-wire-render.js";
import { orderWireOf } from "../src/lib/order-wire.js";

const wire = (input: string) => orderWireOf({
  taskId: "dispatch-recovery-G1", specRev: 1, head: null, round: 0, node: "write", step: "write", dedupKey: "g1-sk-test",
  inputs: [input], outputs: ["分支提交"], acceptance: ["边界回归"], writeBack: "调用 deliver", findings: [], fallbackWarning: null,
}, { repo: "owner/repo", pr: null, dagVersion: 1 });

describe("peer secret gate: sk left boundary", () => {
  test("ordinary agent names and directly attached alphanumerics pass both exits", () => {
    for (const input of ["agent-task-dispatch-recovery-r1", "agent-task-bg-shell-state-fix",
      "xsk-" + "x".repeat(16), "7sk-" + "x".repeat(16)]) {
      expect(peerSecretHit(input), input).toBeNull();
      expect(() => redactOrderForPeer(wire(input), null)).not.toThrow();
      expect(() => renderOrderWire(wire(input), { audience: "peer", ledgerHead: null })).not.toThrow();
    }
  });

  // Lowercase synthetic payloads isolate prefix detection from random / hex rules.
  test("real shapes after original boundaries refuse even when split across whitespace", () => {
    const secret = "sk-" + "x".repeat(16);
    const shapes = [secret, "s k-" + "x".repeat(16), "sk -" + "x".repeat(16),
      secret.slice(0, 11) + " \t\n" + secret.slice(11), ...[" ", "\n", "\t"].map((blank) => [...secret].join(blank))];
    for (const before of ["", "\n", " ", "=", ":", "：", "\"", "'", "`", "-", "_", "review ", "review\n", "7\t"]) {
      for (const shape of shapes) {
        const input = before + shape;
        expect(peerSecretHit(input), input).toBe("密钥前缀");
        expect(() => redactOrderForPeer(wire(input), null)).toThrow(OrderRenderError);
        expect(() => renderOrderWire(wire(input), { audience: "peer", ledgerHead: null })).toThrow(OrderRenderError);
      }
    }
  });

  test("the sk payload threshold stays sixteen and other prefix boundaries stay unrestricted", () => {
    expect(peerSecretHit("sk-" + "x".repeat(15))).toBeNull();
    for (const prefix of ["ghp_" + "x".repeat(20), "xoxb-" + "x".repeat(10), "AKIA" + "X".repeat(16), "tok_" + "x".repeat(8)]) {
      for (const input of ["a" + prefix, "a " + [...prefix].join("\t")]) expect(peerSecretHit(input)).toBe("密钥前缀");
    }
  });
});
