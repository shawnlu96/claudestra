/**
 * 沙箱隔离测试的启动夹具：经原入口（scripts/sandbox.ts up）起沙箱 bridge，协调「选端口 → 关占位 → 子进程绑定」之间的端口竞争。
 * 只有确认是本次 child 撞上 EADDRINUSE（脚本预检报本端口被占 / bridge 日志里本端口 EADDRINUSE）、且本次起的 bridge 已死、
 * 端口此刻确实被别人占着时，才清理后换端口重来（次数与截止时间都有界）；其余任何启动失败原样抛出，不重跑。
 * 成功时核验：pid 文件里的 bridge 活着、是本次起的、（有 lsof 时）正是它在监听这个端口。
 */
import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { SANDBOX_MARKER } from "../src/lib/sandbox.ts";
import { sandboxLayout } from "../src/lib/sandbox-env.ts";

export interface StartSpec {
  /** 沙箱根目录（bridge.pid / bridge.log 所在） */
  root: string;
  /** 原入口的 argv：`sub` 为 up / down */
  argv: (sub: "up" | "down", port: number) => string[];
  env: () => Record<string, string>;
  cwd: string;
  /** 绝对截止时间：取调用方现有 timeout 之内，夹具不另加时间 */
  deadline: number;
  /** 不许选的端口：生产端口、拒连负例端口 */
  avoid: number[];
  maxAttempts?: number;
  /** 受控扰动钩子：选好候选端口、起 child 之前调用（测试用它人为抢占端口） */
  onPicked?: (port: number, attempt: number) => void | Promise<void>;
  /** 指定首个候选端口（重启时沿用原端口）；之后的尝试照常随机选 */
  firstPort?: number;
}

export interface Attempt {
  port: number;
  /** started：起来了；port-race：本端口被抢、已清理换端口；failed：其它失败，原样抛出 */
  outcome: "started" | "port-race" | "failed";
  out: string;
}

export interface Started {
  port: number;
  pid: number;
  out: string;
  attempts: Attempt[];
}

export class StartFailure extends Error {
  constructor(msg: string, readonly attempts: Attempt[]) {
    super(msg);
  }
}

/** 这个端口此刻能不能在回环上绑：能绑 → null；被占 → "EADDRINUSE"；别的错误原样抛（不当成被占） */
function bindProbe(port: number): "EADDRINUSE" | null {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return null;
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE") return "EADDRINUSE";
    throw e;
  }
}

/** 随机挑一个当下空闲、不在 avoid 里的回环端口（探测后即关，之后仍可能被抢——由 startSandbox 协调） */
export function pickPort(avoid: number[]): number {
  for (let i = 0; i < 50; i++) {
    const p = 20000 + Math.floor(Math.random() * 9000);
    if (!avoid.includes(p) && bindProbe(p) === null) return p;
  }
  throw new Error("找不到空闲端口");
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = 进程已不在；EPERM 说明进程在（只是不归我们管），按活着算，免得误判成「无活宿主」
    return (e as { code?: string }).code === "EPERM";
  }
}

function readPid(root: string): number | null {
  const f = sandboxLayout(root).pidFile;
  if (!existsSync(f)) return null;
  const n = Number(readFileSync(f, "utf8").trim());
  return Number.isInteger(n) && n > 1 ? n : null;
}

/** bridge.log 从 offset 起的新内容（追加写，按本次尝试切段） */
function logSince(root: string, offset: number): string {
  const f = sandboxLayout(root).logFile;
  return existsSync(f) ? readFileSync(f).subarray(offset).toString() : "";
}

function logSize(root: string): number {
  const f = sandboxLayout(root).logFile;
  return existsSync(f) ? statSync(f).size : 0;
}

/** 监听这个端口的进程（有 lsof 时），没有 lsof 返回 null */
function listeners(port: number): number[] | null {
  if (!Bun.which("lsof")) return null;
  const r = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { stdout: "pipe" });
  return r.stdout.toString().split("\n").filter((l) => l.startsWith("p")).map((l) => Number(l.slice(1)));
}

/** 脚本预检只报了「本端口被占」这一条（多条问题说明还有别的毛病，不能换端口了事） */
function precheckPortOnly(out: string, port: number): boolean {
  const m = /❌ ([\s\S]*)$/.exec(out.trim());
  if (!m) return false;
  const problems = m[1]!.split("\n").map((l) => l.trim()).filter(Boolean);
  return problems.length === 1 && problems[0] === `端口 ${port} 已被占用；换一个 --port`;
}

/** Bun.serve 撞 EADDRINUSE 的报错原文；bridge 的 uncaughtException 兜底只记 message、进程不退，所以按这句认 */
const bridgeInUse = (log: string, port: number) => log.includes(`Failed to start server. Is port ${port} in use?`);

