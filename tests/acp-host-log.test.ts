import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpLogDir, appendLogLine, LOG_DIR } from "../src/lib/log-paths.js";

// ACP 宿主日志落盘（src/acp-host.ts 的 log → <logs>/acp/<agent>/host.log）
describe("appendLogLine", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "acp-host-log-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  test("目录缺了就建，逐行追加，新建文件 0600", () => {
    const file = join(tmp(), "acp", "worker", "host.log");
    expect(appendLogLine(file, "第一行")).toBe(true);
    expect(appendLogLine(file, "第二行")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("第一行\n第二行\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("写不进去返回 false，不抛", () => {
    const blocker = join(tmp(), "not-a-dir");
    writeFileSync(blocker, "");
    expect(() => appendLogLine(join(blocker, "host.log"), "x")).not.toThrow();
    expect(appendLogLine(join(blocker, "host.log"), "x")).toBe(false);
  });

  // 小上限注入：1000 字节，每写满 1000/64 字节查一次大小
  const MAX = 1000;
  const line = "x".repeat(49); // 带换行 50 字节
  const bound = 2 * (MAX + MAX / 64 + line.length + 1);
  const files = (dir: string) => readdirSync(dir).map((f) => join(dir, f));
  const total = (dir: string) => files(dir).reduce((n, f) => n + statSync(f).size, 0);

  test("长跑越过上限：写入路径上轮转，当前 + 保留文件总量有界、只留一代、全部 0600", () => {
    const dir = join(tmp(), "acp", "worker");
    const file = join(dir, "host.log");
    for (let i = 0; i < 2000; i++) {
      expect(appendLogLine(file, line, MAX)).toBe(true);
      expect(total(dir)).toBeLessThanOrEqual(bound);
    }
    expect(readdirSync(dir).sort()).toEqual(["host.log", "host.log.1"]);
    for (const f of files(dir)) expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  test("反复重启：新进程第一次写就把上次留下的大文件转掉", () => {
    const dir = tmp();
    const file = join(dir, "host.log");
    writeFileSync(file, "y".repeat(MAX * 5), { mode: 0o600 }); // 上次运行留下、本进程没写过的路径
    expect(appendLogLine(file, "重启后第一行", MAX)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("重启后第一行\n");
    expect(statSync(`${file}.1`).size).toBe(MAX * 5);
    for (const f of files(dir)) expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  test("轮转写不进去（.1 是目录）也不抛，照常追加", () => {
    const dir = tmp();
    const file = join(dir, "host.log");
    writeFileSync(file, "y".repeat(MAX * 2), { mode: 0o600 });
    mkdirSync(`${file}.1`);
    expect(() => appendLogLine(file, "a", MAX)).not.toThrow();
    expect(readFileSync(file, "utf8").endsWith("a\n")).toBe(true);
  });

  test("宿主与适配器共用 <logs>/acp/<agent>", () => {
    expect(acpLogDir("worker")).toBe(join(LOG_DIR, "acp", "worker"));
  });
});
