/**
 * 服务端生成的单次授权:bridge 核过按钮(HMAC、点击者是 owner)后签发,manager 消费。只落 token 的哈希,
 * token 本身只走 argv 一次;消费 = 原子改名到 used/,改名失败(已消费 / 不存在)即拒绝,所以伪造和重放都过不去。
 * actor 取授权里记的、由 bridge 判定的点击者,不接受命令行自报。同用户能读写控制目录,这不是对恶意本机脚本的边界。
 * tests/state-maintenance-entry.test.ts。
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, FILE_MODE, maintPaths } from "./paths.js";

const GRANT_ACTIONS = ["observe", "mode", "run", "recover", "note", "services", "runtime", "config"] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];

export interface Grant {
  action: GrantAction;
  /** bridge 判定的点击者("owner" / PM 的 registry 键) */
  actor: string;
  /** 动作绑定的对象:mode 的目标档位、run 绑定的报告 runId + 报告哈希、recover 的 runId */
  binding: Record<string, string>;
  issuedAt: number;
  expiresAt: number;
}

const GRANT_TTL_MS = 5 * 60_000;
const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const grantsDir = (root: string): string => join(maintPaths(root).control, "grants");

export function issueGrant(root: string, g: Omit<Grant, "issuedAt" | "expiresAt">, now = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  const dir = grantsDir(root);
  ensureDir(dir);
  const body: Grant = { ...g, issuedAt: now, expiresAt: now + GRANT_TTL_MS };
  writeFileSync(join(dir, `${hashOf(token)}.json`), JSON.stringify(body), { mode: FILE_MODE, flag: "wx" });
  return token;
}

export type GrantCheck = { ok: true; grant: Grant } | { ok: false; error: string };

const isGrant = (v: unknown): v is Grant => {
  const g = v as Partial<Grant> | null;
  return !!g && GRANT_ACTIONS.includes(g.action as GrantAction) && typeof g.actor === "string" && !!g.actor
    && typeof g.expiresAt === "number" && !!g.binding && typeof g.binding === "object";
};

/**
 * 消费一次授权:先原子改名占住(并发的第二个调用者改名失败),再核动作、有效期与绑定。
 * 核不过的授权同样已作废——授权只能用一次,不论成败。
 */
export function consumeGrant(root: string, token: string, action: GrantAction, binding: Record<string, string>, now = Date.now()): GrantCheck {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, error: "授权格式不对(不是 bridge 签发的)" };
  const dir = grantsDir(root);
  const h = hashOf(token);
  const used = join(dir, `used-${h}.json`);
  try {
    renameSync(join(dir, `${h}.json`), used);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" ? "授权不存在或已用过(伪造或重放),拒绝" : `读不了授权(${code})` };
  }
  let g: unknown;
  try {
    g = JSON.parse(readFileSync(used, "utf8"));
  } catch {
    return { ok: false, error: "授权文件损坏,拒绝" }; // 内容不可信就不执行;文件已作废,不会被再用
  }
  if (!isGrant(g)) return { ok: false, error: "授权文件损坏,拒绝" };
  if (g.action !== action) return { ok: false, error: `授权是给「${g.action}」的,不能用来「${action}」` };
  if (now > g.expiresAt) return { ok: false, error: "授权已过期,请重新点按钮" };
  for (const [k, v] of Object.entries(binding)) if (g.binding[k] !== v) return { ok: false, error: `授权绑定的 ${k} 对不上,拒绝` };
  return { ok: true, grant: g };
}
