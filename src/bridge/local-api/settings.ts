/**
 * 全局设置与个人资料（原 web BFF 的 settings / profile 路由）：
 *   GET/PUT /api/v1/settings  { lang, groqApiKeyHint, pushNoContent }；PUT 体 { lang?, groqApiKey?, pushNoContent? }（key 空串 = 清除）
 *     → ~/.claude-orchestrator/config.json
 *   GET/PUT /api/v1/profile   { user:{nickname, avatar}, claude:{nickname, avatar} }（avatar 是 data:image/* ≤ 256 KB）→ user_profile 表
 * 读任何凭据都行（提示只有尾四位，头像是展示层）；写是全局状态，要 manage grant。
 */
import { readConfig, setGroqApiKey, setLang, setPushNoContent, type AppConfig, type AppLang } from "../../lib/config-store.js";
import { canManage } from "../../lib/devices.js";
import { setLangInMemory } from "../../lib/i18n.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { webDb } from "./db.js";

const MANAGE_MSG = "changing global settings requires a credential with manage grant";
const KEY_RE = /^[\w-]{20,200}$/;
const AVATAR_MAX = 256 * 1024;
/** 两张头像 + 昵称的 JSON 不该超过这个数；再大就是滥用 */
const PROFILE_BODY_MAX = 3 * AVATAR_MAX;

interface Store {
  read: () => Promise<AppConfig>;
  setLang: (lang: AppLang) => Promise<unknown>;
  setGroqApiKey: (key: string) => Promise<unknown>;
  setPushNoContent: (on: boolean) => Promise<unknown>;
}
// 写完文件立刻刷 bridge 内存：lib/i18n 只在启动时 initLang 读一次，不刷的话 Discord 上「思考中 / 完成 / 打断」
// 要等 bridge 重启才换语言。launcher / cron 是别的进程，仍要重启才跟上。
const persistLang = async (lang: AppLang) => {
  await setLang(lang);
  setLangInMemory(lang);
};
const realStore: Store = { read: readConfig, setLang: persistLang, setGroqApiKey, setPushNoContent };
let store = realStore;
/** 单测换成内存实现；生产不调 */
export function setSettingsStoreForTest(s: Store | undefined): void {
  store = s ?? realStore;
}

export const groqKeyHint = (key: string | undefined): string | null => (key ? `····${key.slice(-4)}` : null);
const settingsBody = (cfg: AppConfig) => ({ ok: true, lang: cfg.lang, groqApiKeyHint: groqKeyHint(cfg.groqApiKey), pushNoContent: cfg.pushNoContent === true });

export async function handleSettings(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path === "/settings" && req.method === "GET") return apiJson(200, settingsBody(await store.read()));
  if (path === "/settings" && req.method === "PUT") return putSettings(req, principal);
  if (path === "/profile" && req.method === "GET") return apiJson(200, { ok: true, ...readProfile() });
  if (path === "/profile" && req.method === "PUT") return putProfile(req, principal);
  return null;
}

async function putSettings(req: Request, principal: Principal): Promise<Response> {
  if (!canManage(principal)) return forbidden(MANAGE_MSG);
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const b = (body ?? {}) as { lang?: unknown; groqApiKey?: unknown; pushNoContent?: unknown };
  if (b.lang !== undefined && b.lang !== "zh" && b.lang !== "en") return apiJson(400, { ok: false, error: 'lang must be "zh" or "en"' });
  if (b.groqApiKey !== undefined && typeof b.groqApiKey !== "string") return apiJson(400, { ok: false, error: "groqApiKey must be a string (empty = clear)" });
  if (b.pushNoContent !== undefined && typeof b.pushNoContent !== "boolean") return apiJson(400, { ok: false, error: "pushNoContent must be a boolean" });
  const key = typeof b.groqApiKey === "string" ? b.groqApiKey.trim() : undefined;
  if (key && !KEY_RE.test(key)) return apiJson(400, { ok: false, error: "groqApiKey does not look like an API key" });
  if (b.lang !== undefined) await store.setLang(b.lang);
  if (key !== undefined) await store.setGroqApiKey(key);
  if (typeof b.pushNoContent === "boolean") await store.setPushNoContent(b.pushNoContent);
  return apiJson(200, settingsBody(await store.read()));
}

type ProfileRow = { nickname: string; avatar: string; claude_nickname: string; claude_avatar: string };
interface Profile {
  user: { nickname: string; avatar: string };
  claude: { nickname: string; avatar: string };
}

function readProfile(): Profile {
  const row = webDb().prepare("SELECT nickname, avatar, claude_nickname, claude_avatar FROM user_profile WHERE id = 1").get() as ProfileRow | null;
  return { user: { nickname: row?.nickname ?? "", avatar: row?.avatar ?? "" }, claude: { nickname: row?.claude_nickname ?? "", avatar: row?.claude_avatar ?? "" } };
}

const validAvatar = (v: unknown): v is string => typeof v === "string" && v.length <= AVATAR_MAX && (v === "" || v.startsWith("data:image/"));

/** 缺的字段保留原值：前端可以只改昵称不重传头像 */
function mergeSide(cur: { nickname: string; avatar: string }, patch: unknown): { nickname: string; avatar: string } | string {
  const p = (patch ?? {}) as { nickname?: unknown; avatar?: unknown };
  if (p.nickname !== undefined && typeof p.nickname !== "string") return "nickname must be a string";
  if (p.avatar !== undefined && !validAvatar(p.avatar)) return "avatar must be a data:image/* URL of at most 256 KB";
  return { nickname: typeof p.nickname === "string" ? p.nickname.trim().slice(0, 32) : cur.nickname, avatar: typeof p.avatar === "string" ? p.avatar : cur.avatar };
}

async function putProfile(req: Request, principal: Principal): Promise<Response> {
  if (!canManage(principal)) return forbidden(MANAGE_MSG);
  if (Number(req.headers.get("content-length") || 0) > PROFILE_BODY_MAX) return apiJson(413, { ok: false, error: "profile body too large" });
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const b = (body ?? {}) as { user?: unknown; claude?: unknown };
  const cur = readProfile();
  const user = mergeSide(cur.user, b.user);
  const claude = mergeSide(cur.claude, b.claude);
  if (typeof user === "string") return apiJson(400, { ok: false, error: `user.${user}` });
  if (typeof claude === "string") return apiJson(400, { ok: false, error: `claude.${claude}` });
  webDb().prepare(
    `INSERT INTO user_profile (id, nickname, avatar, claude_nickname, claude_avatar, updated_at) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, avatar = excluded.avatar, claude_nickname = excluded.claude_nickname,
       claude_avatar = excluded.claude_avatar, updated_at = excluded.updated_at`,
  ).run(user.nickname, user.avatar, claude.nickname, claude.avatar, new Date().toISOString());
  return apiJson(200, { ok: true, ...readProfile() });
}
