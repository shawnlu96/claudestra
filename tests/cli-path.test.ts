/** claudestra 启动器在不在用户终端的 PATH 里（src/lib/cli-path.ts）：不起真 shell，runner / finds 都注入 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PATH_LINE, cliPathNotes, ensureCliOnPath, loginProfileFor, loginShellFinds } from "../src/lib/cli-path.js";

const home = () => mkdtempSync(join(tmpdir(), "cli-path-"));

describe("loginProfileFor", () => {
  test("zsh → .zprofile，bash → .bash_profile，别的 shell 不替用户改", () => {
    expect(loginProfileFor("/bin/zsh", "/h")).toBe("/h/.zprofile");
    expect(loginProfileFor("/opt/homebrew/bin/bash", "/h")).toBe("/h/.bash_profile");
    expect(loginProfileFor("/usr/local/bin/fish", "/h")).toBeNull();
  });
});

describe("loginShellFinds", () => {
  test("空环境起登录交互 shell：退出 0 且有输出 = 找得到；非 0 = 找不到；超时 = 判不了", () => {
    const calls: string[][] = [];
    const run = (status: number | null, stdout = "") => (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { status, stdout });
    expect(loginShellFinds("claudestra", "/bin/zsh", "/h", run(0, "/h/.local/bin/claudestra\n"))).toBe(true);
    expect(calls[0]).toEqual(expect.arrayContaining(["/usr/bin/env", "-i", "HOME=/h", "/bin/zsh", "-l", "-i", "-c", "command -v claudestra"]));
    expect(loginShellFinds("claudestra", "/bin/zsh", "/h", run(1))).toBe(false);
    expect(loginShellFinds("claudestra", "/bin/zsh", "/h", run(0, ""))).toBe(false);
    expect(loginShellFinds("claudestra", "/bin/zsh", "/h", run(null))).toBeNull();
  });
});

describe("ensureCliOnPath", () => {
  test("找得到 / 判不了：不碰任何文件", () => {
    const h = home();
    expect(ensureCliOnPath({ home: h, shell: "/bin/zsh", finds: () => true })).toEqual({ status: "ok" });
    expect(ensureCliOnPath({ home: h, shell: "/bin/zsh", finds: () => null })).toEqual({ status: "ok" });
    expect(existsSync(join(h, ".zprofile"))).toBe(false);
  });
  test("找不到：先备份原 profile，再追加带守卫的一行；追加后找得到 → added；重跑不重复追加", () => {
    const h = home();
    writeFileSync(join(h, ".zprofile"), 'eval "$(/opt/homebrew/bin/brew shellenv zsh)"');
    let found = false;
    const finds = () => found;
    const first = ensureCliOnPath({ home: h, shell: "/bin/zsh", finds: () => { const r = finds(); found = true; return r; } });
    expect(first).toEqual({ status: "added", profile: join(h, ".zprofile") });
    const text = readFileSync(join(h, ".zprofile"), "utf8");
    expect(text.startsWith('eval "$(/opt/homebrew/bin/brew shellenv zsh)"\n')).toBe(true);
    expect(text.split(CLI_PATH_LINE)).toHaveLength(2);
    expect(readFileSync(join(h, ".zprofile.bak-claudestra"), "utf8")).toBe('eval "$(/opt/homebrew/bin/brew shellenv zsh)"');
    // 已有这一行却仍找不到：不再追加，给排查提示
    const again = ensureCliOnPath({ home: h, shell: "/bin/zsh", finds: () => false });
    expect(again.status).toBe("hint");
    expect(readFileSync(join(h, ".zprofile"), "utf8").split(CLI_PATH_LINE)).toHaveLength(2);
  });
  test("没有 profile 文件就新建（不留空备份）；fish 之类只给提示", () => {
    const h = home();
    expect(ensureCliOnPath({ home: h, shell: "/bin/bash", finds: () => false }).status).toBe("hint"); // 追加后仍找不到 → 手动提示
    expect(readFileSync(join(h, ".bash_profile"), "utf8")).toContain(CLI_PATH_LINE);
    expect(existsSync(join(h, ".bash_profile.bak-claudestra"))).toBe(false);
    expect(ensureCliOnPath({ home: h, shell: "/usr/bin/fish", finds: () => false }).status).toBe("hint");
  });
});

describe("cliPathNotes（install-cli 的提示）", () => {
  test("ok 不出声；added 说在哪；hint 带办法；抛错也只是提示", () => {
    expect(cliPathNotes(() => ({ status: "ok" }))).toEqual([]);
    expect(cliPathNotes(() => ({ status: "added", profile: "/h/.zprofile" }))[0]).toContain("/h/.zprofile");
    expect(cliPathNotes(() => ({ status: "hint", hint: "do X" }))).toEqual(["claudestra 命令：do X"]);
    expect(cliPathNotes(() => { throw new Error("boom"); })[0]).toContain("boom");
  });
});
