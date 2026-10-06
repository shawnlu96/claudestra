/**
 * 部署锁 wrapper(scripts/pm-deploy-lock.ts)的真实多进程回归:两个以上真子进程竞争、有界超时零部署、退出码 / 信号传播与释放、
 * wrapper 被 SIGKILL 后子进程仍算持有、嵌套重入不死锁、冒用 token 的独立进程仍互斥、argv 不经 shell。
 * 部署命令是临时目录里的模拟脚本(只往日志文件追加 enter/exit),状态目录 / HOME / TMPDIR 全是合成的。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testChildEnv } from "./test-env.ts";
import { main } from "../scripts/pm-deploy-lock.ts";

const WRAPPER = resolve(import.meta.dir, "../scripts/pm-deploy-lock.ts");
const BUN = process.execPath;
let root = "";
let log = "";
let fixture = "";
let lockFile = "";
let paths: Record<string, string> = {};
let env: Record<string, string> = {};

const FIXTURE_SRC = `
import { appendFileSync } from "node:fs";
const [log, name, holdMs, mode, wrapper] = process.argv.slice(2);
appendFileSync(log, "enter " + name + "\\n");
if (mode === "nest") {
  const r = Bun.spawnSync([process.execPath, wrapper, "run", "--label", "deploy-full", "--wait-sec", "2", "--",
    process.execPath, import.meta.path, log, name + "/inner", "30", "0"], { stdio: ["inherit", "inherit", "inherit"] });
  appendFileSync(log, "exit " + name + "\\n");
  process.exit(r.exitCode ?? 99);
}
if (mode === "tree" || mode === "tree-ignore" || mode === "bg") {
  // 部署脚本再起下一级命令(孙进程):tree 同步等它,bg 不等直接退出
  const gc = Bun.spawn([process.execPath, import.meta.path, log, name + "/gc", holdMs, mode === "tree-ignore" ? "ignore" : "0", wrapper],
    { stdio: ["ignore", "ignore", "ignore"] });
  if (mode === "bg") {
    gc.unref();
    appendFileSync(log, "exit " + name + "\\n");
    process.exit(0);
  }
  const code = await gc.exited;
  appendFileSync(log, "exit " + name + "\\n");
  process.exit(code);
}
if (mode === "ignore") process.on("SIGTERM", () => {});
await Bun.sleep(Number(holdMs));
if (mode === "sigkill") process.kill(process.pid, "SIGKILL");
appendFileSync(log, "exit " + name + "\\n");
process.exit(Number(mode) || 0);
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pm-deploy-cli-"));
  const state = join(root, "state");
  mkdirSync(state);
  mkdirSync(join(root, "tmp"));
  log = join(root, "deploy.log");
  writeFileSync(log, "");
  fixture = join(root, "fake-deploy.ts");
  writeFileSync(fixture, FIXTURE_SRC);
  lockFile = join(state, "pm-deploy.lock");
  paths = { HOME: root, TMPDIR: join(root, "tmp"), CLAUDESTRA_STATE_DIR: state };
  env = testChildEnv(paths);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Proc { proc: ReturnType<typeof Bun.spawn>; done: Promise<{ code: number; err: string }> }
function wrap(label: string, waitSec: number, cmd: string[], extraEnv: Record<string, string> = {}, extraArgs: string[] = []): Proc {
  const proc = Bun.spawn([BUN, WRAPPER, "run", "--label", label, "--wait-sec", String(waitSec), ...extraArgs, "--", ...cmd], {
    env: testChildEnv({ ...paths, ...extraEnv }), stdout: "pipe", stderr: "pipe",
  });
  const done = (async () => {
    const err = await new Response(proc.stderr as ReadableStream).text();
    return { code: await proc.exited, err };
  })();
  return { proc, done };
}
const deploy = (name: string, holdMs: number, mode = "0") => [BUN, fixture, log, name, String(holdMs), mode, WRAPPER];
const lines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("等待条件超时");
    await Bun.sleep(20);
  }
}
const lockHeld = () => existsSync(lockFile);
const record = () => JSON.parse(readFileSync(lockFile, "utf8"));
/** PATH 里垫一个 ps:对 wrapper 自身的查询原样走 /bin/ps;查别的 pid(部署子进程身份)时先留标记再按 behavior 处理 */
function psShim(behavior: "sleep 1.5" | "exit 1"): { PATH: string; marker: string } {
  const dir = join(root, "shim");
  mkdirSync(dir, { recursive: true });
  const marker = join(root, "ps-child-query");
  writeFileSync(join(dir, "ps"), `#!/bin/sh\nif [ "$4" != "$PPID" ]; then : > '${marker}'; ${behavior}; fi\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH}`, marker };
}

