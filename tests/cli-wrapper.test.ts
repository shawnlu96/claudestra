import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { cliWrapperScript } from "../src/lib/cli-install";

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
