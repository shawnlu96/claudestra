import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_MAX_BYTES, handoffRoot, readAgentHandoff, saveAgentHandoff } from "../src/lib/agent-handoff.ts";

const A = "agent-codex-a";
const B = "agent-pm";
const registered = [A, B];
let root: string;
let stateDir: string;
let home: string;

/** 临时 HOME 下整棵 .claude 的快照：存交接前后必须逐项不变 */
const claudeTree = () => (existsSync(join(home, ".claude")) ? readdirSync(join(home, ".claude"), { recursive: true }).map(String).sort() : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "handoff-"));
  stateDir = join(root, "state");
  home = join(root, "home");
  mkdirSync(join(home, ".claude", "projects", "x", "memory"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "x", "memory", "HANDOFF.md"), "PM 的交接");
});
afterEach(() => {
  try { chmodSync(join(handoffRoot(stateDir), A), 0o700); } catch { /* 不在 */ }
  rmSync(root, { recursive: true, force: true });
});

const save = (over: Partial<Parameters<typeof saveAgentHandoff>[0]> = {}) => saveAgentHandoff({ agent: A, registered, opId: "op-1", text: "# 交接\n进度", stateDir, ...over });

describe("agent-handoff：落点与元数据", () => {
  test("写到 STATE_DIR/handoff/<名>/HANDOFF.md，带 opId / 时间；目录 0700、文件 0600；不碰 ~/.claude", async () => {
    const before = claudeTree();
    const r = await save({ now: () => new Date("2026-10-04T00:00:00Z") });
    expect(r.path).toBe(join(stateDir, "handoff", A, "HANDOFF.md"));
    expect(r).toMatchObject({ opId: "op-1", savedAt: "2026-10-04T00:00:00.000Z", agent: A, bytes: Buffer.byteLength("# 交接\n进度") });
    expect(readFileSync(r.path, "utf8")).toBe(`<!-- claudestra-handoff ${JSON.stringify({ opId: "op-1", savedAt: "2026-10-04T00:00:00.000Z", agent: A, bytes: r.bytes })} -->\n# 交接\n进度`);
    expect(lstatSync(r.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(stateDir, "handoff", A)).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(stateDir, "handoff")).mode & 0o777).toBe(0o700);
    expect(r.path.includes(".claude")).toBe(false);
    expect(claudeTree()).toEqual(before);
    expect(readFileSync(join(home, ".claude", "projects", "x", "memory", "HANDOFF.md"), "utf8")).toBe("PM 的交接");
    expect(readAgentHandoff(A, stateDir)).toEqual({ meta: { opId: "op-1", savedAt: "2026-10-04T00:00:00.000Z", agent: A, bytes: r.bytes }, text: "# 交接\n进度" });
  });

  test("同 agent 的新交接原子替换旧的；两个 agent 互不覆盖", async () => {
    await save({ opId: "op-1", text: "一" });
    await save({ agent: B, opId: "op-pm", text: "PM" });
    await save({ opId: "op-2", text: "二" });
    expect(readAgentHandoff(A, stateDir)?.meta.opId).toBe("op-2");
    expect(readAgentHandoff(A, stateDir)?.text).toBe("二");
    expect(readAgentHandoff(B, stateDir)?.text).toBe("PM");
    expect(readdirSync(join(stateDir, "handoff", A)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("没存过 → null", () => {
    expect(readAgentHandoff(A, stateDir)).toBeNull();
  });
});

describe("agent-handoff：校验", () => {
  test("不在 registry / 名字不能当目录名 → 拒，什么都不写", async () => {
    await expect(save({ agent: "agent-ghost" })).rejects.toThrow("不在 registry");
    for (const bad of ["../agent-pm", "a/b", ".", "..", "", "x\u0000y"]) {
      await expect(save({ agent: bad, registered: [...registered, bad] })).rejects.toThrow("不能安全地当目录名");
    }
    expect(existsSync(join(stateDir, "handoff", "agent-ghost"))).toBe(false);
    expect(existsSync(join(stateDir, "agent-pm"))).toBe(false);
  });

  test("空 / 全空白 / 超 16KB / 孤立代理项 / 坏 opId → 拒；正好 16KB 可以", async () => {
    await expect(save({ text: "" })).rejects.toThrow("不能为空");
    await expect(save({ text: "  \n\t" })).rejects.toThrow("不能为空");
    await expect(save({ text: 42 })).rejects.toThrow("不能为空");
    await expect(save({ text: "a".repeat(HANDOFF_MAX_BYTES + 1) })).rejects.toThrow("超过上限");
    await expect(save({ text: "中".repeat(Math.floor(HANDOFF_MAX_BYTES / 3) + 1) })).rejects.toThrow("超过上限");
    await expect(save({ text: "bad \uD800 half" })).rejects.toThrow("UTF-8");
    for (const opId of ["", "../x", "a b", 7, "x".repeat(129)]) await expect(save({ opId })).rejects.toThrow("opId");
    expect(existsSync(join(stateDir, "handoff", A, "HANDOFF.md"))).toBe(false);
    expect((await save({ text: "a".repeat(HANDOFF_MAX_BYTES) })).bytes).toBe(HANDOFF_MAX_BYTES);
  });
});

describe("agent-handoff：链接与逃逸", () => {
  test("agent 目录是指向外部的软链 → 拒，外部目录没被写", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(stateDir, "handoff"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(stateDir, "handoff", A));
    await expect(save()).rejects.toThrow("不是普通目录");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("handoff 根是软链 → 拒", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(stateDir, { recursive: true });
    symlinkSync(outside, join(stateDir, "handoff"));
    await expect(save()).rejects.toThrow("不是普通目录");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("HANDOFF.md 是指向外部文件（如 ~/.claude 下的交接）的软链 → 拒，目标原样", async () => {
    const target = join(home, ".claude", "projects", "x", "memory", "HANDOFF.md");
    mkdirSync(join(stateDir, "handoff", A), { recursive: true, mode: 0o700 });
    symlinkSync(target, join(stateDir, "handoff", A, "HANDOFF.md"));
    await expect(save()).rejects.toThrow("不是普通文件");
    expect(readFileSync(target, "utf8")).toBe("PM 的交接");
  });
});

describe("agent-handoff：并发与失败原子性", () => {
  test("并发十个写者：最终文件完整属于其中一个 op（元数据和正文对得上），没有残留 tmp", async () => {
    const ops = Array.from({ length: 10 }, (_, i) => `op-${i}`);
    const rs = await Promise.allSettled(ops.map((opId) => save({ opId, text: `正文属于 ${opId}\n${"x".repeat(2000)}` })));
    expect(rs.every((r) => r.status === "fulfilled")).toBe(true);
    const got = readAgentHandoff(A, stateDir)!;
    expect(ops).toContain(got.meta.opId);
    expect(got.text.startsWith(`正文属于 ${got.meta.opId}\n`)).toBe(true);
    expect(got.meta.bytes).toBe(Buffer.byteLength(got.text));
    expect(readdirSync(join(stateDir, "handoff", A)).sort()).toEqual(["HANDOFF.md"]);
  });

  test("写盘失败（目录不可写）：报错，旧文件和它的 op 绑定原样", async () => {
    await save({ opId: "op-old", text: "旧交接" });
    const before = readFileSync(join(stateDir, "handoff", A, "HANDOFF.md"), "utf8");
    chmodSync(join(stateDir, "handoff", A), 0o500);
    await expect(save({ opId: "op-new", text: "新交接" })).rejects.toThrow();
    chmodSync(join(stateDir, "handoff", A), 0o700);
    expect(readFileSync(join(stateDir, "handoff", A, "HANDOFF.md"), "utf8")).toBe(before);
    expect(readAgentHandoff(A, stateDir)?.meta.opId).toBe("op-old");
  });

  test("超大 / 空文本被拒时旧文件不动", async () => {
    await save({ opId: "op-old", text: "旧交接" });
    await expect(save({ opId: "op-big", text: "a".repeat(HANDOFF_MAX_BYTES + 1) })).rejects.toThrow();
    await expect(save({ opId: "op-empty", text: "" })).rejects.toThrow();
    expect(readAgentHandoff(A, stateDir)).toMatchObject({ meta: { opId: "op-old" }, text: "旧交接" });
  });
});
