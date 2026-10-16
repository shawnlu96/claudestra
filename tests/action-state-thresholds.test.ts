/** src 阈值与 web/features/collab/collab-model.ts 现值逐字核对（读源文件文本，不 import web），防两边漂移 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIX_STUCK_MS, STUCK_MS } from "../src/lib/action-state-thresholds";

const web = readFileSync(join(import.meta.dir, "../web/features/collab/collab-model.ts"), "utf8");
const valueOf = (name: string): number => {
  const m = new RegExp(`export const ${name} = ([\\d_ *]+);`).exec(web);
  if (!m) throw new Error(`${name} not found in collab-model.ts`);
  return m[1]!.split("*").map((x) => Number(x.trim().replace(/_/g, ""))).reduce((a, b) => a * b, 1);
};

test("STUCK_MS / FIX_STUCK_MS 与 collab-model.ts 相同", () => {
  expect(valueOf("STUCK_MS")).toBe(STUCK_MS);
  expect(valueOf("FIX_STUCK_MS")).toBe(FIX_STUCK_MS);
  expect([STUCK_MS, FIX_STUCK_MS]).toEqual([30 * 60_000, 2 * 60 * 60_000]);
});
