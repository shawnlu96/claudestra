#!/usr/bin/env bun
/**
 * CX-0：直接驱动真实 `codex app-server`（不经任何适配器），在 stdio 上接 tap 原样记录 JSON-RPC，回答自研 Codex 适配器的设计问题。
 * 每个场景一份记录：<out>/<runId>/<场景>/{rpc.jsonl, http.jsonl, egress.jsonl, stderr.log, result.json}。
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
const REAL_HOME = userInfo().homedir;
const FORBIDDEN_ROOTS = [join(REAL_HOME, ".codex"), stateDirIn(REAL_HOME), stateDir()];

/** 拒绝运行的三种情况：路径里有软链、落在真实 ~/.codex 或 Claudestra 状态目录下、CODEX_HOME 里已有 auth.json */
function assertIsolatedHome(dir: string): void {
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
  proc!: ReturnType<typeof Bun.spawn>;
  fake!: FakeResponses;
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
    this.proc = Bun.spawn([this.codexBin, "app-server"], { cwd: this.work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    void this.proc.exited.then((code) => {
      this.exitedAt = this.now();
      this.exitCode = code;
    });
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>, (l) => this.onLine(l));
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>, (l) => this.tap("err", l + "\n"));
    const init = await this.request("initialize", {
      clientInfo: { name: "claudestra-probe", version: "0.0.0", title: null },
      capabilities: { experimentalApi: this.opts.experimentalApi ?? true, requestAttestation: false },
    });
    if (init.error) throw new Error(`initialize 失败：${JSON.stringify(init.error)}`);
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

  killGroup(sig: NodeJS.Signals): void {
    try {
      process.kill(-this.proc.pid, sig);
    } catch (e) {
      // 组已经没了（ESRCH）正是想要的结果，记一笔就行
      this.note(`kill(-${this.proc.pid}, ${sig}): ${(e as Error).message}`);
    }
  }

  finish(result: unknown): void {
    this.fake?.stop();
    this.egress?.close();
    if (this.exitedAt === null) this.killGroup("SIGKILL");
    writeFileSync(join(this.dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
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

/** ps 快照：pid、ppid、pgid、命令名 */
export function psSnapshot(): Array<{ pid: number; ppid: number; pgid: number; comm: string }> {
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,comm="]).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), comm: m[4]! }));
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
  const version = Bun.spawnSync([codexBin, "--version"], { env: { PATH: process.env.PATH ?? "" } }).stdout.toString().trim();
  const only = arg("--only")?.split(",");
  const repeat = Number(arg("--repeat") ?? "1");
  writeFileSync(join(runDir, "meta.json"), JSON.stringify({ codexBin, version, only, repeat, startedAt: new Date().toISOString() }, null, 2));
  console.log(`codex: ${codexBin} (${version}) → ${runDir}`);
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only && !only.includes(name)) continue;
    for (let i = 0; i < repeat; i++) {
      const label = repeat > 1 ? `${name}-${i + 1}` : name;
      const p = new Probe(label, runDir, codexBin);
      try {
        const result = await run(p);
        p.finish(result);
        console.log(`✓ ${label}`, JSON.stringify(result).slice(0, 300));
      } catch (e) {
        p.finish({ error: String((e as Error).stack ?? e) });
        console.log(`✗ ${label}`, (e as Error).message);
      }
    }
  }
}

if (import.meta.main) await main();
