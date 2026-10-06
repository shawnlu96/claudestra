#!/usr/bin/env bun
/**
 * CX-3：同一套回合分别跑 codex-acp 2.1.0 和自研适配器，录下各自发给宿主的 session/update，按宿主真实消费的形状（lib/acp/updates.ts
 * 翻出来的条目 + 线程状态 + prompt 结局）逐回合对比；顺带是自研适配器的真 CLI 冒烟（初始化、建会话、带工具调用的回合、审批、打断）。
 * 隔离：每个适配器一个 mkdtemp 根（HOME、CODEX_HOME、TMPDIR、线程 cwd 都在里面），model provider 指向只绑 127.0.0.1 的假 Responses
 * （tests/helpers/fake-responses.ts），代理指到死端口，不读真实 ~/.codex、不连生产 bridge（宿主一侧是进程内的 AcpSession）。
 * 用法：bun scripts/codex-acp-compare.ts --out <目录> [--codex <codex>] [--codex-acp <2.1.0 的 index.js>] [--only self|2.1.0]
 * 结论写在 docs/runtimes/codex-adapter.md「和 2.1.0 的差异」。
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnAdapter } from "../src/lib/acp/adapter-proc.ts";
import { CODEX_ACP_ADAPTER_MAIN } from "../src/lib/acp/codex-adapter/main.ts";
import { codexAcpInstalled } from "../src/lib/acp/install.ts";
import type { PermissionCard } from "../src/lib/acp/permissions.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import { createAcpTranslator, threadStatusOf, turnEndOf } from "../src/lib/acp/updates.ts";
import { inputTexts, type Reply, startFakeResponses, toolNames } from "../tests/helpers/fake-responses.ts";

type Rec = Record<string, any>;
const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const OUT = arg("--out");
if (!OUT) {
  console.error("用法: bun scripts/codex-acp-compare.ts --out <目录> [--codex <codex>] [--codex-acp <index.js>] [--only self|2.1.0]");
  process.exit(2);
}
const CODEX = arg("--codex") ?? Bun.which("codex");
const MODEL = arg("--model") ?? "fake-model";
const installed = codexAcpInstalled();
const UPSTREAM = arg("--codex-acp") ?? (installed.ok ? installed.path : undefined);
if (!CODEX) throw new Error("找不到 codex，用 --codex 指定");

const text = (t: string): Reply => ({ type: "text", text: t });
const exec = (cmd: string, extra: Rec = {}): Reply => ({ type: "tool", name: "exec_command", args: { cmd, ...extra } });
const PLAN = [{ step: "first", status: "completed" }, { step: "second", status: "in_progress" }];
const ESCALATE = { sandbox_permissions: "require_escalated", justification: "compare needs to write outside the workspace" };

/** 一个回合：模型依次回的 Reply（每次采样取一个，取完回 "done"）；pick = 宿主在授权卡上点哪类；cancelAfterMs = 多久后叫停 */
interface Turn {
  name: string;
  prompt: string;
  replies: Reply[];
  pick?: "allow" | "reject" | "hold";
  cancelAfterMs?: number;
}
const TURNS: Turn[] = [
  { name: "text", prompt: "say hi", replies: [text("hello there")] },
  { name: "command", prompt: "run echo", replies: [exec("echo hi"), text("ran it")] },
  { name: "read", prompt: "read the file", replies: [exec("cat a.txt"), text("read it")] },
  { name: "search", prompt: "search", replies: [exec("rg -n needle"), text("searched")] },
  { name: "list", prompt: "list files", replies: [exec("ls"), text("listed")] },
  { name: "plan", prompt: "make a plan", replies: [{ type: "tool", name: "update_plan", args: { plan: PLAN } }, text("planned")] },
  { name: "approve-allow", prompt: "write outside", replies: [exec("echo ok > ../outside-allow.txt", ESCALATE), text("allowed")], pick: "allow" },
  { name: "approve-reject", prompt: "write outside again", replies: [exec("echo no > ../outside-reject.txt", ESCALATE), text("rejected")], pick: "reject" },
  { name: "approve-cancel", prompt: "write outside, then stop", replies: [exec("echo held > ../outside-held.txt", ESCALATE), text("held")], pick: "hold", cancelAfterMs: 1_500 },
  { name: "interrupt", prompt: "think forever", replies: [{ type: "hang" }], cancelAfterMs: 1_500 },
];

/** mkdtemp 出来的新目录：不会有 auth.json；再按真实路径确认它不在真实 ~/.codex 下 */
function isolatedRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx3-compare-")));
  if ((root + sep).startsWith(join(realpathSync(homedir()), ".codex") + sep)) throw new Error(`拒绝运行：${root} 在 ~/.codex 下`);
  for (const d of ["home", "codex-home", "tmp", "work"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "work", "a.txt"), "needle in a file\n");
  return root;
}

