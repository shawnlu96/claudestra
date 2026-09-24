/**
 * 本机 Claudestra 实例的稳定 id（STATE_DIR/instance-id，第一次用到时生成）。
 *
 * peer 握手时双方互报它，用来认出「还是同一个对方」：对方改名、换 token、两边先后
 * 各握一次手，都合并进同一条 peer 记录，而不是按名字撞车生出 -2、-3（lib/peers.ts 的匹配规则）。
 * 它是对方自报的标识，不是凭据——只用来合并，不用来鉴权。
 */
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { STATE_DIR } from "./paths.js";

/** 协议里收到的实例 id 只认这种形状（进 CLI 参数和 peers.json，不能带空白 / 分隔符） */
export function isInstanceId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && /^[\w-]+$/.test(v);
}

const cache = new Map<string, string>();

function readValid(path: string): string {
  try {
    const s = readFileSync(path, "utf8").trim();
    return isInstanceId(s) ? s : "";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** 先写临时文件再 link 过去：link 是原子的，别的进程读到的要么没有、要么是完整的 id；
 *  两个进程同时首用时只有一个 link 成功，另一个读回它的——一台机器只能有一个 id。 */
function createId(dir: string, path: string): string {
  mkdirSync(dir, { recursive: true });
  const fresh = randomBytes(12).toString("hex");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${fresh}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return fresh;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const other = readValid(path);
    if (other) return other;
    renameSync(tmp, path); // 已有的文件内容不合法（被手改坏）——它本来就认不出任何人，直接换掉
    return fresh;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * 读（或生成）本机实例 id。读写失败返回 ""：调用方按「不带 id」处理，握手照常，
 * 只是少了自动合并——绝不能返回一个没落盘的随机值，那会让对方记下一个下次就对不上的 id。
 */
export function instanceIdSync(dir: string = STATE_DIR): string {
  const hit = cache.get(dir);
  if (hit) return hit;
  const path = join(dir, "instance-id");
  let id = "";
  try {
    id = readValid(path) || createId(dir, path);
  } catch (e) {
    console.error(`⚠️ 读写 ${path} 失败，这次握手不带实例 id（只影响重复记录的自动合并）: ${(e as Error).message}`);
    return "";
  }
  cache.set(dir, id);
  return id;
}
