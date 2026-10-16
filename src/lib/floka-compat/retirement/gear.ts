/**
 * `rename.retireCompat`：off（缺省）什么都不做；observe 只报告逐项可退出性，零写入；
 * on 只把收掉后的允许表与恢复包写进显式给的临时目录（execute.ts），不碰源码、状态目录或任何旧入口。
 * 读不懂的值一律 off：打错字不能变成收兼容，也不该凭空开始读样本。
 */
export type RetireGear = "off" | "observe" | "on";

export function parseRetireGear(config: unknown): { gear: RetireGear; problems: string[] } {
  const rename = config && typeof config === "object" ? (config as { rename?: unknown }).rename : undefined;
  const v = rename && typeof rename === "object" ? (rename as { retireCompat?: unknown }).retireCompat : undefined;
  if (v === undefined || v === null) return { gear: "off", problems: [] };
  if (v === "off" || v === "observe" || v === "on") return { gear: v, problems: [] };
  return { gear: "off", problems: ["rename.retireCompat: 不是 off / observe / on（原值不回显），按 off 处理"] };
}
