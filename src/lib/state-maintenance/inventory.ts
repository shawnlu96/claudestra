/**
 * 迁移前后对照用的清单,全部只读(经 StateFs,不调用任何「读或生成」接口)。
 * 身份清单:逐项完整 SHA-256、权限、数值 uid/gid;必需项缺失 / 无效即冲突,可选项明确标缺失。
 * 数据清单:整棵树逐项类型 / 权限 / 属主 / 内容哈希;元数据指纹用来判断在线预演是不是一致快照。
 * 私钥解析失败只报「无效」,不回显内容或解析错误原文。tests/state-maintenance-inventory.test.ts。
 */

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { join } from "node:path";
import type { NodeStat, StateFs } from "../floka-migration/state/types.js";

type ItemKind = "instance-id" | "ed25519" | "p256" | "json";

interface ItemSpec { name: string; rel: string; required: boolean; kind: ItemKind }

/** 身份清单覆盖面:实例 id、签名私钥(及派生公钥)、机器钥、已持久化公钥、peer / pin、token、撤销记录 */
const IDENTITY_ITEMS: readonly ItemSpec[] = [
  { name: "instance-id", rel: "instance-id", required: true, kind: "instance-id" },
  { name: "signing-key", rel: "instance-key.pem", required: true, kind: "ed25519" },
  { name: "machine-key", rel: "e2e-key.pem", required: false, kind: "p256" },
  { name: "pinned-public-keys", rel: "peer-keys.json", required: false, kind: "json" },
  { name: "peers-and-pins", rel: "peers.json", required: false, kind: "json" },
  { name: "tokens", rel: "principals.json", required: false, kind: "json" },
  { name: "accepted-peers", rel: "peer-accepted.json", required: false, kind: "json" },
  { name: "revocations", rel: "peer-revocations.json", required: false, kind: "json" },
];

interface IdentityItem {
  name: string;
  rel: string;
  required: boolean;
  status: "present" | "missing" | "invalid";
  sha256?: string;
  mode?: string;
  uid?: number;
  gid?: number;
  /** 私钥派生公钥(SPKI DER)的 SHA-256 */
  publicKeySha256?: string;
  problem?: string;
}

export interface IdentityInventory { items: IdentityItem[]; conflicts: string[] }

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const octal = (m: number): string => m.toString(8).padStart(4, "0");

function publicSha(pem: Uint8Array, want: "ed25519" | "ec"): string | null {
  try {
    const key = createPrivateKey(Buffer.from(pem));
    if (key.asymmetricKeyType !== want) return null;
    return sha256(createPublicKey(key).export({ format: "der", type: "spki" }));
  } catch {
    return null; // 解析失败只报无效:错误原文可能带私钥片段,不回显
  }
}

function validate(spec: ItemSpec, bytes: Uint8Array): { ok: boolean; pub?: string } {
  const text = Buffer.from(bytes).toString("utf8");
  if (spec.kind === "instance-id") return { ok: /^[\w-]{1,64}$/.test(text.trim()) };
  if (spec.kind === "json") {
    try {
      JSON.parse(text);
      return { ok: true };
    } catch {
      return { ok: false }; // 内容可能含 token,不回显解析错误
    }
  }
  const pub = publicSha(bytes, spec.kind === "ed25519" ? "ed25519" : "ec");
  return pub ? { ok: true, pub } : { ok: false };
}

async function readItem(fs: StateFs, root: string, spec: ItemSpec): Promise<IdentityItem> {
  const base: IdentityItem = { name: spec.name, rel: spec.rel, required: spec.required, status: "missing" };
  const st = await fs.lstat(join(root, spec.rel));
  if (!st) return base;
  const meta = { mode: octal(st.mode), uid: st.uid, gid: st.gid };
  if (st.kind !== "file") return { ...base, ...meta, status: "invalid", problem: "不是普通文件" };
  const bytes = await fs.readFile(join(root, spec.rel));
  if (!bytes) return base;
  const v = validate(spec, bytes);
  const out: IdentityItem = { ...base, ...meta, status: v.ok ? "present" : "invalid", sha256: sha256(bytes) };
  if (v.pub) out.publicKeySha256 = v.pub;
  if (!v.ok) out.problem = "内容无效";
  return out;
}

