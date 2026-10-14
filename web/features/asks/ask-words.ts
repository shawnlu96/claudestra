/** 收件箱卡头的类型标签（UXASK1）与团队项目确认卡的提示（UXASK2）：只在这里译，不进全站字典；写法照 collab/work-i18n.ts。 */
const WORDS: Record<string, string> = {
  '拍板': 'Decide', '授权': 'Authorize', '你来做': 'Your action', '验收': 'Accept', '指派': 'Assigned',
  '批准提案': 'Approve proposal', '团队项目确认': 'Team project confirmation', '大总管': 'Master',
  // UXASK2：团队项目确认卡
  '这张确认卡格式不对，不能在这里确认': 'This confirmation card is malformed and cannot be confirmed here',
};
export function askWord(t: (s: string) => string, text: string): string {
  if (t('待你处理') === '待你处理') return text;
  return WORDS[text] ?? t(text);
}
