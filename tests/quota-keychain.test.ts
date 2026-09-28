/**
 * Keychain 子进程（lib/quota-keychain.ts）：超时 / 输出超限 SIGKILL 并回收、spawn 抛错不冒泡、最小环境、argv 不含秘密。
 * 只跑 sleep / printf / yes / env，不碰 security。
 */

import { describe, expect, test } from "bun:test";
import { classifyKeychain, minimalEnv, readStreamCapped, runWithTimeout, spawnKeychainReader, type SpawnFn } from "../src/lib/quota-keychain.js";
import { keychainBlob } from "./quota-fixtures.js";

const tracking = () => {
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const spawn: SpawnFn = (argv) => {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.push(p);
    return p as never;
  };
  return { procs, spawn };
};

describe("子进程回收", () => {
  test("超时：SIGKILL 并等到进程真正退出", async () => {
    const t = tracking();
    const started = Date.now();
    const r = await runWithTimeout(["sleep", "30"], 150, t.spawn);
    expect(r).toEqual({ code: null, stdout: "", stderr: "", timedOut: true });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.procs[0].killed).toBe(true);
    expect(t.procs[0].exitCode !== null || t.procs[0].signalCode !== null).toBe(true);
  });

  test("输出超过 64 KiB：边读边计数，超限立刻杀掉（不读完）", async () => {
    const t = tracking();
    const r = await runWithTimeout(["yes"], 5000, t.spawn);
    expect(r).toEqual({ code: null, stdout: "", stderr: "", timedOut: false });
    expect(t.procs[0].killed).toBe(true);
    expect(t.procs[0].signalCode !== null || t.procs[0].exitCode !== null).toBe(true);
  });

  test("spawn 同步抛错（ENOENT / EMFILE）→ 不冒泡，判成 error", async () => {
    const boom: SpawnFn = () => {
      throw Object.assign(new Error("spawn EMFILE /secret/path"), { code: "EMFILE" });
    };
    const r = await runWithTimeout(["x"], 1000, boom);
    expect(r).toEqual({ code: null, stdout: "", stderr: "", timedOut: false });
    expect(await spawnKeychainReader({ spawn: boom })("svc")).toEqual({ status: "error" });
  });

  test("读管道出错：照样 SIGKILL，并等进程退出后才返回", async () => {
    const events: string[] = [];
    let exit!: (n: number) => void;
    const exited = new Promise<number>((r) => (exit = r));
    const broken: SpawnFn = () => ({
      stdout: new ReadableStream({ pull: (c) => c.error(new Error("EPIPE secret")) }),
      stderr: new ReadableStream({ start: () => {} }),
      exited: exited.then((n) => (events.push("exited"), n)),
      kill: (sig) => {
        events.push(`kill:${sig}`);
        setTimeout(() => exit(137), 10);
      },
    });
    const r = await runWithTimeout(["x"], 5000, broken);
    expect(r).toEqual({ code: null, stdout: "", stderr: "", timedOut: false });
    expect(events).toEqual(["kill:SIGKILL", "exited"]);
  });

  test("正常收 stdout 与退出码", async () => {
    expect(await runWithTimeout(["printf", "hello"], 5000)).toEqual({ code: 0, stdout: "hello", stderr: "", timedOut: false });
  });

  test("readStreamCapped：上限内原样返回，超限返回 null 并回调", async () => {
    expect(await readStreamCapped(new Response("abc").body, 3)).toBe("abc");
    let hit = false;
    expect(await readStreamCapped(new Response("abcd").body, 3, () => (hit = true))).toBeNull();
    expect(hit).toBe(true);
    expect(await readStreamCapped(null, 3)).toBe("");
  });
});

describe("环境与参数", () => {
  test("默认 spawn 只给最小环境：bridge 的 token 类变量不继承", async () => {
    process.env.DISCORD_BOT_TOKEN_QUOTA_TEST = "leak-me";
    try {
      const r = await runWithTimeout(["/usr/bin/env"], 5000);
      const keys = r.stdout.trim().split("\n").map((l) => l.split("=")[0]).sort();
      expect(keys.every((k) => ["HOME", "LOGNAME", "PATH", "USER", "__CF_USER_TEXT_ENCODING"].includes(k))).toBe(true);
      expect(r.stdout).not.toContain("leak-me");
      expect(keys).toContain("HOME");
    } finally {
      delete process.env.DISCORD_BOT_TOKEN_QUOTA_TEST;
    }
  });

  test("minimalEnv 的形状", () => {
    expect(minimalEnv({ HOME: "/h", USER: "u", DISCORD_BOT_TOKEN: "x" })).toEqual({ HOME: "/h", PATH: "/usr/bin:/bin", USER: "u", LOGNAME: "u" });
  });

  test("argv 只有固定参数与服务名，不含秘密", async () => {
    const seen: string[][] = [];
    const spawn: SpawnFn = (argv) => {
      seen.push(argv);
      return Bun.spawn(["printf", keychainBlob()], { stdout: "pipe", stderr: "pipe" }) as never;
    };
    expect((await spawnKeychainReader({ spawn })("Claude Code-credentials")).status).toBe("ok");
    expect(seen).toEqual([["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]]);
  });

  test("退出码 / stderr 分类", () => {
    const base = { code: 0, stdout: "", stderr: "", timedOut: false };
    expect(classifyKeychain({ ...base, timedOut: true, code: null })).toEqual({ status: "timeout" });
    expect(classifyKeychain({ ...base, stdout: "x" })).toEqual({ status: "ok", stdout: "x" });
    expect(classifyKeychain({ ...base, code: 44 })).toEqual({ status: "missing" });
    expect(classifyKeychain({ ...base, code: 36, stderr: "User interaction is not allowed." })).toEqual({ status: "denied" });
    expect(classifyKeychain({ ...base, code: 128, stderr: "User canceled the operation." })).toEqual({ status: "denied" });
    expect(classifyKeychain({ ...base, code: 1, stderr: "weird" })).toEqual({ status: "error" });
    expect(classifyKeychain({ ...base, code: null })).toEqual({ status: "error" });
  });
});