interface Child {
  proc: ReturnType<typeof Bun.spawn>;
  out: () => Promise<string>;
}

function spawnUp(spec: StartSpec, port: number): Child {
  const proc = Bun.spawn(spec.argv("up", port), { cwd: spec.cwd, env: spec.env(), stdout: "pipe", stderr: "pipe" });
  const text = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([a, b]) => a + b);
  return { proc, out: () => text };
}

/** 等 up child 退出；本次起的 bridge 日志已报本端口 EADDRINUSE 时不必等脚本 20 秒的就绪超时，提前收掉 child */
async function settle(spec: StartSpec, child: Child, port: number, prevPid: number | null, offset: number): Promise<"exited" | "bridge-in-use" | "deadline"> {
  while (true) {
    if (child.proc.exitCode !== null || child.proc.signalCode !== null) return "exited";
    const pid = readPid(spec.root);
    if (pid && pid !== prevPid && bridgeInUse(logSince(spec.root, offset), port)) {
      child.proc.kill("SIGTERM");
      await child.proc.exited;
      return "bridge-in-use";
    }
    if (Date.now() > spec.deadline) {
      child.proc.kill("SIGKILL");
      await child.proc.exited;
      return "deadline";
    }
    await Bun.sleep(50);
  }
}

/** 换端口前清理本次尝试：down 收掉本次 bridge、pid 文件与沙箱 tmux；核验本次 bridge 已退、pid 文件已删（确无活宿主） */
async function cleanupAttempt(spec: StartSpec, port: number, pid: number | null): Promise<void> {
  if (existsSync(join(spec.root, SANDBOX_MARKER))) {
    const r = Bun.spawnSync(spec.argv("down", port), { cwd: spec.cwd, env: spec.env(), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`冲突后清理（down）失败：${r.stdout.toString()}${r.stderr.toString()}`);
  }
  for (let i = 0; pid && pidAlive(pid) && i < 20; i++) await Bun.sleep(100); // 被 kill 后等它被回收
  if (pid && pidAlive(pid)) throw new Error(`端口 ${port} 冲突后本次 bridge（pid ${pid}）清理不掉，不能换端口重来`);
  if (existsSync(sandboxLayout(spec.root).pidFile)) throw new Error("冲突后清理没删掉 bridge.pid");
}

/** 成功后的归属核验：pid 文件是本次的、进程活着、（有 lsof 时）这个端口的监听者只有它 */
function verifyOwned(spec: StartSpec, port: number, prevPid: number | null, out: string): number {
  const pid = readPid(spec.root);
  if (!pid || pid === prevPid || !pidAlive(pid)) throw new Error(`up 报成功但 bridge.pid 不是本次活着的进程（${pid}）：${out}`);
  const ls = listeners(port);
  if (ls && (ls.length === 0 || ls.some((p) => p !== pid))) throw new Error(`端口 ${port} 的监听者 ${ls} 不是本次 bridge ${pid}`);
  return pid;
}

/**
 * 判定一次失败是否「本端口被抢」：没起 bridge 时预检只报本端口被占；起了 bridge 时它的日志本段报本端口 EADDRINUSE、
 * 且（有 lsof 时）端口的监听者不是它。两种都要此刻自己探测本端口确实 EADDRINUSE（不是别的原因）。
 */
function portRaced(spec: StartSpec, port: number, out: string, fresh: number | null, offset: number): boolean {
  if (fresh === null) return precheckPortOnly(out, port) && bindProbe(port) === "EADDRINUSE";
  if (!bridgeInUse(logSince(spec.root, offset), port) || bindProbe(port) !== "EADDRINUSE") return false;
  return !(listeners(port) ?? []).includes(fresh);
}

/** 非端口竞争的失败：本次起过的东西（bridge / 新建的沙箱）先 down 收掉并核验，再连同清理结果原样抛出，不重跑 */
async function failAttempt(spec: StartSpec, port: number, fresh: number | null, created: boolean, msg: string, attempts: Attempt[]): Promise<never> {
  let cleanup = "";
  if (fresh !== null || created) {
    try {
      await cleanupAttempt(spec, port, fresh);
    } catch (e) {
      cleanup = `\n（清理本次尝试也失败了：${(e as Error).message}）`; // 并进下面抛出的错误里，不吞
    }
  }
  throw new StartFailure(msg + cleanup, attempts);
}

/** 经原入口起沙箱 bridge；只在确认端口被抢时有界换端口，其余失败原样抛出 */
export async function startSandbox(spec: StartSpec): Promise<Started> {
  const attempts: Attempt[] = [];
  const max = spec.maxAttempts ?? 3;
  for (let i = 0; i < max; i++) {
    const port = i === 0 && spec.firstPort ? spec.firstPort : pickPort(spec.avoid);
    if (spec.avoid.includes(port)) throw new StartFailure(`端口 ${port} 在禁用表里`, attempts);
    await spec.onPicked?.(port, i);
    const prevPid = readPid(spec.root);
    const offset = logSize(spec.root);
    const hadMarker = existsSync(join(spec.root, SANDBOX_MARKER));
    const child = spawnUp(spec, port);
    const kind = await settle(spec, child, port, prevPid, offset);
    const out = await child.out();
    const pid = readPid(spec.root);
    const fresh = pid !== null && pid !== prevPid ? pid : null;
    const created = !hadMarker && existsSync(join(spec.root, SANDBOX_MARKER));
    if (kind === "exited" && child.proc.exitCode === 0) {
      attempts.push({ port, outcome: "started", out });
      try {
        return { port, pid: verifyOwned(spec, port, prevPid, out), out, attempts };
      } catch (e) {
        attempts[attempts.length - 1]!.outcome = "failed";
        return failAttempt(spec, port, fresh, created, (e as Error).message, attempts);
      }
    }
    if (kind === "deadline" || !portRaced(spec, port, out, fresh, offset)) {
      attempts.push({ port, outcome: "failed", out });
      const why = kind === "deadline" ? "超过截止时间仍未结束" : "非端口竞争";
      return failAttempt(spec, port, fresh, created, `沙箱 up 失败（端口 ${port}，${why}，不重跑）：\n${out}\n${logSince(spec.root, offset)}`, attempts);
    }
    attempts.push({ port, outcome: "port-race", out });
    await cleanupAttempt(spec, port, fresh);
  }
  throw new StartFailure(`连续 ${max} 次端口被抢，放弃：${attempts.map((a) => a.port).join(", ")}`, attempts);
}

/** 夹具起成功的沙箱登记表：正常收尾 stop 摘掉；测试断言中途失败时 stopAll 兜底 down（detached bridge 不会随测试进程退出） */
export class Fleet {
  private live = new Map<string, { spec: StartSpec; port: number; pid: number }>();

  async start(spec: StartSpec): Promise<Started> {
    const up = await startSandbox(spec);
    this.live.set(spec.root, { spec, port: up.port, pid: up.pid });
    return up;
  }

  /** down 并核验：本次 bridge 已退、bridge.pid 已删、端口已释放；问题逐条返回，不吞 */
  async stop(root: string): Promise<string[]> {
    const it = this.live.get(root);
    if (!it) return [`${root} 没登记，无从 down`];
    this.live.delete(root);
    const d = Bun.spawnSync(it.spec.argv("down", it.port), { cwd: it.spec.cwd, env: it.spec.env(), stdout: "pipe", stderr: "pipe" });
    const bad = d.exitCode === 0 ? [] : [`${root} down 失败：${d.stdout.toString()}${d.stderr.toString()}`];
    for (let i = 0; pidAlive(it.pid) && i < 20; i++) await Bun.sleep(100);
    if (pidAlive(it.pid)) bad.push(`${root} 的 bridge（pid ${it.pid}）down 后仍活着`);
    if (existsSync(sandboxLayout(root).pidFile)) bad.push(`${root} down 后 bridge.pid 还在`);
    if (bindProbe(it.port) !== null) bad.push(`${root} down 后端口 ${it.port} 仍被占`);
    return bad;
  }

  async stopAll(): Promise<string[]> {
    const bad: string[] = [];
    for (const root of [...this.live.keys()]) bad.push(...(await this.stop(root)));
    return bad;
  }
}

/**
 * 测试可确认的同步点：闸门文件 gate 在时，嵌进 shim 的这段 sh 记下 `${gate}.hit` 后停住，等 gate 被删（有界 15 秒）。
 * 嵌在 tmux shim 前头 = 停在 up 的 ensure-tmux（预检之后、起 bridge 之前）
 */
export const gateShell = (gate: string) =>
  `if [ -e '${gate}' ]; then : > '${gate}.hit'; i=0; while [ -e '${gate}' ] && [ $i -lt 300 ]; do sleep 0.05; i=$((i+1)); done; fi`;

/** 等子进程停在闸门上 → 做 act（如抢端口）→ 放行；等不到（ms 内）或 act 抛错都原样抛出，闸门总会删 */
export async function atGate(gate: string, ms: number, act: () => void): Promise<void> {
  try {
    for (const end = Date.now() + ms; !existsSync(`${gate}.hit`); await Bun.sleep(20)) {
      if (Date.now() > end) throw new Error(`子进程没走到闸门 ${gate}`);
    }
    act();
  } finally {
    rmSync(gate, { force: true });
  }
}
