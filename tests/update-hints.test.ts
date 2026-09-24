import { describe, expect, test } from "bun:test";
import { isNewerVersion, pickUpdateHint } from "../src/lib/update-hints";
import { parseCcSessionEntry } from "../src/lib/cc-sessions";

describe("isNewerVersion", () => {
  test("逐段数字比较，不是字符串比较", () => {
    expect(isNewerVersion("2.1.281", "2.1.280")).toBe(true);
    expect(isNewerVersion("0.87.1", "0.86.1")).toBe(true);
    expect(isNewerVersion("2.1.100", "2.1.99")).toBe(true);
    expect(isNewerVersion("2.1.280", "2.1.280")).toBe(false);
    expect(isNewerVersion("2.1.279", "2.1.280")).toBe(false);
  });
  test("解析不出来 → false（拿不准就不提示）", () => {
    expect(isNewerVersion(undefined, "1.0.0")).toBe(false);
    expect(isNewerVersion("2.1.281", "garbage")).toBe(false);
  });
});

describe("pickUpdateHint", () => {
  test("Claude Code：磁盘版本比会话启动时新 → 提示重启", () => {
    expect(pickUpdateHint("claude-code", { running: "2.1.280", installed: "2.1.281" }))
      .toEqual({ kind: "restart", running: "2.1.280", installed: "2.1.281" });
    expect(pickUpdateHint("claude-code", { running: "2.1.281", installed: "2.1.281" })).toBeNull();
  });
  test("Claude Code 不看 latest（原生安装器自己会更新）", () => {
    expect(pickUpdateHint("claude-code", { running: "2.1.281", installed: "2.1.281", latest: "9.9.9" })).toBeNull();
  });
  test("Pi：有新版 → 先提示 pi update，哪怕运行版本也落后", () => {
    expect(pickUpdateHint("pi", { running: "0.85.0", installed: "0.86.1", latest: "0.87.1" }))
      .toEqual({ kind: "pi-update", installed: "0.86.1", latest: "0.87.1" });
  });
  test("Pi：已是最新但会话还在旧版 → 提示重启", () => {
    expect(pickUpdateHint("pi", { running: "0.86.1", installed: "0.87.1", latest: "0.87.1" }))
      .toEqual({ kind: "restart", running: "0.86.1", installed: "0.87.1" });
  });
  test("缺数据（快照没版本、离线查不到最新）→ 不提示", () => {
    expect(pickUpdateHint("pi", { installed: "0.86.1" })).toBeNull();
    expect(pickUpdateHint("claude-code", { installed: "2.1.281" })).toBeNull();
  });
});

test("会话登记带出进程启动时的版本", () => {
  const raw = JSON.stringify({ pid: 86415, sessionId: "s1", cwd: "/x", version: "2.1.280" });
  expect(parseCcSessionEntry(raw)?.version).toBe("2.1.280");
});
