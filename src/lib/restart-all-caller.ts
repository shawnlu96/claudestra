/**
 * restart-all 每一轮日志的开始行带上调用者（BGW-1）：之前只记得「有一次 restart-all」，查不到是谁点的。
 * 开始行的 label 只许 [\w .:-]（lib/run-log.ts，它进 bash -c），principal id 本身合规；名字是用户起的，别的字符一律换成 _。
 * tests/restart-all-caller.test.ts
 */

const UNSAFE = /[^\w.:-]/g;

export function restartAllLabel(flag: string, caller: { id: string; name?: string } | null | undefined): string {
  const id = (caller?.id ?? "").replace(UNSAFE, "_").slice(0, 80) || "unknown";
  const name = (caller?.name ?? "").replace(UNSAFE, "_").slice(0, 40);
  return `restart-all${flag} by ${id}${name ? ` name:${name}` : ""}`;
}
