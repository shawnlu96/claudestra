/**
 * 连续工具调用怎么摆（components/tool-rows.tsx 的 ToolGroup）：单步平铺；≥2 步收进一个框，组头可展开 / 收起，
 * 收起时只露最新一步。导出稿（分享 → HTML / PDF）是没有 JS 的静态文件，按钮点不动——那里一律全展开、组头只留文字，
 * 否则每组只剩最后一张卡。tests/web-tool-group.test.ts。
 */
export interface ToolGroupLayout {
  /** 收进带组头的框（否则平铺） */
  framed: boolean;
  /** 组头是可点的展开 / 收起按钮（导出稿里是纯文字） */
  toggle: boolean;
  /** 渲染全部工具卡（否则只渲染最后一张） */
  showAll: boolean;
}

export function toolGroupLayout(count: number, open: boolean, exporting: boolean): ToolGroupLayout {
  if (count <= 1) return { framed: false, toggle: false, showAll: true };
  return { framed: true, toggle: !exporting, showAll: exporting || open };
}
