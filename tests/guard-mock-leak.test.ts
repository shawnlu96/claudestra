// MOCKLEAK1：guard 的 mockleak 规则（scripts/guard/rules/mock-leak.ts）。内存 Files 夹具，被 mock 的模块也放进 Files。
import { describe, expect, test } from "bun:test";
import { measureMockLeak } from "../scripts/guard/rules/mock-leak.ts";

const CONTACTS = "export interface ContactsSnap { a: 1 }\nexport function useContacts() {}\nexport function useFullScope() {}\nexport function fullScopeNow() {}\n";
const DND = "export function dragAllowed() {}\nexport function dragHandlers(d) {}\nexport function useAgentDrop(t) {}\n";
const SOURCE = "export function statsFoldFor() {}\nexport function sessionJsonlPath(r, c, s) {}\nexport type LineTranslator = () => void;\n";
const MODULES: Record<string, string> = {
  "web/features/chat/contacts-data.ts": CONTACTS,
  "web/features/chat/components/agent-dnd.tsx": DND,
  "src/lib/session-source.ts": SOURCE,
};

function measure(test: string, extra: Record<string, string> = {}, file = "tests/x.test.ts") {
  const r = measureMockLeak(new Map(Object.entries({ ...MODULES, ...extra, [file]: test })));
  return { partial: r.counts["mockleak:partial"], live: r.counts["mockleak:live-ns"], detail: r.detail ?? [] };
}

describe("[验收线 1] 历史形状", () => {
  test("4b4ed401b 修之前的 contacts-data：只给 useFullScope 计 partial 1；修好后 0", () => {
    const before = measure(`mock.module("@/features/chat/contacts-data", () => ({ useFullScope: () => state.manage }));`);
    expect(before).toMatchObject({ partial: 1, live: 0 });
    expect(before.detail).toEqual(['mockleak tests/x.test.ts:1 "@/features/chat/contacts-data" 缺 2 个导出:useContacts, fullScopeNow']);
    const after = measure([
      `const contactsData: Record<string, unknown> = await import(new URL("../web/features/chat/contacts-data.ts", import.meta.url).href);`,
      `mock.module("@/features/chat/contacts-data", () => ({ ...contactsData, useFullScope: () => state.manage }));`,
    ].join("\n"));
    expect(after).toMatchObject({ partial: 0, live: 0 });
  });

  test("5d4892bd9 修之前的 agent-dnd：只留 useAgentDrop 计 partial 1；修好后 0", () => {
    const before = measure(`mock.module("@/features/chat/components/agent-dnd", () => ({ useAgentDrop: () => ({ over: false, handlers: {} }) }));`);
    expect(before.partial).toBe(1);
    expect(before.detail[0]).toContain("dragAllowed, dragHandlers");
    const after = measure([
      `const agentDnd: Record<string, unknown> = await import(new URL("../web/features/chat/components/agent-dnd.tsx", import.meta.url).href);`,
      `mock.module("@/features/chat/components/agent-dnd", () => ({ ...agentDnd, useAgentDrop: () => ({ over: false, handlers: {} }) }));`,
    ].join("\n"));
    expect(after.partial).toBe(0);
  });

  test("c689cbeed 修之前经 realSource.sessionJsonlPath 转调计 live-ns 1；修好后（快照 + 工厂外取真函数）0", () => {
    const factory = (call: string) => [
      `mock.module("../src/lib/session-source.js", () => ({`,
      `  ...realSource,`,
      `  sessionJsonlPath: (runtime: string | undefined, cwd: string, sessionId: string) =>`,
      `    cwd === CWD ? sessionFile : ${call}(runtime, cwd, sessionId),`,
      `}));`,
    ].join("\n");
    const before = measure(`const realSource = await import("../src/lib/session-source.js");\n${factory("realSource.sessionJsonlPath")}`);
    expect(before).toMatchObject({ partial: 0, live: 1 });
    expect(before.detail).toEqual(["mockleak tests/x.test.ts:2 经活命名空间 realSource 调自己"]);
    const after = measure([
      `const realSource = { ...(await import("../src/lib/session-source.js")) };`,
      `const realPath = realSource.sessionJsonlPath;`,
      factory("realPath"),
    ].join("\n"));
    expect(after).toMatchObject({ partial: 0, live: 0 });
  });

  test("import * as X 也是活命名空间；join(import.meta.dir, …) 的说明符照样解析", () => {
    const src = [
      `import * as real from "../src/lib/session-source.ts";`,
      `mock.module(join(import.meta.dir, "../src/lib/session-source.ts"), () => ({ ...real, sessionJsonlPath: (...a) => real.sessionJsonlPath(...a) }));`,
    ].join("\n");
    expect(measure(src)).toMatchObject({ partial: 0, live: 1 });
  });
});

