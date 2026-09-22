// scripts/guard 的规则与棘轮语义：全部用内存 fixture（Map<path, text>），不碰磁盘。
import { describe, expect, test } from "bun:test";
import { checkRaised, compare, initLimits, loosenings, parseBaseline, tighten } from "../scripts/guard/ratchet.ts";
import { countCommentBlocks, measureComments } from "../scripts/guard/rules/comments.ts";
import { parseKnip } from "../scripts/guard/rules/dead.ts";
import { collectEdges, findCycles, measureDeps } from "../scripts/guard/rules/deps.ts";
import { measureDup } from "../scripts/guard/rules/dup.ts";
import { measureFn, type SpanParser } from "../scripts/guard/rules/fn.ts";
import { commentExplains, measurePatterns } from "../scripts/guard/rules/patterns.ts";
import { lineCount, measureSize } from "../scripts/guard/rules/size.ts";
import { measureTwins } from "../scripts/guard/rules/twins.ts";
import type { Baseline } from "../scripts/guard/types.ts";

const files = (o: Record<string, string>) => new Map(Object.entries(o));
const lines = (n: number, fill = "x;") => `${Array.from({ length: n }, () => fill).join("\n")}\n`;
const none = new Set<string>();

describe("size", () => {
  test("代码 400 / tests 600 / 数据文件 1000 的默认上限", () => {
    const r = measureSize(
      files({
        "src/a.ts": lines(401),
        "src/ok.ts": lines(400),
        "tests/a.test.ts": lines(600),
        "tests/b.test.ts": lines(601),
        "web/lib/i18n-dict.ts": lines(999),
      }),
      new Map(),
    );
    expect(r.counts["size:src/a.ts"]).toBe(401);
    expect(r.counts["size:src/ok.ts"]).toBeUndefined();
    expect(r.counts["size:tests/a.test.ts"]).toBeUndefined();
    expect(r.counts["size:tests/b.test.ts"]).toBe(601);
    expect(r.counts["size:web/lib/i18n-dict.ts"]).toBeUndefined();
  });

  test("超过 200 字符的行计入 longLine；文档按 UTF-8 字节计", () => {
    const r = measureSize(files({ "src/a.ts": `${"a".repeat(201)}\n${"b".repeat(200)}\n` }), files({ "CLAUDE.md": "中文" }));
    expect(r.counts["longLine:total"]).toBe(1);
    expect(r.counts["doc:CLAUDE.md"]).toBe(6);
  });

  test("lineCount 不把末尾换行算成一行", () => {
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("")).toBe(0);
  });
});

describe("fn", () => {
  // 假解析器：每个 `function` 行开始一个函数，到下一个 `}` 顶格行结束
  const fake: SpanParser = (_f, src) => {
    const ls = src.split("\n");
    const out: { start: number; end: number }[] = [];
    ls.forEach((l, i) => {
      if (!l.startsWith("function")) return;
      const end = ls.findIndex((x, j) => j > i && x === "}");
      out.push({ start: i + 1, end: end + 1 });
    });
    return out;
  };
  const longFn = (name: string, body: number) => `function ${name}() {\n${lines(body, "  x();")}}\n`;

  test("超出量按全仓累加，签名行进 fnLong", () => {
    const r = measureFn(files({ "src/a.ts": longFn("big", 148), "src/b.ts": longFn("small", 10) }), fake);
    expect(r.counts["fn:overflow"]).toBe(50);
    expect(r.counts["fnLong:function big() {"]).toBe(1);
    expect(r.counts["fnLong:function small() {"]).toBeUndefined();
  });

  test("把超长函数原样搬进新文件：总量与签名都不变", () => {
    const before = measureFn(files({ "src/big.ts": longFn("big", 200) + longFn("keep", 5) }), fake).counts;
    const after = measureFn(files({ "src/big.ts": longFn("keep", 5), "src/lib/moved.ts": longFn("big", 200) }), fake).counts;
    expect(compare(before, after, none).failures).toEqual([]);
  });

  test("新写一个超长函数：签名不在 baseline → 失败", () => {
    const base = measureFn(files({ "src/a.ts": longFn("old", 300) }), fake).counts;
    const cur = measureFn(files({ "src/a.ts": longFn("old", 150), "src/b.ts": longFn("fresh", 120) }), fake).counts;
    expect(compare(base, cur, none).failures.map((f) => f.key)).toEqual(["fnLong:function fresh() {"]);
  });

  test("tests/ 不计函数长度", () => {
    expect(measureFn(files({ "tests/x.test.ts": longFn("big", 300) }), fake).counts["fn:overflow"]).toBe(0);
  });
});

