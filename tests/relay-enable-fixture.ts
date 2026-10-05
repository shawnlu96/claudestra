/**
 * tests/relay-enable.test.ts 的夹具：临时目录里的 .env + 假 start / undo，以及并发用例的受控调度。
 * 并发用例不靠「两个 Promise 谁先跑到」：.env 的 readFile 与 start 都是到达 / 释放握手（隔离子进程里替换 readFile），
 * 第二个调用在第一个停稳在指定检查点时发出，等它自己的结果再放行；每个检查点到达时对 .env / 锁目录拍快照。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableRelay, type EnableRelayDeps, type EnableRelayResult, type RelayStart } from "../src/bridge/relay-link.js";
import { readDotenvFileSync } from "../src/lib/env-file.js";
import { testChildEnv } from "./test-env.js";

const dirs: string[] = [];
export function cleanupDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export const ORIGINAL = "# Claudestra 运行时配置\nDISCORD_BOT_TOKEN=abc\nBRIDGE_PORT=3847\n";

export function harness(over: { env?: string | null; start?: () => Promise<RelayStart>; state?: string | null; sandbox?: string | null; current?: string } = {}) {
  const dir = tempDir("relay-enable-");
  const envPath = join(dir, ".env");
  const env = over.env === undefined ? ORIGINAL : over.env;
  if (env !== null) {
    writeFileSync(envPath, env);
    chmodSync(envPath, 0o600);
  }
  let starts = 0, undos = 0;
  const d: EnableRelayDeps = {
    envPath, lockPath: join(dir, "env-write.lock"),
    sandbox: () => over.sandbox ?? null,
    current: () => over.current ?? readDotenvFileSync(envPath)?.RELAY_URL?.trim() ?? "",
    start: async () => (starts++, over.start ? over.start() : { ok: true }),
    undo: async () => void undos++,
    state: () => over.state ?? "online",
  };
  return { d, dir, envPath, starts: () => starts, undos: () => undos, text: () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : null) };
}

/**
 * 真的让 Bun 同步读这份 .env：子进程最小 env、临时 HOME / 状态 / 运行时 / TMP，--no-env-file 只认显式给的那份，
 * cwd 放在空目录里
 */