describe("[验收线 2] 不误报", () => {
  test("展开快照、列全运行时导出（键的各种写法）、只缺 type / interface 计 0", () => {
    expect(measure(`const real = { ...await import("@/features/chat/contacts-data") };\nmock.module("@/features/chat/contacts-data", () => ({ ...real, useFullScope: () => true }));`).partial).toBe(0);
    const full = `mock.module("@/features/chat/components/agent-dnd", () => ({\n  dragAllowed,\n  "dragHandlers": () => ({}),\n  useAgentDrop(t) { return {}; },\n}));`;
    expect(measure(full).partial).toBe(0);
    const getters = `mock.module("@/features/chat/contacts-data", () => ({ async useContacts() {}, get useFullScope() { return f; }, fullScopeNow }));`;
    expect(measure(getters).partial).toBe(0);
    expect(measure(`mock.module("../src/lib/session-source", () => { return { statsFoldFor, sessionJsonlPath: () => "" }; });`).partial).toBe(0);
  });

  test("String.raw 子进程脚本、注释里的 mock 不算；EXCLUDE 里的生成文件跳过", () => {
    expect(measure("const script = String.raw`\nmock.module(from(\"lib/registry\"), () => ({ readRegistryAgents: async () => [] }));\n`;").partial).toBe(0);
    expect(measure(`// mock.module("@/features/chat/contacts-data", () => ({ useFullScope }));`).partial).toBe(0);
    const gen = `mock.module("@/lib/build-info", () => ({ CLIENT_COMMIT: "" }));`;
    expect(measure(gen, { "web/lib/build-info.ts": "export const CLIENT_COMMIT = '';\nexport const CLIENT_VERSION = '';\n" }).partial).toBe(0);
  });

  test("在工厂外先取出真函数再调用、工厂里只展开活命名空间，都不算 live-ns", () => {
    const src = [
      `const real = await import("../src/lib/session-source.js");`,
      `const realPath = real.sessionJsonlPath;`,
      `mock.module("../src/lib/session-source.js", () => ({ ...real, sessionJsonlPath: (...a) => realPath(...a) }));`,
    ].join("\n");
    expect(measure(src)).toMatchObject({ partial: 0, live: 0 });
  });

  test("tests/ 以外的文件不扫", () => {
    expect(measure(`mock.module("@/features/chat/contacts-data", () => ({ useFullScope }));`, {}, "scripts/x.ts").partial).toBe(0);
  });
});

