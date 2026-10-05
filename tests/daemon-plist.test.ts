/**
 * daemon plist 模板从 cli-install 抽到 daemon-plist.ts（hardening-PLIST）：
 * 1. 新模板对各种输入与抽出前的模板逐字节相同（基线是 b6da6cfb 的 buildDaemonPlist 原样冻结，只把 homedir()/buildEnvPath()/LOG_DIR 换成参数）；
 * 2. writeDaemonPlists 用假 IO 跑一遍：写下去的就是新模板的结果，不碰真目录 / launchctl / 真环境。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { renderDaemonPlist } from "../src/lib/daemon-plist.js";
import { DAEMONS, type DaemonSpec } from "../src/lib/cli-wrapper.js";
import { writeDaemonPlists, type DaemonPlistWriteIO } from "../src/lib/cli-install.js";

// ── 冻结基线：b6da6cfb src/lib/cli-install.ts 的 buildDaemonPlist，模板文本未改 ──
function baselineDaemonPlist(
  repoRoot: string,
  bunPath: string,
  daemon: DaemonSpec,
  home: string,
  envPath: string,
  LOG_DIR: string,
): string {
  const argv = [bunPath, `${repoRoot}/${daemon.script}`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${daemon.label}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>HOME</key>
    <string>${home}</string>
    <!--
      LANG/LC_ALL 必须注入 UTF-8 locale，否则 daemon 派生的子进程（tmux 尤其）
      跑在 C locale 下会把 CJK 字符渲染成 '_' placeholder。导致 launcher 调
      manager.ts list 时拿到的 tmux window name 跟 registry 里的真实 CJK name
      不 match，永远判定 dead → 死循环 restart → zombie window 累积。
      pm2 时代不出问题是因为 pm2 从 user shell 启动，继承了 LANG。
    -->
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>LC_ALL</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/${daemon.stem}.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/${daemon.stem}.err</string>
</dict>
</plist>
`;
}

const ENVS = [
  { home: "/Users/alice", envPath: "/Users/alice/.bun/bin:/Users/alice/.local/bin:/opt/homebrew/bin:/usr/bin:/bin", logDir: "/Users/alice/.claude-orchestrator/logs" },
  { home: "/Users/有 空格 的家", envPath: "/opt/node dir/bin:/Users/有 空格 的家/.bun/bin", logDir: "/Users/有 空格 的家/日志 目录" },
  { home: "/tmp/h&<>\"'$`\\x", envPath: "/a&b:/c<d>:/e\"f'g:$HOME:`x`", logDir: "/l&<g>/'\"$" },
  { home: "", envPath: "", logDir: "" },
];
const ROOTS = ["/Users/alice/repos/claudestra", "/Users/张三/代码 仓库/claudestra", "/r&<o>/o\"t'$`"];
const BUNS = ["/Users/alice/.bun/bin/bun", "/opt/homebrew/bin/bun", "/路径 有空格/bun&<>"];
const ODD_DAEMONS: DaemonSpec[] = [
  { label: "com.例子.守护 进程", script: "src/中文 脚本.ts", stem: "名 字" },
  { label: "a&b<c>\"'", script: "s&<>.ts", stem: "x&y" },
];

describe("renderDaemonPlist 与抽出前的模板逐字节相同", () => {
  test("各 daemon × 空格 / 中文 / 特殊字符输入", () => {
    let n = 0;
    for (const daemon of [...DAEMONS, ...ODD_DAEMONS])
      for (const env of ENVS)
        for (const repoRoot of ROOTS)
          for (const bunPath of BUNS) {
            const got = renderDaemonPlist({ repoRoot, bunPath, daemon, ...env });
            const want = baselineDaemonPlist(repoRoot, bunPath, daemon, env.home, env.envPath, env.logDir);
            expect(Buffer.from(got, "utf8").equals(Buffer.from(want, "utf8"))).toBe(true);
            n++;
          }
    expect(n).toBe((DAEMONS.length + ODD_DAEMONS.length) * ENVS.length * ROOTS.length * BUNS.length);
  });

  test("DAEMONS 本身没变：label / script / stem 与顺序", () => {
    expect(DAEMONS.map((d) => [d.label, d.script, d.stem])).toEqual([
      ["com.claudestra.bridge", "src/bridge.ts", "bridge"],
      ["com.claudestra.cron", "src/cron.ts", "cron"],
      ["com.claudestra.scheduler", "src/scheduler.ts", "scheduler"],
      ["com.claudestra.launcher", "src/launcher.ts", "launcher"],
    ]);
  });

  test("新模块是纯模板：不碰 homedir / env / 文件 / 子进程", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/lib/daemon-plist.ts"), "utf-8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[0]);
    expect(imports).toEqual([`import type { DaemonSpec } from "./cli-wrapper.js";`]);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(/homedir|process\.env|\bBun\.|spawn|readFile|writeFile|LOG_DIR/.test(code)).toBe(false);
  });
});

describe("writeDaemonPlists 走假 IO：写下去的就是新模板结果", () => {
  test("每个 daemon 取一次环境、写一次，路径与内容对得上", async () => {
    const env = ENVS[1];
    const dir = "/假的/Library/LaunchAgents";
    const calls: string[] = [];
    const writes: { path: string; content: string }[] = [];
    let envCalls = 0;
    const io: DaemonPlistWriteIO = {
      launchAgentsDir: () => { calls.push("dir"); return dir; },
      plistEnv: () => { envCalls++; return env; },
      mkdir: async (d) => { calls.push(`mkdir ${d}`); },
      writeFile: async (path, content) => { calls.push(`write ${path}`); writes.push({ path, content }); },
    };
    const repoRoot = ROOTS[1];
    const bunPath = BUNS[2];
    const out = await writeDaemonPlists(repoRoot, bunPath, io);

    expect(calls).toEqual(["dir", `mkdir ${dir}`, ...DAEMONS.map((d) => `write ${dir}/${d.label}.plist`)]);
    expect(envCalls).toBe(DAEMONS.length);
    expect(out).toEqual(DAEMONS.map((d) => ({ label: d.label, plistPath: `${dir}/${d.label}.plist` })));
    expect(writes.map((w) => w.content)).toEqual(DAEMONS.map((daemon) => renderDaemonPlist({ repoRoot, bunPath, daemon, ...env })));
    expect(writes.map((w) => w.content)).toEqual(DAEMONS.map((d) => baselineDaemonPlist(repoRoot, bunPath, d, env.home, env.envPath, env.logDir)));
  });
});
