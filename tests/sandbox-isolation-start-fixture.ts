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
  /** 每次起 up child 后调用（Fleet 用它登记起到一半的进程组，runner 中途收尾时也能收掉） */
  onSpawn?: (proc: Proc, port: number) => void;
  /** 外层 onPicked await 恢复后同步复核取消；与 spawn 之间不能再 await，否则 stop 可漏收新 child。 */
  checkCancelled?: () => void;
}

type Proc = ReturnType<typeof Bun.spawn>;

/** 截止后的每段收尾（杀进程组后等退出、排空输出、down）各自的上限：收尾有界，不靠加大调用方 timeout */
const CLEANUP_MS = 5_000;

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

/** 给整个进程组发信号；ESRCH = 组里已没有进程，正是要的结果，其余错误原样抛 */
function killGroup(pgid: number, sig: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pgid, sig);
  } catch (e) {
    if ((e as { code?: string }).code !== "ESRCH") throw e;
  }
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), Bun.sleep(ms).then(() => false)]);

/** 读一路输出直到 EOF；返回「ms 内读完没有 + 已读内容」，没读完就取消读取（不无限等攥着管道的后代） */
function drain(stream: ReadableStream<Uint8Array>): (ms: number) => Promise<[boolean, string]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const eof = (async () => {
    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  })();
  return async (ms) => {
    const ended = await within(eof, ms);
    if (!ended) await reader.cancel();
    return [ended, Buffer.concat(chunks).toString()];
  };
}

interface Child {
  proc: Proc;
  /** 有界收输出：ms 内后代仍攥着管道没 EOF → 收掉整组（组里还有进程，组号不会被复用）再截断返回 */
  out: (ms: number) => Promise<string>;
  /** 收掉整个进程组（child 与继承它输出管道的后代），有界等 child 退出 */
  kill: (sig: "SIGTERM" | "SIGKILL") => Promise<void>;
}

/** 原入口子进程独占一个进程组（detached = setsid，组号即 pid），收尾按组杀，后代不会漏 */
function spawnChild(spec: StartSpec, argv: string[]): Child {
  const proc = Bun.spawn(argv, { cwd: spec.cwd, env: spec.env(), stdout: "pipe", stderr: "pipe", detached: true });
  const [a, b] = [drain(proc.stdout), drain(proc.stderr)];
  const kill = async (sig: "SIGTERM" | "SIGKILL") => {
    killGroup(proc.pid, sig);
    if (!(await within(proc.exited, CLEANUP_MS))) throw new Error(`${argv.join(" ")}（pid ${proc.pid}）${sig} 后 ${CLEANUP_MS}ms 仍没退出`);
  };
  const out = async (ms: number) => {
    const got = await Promise.all([a(ms), b(ms)]);
    const ended = got.every(([e]) => e);
    if (!ended) killGroup(proc.pid, "SIGKILL");
    return got.map(([, t]) => t).join("") + (ended ? "" : `\n（输出 ${ms}ms 内没结束：后代还攥着管道，已收掉整个进程组）`);
  };
  return { proc, out, kill };
}

/** 有界跑一次原入口（down）：ms 内没结束就收掉整组并报失败，不无限等 */
async function runBounded(spec: StartSpec, argv: string[], ms: number): Promise<{ ok: boolean; out: string }> {
  const c = spawnChild(spec, argv);
  const done = await within(c.proc.exited, ms);
  if (!done) await c.kill("SIGKILL");
  const out = await c.out(CLEANUP_MS);
  return { ok: done && c.proc.exitCode === 0, out: done ? out : `${ms}ms 内没结束，已收掉整个进程组：${out}` };
}

/** 等 up child 退出；本次起的 bridge 日志已报本端口 EADDRINUSE 时不必等脚本 20 秒的就绪超时，提前收掉 child */
async function settle(spec: StartSpec, child: Child, port: number, prevPid: number | null, offset: number): Promise<"exited" | "bridge-in-use" | "deadline"> {
  while (true) {
    if (child.proc.exitCode !== null || child.proc.signalCode !== null) return "exited";
    const pid = readPid(spec.root);
    if (pid && pid !== prevPid && bridgeInUse(logSince(spec.root, offset), port)) {
      await child.kill("SIGTERM");
      return "bridge-in-use";
    }
    if (Date.now() > spec.deadline) {
      await child.kill("SIGKILL");
      return "deadline";
    }
    await Bun.sleep(50);
  }
}

