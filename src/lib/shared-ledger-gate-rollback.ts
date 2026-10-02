import type { Step, StepName } from "./dag-tools-steps.js";

export async function rollback(steps: Step[]): Promise<{ rolledBack: StepName[]; leftovers: string[] }> {
  const rolledBack: StepName[] = [];
  const leftovers: string[] = [];
  for (const s of steps) {
    if (!s.undo) continue;
    try {
      const err = await s.undo();
      if (err) leftovers.push(`${s.name}：${err}`);
      else rolledBack.push(s.name);
    } catch (e) {
      leftovers.push(`${s.name}：${(e as Error).message}`);
    }
  }
  return { rolledBack, leftovers };
}
