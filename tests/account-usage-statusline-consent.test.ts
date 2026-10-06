/**
 * statusLine 包装批准（bridge/account-usage-statusline-consent.ts），fixture settings：
 * 没有可信 owner 身份 / 非 owner / peer / 伪造或换频道的按钮 / 别的 bridge 进程的卡片 / 重放 / 过期 / 漂移都零写；
 * owner 对 bridge 自己贴出的卡片点一次只写一次。management 的薄分支不带身份 → 拒绝。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleStatuslineConsentButton, SLWRAP_PREFIX, statuslineConsentCard } from "../src/bridge/account-usage-statusline-consent.ts";
import { ensureStatuslineUsage, WRAP_PLAN_TTL_MS } from "../src/lib/statusline-usage-install.ts";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.ts";
import { isReservedButtonId } from "../src/lib/reserved-button-ids.ts";

const ROOT = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "sl-consent-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CUSTOM = `{"statusLine":{"type":"command","command":"echo mine"}}`;
const KEY = new Uint8Array(32).fill(7);
let n = 0;

async function setup() {
  const d = join(dir, `c-${n++}`);
  mkdirSync(d);
  const settingsPath = join(d, "settings.json");
  writeFileSync(settingsPath, CUSTOM);
  const planPath = join(d, "plan.json");
  await ensureStatuslineUsage({ repoRoot: ROOT, settingsPath, planPath });
  const deps = { key: KEY, planPath };
  const card = statuslineConsentCard("chat-1", deps)!;
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
