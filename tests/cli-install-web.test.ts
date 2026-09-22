/**
 * web 前端 daemon 的两个判据（v2.24+，owner 2026-09-22：「有 Claude Code 的人，
 * 一个安装命令下来，就可以用我这个 Web 端」）。
 *
 * 在此之前 install-cli 只装 bridge/cron/launcher 三个 daemon，web 要用户自己
 * `cd web && npm run dev` 前台跑着——关掉终端就没了、重启机器也不回来。
 */
import { describe, test, expect } from "bun:test";
import {
  isGeneratedPlist,
  WEB_PORT_FALLBACK,
  webDaemonReadiness,
  webDaemonSpec,
  webPortFromStartScript,
} from "../src/lib/cli-install.js";

describe("webPortFromStartScript", () => {
  test("从 next start 抠端口——package.json 是端口的唯一真源", () => {
    expect(webPortFromStartScript("next start -p 3333")).toBe(3333);
    expect(webPortFromStartScript("next start --port 8080")).toBe(8080);
    expect(webPortFromStartScript("next start --port=8080")).toBe(8080);
  });

  test("没写端口 / 没有 start 脚本 → 用兜底值（不能拿 NaN 去拼 plist）", () => {
    expect(webPortFromStartScript("next start")).toBe(WEB_PORT_FALLBACK);
    expect(webPortFromStartScript(undefined)).toBe(WEB_PORT_FALLBACK);
    expect(webPortFromStartScript("")).toBe(WEB_PORT_FALLBACK);
  });

  test("越界端口不采信", () => {
    expect(webPortFromStartScript("next start -p 99999")).toBe(WEB_PORT_FALLBACK);
    expect(webPortFromStartScript("next start -p 0")).toBe(WEB_PORT_FALLBACK);
  });
});

describe("webDaemonReadiness", () => {
  const all = { pkg: true, nextBin: true, build: true, envLocal: true };

  test("四个条件齐了才装", () => {
    expect(webDaemonReadiness(all).ready).toBe(true);
  });

  // 下面三格对应 next start 三种「报错很难懂」的失败：装了 daemon 只会得到一个
  // KeepAlive 无限重启的坏服务，不如不装并说清缺什么。
  test("没装依赖 → 不装，且说得出是缺依赖", () => {
    const v = webDaemonReadiness({ ...all, nextBin: false });
    expect(v.ready).toBe(false);
    expect(v.reason).toContain("npm install");
  });

  test("没 build → 不装（next start 会直接退出）", () => {
    const v = webDaemonReadiness({ ...all, build: false });
    expect(v.ready).toBe(false);
    expect(v.reason).toContain("npm run build");
  });

  test("没 .env.local → 不装（页面起来了也连不上 bridge）", () => {
    const v = webDaemonReadiness({ ...all, envLocal: false });
    expect(v.ready).toBe(false);
    expect(v.reason).toContain("setup");
  });

  test("上游精简版没有 web/ → 不装，理由要说清是压根没有前端", () => {
    const v = webDaemonReadiness({ pkg: false, nextBin: false, build: false, envLocal: false });
    expect(v.ready).toBe(false);
    expect(v.reason).toContain("没有 web/");
  });
});

describe("webDaemonSpec", () => {
  const spec = webDaemonSpec("/repo", 3333, "/opt/homebrew/bin/node");

  // ⚠ 这条是「装完网页打不开」的正主：`node_modules/.bin/next` 是
  // `#!/usr/bin/env node` 的 shim，解析 node 靠 plist 里那份固定 PATH，而 nvm /
  // fnm / volta 装的 node 根本不在那份列表里 ⇒ launchd 起不来、端口不监听、
  // KeepAlive 还会安静地重试下去。拿到绝对路径就直接 exec node。
  test("拿得到 node 绝对路径时直接 exec node，不依赖 shebang", () => {
    expect(spec.exec?.cwd).toBe("/repo/web");
    expect(spec.exec?.argv).toEqual([
      "/opt/homebrew/bin/node", "/repo/web/node_modules/next/dist/bin/next", "start", "-p", "3333",
    ]);
  });

  test("找不到 node 才退回 .bin/next 的 shim（总比不装强）", () => {
    const s2 = webDaemonSpec("/repo", 3333, null);
    expect(s2.exec?.argv).toEqual(["/repo/web/node_modules/.bin/next", "start", "-p", "3333"]);
  });

  test("端口跟着参数走（不是写死 3333）", () => {
    expect(webDaemonSpec("/repo", 8080, "/usr/bin/node").exec?.argv.slice(-1)).toEqual(["8080"]);
  });

  test("keepExisting——用户手写过的 plist 不许覆盖", () => {
    // install-cli 每次 update 都会跑；无条件覆盖等于每次升级悄悄抹掉用户对端口 /
    // 日志落点 / 反代的定制。
    expect(spec.keepExisting).toBe(true);
  });

  test("日志跟另外三个 daemon 同一个 stem 规则（不落 /tmp，那儿会被系统清理）", () => {
    expect(spec.stem).toBe("web");
  });
});

/**
 * 2026-09-22 试装实录：用户先用带 shebang bug 的版本跑过一次 install-cli，生成了
 * 一份起不来的 web plist（launchctl 报 `- 127` = 命令找不到）；之后拉了修复版再跑，
 * keepExisting 原样保留那份坏文件 —— **修复根本没机会生效**。
 * 「不覆盖用户手写的」和「永远不更新自己生成的」是两件事。
 */
describe("isGeneratedPlist", () => {
  const generated = `<plist version="1.0"><dict>
  <key>Label</key><string>com.claudestra.web</string>
  <key>ClaudestraGenerated</key><true/>
</dict></plist>`;
  const handWritten = `<plist version="1.0"><dict>
  <key>Label</key><string>com.claudestra.web</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string></array>
</dict></plist>`;

  test("我们生成的认得出来 → 可以被新版替换", () => {
    expect(isGeneratedPlist(generated)).toBe(true);
  });

  test("用户手写的没有标记 → 永不覆盖", () => {
    expect(isGeneratedPlist(handWritten)).toBe(false);
  });

  test("空内容 / 读不出来当成用户的（保守方向：宁可不覆盖）", () => {
    expect(isGeneratedPlist("")).toBe(false);
  });
});
