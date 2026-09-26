/**
 * 目录（docs/relay/protocol.md §5）：实例登记与配对短码，SQLite 持久化。在线连接、联系人、pending 都不在这里（内存，server.ts）。
 *
 * 指纹是主键、公钥与 slug 唯一：两把不同公钥算出同一指纹是 2^64 才撞一次的事，撞了路由就会送错人，登记时直接拒。
 * slug 是浏览器地址里的那一段，一把钥匙只能持有一个、一个只能被一把钥匙持有——否则 front 就把 A 的网页送给 B。
 * 短码只存 code → fp 映射（§5.2）：校验在实例本机，这里过期即删。不存任何请求内容、头或 token。
 */
import { Database } from "bun:sqlite";
import { LIMITS, slugCandidates } from "../lib/relay-protocol.js";

export interface InstanceRecord {
  fp: string;
  key: string;
  slug: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instances (
  fp TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY, fp TEXT NOT NULL REFERENCES instances(fp) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS codes_fp ON codes(fp);
`;
const COLS = "fp, public_key AS key, slug, name, first_seen AS firstSeen, last_seen AS lastSeen";

export class Directory {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL"); // 读多写少，WAL 让 last_seen 的 touch 不挡查询
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
  }

  /**
   * 握手成功后登记 / 更新实例，返回最终 slug（§5.1：想要的 → 加指纹前 4 位 → 加前 8 位 → 整个指纹）。
   * 同一指纹再来：更新名字与 slug、释放旧 slug。另一把钥匙算出同一指纹 → fingerprint_conflict。
   */
  register(fp: string, key: string, slugWanted: string, name: string, now = new Date().toISOString()): { slug: string } | "fingerprint_conflict" {
    const cur = this.byFp(fp);
    if (cur && cur.key !== key) return "fingerprint_conflict";
    const slug = this.allocateSlug(fp, slugWanted);
    if (cur) this.db.run("UPDATE instances SET slug = ?, name = ?, last_seen = ? WHERE fp = ?", [slug, name, now, fp]);
    else this.db.run("INSERT INTO instances (fp, public_key, slug, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)", [fp, key, slug, name, now, now]);
    return { slug };
  }

  private allocateSlug(fp: string, wanted: string): string {
    for (const c of [...slugCandidates(wanted, fp), fp.replace(/-/g, "")]) {
      const owner = this.bySlug(c);
      if (!owner || owner.fp === fp) return c;
    }
    return fp.replace(/-/g, ""); // 到这里只可能是整个指纹也被占——那就是同一个指纹，上面已经返回了
  }

  byFp(fp: string): InstanceRecord | null {
    return this.db.query<InstanceRecord, [string]>(`SELECT ${COLS} FROM instances WHERE fp = ?`).get(fp) ?? null;
  }

  bySlug(slug: string): InstanceRecord | null {
    return this.db.query<InstanceRecord, [string]>(`SELECT ${COLS} FROM instances WHERE slug = ?`).get(slug) ?? null;
  }

  /** 一批指纹 → 记录（联系人清单解析用；不在目录里的略过） */
  many(fps: string[]): InstanceRecord[] {
    if (!fps.length) return [];
    const marks = fps.map(() => "?").join(",");
    return this.db.query<InstanceRecord, string[]>(`SELECT ${COLS} FROM instances WHERE fp IN (${marks})`).all(...fps);
  }

  touch(fps: string[], now = new Date().toISOString()): void {
    if (!fps.length) return;
    const stmt = this.db.prepare("UPDATE instances SET last_seen = ? WHERE fp = ?");
    this.db.transaction(() => fps.forEach((fp) => stmt.run(now, fp)))();
  }

  count(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM instances").get()?.n ?? 0;
  }

  // ── 配对短码（§5.2） ───────────────────────────────────────────────────

  /** 登记短码；同一实例最多 maxCodesPerInstance 个有效短码，超了返回 false（调用方回 rate_limited） */
  putCode(code: string, fp: string, expiresAt: number, now = Date.now()): boolean {
    this.db.run("DELETE FROM codes WHERE fp = ? AND expires_at <= ?", [fp, now]);
    const n = this.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM codes WHERE fp = ? AND code <> ?").get(fp, code)?.n ?? 0;
    if (n >= LIMITS.maxCodesPerInstance) return false;
    const owner = this.db.query<{ fp: string }, [string]>("SELECT fp FROM codes WHERE code = ?").get(code);
    if (owner && owner.fp !== fp) return false; // 别人的短码不能被覆盖：碰巧撞码就让后来者换一个
    this.db.run("INSERT OR REPLACE INTO codes (code, fp, expires_at) VALUES (?, ?, ?)", [code, fp, expiresAt]);
    return true;
  }

  /** 只有登记者能删自己的短码 */
  delCode(code: string, fp: string): boolean {
    return this.db.run("DELETE FROM codes WHERE code = ? AND fp = ?", [code, fp]).changes > 0;
  }

  /** 短码 → 实例（过期算不存在） */
  lookupCode(code: string, now = Date.now()): InstanceRecord | null {
    const row = this.db.query<{ fp: string; expires_at: number }, [string]>("SELECT fp, expires_at FROM codes WHERE code = ?").get(code);
    if (!row || row.expires_at <= now) return null;
    return this.byFp(row.fp);
  }

  sweepCodes(now = Date.now()): number {
    return this.db.run("DELETE FROM codes WHERE expires_at <= ?", [now]).changes;
  }

  close(): void {
    this.db.close();
  }
}
