import { expect, test } from "bun:test";
import { ORDER_TOOLS, orderTool } from "../src/lib/order-tools.js";
import { parseVerdictWire } from "../src/lib/order-wire.js";

test("display guidance leaves formal schema and submitted findings/reportPath intact", async () => {
  const tool = ORDER_TOOLS.find((t) => t.name === "submit_verdict")!;
  const schema = tool.inputSchema as any;
  expect(schema.properties.head.description).toBe("审查单上的完整 head SHA");
  expect(schema.properties.orderId.description).toBe("take_review 返回的 orderId");
  expect(schema.properties.reportPath.description).toBe("报告的绝对路径，放在 ledger/reviews/ 下，非空");
  expect(schema.properties.findings.items.required).toEqual(["findingId", "family", "severity", "probe", "description"]);
  expect(schema.required).toEqual(["v", "orderId", "head", "verdict", "p0", "p1", "p2", "findings", "reportPath"]);
  const original = {
    v: 1, orderId: "T1:review:r1", head: "b".repeat(40), verdict: "changes", p0: 0, p1: 1, p2: 0,
    findings: [{ findingId: "evidence", family: "correctness", severity: "P1" as const,
      probe: "[验收线 1] /tmp/evidence/Q7mB2pL9rX4cN6vT8sJ1kH5wZ3yD0fG2/probe.log",
      description: "审查会话 Q7mB2pL9rX4cN6vT8sJ1kH5wZ3yD0fG2" }],
    reportPath: "/tmp/evidence/ledger/reviews/T1-r1.md",
  };
  const before = JSON.stringify(original);
  const parsed = parseVerdictWire(original);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value.head).toBe(original.head);
  expect(parsed.value.orderId).toBe(original.orderId);
  expect(parsed.value.reportPath).toBe(original.reportPath);
  expect(parsed.value.findings).toEqual(original.findings);
  let forwarded: unknown;
  await orderTool(async (msg) => { forwarded = msg; return { ok: true }; }, "submit_verdict", original);
  expect(forwarded).toEqual({ type: "order_tool", tool: "submit_verdict", args: original });
  expect(JSON.stringify(original)).toBe(before);
  expect(parseVerdictWire({ ...original, head: original.head.slice(0, 8) }).ok).toBe(false);
});
