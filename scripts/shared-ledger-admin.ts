#!/usr/bin/env bun
/**
 * Offline shared-ledger center administration: opens the center database directly on the center host.
 *   invite --db <db> --team <id> --project <id> --person <id> --code <member code> --role member|service
 *          --actions read,plan[,...] --ttl 24h [--credential-ttl 90d]   → prints the one-time join code once
 *   list --db <db>          revoke --db <db> <join code id>
 * Owner import/projection identities are enrolled the same way with --role service; there is no other path.
 */
import { Store } from "../src/shared-ledger/store.js";
import { centerId, createJoinCode, listJoinCodes, parseDuration, revokeJoinCode } from "../src/shared-ledger/join.js";

const USAGE = "usage: shared-ledger-admin invite|list|revoke --db <center db> ...（见文件头）";
const VALUED = new Set(["db", "team", "project", "person", "code", "role", "actions", "ttl", "credential-ttl"]);

function parseAdminArgs(argv: string[]): { cmd: string; flags: Record<string, string>; pos: string[] } {
  const [cmd = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    if (!VALUED.has(name) || rest[i + 1] === undefined) throw new Error(`unknown or empty flag ${a}`);
    flags[name] = rest[++i]!;
  }
  return { cmd, flags, pos };
}

export function runAdmin(argv: string[], now = Date.now()): Record<string, unknown> {
  const { cmd, flags, pos } = parseAdminArgs(argv);
  const need = (k: string) => { if (!flags[k]) throw new Error(`missing --${k}`); return flags[k]!; };
  if (!["invite", "list", "revoke"].includes(cmd)) throw new Error(USAGE);
  const store = new Store(need("db"));
  try {
    if (cmd === "list") return { ok: true, centerId: centerId(store), codes: listJoinCodes(store, now) };
    if (cmd === "revoke") {
      if (pos.length !== 1) throw new Error("usage: revoke --db <db> <join code id>");
      return revokeJoinCode(store, pos[0]!, now) ? { ok: true, id: pos[0], revoked: true }
        : { ok: false, error: "join code not found, already used or already revoked" };
    }
    const invite = createJoinCode(store, { teamId: need("team"), projectId: need("project"), personId: need("person"),
      memberCode: need("code"), role: need("role") as "member" | "service", actions: need("actions").split(",").map((s) => s.trim()),
      ttlMs: parseDuration(need("ttl")), ...(flags["credential-ttl"] ? { credentialTtlMs: parseDuration(flags["credential-ttl"]) } : {}) }, now);
    return { ok: true, centerId: centerId(store), id: invite.id, expiresAt: invite.expiresAt, joinCode: invite.code,
      note: "入组码只显示这一次；库里只存哈希。" };
  } finally { store.close(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(runAdmin(process.argv.slice(2)))); }
  catch (e) {
    console.log(JSON.stringify({ ok: false, error: (e as Error).message }));
    process.exitCode = 1;
  }
}
