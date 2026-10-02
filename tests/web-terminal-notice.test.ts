/** 网页终端打开 ACP agent 时的提示（web/features/terminal/terminal-notice.ts）：只给 transport=acp，英文界面有译文 */
import { expect, test } from "bun:test";
import { DICT } from "@/lib/i18n-dict";
import { ACP_HOST_NOTICE, terminalNotice } from "../web/features/terminal/terminal-notice";

test("transport=acp 才提示「只是宿主日志、Ctrl+C 会停掉宿主」；tmux / 缺省不提示", () => {
  expect(terminalNotice({ transport: "acp" })).toBe(ACP_HOST_NOTICE);
  expect(ACP_HOST_NOTICE).toContain("Ctrl+C");
  for (const transport of ["tmux", null, undefined]) expect(terminalNotice({ transport })).toBeNull();
  expect(DICT[ACP_HOST_NOTICE]).toContain("Ctrl+C");
});
