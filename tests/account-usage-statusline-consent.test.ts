/**
 * statusLine 包装批准（bridge/account-usage-statusline-consent.ts），fixture settings：
 * 没有可信 owner 身份 / 非 owner / peer / 伪造或换频道的按钮 / 别的 bridge 进程的卡片 / 重放 / 过期 / 漂移都零写；
 * owner 对 bridge 自己贴出的卡片点一次只写一次。management 的薄分支不带身份 → 拒绝。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  handleStatuslineConsentButton, postStatuslineConsentCard, SLWRAP_PREFIX, statuslineConsentCard, statuslineConsentRoute,
} from "../src/bridge/account-usage-statusline-consent.ts";
import type { Delivery, Envelope } from "../src/bridge/router.ts";
import type { Principal } from "../src/lib/principals.ts";
import { ensureStatuslineUsage, WRAP_PLAN_TTL_MS } from "../src/lib/statusline-usage-install.ts";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.ts";
import { isReservedButtonId } from "../src/lib/reserved-button-ids.ts";

const ROOT = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "sl-consent-"));
const prevControl = process.env.CONTROL_CHANNEL_ID;
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevControl === undefined) delete process.env.CONTROL_CHANNEL_ID;
  else process.env.CONTROL_CHANNEL_ID = prevControl;
});
const CUSTOM = `{"statusLine":{"type":"command","command":"echo mine"}}`;
const KEY = new Uint8Array(32).fill(7);
let n = 0;

async function setup(chatId = "chat-1") {
  const d = join(dir, `c-${n++}`);
  mkdirSync(d);
  const settingsPath = join(d, "settings.json");
  writeFileSync(settingsPath, CUSTOM);
  const planPath = join(d, "plan.json");
  await ensureStatuslineUsage({ repoRoot: ROOT, settingsPath, planPath });
  const deps = { key: KEY, planPath };
  const card = statuslineConsentCard(chatId, deps)!;
  return { settingsPath, planPath, deps, id: card.components[0].buttons[0].id as string };
}
const owner = { chatId: "chat-1", principalId: OWNER_PRINCIPAL_ID };

describe("handleStatuslineConsentButton", () => {
  test("按钮 id 是保留前缀：agent 用 reply 贴不出来", async () => {
    const { id } = await setup();
    expect(id.startsWith(SLWRAP_PREFIX)).toBe(true);
    expect(isReservedButtonId(id)).toBe(true);
  });

  test("没有可信 owner 身份（management 入口现状）：拒绝，零写", async () => {
    const s = await setup();
    expect(await handleStatuslineConsentButton(s.id, { chatId: "chat-1" }, s.deps)).toContain("拿不到可信的点击者身份");
    expect(readFileSync(s.settingsPath, "utf8")).toBe(CUSTOM);
  });

  test("非 owner / peer / token principal：零写", async () => {
    const s = await setup();
    for (const principalId of ["discord:123", "token:tok_x", "peer:Shawn", ""]) {
      expect(await handleStatuslineConsentButton(s.id, { chatId: "chat-1", principalId }, s.deps)).toContain("只有本机 owner");
    }
    expect(readFileSync(s.settingsPath, "utf8")).toBe(CUSTOM);
  });

  test("伪造 MAC / 换频道 / 别的 bridge 进程（别的密钥）的卡片：零写", async () => {
    const s = await setup();
    const forged = s.id.replace(/:[0-9a-f]{32}$/, ":" + "0".repeat(32));
    expect(await handleStatuslineConsentButton(forged, owner, s.deps)).toContain("按钮已失效");
    expect(await handleStatuslineConsentButton(s.id, { ...owner, chatId: "chat-2" }, s.deps)).toContain("按钮已失效");
    expect(await handleStatuslineConsentButton(s.id, owner, { ...s.deps, key: new Uint8Array(32).fill(9) })).toContain("按钮已失效");
    expect(await handleStatuslineConsentButton(`${SLWRAP_PREFIX}garbage`, owner, s.deps)).toContain("格式不对");
    expect(readFileSync(s.settingsPath, "utf8")).toBe(CUSTOM);
  });

  test("过期 / 配置漂移：零写", async () => {
    const s = await setup();
    expect(await handleStatuslineConsentButton(s.id, owner, { ...s.deps, now: () => Date.now() + WRAP_PLAN_TTL_MS + 1 })).toContain("按钮已失效");
    const drift = `{"statusLine":{"type":"command","command":"echo changed"}}`;
    writeFileSync(s.settingsPath, drift);
    expect(await handleStatuslineConsentButton(s.id, owner, s.deps)).toContain("drift");
    expect(readFileSync(s.settingsPath, "utf8")).toBe(drift);
  });

  test("owner 点 bridge 贴出的卡片：写一次，原命令包在里面；重放 / 再点零写", async () => {
    const s = await setup();
    expect(await handleStatuslineConsentButton(s.id, owner, s.deps)).toContain("✅");
    const after = readFileSync(s.settingsPath, "utf8");
    expect(JSON.parse(after).statusLine.command).toContain("--wrap 'echo mine'");
    expect(await handleStatuslineConsentButton(s.id, owner, s.deps)).toContain("按钮已失效");
    expect(readFileSync(s.settingsPath, "utf8")).toBe(after);
    expect(statuslineConsentCard("chat-1", s.deps)).toBeNull();
  });

  test("并发两次批准：只写一次", async () => {
    const s = await setup();
    const rs = await Promise.all([1, 2].map(() => handleStatuslineConsentButton(s.id, owner, s.deps)));
    expect(rs.filter((r) => r.startsWith("✅"))).toHaveLength(1);
  });
});

describe("网页 owner 批准路由（/api/v1 扩展）", () => {
  const base = { createdAt: "2026-10-06T00:00:00Z" };
  const ownerDevice = { ...base, id: "owner:self", role: "owner", agents: ["*", "master"], manage: true, credential: "cred1" } as Principal;
  const bearerStar = { ...base, id: "token:tok_1", role: "external", agents: ["*"], secret: "s" } as Principal;
  const guest = { ...base, id: "guest:g1", role: "external", agents: ["master"], manage: false, credential: "cred2" } as Principal;
  const peer = { ...base, id: "token:tok_p", role: "external", agents: ["*"], peer: "other", credential: "c3" } as Principal;
  const ownerPartial = { ...ownerDevice, agents: ["master"] } as Principal;
  const CONTROL = "control-chan";
  const click = (agent: string, text: string) => new Request(`http://x/api/v1/agents/${agent}/messages`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });

  test("非 owner 设备（全 scope token / guest / peer / 部分 scope）：403，零写", async () => {
    process.env.CONTROL_CHANNEL_ID = CONTROL;
    const s = await setup(CONTROL);
    const route = statuslineConsentRoute(() => s.deps);
    for (const p of [bearerStar, guest, peer, ownerPartial]) {
      const req = click("master", `[button:${s.id}]`);
      expect((await route(req, new URL(req.url), p))!.status).toBe(403);
    }
    expect(readFileSync(s.settingsPath, "utf8")).toBe(CUSTOM);
  });

  test("owner 设备在 master 聊天里点：写一次；再点 / 在别的 agent 聊天里点都零写；普通消息放行给原路由", async () => {
    process.env.CONTROL_CHANNEL_ID = CONTROL;
    const s = await setup(CONTROL);
    const route = statuslineConsentRoute(() => s.deps);
    const other = click("agent-x", `[button:${s.id}]`);
    expect(await (await route(other, new URL(other.url), ownerDevice))!.json()).toMatchObject({ ok: true, text: expect.stringContaining("按钮已失效") });
    expect(readFileSync(s.settingsPath, "utf8")).toBe(CUSTOM);
    const ok = click("master", `[button:${s.id}]`);
    expect(await (await route(ok, new URL(ok.url), ownerDevice))!.json()).toMatchObject({ ok: true, handled: "statusline-consent", text: expect.stringContaining("✅") });
    const after = readFileSync(s.settingsPath, "utf8");
    const again = click("master", `[button:${s.id}]`);
    expect(((await (await route(again, new URL(again.url), ownerDevice))!.json()) as { text: string }).text).toContain("按钮已失效");
    expect(readFileSync(s.settingsPath, "utf8")).toBe(after);
    const plain = click("master", "hello");
    expect(await route(plain, new URL(plain.url), ownerDevice)).toBeNull();
  });
});

describe("bridge 贴批准卡", () => {
  test("有待批计划才贴，贴到控制频道、按钮是本进程签的；同一计划重复 tick 不再贴；没有计划 / 没有频道不贴", async () => {
    const s = await setup("chan-post");
    const sent: Envelope[] = [];
    const deliver = async (env: Envelope): Promise<Delivery> => (sent.push(env), { envelope: env, outcome: { kind: "sent", discordMessageIds: ["m1"] } } as Delivery);
    expect(await postStatuslineConsentCard(deliver, { ...s.deps, chatId: "" })).toBe("no_channel");
    expect(await postStatuslineConsentCard(deliver, { ...s.deps, chatId: "chan-post" })).toBe("posted");
    expect(await postStatuslineConsentCard(deliver, { ...s.deps, chatId: "chan-post" })).toBe("duplicate");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from.kind).toBe("bridge");
    expect(sent[0]!.to).toMatchObject({ kind: "user", channelId: "chan-post" });
    const id = (sent[0]!.meta as { components: any[] }).components[0].buttons[0].id;
    expect(id).toBe(s.id);
    expect(await postStatuslineConsentCard(deliver, { ...s.deps, planPath: join(dir, "nope.json"), chatId: "chan-post" })).toBe("none");
    expect(readFileSync(s.settingsPath, "utf8")).toBe(CUSTOM);
  });

  test("投递失败：不记已贴，下个 tick 重试", async () => {
    const s = await setup("chan-fail");
    let fail = true;
    const deliver = async (env: Envelope): Promise<Delivery> =>
      ({ envelope: env, outcome: fail ? { kind: "dropped", reason: "offline" } : { kind: "sent", discordMessageIds: [] } }) as Delivery;
    expect(await postStatuslineConsentCard(deliver, { ...s.deps, chatId: "chan-fail" })).toBe("failed");
    fail = false;
    expect(await postStatuslineConsentCard(deliver, { ...s.deps, chatId: "chan-fail" })).toBe("posted");
  });
});
