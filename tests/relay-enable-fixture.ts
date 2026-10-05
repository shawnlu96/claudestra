/**
 * tests/relay-enable.test.ts 的夹具：临时目录里的 .env + 假 start / undo，以及并发用例的受控调度。
 * 并发用例不靠「两个 Promise 谁先跑到」：start 是一道到达 / 释放握手，第二个调用按指定调度点发出，
 * 全程都在第一个调用卡在 start 里、锁还拿着的时候，到达那一刻对 .env / 锁目录拍快照。
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

/** 第二个调用的发出时机：都在第一个调用释放 start 之前 */
export type Launch =
  | { at: "sync" } // 和第一个同一 tick 紧接着发
  | { at: "ticks"; n: number } // 第一个发出后让出 n 轮宏任务（第一个的 .env 读写可能做了一部分）
  | { at: "arrived"; n: number }; // 第一个到达 start 之后再让出 n 轮宏任务

export const LAUNCHES: Launch[] = [
  { at: "sync" }, { at: "ticks", n: 1 }, { at: "ticks", n: 3 }, { at: "arrived", n: 0 }, { at: "arrived", n: 2 },
];

const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));
async function yieldTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await macrotask();
}

interface Arrival { tag: string; env: string | null; lockHeld: boolean; listing: string[] }
export interface Observed {
  first: string;
  second: string;
  log: string[];
  arrivals: Arrival[];
  /** 释放 start 之前，第二个调用是否已经有结果 */
  secondSettledEarly: boolean;
  results: Record<string, EnableRelayResult>;
  starts: number;
  envAfter: string | null;
  listingAfter: string[];
}

/** 锁失效的反向故障：两个调用各拿一把互不相干的锁 */
export type LockMode = "shared" | "broken";

/**
 * 跑一次两路并发接入：first 先发，second 按 launch 发出；start 握手——到达时拍快照并通知，测试放行前一直挂着。
 * 第一个到达者之后若还有人到达（锁失效时）直接放行，免得卡死，由断言判红。
 */
export async function runContention(launch: Launch, order: "AB" | "BA", lock: LockMode = "shared"): Promise<Observed> {
  const h = harness();
  const urls: Record<string, string | undefined> = { A: undefined, B: "relay.other.example" };
  const [first, second] = order === "AB" ? ["A", "B"] : ["B", "A"];
  const log: string[] = [];
  const arrivals: Arrival[] = [];
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deps = (tag: string): EnableRelayDeps => ({
    ...h.d,
    lockPath: lock === "shared" ? h.d.lockPath : join(h.dir, `env-write-${tag}.lock`),
    current: () => (log.push(`${tag}:current`), h.d.current()),
    start: async () => {
      log.push(`${tag}:start`);
      arrivals.push({ tag, env: h.text(), lockHeld: existsSync(h.d.lockPath), listing: readdirSync(h.dir).sort() });
      if (arrivals.length === 1) {
        arrived.resolve();
        await release.promise;
      }
      return h.d.start();
    },
  });
  const results: Record<string, EnableRelayResult> = {};
  const call = (tag: string) => enableRelay(urls[tag], deps(tag)).then((r) => void (results[tag] = r));
  const pFirst = call(first);
  if (launch.at === "ticks") await yieldTimes(launch.n);
  if (launch.at === "arrived") await arrived.promise, await yieldTimes(launch.n);
  const pSecond = call(second);
  // 第二个调用不该等第一个：给它足够让出（锁失效时它也会去读写 .env），再看它是否已经有结果
  await Promise.race([arrived.promise, pFirst]);
  await yieldTimes(5);
  const secondSettledEarly = second in results;
  release.resolve();
  await Promise.all([pFirst, pSecond]);
  return { first, second, log, arrivals, secondSettledEarly, results, starts: h.starts(), envAfter: h.text(), listingAfter: readdirSync(h.dir).sort() };
}

/** 并发的全部不变式；返回违反项（空 = 通过）。成功者必是先发的那个，与 A / B 谁先无关 */
export function contentionViolations(o: Observed, relayUrlOf: (tag: string) => string): string[] {
  const bad: string[] = [];
  const want = (ok: boolean, what: string) => void (ok || bad.push(what));
  const w = o.results[o.first], l = o.results[o.second];
  want(w?.ok === true && w.relayUrl === relayUrlOf(o.first), `先发的 ${o.first} 应成功`);
  want(l?.ok === false && l.status === 409 && /另一次接入正在进行/.test(l.error), `后发的 ${o.second} 应因锁被占 409`);
  want(o.secondSettledEarly, "后发的应在先发的放行前就拿到 409，不排队");
  want(o.starts === 1, `start 只该调一次（实际 ${o.starts}）`);
  want(JSON.stringify(o.log) === JSON.stringify([`${o.first}:current`, `${o.first}:start`]), `调用顺序不对：${o.log.join(",")}`);
  const a = o.arrivals[0];
  const envWithUrl = `${ORIGINAL}RELAY_URL=${relayUrlOf(o.first)}\n`;
  want(o.arrivals.length === 1 && a?.tag === o.first, "只有先发的到达 start");
  want(a?.env === envWithUrl, "到达 start 时 .env 已写好（只多一行 RELAY_URL）");
  want(a?.lockHeld === true && JSON.stringify(a?.listing) === JSON.stringify([".env", "env-write.lock"]), "到达 start 时锁还拿着、没有临时文件");
  want(o.envAfter === envWithUrl, "结束后 .env 是先发者的地址");
  want(JSON.stringify(o.listingAfter) === JSON.stringify([".env"]), "结束后锁已释放、目录里只有 .env");
  return bad;
}
