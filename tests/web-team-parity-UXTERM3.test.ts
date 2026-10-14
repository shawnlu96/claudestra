import { expect, test } from "bun:test";
import { STEP_WORD, ownerWordEn } from "../web/lib/owner-words";
import { SLOT_KEYS, SLOT_LABEL, stepLineView } from "../web/features/collab/collab-step-line-model";

const keys = ["restate", "write", "review", "fix", "ui_check"] as const;
test("UXTERM3 步骤线复用统一词表，保留七格顺序及合并部署/核对", () => {
  for (const key of keys) expect(SLOT_LABEL[key]).toBe(STEP_WORD[key]!);
  expect(SLOT_KEYS).toEqual(["restate", "write", "review", "fix", "ui_check", "merge", "verify"]);
  expect([SLOT_LABEL.merge, SLOT_LABEL.verify]).toEqual(["合并部署", "核对"]);
  const view = stepLineView({ steps: keys.map(step => ({ step, executor: "agent-dev", round: 0 })), active: { step: "write", round: 0 } }, "build")!;
  expect(view.current?.label).toBe(STEP_WORD.write!);
  expect(keys.map(k => ownerWordEn(view.slots.find(s => s.key === k)!.label))).toEqual(keys.map(k => ownerWordEn(STEP_WORD[k]!)));
  expect(ownerWordEn(SLOT_LABEL.restate)).toBe("Confirm");
  expect(ownerWordEn(SLOT_LABEL.write)).toBe("Build");
});