describe("deps", () => {
  test("lib 只能 import lib；动态 import 也扫；type-only 不算", () => {
    const r = measureDeps(
      files({
        "src/lib/a.ts": `import { x } from "../bridge/b.js";\nimport type { T } from "../bridge/c.js";`,
        "src/lib/d.ts": `const m = await import("../bridge/b.js");`,
        "src/bridge/b.ts": "export const x = 1;",
        "src/bridge/c.ts": "export type T = 1;",
      }),
    );
    expect(Object.keys(r.counts).sort()).toEqual([
      "deps:lib-only-lib: src/lib/a.ts -> src/bridge/b.ts",
      "deps:lib-only-lib: src/lib/d.ts -> src/bridge/b.ts",
    ]);
  });

  test("bridge 枢纽、watcher 互相 import、入口互相 import、tests → 入口", () => {
    const r = measureDeps(
      files({
        "src/bridge/wedge-watcher.ts": `import { a } from "./management.js";\nimport { b } from "./jsonl-watcher.js";`,
        "src/bridge/management.ts": "export const a = 1;",
        "src/bridge/jsonl-watcher.ts": "export const b = 1;",
        "src/manager.ts": `import { c } from "./cron.js";`,
        "src/cron.ts": "export const c = 1;",
        "tests/cron.test.ts": `import { c } from "../src/cron";`,
      }),
    );
    expect(Object.keys(r.counts).sort()).toEqual([
      "deps:bridge-hub-leaf: src/bridge/wedge-watcher.ts -> src/bridge/management.ts",
      "deps:entry-no-entry: src/manager.ts -> src/cron.ts",
      "deps:tests-no-entry: tests/cron.test.ts -> src/cron.ts",
      "deps:watcher-no-watcher: src/bridge/wedge-watcher.ts -> src/bridge/jsonl-watcher.ts",
    ]);
  });

  test("web 与 src 互不 import；tests → web 只许纯模块", () => {
    const r = measureDeps(
      files({
        "web/lib/a.ts": `import { x } from "../../src/lib/x.js";`,
        "src/lib/x.ts": "export const x = 1;",
        "tests/w.test.ts": `import { p } from "@/lib/pure";\nimport { u } from "@/lib/ui";`,
        "web/lib/pure.ts": "export const p = 1;",
        "web/lib/ui.ts": `import { useState } from "react";\nexport const u = 1;`,
      }),
    );
    expect(Object.keys(r.counts).sort()).toEqual([
      "deps:tests-web-pure: tests/w.test.ts -> web/lib/ui.ts",
      "deps:web-src-split: web/lib/a.ts -> src/lib/x.ts",
    ]);
  });

  test("运行时环被找出来；注释里的 import 不算", () => {
    const f = files({
      "src/lib/a.ts": `import { b } from "./b.js";\n// import { c } from "./c.js";`,
      "src/lib/b.ts": `import { a } from "./a.js";`,
      "src/lib/c.ts": "export const c = 1;",
    });
    expect(findCycles(collectEdges(f))).toEqual([["src/lib/a.ts", "src/lib/b.ts"]]);
  });
});

describe("dup", () => {
  const block = ["const a = compute(1);", "const b = compute(2);", "if (a > b) log(a);", "else log(b);"];
  const code = [...block, "return merge(a, b);", "cleanup(a, b);"].join("\n");

  test("6 条有效行复制到另一个文件 → 两边各计 6 行", () => {
    expect(measureDup(files({ "src/a.ts": code, "src/b.ts": code })).counts["dup:total"]).toBe(12);
  });

  test("插空行、插注释、改缩进不改变计数", () => {
    const noisy = code.replace("else log(b);", "\n  // 说明\n   else   log(b);\n\n");
    expect(measureDup(files({ "src/a.ts": code, "src/b.ts": noisy })).counts["dup:total"]).toBe(12);
  });

  test("tests/ 与 twin 的第二份不计", () => {
    expect(measureDup(files({ "src/a.ts": code, "tests/b.test.ts": code })).counts["dup:total"]).toBe(0);
    const twin = files({ "src/lib/inline-buttons.ts": code, "web/lib/chat/inline-buttons.ts": code });
    expect(measureDup(twin).counts["dup:total"]).toBe(0);
  });
});

