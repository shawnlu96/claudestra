/**
 * T39：会话管理类接口只给全权凭据（isFullScope = canManage）。以前的门只查 `agents.includes("*")`，
 * scope 为 "*" 的 guest（默认 guestGrant(["*"])）和 peer 都能进：列出全部会话 id、收编 owner 的会话，
 * 或 resume takeover 把 owner 正在跑的 CC 进程 SIGTERM 掉。另两类同批收掉的：
 * - /agents/:name/answer（替 agent 批准权限弹框、回答提问）只认 owner 本人（isOwnerPrincipal）；
 * - /agents/:name/history(/:sid) 的 agent 名会拼进归档路径：%2F 解码后就是 /，能读到任意目录下的会话正文。
 *
 * 全部走真实鉴权（api-auth：Bearer / 设备 cookie），沙箱见 tests/api-runner-harness.ts，不连任何端口。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { runnerHome, type RunnerHome, type RunnerResult } from "./api-runner-harness";
import { canManage, effectivePrincipal, guestGrant, hashDeviceToken, type DeviceCredential, type Grant } from "../src/lib/devices";
import type { Principal } from "../src/lib/principals";
import { agentArchiveDir } from "../src/lib/session-archive";
import { visibleSessions, type NeutralSessionInfo } from "../src/bridge/sessions-inventory";

const at = "2026-01-01T00:00:00Z";
const device = (id: string, grant: Grant): DeviceCredential => ({
  id: `dev_${id}`, v: 1, type: "bearer", hash: hashDeviceToken(`dev_${id}`), deviceName: id, grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z",
});
const OWNER_GRANT: Grant = { agents: ["*", "master"], terminal: false, manage: true };
const token = (id: string, agents: string[], extra: Partial<Principal> = {}): Principal =>
  ({ id: `token:tok_${id}`, role: "external", name: id, agents, secret: `s-${id}`, createdAt: at, ...extra }) as Principal;

const OWNER = {
  id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], createdAt: at,
  credentials: [
    device("owner", OWNER_GRANT),
    device("owner_nomanage", { ...OWNER_GRANT, manage: false }),
    device("owner_cc", { agents: ["cc"], terminal: false, manage: true }),
  ],
} as Principal;
const GUEST_ALL = { id: "guest:all", role: "external", name: "friend", agents: ["*"], createdAt: at, credentials: [device("guest_all", guestGrant(["*"]))] } as Principal;
const GUEST_CC = { id: "guest:cc", role: "external", name: "friend2", agents: ["cc"], createdAt: at, credentials: [device("guest_cc", guestGrant(["cc"]))] } as Principal;
const WEBUI = token("webui", ["*", "master"], { name: "web-ui" });
const CC_ONLY = token("cc_only", ["cc"]);
const PEER_ALL = token("peer_all", ["*"], { peer: "alex" });
const PEER_CC = token("peer_cc", ["cc"], { peer: "alex" });
const PRINCIPALS = [OWNER, GUEST_ALL, GUEST_CC, WEBUI, CC_ONLY, PEER_ALL, PEER_CC];

const viaDevice = (p: Principal, i: number) => effectivePrincipal({ principal: p, credential: p.credentials![i] });

/** 名字 → 请求凭据 + 鉴权后的 principal（纯函数断言用） */
const CREDS: Record<string, { auth: { device?: string; bearer?: string }; p: Principal }> = {
  "owner 设备": { auth: { device: "dev_owner" }, p: viaDevice(OWNER, 0) },
  "owner 设备 manage=false": { auth: { device: "dev_owner_nomanage" }, p: viaDevice(OWNER, 1) },
  "owner 设备 部分 scope（manage=true）": { auth: { device: "dev_owner_cc" }, p: viaDevice(OWNER, 2) },
  "guest *": { auth: { device: "dev_guest_all" }, p: viaDevice(GUEST_ALL, 0) },
  "guest 部分 scope": { auth: { device: "dev_guest_cc" }, p: viaDevice(GUEST_CC, 0) },
  "老的 * Bearer（web-ui）": { auth: { bearer: "s-webui" }, p: WEBUI },
  "scoped token": { auth: { bearer: "s-cc_only" }, p: CC_ONLY },
  "peer *": { auth: { bearer: "s-peer_all" }, p: PEER_ALL },
  "peer 部分 scope": { auth: { bearer: "s-peer_cc" }, p: PEER_CC },
};
/** 全权（isFullScope）：会话管理类接口只放这两种 */
const ALLOWED = new Set(["owner 设备", "老的 * Bearer（web-ui）"]);
/** 以 owner 名义拍板的接口（/answer）只认 owner 本人（isOwnerPrincipal）：owner 的其它设备也算，老 web-ui token 过渡期也算 */
const OWNER_ONLY = new Set(["owner 设备", "owner 设备 manage=false", "owner 设备 部分 scope（manage=true）", "老的 * Bearer（web-ui）"]);

