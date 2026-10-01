import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  test("宿主与适配器共用 <logs>/acp/<agent>", () => {
    expect(acpLogDir("worker")).toBe(join(LOG_DIR, "acp", "worker"));
  });
});