/** 换端口前清理本次尝试：down 收掉本次 bridge、pid 文件与沙箱 tmux；核验本次 bridge 已退、pid 文件已删（确无活宿主） */
async function cleanupAttempt(spec: StartSpec, port: number, pid: number | null): Promise<void> {
  if (existsSync(join(spec.root, SANDBOX_MARKER))) {
    const r = await runBounded(spec, spec.argv("down", port), CLEANUP_MS);
    if (!r.ok) throw new Error(`本次尝试的清理（down）失败：${r.out}`);
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
    spec.checkCancelled?.();
    const child = spawnChild(spec, spec.argv("up", port));
    spec.onSpawn?.(child.proc, port);
    const kind = await settle(spec, child, port, prevPid, offset);
    const out = await child.out(CLEANUP_MS);
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

interface Entry {
  spec: StartSpec;
  /** 当前（最后一次）起的 up child 与它的候选端口；起成功后 pid 为本次 bridge */
  up: Proc | null;
  port: number | null;
  pid: number | null;
  stopped: boolean;
  /** 本次启动（含失败路径的收尾）；stop 等它落定后再 down，收尾报完就不会再冒出新资源 */
  run: Promise<Started> | null;
}

/** 夹具起的沙箱登记表：起之前就登记，正常收尾 stop 摘掉；断言中途失败或起到一半 runner 收尾时 stopAll 兜底（detached bridge 不随测试进程退出） */
export class Fleet {
  private live = new Map<string, Entry>();

  async start(spec: StartSpec): Promise<Started> {
    if (this.live.has(spec.root)) throw new Error(`${spec.root} 已登记在跑，不能再起`);
    const it: Entry = { spec, up: null, port: null, pid: null, stopped: false, run: null };
    this.live.set(spec.root, it);
    const halted = () => new Error(`${spec.root} 起到一半已被收掉，不再尝试`);
    const onPicked = async (p: number, i: number) => {
      if (it.stopped) throw halted();
      await spec.onPicked?.(p, i);
      if (it.stopped) throw halted();
    };
    const onSpawn = (proc: Proc, p: number) => {
      [it.up, it.port] = [proc, p];
      spec.onSpawn?.(proc, p);
    };
    const checkCancelled = () => {
      spec.checkCancelled?.();
      if (it.stopped) throw halted();
    };
    it.run = startSandbox({ ...spec, onPicked, onSpawn, checkCancelled }).then((up) => {
      [it.port, it.pid] = [up.port, up.pid];
      return up;
    });
    try {
      const up = await it.run;
      if (it.stopped) throw new Error(`${spec.root} 起好时已被收掉（由 stop 负责 down 与核验），不算启动成功`);
      return up;
    } catch (e) {
      if (!it.stopped && this.live.get(spec.root) === it) this.live.delete(spec.root); // 失败路径 startSandbox 已收并把清理结果并进 e
      throw e;
    }
  }

  /** 收掉起到一半的 up 进程组、down，并核验：bridge 已退、bridge.pid 已删、端口已释放；问题逐条返回，不吞 */
  async stop(root: string): Promise<string[]> {
    const it = this.live.get(root);
    if (!it) return [`${root} 没登记，无从 down`];
    it.stopped = true;
    const bad: string[] = [];
    if (it.up && it.up.exitCode === null && it.up.signalCode === null) {
      killGroup(it.up.pid, "SIGKILL"); // child 还没被回收，组号仍是本次的
      if (!(await within(it.up.exited, CLEANUP_MS))) bad.push(`${root} 起到一半的 up（pid ${it.up.pid}）收不掉`);
    }
    // 起过 child 就等启动与失败收尾落定再 down；还没起 child 时，外层 await 后的同步取消检查保证不会再 spawn。
    if (it.up && it.run && !(await within(Promise.allSettled([it.run]), 4 * CLEANUP_MS))) bad.push(`${root} 起到一半的启动 ${4 * CLEANUP_MS}ms 内没落定`);
    this.live.delete(root);
    const pid = it.pid ?? readPid(root);
    if (it.port !== null && existsSync(join(root, SANDBOX_MARKER))) {
      const d = await runBounded(it.spec, it.spec.argv("down", it.port), CLEANUP_MS);
      if (!d.ok) bad.push(`${root} down 失败：${d.out}`);
    }
    for (let i = 0; pid && pidAlive(pid) && i < 20; i++) await Bun.sleep(100);
    if (pid && pidAlive(pid)) bad.push(`${root} 的 bridge（pid ${pid}）down 后仍活着`);
    if (existsSync(sandboxLayout(root).pidFile)) bad.push(`${root} down 后 bridge.pid 还在`);
    if (pid && it.port !== null && bindProbe(it.port) !== null) bad.push(`${root} down 后端口 ${it.port} 仍被占`);
    return bad;
  }

  async stopAll(): Promise<string[]> {
    const bad: string[] = [];
    for (const root of [...this.live.keys()]) bad.push(...(await this.stop(root)));
    return bad;
  }
}

/**
 * 测试可确认的同步点：闸门文件 gate 在、且还没人停过时，嵌进 shim 的这段 sh 把自己的 pid 写进 `${gate}.hit` 后停住，
 * 等 gate 被删（有界 15 秒）；之后的调用（如收尾的 down）直接放行。嵌在 tmux shim 前头 = 停在 up 的 ensure-tmux（预检之后、起 bridge 之前）
 */
export const gateShell = (gate: string) =>
  `if [ -e '${gate}' ] && [ ! -e '${gate}.hit' ]; then echo $$ > '${gate}.hit'; i=0; while [ -e '${gate}' ] && [ $i -lt 300 ]; do sleep 0.05; i=$((i+1)); done; fi`;

/** 等子进程停到闸门上（ms 内），返回停着的 shim 的 pid；等不到原样抛出 */
export async function gateHit(gate: string, ms: number): Promise<number> {
  for (const end = Date.now() + ms; !existsSync(`${gate}.hit`); await Bun.sleep(20)) {
    if (Date.now() > end) throw new Error(`子进程没走到闸门 ${gate}`);
  }
  for (let i = 0; readFileSync(`${gate}.hit`, "utf8").trim() === "" && i < 50; i++) await Bun.sleep(10); // pid 刚建文件还没写完
  return Number(readFileSync(`${gate}.hit`, "utf8").trim());
}

/** 等子进程停在闸门上 → 做 act（如抢端口）→ 放行；等不到（ms 内）或 act 抛错都原样抛出，闸门总会删 */
export async function atGate(gate: string, ms: number, act: () => void): Promise<void> {
  try {
    await gateHit(gate, ms);
    act();
  } finally {
    rmSync(gate, { force: true });
  }
}
