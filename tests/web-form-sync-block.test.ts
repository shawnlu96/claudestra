/**
 * T10b：勾选退回本地的原因码（syncBlock）+ 线上同形状表单（圈号 label、min 0、max = 选项数、submitLabel）照常同步。
 * 09-28 线上「勾了不进输入框」的根因是中继托管的网页还是 T10 之前的版本（tests/doctor-relay-web.test.ts），
 * 这里锁住：这种形状的表单在当前代码里走同步分支，退回本地时有原因码可查。
 */
import { describe, expect, test } from "bun:test";
import { composeFormSend, lineScan, syncBlock, syncable, toggleFormValue, type MultiRow, type SyncForm } from "@/lib/chat/form-compose";

const live: MultiRow = {
  type: "multiselect",
  id: "d_pm_2010_form",
  placeholder: "勾选要批准的项",
  min: 0,
  max: 5,
  submitLabel: "提交",
  options: [
    { label: "⑨ 允许改仓库外 recall.py", value: "recall_fix", description: "改前备份" },
    { label: "⑨ 存量小清理（不做大合并）", value: "mem_cleanup_small" },
    { label: "⑨ 产品内建记忆层进路线", value: "mem_product_layer" },
    { label: "⑬ 名字暂留「值守」", value: "autopilot_keep_name" },
    { label: "⑬ 值守第一期按修正版做", value: "autopilot_phase1" },
  ],
};
const F: SyncForm = { row: live, title: "勾选要批准的项", messageId: "h115266", rowKey: "m:d_pm_2010_form" };
const older: SyncForm = { row: { ...live, options: [{ label: "旧的", value: "x" }] }, title: "勾选要批准的项", messageId: "h1", rowKey: "m:d_pm_2010_form" };

describe("syncBlock：退回本地的原因码", () => {
  test("线上同形状表单：可同步（null）", () => {
    expect(syncable(live)).toBe(true);
    expect(syncBlock(live, F, [F], true)).toBeNull();
  });
  test("没有输入框（分享模式）→ no-composer，优先于其他原因", () => {
    expect(syncBlock(live, undefined, [], false)).toBe("no-composer");
  });
  test("不在可作答表单里 → not-open", () => {
    expect(syncBlock(live, undefined, [F], true)).toBe("not-open");
  });
  test("选项不合格 → unsyncable", () => {
    const bad: MultiRow = { ...live, options: [{ label: "A", value: "a" }, { label: "A", value: "b" }] };
    expect(syncBlock(bad, { ...F, row: bad }, [{ ...F, row: bad }], true)).toBe("unsyncable");
  });
  test("同 id 有更新的一条 → 旧的那条 superseded，新的照常同步", () => {
    expect(syncBlock(older.row, older, [F, older], true)).toBe("superseded");
    expect(syncBlock(live, F, [F, older], true)).toBeNull();
  });
});

describe("线上同形状表单走完同步链路", () => {
  test("勾三项 → 同步行；补一句发送 → [select:…] + 补充", () => {
    let text = "";
    for (const v of ["recall_fix", "mem_cleanup_small", "mem_product_layer"]) text = toggleFormValue(text, F, [F], v);
    expect(text).toBe("【勾选要批准的项】✓ ⑨ 允许改仓库外 recall.py；✓ ⑨ 存量小清理（不做大合并）；✓ ⑨ 产品内建记忆层进路线\n");
    expect(lineScan(text, [F]).ambiguous.size).toBe(0);
    const { wire, answered } = composeFormSend(`${text}先做 recall`, [F]);
    expect(wire).toBe("[select:d_pm_2010_form:recall_fix,mem_cleanup_small,mem_product_layer]\n先做 recall");
    expect(answered).toEqual([{ messageId: "h115266", rowKey: "m:d_pm_2010_form", choiceValue: "d_pm_2010_form:recall_fix,mem_cleanup_small,mem_product_layer" }]);
  });
  test("max = 选项数：五项全勾也不算超", () => {
    let text = "";
    for (const o of live.options) text = toggleFormValue(text, F, [F], o.value);
    expect(lineScan(text, [F]).owners.get(live.id)?.over).toBe(false);
  });
});
