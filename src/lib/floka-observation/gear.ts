/**
 * `rename.observation`：off 不出报告；observe（缺省）只读显式样本、报告打到 stdout，零写入；
 * on 只多一件事——报告另写一份到显式给出的临时目录（output.ts 把关）。三档都不改协议、迁移、调度或台账。
 * 读不懂的值按 observe：observe 本身不写任何东西，打错字既不会变成写盘，也不会让观察悄悄停掉。
 */
export type ObservationGear = "off" | "observe" | "on";

export function parseObservationGear(config: unknown): { gear: ObservationGear; problems: string[] } {
  const rename = config && typeof config === "object" ? (config as { rename?: unknown }).rename : undefined;
  const v = rename && typeof rename === "object" ? (rename as { observation?: unknown }).observation : undefined;
  if (v === undefined || v === null) return { gear: "observe", problems: [] };
  if (v === "off" || v === "observe" || v === "on") return { gear: v, problems: [] };
  return { gear: "observe", problems: ["rename.observation: 不是 off / observe / on（原值不回显），按 observe 处理"] };
}