describe("patterns", () => {
  test("绕过 tmux-helper 的写法按总数计；规范实现本身和 tests 不算", () => {
    const r = measurePatterns(
      files({
        "src/bridge/x.ts": "tmux(`master:${name}`);\nspawn([\"tmux\", \"send-keys\"]);",
        "src/lib/tmux-helper.ts": "const t = `master:${name}`;",
        "tests/x.test.ts": "const t = `master:${name}`;",
      }),
    );
    expect(r.counts["pattern:tmux-target-literal"]).toBe(1);
    expect(r.counts["pattern:raw-tmux-spawn"]).toBe(1);
  });

  test("无注释或占位注释的吞错计数；写了理由的放行", () => {
    const src = [
      "try { a(); } catch {}",
      "try { a(); } catch (e) { /* 同上 */ }",
      "try { a(); } catch { /* ignore */ }",
      "try { a(); } catch { /* non-critical */ }",
      "try { a(); } catch { /* 进程可能已退出，kill 失败无害 */ }",
      "p.catch(() => {});",
      "p.catch(() => undefined);",
      "p.catch(() => {}); // 通知失败不影响主流程，下一轮会重试",
      "p.catch((e) => { /* 窗口已关闭时 send 必然失败 */ });",
      "try { a(); } catch { cleanup(); }",
    ].join("\n");
    const r = measurePatterns(files({ "src/x.ts": src }));
    expect(r.counts["catch:empty-block"]).toBe(4);
    expect(r.counts["catch:silent-promise"]).toBe(2);
  });

  test("commentExplains：长度与占位词", () => {
    expect(commentExplains("/* ignore */")).toBe(false);
    expect(commentExplains("// best-effort")).toBe(false);
    expect(commentExplains("// 忽略")).toBe(false);
    expect(commentExplains("// 文件不存在就用默认值")).toBe(true);
    expect(commentExplains("// socket closed; nothing to flush")).toBe(true);
  });

  test("web/app/api 路由不调 isAuthed 且不在公开清单 → 违规", () => {
    const r = measurePatterns(
      files({
        "web/app/api/secret/route.ts": "export async function GET() { return ok(); }",
        "web/app/api/fine/route.ts": "export async function GET(r) { if (!isAuthed(r)) return no(); }",
        "web/app/api/version/route.ts": "export async function GET() { return ok(); }",
      }),
    );
    expect(Object.keys(r.counts).filter((k) => k.startsWith("route:"))).toEqual(["route:web/app/api/secret/route.ts"]);
  });
});

describe("twins", () => {
  const pair: [string, string][] = [["src/lib/t.ts", "web/lib/t.ts"]];
  test("去注释后一致即通过；改一个字符就报", () => {
    const a = "// 服务端版本\nexport const f = (x) => x + 1;\n";
    const b = "/* web 版本 */\nexport const f = (x) => x + 1;\n";
    expect(measureTwins(files({ "src/lib/t.ts": a, "web/lib/t.ts": b }), pair).counts).toEqual({});
    const drift = measureTwins(files({ "src/lib/t.ts": a, "web/lib/t.ts": b.replace("+ 1", "+ 2") }), pair);
    expect(drift.counts).toEqual({ "twins:src/lib/t.ts <-> web/lib/t.ts": 1 });
  });
});

describe("comments", () => {
  test("函数体内连续 8 行注释算一块，顶层文档注释不算", () => {
    const inner = `function f() {\n${lines(8, "  // 叙事")}  run();\n}\n`;
    const top = `${lines(12, "// 文件头说明")}export const x = 1;\n`;
    expect(countCommentBlocks(inner)).toBe(1);
    expect(countCommentBlocks(top)).toBe(0);
    expect(countCommentBlocks(`function f() {\n${lines(7, "  // 短")}}\n`)).toBe(0);
    expect(measureComments(files({ "src/a.ts": inner, "tests/a.test.ts": inner })).counts["comments:blocks"]).toBe(1);
  });
});

describe("dead（knip 输出解析）", () => {
  test("exports / types / files 都转成 file#name", () => {
    const json = JSON.stringify({
      files: ["src/orphan.ts"],
      issues: [{ file: "src/lib/a.ts", exports: [{ name: "x" }], types: [{ name: "T" }], files: [] }],
    });
    expect(parseKnip(json)).toEqual({ "dead:src/orphan.ts#<file>": 1, "dead:src/lib/a.ts#x": 1, "dead:src/lib/a.ts#T": 1 });
  });
});

