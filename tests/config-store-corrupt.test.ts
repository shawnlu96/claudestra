/**
 * config.json 损坏时：读者返回「自动更新全关」的安全默认（以前回落到全开的 DEFAULT_CONFIG，
 * 用户关掉的自动更新会被静默打开），写者拒写并留 .corrupt 备份。
 *
 * config-store 的路径是模块常量，这里借 CLAUDESTRA_STATE_DIR 在子进程里指向临时目录，
 * 顺带验证 override 真的把状态文件挪走了（生产目录不被碰）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const MOD = join(import.meta.dir, "../src/lib/config-store.ts");

function run(stateDir: string, body: string): { status: number | null; out: string; err: string } {
  const script = `import * as c from ${JSON.stringify(MOD)};\n${body}`;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, CLAUDESTRA_STATE_DIR: stateDir },
    encoding: "utf-8",
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe("config-store 坏文件", () => {
  test("不存在 → 默认（自动更新开）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-missing-"));
    const r = run(dir, `console.log(JSON.stringify(c.readConfigSync().autoUpdate));`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ claudestra: true, claudeCode: true });
  });

  test("损坏 → 同步/异步读都返回自动更新全关，并在 stderr 留痕", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-bad-"));
    writeFileSync(join(dir, "config.json"), "{bad");
    const r = run(dir, `
      const a = c.readConfigSync().autoUpdate;
      const b = (await c.readConfig()).autoUpdate;
      console.log(JSON.stringify([a.claudestra, a.claudeCode, b.claudestra, b.claudeCode]));`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual([false, false, false, false]);
    expect(r.err).toContain("config.json");
  });

  test("损坏 → 写者拒写，原文件字节不变，留 .corrupt 备份", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-write-"));
    const p = join(dir, "config.json");
    writeFileSync(p, "{bad");
    const r = run(dir, `
      try { await c.setAutoUpdate("claudeCode", true); console.log("wrote"); }
      catch (e) { console.log("refused:" + e.name); }`);
    expect(r.out).toBe("refused:StateCorruptError");
    expect(readFileSync(p, "utf-8")).toBe("{bad");
    expect(readdirSync(dir).some((f) => f.startsWith("config.json.corrupt-"))).toBe(true);
  });

  test("正常文件照常读写（原子写，不留 tmp）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-ok-"));
    const r = run(dir, `
      await c.setAutoUpdate("claudeCode", false);
      console.log(JSON.stringify(c.readConfigSync().autoUpdate));`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ claudestra: true, claudeCode: false });
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
