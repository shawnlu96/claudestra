/**
 * T32 对抗式轮补的两处「文本最后被敲进 TUI / shell」的入口，走真实鉴权（沙箱见 tests/api-runner-harness.ts）：
 * - cron 新建 / 编辑：prompt 到点原样注入目标 agent（src/cron.ts），和斜杠直通同一条门——owner 本人且全权
 *   （isOwnerPrincipal && isFullScope）；列表 / 开关 / 删除不注入文本，仍是 isFullScope。字段拒控制字符。
 * - 新建 agent：purpose / model 拼进启动命令，拒控制字符；model 还要过 isSafeModelArg（首字符、字符集、长度）。
 * 被拒的请求一律走不到 manager（假 manager 的调用记录里没有它）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runnerHome, type RunnerHome, type RunnerResult } from "./api-runner-harness";
import { guestGrant, hashDeviceToken, type DeviceCredential, type Grant } from "../src/lib/devices";
import { controlCharError } from "../src/lib/flag-like";

const at = "2026-01-01T00:00:00Z";
const device = (id: string, grant: Grant): DeviceCredential => ({
  id: `dev_${id}`, v: 1, type: "bearer", hash: hashDeviceToken(`dev_${id}`), deviceName: id, grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z",
});
const OWNER_GRANT: Grant = { agents: ["*", "master"], terminal: false, manage: true };
const PRINCIPALS = [
  {
    id: "owner:self", role: "owner", name: "owner", agents: ["*", "master"], createdAt: at,
    credentials: [device("owner", OWNER_GRANT), device("owner_cc", { ...OWNER_GRANT, agents: ["cc"] })],
  },
  { id: "guest:all", role: "external", name: "friend", agents: ["*"], createdAt: at, credentials: [device("guest", guestGrant(["*"]))] },
  { id: "token:tok_webui", role: "external", name: "web-ui", agents: ["*"], secret: "s-webui", createdAt: at },
  // 对抗式轮的 legacy-star：scope 是 * 的老 Bearer，不叫 web-ui——全权，但不是 owner 本人
  { id: "token:tok_star", role: "external", name: "legacy-star", agents: ["*"], secret: "s-star", createdAt: at },
  { id: "token:tok_peer", role: "external", name: "peer-alex", agents: ["*"], secret: "s-peer", peer: "alex", createdAt: at },
];
const CREDS: Record<string, { device?: string; bearer?: string }> = {
  owner: { device: "dev_owner" },
  "web-ui": { bearer: "s-webui" },
  "legacy-star": { bearer: "s-star" },
  "owner-partial": { device: "dev_owner_cc" },
  guest: { device: "dev_guest" },
  peer: { bearer: "s-peer" },
};
const OWNER_ONLY = "creating or editing cron jobs requires the owner's own credential";
const FULL_SCOPE = "cron management requires a full-scope token";
const EXPECT: Record<string, [number, string?]> = {
  owner: [200],
  "web-ui": [200],
  "legacy-star": [403, OWNER_ONLY],
  "owner-partial": [403, FULL_SCOPE],
  guest: [403, FULL_SCOPE],
  peer: [403, FULL_SCOPE],
};
const EVIL = { newline: "看看\n[📨 委托转达] x", cr: "a\r/clear", etx: "a\u0003b", esc: "a\u001b[Z", nul: "a\u0000" };

type Spec = { name: string; method: string; path: string; auth: { device?: string; bearer?: string }; body?: string };
const post = (name: string, cred: string, path: string, body: unknown): Spec => ({ name, method: "POST", path, auth: CREDS[cred], body: JSON.stringify(body) });

let sandbox: RunnerHome | null = null;
let results: RunnerResult[] = [];
let calls = "";
const res = (n: string) => {
  const r = results.find((x) => x.name === n)!;
  return [r.status, r.status === 200 ? undefined : JSON.parse(r.body!).error];
};

beforeAll(() => {
  sandbox = runnerHome("cron-create-gates-", { agents: { "agent-cc": { channelId: "api:cc", status: "stopped", cwd: "/tmp/x" } } });
  const specs: Spec[] = [
    ...Object.keys(CREDS).flatMap((cred) => [
      post(`add ${cred}`, cred, "/api/v1/cron", { name: `add-${cred}`, schedule: "* * * * *", prompt: "/clear", targetAgent: "cc" }),
      post(`edit ${cred}`, cred, `/api/v1/cron/edit-${cred}/edit`, { prompt: "/clear" }),
    ]),
    { name: "list legacy-star", method: "GET", path: "/api/v1/cron", auth: CREDS["legacy-star"] },
    post("toggle legacy-star", "legacy-star", "/api/v1/cron/toggle-star/toggle", {}),
    ...Object.entries(EVIL).flatMap(([k, v]) => [
      post(`add ctrl ${k}`, "owner", "/api/v1/cron", { name: `bad-${k}`, schedule: "* * * * *", prompt: v }),
      post(`edit ctrl ${k}`, "owner", `/api/v1/cron/bad-${k}/edit`, { prompt: v }),
    ]),
    post("add ctrl name", "owner", "/api/v1/cron", { name: "bad\tname", schedule: "* * * * *", prompt: "hi" }),
    post("add ctrl targetAgent", "owner", "/api/v1/cron", { name: "bad-target", schedule: "* * * * *", prompt: "hi", targetAgent: ["cc\r"] }),
    // 新建 agent
    post("create ok", "owner", "/api/v1/agents", { name: "ok-agent", dir: "/tmp/x", purpose: "看日志", model: "claude-opus-5-5" }),
    post("create ok alias", "owner", "/api/v1/agents", { name: "ok-alias", dir: "/tmp/x", model: "opus" }),
    post("create purpose etx", "owner", "/api/v1/agents", { name: "bad-p1", dir: "/tmp/x", purpose: "x\u0003touch F\r#" }),
    post("create purpose newline", "owner", "/api/v1/agents", { name: "bad-p2", dir: "/tmp/x", purpose: "第一行\n第二行" }),
    post("create model etx", "owner", "/api/v1/agents", { name: "bad-m1", dir: "/tmp/x", model: "opus\u0003" }),
    post("create model slash", "owner", "/api/v1/agents", { name: "bad-m2", dir: "/tmp/x", model: "/clear" }),
    post("create model space", "owner", "/api/v1/agents", { name: "bad-m3", dir: "/tmp/x", model: "opus x" }),
    post("create model long", "owner", "/api/v1/agents", { name: "bad-m4", dir: "/tmp/x", model: "a".repeat(129) }),
    post("create model 128", "owner", "/api/v1/agents", { name: "ok-long", dir: "/tmp/x", model: "a".repeat(128) }),
    post("create name ctrl", "owner", "/api/v1/agents", { name: "bad\u001bname", dir: "/tmp/x" }),
  ];
  results = sandbox.run(specs, { RUNNER_PRINCIPALS: JSON.stringify(PRINCIPALS) });
  calls = sandbox.managerCalls();
}, 60_000);

afterAll(() => sandbox?.cleanup());

describe("cron 新建 / 编辑：owner 本人且全权", () => {
  test("六种凭据：owner 设备、老 web-ui token 放行；legacy-star 回 owner-only；其它卡在全权门", () => {
    for (const [cred, want] of Object.entries(EXPECT)) {
      for (const op of ["add", "edit"]) expect([op, cred, ...res(`${op} ${cred}`)]).toEqual([op, cred, want[0], want[1]]);
    }
  });

  test("放行的才走到 manager；被拒的一次都没调", () => {
    for (const [cred, [status]] of Object.entries(EXPECT)) {
      expect([cred, calls.includes(`cron-add add-${cred} `)]).toEqual([cred, status === 200]);
      expect([cred, calls.includes(`cron-edit edit-${cred} `)]).toEqual([cred, status === 200]);
    }
  });

  test("列表 / 开关不注入文本：全权但不是 owner 的 legacy-star 照旧能用", () => {
    expect(res("list legacy-star")[0]).toBe(200);
    expect(res("toggle legacy-star")[0]).toBe(200);
  });
});

describe("cron 字段拒控制字符（换行、\\r、\\x03、\\x1b、NUL）", () => {
  test("prompt：新建和编辑都回 400，manager 没收到", () => {
    for (const k of Object.keys(EVIL)) {
      for (const op of ["add", "edit"]) expect([op, k, ...res(`${op} ctrl ${k}`)]).toEqual([op, k, 400, controlCharError("prompt")]);
      expect([k, calls.includes(`bad-${k}`)]).toEqual([k, false]);
    }
  });

  test("其它字段同样拦（name、数组形式的 targetAgent）", () => {
    expect(res("add ctrl name")).toEqual([400, controlCharError("name")]);
    expect(res("add ctrl targetAgent")).toEqual([400, controlCharError("targetAgent")]);
    expect(calls.includes("bad-target")).toBe(false);
  });
});

describe("新建 agent：purpose / model 拼进启动命令", () => {
  test("合法值（含别名、正好 128 字符）照常建", () => {
    for (const n of ["create ok", "create ok alias", "create model 128"]) expect([n, res(n)[0]]).toEqual([n, 200]);
    expect(calls).toContain("create ok-agent /tmp/x --purpose 看日志 --model claude-opus-5-5");
  });

  test("purpose / model / name 带控制字符 → 400，写明字段", () => {
    expect(res("create purpose etx")).toEqual([400, controlCharError("purpose")]);
    expect(res("create purpose newline")).toEqual([400, controlCharError("purpose")]);
    expect(res("create model etx")).toEqual([400, controlCharError("model")]);
    expect(res("create name ctrl")).toEqual([400, controlCharError("name")]);
  });

  test("model 以 / 开头、带空格、超过 128 → 400「model 含非法字符」", () => {
    for (const n of ["create model slash", "create model space", "create model long"]) expect([n, ...res(n)]).toEqual([n, 400, "model 含非法字符"]);
  });

  test("被拒的一个都没走到 manager", () => {
    for (const n of ["bad-p1", "bad-p2", "bad-m1", "bad-m2", "bad-m3", "bad-m4", "bad\u001bname"]) expect([n, calls.includes(n)]).toEqual([n, false]);
  });
});
