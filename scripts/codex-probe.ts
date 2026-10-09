#!/usr/bin/env bun
/**
 * CX-0：直接驱动真实 `codex app-server`（不经任何适配器），在 stdio 上接 tap 原样记录 JSON-RPC，回答自研 Codex 适配器的设计问题。
 * 每个场景一份记录：<out>/<runId>/<场景>/{rpc.jsonl, http.jsonl, egress.jsonl, stderr.log, result.json, probe.json}。
 * 不碰真实凭据：每个场景 mkdtemp 一个隔离 HOME + CODEX_HOME，model provider 指向只绑 127.0.0.1 的假 Responses 服务
 * （tests/helpers/fake-responses.ts）；env 只给白名单，另把 HTTP(S)_PROXY 指向本地「记录后拒绝」的代理，外网访问只留记录不放行。
 * 用法：bun scripts/codex-probe.ts --out <目录> [--only a,b] [--codex <codex 可执行文件>] [--repeat N]
 * 结论与脱敏片段：docs/runtimes/codex-app-server-probe.md
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { stateDir, stateDirIn } from "../src/lib/state-dir.ts";
import { type FakeResponses, type RecordedRequest, type Reply, startFakeResponses } from "../tests/helpers/fake-responses.ts";
import { SCENARIOS } from "./codex-probe-scenarios.ts";

export interface Msg {
  t: number;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

export interface ProbeOptions {
  /** config.toml 顶层的额外键（自动压缩阈值之类），写在所有表之前 */
  topToml?: string;
  /** config.toml 末尾的额外表（mcp_servers 之类） */
  tablesToml?: string;
  /** false = 不声明 experimentalApi（Q0-7 对照） */
  experimentalApi?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** start 是 ps 的 lstart（秒级启动时间），和 pid 一起认「还是不是当初那个进程」 */
type PsRow = { pid: number; ppid: number; pgid: number; start: string; comm: string };
type Subprocess = ReturnType<typeof Bun.spawn>;
/** 运行期间扫后代的间隔；收尾宽限期里改成每 GRACE_POLL_MS 扫一次。两次扫描之间就脱离 app-server 的后代抓不到 */
const SCAN_MS = 500;
const GRACE_POLL_MS = 100;
const REAL_HOME = userInfo().homedir;
const FORBIDDEN_ROOTS = [join(REAL_HOME, ".codex"), stateDirIn(REAL_HOME), stateDir()];

/** 拒绝运行的三种情况：路径里有软链、落在真实 ~/.codex 或 Claudestra 状态目录下、CODEX_HOME 里已有 auth.json */
export function assertIsolatedHome(dir: string): void {
  const abs = resolve(dir);
  const real = realpathSync(abs);
  if (real !== abs) throw new Error(`拒绝运行：${abs} 的路径里有软链（realpath=${real}）`);
  for (const root of FORBIDDEN_ROOTS) {
    const r = existsSync(root) ? realpathSync(root) : root;
    if (real === r || real.startsWith(r + sep)) throw new Error(`拒绝运行：${real} 落在 ${r} 下`);
  }
  if (existsSync(join(real, "auth.json"))) throw new Error(`拒绝运行：${real} 里有 auth.json`);
}

function writeConfig(codexHome: string, baseUrl: string, opts: ProbeOptions): void {
  const toml = [
    'model = "fake-model"',
    'model_provider = "fake"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    opts.topToml ?? "",
    "",
    "[model_providers.fake]",
    'name = "fake"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
    opts.tablesToml ?? "",
  ].join("\n");
  writeFileSync(join(codexHome, "config.toml"), toml);
}

/** 本地 HTTP 代理：记下 CONNECT / 绝对 URL 请求的目标，一律回 403。外网访问只留记录，不放行 */
function startEgressRecorder(log: (host: string) => void): Promise<{ port: number; server: Server }> {
  const server = createServer((sock) => {
    sock.once("data", (buf) => {
      const first = buf.toString("latin1").split("\r\n")[0] ?? "";
      log(first.replace(/\?.*?(\s)/, "?<query>$1"));
      sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    // 被拒的客户端随时断开都无所谓：这个连接只为留一行记录
    sock.on("error", (e) => log(`<socket error ${e.message}>`));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ port: (server.address() as { port: number }).port, server })));
}

