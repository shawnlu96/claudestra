import { expect, test } from "bun:test";
import { taskTokenText, taskUsageLines } from "../web/features/collab/detail-usage-model";
import { detailPauseTr } from "../web/features/collab/detail-pause-i18n";
import { fillParams } from "../web/lib/i18n-fill";
import type { TaskUsageSummary } from "../web/lib/api/usage-task";

const summary: TaskUsageSummary = { families: { claude: { totalTokens: 17_500_000 }, codex: { totalTokens: 14_000_000 } }, totalTokens: 31_500_000,
  hasArchive: true, detailFrom: "2026-10-01", unavailableBefore: null, lent: { claude: { orders: 2, tokensReported: false } },
  weekEstimate: { claude: { estimatePct: 3 }, codex: { estimatePct: null } } };
test("integer ten-thousands and every weekly share is explicitly approximate", () => {
  expect(taskTokenText(9_999)).toBe("不到 1 万");
  expect(taskTokenText(15_000)).toBe("2 万");
  expect(taskUsageLines(summary)).toEqual([
    "Claude 约 1,750 万 token · 约占本周额度 3%", "Codex 约 1,400 万 token · 约占本周额度不到 1%",
    "另有 2 单在其他成员机器上跑，用量对方没回传", "早于 2026-10-01 的部分已不可查",
  ]);
});
test("reported orders are not labelled unreported; absent usage is distinct from missing history", () => {
  const s = { ...summary, families: {}, hasArchive: false, lent: { codex: { orders: 4, tokensReported: true, unreportedOrders: 1 } } };
  expect(taskUsageLines(s)).toEqual(["还没有用量记录", "另有 1 单在其他成员机器上跑，用量对方没回传"]);
  expect(taskUsageLines({ ...s, unavailableBefore: "2026-09-01", lent: {} })).toEqual(["还没有用量记录", "早于 2026-09-01 的部分已不可查"]);
  expect(taskUsageLines(summary, detailPauseTr(fillParams, "en"))[0]).toContain("about 3% of this week's quota");
});
