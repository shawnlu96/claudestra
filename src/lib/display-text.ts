/**
 * 要显示在侧栏 / 顶栏的用户文本（显示名 label、任务名 task）的字符闸：控制字符与方向控制符（RLO 之类）
 * 会让一段文字看起来像别的会话名。manager 的 label（manager/agent-external.ts）与 task（manager/team.ts）共用。
 */
const UNSAFE_DISPLAY_RE = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/;

export function hasUnsafeDisplayChars(s: string): boolean {
  return UNSAFE_DISPLAY_RE.test(s);
}
