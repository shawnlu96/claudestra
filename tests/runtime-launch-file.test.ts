/**
 * OCR-2 验收追加 7 第 4 条：ACP 启动文件的目录 / 文件校验（P2-1）与清理（P2-2）。lib/runtimes/acp-launch-file.ts。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_LAUNCH_FILE_ENV, settleLaunchPayloads, sweepStaleLaunchPayloads, takeLaunchPayload, writeLaunchPayload,
} from "../src/lib/runtimes/acp-launch-file.ts";
import { waitReadyAndSettle } from "../src/lib/runtimes/acp-launch-payload.ts";

const root = mkdtempSync(join(tmpdir(), "acp-launch-file-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => join(root, `d${++n}`);
const take = (path: string, dir: string) => takeLaunchPayload({ [ACP_LAUNCH_FILE_ENV]: path }, dir);
const P: [string, string][] = [["CLAUDESTRA_CODEX_PREAMBLE", "x"]];

describe("P2-1 目录与文件校验", () => {
  test("写方建目录 0700；已有的宽权限目录收紧到 0700；读方遇到宽权限目录拒", () => {
    const dir = freshDir();
    writeLaunchPayload(P, { dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    const path = writeLaunchPayload(P, { dir })!;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    expect(take(path, dir)).toMatchObject({ ok: false, error: expect.stringContaining("权限太宽") });
  });

  test("目录是符号链接：写抛、读拒", () => {
    const real = freshDir();
    mkdirSync(real, { mode: 0o700 });
    const link = freshDir();
    symlinkSync(real, link);
    expect(() => writeLaunchPayload(P, { dir: link })).toThrow("符号链接");
    expect(take(join(link, "0123456789abcdef.json"), link)).toMatchObject({ ok: false, error: expect.stringContaining("符号链接") });
  });

  test("文件是符号链接（指向本人的 0600 文件）也拒：O_NOFOLLOW", () => {
    const dir = freshDir();
    const real = writeLaunchPayload(P, { dir })!;
    const link = join(dir, "abcdefabcdefabcd.json");
    symlinkSync(real, link);
    expect(take(link, dir)).toMatchObject({ ok: false, error: expect.stringContaining("读不了") });
    expect(existsSync(real)).toBe(true); // 链接指向的文件没被动
  });

  test("文件权限不是 0600：拒", () => {
    const dir = freshDir();
    const path = writeLaunchPayload(P, { dir })!;
    chmodSync(path, 0o644);
    expect(take(path, dir)).toMatchObject({ ok: false, error: expect.stringContaining("0600") });
  });
});

describe("P2-2 清理", () => {
  test("没就绪（失败 / 超时）：只删这个 agent 的文件，别的 agent 的不碰", async () => {
    const dir = freshDir();
    const mine = writeLaunchPayload(P, { dir, agent: "agent-a" })!;
    const other = writeLaunchPayload(P, { dir, agent: "agent-b" })!;
    await settleLaunchPayloads("agent-a", false);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
    await settleLaunchPayloads("agent-b", false);
  });

  test("就绪且宿主已读走：立即收尾；waitReady 抛错也删文件", async () => {
    const dir = freshDir();
    const read = writeLaunchPayload(P, { dir, agent: "agent-c" })!;
    expect(take(read, dir)).toEqual({ used: true, ok: true });
    const t0 = Date.now();
    await settleLaunchPayloads("agent-c", true);
    expect(Date.now() - t0).toBeLessThan(1_000);
    const thrown = writeLaunchPayload(P, { dir, agent: "agent-d" })!;
    await expect(waitReadyAndSettle({ name: "agent-d" }, async () => { throw new Error("窗口没了"); })).rejects.toThrow("窗口没了");
    expect(existsSync(thrown)).toBe(false);
  });

  test("写它的进程退出（没收尾）：exit 时删掉", () => {
    const dir = freshDir();
    const mod = join(import.meta.dir, "../src/lib/runtimes/acp-launch-file.ts");
    const r = Bun.spawnSync([process.execPath, "-e",
      `const m = await import(${JSON.stringify(mod)}); console.log(m.writeLaunchPayload([["CLAUDESTRA_CODEX_PREAMBLE", "x"]], { dir: ${JSON.stringify(dir)} }));`]);
    const path = r.stdout.toString().trim();
    expect(path).toEndWith(".json");
    expect(existsSync(path)).toBe(false);
  }, 30_000);

  test("兜底清扫：超过 30 分钟且写者已不在才删；写者还活着、或还新的，都留着", () => {
    const dir = freshDir();
    const old = Date.now() / 1000 - 3600;
    const dead = join(dir, "1111111111111111.json");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(dead, JSON.stringify({ v: 1, values: [], env: {}, pid: 2147483646 }), { mode: 0o600 });
    utimesSync(dead, old, old);
    const live = writeLaunchPayload(P, { dir, agent: "agent-e" })!; // 写者 = 本进程，还活着
    utimesSync(live, old, old);
    const young = join(dir, "2222222222222222.json");
    writeFileSync(young, JSON.stringify({ v: 1, values: [], env: {}, pid: 2147483646 }), { mode: 0o600 });
    sweepStaleLaunchPayloads(dir);
    expect([existsSync(dead), existsSync(live), existsSync(young)]).toEqual([false, true, true]);
  });
});
