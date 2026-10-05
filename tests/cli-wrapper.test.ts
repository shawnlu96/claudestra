import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { cliWrapperScript } from "../src/lib/cli-install";
import { testChildEnv } from "./test-env.ts";

const script = cliWrapperScript("/opt/claudestra");

test("claudestra 包装脚本 bash 语法正确", () => {
  const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test("提供 ls 与普通模式 attach，并说明私有 socket", () => {
  expect(script).toContain("ls|list)");
  expect(script).toContain(`PLAIN_ATTACH=(tmux -S "$SOCK" attach -t master)`);
  expect(script).toContain("普通 tmux ls 看不到是正常的");
});

// 非 iTerm 终端里 -CC 只会吐控制协议文本；ssh 进来时唤起 iTerm 会开在远端桌面上。
// 所以 iTerm 外默认普通 attach，唤起 iTerm 只在显式 --iterm 时发生
test("iTerm 外默认普通 attach，唤起 iTerm 要显式 --iterm", () => {
  const plainGate = script.indexOf(`if [ "$MODE" != iterm ] || [ ! -d /Applications/iTerm.app ]; then`);
  const plainAt = script.indexOf('exec "${PLAIN_ATTACH[@]}"');
  const osaAt = script.indexOf("/usr/bin/osascript");
  expect(plainGate).toBeGreaterThan(0);
  expect(plainAt).toBeGreaterThan(plainGate);
  expect(plainAt).toBeLessThan(osaAt);
  expect(script).toContain("--iterm) MODE=iterm ;;");
});

test("$VAR 后面不能紧跟非 ASCII 字符（bash 会把 UTF-8 字节当成变量名的一部分，set -u 下直接 unbound variable）", () => {
  expect(script).not.toMatch(/\$[A-Za-z_]\w*[^\x00-\x7F]/);
});

test("其余参数交给 manager：help 列出 manager 命令、relay 是 relay-status 的简写、相对路径参数先转绝对再进仓库目录", () => {
  const s = cliWrapperScript("/opt/claudestra", "/opt/bun/bin/bun");
  expect(s).toContain('BUN="/opt/bun/bin/bun"');
  expect(s).toContain("-h|--help|help)");
  expect(s).toContain('relay) shift; cd "$REPO" && exec "$BUN" run src/manager.ts relay-status "$@" ;;');
  expect(s).toContain('cd "$REPO" && exec "$BUN" run src/manager.ts "${ARGS[@]}"');
  expect(s).not.toContain("exit 2");
});

test("相对路径参数转绝对：. 与 ./x 换成调用者目录下的绝对路径，普通参数原样", () => {
  const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "cliw-"));
  require("fs").mkdirSync(require("path").join(dir, "sub"));
  // 把 exec 换成 echo，只看最终交给 manager 的参数
  const probe = cliWrapperScript(require("os").tmpdir(), "echo").replace(/exec "\$BUN" run src\/manager\.ts "\$\{ARGS\[@\]\}"/, 'printf "%s\\n" "${ARGS[@]}"; exit 0');
  const r = spawnSync("bash", ["-s", "--", "create", "demo", ".", "./sub", "purpose text"], { input: probe, encoding: "utf8", cwd: dir });
  const real = require("fs").realpathSync(dir);
  expect(r.stdout.trim().split("\n")).toEqual(["create", "demo", real, `${real}/sub`, "purpose text"]);
});

// 脚本生成抽到 src/lib/cli-wrapper.ts：cli-install 原名 re-export，旧入口和新模块是同一个函数 / 同一份 DAEMONS
test("cli-install 旧入口与 cli-wrapper 新模块等价：同一函数、同一 DAEMONS，路径矩阵输出逐字节一致", async () => {
  const oldMod = await import("../src/lib/cli-install");
  const newMod = await import("../src/lib/cli-wrapper");
  expect(oldMod.cliWrapperScript).toBe(newMod.cliWrapperScript);
  expect(oldMod.DAEMONS).toBe(newMod.DAEMONS);
  const matrix: Array<[string, string | undefined]> = [
    ["/opt/claudestra", undefined],
    ["/Users/a b/my repo", "/Users/a b/.bun/bin/bun"],
    ["/opt/claudestra", "/opt/bun/bin/bun"],
  ];
  for (const [repo, bun] of matrix) {
    const a = bun === undefined ? oldMod.cliWrapperScript(repo) : oldMod.cliWrapperScript(repo, bun);
    const b = bun === undefined ? newMod.cliWrapperScript(repo) : newMod.cliWrapperScript(repo, bun);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a).toContain(`REPO=${JSON.stringify(repo)}\n`);
    expect(a).toContain(`BUN=${JSON.stringify(bun ?? "bun")}\n`);
    expect(a).toContain(`DAEMONS=(${newMod.DAEMONS.map((d) => `"${d.label}"`).join(" ")})\n`);
    expect(spawnSync("bash", ["-n"], { input: a, encoding: "utf8" }).status).toBe(0);
  }
});

// 临时沙箱里真跑 wrapper：HOME/TMPDIR 指向临时目录，BUN 换成打印参数的桩，只走 relay 分支（不碰 launchctl / tmux）
test("wrapper smoke：带空格的仓库路径与 Bun 路径下 relay 分支在仓库目录里调到 BUN", () => {
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "cliw smoke-"));
  const repo = path.join(root, "my repo");
  const bunDir = path.join(root, "bun bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bunDir);
  const bun = path.join(bunDir, "bun");
  fs.writeFileSync(bun, '#!/bin/sh\npwd -P\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
  const env = testChildEnv({ PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root });
  try {
    const r = spawnSync("bash", ["-s", "--", "relay", "--json"], { input: cliWrapperScript(repo, bun), encoding: "utf8", cwd: root, env });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([fs.realpathSync(repo), "run", "src/manager.ts", "relay-status", "--json"]);
    const refused = spawnSync("bash", ["-s", "--", "relay"], { input: cliWrapperScript(repo, bun), encoding: "utf8", cwd: root, env: { ...env, CLAUDESTRA_SANDBOX: "1" } });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("CLAUDESTRA_SANDBOX=1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