type Endpoint = { method: string; path: string; body?: string; ok: number[]; owner?: true; error?: string; probes?: true };
const ENDPOINTS: Record<string, Endpoint> = {
  "session-list": { method: "GET", path: "/api/v1/session-list", ok: [200] },
  runtimes: { method: "GET", path: "/api/v1/runtimes", ok: [200] },
  // 空 body 过了门就是 400：能走到参数校验 = 门放行了
  resume: { method: "POST", path: "/api/v1/agents/resume", body: "{}", ok: [400] },
  // 过了门以后假 tmux 抓不到屏：409 / 502 都说明走到了门后面
  clear: { method: "POST", path: "/api/v1/agents/cc/clear", body: "{}", ok: [409, 502] },
  // 切模型 / effort 会注入 TUI：过了门以后假 tmux 抓屏为空 → 判成忙，409「正在回合中」
  "claude-settings": { method: "POST", path: "/api/v1/agents/cc/claude-settings", body: JSON.stringify({ effort: "high" }), ok: [409] },
  // 过了门就会真去探本机网络（fetch 3847、tailscale status、lsof）：放行的格子不发请求，只断言门的判定（见纯函数用例）
  "remote-access": { method: "GET", path: "/api/v1/remote-access", ok: [], probes: true },
  // 替 agent 批准权限弹框：过了门以后假 tmux 抓不到弹框 → 409「permission dialog no longer active」
  answer: {
    method: "POST", path: "/api/v1/agents/cc/answer", body: JSON.stringify({ kind: "permission", action: "allow" }), ok: [409],
    owner: true, error: "answering requires the owner's own credential",
  },
};
const allows = (e: Endpoint, cred: string) => (e.owner ? OWNER_ONLY : ALLOWED).has(cred);

// 路径穿越：野生会话（owner 终端里手敲的 CC）和 master 的归档，都不属于任何 scope 内的 agent
const SID = "11111111-2222-3333-4444-555555555555";
const SECRET = "OWNER-WILD-SECRET";
const TRAVERSALS = (home: string) => {
  const wild = join(home, ".claude", "projects", "-Users-owner-secret");
  return {
    "%2F.. 逃出归档根": `agent-x/${"../".repeat(40)}${wild.slice(1)}`,
    绝对路径: wild,
    "agent-x/../master": "agent-x/../master",
    反斜杠: "agent-x\\..\\master",
    "..": "..",
    // 编码两次：解码一次后是字面的「%2F」，不是分隔符——当成一个不存在的目录名，读不到任何东西
    编码两次: `agent-x%2F${"..%2F".repeat(40)}${encodeURIComponent(wild.slice(1))}`,
  };
};
const TRAV_CREDS = ["guest *", "peer *", "owner 设备"];

let sandbox: RunnerHome | null = null;
let results: RunnerResult[] = [];
const byName = (n: string) => results.find((x) => x.name === n)!;

