/** i18n 的 {name} 占位替换：纯函数单独成文件，根目录 bun test 能直接测（lib/i18n.tsx 带 React）。 */
export type I18nParams = Record<string, string | number>;

/** {name} 换成 params.name；params 里没有的占位原样留着，漏传一眼能看出来。 */
export function fillParams(s: string, params?: I18nParams): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] === undefined ? m : String(params[k])));
}
