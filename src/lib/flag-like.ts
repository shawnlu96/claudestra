/**
 * POST /api/v1/agents 的字段闸：以 `-` 开头的值传给 manager 后会被当成 flag 重新解析——`{"model":"--parent=master"}`
 * 会变成 parent=master，`{"effort":"--task=x"}` 同理（manager/create-args.ts 的 flag 提取按顺序逐个吃 argv）。
 * purpose 不在这里：它走具名 --purpose 且最先抽，内容长什么样都行。测试见 tests/flag-like.test.ts。
 */
export function firstFlagLikeField(fields: Record<string, string>): string | null {
  return Object.entries(fields).find(([, v]) => v.startsWith("-"))?.[0] ?? null;
}

const fieldEntries = (fields: unknown): [string, unknown][] => (fields && typeof fields === "object" ? Object.entries(fields) : []);

/**
 * 第一个含控制字符（见 hasControlChar）的字段名，全干净 → null。这些值最后会经 `send-keys -l` 敲进 TUI
 * 或 shell：cron 的 prompt 到点原样注入，create 的 purpose / model 拼进启动命令。单引号转义挡不住——\x03 丢掉整行、
 * \r 提前提交后面那段。只看字符串：别的类型由 firstNonStringField 先拦（textFieldsProblem）。测试见 tests/flag-like.test.ts。
 */
export function firstControlCharField(fields: unknown): string | null {
  return fieldEntries(fields).find(([, v]) => typeof v === "string" && hasControlChar(v))?.[0] ?? null;
}

/**
 * 敲进 TUI 会出事的字符：\p{Cc}（C0 / C1：换行、\r、Tab、\x03、\x1b…会被当成按键）；U+2028 / U+2029（CC 输入框当换行，跟着的
 * Enter 提交不了）；方向控制符（界面上看到的顺序和实际敲进去的不一样）；字符串中间的 U+FEFF。ZWJ、ZWNJ、软连字符、变体选择符
 * 放行：👨‍👩‍👧 这类 emoji 序列要靠它们，也不会被当成按键。cron（含调度器）、create、claude-settings、pi-settings 同一个判定。
 */
export const hasControlChar = (s: string) => /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|(?<!^)\ufeff/u.test(s);

/** 该是文字的字段传成了对象、数组、数字… → 第一个这样的字段名；null / undefined 不算（= 没传） */
export function firstNonStringField(fields: unknown): string | null {
  return fieldEntries(fields).find(([, v]) => v != null && typeof v !== "string")?.[0] ?? null;
}

/** 文本字段的入口闸，先于 trim 调用（首尾的 \r \n 也算）：类型不对 → not_string，带控制字符 → control_chars，都没问题 → null。给 keys 只看这几个字段 */
export function textFieldsProblem(body: unknown, keys?: string[]): ReturnType<typeof controlCharBody> | null {
  const fields = keys ? Object.fromEntries(keys.map((k) => [k, (body as Record<string, unknown> | null)?.[k]])) : body;
  const typed = firstNonStringField(fields);
  if (typed) return { ok: false, code: "not_string", field: typed, error: `「${typed}」必须是一段文字 / "${typed}" must be a string` };
  const ctrl = firstControlCharField(fields);
  return ctrl ? controlCharBody(ctrl) : null;
}

/**
 * cron 调度器发送前的最后一道（src/cron.ts executeJob）：入口（API、manager cron-add / cron-edit）都拦了，
 * 这里挡的是拦之前写进 cron.json 的旧任务和手改的文件——真 CC 上 \x1b[Z 会被当成 Shift+Tab 切掉权限模式。
 */
export const CRON_PROMPT_REFUSED =
  "prompt 里有换行或控制字符，已拒发（多半是加校验之前写进去的旧任务）。用 cron-edit 改成一行后会恢复执行" +
  " / The prompt contains a line break or control character and was not sent (likely a job saved before validation). Fix it with cron-edit.";

/** 给人看的原因：哪个字段、为什么不行。网页按 code + field 自己出文案（features/chat/components/cron-modal.tsx） */
export const controlCharError = (field: string) =>
  `「${field}」里有换行或看不见的控制字符（比如 Tab、Esc、方向控制符）。这段文字会原样敲进终端：换行会让它提前提交，控制字符会被当成按键，所以只能写成一行普通文字。` +
  ` / "${field}" contains a line break or an invisible control character (such as Tab, Esc or a direction mark). It is typed into the terminal as-is —` +
  " a line break submits early and control characters act as key presses — so it must be a single line of plain text.";

/** 400 响应体：code 固定、field 给出是哪个字段 */
export const controlCharBody = (field: string) => ({ ok: false, code: "control_chars", field, error: controlCharError(field) });
