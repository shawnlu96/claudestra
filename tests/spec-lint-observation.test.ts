/**
 * merge-arch-SPECOBS1：「## 上线后 PM」首行观察期的纯 lint 与恢复键 specObservationHours 三档（on 拒 / observe 去重记录、不写台账 / off 不跑）。
 * 走真实 preflightStart 的手动 / 自动开卡见 tests/dag-tools-start-observation.test.ts。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { parseObservation } from "../src/lib/scheduler-post-verify-defer.js";
import { postVerifySection } from "../src/lib/scheduler-post-verify-ledger.js";
import { lintObservation, observationGate, SPEC_OBSERVATION_RULE } from "../src/lib/spec-lint-observation.js";

const P = "claude-orchestrator";
const spec = (pm: string, head = "模板：code") => `# 规格\n${head}\n## 目标\n做事\n## 上线后 PM\n${pm}\n## 附录\n无\n`;
const OK = "观察期：24 小时\n核对提醒是否按时发出";

describe("lintObservation", () => {
  test("有效观察期 + 核对动作：code / ui / security 都过；1、24、168、169（封顶 168）都过", () => {
    for (const head of ["模板：code", "模板：ui", "模板：security", ""]) expect(lintObservation(spec(OK, head))).toBeNull();
    for (const n of [1, 24, 168, 169]) expect(lintObservation(spec(`观察期：${n} 小时\n核对动作`))).toBeNull();
    expect(parseObservation(postVerifySection(spec("观察期：169 小时\n核对动作")))).toEqual({ hours: 168, capped: true });
  });

  test("与提醒侧同一认法：中英文冒号 / 空格、标题后的排版空行都接受", () => {
    for (const line of ["观察期:24 小时", "观察期 ： 24 小时", "观察期：24小时"]) {
      expect(lintObservation(spec(`${line}\n核对动作`))).toBeNull();
      expect(parseObservation(postVerifySection(spec(`${line}\n核对动作`)))).toMatchObject({ hours: 24 });
    }
    expect(lintObservation(spec(`\n\n${OK}`))).toBeNull();
  });

  test("缺节 / 空节 / 没有规格：拒并给修法", () => {
    expect(lintObservation("# 规格\n模板：security\n## 目标\n做事\n")).toContain("缺「## 上线后 PM」");
    expect(lintObservation("# 规格\n## 上线后 PM\n\n## 附录\n无\n")).toContain("空节");
    for (const t of [null, undefined, "", "  \n"]) expect(lintObservation(t)).toContain("缺规格 / 缺观察期");
  });

  test("首行没写 / 写到第二行 / 只在子标题、列表、引用、代码块里：拒", () => {
    expect(lintObservation(spec("核对动作\n观察期：24 小时"))).toContain("没写在正文第一行");
    expect(lintObservation(spec("核对动作"))).toContain("正文第一行没写观察期");
    for (const first of ["### 观察期：24 小时", "- 观察期：24 小时", "1. 观察期：24 小时", "> 观察期：24 小时"]) {
      expect(lintObservation(spec(`${first}\n核对动作`))).toContain("不算正文首行");
    }
    expect(lintObservation(spec("```\n观察期：24 小时\n```\n核对动作"))).toContain("没写在正文第一行");
  });

  test("缩进代码块（四空格 / 制表符 / 空格 + 制表符）里的观察期不算正文首行；1–3 格缩进仍是正文", () => {
    for (const ind of ["    ", "\t", "  \t", "      "]) {
      for (const pm of [`${ind}观察期：24 小时\n\n核对动作`, `\n${ind}观察期：24 小时\n\n核对动作`]) {
        expect(lintObservation(spec(pm))).toContain("缩进代码块");
        expect(lintObservation(spec(pm, "模板：security"))).toContain("缩进代码块");
      }
    }
    for (const ind of [" ", "   "]) expect(lintObservation(spec(`${ind}观察期：24 小时\n核对动作`))).toBeNull();
  });

  test("0 / 负数 / 小数 / 占位 N：格式没认出", () => {
    for (const n of ["0", "-1", "1.5", "N", "二十四"]) {
      const why = lintObservation(spec(`观察期：${n} 小时\n核对动作`)) as string;
      expect(why).toContain("格式没认出");
      expect(why).toContain("N 为 1 以上整数");
    }
  });

  test("有效观察期但没有核对动作（或只有子标题 / 围栏）：拒", () => {
    for (const rest of ["", "\n\n", "\n### 动作", "\n```\n```"]) expect(lintObservation(spec(`观察期：24 小时${rest}`))).toContain("没有 PM 核对动作");
  });

  test("观察期后只有空 Markdown 标记（空清单 / 空任务项 / 空引用 / 分隔线 / 注释 / 链接定义）：拒；有文字的列表动作照过", () => {
    for (const rest of ["- [ ]", "---", "* * *", "___", "<!-- TODO -->", "<!--\n核对动作\n-->", ">", "> -", "-", "1.", "[ref]: https://example.com", "  - [x]  ",
      "[ref]:\nhttps://example.com", "> [ref]: https://example.com", "[ref]: https://example.com\n\"reference title\"",
      "- [ref]: <https://example.com> 't'", "[ref]: https://example.com\n(多行\n标题)", "> [ref]:\n> https://example.com\n> \"t\""]) {
      expect(lintObservation(spec(`观察期：24 小时\n\n${rest}`))).toContain("没有 PM 核对动作");
    }
    for (const rest of ["- [ ] 核对提醒", "> 核对提醒", "1. 核对提醒", "<!-- 注 --> 核对提醒", "核对 [链接](https://example.com)",
      "[ref]: https://example.com\n核对提醒", "> [ref]: https://example.com\n> 核对提醒", "[ref]:\nhttps://example.com\n\"t\"\n核对提醒", "[ref]: https://example.com 核对提醒"]) {
      expect(lintObservation(spec(`观察期：24 小时\n${rest}`))).toBeNull();
    }
  });

  test("引用标题必须完整且闭合后无正文；解析失败保留候选动作", () => {
    for (const title of ['"核对提醒" 并核对部署结果', '"未闭合标题\n核对部署结果',
      "'核对提醒' 并核对部署结果", '(核对提醒) 并核对部署结果',
      '"核对\\"提醒" 并核对结果', '(核对(部署))', '"未闭合\n\n核对结果']) {
      expect(lintObservation(spec(`观察期：24 小时\n\n[ref]: https://example.com\n${title}`))).toBeNull();
      expect(lintObservation(spec(`观察期：24 小时\n\n[ref]: https://example.com ${title}`))).toBeNull();
    }
    for (const title of ['"核对\\"提醒"', "'标题\n续行'", '(标题\n续行)']) {
      expect(lintObservation(spec(`观察期：24 小时\n\n[ref]: https://example.com\n${title}`))).toContain("没有 PM 核对动作");
    }
  });

  test("多行引用标题在新 Markdown 块处终止，原引用容器的完整标题仍不可见", () => {
    for (const block of ['- 核对部署结果', '* 核对部署结果', '+ 核对部署结果', '1. 核对部署结果',
      '> 核对部署结果', '### 核对部署结果', '---', '* * *', '___', '```']) {
      const tail = `[ref]: https://example.com\n"见文档\n${block}\n核对部署结果"`;
      expect(lintObservation(spec(`观察期：24 小时\n\n${tail}`))).toBeNull();
    }
    for (const tail of ['> [ref]: https://example.com\n> "多行\n> 标题"',
      '> > [ref]: https://example.com\n>> "多行\n>> 标题"']) {
      expect(lintObservation(spec(`观察期：24 小时\n\n${tail}`))).toContain("没有 PM 核对动作");
    }
    for (const tail of ['[ref]: https://example.com\n> "核对结果"', '[ref]: https://example.com\n- "核对结果"']) {
      expect(lintObservation(spec(`观察期：24 小时\n\n${tail}`))).toBeNull();
    }
    expect(lintObservation(spec('观察期：24 小时\n\n> [ref]: https://example.com\n> "标题\n> - 核对结果"'))).toBeNull();
  });

  test("Markdown 解析器区分不可见标题续行与可见 HTML/空标题块", () => {
    for (const tail of ['[ref]: https://example.com\n"见文档\n2. 核对部署结果"',
      '[ref]: https://example.com\n"见文档\n    - x\n核对部署结果"',
      '[ref]: https://example.com\n"见文档\n\t- 核对部署结果"',
      '> [ref]: https://example.com\n> "多行\n标题"', '&nbsp;', '<!-- TODO -->',
      '```\n核对部署结果\n```', '### 核对部署结果']) {
      expect(lintObservation(spec(`观察期：24 小时\n\n${tail}`))).toContain("没有 PM 核对动作");
    }
    for (const tail of ['[ref]: https://example.com\n"见文档\n<div>\n核对部署结果"',
      '[ref]: https://example.com\n"见文档\n<details>\n核对部署结果"',
      '[ref]: https://example.com\n"见文档\n#\n核对部署结果"',
      '[ref]:\n> https://example.com\n> "标题"', '&#26680;对部署结果',
      '[ref]: https://example.com\n"见文档\n - x\n核对部署结果"']) {
      expect(lintObservation(spec(`观察期：24 小时\n\n${tail}`))).toBeNull();
    }
  });

  test("整段观察期上下文：缩进续行可见，空行后的缩进代码仍不计动作", () => {
    for (const tail of ['    核对部署结果', '\t核对部署结果', '    - 核对部署结果\n    - 核对监控']) {
      expect(lintObservation(spec(`观察期：24 小时\n${tail}`))).toBeNull();
      expect(lintObservation(spec(`观察期：24 小时\n\n${tail}`))).toContain("没有 PM 核对动作");
    }
    expect(lintObservation(spec('观察期：24 小时'))).toContain("没有 PM 核对动作");
  });

  test("重复节拒；代码块里的同名标题不算重复", () => {
    expect(lintObservation(`${spec(OK)}## 上线后 PM\n观察期：1 小时\n核对\n`)).toContain("出现了 2 次");
    expect(lintObservation(`${spec(OK)}\`\`\`md\n## 上线后 PM\n观察期：1 小时\n\`\`\`\n`)).toBeNull();
  });
});

describe("observationGate：恢复键 specObservationHours", () => {
  let dir: string;
  const policy = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => {
    expect(key).toBe("specObservationHours");
    return { mode, manualAfterMs: null, source: "config" };
  };
  const records = () => existsSync(join(dir, "obs")) ? readdirSync(join(dir, "obs")).map((f) => JSON.parse(readFileSync(join(dir, "obs", f), "utf8"))) : [];
  const gate = (mode: RecoveryMode, inline?: string, taskId = "i28-a") =>
    observationGate({ ledgerDir: join(dir, "ledger"), project: P, taskId, inline }, { policy: policy(mode), now: 1_000, observeDir: join(dir, "obs") });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "specobs-gate-"));
    mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("on：inline 与正式文件同一检查；没有规格也拒；不记", () => {
    expect(gate("on", spec("核对动作"))).toContain("正文第一行没写观察期");
    writeFileSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"), spec("核对动作"));
    expect(gate("on")).toBe(gate("on", spec("核对动作")));
    rmSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"));
    expect(gate("on")).toContain("缺规格 / 缺观察期");
    expect(gate("on", spec(OK))).toBeNull();
    expect(records()).toEqual([]);
  });

  test("observe：放行，按 project + 卡号 + 规格摘要 + 规则版本去重记录；改了规格 / 换卡号重新记", () => {
    expect(gate("observe", spec("核对动作"))).toBeNull();
    expect(gate("observe", spec("核对动作"))).toBeNull();
    expect(records()).toEqual([expect.objectContaining({ project: P, taskId: "i28-a", rule: SPEC_OBSERVATION_RULE, reason: expect.stringContaining("正文第一行没写观察期") })]);
    expect(gate("observe", spec("核对动作 2"))).toBeNull();
    expect(gate("observe", spec("核对动作"), "i28-b")).toBeNull();
    expect(records()).toHaveLength(3);
    expect(gate("observe", spec(OK))).toBeNull();
    expect(records()).toHaveLength(3);
  });

  test("off：不跑新增检查、不记", () => {
    expect(gate("off")).toBeNull();
    expect(gate("off", spec("核对动作"))).toBeNull();
    expect(records()).toEqual([]);
  });
});
