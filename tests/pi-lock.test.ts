// Pi 全局模型锁读 config.json（lib/pi-lock.ts）：配置值生效、agent 传入的模型 / 档位被忽略、写坏了拒绝启动而不是放开锁
import { describe, expect, test } from "bun:test";
import { buildPiCommand, PI_LOCKED_EFFORT, PI_LOCKED_MODEL } from "../src/lib/pi-launch.ts";
import { piLock } from "../src/lib/pi-lock.ts";
import { piLaunchOptions } from "../src/lib/runtimes/pi.ts";
import { piAcpArgs } from "../src/lib/runtimes/pi-acp.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";

const SPEC: LaunchSpec = {
  mode: "resume", channelId: "123", bridgeUrl: "ws://localhost:3847", sessionId: "019a-pi", agentName: "agent-pa", purpose: "写代码",
  model: "evil/agent-picked", effort: "low", extras: { piEnv: { base: "minimal" } },
};
const CFG = { piLockedModel: "prov-a/model-b", piLockedEffort: "high" };
const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];

describe("pi-lock：值从 config.json 来", () => {
  test("配置值生效", () => {
    expect(piLock(CFG)).toEqual({ model: "prov-a/model-b", effort: "high" });
  });

  test("没写 / 文件缺失 / 不是对象：用默认锁（仍是锁住的）", () => {
    for (const raw of [{}, undefined, null, "x", { piLockedEffort: "max" }]) {
      expect(piLock(raw).model).toBe(PI_LOCKED_MODEL);
    }
    expect(piLock({ piLockedModel: "prov-a/model-b" }).effort).toBe(PI_LOCKED_EFFORT);
  });

  test("写坏了拒绝启动，报清楚是哪个字段", () => {
    for (const m of ["-x/y", "no-slash", "", 42, "a/b\nc", `p/${"m".repeat(130)}`]) {
      expect(() => piLock({ piLockedModel: m })).toThrow(/piLockedModel 不合法/);
    }
    for (const e of ["turbo", "", 3]) {
      expect(() => piLock({ piLockedEffort: e })).toThrow(/piLockedEffort 不合法/);
    }
  });
});

describe("pi-lock：agent 传入的 --model / effort 被忽略", () => {
  const lock = piLock(CFG);

  test("tmux 路径", () => {
    const o = piLaunchOptions(SPEC, lock);
    expect([o.model, o.effort]).toEqual(["prov-a/model-b", "high"]);
    const cmd = buildPiCommand(o);
    expect(cmd).toContain("--model prov-a/model-b");
    expect(cmd).not.toContain("agent-picked");
  });

  test("ACP 路径（启动参数）", () => {
    const args = piAcpArgs(SPEC, "agent-pa", "/repo", false, "claudestra", lock);
    expect([flag(args, "--model"), flag(args, "--thinking")]).toEqual(["prov-a/model-b", "high"]);
    expect(args.join(" ")).not.toContain("agent-picked");
  });
});
