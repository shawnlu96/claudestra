/** i18n 的 {name} 占位替换：纯函数单独成文件，根目录 bun test 能直接测（lib/i18n.tsx 带 React）。 */
export type I18nParams = Record<string, string | number>;

/**
 * {name} 换成 params.name；params 里没有的占位原样留着，漏传一眼能看出来。
 * 英文单复数：译文写成「单数|复数」（"{n} agent|{n} agents"），按 params.n 选——n 为 1 取前半，否则取后半。
 * 中文原文没有 |，不受影响；没传 n 时取复数（「{n} agents」比「{n} agent」更不容易读错）。
 */
export function fillParams(s: string, params?: I18nParams): string {
  const forms = s.split("|");
  const picked = forms.length === 2 ? forms[Number(params?.n) === 1 ? 0 : 1] : s;
  if (!params) return picked;
  return picked.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] === undefined ? m : String(params[k])));
}
