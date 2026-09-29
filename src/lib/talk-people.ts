/**
 * people：代码里「人」这一层。凭据（principal）表示不了人：同一个人配两台 guest 设备就是两个 principal。
 * 本机的人 id = `local:<principalId>`（和台账 human assignee 同一格式），owner 的所有设备与 Discord 上的 owner 都是 local:owner:self。
 * 合并只在本机 guest 之间：被合并的一方 mergedInto 指向另一方，链条始终压平成一层（合并时把指向自己的也改指过去），
 * 所以「这个人」= 规范 id + 所有 mergedInto 它的别名；读侧按别名集合判断，旧房间、旧指派不用改写。
 */
import type { Database } from "bun:sqlite";

export const OWNER_PRINCIPAL = "owner:self";
export const OWNER_PERSON = `local:${OWNER_PRINCIPAL}`;
const GUEST_RE = /^guest:[0-9a-f]{1,64}$/;
/** 名字里不许出现的：控制字符、格式字符（含双向控制符、零宽字符）、默认可忽略字符、盲文空白 */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu;
const NAME_MAX = 32;

export interface Person {
  id: string;
  kind: "local" | "remote";
  principalId: string | null;
  fp: string | null;
  remotePrincipal: string | null;
  displayName: string;
  claimedName: string | null;
  mergedInto: string | null;
}

export class TalkPeopleError extends Error {
  constructor(public code: "invalid" | "not_found" | "conflict", message: string) {
    super(message);
  }
}

export const personIdOf = (principalId: string): string => `local:${principalId}`;
export const isGuestPrincipal = (principalId: string): boolean => GUEST_RE.test(principalId);
/** 本机的人能进 talk 的 principal：owner 本人或 guest 设备（集成 token、peer 不是人） */
const isLocalPersonPrincipal = (principalId: string): boolean => principalId === OWNER_PRINCIPAL || isGuestPrincipal(principalId);

export function localPrincipalOf(personId: string): string | null {
  if (!personId.startsWith("local:")) return null;
  const p = personId.slice("local:".length);
  return isLocalPersonPrincipal(p) ? p : null;
}

/** 显示名清洗：去掉不可见字符、首尾空白，按码点截到 32 个 */
export function cleanName(raw: string): string {
  return [...raw.replace(INVISIBLE_RE, "").trim()].slice(0, NAME_MAX).join("");
}

const rowToPerson = (r: Record<string, unknown>): Person => ({
  id: String(r.id), kind: r.kind as Person["kind"], principalId: (r.principalId as string | null) ?? null, fp: (r.fp as string | null) ?? null,
  remotePrincipal: (r.remotePrincipal as string | null) ?? null, displayName: String(r.displayName ?? ""), claimedName: (r.claimedName as string | null) ?? null,
  mergedInto: (r.mergedInto as string | null) ?? null,
});

export function getPerson(db: Database, id: string): Person | null {
  const r = db.prepare("SELECT * FROM people WHERE id = ?").get(id) as Record<string, unknown> | null;
  return r ? rowToPerson(r) : null;
}

/** 本机的人第一次在 talk 里出现时建行（幂等）；不是 owner / guest 的 principal 抛 invalid */
export function ensureLocalPerson(db: Database, principalId: string, now = Date.now()): Person {
  if (!isLocalPersonPrincipal(principalId)) throw new TalkPeopleError("invalid", `不是本机的人：${principalId}`);
  const id = personIdOf(principalId);
  db.prepare("INSERT OR IGNORE INTO people (id, kind, principalId, createdAt, updatedAt) VALUES (?, 'local', ?, ?, ?)").run(id, principalId, now, now);
  return getPerson(db, id)!;
}

/** 规范 id：被合并的返回它并入的那个人（链条压平，最多一跳）；没有这行就是自己 */
function canonicalPerson(db: Database, id: string): string {
  const r = db.prepare("SELECT mergedInto FROM people WHERE id = ?").get(id) as { mergedInto: string | null } | null;
  return r?.mergedInto ?? id;
}

/** 这个人的全部 id：规范 id + 并入它的别名（按字节序，规范 id 在前） */
export function personAliases(db: Database, id: string): string[] {
  const canon = canonicalPerson(db, id);
  const rows = db.prepare("SELECT id FROM people WHERE mergedInto = ? ORDER BY id").all(canon) as { id: string }[];
  return [canon, ...rows.map((r) => r.id)];
}

/** 这个人名下的本机 principal（owner:self / guest:…），成员键和台账 assignee 都按它们判 */
export function personPrincipals(db: Database, id: string): string[] {
  return personAliases(db, id).map(localPrincipalOf).filter((p): p is string => p !== null);
}

/**
 * 把 from 并进 into：只许两个本机 guest；into 自己不能已被并走；from 名下原有的别名一并改指 into（保持一层）。
 * owner 不参与合并：owner 的多台设备本来就共用一个 principal。
 */
export function mergePeople(db: Database, from: string, into: string, now = Date.now()): void {
  const fp = localPrincipalOf(from);
  const ip = localPrincipalOf(into);
  if (!fp || !ip || !isGuestPrincipal(fp) || !isGuestPrincipal(ip)) throw new TalkPeopleError("invalid", "只能合并本机的两个 guest");
  if (from === into) throw new TalkPeopleError("invalid", "不能合并到自己");
  db.transaction(() => {
    ensureLocalPerson(db, fp, now);
    ensureLocalPerson(db, ip, now);
    if (getPerson(db, into)!.mergedInto) throw new TalkPeopleError("conflict", `${into} 已并入别人，先并到它的规范 id`);
    db.prepare("UPDATE people SET mergedInto = ?, updatedAt = ? WHERE mergedInto = ?").run(into, now, from);
    db.prepare("UPDATE people SET mergedInto = ?, updatedAt = ? WHERE id = ?").run(into, now, from);
  }).immediate();
}

export function unmergePerson(db: Database, id: string, now = Date.now()): void {
  const r = db.prepare("UPDATE people SET mergedInto = NULL, updatedAt = ? WHERE id = ? AND mergedInto IS NOT NULL").run(now, id);
  if (r.changes !== 1) throw new TalkPeopleError("not_found", `${id} 没有并入别人`);
}

/** 本机备注名（只有 owner 能设，对方改不了）；空串 = 回到默认名 */
export function setDisplayName(db: Database, id: string, raw: string, now = Date.now()): string {
  const name = cleanName(raw);
  const r = db.prepare("UPDATE people SET displayName = ?, updatedAt = ? WHERE id = ?").run(name, now, id);
  if (r.changes !== 1) throw new TalkPeopleError("not_found", `没有这个人：${id}`);
  return name;
}
