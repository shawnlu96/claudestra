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

// 非 iTerm 终端里 -CC 只会吐控制协议文本；没装 iTerm 时必须直接走普通 attach，不能去唤起 iTerm
test("没装 iTerm 走普通 attach，而且判断在唤起 iTerm 之前", () => {
  const plainAt = script.indexOf('exec "${PLAIN_ATTACH[@]}"');
  const osaAt = script.indexOf("/usr/bin/osascript");
  expect(script).toContain("[ ! -d /Applications/iTerm.app ]");
  expect(plainAt).toBeGreaterThan(0);
  expect(plainAt).toBeLessThan(osaAt);
});