export async function identityInventory(fs: StateFs, root: string): Promise<IdentityInventory> {
  const items: IdentityItem[] = [];
  for (const spec of IDENTITY_ITEMS) items.push(await readItem(fs, root, spec));
  const conflicts = items.filter((i) => i.required && i.status !== "present")
    .map((i) => `必需身份 ${i.name} ${i.status === "missing" ? "缺失" : "无效"},拒绝迁移,也不会生成`);
  return { items, conflicts };
}

interface TreeEntry {
  rel: string;
  kind: NodeStat["kind"];
  mode: string;
  uid: number;
  gid: number;
  sha256?: string;
  link?: string | null;
}

export interface TreeInventory {
  entries: TreeEntry[];
  /** 全部条目(含内容哈希)的摘要:前后对照先比它 */
  digest: string;
  /** ino / size / mtime / ctime 的摘要:同一根两次之间变了 = 有人在写 */
  metaDigest: string;
}

/** 整棵树(根本身不跟随;root 应是数据所在的真实目录)。withContent=false 只记元数据,在线预演用 */
export async function treeInventory(fs: StateFs, root: string, withContent: boolean): Promise<TreeInventory> {
  const entries: TreeEntry[] = [];
  const meta = createHash("sha256");
  const walk = async (rel: string): Promise<void> => {
    const p = rel === "." ? root : join(root, rel);
    const st = await fs.lstat(p);
    if (!st) throw new Error(`清单途中条目消失:${rel}(非一致)`);
    meta.update(`${rel}\0${st.ino}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.mode}\n`);
    const e: TreeEntry = { rel, kind: st.kind, mode: octal(st.mode), uid: st.uid, gid: st.gid };
    if (st.kind === "symlink") e.link = (await fs.readlink?.(p)) ?? null;
    if (st.kind === "file" && withContent) {
      const bytes = await fs.readFile(p);
      if (!bytes) throw new Error(`清单途中文件消失:${rel}(非一致)`);
      e.sha256 = sha256(bytes);
    }
    entries.push(e);
    if (st.kind === "dir") for (const n of (await fs.readdir(p)).sort()) await walk(rel === "." ? n : join(rel, n));
  };
  await walk(".");
  return { entries, digest: sha256(JSON.stringify(entries)), metaDigest: meta.digest("hex") };
}

/** 两份身份清单逐项比对(哈希、权限、属主、状态),返回差异描述(只含项名) */
export function diffIdentity(a: IdentityInventory, b: IdentityInventory): string[] {
  const out: string[] = [];
  for (const x of a.items) {
    const y = b.items.find((i) => i.name === x.name);
    const keys = ["status", "sha256", "mode", "uid", "gid", "publicKeySha256"] as const;
    const changed = keys.filter((k) => x[k] !== y?.[k]);
    if (changed.length) out.push(`身份 ${x.name} 不一致(${changed.join("、")})`);
  }
  return out;
}

/** 两份数据清单逐项比对;最多列 20 条,避免报告被撑爆 */
export function diffTree(a: TreeInventory, b: TreeInventory): string[] {
  if (a.digest === b.digest) return [];
  const key = (e: TreeEntry) => JSON.stringify(e);
  const bm = new Map(b.entries.map((e) => [e.rel, key(e)]));
  const am = new Map(a.entries.map((e) => [e.rel, key(e)]));
  const out: string[] = [];
  for (const [rel, k] of am) if (bm.get(rel) !== k) out.push(bm.has(rel) ? `数据 ${rel} 变了` : `数据 ${rel} 不见了`);
  for (const rel of bm.keys()) if (!am.has(rel)) out.push(`数据 ${rel} 多出来了`);
  return out.length > 20 ? [...out.slice(0, 20), `……另有 ${out.length - 20} 处差异`] : out;
}
