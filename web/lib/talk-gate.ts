/**
 * Chat（人与人，/talk）入口默认收起（T50）：开关是 bridge config.json 的 talkEnabled（设置 · 实验，owner 改），缺省关。
 * 只收界面——侧栏不出「工作台 | Chat」切换、/talk 跳回 /chat；talk API、数据、「丢进工作台」「粘贴外部文字」都照旧。
 * 纯逻辑，单测 tests/web-talk-gate.test.ts；on = null 表示还没读到。
 */

/** GET /settings 的回包 → 开没开；老 bridge 没这个字段、读失败都按关 */
export const talkEnabledOf = (j: { talkEnabled?: unknown } | null | undefined): boolean => j?.talkEnabled === true;

/** 侧栏出不出切换：只有读到「开」才出（没读到时先显示原来的标题，免得一闪） */
export const showWorkspaceSwitch = (on: boolean | null): boolean => on === true;

/** /talk 该不该跳走：读到「关」才跳（还没读到时不跳，免得开着的人被弹回工作台） */
export const talkRedirect = (on: boolean | null): "/chat" | null => (on === false ? "/chat" : null);

/**
 * 读回来的开关只对读它的那台机器有效：从开着 Chat 的 A 切到 B，B 的设置回来之前不能沿用 A 的 true（会先把 Chat 挂出来）。
 * 记录的机器不是当前这台 = 还没读到（null）
 */
export const talkOnFor = (rec: { fp: string | null; on: boolean } | null, fp: string | null): boolean | null =>
  rec && rec.fp === fp ? rec.on : null;
