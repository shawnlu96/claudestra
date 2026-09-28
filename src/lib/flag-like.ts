/**
 * POST /api/v1/agents 的字段闸：以 `-` 开头的值传给 manager 后会被当成 flag 重新解析——`{"model":"--parent=master"}`
 * 会变成 parent=master，`{"effort":"--task=x"}` 同理（manager/create-args.ts 的 flag 提取按顺序逐个吃 argv）。
 * purpose 不在这里：它走具名 --purpose 且最先抽，内容长什么样都行。测试见 tests/flag-like.test.ts。
 */
export function firstFlagLikeField(fields: Record<string, string>): string | null {
  return Object.entries(fields).find(([, v]) => v.startsWith("-"))?.[0] ?? null;
}