describe("棘轮语义", () => {
  test("check：超 baseline 失败；没有条目的按默认上限；低于 baseline 只提示可收紧", () => {
    const limits = { "size:src/big.ts": 500, "dup:total": 10 };
    const v = compare(limits, { "size:src/big.ts": 501, "size:src/new.ts": 401, "dup:total": 9 }, none);
    expect(v.failures.map((f) => f.key)).toEqual(["size:src/big.ts", "size:src/new.ts"]);
    expect(v.tightenable.map((f) => f.key)).toEqual(["dup:total"]);
  });

  test("被跳过的规则（依赖缺席）不检查", () => {
    const v = compare({}, { "dead:src/a.ts#x": 1 }, new Set(["dead"]));
    expect(v.failures).toEqual([]);
  });

  test("--update 只收紧：取 min、降到上限内删除、永不新增", () => {
    const limits = { "size:src/big.ts": 500, "size:src/shrunk.ts": 450, "dup:total": 10, "deps:a -> b": 1 };
    const cur = { "size:src/big.ts": 520, "size:src/shrunk.ts": 390, "dup:total": 7, "size:src/new.ts": 900 };
    expect(tighten(limits, cur, none)).toEqual({ "dup:total": 7, "size:src/big.ts": 500 });
  });

  test("--update 不动被跳过规则的条目", () => {
    expect(tighten({ "dead:a#x": 1 }, {}, new Set(["dead"]))).toEqual({ "dead:a#x": 1 });
  });

  test("放宽必须在 raised[] 有 from=基准值、to≥新值、why≥10 字的记录", () => {
    const base: Baseline = { version: 1, limits: { "size:src/a.ts": 500 }, raised: [] };
    const cur: Baseline = { version: 1, limits: { "size:src/a.ts": 520, "deps:x -> y": 1 }, raised: [] };
    expect(checkRaised(base, cur)).toEqual(["size:src/a.ts 500 → 520", "deps:x -> y 0 → 1"]);
    cur.raised = [{ key: "size:src/a.ts", from: 500, to: 520, why: "太短" }];
    expect(checkRaised(base, cur)).toHaveLength(2);
    cur.raised = [
      { key: "size:src/a.ts", from: 500, to: 520, why: "新协议解析暂时只能放这里，下个版本拆出" },
      { key: "deps:x -> y", from: 0, to: 1, why: "临时依赖：等 lib/manager-client.ts 落地后删" },
    ];
    expect(checkRaised(base, cur)).toEqual([]);
  });

  test("旧的 raised 记录不能被复用到下一次放宽（from 必须等于基准值）", () => {
    const base: Baseline = { version: 1, limits: { "size:src/a.ts": 520 }, raised: [] };
    const cur: Baseline = {
      version: 1,
      limits: { "size:src/a.ts": 600 },
      raised: [{ key: "size:src/a.ts", from: 500, to: 700, why: "上一次放宽的理由写得很长" }],
    };
    expect(checkRaised(base, cur)).toEqual(["size:src/a.ts 520 → 600"]);
  });

  test("收紧与删除条目不需要 raised；没有基准 baseline 时不比对", () => {
    const base: Baseline = { version: 1, limits: { "size:src/a.ts": 500, "dup:total": 9 }, raised: [] };
    const cur: Baseline = { version: 1, limits: { "size:src/a.ts": 450 }, raised: [] };
    expect(checkRaised(base, cur)).toEqual([]);
    expect(checkRaised(null, cur)).toEqual([]);
  });

  test("--init：只记超上限的项，被跳过规则沿用旧条目；loosenings 列出变大的项", () => {
    const limits = initLimits({ "size:src/a.ts": 380, "size:src/b.ts": 700, "dup:total": 3 }, { "dead:x#y": 1 }, new Set(["dead"]));
    expect(limits).toEqual({ "dead:x#y": 1, "dup:total": 3, "size:src/b.ts": 700 });
    expect(loosenings({ "size:src/b.ts": 650 }, limits)).toEqual([
      { key: "dead:x#y", from: 0, to: 1, why: "" },
      { key: "dup:total", from: 0, to: 3, why: "" },
      { key: "size:src/b.ts", from: 650, to: 700, why: "" },
    ]);
  });

  test("baseline 结构坏了直接报错，不会被当成没有 baseline", () => {
    expect(() => parseBaseline(`{"version":1,"limits":{"a":"x"},"raised":[]}`)).toThrow();
    expect(() => parseBaseline(`{"limits":{}}`)).toThrow();
    expect(parseBaseline(`{"version":1,"limits":{"a":1},"raised":[]}`).limits.a).toBe(1);
  });
});
