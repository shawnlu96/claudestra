/**
 * parseModalOptions 迁到 lib/modal-numbered-options.ts 的等价性回归：
 * 旧实现取自固定基线 Git 对象（迁出前的 tmux-helper.ts，原文切片落临时模块），与新模块、tmux-helper 公开旧入口、
 * modal-confirm 的真实调用方逐字段比对；基线对象缺失直接报错，不 skip。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testChildEnv } from "./test-env.ts";
import * as helper from "../src/lib/tmux-helper.ts";
import * as pure from "../src/lib/modal-numbered-options.ts";
import { isAutoConfirmableModal } from "../src/lib/modal-confirm.ts";

const BASE = "b6da6cfb6f1060a88617e31401a5fd90ee302e7f";
const ROOT = resolve(import.meta.dir, "..");
const temp = mkdtempSync(join(tmpdir(), "modal-numbered-"));
for (const name of ["home", "state", "runtime", "tmp"]) mkdirSync(join(temp, name));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const env = testChildEnv({
  HOME: join(temp, "home"), TMPDIR: join(temp, "tmp"),
  CLAUDESTRA_STATE_DIR: join(temp, "state"), CLAUDESTRA_RUNTIME_DIR: join(temp, "runtime"),
});
const shown = spawnSync("git", ["show", `${BASE}:src/lib/tmux-helper.ts`], { cwd: ROOT, env, encoding: "utf8" });
if (shown.status !== 0) throw new Error(`Cannot load fixed tmux-helper baseline: ${shown.stderr}`);
const START = "/**\n * 解析 Claude Code TUI 里的数字选项 modal";
const END = "/** 无编号选择弹窗的一个选项";
const oldBlock = shown.stdout.slice(shown.stdout.indexOf(START), shown.stdout.indexOf(END));
if (!oldBlock.includes("export function parseModalOptions")) throw new Error("baseline slice missing parseModalOptions");
const oraclePath = join(temp, "oracle.ts");
writeFileSync(oraclePath, `import { paneTail } from ${JSON.stringify(join(ROOT, "src/lib/pane-tail.ts"))};\n${oldBlock}`);
const oracle: typeof pure = await import(oraclePath);

const menu = (rows: string[], before: string[] = [], after: string[] = []) => [...before, ...rows, ...after].join("\n");
const filler = (n: number, p = "log") => Array.from({ length: n }, (_, i) => `${p} line ${i}`);
const CASES: Record<string, string> = {
  basic: menu(["Select model", "", "❯ 1. Default (recommended)", "  2. Opus", "  3. Haiku", "", "Enter to confirm · Esc to exit"]),
  selectedMiddle: menu(["  1. Yes", "❯ 2. No, and tell Claude", "  3. Always"]),
  plainNumberedReply: menu(["Steps:", "1. Install deps", "2. Run tests", "3. Ship"]),
  singleOption: menu(["❯ 1. Only one"]),
  emptyLabel: menu(["❯ 1.  ", "  2. Real", "  3. Also"]),
  emptyLabelSelected: menu(["❯ 1. ", "  2. a", "  3. b"]),
  duplicateKeys: menu(["❯ 1. first", "  1. dup", "  2. second", "  2. dup2"]),
  staleResidue: menu(["❯ 1. old menu A", "  2. old menu B"], [], [...filler(20, "reply"), "1. new list", "2. more"]),
  residueOutOfWindow: menu(["❯ 1. old A", "  2. old B"], [], filler(30, "reply")),
  windowEdge: menu(["❯ 1. edge", "  2. inside"], [], filler(28)),
  windowEdgeOut: menu(["❯ 1. edge", "  2. inside"], [], filler(29)),
  longLabel: menu([`❯ 1. ${"x".repeat(120)}`, `  2. ${"中".repeat(90)}`, "  3.   spaced    out\tlabel   "]),
  twoDigit: menu(["❯ 10. ten", "  11. eleven", "  100. too long", "  7.no-space"]),
  many: menu(Array.from({ length: 28 }, (_, i) => `${i === 0 ? "❯" : " "} ${i + 1}. item ${i + 1}`)),
  manyBeyond30: menu(Array.from({ length: 35 }, (_, i) => `${i === 34 ? "❯" : " "} ${i + 1}. item ${i + 1}`)),
  trailingBlanks: menu(["Trust this folder?", "❯ 1. Yes, proceed", "  2. No, exit"], filler(3), Array(40).fill("")),
  tallPane: menu(["❯ 1. Yes", "  2. No"], filler(200), ["", "  Esc to cancel", ...Array(10).fill("   ")]),
  trustPrompt: readFileSync(join(import.meta.dir, "fixtures/cc-bypass-consent-pane.txt"), "utf8"),
  crlf: "❯ 1. Yes\r\n  2. No\r\n",
  boxed: menu(["│ ❯ 1. boxed │", "│   2. boxed │"]),
  noSelected: menu(["  1. a", "  2. b"]),
  empty: "",
  blankOnly: "\n\n   \n",
};

// 基线 modal-confirm.ts 原文，tmux-helper 依赖换成「现 tmux-helper + 基线 parseModalOptions」的 shim，其余相对 import 指回源码
const shim = join(temp, "helper-shim.ts");
writeFileSync(shim, `export * from ${JSON.stringify(join(ROOT, "src/lib/tmux-helper.ts"))};\nexport { parseModalOptions } from ${JSON.stringify(oraclePath)};\n`);
const confirmSrc = spawnSync("git", ["show", `${BASE}:src/lib/modal-confirm.ts`], { cwd: ROOT, env, encoding: "utf8" });
if (confirmSrc.status !== 0) throw new Error(`Cannot load fixed modal-confirm baseline: ${confirmSrc.stderr}`);
const oldConfirmPath = join(temp, "modal-confirm-baseline.ts");
writeFileSync(oldConfirmPath, confirmSrc.stdout.replace(/from "(\.\/[^"]+)\.js"/g, (_all, spec: string) =>
  `from ${JSON.stringify(spec === "./tmux-helper" ? shim : join(ROOT, "src/lib", `${spec}.ts`))}`));
const oldConfirm: { isAutoConfirmableModal: typeof isAutoConfirmableModal } = await import(oldConfirmPath);
const CONFIRM: Record<string, string> = {
  devChannels: menu(["WARNING: Loading development channels", "", "Channels: server:claudestra", "",
    "❯ 1. I am using this for local development", "  2. Exit", "", "Enter to confirm · Esc to cancel"], [], Array(35).fill("")),
  permission: menu(["Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "Enter to confirm · Esc to cancel"]),
  exitSelected: menu(["Something", "❯ 1. No, exit", "  2. Yes"]),
  residueThenShell: menu(["❯ 1. Yes", "  2. No", "user@host ~ % "]),
  sessionIdle: menu(["This session is 21h 6m old and 913.2k tokens.", "❯ 1. Continue", "  2. Clear"]),
};

describe("modal-numbered-options 迁出等价", () => {
  test("tmux-helper 旧入口就是新模块同一函数", () => {
    expect(helper.parseModalOptions).toBe(pure.parseModalOptions);
  });

  for (const [name, pane] of Object.entries(CASES)) {
    test(`基线 oracle 与新模块 / 旧入口逐字段一致：${name}`, () => {
      const want = oracle.parseModalOptions(pane);
      expect(JSON.stringify(pure.parseModalOptions(pane))).toBe(JSON.stringify(want));
      expect(JSON.stringify(helper.parseModalOptions(pane))).toBe(JSON.stringify(want));
    });
  }

  test("用例覆盖到命中 / 未命中 / 截断 25 / 截 80 字符", () => {
    expect(oracle.parseModalOptions(CASES.basic)?.length).toBe(3);
    expect(oracle.parseModalOptions(CASES.plainNumberedReply)).toBeNull();
    expect(oracle.parseModalOptions(CASES.many)?.length).toBe(25);
    expect(oracle.parseModalOptions(CASES.longLabel)?.[0]?.label.length).toBe(80);
    expect(oracle.parseModalOptions(CASES.windowEdge)).not.toBeNull();
    expect(oracle.parseModalOptions(CASES.windowEdgeOut)).toBeNull();
    expect(oracle.parseModalOptions(CASES.trailingBlanks)).not.toBeNull();
  });

  test("真实调用方 isAutoConfirmableModal：现接线与基线 parseModalOptions 接线逐屏一致", () => {
    for (const [name, pane] of Object.entries({ ...CASES, ...CONFIRM })) {
      for (const opts of [{}, { allowSessionIdle: true }]) {
        expect(`${name}:${isAutoConfirmableModal(pane, opts)}`).toBe(`${name}:${oldConfirm.isAutoConfirmableModal(pane, opts)}`);
      }
    }
    expect(isAutoConfirmableModal(CONFIRM.devChannels)).toBe(true);
  });

  test("新模块只 import pane-tail，不回引 tmux-helper / 外设", () => {
    const src = readFileSync(join(ROOT, "src/lib/modal-numbered-options.ts"), "utf8");
    expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["./pane-tail.js"]);
  });
});
