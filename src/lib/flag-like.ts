/**
 * POST /api/v1/agents 的字段闸：以 `-` 开头的值传给 manager 后会被当成 flag 重新解析——`{"model":"--parent=master"}`
 * 会变成 parent=master，`{"effort":"--task=x"}` 同理（manager/create-args.ts 的 flag 提取按顺序逐个吃 argv）。
 * purpose 不在这里：它走具名 --purpose 且最先抽，内容长什么样都行。测试见 tests/flag-like.test.ts。
 */
export function firstFlagLikeField(fields: Record<string, string>): string | null {
  return Object.entries(fields).find(([, v]) => v.startsWith("-"))?.[0] ?? null;
}

/**
 * 第一个含控制字符（\p{Cc}：换行、\r、\x03、\x1b…）的字段名，全干净 → null。这些值最后会经 `send-keys -l` 敲进 TUI
 * 或 shell：cron 的 prompt 到点原样注入，create 的 purpose / model 拼进启动命令。单引号转义挡不住——\x03 丢掉整行、
 * \r 提前提交后面那段。非字符串值按 String() 看（数组会拼成字符串）。测试见 tests/flag-like.test.ts。
 */
export function firstControlCharField(fields: unknown): string | null {
  const entries = fields && typeof fields === "object" ? Object.entries(fields) : [];
  return entries.find(([, v]) => v != null && /\p{Cc}/u.test(String(v)))?.[0] ?? null;
}

export const controlCharError = (field: string) =>
  `${field} 不能含换行或控制字符 / ${field} must not contain line breaks or control characters`;
