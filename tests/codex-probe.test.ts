import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Probe } from "../scripts/codex-probe.ts";

/**
 * 假 app-server：回 initialize（userAgent 里带版本号），并起一个**独立进程组**、忽略 SIGTERM 和 EOF 的孙进程
 * （和 Q0-6 里实测的 MCP server 一样不在 app-server 的组里），把它的 pid 写进 cwd。收到 EOF 自己退出，孙进程变孤儿。
 */
const FAKE_APP_SERVER = `
const fs = require("node:fs");
const cp = require("node:child_process");
const g = cp.spawn(process.execPath, ["-e", "for (const s of ['SIGTERM','SIGHUP','SIGINT']) process.on(s, () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync("grandchild.pid", String(g.pid));
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: "fake-probe/9.9.9 (test)" } }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH = 进程已经没了，正是要判断的结果
    return false;
  }
};

const roots: string[] = [];
const strays: number[] = [];
afterEach(() => {
  // 修复前的代码会把孙进程留成孤儿：测试自己收尾，红的时候也不漏进程
  for (const pid of strays.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(): { out: string; bin: string } {
  // probe 拒绝带软链的路径；macOS 的 tmpdir 在 /var → /private/var 软链下面，先取 realpath
  const root = mkdtempSync(join(realpathSync(tmpdir()), "codex-probe-test-"));
  roots.push(root);
  const bin = join(root, "fake-codex");
  writeFileSync(bin, `#!${process.execPath}\n${FAKE_APP_SERVER}`);
  chmodSync(bin, 0o755);
  return { out: root, bin };
}

const quick = () => ({ type: "text" as const, text: "ok" });

describe("codex-probe 收尾", () => {
  test("场景中途抛错：finish 也会清掉不在 app-server 进程组里、忽略 SIGTERM 的子进程，原始错误写进 result.json", async () => {
    const { out, bin } = setup();
    const p = new Probe("boom", out, bin);
    let gpid = 0;
    try {
      await p.start(quick);
      gpid = Number(readFileSync(join(p.work, "grandchild.pid"), "utf8"));
      strays.push(gpid);
      expect(alive(gpid)).toBe(true);
      throw new Error("scenario blew up mid-way");
    } catch (e) {
      await p.finish({ error: String(e) });
    }
    expect(gpid).toBeGreaterThan(0);
    expect(alive(gpid)).toBe(false);
    expect(JSON.parse(readFileSync(join(p.dir, "result.json"), "utf8")).error).toContain("scenario blew up mid-way");
  }, 20_000);

  test("启动前就拒跑（CODEX_HOME 里有 auth.json）：finish 不再抛第二个错，拒跑原因写进 result.json", async () => {
    const { out, bin } = setup();
    const p = new Probe("refused", out, bin);
    writeFileSync(join(p.codexHome, "auth.json"), "{}");
    let first = "";
    try {
      await p.start(quick);
    } catch (e) {
      first = String(e);
    }
    expect(first).toContain("auth.json");
    await p.finish({ error: first });
    expect(existsSync(join(p.dir, "result.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(p.dir, "result.json"), "utf8")).error).toContain("拒绝运行");
    expect(existsSync(join(p.work, "grandchild.pid"))).toBe(false);
  });

  test("版本号取自 app-server 的 initialize 回包（不再单独起一次 codex --version）", async () => {
    const { out, bin } = setup();
    const p = new Probe("version", out, bin);
    try {
      await p.start(quick);
      strays.push(Number(readFileSync(join(p.work, "grandchild.pid"), "utf8")));
      expect(p.serverVersion).toBe("9.9.9");
    } finally {
      await p.finish({});
    }
  }, 20_000);
});
