/**
 * setup 收尾的收编闸门 + 收尾调 install-cli 的参数。
 *
 * 收编确认默认 Y，会 SIGTERM 用户外面空闲的会话再在我们的 tmux 里 resume：
 * 只选 Web 时 web 没装上、或网页登录要的「远程登录」没开，就等于关掉用户的会话却无处对话。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { gateSetupAdoption } from "../src/lib/setup-adoption.js";

const base = { deferred: false, failures: [] as string[], laterFailures: [] as string[], discord: false, webInstalled: true };

describe("gateSetupAdoption", () => {
  test("只选 Web、web 装上、登录前置通过 → 收编", () => {
    const g = gateSetupAdoption(base);
    expect(g.verdict).toBe("adopt");
    expect(g.failures).toEqual([]);
    expect(g.skipHint).toBeUndefined();
  });

  test("只选 Web 但 web 服务没装上（构建失败 / 拒绝构建 / 没 node）→ 跳过，提示 web 可用后再收编", () => {
    const g = gateSetupAdoption({ ...base, webInstalled: false });
    expect(g.verdict).toBe("no-frontend");
    expect(g.skipHint?.[0]).toContain("takeover");
    expect(g.skipHint?.[0]).toContain("网页侧栏");
    expect(g.skipHint?.[1]).toContain("takeover");
  });

  test("「远程登录」没开（laterFailures）先并进 failures 再判 → 不收编，失败照样进横幅", () => {
    const sshd = "「远程登录」没开：网页登录会失败";
    const g = gateSetupAdoption({ ...base, laterFailures: [sshd] });
    expect(g.verdict).toBe("failures");
    expect(g.failures).toEqual([sshd]);
    expect(g.skipHint).toBeDefined();
  });

  test("配了 Discord 时 web 没装上也能收编（Discord 就是对话入口）", () => {
    expect(gateSetupAdoption({ ...base, discord: true, webInstalled: false }).verdict).toBe("adopt");
  });

  test("有组件失败 → 不收编；failures 保序合并（收尾的在前，之前各步的在后）", () => {
    const g = gateSetupAdoption({ ...base, discord: true, failures: ["MCP"], laterFailures: ["sshd"] });
    expect(g.verdict).toBe("failures");
    expect(g.failures).toEqual(["MCP", "sshd"]);
  });

  test("deferred（用户选自己跑）→ 不收编也不提示，但 laterFailures 仍带回横幅", () => {
    const g = gateSetupAdoption({ ...base, deferred: true, laterFailures: ["sshd"] });
    expect(g.verdict).toBe("deferred");
    expect(g.skipHint).toBeUndefined();
    expect(g.failures).toEqual(["sshd"]);
  });

  test("不改调用方传进来的数组", () => {
    const failures: string[] = [];
    gateSetupAdoption({ ...base, failures, laterFailures: ["sshd"] });
    expect(failures).toEqual([]);
  });
});

describe("setup 收尾调 install-cli", () => {
  // setup.ts 是入口（import 即跑 main），只能从源码钉：不带 skipWebBuild 时，前台刚失败 / 被拒的
  // web 构建会在「装 claudestra 命令…」那行后面无输出、无超时地再跑一遍
  test("每处 installClaudestraCli 调用都带 skipWebBuild: true", () => {
    const src = readFileSync(new URL("../src/setup.ts", import.meta.url), "utf8");
    const calls = [...src.matchAll(/installClaudestraCli\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toMatch(/skipWebBuild:\s*true/);
  });
});
