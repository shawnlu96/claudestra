#!/usr/bin/env bun
/**
 * CXF-S 上线门槛的真 CLI 组合实测：同一个 Codex 线程按 2.1.0 → 自研 → 2.1.0 来回切，每一段都是真的 ACP 宿主（lib/acp/host.ts）
 * 起真的适配器、按 session/resume 接回同一线程，跑真的 codex app-server 回合；切换走真的开关命令（manager/acp-adapter.ts applySwitch）
 * 和「宿主空闲时自己退出（retireIfIdle，生产里是 SIGUSR2）→ 按开关重起宿主」的重启路径，回合在跑时切换要被推迟（deferred）。
 * 每一轮发给模型的请求里要带着之前所有回合（历史没丢），线程 id 始终是同一个、rollout 只有一份（状态没丢）。
 * 隔离：一个 mkdtemp 根（HOME、CODEX_HOME、TMPDIR、cwd、开关文件都在里面），model provider 是只绑 127.0.0.1 的假 Responses，
 * 代理指到死端口；不读 ~/.codex、不需要登录，不连生产 bridge（bridge 一侧是进程内的假连接）。上游 2.1.0 只读本机已装的那份。
 * --npm：另外实机跑更新闸的「npm 候选」判定（codex-compat.ts probeNpmCodexCompat：真的从 npm 装进一次性临时目录、用装出来的 codex
 *   生成 schema 和已提交的锁比；npm 走登录 shell，和 bridge 的 runInLoginShell 一样拿 npm 的 PATH；不碰全局 Codex 和 ~/.codex）。
 * 用法：bun scripts/codex-adapter-relay.ts --out <目录> [--codex <codex>] [--codex-acp <2.1.0 的 index.js>] [--npm 0.159.3,0.160.1] [--keep]（留下隔离根）
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import { CODEX_ACP_ADAPTER_MAIN } from "../src/lib/acp/codex-adapter/main.ts";
import { pickCodexAdapter, probeNpmCodexCompat, selectedCodexAdapter } from "../src/lib/acp/codex-compat.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";
import type { StopReport } from "../src/lib/acp/turn.ts";
import { stateDir } from "../src/lib/state-dir.ts";
import { applySwitch } from "../src/manager/acp-adapter.ts";
import { ROLLBACK, updateAdapterChoice, withAgent, readAdapterChoice } from "../src/lib/acp/codex-compat-switch.ts";
import { assertIsolatedHome } from "./codex-probe.ts";
import { inputTexts, type Reply, startFakeResponses } from "../tests/helpers/fake-responses.ts";

type Rec = Record<string, any>;
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const OUT = opt("--out") ?? (console.error("用法: bun scripts/codex-adapter-relay.ts --out <目录> [--codex <codex>] [--codex-acp <index.js>] [--npm <版本,…>] [--keep]"), process.exit(2));
const CODEX = opt("--codex") ?? Bun.which("codex");
const UPSTREAM = opt("--codex-acp") ?? join(stateDir(), "acp", "codex-acp-2.1.0", "index.js");
if (!CODEX) throw new Error("找不到 codex，用 --codex 指定");
const AGENT = "agent-relay";
/** 真 ~/.codex 的指纹：config.toml 的哈希 + sessions 目录的 mtime，实测前后必须一样（证明没碰） */
const REAL_CODEX = join(homedir(), ".codex");
const realCodexPrint = () => {
  const cfg = join(REAL_CODEX, "config.toml");
  const sessions = join(REAL_CODEX, "sessions");
  const hash = existsSync(cfg) ? new Bun.CryptoHasher("sha256").update(readFileSync(cfg)).digest("hex").slice(0, 12) : "-";
  return `${hash}/${existsSync(sessions) ? statSync(sessions).mtimeMs : "-"}`;
};
const REAL_BEFORE = realCodexPrint();
const t0 = Date.now();
const transcript: string[] = [];
const say = (m: string) => (transcript.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`), console.log(transcript.at(-1)));

function isolatedRoot(): string {
  const base = realpathSync(tmpdir());
  assertIsolatedHome(base);
  const root = mkdtempSync(join(base, "cxf-s-relay-"));
  for (const d of ["home", "codex-home", "tmp", "work", "state", "logs"]) mkdirSync(join(root, d));
  for (const d of [root, join(root, "codex-home"), join(root, "home")]) assertIsolatedHome(d);
  return root;
}

const ROOT = isolatedRoot();
const CHOICE = join(ROOT, "state", "codex-adapter.json");
const WORK = join(ROOT, "work");
let queue: Reply[] = [];
const fake = startFakeResponses((req) => {
  if (!req.path.endsWith("/responses")) return { type: "json", body: { error: "not found" }, status: 404 };
  if (inputTexts(req.body).some((t) => /short title/i.test(t))) return { type: "text", text: "Relay run" };
  return queue.shift() ?? { type: "text", text: "done" };
});
writeFileSync(join(ROOT, "codex-home", "config.toml"), [
  'model = "fake-model"', 'model_provider = "fake"', "", "[model_providers.fake]", 'name = "fake"', `base_url = "${fake.baseUrl}"`, 'wire_api = "responses"',
  "request_max_retries = 0", "stream_max_retries = 0", "",
].join("\n"));
const ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(ROOT, "home"), CODEX_HOME: join(ROOT, "codex-home"), TMPDIR: join(ROOT, "tmp"), LANG: "en_US.UTF-8",
  HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", CLAUDESTRA_AGENT: AGENT,
};
const text = (t: string): Reply => ({ type: "text", text: t });
const CMD = { upstream: [process.execPath, UPSTREAM], self: [process.execPath, CODEX_ACP_ADAPTER_MAIN] };

/** create 的引导（生产里固定走上游，runtimes/codex-acp.ts bootstrapThread）：新线程跑一轮，返回 thread id */
async function bootstrap(): Promise<string> {
  const logs: string[] = [];
  const proc = spawnAdapter(CMD.upstream, { ...ENV, CODEX_PATH: CODEX!, INITIAL_AGENT_MODE: "agent-full-access" }, WORK, (m) => logs.push(m), "bootstrap");
  const s = new AcpSession(proc.wire, { onUpdate: () => {}, onPermission: async () => null, log: (m) => logs.push(m) });
  try {
    await s.initialize();
    const sid = await s.create(WORK);
    queue = [text("noted: the code word is PINEAPPLE-7")];
    const r = await s.prompt("remember the code word PINEAPPLE-7", 60_000);
    if (r.kind !== "done") throw new Error(`引导轮没成：${JSON.stringify(r)}`);
    say(`引导（2.1.0 ${s.agentInfo?.version ?? "?"}）建线程 ${sid}`);
    return sid;
  } finally {
    proc.stop();
    await Promise.race([proc.exited, Bun.sleep(5_000)]);
  }
}

interface Leg {
  host: AcpHost;
  adapter: () => string;
  proc: () => AdapterProc | null;
  stops: StopReport[];
  sent: Rec[];
  logs: string[];
  link: { onFrame(m: Rec): void };
  ready: () => boolean;
}

/** 按开关起一个宿主（同 acp-host.ts：选适配器 → 起之前判协议 → 接不上退上游），接回 sid */
function startHost(sid: string, name: string): Leg {
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  const selected = selectedCodexAdapter(AGENT, CHOICE);
  const pick = pickCodexAdapter({ cmd: CMD[selected], adapter: selected, upstream: CMD.upstream }, CODEX!, log);
  if (!pick || "error" in pick) throw new Error(`宿主起不来：${pick?.error ?? "没选适配器"}`);
  const stops: StopReport[] = [];
  const sent: Rec[] = [];
  let link!: { onFrame(m: Rec): void };
  let proc: AdapterProc | null = null;
  let ready = false;
  const host = new AcpHost(
    {
      channelId: "relay", agentName: AGENT, sessionId: sid, cwd: WORK, mcpName: "claudestra", agentCmd: pick.cmd,
      env: { base: ENV, bunBin: process.execPath, channelServer: join(import.meta.dir, "../src/channel-server.ts"), mcpName: "claudestra", codexPath: CODEX!, logsDir: join(ROOT, "logs") },
    },
    {
      spawn: (cmd, env, cwd) => (proc = spawnAdapter(cmd, env, cwd, log, name)),
      fallback: (why, kind) => pick.fallback(why, kind),
      makeLink: (d) => {
        link = d;
        return {
          connect: () => void setTimeout(() => d.onRegistered(), 0),
          send: (f: Rec) => (sent.push(f), true),
          request: async (f: Rec) => (f.type === "acp_entries" ? true : null),
          close: () => {},
          up: true,
        } as any;
      },
      startProxy: (d) => startToolProxy(d),
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => void (ready = true),
      rotateSession: async () => ({ ok: false, error: "实测不轮换" }),
      log,
    },
  );
  host.start();
  return { host, adapter: () => pick.adapter, proc: () => proc, stops, sent, logs, link, ready: () => ready };
}

async function until(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await Bun.sleep(50);
  }
}

let msg = 0;
/** 一轮：入站一条，模型按 replies 回，等 Stop；返回这一轮发给模型的请求里看得到的全部文字 */
async function turn(leg: Leg, content: string, replies: Reply[]): Promise<{ stop: StopReport; seen: string[] }> {
  queue = [...replies];
  const from = fake.requests.length;
  const stops = leg.stops.length;
  leg.link.onFrame({ type: "message", content, meta: { chat_id: "api:owner", message_id: `m${++msg}` } });
  await until(() => leg.stops.length > stops, `「${content}」的 Stop`);
  const seen = fake.requests.slice(from).filter((r) => r.path.endsWith("/responses")).flatMap((r) => inputTexts(r.body));
  return { stop: leg.stops.at(-1)!, seen };
}

async function stopHost(leg: Leg): Promise<void> {
  const p = leg.proc();
  leg.host.stop();
  if (p) await Promise.race([p.exited, Bun.sleep(8_000)]);
}

/** 自研适配器底下的 codex app-server：适配器 pid 的子进程里命令行带 app-server 的那个 */
async function appServerPid(adapterPid: number): Promise<number | null> {
  const out = await new Response(Bun.spawn(["ps", "-ax", "-o", "pid=,ppid=,command="]).stdout).text();
  const row = out.split("\n").map((l) => l.trim().split(/\s+/)).find((c) => Number(c[1]) === adapterPid && c.slice(2).join(" ").includes("app-server"));
  return row ? Number(row[0]) : null;
}

async function crashAppServer(leg: Leg, sid: string): Promise<void> {
  const attached = () => leg.logs.filter((l) => l.includes(`已接上线程 ${sid.slice(0, 8)}`)).length;
  const before = attached();
  queue = [{ type: "hang" }];
  const stops = leg.stops.length;
  leg.link.onFrame({ type: "message", content: "(B) think for a long time", meta: { chat_id: "api:owner", message_id: `m${++msg}` } });
  await until(() => queue.length === 0, "hang 请求到了");
  await Bun.sleep(300);
  const pid = await appServerPid(leg.proc()!.pid!);
  check("找到自研底下的 app-server", pid !== null, pid);
  if (pid) process.kill(pid, "SIGKILL");
  await until(() => leg.stops.length > stops, "崩溃那一轮的 Stop");
  check("崩溃那一轮按失败收尾", leg.stops.at(-1)!.event === "StopFailure", leg.stops.at(-1)!.event);
  await until(() => attached() > before, "重起后接回", 90_000);
  check("宿主重起的还是自研（崩溃不触发退回上游）", leg.adapter() === "self", leg.logs.filter((l) => l.includes("适配器退出了")).slice(-1)[0]);
}

/** 更新闸的 npm 候选判定：每个版本一行（判定、组合身份、原因），只记录不判对错——不存在的版本本来就该是 unknown */
async function npmCandidates(versions: string[]): Promise<Rec[]> {
  const shell = async (cmd: string) => {
    const p = Bun.spawn([process.env.SHELL || "/bin/zsh", "-lc", cmd], { stdout: "pipe", stderr: "pipe" });
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: code === 0, tail: `${o}\n${e}`.trim().split("\n").slice(-3).join(" | ") };
  };
  const rows: Rec[] = [];
  for (const v of versions) {
    const at = Date.now();
    const c = await probeNpmCodexCompat(v, shell);
    rows.push({ version: v, ms: Date.now() - at, verdict: c.verdict, codexVersion: c.codexVersion, identity: c.identity, reasons: c.reasons });
    say(`npm 候选 ${v}：${c.verdict}${c.identity ? `（组合身份 ${c.identity.id}，schema ${c.identity.schema}）` : ""}${c.reasons.length ? `；${c.reasons[0]!.slice(0, 160)}` : ""}`);
  }
  return rows;
}

const results: Rec[] = [];
const check = (name: string, ok: boolean, detail: unknown = "") => {
  results.push({ name, ok, detail });
  say(`${ok ? "✅" : "❌"} ${name}${detail ? `：${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

async function main(): Promise<void> {
  const out = resolve(OUT!);
  mkdirSync(out, { recursive: true });
  const sid = await bootstrap();
  let leg = startHost(sid, "leg-A");
  await until(leg.ready, "A 就绪");
  check("A 起的是上游 2.1.0（开关缺省）", leg.adapter() === "upstream", leg.logs.find((l) => l.includes("已接上线程")));
  let r = await turn(leg, "(A) what is the code word?", [text("A: PINEAPPLE-7")]);
  check("A 一轮正常结束", r.stop.event === "Stop");
  check("A 的请求里有引导轮的历史", r.seen.some((t) => t.includes("noted: the code word is PINEAPPLE-7")));

  const deps = (l: () => Leg) => ({
    agents: async () => [{ name: AGENT, runtime: "codex", transport: "acp" }],
    running: () => l().adapter() as "upstream" | "self",
    // 同 restart 子进程在重启锁里做的（manager/acp-retire.ts → acp-host.ts 的 SIGUSR2）：宿主自己判空闲并停机，同一段同步代码；退了才重起
    restart: async () => {
      if (!l().host.retireIfIdle()) return { ok: false, deferred: "回合在跑" };
      await stopHost(l());
      leg = startHost(sid, `leg-${selectedCodexAdapter(AGENT, CHOICE)}`);
      await until(leg.ready, "重起后就绪");
      return { ok: true };
    },
    update: (change: Parameters<typeof updateAdapterChoice>[0]) => updateAdapterChoice(change, CHOICE),
    read: () => readAdapterChoice(CHOICE),
  });

  // 回合在跑时切：开关照改，不重启（deferred），回合不受影响
  queue = [{ type: "hang" }];
  leg.link.onFrame({ type: "message", content: "(A) think for a long time", meta: { chat_id: "api:owner", message_id: `m${++msg}` } });
  await until(() => fake.requests.length > 0 && queue.length === 0, "hang 请求到了");
  await Bun.sleep(300);
  const busySwitch = await applySwitch((c) => withAgent(c, AGENT, "self"), true, deps(() => leg));
  check("回合在跑时切到自研：不重启、列进 deferred", (busySwitch.deferred as Rec[]).some((d) => d.agent === AGENT) && !(busySwitch.restarted as string[]).length, busySwitch);
  const stopsBefore = leg.stops.length;
  await Bun.sleep(500);
  check("推迟期间宿主还是 2.1.0、没被重启，那一轮还在跑（没被掐）", leg.adapter() === "upstream" && leg.stops.length === stopsBefore && leg.host.loop.busy);
  leg.link.onFrame({ type: "abort", id: "relay-abort" });
  await until(() => leg.stops.length > stopsBefore, "打断后的 Stop");
  check("打断后回合收尾", leg.stops.at(-1)!.event !== undefined, leg.stops.at(-1)!.event);

  // 空闲时再切：重启到自研，接回同一线程
  const toSelf = await applySwitch((c) => withAgent(c, AGENT, "self"), true, deps(() => leg));
  check("空闲时切到自研：重启了", (toSelf.restarted as string[]).includes(AGENT), toSelf);
  check("B 起的是自研，组合身份已打进日志", leg.adapter() === "self" && leg.logs.some((l) => l.includes("组合身份")), leg.logs.find((l) => l.includes("组合身份")));
  check("B 按 session/resume 接回同一线程", leg.logs.some((l) => l.includes(`已接上线程 ${sid.slice(0, 8)}`) && l.includes("session/resume")), leg.logs.find((l) => l.includes("已接上线程")));
  r = await turn(leg, "(B) run a command then repeat the word", [{ type: "tool", name: "exec_command", args: { cmd: "echo relay-B" } }, text("B: PINEAPPLE-7")]);
  check("B 带命令的一轮正常结束", r.stop.event === "Stop");
  check("B 的请求里有 A 段和引导轮的历史", r.seen.some((t) => t.includes("A: PINEAPPLE-7")) && r.seen.some((t) => t.includes("noted: the code word")));

  // 故障竞争：自研回合中 app-server 被杀（崩溃）→ 这一轮按失败收尾，宿主重起的还是自研，接回同一线程，历史还在
  await crashAppServer(leg, sid);
  r = await turn(leg, "(B) after the crash, say the word again", [text("B2: PINEAPPLE-7")]);
  check("崩溃后自研接回，下一轮正常、历史还在", r.stop.event === "Stop" && r.seen.some((t) => t.includes("B: PINEAPPLE-7")));

  // 一条命令切回
  const back = await applySwitch(() => ROLLBACK, true, deps(() => leg));
  check("rollback 一条命令切回：重启了、开关清空", (back.restarted as string[]).includes(AGENT) && back.default === "upstream" && !Object.keys(back.overrides as Rec).length, back);
  check("C 起的是上游 2.1.0", leg.adapter() === "upstream");
  r = await turn(leg, "(C) what did B say?", [text("C: B said PINEAPPLE-7")]);
  check("C 一轮正常结束", r.stop.event === "Stop");
  check("C 的请求里有自研段的历史（含命令输出）", r.seen.some((t) => t.includes("B: PINEAPPLE-7")) && r.seen.some((t) => t.includes("relay-B")));
  await stopHost(leg);

  const rollouts = readdirSync(join(ROOT, "codex-home", "sessions"), { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
  check("CODEX_HOME 里这条线程只有一份 rollout", rollouts.filter((f) => f.includes(sid)).length === 1, rollouts);
  fake.stop();
  const npm = await npmCandidates((opt("--npm") ?? "").split(",").filter(Boolean));
  check("真 ~/.codex 没被碰（config.toml 哈希 + sessions mtime 前后一致）", realCodexPrint() === REAL_BEFORE, REAL_BEFORE);
  const ok = results.every((x) => x.ok);
  if (!argv.includes("--keep")) rmSync(ROOT, { recursive: true, force: true }); // 隔离根默认删掉（--keep 留着排查）
  writeFileSync(join(out, "relay.json"), JSON.stringify({ ok, sid, codex: CODEX, upstream: UPSTREAM, root: ROOT, results, npm, transcript }, null, 2));
  say(`${ok ? "全部通过" : "有失败"}；记录在 ${join(out, "relay.json")}`);
  process.exit(ok ? 0 : 1);
}

await main();
