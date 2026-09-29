/**
 * "*" 不含 master：凡是按名字解析 agent 的地方，master 判定都走 isMasterName（src/lib/registry.ts：规范名 → 去空白 →
 * 去掉所有层 agent- 前缀 → master，__master__ 也算）。判定只要比路由解析「窄」一处，"*" 就能从那里碰到 master：
 * - 以前 "agent-master" 加前缀成 "agent-agent-master" 就不算 master，guest "*" 能读历史、打断 master（热修 #182）；
 * - "Master" 在 scope 判定里是普通 agent，history 拼出 archive/agent-Master，APFS 不分大小写，读到 master 的归档（HF182-r1 P1-1）；
 * - /agents/--include-master/restart：manager 把名字当成开关，全体重启连同 master（P1-2）；
 * - /sessions/:sid/history、manage 只有全权门，老 "*" Bearer 按 id 读 / 删 master 的会话（P2-3）。
 * 走真实鉴权（沙箱见 tests/api-runner-harness.ts）；manager 的 restart 解析另起子进程，tmux 是假的。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runnerHome, type RunnerHome, type RunnerResult } from "./api-runner-harness";
import { guestGrant, hashDeviceToken, type DeviceCredential, type Grant } from "../src/lib/devices";
import { inScopeEitherName } from "../src/bridge/api-respond";
import { terminalAllowedFor } from "../src/bridge/terminal-auth";
import { visibleSessions, type NeutralSessionInfo } from "../src/bridge/sessions-inventory";
import { projectsSlug } from "../src/lib/jsonl-cost";
import { isMasterName } from "../src/lib/registry";
import type { Principal } from "../src/lib/principals";

const at = "2026-01-01T00:00:00Z";
const device = (id: string, grant: Grant): DeviceCredential => ({
  id: `dev_${id}`, v: 1, type: "bearer", hash: hashDeviceToken(`dev_${id}`), deviceName: id, grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z",
});
const PRINCIPALS = [
  { id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], createdAt: at, credentials: [device("owner", { agents: ["*", "master"], terminal: false, manage: true })] },
  { id: "guest:all", role: "external", name: "friend", agents: ["*"], createdAt: at, credentials: [device("guest", guestGrant(["*"]))] },
  { id: "token:tok_star", role: "external", name: "legacy-star", agents: ["*"], secret: "s-star", createdAt: at },
  { id: "token:tok_cc", role: "external", name: "cc-only", agents: ["cc"], secret: "s-cc", createdAt: at },
  // 老版本（大总管只认逐字写法）签出的 guest：--agents MASTER,cc 把 MASTER 当普通名字写进了 principal 和 grant（T42-r2 P1）
  { id: "guest:legacy", role: "external", name: "legacy", agents: ["MASTER", "cc"], createdAt: at, credentials: [device("legacy", { agents: ["MASTER", "cc"], terminal: false, manage: false })] },
];
const OWNER = { device: "dev_owner" };
const STAR = { bearer: "s-star" };
const CREDS = { "guest *": { device: "dev_guest" }, "老 * Bearer": STAR, "scoped token": { bearer: "s-cc" }, "老 guest [MASTER]": { device: "dev_legacy" } };
// 全角 ｍ（U+FF4D）、全角大写整词经 NFKC 都变回 master
const MASTER_NAMES = ["master", "agent-master", "agent-agent-master", "__master__", "Master", "MASTER", "agent-Master", "AGENT-master", "ｍaster", "ＭＡＳＴＥＲ"];
const SID_AM = "11111111-2222-3333-4444-555555555555"; // archive/agent-master 里的 master 归档
const SID_G = "22222222-3333-4444-5555-666666666666"; // 被 remove 的 agent-gone 的归档
const SID_MS = "33333333-4444-5555-6666-777777777777"; // 大总管工作目录下的 CC 会话
const SID_W = "44444444-5555-6666-7777-888888888888"; // 别处的野生会话
const ENDPOINTS: [string, string, string?][] = [
  ["GET", "history"], ["GET", `history/${SID_AM}`], ["GET", "skills"], ["GET", "pending"],
  ["POST", "interrupt", "{}"], ["POST", "messages", JSON.stringify({ text: "hi" })], ["POST", "notify-read", "{}"],
  ["POST", "claude-settings", JSON.stringify({ effort: "high" })], ["POST", "clear", "{}"],
];
const line = (text: string) => JSON.stringify({ type: "user", uuid: "u1", timestamp: at, message: { role: "user", content: text } }) + "\n";

let sandbox: RunnerHome | null = null;
let results: RunnerResult[] = [];
let masterDir = "";

beforeAll(() => {
  // master 也放进假 manager 的 list：否则 agent-master 解析不到人，回 404 看不出门放没放行
  const agents = { "agent-cc": { channelId: "api:cc", status: "stopped", cwd: "/tmp/x" }, master: { channelId: "api:master", status: "stopped", cwd: "/tmp/m" } };
  sandbox = runnerHome("api-master-scope-", { agents });
  const { home } = sandbox;
  const archive = join(home, ".claude-orchestrator", "archive");
  for (const [dir, sid, text] of [["agent-master", SID_AM, "MASTER-ARCHIVE-SECRET"], ["agent-gone", SID_G, "gone 的会话"]]) {
    mkdirSync(join(archive, dir), { recursive: true });
    writeFileSync(join(archive, dir, `${sid}.jsonl`), line(text));
  }
  // 归档根下的链接：指到根外的目录、指到 master 的归档目录，都不能当成被 remove 的 agent 来读
  mkdirSync(join(home, "outside"));
  writeFileSync(join(home, "outside", `${SID_G}.jsonl`), line("OUTSIDE-SECRET"));
  symlinkSync(join(home, "outside"), join(archive, "agent-evil"));
  symlinkSync(join(archive, "agent-master"), join(archive, "agent-alias"));
  masterDir = join(home, "masterdir");
  mkdirSync(masterDir);
  for (const [cwd, sid, text] of [[masterDir, SID_MS, "MASTER-LIVE-SECRET"], ["/tmp/wild", SID_W, "野生会话"]]) {
    const dir = join(home, ".claude", "projects", projectsSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.jsonl`), line(text));
  }
  const at_ = (name: string) => `/api/v1/agents/${encodeURIComponent(name)}`;
  const req = (name: string, method: string, path: string, auth: object, body?: string) => ({ name, method, path, auth, body });
  const specs = [
    ...Object.entries(CREDS).flatMap(([cred, auth]) =>
      MASTER_NAMES.flatMap((n) => ENDPOINTS.map(([method, ep, body]) => req(`${cred} ${n} ${ep}`, method, `${at_(n)}/${ep}`, auth, body))),
    ),
    req("owner agent-master pending", "GET", `${at_("agent-master")}/pending`, OWNER),
    req("owner master history", "GET", `${at_("master")}/history`, OWNER),
    req("老 guest [MASTER] cc pending", "GET", `${at_("cc")}/pending`, CREDS["老 guest [MASTER]"]),
    req("guest cc pending", "GET", `${at_("cc")}/pending`, CREDS["guest *"]),
    req("guest agent-cc pending", "GET", `${at_("agent-cc")}/pending`, CREDS["guest *"]),
    // registry 查不到：只认逐字同名的归档目录（被 remove 的 agent 照常读；大小写写法、master 不认）
    req("owner Master history", "GET", `${at_("Master")}/history`, OWNER),
    req("owner Master history sid", "GET", `${at_("Master")}/history/${SID_AM}`, OWNER),
    req("guest gone history", "GET", `${at_("gone")}/history`, CREDS["guest *"]),
    req("guest gone history sid", "GET", `${at_("gone")}/history/${SID_G}`, CREDS["guest *"]),
    req("guest Gone history", "GET", `${at_("Gone")}/history`, CREDS["guest *"]),
    req("guest evil history", "GET", `${at_("evil")}/history/${SID_G}`, CREDS["guest *"]),
    req("guest alias history", "GET", `${at_("alias")}/history/${SID_AM}`, CREDS["guest *"]),
    // lifecycle
    ...["--include-master", "-x"].map((n) => req(`star lifecycle ${n}`, "POST", `${at_(n)}/restart`, STAR, "{}")),
    ...["Master", "agent-agent-master", "ＭＡＳＴＥＲ"].flatMap((n) => ["restart", "kill", "remove"].map((op) => req(`star ${op} ${n}`, "POST", `${at_(n)}/${op}`, STAR, "{}"))),
    req("star restart cc", "POST", `${at_("cc")}/restart`, STAR, "{}"),
    req("scoped restart other", "POST", `${at_("other")}/restart`, { bearer: "s-cc" }, "{}"),
    // archive / agent-info
    ...["Master", "agent-Master", "ｍaster"].map((n) => req(`star archive ${n}`, "POST", `${at_(n)}/archive`, STAR, "{}")),
    ...["agent-agent-master", "Master", "__master__"].map((n) => req(`star info ${n}`, "GET", `${at_(n)}/info`, STAR)),
    // 按会话 id
    req("star master session", "GET", `/api/v1/sessions/${SID_MS}/history`, STAR),
    req("owner master session", "GET", `/api/v1/sessions/${SID_MS}/history`, OWNER),
    req("star wild session", "GET", `/api/v1/sessions/${SID_W}/history`, STAR),
    req("star delete master session", "POST", `/api/v1/sessions/${SID_MS}/manage`, STAR, JSON.stringify({ action: "delete" })),
  ];
  results = sandbox.run(specs, { RUNNER_PRINCIPALS: JSON.stringify(PRINCIPALS), MASTER_DIR: masterDir });
}, 120_000);

afterAll(() => sandbox?.cleanup());

const byName = (n: string) => results.find((r) => r.name === n)!;
const status = (n: string) => byName(n).status;
const leaks = (n: string) => /MASTER-(ARCHIVE|LIVE)-SECRET/.test(String(byName(n).body));

describe("master 的各种写法（含大小写、全角）：生产路由 + 假 tmux", () => {
  test("guest * / 老 * Bearer / scoped token / 名单写了 MASTER 的老 guest × 10 种写法 × 9 个端点：一律 403，正文不外泄", () => {
    const creds = Object.keys(CREDS);
    const matrix = results.filter((r) => MASTER_NAMES.some((n) => creds.some((c) => r.name.startsWith(`${c} ${n} `))));
    expect(matrix.length).toBe(creds.length * MASTER_NAMES.length * ENDPOINTS.length);
    expect(matrix.filter((r) => r.status !== 403 || leaks(r.name)).map((r) => `${r.name} → ${r.status}`)).toEqual([]);
  });

  test("scope 显式列了 master 的 owner 设备照常能用 agent-master 写法；普通 agent 两种写法照常放行", () => {
    expect(status("owner agent-master pending")).toBe(200);
    expect(status("owner master history")).toBe(200);
    expect(status("老 guest [MASTER] cc pending")).toBe(200); // 老 guest 的 MASTER 条目作废（上面矩阵读 master 全 403），开放的 cc 照常
    expect(status("guest cc pending")).toBe(200);
    expect(status("guest agent-cc pending")).toBe(200);
  });
});

describe("history：registry 查不到时只认逐字同名的归档目录", () => {
  test("Master（APFS 上就是 agent-master 的目录）：连 owner 也 404，读不到 master 的归档", () => {
    for (const n of ["owner Master history", "owner Master history sid"]) expect([n, status(n), leaks(n)]).toEqual([n, 404, false]);
  });
  test("remove 之后按名字读历史照常（registry 里没有、归档还在）；换了大小写的写法 404", () => {
    expect(status("guest gone history")).toBe(200);
    expect(String(byName("guest gone history sid").body)).toContain("gone 的会话");
    expect(status("guest Gone history")).toBe(404);
  });
  test("归档根下的链接：指到根外、指到 master 的归档目录 → 404，读不到内容", () => {
    expect([status("guest evil history"), String(byName("guest evil history").body).includes("OUTSIDE-SECRET")]).toEqual([404, false]);
    expect([status("guest alias history"), leaks("guest alias history")]).toEqual([404, false]);
  });
});

describe("lifecycle（restart / kill / remove）", () => {
  test("以 - 开头的名字 400：--include-master 当名字传不进 manager", () => {
    for (const n of ["--include-master", "-x"]) expect([n, status(`star lifecycle ${n}`)]).toEqual([n, 400]);
  });
  test("master 的各种写法 400（由 launcher 守护）", () => {
    for (const n of ["Master", "agent-agent-master", "ＭＡＳＴＥＲ"]) {
      for (const op of ["restart", "kill", "remove"]) expect([op, n, status(`star ${op} ${n}`)]).toEqual([op, n, 400]);
    }
  });
  test("普通 agent 照常走到 manager；scope 外的 403", () => {
    expect(status("star restart cc")).toBe(200);
    expect(status("scoped restart other")).toBe(403);
  });
});

describe("archive / agent-info", () => {
  test("archive：master 的写法都挡住，不建标记目录（否则 master 从 owner 的侧栏消失）", () => {
    for (const n of ["Master", "agent-Master", "ｍaster"]) expect([n, status(`star archive ${n}`)]).toEqual([n, 403]);
    const marks = join(sandbox!.home, ".claude-orchestrator", "archive", "archived");
    for (const n of ["Master", "master", "agent-Master"]) expect([n, existsSync(join(marks, n))]).toEqual([n, false]);
  });
  test("agent-info：master 的写法 400，不去 registry 找历史条目 agent-master", () => {
    for (const n of ["agent-agent-master", "Master", "__master__"]) expect([n, status(`star info ${n}`)]).toEqual([n, 400]);
  });
});

describe("按会话 id：大总管的会话只给显式列了 master 的凭据或 owner 本人", () => {
  test("老 * Bearer 读 / 删 master 工作目录下的会话 → 403，文件还在；owner 照读；别处的野生会话照常", () => {
    expect([status("star master session"), leaks("star master session")]).toEqual([403, false]);
    expect(status("star delete master session")).toBe(403);
    expect(existsSync(join(sandbox!.home, ".claude", "projects", projectsSlug(masterDir), `${SID_MS}.jsonl`))).toBe(true);
    expect([status("owner master session"), leaks("owner master session")]).toEqual([200, true]);
    expect(status("star wild session")).toBe(200);
  });

  test("GET /sessions（visibleSessions）：master 的会话不把 id 递给老 * Bearer", () => {
    const p = (agents: string[], extra: Partial<Principal> = {}): Principal => ({ id: "token:x", role: "external", name: "x", agents, createdAt: at, secret: "s", ...extra });
    const list: NeutralSessionInfo[] = [
      { kind: "interactive", sessionId: "s-cc", status: "running", registeredAgent: "agent-cc" },
      { kind: "interactive", sessionId: "s-am", status: "running", registeredAgent: "agent-master" },
      { kind: "background", sessionId: "s-dopp", status: "running", doppelgangerOf: "master" },
      { kind: "interactive", sessionId: "s-mdir", status: "running", cwd: "/r/m" },
      { kind: "interactive", sessionId: "s-wild", status: "running", cwd: "/r/other" },
    ];
    const ids = (q: Principal) => visibleSessions(list, q, "/r/m").map((s) => s.sessionId);
    expect(ids(p(["*"]))).toEqual(["s-cc", "s-wild"]);
    expect(ids(p(["*", "master"]))).toEqual(["s-cc", "s-am", "s-dopp", "s-mdir", "s-wild"]);
    expect(ids(p(["*"], { id: "owner:self" }))).toEqual(["s-cc", "s-am", "s-dopp", "s-mdir", "s-wild"]);
  });
});

describe("isMasterName / inScopeEitherName / terminalAllowedFor（纯函数）", () => {
  const p = (agents: string[], extra: Partial<Principal> = {}): Principal => ({ id: "token:x", role: "external", name: "x", agents, createdAt: at, secret: "s", ...extra });
  test("isMasterName：大小写、全角、多层前缀、__master__、夹不可见字符或空白都算；名字里带 master 的普通 agent 不算", () => {
    for (const n of [...MASTER_NAMES, "__MASTER__", "agent-__master__", "Agent-Agent-MASTER"]) expect([n, isMasterName(n)]).toEqual([n, true]);
    // 零宽 / 变体选择符 / 空白：路由按逐字解析落不到 master，但判定只能宽不能窄——宽了只是多挡一个本来就 404 的名字（T42-r2）
    for (const n of ["m\u200baster", "master\ufe0f", "master\u3164", " master ", "agent- master ", "agent-\u200bmaster"]) expect([n, isMasterName(n)]).toEqual([n, true]);
    for (const n of ["mastermind", "agent-masters", "master2", "", undefined, null]) expect([n, isMasterName(n)]).toEqual([n, false]);
  });
  test("inScopeEitherName：master 的写法只按 master 判；显式列 master 才放行", () => {
    for (const n of MASTER_NAMES) {
      for (const agents of [["*"], ["cc"], ["__master__"]]) expect([n, agents, inScopeEitherName(p(agents), n)]).toEqual([n, agents, false]);
      for (const agents of [["*", "master"], ["agent-master"]]) expect([n, agents, inScopeEitherName(p(agents), n)]).toEqual([n, agents, true]);
    }
    expect(inScopeEitherName(p(["*"]), "cc")).toBe(true);
    expect(inScopeEitherName(p(["*"]), "agent-cc")).toBe(true);
    expect(inScopeEitherName(p(["agent-cc"]), "cc")).toBe(true);
    expect(inScopeEitherName(p(["cc"]), "agent-cc")).toBe(true);
    expect(inScopeEitherName(p(["cc"]), "other")).toBe(false);
    expect(inScopeEitherName(p(["*"]), "mastermind")).toBe(true);
    for (const n of [" master ", "agent- master ", "m\u200baster"]) expect([n, inScopeEitherName(p(["*"]), n)]).toEqual([n, false]);
  });
  test("terminalAllowedFor：* + 终端权限开不了 master 的任何写法；普通 agent 照常", () => {
    const t = p(["*"], { terminal: true });
    for (const n of MASTER_NAMES) expect([n, terminalAllowedFor(t, n)]).toEqual([n, false]);
    expect(terminalAllowedFor(t, "cc")).toBe(true);
    expect(terminalAllowedFor(p(["*", "master"], { terminal: true }), "agent-master")).toBe(true);
  });
});

describe("manager restart：--include-master 只认命令行里本来就有的", () => {
  let home = "";
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "restart-parse-"));
    mkdirSync(join(home, "fakebin"));
    mkdirSync(join(home, ".claude-orchestrator"));
    writeFileSync(join(home, "fakebin", "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "tmux.log")}'\nexit 1\n`, { mode: 0o755 });
    // 历史条目 agent-master：按名字重启会把它拉成 master 会话上的分身
    const reg = { agents: { "agent-master": { channelId: "c", status: "active", cwd: "/tmp", sessionId: SID_AM } } };
    writeFileSync(join(home, ".claude-orchestrator", "registry.json"), JSON.stringify(reg));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const manager = (...args: string[]) => {
    const env = { PATH: `${join(home, "fakebin")}:/usr/bin:/bin`, HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "rt"), CONTROL_CHANNEL_ID: "", LANG: "C" };
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "manager.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    return JSON.parse(r.stdout.toString().trim().split("\n").pop() || "{}") as { ok: boolean; error?: string };
  };

  test("`restart -- --include-master`：-- 之后只当名字，不会全体重启连同 master", () => {
    const r = manager("restart", "--", "--include-master");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不存在");
  });
  test("按名字重启 master 的任何写法都拒（历史条目 agent-master 不会被拉起）", () => {
    for (const n of ["master", "Master", "agent-master", "agent-Master"]) {
      expect([n, manager("restart", n)]).toEqual([n, { ok: false, error: "大总管由 launcher 守护：要重启它用 restart --include-master" }]);
      expect([n, manager("restart", "--", n).ok]).toEqual([n, false]);
    }
    expect(existsSync(join(home, "tmux.log")) ? readFileSync(join(home, "tmux.log"), "utf8") : "").not.toContain("new-window");
  });
  test("原有写法不变：`restart --include-master x` 仍报「只能用于全体重启」", () => {
    expect(manager("restart", "--include-master", "x")).toEqual({ ok: false, error: "--include-master 只能用于全体重启（不要同时指定 agent 名）" });
  });
});
