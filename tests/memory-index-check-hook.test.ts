/**
 * 记忆索引体积检查走真实入口:src/hooks/recall-hook.ts 当子进程跑,HOME 和状态目录都指到临时目录,
 * MEMORY.md 全是合成内容。「旧 hook 的输出」用两种方式钉住:没有 HANDOFF 时是空串,有 HANDOFF 时等于
 * 同一份夹具去掉 MEMORY.md 后的输出(没有索引文件时检查什么都不做)。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffPath, memoryDir, projectSlug } from "../src/lib/session-recall.js";

const root = mkdtempSync(join(tmpdir(), "memory-index-hook-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const HOOK = join(import.meta.dir, "..", "src", "hooks", "recall-hook.ts");
const OVER_8193 = `${"a".repeat(5000)}\n${"b".repeat(3191)}\n`;
const NOTICE_8193 = "⚠ 记忆索引 MEMORY.md 共 8193 字节,超过 8192 字节阈值 1 字节;最长行:第 1 行(5000 字节)、第 2 行(3191 字节)。"
  + "只是提示,不会自动改动;要精简请先让用户确认。\n";
const BYTES_101 = `${"x".repeat(60)}\n${"y".repeat(39)}\n`;

interface Box { home: string; state: string; cwd: string; index: string; record: string }
let seq = 0;
/** 每个用例一套独立的假 HOME / 状态目录;config 给了就写成机器级开关文件(字符串原样写,用来造坏配置) */
function box(config?: unknown, memory?: string | Uint8Array): Box {
  const dir = join(root, `case-${seq++}`);
  const home = join(dir, "home"), state = join(dir, "state"), cwd = join(dir, "proj");
  mkdirSync(memoryDir(cwd, home), { recursive: true });
  mkdirSync(state, { recursive: true });
  if (config !== undefined) writeFileSync(join(state, "memory-index-mode.json"), typeof config === "string" ? config : JSON.stringify(config));
  const index = join(memoryDir(cwd, home), "MEMORY.md");
  if (memory !== undefined) writeFileSync(index, memory);
  return { home, state, cwd, index, record: join(state, "memory-index-check", `${projectSlug(cwd)}.json`) };
}

function spawnHook(b: Box, input: Record<string, unknown>, env: Record<string, string> = {}) {
  return Bun.spawn(["bun", HOOK], {
    stdin: new Blob([JSON.stringify({ cwd: b.cwd, source: "startup", ...input })]),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, HOME: b.home, CLAUDESTRA_STATE_DIR: b.state, MEM0_RECALL_SCRIPT: join(b.home, "no-such-recall.py"), ...env },
  });
}

