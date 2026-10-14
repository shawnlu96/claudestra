/** Light checks are a fast author signal, not a coverage claim: changed tests plus direct importers, never transitive users. */
import { isTestFile } from "./ci-impact-graph.js";
import type { ChangedFile, ImpactSide } from "./ci-impact-select.js";

export interface LightSelection { tests: string[]; changed: number; direct: number; reasons: string[] }
export function selectLightTests(changes: readonly ChangedFile[], base: ImpactSide, head: ImpactSide, slow: readonly string[] = []): LightSelection {
  const available = new Set(head.paths.filter(isTestFile)), excluded = new Set(slow);
  const changed = new Set(changes.map((c) => c.path).filter((p) => available.has(p) && !excluded.has(p)));
  const picked = new Set(changed);
  for (const c of changes) {
    for (const [side, seed] of [[head, c.path], [base, c.from ?? c.path]] as const) {
      for (const user of side.graph.reverse.get(seed) ?? []) if (available.has(user) && !excluded.has(user)) picked.add(user);
    }
  }
  const capped = picked.size > 200, tests = [...(capped ? changed : picked)].sort();
  return { tests, changed: changed.size, direct: tests.filter((p) => !changed.has(p)).length,
    reasons: capped ? [`light 选集 ${picked.size} 超过 200，仅保留改动测试`] : [] };
}