function writeConfig(codexHome: string, baseUrl: string): void {
  const toml = [`model = "${MODEL}"`, 'model_provider = "fake"', "", "[model_providers.fake]", 'name = "fake"', `base_url = "${baseUrl}"`, 'wire_api = "responses"'];
  const tail = ["request_max_retries = 0", "stream_max_retries = 0", "", "[tools.update_plan]", "enabled = true", ""];
  writeFileSync(join(codexHome, "config.toml"), [...toml, ...tail].join("\n"));
}

/** 宿主消费到的形状：翻译器条目（去掉时间戳、id 换成序号）、线程状态、idle 上的结局 */
function consumed(updates: Rec[]): Rec {
  const tr = createAcpTranslator(() => "t", { from: "compaction-update" });
  const ids = new Map<string, string>();
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (!v || typeof v !== "object") return v;
    const o: Rec = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "timestamp") continue;
      o[k] = (k === "id" || k === "tool_use_id") && typeof x === "string" ? (ids.get(x) ?? (ids.set(x, `#${ids.size + 1}`), ids.get(x))) : norm(x);
    }
    return o;
  };
  const entries = [...updates.flatMap((u) => tr.push(u)), ...tr.flush()].map(norm);
  const statuses = updates.map(threadStatusOf).filter(Boolean);
  const ends = updates.map(turnEndOf).filter(Boolean);
  return { entries, statuses, ends };
}

async function runAdapter(label: string, cmd: string[]): Promise<Rec> {
  const root = isolatedRoot();
  let queue: Reply[] = [];
  const fake = startFakeResponses((req) => {
    if (!req.path.endsWith("/responses")) return { type: "json", body: { error: "not found" }, status: 404 };
    if (inputTexts(req.body).some((t) => /short title/i.test(t))) return text("Compare run");
    return queue.shift() ?? text("done");
  });
  writeConfig(join(root, "codex-home"), fake.baseUrl);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home"), TMPDIR: join(root, "tmp"), LANG: "en_US.UTF-8",
    CODEX_PATH: CODEX!, INITIAL_AGENT_MODE: "workspace-write",
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
  };
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  const proc = spawnAdapter(cmd, env, join(root, "work"), log, `compare-${label}`);
  const updates: Rec[] = [];
  const cards: PermissionCard[] = [];
  let pick: Turn["pick"];
  const onPermission = async (card: PermissionCard) => {
    cards.push(card);
    if (pick === "hold") return new Promise<string | null>(() => {}); // 宿主一直不答：只能靠 session/cancel 收场
    const want = pick === "allow" ? "success" : "danger";
    return card.options.find((o) => o.style === want)?.id ?? null;
  };
  const session = new AcpSession(proc.wire, { onUpdate: (u) => void updates.push(u), onPermission, log, onSelfTurn: () => {} });
  const turns: Rec[] = [];
  try {
    const caps = await session.initialize();
    await session.create(join(root, "work"));
    log(`initialize ${JSON.stringify(caps)} agentInfo=${JSON.stringify(session.agentInfo)}`);
    for (const t of TURNS) {
      queue = [...t.replies];
      pick = t.pick;
      const from = updates.length;
      const cardsFrom = cards.length;
      const timer = t.cancelAfterMs ? setTimeout(() => void session.cancel(), t.cancelAfterMs) : undefined;
      const outcome = await session.prompt(t.prompt, 60_000);
      clearTimeout(timer);
      await Bun.sleep(200);
      const slice = updates.slice(from);
      const shown = cards.slice(cardsFrom).map((c) => ({ title: c.title, detail: c.detail, options: c.options }));
      turns.push({ name: t.name, outcome, cards: shown, raw: slice, ...consumed(slice) });
    }
  } finally {
    proc.stop();
    await Promise.race([proc.exited, Bun.sleep(5_000)]);
    fake.stop();
  }
  const tools = [...new Set(fake.requests.flatMap((r) => toolNames(r.body)))];
  return { label, cmd, agentInfo: session.agentInfo, tools, turns, logs: logs.slice(-200), root };
}

async function main(): Promise<void> {
  const out = resolve(OUT!);
  mkdirSync(out, { recursive: true });
  const only = arg("--only");
  const runs: Rec[] = [];
  if (only !== "self") {
    if (!UPSTREAM) throw new Error("找不到 codex-acp 2.1.0 的入口，用 --codex-acp 指定");
    runs.push(await runAdapter("2.1.0", [process.execPath, UPSTREAM]));
  }
  if (only !== "2.1.0") runs.push(await runAdapter("self", [process.execPath, CODEX_ACP_ADAPTER_MAIN]));
  for (const r of runs) writeFileSync(join(out, `${r.label}.json`), JSON.stringify(r, null, 2));
  for (const t of TURNS) {
    const [a, b] = runs.map((r) => r.turns.find((x: Rec) => x.name === t.name));
    const same = (k: string) => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]);
    const one = () => JSON.stringify({ outcome: a?.outcome, entries: a?.entries?.length, cards: a?.cards?.length });
    const line = runs.length < 2 ? one() : ["entries", "statuses", "outcome", "cards"].map((k) => `${k}:${same(k) ? "同" : "异"}`).join(" ");
    console.log(`${t.name.padEnd(15)} ${line}`);
  }
  console.log(`记录在 ${out}`);
}

await main();