beforeAll(() => {
  sandbox = runnerHome("session-gates-", { agents: { "agent-cc": { channelId: "api:cc", status: "stopped", cwd: "/tmp/x" } } });
  const line = JSON.stringify({ type: "user", uuid: "u1", timestamp: at, message: { role: "user", content: SECRET } }) + "\n";
  for (const dir of [join(sandbox.home, ".claude", "projects", "-Users-owner-secret"), join(sandbox.home, ".claude-orchestrator", "archive", "master")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID}.jsonl`), line);
  }
  const specs: { name: string; method: string; path: string; body?: string; auth: object }[] = [];
  for (const [cred, { auth }] of Object.entries(CREDS)) {
    for (const [ep, e] of Object.entries(ENDPOINTS)) {
      if (!(e.probes && allows(e, cred))) specs.push({ name: `${cred} ${ep}`, method: e.method, path: e.path, body: e.body, auth });
    }
  }
  for (const [k, name] of Object.entries(TRAVERSALS(sandbox.home))) {
    const base = `/api/v1/agents/${encodeURIComponent(name).replaceAll(".", "%2E")}/history`;
    for (const cred of TRAV_CREDS) {
      specs.push({ name: `trav ${cred} ${k} list`, method: "GET", path: base, auth: CREDS[cred].auth });
      specs.push({ name: `trav ${cred} ${k} read`, method: "GET", path: `${base}/${SID}`, auth: CREDS[cred].auth });
    }
  }
  results = sandbox.run(specs, { RUNNER_PRINCIPALS: JSON.stringify(PRINCIPALS) });
}, 120_000);

afterAll(() => sandbox?.cleanup());

describe("权限矩阵：九种凭据 × 会话管理类接口（另加只认 owner 本人的 /answer）", () => {
  for (const cred of Object.keys(CREDS)) {
    test(cred, () => {
      for (const [ep, e] of Object.entries(ENDPOINTS)) {
        if (e.probes && allows(e, cred)) continue; // 放行的格子不真去探网络，门的判定由下一个用例断言
        const r = byName(`${cred} ${ep}`);
        if (!allows(e, cred)) {
          expect([ep, r.status, JSON.parse(r.body!).error]).toEqual([ep, 403, e.error ?? `${ep} requires a full-scope token`]);
        } else {
          expect([ep, e.ok.includes(r.status!) ? "ok" : `${r.status} ${r.body}`]).toEqual([ep, "ok"]);
        }
      }
    });
  }

  test("全权门（isFullScope = canManage）逐一对上：只有 owner 全权设备和老的 * Bearer", () => {
    for (const [cred, { p }] of Object.entries(CREDS)) expect([cred, canManage(p)]).toEqual([cred, ALLOWED.has(cred)]);
  });
});

describe("历史接口的路径穿越（agent 名 %2F 解码后会拼进归档路径）", () => {
  test("guest *、peer *，连 owner 本人也一样：挡在门外，读不到 scope 外的会话正文", () => {
    for (const k of Object.keys(TRAVERSALS("/h"))) {
      for (const cred of TRAV_CREDS) {
        for (const op of ["list", "read"]) {
          const r = byName(`trav ${cred} ${k} ${op}`);
          // 单独的「..」（连 %2E%2E 也是）会被 URL 解析当成上一级目录规范化掉，请求到不了这个路由 → 404；
          // 编码两次的名字里没有分隔符，过得了门，但只是一个不存在的 agent → 404
          const want = k === ".." || k === "编码两次" ? 404 : 403;
          expect(`${k} ${cred} ${op} ${r.status} ${String(r.body).includes(SECRET)}`).toBe(`${k} ${cred} ${op} ${want} false`);
        }
      }
    }
  });

  test("agentArchiveDir：只认归档根下的单层目录", () => {
    expect(agentArchiveDir("agent-cc", "/r/archive")).toBe("/r/archive/agent-cc");
    for (const n of ["agent-x/../master", "../x", "..", ".", "/etc", "a/b", "agent-x/../../../h/.claude/projects/p", ""]) {
      expect([n, agentArchiveDir(n, "/r/archive")]).toEqual([n, null]);
    }
  });
});

describe("GET /sessions 的可见范围（visibleSessions）", () => {
  const list: NeutralSessionInfo[] = [
    { kind: "interactive", sessionId: "s-cc", status: "running", registeredAgent: "agent-cc" },
    { kind: "background", sessionId: "s-dopp", status: "running", doppelgangerOf: "agent-cc" },
    { kind: "interactive", sessionId: "s-wild", status: "running", cwd: "/Users/owner/secret" },
  ];
  const ids = (p: Principal) => visibleSessions(list, p).map((s) => s.sessionId);

  test("全权凭据看全部，含野生会话；其余只看 scope 内 agent 的正式会话及其分身", () => {
    for (const [cred, { p }] of Object.entries(CREDS)) {
      expect([cred, ids(p)]).toEqual([cred, ALLOWED.has(cred) ? ["s-cc", "s-dopp", "s-wild"] : ["s-cc", "s-dopp"]]);
    }
  });
});