describe("[验收线 2] 列不全时只认展开", () => {
  test("包名、变量路径没有展开计 1；展开了计 0", () => {
    expect(measure(`mock.module("fs/promises", () => ({ readFile: async () => "" }));`).partial).toBe(1);
    expect(measure(`mock.module(path, () => ({ CollabEntry: () => null }));`).partial).toBe(1);
    expect(measure(`mock.module(root + "src/lib/run-manager.ts", () => ({ runManagerProcess }));`).partial).toBe(1);
    expect(measure(`const real = await import("fs/promises");\nmock.module("fs/promises", () => ({ ...real, readFile: async () => "" }));`).partial).toBe(0);
    expect(measure(`mock.module(path, () => ({ ...real, ...over }));`).partial).toBe(0);
  });

  test("目标模块有 export * from 时，没展开就计 1（即便列了它自己的导出）", () => {
    const barrel = { "src/lib/barrel.ts": `export * from "./a.ts";\nexport function own() {}\n` };
    expect(measure(`mock.module("../src/lib/barrel.ts", () => ({ own: () => 1 }));`, barrel).partial).toBe(1);
    expect(measure(`const b = { ...await import("../src/lib/barrel.ts") };\nmock.module("../src/lib/barrel.ts", () => ({ ...b, own: () => 1 }));`, barrel).partial).toBe(0);
  });

  test("导出名认 export { a, b as c } / export * as ns / export default / class / const / enum，不认 export type { … }", () => {
    const mod = {
      "src/lib/m.ts": [
        `const a = 1, b = 2;`,
        `export { a, b as c, type T };`,
        `export * as ns from "./n.ts";`,
        `export default function () {}`,
        `export class K {}`,
        `export const enum E { X }`,
        `export let v = 1;`,
        `export type { U } from "./u.ts";`,
        `export declare const d: number;`,
      ].join("\n"),
    };
    const r = measure(`mock.module("../src/lib/m.js", () => ({ a }));`, mod);
    expect(r.detail).toEqual(['mockleak tests/x.test.ts:1 "../src/lib/m.js" 缺 6 个导出:default, K, E, v, ns, c']);
    expect(measure(`mock.module("../src/lib/m.js", () => ({ a, c, ns, default: f, K, E, v }));`, mod).partial).toBe(0);
  });
});

describe("[验收线 2] 只认工厂自己那层的 return（r1 审查 nested-return-object）", () => {
  const mod = { "src/lib/m.ts": "export function a() {}\nexport function b() {}\n" };
  test("嵌套函数里的 return {…} 不当成工厂的返回对象", () => {
    const fp = `mock.module("../src/lib/m.ts", () => {\n  const helper = () => { return {}; };\n  return { a, b };\n});`;
    expect(measure(fp, mod)).toMatchObject({ partial: 0, live: 0 });
    const fn = `mock.module("../src/lib/m.ts", () => {\n  const helper = () => { return { a, b }; };\n  return { a };\n});`;
    expect(measure(fn, mod)).toMatchObject({ partial: 1, live: 0, detail: ['mockleak tests/x.test.ts:1 "../src/lib/m.ts" 缺 1 个导出:b'] });
  });

  test("function 声明、方法、带返回类型的嵌套函数也跳过；if 块里的 return 仍算工厂的", () => {
    const nested = [
      `mock.module("../src/lib/m.ts", function () {`,
      `  function h(): Rec { return { a, b }; }`,
      `  const o = { m(x) { return { a, b }; } };`,
      `  if (flag) { return { a }; }`,
      `  return { a, b };`,
      `});`,
    ].join("\n");
    expect(measure(nested, mod).partial).toBe(1);
  });
});

describe("[验收线 2] 嵌套函数带内联对象 / 泛型返回类型也跳过（r2 审查 nested-return-object）", () => {
  const mod = { "src/lib/m.ts": "export const a = 1;\nexport const b = 2;\n" };
  const factory = (...lines: string[]) => [`mock.module("../src/lib/m.ts", () => {`, ...lines, `});`].join("\n");
  test("helper(): {} 返回空对象，工厂列全 → 0", () => {
    expect(measure(factory(`  function helper(): {} { return {}; }`, `  return { a, b };`), mod)).toMatchObject({ partial: 0, live: 0 });
  });
  test("helper(): { a: number; b: number } 列全，工厂只给 a → 1", () => {
    const r = measure(factory(`  function helper(): { a: number; b: number } {`, `    return { a, b };`, `  }`, `  return { a };`), mod);
    expect(r).toMatchObject({ partial: 1, live: 0, detail: ['mockleak tests/x.test.ts:1 "../src/lib/m.ts" 缺 1 个导出:b'] });
  });
  test("泛型 / 函数类型 / 方法的返回类型，以及 else / try 块里的 return", () => {
    const cases = [
      `  function h(): Promise<{ a: number }> { return { a, b }; }`,
      `  function h(): () => { a: 1 } { return { a, b }; }`,
      `  const o = { m(x: { k: 1 }): Array<{ a: 1 }> { return { a, b }; } };`,
      `  if (x) { y(); } else { return { a }; }`,
      `  try { return { a }; } finally { z(); }`,
    ];
    for (const c of cases) expect(measure(factory(c, `  return { a };`), mod).partial).toBe(1);
  });
});
