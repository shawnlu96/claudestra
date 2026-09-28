/**
 * 定时任务的 prompt 到点原样敲进 agent 的终端（src/cron.ts）：换行会拆成几次提交，服务端也会拒（bridge api-routes /cron）。
 * 表单提交前就挡住并说明原因（features/chat/components/cron-modal.tsx）；粘贴进来的换行不悄悄替换，让人自己改。
 * 返回要显示的提示（i18n 原文），没问题 → ""。测试见 tests/web-cron-prompt.test.ts。
 */
export function promptProblem(p: string): string {
  if (/[\r\n]/.test(p)) return "定时任务的 prompt 只能一行";
  return /\p{Cc}/u.test(p) ? "任务指令里有看不见的控制字符（比如 Tab），请删掉" : "";
}
