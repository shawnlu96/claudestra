/** 本地 API：GET/PUT /api/v1/settings（config.json 里的 lang / groqApiKey / pushNoContent / talkEnabled）与 GET/PUT /api/v1/profile（user_profile 表） */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setWebStatePathForTest } from "../src/bridge/local-api/db.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { groqKeyHint, setSettingsStoreForTest } from "../src/bridge/local-api/settings.js";
import type { AppConfig } from "../src/lib/config-store.js";
import type { Principal } from "../src/lib/principals.js";
import { closeWebState } from "../src/lib/web-state.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };

let cfg: AppConfig;
let dir: string;
let dbPath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "local-api-settings-"));
  dbPath = join(dir, "web-state.sqlite");
  setWebStatePathForTest(dbPath);
  cfg = { autoUpdate: { claudestra: true, claudeCode: true }, lang: "zh" };
  setSettingsStoreForTest({
    read: async () => cfg,
    setLang: async (lang) => { cfg = { ...cfg, lang }; },
    setGroqApiKey: async (key) => {
      cfg = { ...cfg };
      if (key) cfg.groqApiKey = key;
      else delete cfg.groqApiKey;
    },
    setPushNoContent: async (on) => { cfg = { ...cfg, pushNoContent: on }; },
    setTalkEnabled: async (on) => { cfg = { ...cfg, talkEnabled: on }; },
  });
});
afterAll(() => {
  setSettingsStoreForTest(undefined);
  setWebStatePathForTest(undefined);
  closeWebState(dbPath);
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, p: Principal, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const r = new Request(`http://bridge.local${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("/api/v1/settings", () => {
  test("GET 任何凭据都行；没配 key 时 hint 是 null", async () => {
    const res = await call("GET", "/api/v1/settings", GUEST);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lang: "zh", groqApiKeyHint: null, pushNoContent: false, talkEnabled: false });
  });
  test("PUT 要 manage grant：guest 403，什么都没改", async () => {
    expect((await call("PUT", "/api/v1/settings", GUEST, { lang: "en" })).status).toBe(403);
    expect(cfg.lang).toBe("zh");
  });
  test("PUT 校验：lang 只认 zh/en，groqApiKey 得是字符串且像个 key，坏 JSON 400", async () => {
    expect((await call("PUT", "/api/v1/settings", OWNER, { lang: "fr" })).status).toBe(400);
    expect((await call("PUT", "/api/v1/settings", OWNER, { groqApiKey: 42 })).status).toBe(400);
    expect((await call("PUT", "/api/v1/settings", OWNER, { groqApiKey: "short" })).status).toBe(400);
    expect((await call("PUT", "/api/v1/settings", OWNER, "{bad")).status).toBe(400);
    expect((await call("PUT", "/api/v1/settings", OWNER, { lang: "en", pushNoContent: "yes" })).status).toBe(400); // 校验在任何写入之前
    expect(cfg).toEqual({ autoUpdate: { claudestra: true, claudeCode: true }, lang: "zh" });
  });
  test("PUT lang + key：回体只带尾四位提示；空串清除 key；lang 可单独提交", async () => {
    const key = "gsk_abcdefghijklmnopqrstuvwxyz1234";
    const res = await call("PUT", "/api/v1/settings", OWNER, { lang: "en", groqApiKey: key });
    expect(await res.json()).toEqual({ ok: true, lang: "en", groqApiKeyHint: "····1234", pushNoContent: false, talkEnabled: false });
    expect(cfg.groqApiKey).toBe(key);
    expect(JSON.stringify(await (await call("GET", "/api/v1/settings", GUEST)).json())).not.toContain("gsk_");
    expect(await (await call("PUT", "/api/v1/settings", OWNER, { groqApiKey: "" })).json()).toEqual({ ok: true, lang: "en", groqApiKeyHint: null, pushNoContent: false, talkEnabled: false });
    expect(cfg.groqApiKey).toBeUndefined();
    expect(await (await call("PUT", "/api/v1/settings", OWNER, { lang: "zh" })).json()).toMatchObject({ lang: "zh" });
  });
  test("推送不带正文：guest 改不了；owner 打开 / 关上，GET 读回", async () => {
    expect((await call("PUT", "/api/v1/settings", GUEST, { pushNoContent: true })).status).toBe(403);
    expect(cfg.pushNoContent).toBeUndefined();
    expect(await (await call("PUT", "/api/v1/settings", OWNER, { pushNoContent: true })).json()).toMatchObject({ pushNoContent: true });
    expect(await (await call("GET", "/api/v1/settings", GUEST)).json()).toMatchObject({ pushNoContent: true });
    expect(await (await call("PUT", "/api/v1/settings", OWNER, { pushNoContent: false })).json()).toMatchObject({ pushNoContent: false, talkEnabled: false });
  });
  test("Chat 入口（T50）：缺省关，guest 改不了也读得到；owner 打开 / 关上；不是布尔 400", async () => {
    expect(await (await call("GET", "/api/v1/settings", GUEST)).json()).toMatchObject({ talkEnabled: false });
    expect((await call("PUT", "/api/v1/settings", GUEST, { talkEnabled: true })).status).toBe(403);
    expect((await call("PUT", "/api/v1/settings", OWNER, { talkEnabled: "on" })).status).toBe(400);
    expect(cfg.talkEnabled).toBeUndefined();
    expect(await (await call("PUT", "/api/v1/settings", OWNER, { talkEnabled: true })).json()).toMatchObject({ talkEnabled: true });
    expect(await (await call("GET", "/api/v1/settings", GUEST)).json()).toMatchObject({ talkEnabled: true });
    expect(await (await call("PUT", "/api/v1/settings", OWNER, { talkEnabled: false })).json()).toMatchObject({ talkEnabled: false });
  });
  test("groqKeyHint", () => {
    expect(groqKeyHint(undefined)).toBeNull();
    expect(groqKeyHint("")).toBeNull();
    expect(groqKeyHint("abcdefgh")).toBe("····efgh");
  });
});

describe("/api/v1/profile", () => {
  const AVATAR = "data:image/jpeg;base64,/9j/4AAQ";
  test("GET 默认全空", async () => {
    expect(await (await call("GET", "/api/v1/profile", GUEST)).json()).toEqual({ ok: true, user: { nickname: "", avatar: "" }, claude: { nickname: "", avatar: "" } });
  });
  test("PUT：guest 403；owner 写入后 GET 读回；昵称裁到 32 字", async () => {
    expect((await call("PUT", "/api/v1/profile", GUEST, { user: { nickname: "x" } })).status).toBe(403);
    const long = "很".repeat(40);
    const res = await call("PUT", "/api/v1/profile", OWNER, { user: { nickname: ` ${long} `, avatar: AVATAR }, claude: { nickname: "小克", avatar: "" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, user: { nickname: "很".repeat(32), avatar: AVATAR }, claude: { nickname: "小克", avatar: "" } });
    expect(await (await call("GET", "/api/v1/profile", GUEST)).json()).toMatchObject({ user: { avatar: AVATAR } });
  });
  test("PUT 只改一侧 / 只改昵称：缺的字段保留原值", async () => {
    const res = await call("PUT", "/api/v1/profile", OWNER, { claude: { nickname: "克劳德" } });
    expect(await res.json()).toEqual({ ok: true, user: { nickname: "很".repeat(32), avatar: AVATAR }, claude: { nickname: "克劳德", avatar: "" } });
  });
  test("PUT 校验：头像必须 data:image/* 且 ≤ 256 KB；昵称必须字符串；超大体 413", async () => {
    expect((await call("PUT", "/api/v1/profile", OWNER, { user: { avatar: "https://evil/x.png" } })).status).toBe(400);
    expect((await call("PUT", "/api/v1/profile", OWNER, { user: { avatar: `data:image/png;base64,${"A".repeat(256 * 1024)}` } })).status).toBe(400);
    expect((await call("PUT", "/api/v1/profile", OWNER, { claude: { nickname: 7 } })).status).toBe(400);
    expect((await call("PUT", "/api/v1/profile", OWNER, {}, { "content-length": String(10 * 1024 * 1024) })).status).toBe(413);
  });
});
