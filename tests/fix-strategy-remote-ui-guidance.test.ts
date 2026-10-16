/** UIEVID2 [验收线 1]：换家族收敛单（cv）挂给 peer 时，ui 卡的 wire 与渲染正文都带出借截图指引，code 卡不带。 */
import { expect, test } from "bun:test";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { remoteProbe } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { UI_LEND_GUIDANCE } from "../src/lib/ui-delivery-guidance.js";
import { sanitizeForeign } from "../src/lib/order-wire-render.js";

/** 外发闸按 NFKC 折全角标点：peer 收到的就是这一行 */
const SENT = sanitizeForeign(UI_LEND_GUIDANCE);

test.each([["ui", true], ["code", false]] as const)("[验收线 1] %s 卡的 cv 单带截图指引：%p", async (template, carries) => {
  const f = await fourRoundFix();
  try {
    f.db.run("UPDATE task_workflows SET template = ? WHERE taskId = 'T1'", [template]);
    const p = remoteProbe(f), intent = p.plan();
    p.deps.localFamilyWait = () => "本机不接codex";
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "pooled" });
    const order = remoteOrder(f.db, intent.id)!;
    expect(order.wire.acceptance.filter((s) => s === SENT)).toHaveLength(carries ? 1 : 0);
    expect(order.text.includes(SENT)).toBe(carries);
  } finally { f.close(); }
});