export class Probe {
  readonly msgs: Msg[] = [];
  readonly t0 = Date.now();
  readonly dir: string;
  readonly work: string;
  readonly codexHome: string;
  fake!: FakeResponses;
  /** 从 initialize 回包的 userAgent 里取（`<client>/<codex 版本> (...)`）；没起成就是 null */
  userAgent: string | null = null;
  serverVersion: string | null = null;
  private child: Subprocess | null = null;
  /** app-server 的后代（含改过进程组的），运行中每 SCAN_MS 登记一次；app-server 死后它们的 ppid 变 1，只能靠这里找回 */
  private readonly tracked = new Map<number, PsRow>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  exitedAt: number | null = null;
  exitCode: number | null = null;
  private nextId = 1;
  private pending = new Map<number, (m: Msg) => void>();
  private waiters: Array<{ pred: (m: Msg) => boolean; ok: (m: Msg) => void }> = [];
  private serverRequestHandler: (m: Msg) => unknown = () => ({ decision: "cancel" });
  private egress: Server | null = null;
  private egressPort = 0;
  private opts: ProbeOptions = {};

  constructor(
    readonly name: string,
    readonly outDir: string,
    readonly codexBin: string,
  ) {
    this.dir = join(outDir, name);
    mkdirSync(this.dir, { recursive: true });
    const root = mkdtempSync(join(outDir, `.home-${name}-`));
    this.codexHome = join(root, "codex-home");
    this.work = join(root, "work");
    for (const d of ["home", "codex-home", "tmp", "work"]) mkdirSync(join(root, d));
  }

  now(): number {
    return Date.now() - this.t0;
  }

  /** 当前的 app-server 子进程；还没起（比如启动前就被拒跑）时抛错，收尾路径用 child 判断 */
  get proc(): Subprocess {
    if (!this.child) throw new Error("app-server 还没起");
    return this.child;
  }

  private tap(dir: "out" | "in" | "err" | "note", line: string): void {
    appendFileSync(join(this.dir, dir === "err" ? "stderr.log" : "rpc.jsonl"), dir === "err" ? line : JSON.stringify({ t: this.now(), dir, line }) + "\n");
  }

  note(text: string): void {
    this.tap("note", text);
  }

  async start(responder: (r: RecordedRequest) => Reply | Promise<Reply>, opts: ProbeOptions = {}): Promise<void> {
    this.fake = startFakeResponses(async (r) => {
      appendFileSync(join(this.dir, "http.jsonl"), JSON.stringify({ t: r.at - this.t0, ...r }) + "\n");
      return responder(r);
    });
    const eg = await startEgressRecorder((line) => appendFileSync(join(this.dir, "egress.jsonl"), JSON.stringify({ t: this.now(), line }) + "\n"));
    this.egress = eg.server;
    this.egressPort = eg.port;
    writeConfig(this.codexHome, this.fake.baseUrl, opts);
    this.opts = opts;
    await this.spawn();
  }

  /** 同一个 CODEX_HOME、同一个假服务，再起一个 app-server（先 EOF 关掉旧的）。Q0-9 查重启后的对账 */
  async restart(): Promise<void> {
    await this.closeAndWait();
    this.exitedAt = null;
    this.exitCode = null;
    await this.spawn();
    this.notify("initialized");
  }

