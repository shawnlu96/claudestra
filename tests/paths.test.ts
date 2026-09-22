/**
 * lib/paths.ts：默认值必须与收口前各处手拼的路径逐字相同；override 只在设了时生效，
 * 且只有设了才会进启动前缀（不设 = 启动命令逐字节不变）。
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  STATE_DIR, RUNTIME_DIR, TMUX_SOCK, CONFIG_PATH, LOG_DIR, ARCHIVE_ROOT,
  INBOX_DIR, UPDATE_LOCK, CRON_HISTORY_PATH, stateDirIn, statePath, pathOverrideEnv,
} from "../src/lib/paths";
import { buildClaudeCommand } from "../src/lib/claude-launch";
import { REGISTRY_PATH } from "../src/lib/registry";

const hasOverride = !!(process.env.CLAUDESTRA_STATE_DIR || process.env.CLAUDESTRA_RUNTIME_DIR);

describe("paths 默认值", () => {
  test.skipIf(hasOverride)("与收口前的字面量一致", () => {
    const home = homedir();
    expect(STATE_DIR).toBe(`${home}/.claude-orchestrator`);
    expect(RUNTIME_DIR).toBe("/tmp/claude-orchestrator");
    expect(TMUX_SOCK).toBe("/tmp/claude-orchestrator/master.sock");
    expect(REGISTRY_PATH).toBe(`${home}/.claude-orchestrator/registry.json`);
    expect(CONFIG_PATH).toBe(`${home}/.claude-orchestrator/config.json`);
    expect(LOG_DIR).toBe(`${home}/.claude-orchestrator/logs`);
    expect(ARCHIVE_ROOT).toBe(`${home}/.claude-orchestrator/archive`);
    expect(INBOX_DIR).toBe(`${home}/.claude-orchestrator/inbox`);
    expect(UPDATE_LOCK).toBe(`${home}/.claude-orchestrator/update.lock`);
    expect(CRON_HISTORY_PATH).toBe(`${home}/.claude-orchestrator/cron-history.json`);
    expect(statePath("principals.json")).toBe(`${home}/.claude-orchestrator/principals.json`);
  });

  test("stateDirIn 不看 override", () => {
    expect(stateDirIn("/Users/x")).toBe("/Users/x/.claude-orchestrator");
  });
});

describe("pathOverrideEnv", () => {
  test("没设 → 空；设了才带；空白当没设", () => {
    expect(pathOverrideEnv({})).toEqual({});
    expect(pathOverrideEnv({ CLAUDESTRA_STATE_DIR: "  " })).toEqual({});
    expect(pathOverrideEnv({ CLAUDESTRA_STATE_DIR: "/s", CLAUDESTRA_RUNTIME_DIR: "/r" }))
      .toEqual({ CLAUDESTRA_STATE_DIR: "/s", CLAUDESTRA_RUNTIME_DIR: "/r" });
  });

  test.skipIf(hasOverride)("不设 override 时启动命令里没有它们", () => {
    const cmd = buildClaudeCommand({ channelId: "123", bridgeUrl: "ws://localhost:3847" } as never);
    expect(cmd).not.toContain("CLAUDESTRA_STATE_DIR");
    expect(cmd).not.toContain("CLAUDESTRA_RUNTIME_DIR");
  });
});

describe("override 生效（子进程里验证，模块常量在加载时求值）", () => {
  test("STATE_DIR / RUNTIME_DIR / 派生路径都跟着走", () => {
    const script =
      `import * as p from ${JSON.stringify(join(import.meta.dir, "../src/lib/paths.ts"))};` +
      `console.log(JSON.stringify([p.STATE_DIR, p.RUNTIME_DIR, p.TMUX_SOCK, p.statePath("x.json"), p.LOG_DIR]));`;
    const r = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, CLAUDESTRA_STATE_DIR: "/sbx/state", CLAUDESTRA_RUNTIME_DIR: "/sbx/run" },
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual([
      "/sbx/state", "/sbx/run", "/sbx/run/master.sock", "/sbx/state/x.json", "/sbx/state/logs",
    ]);
  });
});