describe("两份部署入口真实并发", () => {
  test("3 个独立 wrapper(两个 label)同时起:关键区严格串行,全部完成", async () => {
    const ps = [wrap("deploy-full", 20, deploy("A", 300)), wrap("card-merge", 20, deploy("B", 300)), wrap("deploy-full", 20, deploy("C", 300))];
    const res = await Promise.all(ps.map((p) => p.done));
    expect(res.map((r) => r.code)).toEqual([0, 0, 0]);
    const l = lines();
    expect(l.length).toBe(6);
    for (let i = 0; i < l.length; i += 2) {
      expect(l[i]!.startsWith("enter ")).toBe(true);
      expect(l[i + 1]).toBe(`exit ${l[i]!.slice(6)}`);
    }
    expect(lockHeld()).toBe(false);
  }, 30_000);

  test("第二份有界超时:零部署、报持有者 label/pid/代次/获取时间,第一份不被 kill 正常完成", async () => {
    const first = wrap("deploy-full", 5, deploy("first", 1500));
    await until(() => lines().includes("enter first"));
    const second = wrap("card-merge", 0.3, deploy("second", 10));
    const r2 = await second.done;
    expect(r2.code).toBe(75);
    expect(r2.err).toContain("label=deploy-full");
    expect(r2.err).toContain(`pid=${first.proc.pid}`);
    expect(r2.err).toMatch(/代次=\w{3} \w{3} +\d+ [\d:]+ \d{4}/);
    expect(r2.err).toMatch(/获取于=\d{4}-\d\d-\d\dT/);
    expect(r2.err).toContain("未执行");
    expect((await first.done).code).toBe(0);
    expect(lines()).toEqual(["enter first", "exit first"]);
  }, 30_000);

  test("等锁时收到 SIGTERM:放弃、不执行、持有者不受影响", async () => {
    const first = wrap("deploy-full", 5, deploy("first", 1500));
    await until(() => lines().includes("enter first"));
    const waiter = wrap("card-merge", 30, deploy("waiter", 10));
    await Bun.sleep(400);
    waiter.proc.kill("SIGTERM");
    expect((await waiter.done).code).toBe(143);
    expect((await first.done).code).toBe(0);
    expect(lines()).toEqual(["enter first", "exit first"]);
  }, 30_000);
});

