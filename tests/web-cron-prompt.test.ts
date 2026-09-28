/** web/lib/cron-prompt.ts：定时任务表单在提交前就挡住换行 / 控制字符，文案都在字典里 */
import { describe, expect, test } from "bun:test";
import { promptProblem } from "@/lib/cron-prompt";
import { DICT } from "@/lib/i18n-dict";

describe("promptProblem", () => {
  test("一行普通文字（中文、emoji、ZWJ / 变体选择符组合 emoji、软连字符、空格）没问题", () => {
    expect(promptProblem("每周一 10 点汇总 PR 状态 📊 👨\u200d👩\u200d👧 🏳\ufe0f\u200d🌈 ❤\ufe0f")).toBe("");
    expect(promptProblem("co\u00adop\u200cx")).toBe("");
  });
  test("粘贴进来的换行（\\n、\\r\\n、\\r、U+2028、U+2029、U+0085）→「只能一行」", () => {
    for (const p of ["a\nb", "a\r\nb", "a\rb", "LS-A\u2028/clear", "a\u2029b", "a\u0085b"]) expect([p, promptProblem(p)]).toEqual([p, "定时任务的 prompt 只能一行"]);
  });
  test("其它控制字符（Tab、Esc、\\x03）→ 单独说明", () => {
    for (const p of ["a\tb", "a\u001b[Z", "a\u0003", "a\u200eb", "a\u202eb", "a\u2066b", "a\ufeffb"]) expect([p, promptProblem(p)]).toEqual([p, "任务指令里有看不见的控制字符（比如 Tab），请删掉"]);
  });
  test("提示文案都有英文", () => {
    for (const k of ["定时任务的 prompt 只能一行", "任务指令里有看不见的控制字符（比如 Tab），请删掉"]) expect(DICT[k]).toBeTruthy();
    expect(DICT["「{field}」里有换行或看不见的控制字符。到点会原样敲进终端，换行会让它提前提交，所以只能写成一行"]).toContain("{field}");
  });
});