export function bunReads(envPath: string, key: string, extraEnv: Record<string, string> = {}): string {
  const root = tempDir("relay-env-read-");
  const r = Bun.spawnSync([process.execPath, "--no-env-file", `--env-file=${envPath}`, "--print", `process.env.${key}`], {
    cwd: root,
    env: testChildEnv({ HOME: root, TMPDIR: root, CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run"), ...extraEnv }),
  });
  return r.stdout.toString().trim();
}


/**
 * 第一个调用路上的检查点（都在锁里）：read = writeEnvKeys 的 await readFile 发出、真 I/O 还没开始；read-done = 真读完、还没写；
 * start = .env 已写好、进了 start。第二个调用在第一个停在 launch 这一点时发出；sync = 同一 tick 紧接着发（第一个还没走到任何检查点）
 */
export type Launch = "sync" | "read" | "read-done" | "start";
export const LAUNCHES: Launch[] = ["sync", "read", "read-done", "start"];
type Checkpoint = Exclude<Launch, "sync">;
/** I/O 扰动：放行 read 之后、真 readFile 之前再插一段延迟（不插 / 让出一轮宏任务 / 15ms 定时器）；检查点握手不该受它影响 */
export const IO_DELAYS = ["none", "macrotask", "timer"] as const;
type IoDelay = (typeof IO_DELAYS)[number];
/** 反向故障：broken = 两个调用各拿一把互不相干的锁；lost-at-read = 第一个走到 I/O 那一步时锁目录被删（中途失锁） */
type LockMode = "shared" | "broken" | "lost-at-read";
export interface Scenario { launch: Launch; order: "AB" | "BA"; lock: LockMode; delay: IoDelay }

interface Arrival { tag: string; at: Checkpoint; env: string | null; lockHeld: boolean; listing: string[] }
interface Observed {
  first: string;
  second: string;
  /** 第二个调用发出那一刻，第一个调用最后到达的检查点（sync 时是 none） */
  phaseAtLaunch: Checkpoint | "none";
  log: string[];
  arrivals: Arrival[];
  /** 第二个调用拿到结果时，第一个是否还没结束（还停在检查点上） */
  secondSettledEarly: boolean;
  results: Record<string, EnableRelayResult>;
  starts: number;
  envAfter: string | null;
  listingAfter: string[];
}

const RESULT_MARK = "@@relay-contention@@";

/**
 * 并发场景在隔离子进程里跑：子进程把 fs/promises 的 readFile 换成带检查点的替身（mock.module 只在子进程生效，不污染全量测试），
 * 真 enableRelay → writeEnvKeys 的那次 I/O 由此可挂起 / 放行。最小 env、临时 HOME / 状态 / 运行时 / TMP，--no-env-file，cwd 是空目录
 */
export async function runContention(scenarios: Scenario[]): Promise<Observed[]> {
  const root = tempDir("relay-contention-");
  const proc = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, JSON.stringify(scenarios)], {
    cwd: root,
    env: testChildEnv({ HOME: root, TMPDIR: root, CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run") }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = out.split("\n").find((l) => l.startsWith(RESULT_MARK));
  if (code !== 0 || !line) throw new Error(`并发子进程失败（退出码 ${code}）：${err.slice(-2000)}`);
  return JSON.parse(line.slice(RESULT_MARK.length)) as Observed[];
}

/** 子进程里 readFile 替身的钩子：readFile 被调用那一刻同步认领（是哪个调用在读），返回各检查点的握手；null = 直通 */
let ioHook: (() => (at: Checkpoint) => Promise<void>) | null = null;

async function installIoGate(): Promise<void> {
  const { mock } = await import("bun:test");
  const real = await import("fs/promises");
  const readFile = real.readFile as (...args: unknown[]) => Promise<unknown>;
  mock.module("fs/promises", () => ({
    ...real,
    readFile: async (...args: unknown[]) => {
      const at = ioHook?.();
      await at?.("read");
      const out = await readFile(...args);
      await at?.("read-done");
      return out;
    },
  }));
}

const ioDelay = (d: IoDelay) => new Promise<void>((r) => (d === "none" ? r() : setTimeout(r, d === "timer" ? 15 : 0)));

/**
 * 一次两路并发接入（子进程内）：first 先发；它停在 launch 检查点（sync 时停在 start）、停稳的信号到了才发 second；
 * 等 second 自己的结果（完成握手，不按 tick 采样）再放行 first。每个检查点到达时对 .env / 锁目录拍快照
 */
async function runScenario(s: Scenario): Promise<Observed> {
  const h = harness();
  const urls: Record<string, string | undefined> = { A: undefined, B: "relay.other.example" };
  const [first, second] = s.order === "AB" ? ["A", "B"] : ["B", "A"];
  const hold: Checkpoint = s.launch === "sync" ? "start" : s.launch;
  const log: string[] = [];
  const arrivals: Arrival[] = [];
  const parked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let inLock = ""; // 最近在锁里调 current() 的调用：它紧接着同步发出 readFile，中间没有让出
  let firstAt: Checkpoint | "none" = "none";
  let firstDone = false;
  const checkpoint = async (tag: string, at: Checkpoint) => {
    log.push(`${tag}:${at}`);
    arrivals.push({ tag, at, env: h.text(), lockHeld: existsSync(h.d.lockPath), listing: readdirSync(h.dir).sort() });
    if (tag !== first) return; // 锁失效时第二个也会走到这里：直接放行，由断言判红
    firstAt = at;
    if (at === "read" && s.lock === "lost-at-read") rmSync(h.d.lockPath, { recursive: true, force: true });
    if (at === hold) parked.resolve(), await release.promise;
    if (at === "read") await ioDelay(s.delay);
  };
  const deps = (tag: string): EnableRelayDeps => ({
    ...h.d,
    lockPath: s.lock === "broken" ? join(h.dir, `env-write-${tag}.lock`) : h.d.lockPath,
    current: () => (log.push(`${tag}:current`), (inLock = tag), h.d.current()),
    start: async () => (await checkpoint(tag, "start"), h.d.start()),
  });
  const results: Record<string, EnableRelayResult> = {};
  const call = (tag: string) => enableRelay(urls[tag], deps(tag)).then((r) => void (results[tag] = r));
  ioHook = () => {
    const tag = inLock;
    return (at) => checkpoint(tag, at);
  };
  try {
    const pFirst = call(first).then(() => void (firstDone = true));
    if (s.launch !== "sync") await Promise.race([parked.promise, pFirst]);
    const phaseAtLaunch = firstAt;
    await call(second);
    const secondSettledEarly = !firstDone;
    release.resolve();
    await pFirst;
    return { first, second, phaseAtLaunch, log, arrivals, secondSettledEarly, results, starts: h.starts(), envAfter: h.text(), listingAfter: readdirSync(h.dir).sort() };
  } finally {
    ioHook = null;
  }
}

/** 并发的全部不变式；返回违反项（空 = 通过）。成功者必是先发的那个，与 A / B 谁先、I/O 快慢无关 */
export function contentionViolations(s: Scenario, o: Observed, relayUrlOf: (tag: string) => string): string[] {
  const bad: string[] = [];
  const want = (ok: boolean, what: string) => void (ok || bad.push(what));
  const w = o.results[o.first], l = o.results[o.second];
  const envWithUrl = `${ORIGINAL}RELAY_URL=${relayUrlOf(o.first)}\n`;
  const locked = JSON.stringify([".env", "env-write.lock"]);
  want(o.phaseAtLaunch === (s.launch === "sync" ? "none" : s.launch), `第二个发出时第一个应停在 ${s.launch}（实际 ${o.phaseAtLaunch}）`);
  want(w?.ok === true && w.relayUrl === relayUrlOf(o.first), `先发的 ${o.first} 应成功`);
  want(l?.ok === false && l.status === 409 && /另一次接入正在进行/.test(l.error), `后发的 ${o.second} 应因锁被占 409`);
  want(o.secondSettledEarly, "后发的应在先发的放行前就拿到 409，不排队");
  want(o.starts === 1, `start 只该调一次（实际 ${o.starts}）`);
  want(JSON.stringify(o.log) === JSON.stringify(["current", "read", "read-done", "start"].map((p) => `${o.first}:${p}`)), `调用顺序不对：${o.log.join(",")}`);
  want(JSON.stringify(o.arrivals.map((a) => `${a.tag}:${a.at}`)) === JSON.stringify(["read", "read-done", "start"].map((p) => `${o.first}:${p}`)), "只有先发的走到各检查点");
  for (const a of o.arrivals) {
    want(a.env === (a.at === "start" ? envWithUrl : ORIGINAL), `${a.tag} 到达 ${a.at} 时 .env 不对（读之前 / 读完未写 = 原文，start = 只多一行 RELAY_URL）`);
    want(a.lockHeld && JSON.stringify(a.listing) === locked, `${a.tag} 到达 ${a.at} 时锁应还拿着、没有临时文件`);
  }
  want(o.envAfter === envWithUrl, "结束后 .env 是先发者的地址");
  want(JSON.stringify(o.listingAfter) === JSON.stringify([".env"]), "结束后锁已释放、目录里只有 .env");
  return bad;
}

// 并发场景的子进程入口（runContention 起它）：`bun --no-env-file tests/relay-enable-fixture.ts '<Scenario[] JSON>'`，结果一行 JSON 打到 stdout
if (import.meta.main) {
  await installIoGate();
  const out: Observed[] = [];
  try {
    for (const s of JSON.parse(Bun.argv[2] ?? "[]") as Scenario[]) out.push(await runScenario(s));
  } finally {
    cleanupDirs();
  }
  console.log(`${RESULT_MARK}${JSON.stringify(out)}`);
}