async function run(b: Box, input: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<string> {
  const p = spawnHook(b, input, env);
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  return out;
}

/** 目录下每个文件的「大小:mtime:内容」——用户文件一个字节、一个 mtime 都不许动 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const st = statSync(join(dir, name));
    out[name] = st.isFile() ? `${st.size}:${st.mtimeMs}:${readFileSync(join(dir, name)).toString("base64")}` : "dir";
  }
  return out;
}
const readRecord = (b: Box) => JSON.parse(readFileSync(b.record, "utf-8"));

describe("recall-hook 记忆索引检查", () => {
  test("[验收线 1] 正好 8192 字节 on 无提示;8193 字节恰一行提示", async () => {
    const at = box({ mode: "on" }, OVER_8193.slice(0, 5000) + OVER_8193.slice(5001));
    expect(statSync(at.index).size).toBe(8192);
    expect(await run(at)).toBe("");

    const over = box({ mode: "on" }, OVER_8193);
    expect(await run(over)).toBe(NOTICE_8193);
    for (const b of [at, over]) expect(existsSync(b.record)).toBe(false); // on 只提示,不落记录

    const seen = box({ mode: "observe" }, OVER_8193);
    expect(await run(seen)).toBe("");
    expect(readRecord(seen)).toMatchObject({ mode: "observe", totalBytes: 8193, maxBytes: 8192, overBytes: 1, longest: [{ line: 1, bytes: 5000 }, { line: 2, bytes: 3191 }] });
  });

  test("[验收线 2] 提示和记录只有数字和行号,不带索引正文", async () => {
    const text = "# 索引\r\n\r\n- 甲乙丙丁\n- abcdefghijkl\n\n- 最长的一行在这里 xyz";
    const b = box({ mode: "observe", maxBytes: 50 }, text);
    expect(await run(b)).toBe("");
    expect(readRecord(b)).toMatchObject({ totalBytes: 73, overBytes: 23, longest: [{ line: 6, bytes: 30 }, { line: 3, bytes: 14 }, { line: 4, bytes: 14 }] });
    const out = await run(box({ mode: "on", maxBytes: 50 }, text));
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(out).toContain("共 73 字节,超过 50 字节阈值 23 字节;最长行:第 6 行(30 字节)、第 3 行(14 字节)、第 4 行(14 字节)");
    for (const body of ["甲乙丙丁", "abcdefghijkl", "最长的一行", "xyz"]) {
      expect(out).not.toContain(body);
      expect(readFileSync(b.record, "utf-8")).not.toContain(body);
    }
  });

  test("[验收线 3] 阈值 100:on 提示超 1、不留记录;observe 只落记录;off 什么都不留", async () => {
    const on = box({ mode: "on", maxBytes: 100 }, BYTES_101);
    const onBefore = snapshot(join(on.home, ".."));
    expect(await run(on)).toContain("共 101 字节,超过 100 字节阈值 1 字节;最长行:第 1 行(60 字节)、第 2 行(39 字节)");
    expect(snapshot(join(on.home, ".."))).toEqual(onBefore);

    // 开关文件不存在 = observe + 缺省阈值;写了阈值的 observe 记录用配置的阈值
    for (const [config, maxBytes, overBytes] of [[{ mode: "observe", maxBytes: 100 }, 100, 1], [{ maxBytes: 100 }, 100, 1], [undefined, 8192, 0]] as const) {
      const b = box(config, BYTES_101);
      const before = snapshot(b.state);
      expect(await run(b)).toBe("");
      expect(readRecord(b)).toMatchObject({ mode: "observe", cwd: b.cwd, source: "startup", totalBytes: 101, maxBytes, overBytes });
      const { "memory-index-check": _dir, [join("memory-index-check", `${projectSlug(b.cwd)}.json`)]: _rec, ...rest } = snapshot(b.state);
      expect(rest).toEqual(before);
    }

    const off = box({ mode: "off", maxBytes: 100 }, BYTES_101);
    const before = snapshot(join(off.home, ".."));
    expect(await run(off)).toBe("");
    expect(snapshot(join(off.home, ".."))).toEqual(before);
  });

  test("[验收线 3] 非法阈值 / 坏配置按 off:不提示、不落记录", async () => {
    const bad = ["{not json", "[]", "null", '"on"', { mode: "loud" }, { mode: "on", maxBytes: 0 }, { mode: "on", maxBytes: -5 },
      { mode: "on", maxBytes: 1.5 }, { mode: "on", maxBytes: "100" }, { mode: 1, maxBytes: 100 }];
    await Promise.all(bad.map(async (config) => {
      const b = box(config, BYTES_101 + OVER_8193);
      const before = snapshot(join(b.home, ".."));
      expect(await run(b)).toBe("");
      expect(snapshot(join(b.home, ".."))).toEqual(before);
    }));
  });

  test("[验收线 3] 有 HANDOFF 时 observe / off 的 stdout 与没有索引文件时逐字相同,on 只在末尾多一行", async () => {
    const outs: Record<string, string> = {};
    for (const [name, config, memory] of [["legacy", { mode: "on", maxBytes: 100 }, undefined], ["off", { mode: "off", maxBytes: 100 }, BYTES_101],
      ["observe", { mode: "observe", maxBytes: 100 }, BYTES_101], ["on", { mode: "on", maxBytes: 100 }, BYTES_101]] as const) {
      const b = box(config, memory);
      writeFileSync(handoffPath(b.cwd, b.home), "# HANDOFF\n在做什么:修值守");
      outs[name] = (await run(b)).replaceAll(b.cwd, "<cwd>");
    }
    expect(outs.legacy).toStartWith("## HANDOFF · 上次会话交接");
    expect(outs.legacy).toEndWith("在做什么:修值守\n");
    expect(outs.off).toBe(outs.legacy);
    expect(outs.observe).toBe(outs.legacy);
    expect(outs.on.startsWith(outs.legacy)).toBe(true);
    expect(outs.on.slice(outs.legacy.length)).toMatch(/^⚠ 记忆索引 MEMORY\.md 共 101 字节,[^\n]*\n$/);
  });

  test("[验收线 4] 缺文件、目录冒充文件、拒绝读取、subagent 都不报且 exit 0", async () => {
    const missing = box({ mode: "on", maxBytes: 100 });
    expect(await run(missing)).toBe("");
    expect(existsSync(missing.record)).toBe(false);

    const dir = box({ mode: "on", maxBytes: 1 });
    mkdirSync(join(dir.index, "sub"), { recursive: true });
    writeFileSync(join(dir.index, "sub", "big.md"), BYTES_101);
    expect(await run(dir)).toBe("");
    expect(existsSync(dir.record)).toBe(false);

    const denied = box({ mode: "on", maxBytes: 100 }, BYTES_101);
    chmodSync(denied.index, 0o000);
    try {
      // root 不受权限位约束,读得出来就不是「拒绝读取」了,这一段只在普通用户下有意义
      if (process.getuid?.() !== 0) {
        expect(await run(denied)).toBe("");
        expect(existsSync(denied.record)).toBe(false);
      }
    } finally {
      chmodSync(denied.index, 0o644);
    }

    const sub = box({ mode: "on", maxBytes: 100 }, BYTES_101);
    expect(await run(sub, { agent_id: "sub-1" })).toBe("");
    expect(existsSync(sub.record)).toBe(false);
  });

  test("[验收线 4] compact 不注入 HANDOFF 但照样检查;clear / resume 也检查;提示排在 recall 之后", async () => {
    const b = box({ mode: "on", maxBytes: 100 }, BYTES_101);
    writeFileSync(handoffPath(b.cwd, b.home), "# HANDOFF\n在做什么:修值守");
    const compact = await run(b, { source: "compact" });
    expect(compact).not.toContain("HANDOFF");
    expect(compact).toMatch(/^⚠ 记忆索引 MEMORY\.md 共 101 字节,[^\n]*\n$/);
    for (const source of ["clear", "resume"]) expect(await run(b, { source })).toEndWith(compact);
    expect(existsSync(b.record)).toBe(false);

    const seen = box({ mode: "observe", maxBytes: 100 }, BYTES_101);
    for (const source of ["compact", "clear", "resume"]) {
      expect(await run(seen, { source })).toBe("");
      expect(readRecord(seen).source).toBe(source);
    }

    const script = join(b.home, "recall.sh");
    writeFileSync(script, "echo '## mem0 recall'\necho '- 合成记忆'\n");
    const out = await run(b, { source: "startup" }, { MEM0_RECALL_PYTHON: "/bin/sh", MEM0_RECALL_SCRIPT: script });
    expect(out).toContain("## HANDOFF");
    expect(out).toEndWith(`## mem0 recall\n- 合成记忆\n${compact}`);
  });

  test("[验收线 4] recall 卡到超时:observe 的记录早已落盘,on 照常 exit 0 并带上提示", async () => {
    const stuck = (b: Box) => {
      const script = join(b.home, "recall.sh");
      writeFileSync(script, "exec sleep 60\n");
      return spawnHook(b, {}, { MEM0_RECALL_PYTHON: "/bin/sh", MEM0_RECALL_SCRIPT: script });
    };
    const started = Date.now();
    const seen = box({ mode: "observe", maxBytes: 100 }, BYTES_101);
    const on = box({ mode: "on", maxBytes: 100 }, BYTES_101);
    const p = stuck(seen), q = stuck(on);
    let exited = false;
    void p.exited.then(() => { exited = true; });
    while (!existsSync(seen.record) && !exited && Date.now() - started < 8_000) await Bun.sleep(50);
    expect(existsSync(seen.record)).toBe(true);
    expect(exited).toBe(false); // recall 还卡着,记录已经在盘上了
    const [quiet, out] = await Promise.all([new Response(p.stdout).text(), new Response(q.stdout).text()]);
    expect(await p.exited).toBe(0);
    expect(await q.exited).toBe(0);
    expect(quiet).toBe("");
    expect(out).toMatch(/^⚠ 记忆索引 MEMORY\.md 共 101 字节,[^\n]*\n$/);
    expect(existsSync(on.record)).toBe(false);
    expect(Date.now() - started).toBeLessThan(14_000); // 既有超时链:10s SIGTERM + 1s SIGKILL,检查没有再往上加
  }, 20_000);

  test("[验收线 3] 开关文件不是普通文件(无写者 FIFO / 目录 / 悬空软链)按 off:不卡住,HANDOFF 和 recall 照常", async () => {
    const plant: Array<(path: string) => void> = [
      (path) => { expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0); },
      (path) => mkdirSync(path),
      (path) => symlinkSync(join(path, "..", "no-such-config.json"), path),
    ];
    await Promise.all(plant.map(async (make) => {
      const b = box(undefined, BYTES_101 + OVER_8193);
      make(join(b.state, "memory-index-mode.json"));
      writeFileSync(handoffPath(b.cwd, b.home), "# HANDOFF\n在做什么:修值守");
      const script = join(b.home, "recall.sh");
      writeFileSync(script, "echo synthetic-recall\n");
      const started = Date.now();
      const p = spawnHook(b, {}, { MEM0_RECALL_PYTHON: "/bin/sh", MEM0_RECALL_SCRIPT: script });
      const killer = setTimeout(() => p.kill("SIGKILL"), 8_000); // 回归时别让卡死的 hook 把整个测试拖到超时
      const out = await new Response(p.stdout).text();
      const code = await p.exited;
      clearTimeout(killer);
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(out).toStartWith("## HANDOFF · 上次会话交接");
      expect(out).toEndWith("在做什么:修值守\n\nsynthetic-recall\n");
      expect(existsSync(b.record)).toBe(false);
    }));
  }, 20_000);

  test("[验收线 5] on / observe 前后用户记忆目录的字节和 mtime 都不变;observe 只新增状态目录里那份记录,on 什么都不新增", async () => {
    for (const mode of ["on", "observe"] as const) {
      const b = box({ mode, maxBytes: 100 }, BYTES_101);
      writeFileSync(handoffPath(b.cwd, b.home), "# HANDOFF\n在做什么:修值守");
      writeFileSync(join(memoryDir(b.cwd, b.home), "feedback_x.md"), "合成的记忆正文\n");
      const home = snapshot(b.home), state = snapshot(b.state);
      for (const source of ["startup", "resume", "clear", "compact"]) await run(b, { source });
      expect(snapshot(b.home)).toEqual(home);
      const after = snapshot(b.state);
      const added = mode === "observe" ? ["memory-index-check", join("memory-index-check", `${projectSlug(b.cwd)}.json`)] : [];
      expect(Object.keys(after).filter((k) => !(k in state)).sort()).toEqual(added);
      for (const k of Object.keys(state)) expect(after[k]).toBe(state[k]);
    }
  });

  test("[验收线 5] 记录位置被放了指向用户记忆的软链:observe 不顺着它写,记忆的字节和 mtime 不变", async () => {
    // 记录文件本身是指向 MEMORY.md 的软链:换掉的是链接,不是它指向的文件
    const file = box({ mode: "observe", maxBytes: 100 }, BYTES_101);
    mkdirSync(join(file.state, "memory-index-check"));
    symlinkSync(file.index, file.record);
    const home = snapshot(file.home);
    expect(await run(file)).toBe("");
    expect(snapshot(file.home)).toEqual(home);
    expect(readFileSync(file.index, "utf-8")).toBe(BYTES_101);
    expect(lstatSync(file.record).isFile()).toBe(true);
    expect(readRecord(file)).toMatchObject({ mode: "observe", totalBytes: 101, overBytes: 1 });

    // 记录目录是指向记忆目录的软链:这次不写,记忆目录里不多出任何文件
    const dir = box({ mode: "observe", maxBytes: 100 }, BYTES_101);
    symlinkSync(memoryDir(dir.cwd, dir.home), join(dir.state, "memory-index-check"));
    const before = snapshot(dir.home);
    expect(await run(dir)).toBe("");
    expect(snapshot(dir.home)).toEqual(before);
    expect(lstatSync(join(dir.state, "memory-index-check")).isSymbolicLink()).toBe(true);
  });
});
