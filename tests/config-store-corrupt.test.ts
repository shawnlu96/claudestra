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

  // 审查 major：看板是唯一的自动周期写者。坏文件时每轮「建频道 → 存 id 被拒」，
  // 以前会每个 Stop hook 建一个 Discord 频道、落一份 .corrupt 备份
  test("损坏 → 反复被拒写只留 1 份备份；看板不建频道", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-dash-"));
    const p = join(dir, "config.json");
    writeFileSync(p, "{bad");
    const DASH = join(import.meta.dir, "../src/bridge/stats-dashboard.ts");
    const r = run(dir, `
      const { ensureChannel } = await import(${JSON.stringify(DASH)});
      let refused = 0, created = 0;
      for (let i = 0; i < 3; i++) {
        try { await c.setStatsDashboard("123", "456"); } catch (e) { if (e.name === "StateCorruptError") refused++; }
      }
      const fake = { channels: { fetch: async () => null } };
      for (let i = 0; i < 3; i++) {
        const id = await ensureChannel(fake, async () => { created++; return "999"; });
        if (id !== null) throw new Error("ensureChannel 不该返回频道: " + id);
      }
      console.log(JSON.stringify({ refused, created, corrupt: c.isConfigCorrupt() }));`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ refused: 3, created: 0, corrupt: true });
    expect(readdirSync(dir).filter((f) => f.startsWith("config.json.corrupt-")).length).toBe(1);
    expect(readFileSync(p, "utf-8")).toBe("{bad");
    // 暂停提示只打一次
    expect(r.err.split("用量看板暂停").length - 1).toBe(1);
  });

  test("内容变了（又坏成另一个样子）才另落一份备份", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-bak2-"));
    const p = join(dir, "config.json");
    writeFileSync(p, "{bad");
    run(dir, `await c.setLang("en").catch(() => {});`);
    writeFileSync(p, "{worse");
    run(dir, `await c.setLang("en").catch(() => {});`);
    run(dir, `await c.setLang("en").catch(() => {});`);
    expect(readdirSync(dir).filter((f) => f.startsWith("config.json.corrupt-")).length).toBe(2);
  });

  test("不存在 / 正常 → isConfigCorrupt 为 false", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-flag-"));
    expect(run(dir, `console.log(c.isConfigCorrupt());`).out).toBe("false");
    writeFileSync(join(dir, "config.json"), "{}");
    expect(run(dir, `console.log(c.isConfigCorrupt());`).out).toBe("false");
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
