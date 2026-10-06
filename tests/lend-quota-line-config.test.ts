/**
 * lib/lend-quota-line-config.ts（QLINE1）：missing → 默认 70/80 on；invalid（坏 JSON / 未知字段 / 缺家族 / 越界 / 提醒线不低于停线）→ 按默认执行并如实标 invalid；
 * 补丁校验（非法整份拒、零副作用）；改一族不改另一族；并发写不丢更新；坏文件另存后可被网页重存修好；不碰 lend.json。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultQuotaLines, parsePatch, quotaLinesProblem, readQuotaLines, readQuotaLinesSync, saveQuotaLines } from "../src/lib/lend-quota-line-config.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "qline-cfg-")); dirs.push(d); return join(d, "lend-quota-lines.json"); };

describe("读", () => {
  test("missing = 默认 on、两族 70/80", async () => {
    const p = tmp();
    const r = await readQuotaLines(p);
    expect(r.status).toBe("missing");
    expect(r.file).toEqual({ v: 1, mode: "on", families: { codex: { warnPct: 70, stopPct: 80 }, claude: { warnPct: 70, stopPct: 80 } } });
    expect(readQuotaLinesSync(p).status).toBe("missing");
  });
  const bad: [string, unknown][] = [
    ["坏 JSON", "{"], ["未知顶层字段", { ...defaultQuotaLines(), x: 1 }], ["未知家族", { ...defaultQuotaLines(), families: { ...defaultQuotaLines().families, pi: { warnPct: 1, stopPct: 2 } } }],
    ["缺家族", { v: 1, mode: "on", families: { codex: { warnPct: 70, stopPct: 80 } } }], ["mode 非法", { ...defaultQuotaLines(), mode: "maybe" }],
    ["提醒线 = 停线", { ...defaultQuotaLines(), families: { ...defaultQuotaLines().families, codex: { warnPct: 80, stopPct: 80 } } }],
    ["越界 101", { ...defaultQuotaLines(), families: { ...defaultQuotaLines().families, claude: { warnPct: 70, stopPct: 101 } } }],
    ["小数", { ...defaultQuotaLines(), families: { ...defaultQuotaLines().families, claude: { warnPct: 70.5, stopPct: 80 } } }],
  ];
  for (const [name, v] of bad) {
    test(`invalid（${name}）：按默认执行、标 invalid 带原因`, async () => {
      const p = tmp();
      writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
      const r = await readQuotaLines(p);
      expect(r.status).toBe("invalid");
      expect(r.file).toEqual(defaultQuotaLines());
      expect(r.status === "invalid" && r.error.length > 0).toBe(true);
    });
  }
  test("合法文件原样读出", async () => {
    const p = tmp();
    const f = { v: 1, mode: "observe", families: { codex: { warnPct: 0, stopPct: 100 }, claude: { warnPct: 10, stopPct: 20 } } };
    writeFileSync(p, JSON.stringify(f));
    expect(await readQuotaLines(p)).toEqual({ status: "ok", file: f as never });
  });
});

describe("补丁校验", () => {
  const rejects: [string, unknown][] = [
    ["空", {}], ["数组", []], ["未知字段", { family: "codex", warnPct: 70, stopPct: 80, peer: "x" }], ["身份字段", { mode: "on", principal: "owner:self" }],
    ["缺家族", { warnPct: 70, stopPct: 80 }], ["未知家族", { family: "pi", warnPct: 70, stopPct: 80 }], ["缺停线", { family: "codex", warnPct: 70 }],
    ["字符串数", { family: "codex", warnPct: "70", stopPct: 80 }], ["NaN", { family: "codex", warnPct: Number.NaN, stopPct: 80 }],
    ["Infinity", { family: "codex", warnPct: 70, stopPct: Number.POSITIVE_INFINITY }], ["负数", { family: "codex", warnPct: -1, stopPct: 80 }],
    ["提醒 >= 停", { family: "codex", warnPct: 90, stopPct: 80 }], ["mode 非法", { mode: "auto" }],
  ];
  for (const [name, b] of rejects) test(`拒：${name}`, () => expect(typeof parsePatch(b)).toBe("string"));
  test("收：一族两条线 / 模式 / 两者", () => {
    expect(parsePatch({ family: "claude", warnPct: 0, stopPct: 1 })).toEqual({ family: "claude", warnPct: 0, stopPct: 1 });
    expect(parsePatch({ mode: "off" })).toEqual({ mode: "off" });
    expect(parsePatch({ mode: "observe", family: "codex", warnPct: 60, stopPct: 100 })).toEqual({ mode: "observe", family: "codex", warnPct: 60, stopPct: 100 });
  });
  test("整份校验：默认合法", () => expect(quotaLinesProblem(defaultQuotaLines())).toBeNull());
});

describe("写", () => {
  test("改 codex 不改 claude；文件 0600、可读回", async () => {
    const p = tmp();
    const r = await saveQuotaLines({ family: "codex", warnPct: 50, stopPct: 60 }, p);
    expect(r.ok).toBe(true);
    const back = await readQuotaLines(p);
    expect(back).toEqual({ status: "ok", file: { v: 1, mode: "on", families: { codex: { warnPct: 50, stopPct: 60 }, claude: { warnPct: 70, stopPct: 80 } } } });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    await saveQuotaLines({ mode: "observe" }, p);
    expect((await readQuotaLines(p)).file.families.codex).toEqual({ warnPct: 50, stopPct: 60 });
  });
  test("并发改两族：都留下（锁内现读、原子写）", async () => {
    const p = tmp();
    const rs = await Promise.all([
      saveQuotaLines({ family: "codex", warnPct: 10, stopPct: 20 }, p), saveQuotaLines({ family: "claude", warnPct: 30, stopPct: 40 }, p), saveQuotaLines({ mode: "off" }, p),
    ]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect((await readQuotaLines(p)).file).toEqual({ v: 1, mode: "off", families: { codex: { warnPct: 10, stopPct: 20 }, claude: { warnPct: 30, stopPct: 40 } } });
    expect(readdirSync(join(p, "..")).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
  });
  test("坏文件：另存原文件，以默认为底写入，回报 replacedInvalid", async () => {
    const p = tmp();
    writeFileSync(p, "{oops");
    const r = await saveQuotaLines({ family: "claude", warnPct: 60, stopPct: 70 }, p, 123);
    expect(r).toMatchObject({ ok: true, replacedInvalid: expect.any(String) });
    expect(readFileSync(`${p}.invalid-123`, "utf8")).toBe("{oops");
    expect((await readQuotaLines(p)).file.families).toEqual({ codex: { warnPct: 70, stopPct: 80 }, claude: { warnPct: 60, stopPct: 70 } });
  });
  test("锁被占着：busy，不写", async () => {
    const p = tmp();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${p}.lock`);
    writeFileSync(join(`${p}.lock`, "owner"), "someone");
    const r = await saveQuotaLines({ mode: "off" }, p);
    expect(r).toMatchObject({ ok: false, code: "busy" });
    expect(existsSync(p)).toBe(false);
  }, 15_000);
  test("写不进去（上级是文件不是目录）：ok:false，不报已生效", async () => {
    const blocker = tmp();
    writeFileSync(blocker, "file-not-dir");
    const r = await saveQuotaLines({ mode: "off" }, join(blocker, "x.json"));
    expect(r.ok).toBe(false);
  }, 15_000);
});