  private async spawn(): Promise<void> {
    assertIsolatedHome(this.codexHome);
    const root = resolve(this.codexHome, "..");
    const proxy = `http://127.0.0.1:${this.egressPort}`;
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(root, "home"),
      CODEX_HOME: this.codexHome,
      TMPDIR: join(root, "tmp"),
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      ALL_PROXY: proxy,
      NO_PROXY: "127.0.0.1,localhost",
    };
    const child = Bun.spawn([this.codexBin, "app-server"], { cwd: this.work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    this.child = child;
    void child.exited.then((code) => {
      // restart() 之后旧进程的退出事件不能盖掉新进程的状态
      if (this.child !== child) return;
      this.exitedAt = this.now();
      this.exitCode = code;
    });
    this.scanTimer ??= setInterval(() => this.scan(), SCAN_MS);
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>, (l) => this.onLine(l));
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>, (l) => this.tap("err", l + "\n"));
    const init = await this.request("initialize", {
      clientInfo: { name: "claudestra-probe", version: "0.0.0", title: null },
      capabilities: { experimentalApi: this.opts.experimentalApi ?? true, requestAttestation: false },
    });
    if (init.error) throw new Error(`initialize 失败：${JSON.stringify(init.error)}`);
    this.userAgent = init.result?.userAgent ?? null;
    this.serverVersion = this.userAgent?.match(/^[^/\s]+\/(\S+)/)?.[1] ?? null;
  }

  private async pump(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    }
    if (buf.trim()) onLine(buf);
  }

  private onLine(line: string): void {
    this.tap("in", line);
    let m: Msg;
    try {
      m = { t: this.now(), ...JSON.parse(line) };
    } catch {
      // 非 JSON 行已原样进了 rpc.jsonl，这里只是不参与关联
      return;
    }
    this.msgs.push(m);
    if (m.id !== undefined && m.method) {
      void Promise.resolve(this.serverRequestHandler(m)).then((result) => this.write({ id: m.id, result }));
      return;
    }
    if (m.id !== undefined && typeof m.id === "number") this.pending.get(m.id)?.(m);
    this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.ok(m), false) : true));
  }

  write(obj: object): void {
    const line = JSON.stringify(obj);
    this.tap("out", line);
    (this.proc.stdin as import("bun").FileSink).write(line + "\n");
    (this.proc.stdin as import("bun").FileSink).flush();
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** 发请求；返回整条响应（含 t、result / error）。超时返回 error.timeout，不抛 */
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<Msg> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((ok) => {
      const timer = setTimeout(() => ok({ t: this.now(), id, error: { timeout: timeoutMs } }), timeoutMs);
      this.pending.set(id, (m) => (clearTimeout(timer), ok(m)));
    });
  }

  /** 发请求但不等：返回 id，之后用 responseOf(id) 找回包 */
  send(method: string, params: unknown): number {
    const id = this.nextId++;
    this.write({ id, method, params });
    return id;
  }

  responseOf(id: number): Msg | undefined {
    return this.msgs.find((m) => m.id === id && !m.method);
  }

  onServerRequest(handler: (m: Msg) => unknown): void {
    this.serverRequestHandler = handler;
  }

  /** 等一条满足条件的消息（含已经到过的）；超时返回 null */
  waitFor(pred: (m: Msg) => boolean, timeoutMs = 20_000, since = 0): Promise<Msg | null> {
    const hit = this.msgs.find((m) => m.t >= since && pred(m));
    if (hit) return Promise.resolve(hit);
    return new Promise((ok) => {
      const timer = setTimeout(() => ok(null), timeoutMs);
      this.waiters.push({ pred: (m) => m.t >= since && pred(m), ok: (m) => (clearTimeout(timer), ok(m)) });
    });
  }

  async startThread(extra: Record<string, unknown> = {}): Promise<string> {
    const r = await this.request("thread/start", { cwd: this.work, ...extra }, 100_000);
    if (r.error) throw new Error(`thread/start 失败：${JSON.stringify(r.error)}`);
    return r.result.thread.id as string;
  }

  /** 关 stdin，量退出耗时；超过 limitMs 还活着就 SIGKILL 整组（记一笔） */
  async closeAndWait(limitMs = 10_000): Promise<number | null> {
    this.scan();
    const at = this.now();
    (this.proc.stdin as import("bun").FileSink).end();
    const deadline = Date.now() + limitMs;
    while (this.exitedAt === null && Date.now() < deadline) await sleep(20);
    if (this.exitedAt === null) {
      this.note(`EOF 后 ${limitMs}ms 未退出，SIGKILL 进程组`);
      this.killGroup("SIGKILL");
      return null;
    }
    return this.exitedAt - at;
  }

  /**
   * 场景主动停 app-server（整组信号）前先登记一次后代：停完它们就成了 ppid=1 的孤儿，再找不回来。
   * 返回信号发出时刻（相对 t0），量退出耗时要从这里算，别把 ps 扫描的时间算进去
   */
  killGroup(sig: NodeJS.Signals): number {
    if (this.child) this.scan();
    const at = this.now();
    if (this.child) this.kill(-this.child.pid, sig);
    return at;
  }

  /** 只给 app-server 本身发信号（不是整组），同样先登记后代；返回信号发出时刻 */
  signalServer(sig: NodeJS.Signals): number {
    if (this.child) this.scan();
    const at = this.now();
    if (this.child) this.kill(this.child.pid, sig);
    return at;
  }

  private kill(target: number, sig: NodeJS.Signals): void {
    try {
      process.kill(target, sig);
    } catch (e) {
      // 目标已经没了（ESRCH）正是想要的结果，记一笔就行
      this.note(`kill(${target}, ${sig}): ${(e as Error).message}`);
    }
  }

  /**
   * 把 app-server 的后代登记进 tracked：从 app-server（还没被回收时）和已登记且仍是原进程的 pid 往下找。
   * app-server 回收后它的 pid 可能被别的进程复用，所以只在 exitedAt 为 null 时拿它当根
   */
  private scan(rows: PsRow[] = psSnapshot()): void {
    if (!this.child) return;
    const roots = new Set(this.liveTracked(rows).map((x) => x.pid));
    if (this.exitedAt === null) roots.add(this.child.pid);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of rows) {
        if (roots.has(x.pid) || !roots.has(x.ppid)) continue;
        roots.add(x.pid);
        this.tracked.set(x.pid, x);
        grew = true;
      }
    }
  }

  /**
   * 登记过、现在还活着（不算僵尸）、启动时间没变（防 pid 复用）的后代，返回**当前**这一行：
   * 登记之后才 setsid / exec 的进程 pgid、命令名会变，发信号要用现在的 pgid
   */
  private liveTracked(rows: PsRow[]): PsRow[] {
    const byPid = new Map(rows.map((x) => [x.pid, x]));
    return [...this.tracked.values()].flatMap((t) => {
      const now = byPid.get(t.pid);
      return now && now.start === t.start && now.comm !== "<defunct>" ? [now] : [];
    });
  }

  /** 一次 ps：先补登记新冒出来的后代，再返回还活着的登记后代 */
  private sweep(): PsRow[] {
    const rows = psSnapshot();
    this.scan(rows);
    return this.liveTracked(rows);
  }

  private survivorsOf(live: PsRow[]): string[] {
    const self = this.child && this.exitedAt === null ? [`${this.child.pid}:app-server`] : [];
    return [...self, ...live.map((x) => `${x.pid}:${x.comm.split("/").pop()}`)];
  }

  /** 宽限期等待：每 GRACE_POLL_MS 补扫一次（新后代随时并入），done 成立或超时为止；返回最后一次扫到的存活后代 */
  private async graceWait(done: (live: PsRow[]) => boolean, ms: number): Promise<PsRow[]> {
    const end = Date.now() + ms;
    for (;;) {
      const live = this.sweep();
      if (done(live) || Date.now() >= end) return live;
      await sleep(GRACE_POLL_MS);
    }
  }

  /** 对 app-server 的进程组，以及 live 里每个后代（它现在的进程组 + pid）发信号；不碰探针自己所在的组 */
  private signalAll(sig: NodeJS.Signals, ownPgid: number | undefined, live: PsRow[]): void {
    if (this.child) this.kill(-this.child.pid, sig);
    for (const x of live) {
      if (x.pgid > 1 && x.pgid !== ownPgid) this.kill(-x.pgid, sig);
      this.kill(x.pid, sig);
    }
  }

  /**
   * 统一收尾（场景正常结束或中途抛错都走这里）：EOF 等 2s → SIGTERM 等 1s → SIGKILL 等 1s，最后再扫一次记存活者。
   * 后台扫描一直开到收尾结束；每段等待里每 GRACE_POLL_MS 补扫一次，每次发信号前用的都是刚扫出来的集合，
   * 所以宽限期里才冒出来的后代（EOF 之后才派生、改了进程组的）也会并进来。覆盖 app-server 进程组和全部登记后代（Q0-6）
   */
  async cleanup(): Promise<Record<string, unknown>> {
    try {
      if (!this.child) return { spawned: false };
      const ownPgid = psSnapshot().find((x) => x.pid === process.pid)?.pgid;
      this.sweep();
      if (this.exitedAt === null) {
        try {
          (this.child.stdin as import("bun").FileSink).end();
        } catch (e) {
          // stdin 已经关了：照样往下走信号步骤
          this.note(`收尾关 stdin：${(e as Error).message}`);
        }
      }
      const done = (live: PsRow[]) => this.survivorsOf(live).length === 0;
      // EOF 之后要等的是 app-server 退出，后代的去留交给后面两步；等待期间照样补扫
      let live = await this.graceWait(() => this.exitedAt !== null, 2_000);
      live = this.sweep();
      const afterEof = this.survivorsOf(live);
      if (afterEof.length) this.signalAll("SIGTERM", ownPgid, live);
      live = await this.graceWait(done, 1_000);
      live = this.sweep();
      const afterTerm = this.survivorsOf(live);
      if (afterTerm.length) this.signalAll("SIGKILL", ownPgid, live);
      await this.graceWait(done, 1_000);
      const afterKill = this.survivorsOf(this.sweep());
      const tracked = [...this.tracked.values()].map((x) => `${x.pid}:${x.comm.split("/").pop()}:pgid=${x.pgid}`);
      return { spawned: true, tracked, afterEof, afterTerm, afterKill };
    } finally {
      if (this.scanTimer) clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /** 先落 result.json（原始结果 / 错误绝不因收尾出错而丢），再收尾，收尾报告进 probe.json */
  async finish(result: unknown): Promise<void> {
    writeFileSync(join(this.dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
    let cleanup: unknown;
    try {
      cleanup = await this.cleanup();
    } catch (e) {
      cleanup = { error: String((e as Error).stack ?? e) };
    }
    this.fake?.stop();
    this.egress?.close();
    writeFileSync(join(this.dir, "probe.json"), JSON.stringify({ userAgent: this.userAgent, cleanup }, null, 2) + "\n");
  }
}

/** 一轮完整的「方法名 + 相对时间」序列，供结论表直接引用 */
export function timeline(msgs: Msg[], from = 0): string[] {
  return msgs
    .filter((m) => m.t >= from)
    .map((m) => {
      const st = m.params?.status?.type ?? m.params?.turn?.status ?? m.params?.item?.type ?? "";
      return `${m.t}ms ${m.method ?? `resp#${m.id}${m.error ? " ERR" : ""}`}${st ? ` ${st}` : ""}`;
    });
}

/** ps 快照：pid、ppid、pgid、启动时间（lstart，形如 "Mon Oct  5 17:23:01 2026"）、命令名 */
export function psSnapshot(): PsRow[] {
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,lstart=,comm="]).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4]!, comm: m[5]! }));
}

/** CODEX_HOME 下所有 rollout 文件的内容拼起来（Q0-1 查 steer 进没进 rollout） */
export function rolloutText(codexHome: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (lstatSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) out.push(readFileSync(p, "utf8"));
    }
  };
  if (existsSync(join(codexHome, "sessions"))) walk(join(codexHome, "sessions"));
  return out.join("\n");
}

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = arg("--out");
  if (!out) {
    console.error("用法: bun scripts/codex-probe.ts --out <目录> [--only a,b] [--codex <path>] [--repeat N]");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const runDir = join(realpathSync(out), new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir);
  const codexBin = arg("--codex") ?? Bun.which("codex");
  if (!codexBin) throw new Error("找不到 codex（PATH 里没有，也没给 --codex）");
  const only = arg("--only")?.split(",");
  const repeat = Number(arg("--repeat") ?? "1");
  // 版本号不另起 `codex --version`（那次启动不在隔离环境里）：取每个场景 initialize 回包里的 userAgent
  const versions = new Set<string>();
  const writeMeta = () =>
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({ codexBin, versions: [...versions], only, repeat, startedAt }, null, 2) + "\n");
  const startedAt = new Date().toISOString();
  writeMeta();
  console.log(`codex: ${codexBin} → ${runDir}`);
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only && !only.includes(name)) continue;
    for (let i = 0; i < repeat; i++) {
      const label = repeat > 1 ? `${name}-${i + 1}` : name;
      const p = new Probe(label, runDir, codexBin);
      let result: unknown;
      let ok = true;
      try {
        result = await run(p);
      } catch (e) {
        ok = false;
        result = { error: String((e as Error).stack ?? e) };
      }
      await p.finish(result);
      if (p.serverVersion) versions.add(p.serverVersion);
      writeMeta();
      console.log(`${ok ? "✓" : "✗"} ${label}`, JSON.stringify(result).slice(0, 300));
    }
  }
}

if (import.meta.main) await main();
