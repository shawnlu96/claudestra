/** 网页终端打开 ACP agent 时的提示（web/features/terminal/terminal-notice.ts）：只给 transport=acp，英文界面有译文 */
import { expect, test } from "bun:test";
import { DICT } from "@/lib/i18n-dict";
import { ACP_HOST_NOTICE, terminalNotice } from "../web/features/terminal/terminal-notice";

test("transport=acp 才提示「底部可输入、Esc / Ctrl+C 打断、空闲按两次停宿主」；tmux / 缺省不提示", () => {
  expect(terminalNotice({ transport: "acp" })).toBe(ACP_HOST_NOTICE);
  for (const k of ["输入", "Esc", "Ctrl+C", "打断", "两次"]) expect(ACP_HOST_NOTICE).toContain(k);
  expect(ACP_HOST_NOTICE).not.toContain("只读");
  for (const transport of ["tmux", null, undefined]) expect(terminalNotice({ transport })).toBeNull();
  expect(DICT[ACP_HOST_NOTICE]).toContain("Ctrl+C");
});