describe("退出 / 信号传播与释放", () => {
  test("命令非零退出:原样传播并释放,下一份立即拿到", async () => {
    expect((await wrap("deploy-full", 1, deploy("bad", 10, "3")).done).code).toBe(3);
    expect(lockHeld()).toBe(false);
    expect((await wrap("deploy-full", 0, deploy("next", 10)).done).code).toBe(0);
  }, 30_000);

  test("命令被信号杀死:128+信号,释放", async () => {
    expect((await wrap("deploy-full", 1, deploy("killed", 10, "sigkill")).done).code).toBe(137);
    expect(lockHeld()).toBe(false);
  }, 30_000);

  test("命令不存在:127,释放", async () => {
    expect((await wrap("deploy-full", 1, [join(root, "no-such-cmd")]).done).code).toBe(127);
    expect(lockHeld()).toBe(false);
  }, 30_000);

  test("wrapper 收到 SIGTERM:转发给部署子进程,等它退出后释放,退出码 143", async () => {
    const w = wrap("deploy-full", 1, deploy("long", 5000));
    await until(() => lines().includes("enter long"));
    w.proc.kill("SIGTERM");
    expect((await w.done).code).toBe(143);
    expect(lines()).toEqual(["enter long"]);
    expect(lockHeld()).toBe(false);
  }, 30_000);

  test("wrapper 被 SIGKILL 而部署子进程还在:锁仍算持有;子进程死后才被接管", async () => {
    const w = wrap("deploy-full", 1, deploy("orphan", 1500));
    await until(() => lines().includes("enter orphan") && lockHeld() && !!record().child);
    const childPid = record().child.pid as number;
    w.proc.kill("SIGKILL");
    await w.proc.exited; // 不等 stderr 读完:孤儿子进程还开着那根管道
    const blocked = await wrap("card-merge", 0.3, deploy("blocked", 10)).done;
    expect(blocked.code).toBe(75);
    expect(blocked.err).toContain(`child=${childPid}`);
    await until(() => lines().includes("exit orphan"));
    await Bun.sleep(100);
    expect((await wrap("card-merge", 5, deploy("after", 10)).done).code).toBe(0);
    expect(lines()).toEqual(["enter orphan", "exit orphan", "enter after", "exit after"]);
  }, 30_000);

  test("label 不合法 / 用法错误:不执行", async () => {
    expect(await main(["bogus"])).toBe(64);
    expect(await main(["run", "--label", "deploy-full", "--wait-sec", "99999", "--", "true"])).toBe(64);
    expect((await wrap("bad label", 1, deploy("x", 10)).done).code).toBe(70);
    const p = Bun.spawn([BUN, WRAPPER, "run", "--label", "deploy-full"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(64);
    expect(lines()).toEqual([]);
  }, 30_000);

  test("argv 不经 shell:元字符原样传给命令", async () => {
    const evil = `$(touch ${join(root, "PWNED")});x\`id\``;
    expect((await wrap("deploy-full", 1, deploy(evil, 10)).done).code).toBe(0);
    expect(lines()).toEqual([`enter ${evil}`, `exit ${evil}`]);
    expect(existsSync(join(root, "PWNED"))).toBe(false);
  }, 30_000);
});

describe("部署进程树生命周期(孙进程 / 启动窗口 / 身份未知)", () => {
  test("wrapper 收到 SIGTERM:整组转发,孙进程也停;第二份进关键区时上一份进程树已全部结束", async () => {
    const w = wrap("deploy-full", 1, deploy("tree", 1500, "tree"));
    await until(() => lines().includes("enter tree/gc") && lockHeld() && !!record().child);
    w.proc.kill("SIGTERM");
    expect((await w.done).code).toBe(143);
    expect((await wrap("card-merge", 5, deploy("second", 10)).done).code).toBe(0);
    await Bun.sleep(1700); // 孙进程若还活着,这时已写出 exit
    expect(lines()).toEqual(["enter tree", "enter tree/gc", "enter second", "exit second"]);
  }, 30_000);

  test("孙进程忽略 SIGTERM:直接子进程已退,锁仍持有到孙进程退出,第二份等锁后才进", async () => {
    const w = wrap("deploy-full", 1, deploy("tree", 1500, "tree-ignore"));
    await until(() => lines().includes("enter tree/gc") && lockHeld() && !!record().child);
    w.proc.kill("SIGTERM");
    await Bun.sleep(100);
    const second = wrap("card-merge", 10, deploy("second", 10));
    expect((await w.done).code).toBe(143);
    expect((await second.done).code).toBe(0);
    const l = lines();
    expect(l.indexOf("exit tree/gc")).toBeGreaterThan(-1);
    expect(l.indexOf("enter second")).toBeGreaterThan(l.indexOf("exit tree/gc"));
  }, 30_000);

  test("部署脚本正常退出但留下仍在跑的下级进程:锁不释放,第二份超时零部署", async () => {
    const w = wrap("deploy-full", 1, deploy("bg", 1500, "bg"));
    await until(() => lines().includes("exit bg") && lines().includes("enter bg/gc"));
    const second = await wrap("card-merge", 0.3, deploy("second", 10)).done;
    expect(second.code).toBe(75);
    expect((await w.done).code).toBe(0);
    expect(lines()).not.toContain("enter second");
    expect(lines()).toContain("exit bg/gc");
    expect(lockHeld()).toBe(false);
  }, 30_000);

  test("下级进程超过 --drain-sec 仍在:wrapper 退出但不释放,锁按进程组算活,组空后才被接管", async () => {
    const w = wrap("deploy-full", 1, deploy("bg", 1500, "bg"), {}, ["--drain-sec", "0.2"]);
    await until(() => lines().includes("enter bg/gc"));
    expect((await w.done).code).toBe(0);
    expect(lockHeld()).toBe(true);
    const blocked = await wrap("card-merge", 0.3, deploy("blocked", 10)).done;
    expect(blocked.code).toBe(75);
    expect(blocked.err).toContain("判定=live");
    await until(() => lines().includes("exit bg/gc"));
    expect((await wrap("card-merge", 5, deploy("after", 10)).done).code).toBe(0);
    expect(lines()).not.toContain("enter blocked");
    expect(lines().slice(-2)).toEqual(["enter after", "exit after"]);
  }, 30_000);

  test("启动窗口:子进程身份落盘前 wrapper 被 SIGKILL → 部署命令一步都没执行,第二份正常拿锁", async () => {
    const shim = psShim("sleep 1.5");
    const w = wrap("deploy-full", 1, deploy("child", 1500), { PATH: shim.PATH });
    await until(() => existsSync(shim.marker));
    expect(lockHeld() && !record().child).toBe(true);
    w.proc.kill("SIGKILL");
    await w.proc.exited;
    expect((await wrap("card-merge", 5, deploy("second", 10)).done).code).toBe(0);
    await Bun.sleep(800);
    expect(lines()).toEqual(["enter second", "exit second"]);
  }, 30_000);

  test("部署子进程身份查不到(ps 失败):fail-closed,命令不执行,退出 70,锁释放", async () => {
    const shim = psShim("exit 1");
    const r = await wrap("deploy-full", 1, deploy("child", 300), { PATH: shim.PATH }).done;
    expect(r.code).toBe(70);
    expect(r.err).toContain("未执行");
    await Bun.sleep(500);
    expect(lines()).toEqual([]);
    expect(lockHeld()).toBe(false);
  }, 30_000);
});

describe("嵌套与冒用", () => {
  test("card-merge 内部再经 wrapper 调 deploy-full:受控重入,不死锁", async () => {
    const r = await wrap("card-merge", 1, deploy("merge", 0, "nest")).done;
    expect(r.code).toBe(0);
    expect(r.err).toContain("受控重入");
    expect(lines()).toEqual(["enter merge", "enter merge/inner", "exit merge/inner", "exit merge"]);
    expect(lockHeld()).toBe(false);
  }, 30_000);

  test("独立进程冒用 label 与持有者 token:不是后代 → 仍互斥、超时零部署", async () => {
    const first = wrap("deploy-full", 5, deploy("first", 1500));
    await until(() => lines().includes("enter first") && lockHeld());
    const token = record().token as string;
    const impostor = await wrap("deploy-full", 0.3, deploy("impostor", 10), { CLAUDESTRA_PM_DEPLOY_LOCK_TOKEN: token }).done;
    expect(impostor.code).toBe(75);
    expect(impostor.err).not.toContain("受控重入");
    expect((await first.done).code).toBe(0);
    expect(lines()).toEqual(["enter first", "exit first"]);
  }, 30_000);

  test("status:打印持有者诊断且不泄露 token", async () => {
    const first = wrap("deploy-full", 5, deploy("first", 800));
    await until(() => lines().includes("enter first") && lockHeld());
    const token = record().token as string;
    const s = Bun.spawnSync([BUN, WRAPPER, "status"], { env, stdout: "pipe", stderr: "pipe" });
    const out = s.stdout.toString();
    expect(s.exitCode).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ status: "held", state: "live", record: { label: "deploy-full", holder: { pid: first.proc.pid } } });
    expect(out).not.toContain(token);
    await first.done;
  }, 30_000);
});
