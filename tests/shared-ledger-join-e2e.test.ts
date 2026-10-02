import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/shared-ledger/store.js";
import { LedgerService } from "../src/shared-ledger/service.js";
import { startServer } from "../src/shared-ledger/server.js";
import { runAdmin } from "../scripts/shared-ledger-admin.js";
import { joinSharedLedger, parseSharedLedgerJoinCode } from "../src/lib/shared-ledger-join.js";
import { resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { readSharedLedgerBindings } from "../src/lib/shared-ledger-gate-bindings.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import type { InstanceKey } from "../src/lib/instance-key.js";

const newKey = (): InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
const scrub = { identity: { username: "nobody-local", hostname: "nobody-host" } };
let root: string, db: string, store: Store, server: ReturnType<typeof startServer>, url: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sl-join-e2e-"));
  db = join(root, "center.sqlite");
  store = new Store(db);
  server = startServer(new LedgerService(store));
  url = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => { server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });

const admin = (...a: string[]) => runAdmin(["invite", "--db", db, "--team", "team-a", "--project", "project-a", "--ttl", "1h", ...a]);

describe("shared ledger enrollment end to end", () => {
  test("two members enroll from isolated state dirs and read the same project; a third instance is refused", async () => {
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) => spyOn(console, m).mockImplementation((...a) => { logs.push(a.join(" ")); }));
    try {
      const a = admin("--person", "peer-a", "--code", "peer-a", "--role", "member", "--actions", "read,plan");
      const b = admin("--person", "peer-b", "--code", "peer-b", "--role", "member", "--actions", "read");
      expect(a.ok && b.ok).toBe(true);
      const codes = [String(a.joinCode), String(b.joinCode)];
      const listed = JSON.stringify(runAdmin(["list", "--db", db]));
      for (const c of codes) expect(listed.includes(parseSharedLedgerJoinCode(c)!.secret)).toBe(false);

      const members = await Promise.all(["a", "b"].map(async (n, i) => {
        const dir = join(root, `state-${n}`), key = newKey(), instanceId = `instance-${n}`;
        const result = await joinSharedLedger({ url, code: codes[i]!, key, instanceId, subject: "owner:self", stateDir: dir });
        return { dir, key, instanceId, result };
      }));
      const bearers: string[] = [];
      for (const m of members) {
        const file = join(m.dir, "shared-ledger-credentials.json");
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(m.dir, "shared-ledger-bindings.json")).mode & 0o777).toBe(0o600);
        expect(readSharedLedgerBindings(m.dir)).toEqual([{ centerId: m.result.centerId, teamId: "team-a", projectId: "project-a", localProjectId: "project-a" }]);
        expect(m.result).toMatchObject({ teamId: "team-a", projectId: "project-a", kind: "person", identities: 1 });
        expect(JSON.stringify(m.result)).not.toMatch(/bearer|sljoin1/);
        bearers.push(resolveSharedLedgerCredential("owner:self", "person", m.result.centerId, "team-a", "project-a", "read", m.dir)!.bearer);
      }
      const [ma, mb] = members as [typeof members[0], typeof members[0]];
      const credA = resolveSharedLedgerCredential("owner:self", "person", ma.result.centerId, "team-a", "project-a", "plan", ma.dir)!;
      const created = await new SharedLedgerClient(credA, ma.key, { scrub }).command({ type: "feature.new", projectId: "project-a",
        requestId: randomBytes(6).toString("hex"), title: "Shared plan", description: "Visible to both", homeInstanceId: ma.instanceId });
      const credB = resolveSharedLedgerCredential("owner:self", "person", mb.result.centerId, "team-a", "project-a", "read", mb.dir)!;
      const seenByB = await new SharedLedgerClient(credB, mb.key).features();
      expect(seenByB.features.map((f) => f.id)).toContain((created as { result: { featureId: string } }).result.featureId);
      // peer B holds read only: no plan authority.
      expect(resolveSharedLedgerCredential("owner:self", "person", mb.result.centerId, "team-a", "project-a", "plan", mb.dir)).toBeNull();

      // Third instance: no join code. Reusing peer A's code (already redeemed) and a forged code both fail.
      const third = join(root, "state-c");
      for (const code of [codes[0]!, `sljoin1.${ma.result.centerId}.${"a".repeat(32)}.${"A".repeat(43)}`]) {
        await expect(joinSharedLedger({ url, code, key: newKey(), instanceId: "instance-c", subject: "owner:self", stateDir: third }))
          .rejects.toThrow("join rejected");
      }
      const forged = new SharedLedgerClient({ ...credB, instanceId: "instance-c", bearer: randomBytes(32).toString("base64url") }, newKey());
      await expect(forged.features()).rejects.toMatchObject({ status: 403 });

      // Secrets never reach logs, output or ledger events.
      const events = JSON.stringify(store.all("SELECT * FROM events"));
      for (const s of [...codes, ...bearers]) {
        expect(logs.join("\n").includes(s)).toBe(false);
        expect(events.includes(s)).toBe(false);
        expect(readFileSync(db).toString("latin1").includes(s)).toBe(false);
      }
    } finally { for (const s of spies) s.mockRestore(); }
  });

  test("owner service identity enrolls through the same join path", async () => {
    const s = admin("--person", "owner-service", "--code", "owner-svc", "--role", "service", "--actions", "read,plan,import,project");
    const dir = join(root, "state-svc");
    const r = await joinSharedLedger({ url, code: String(s.joinCode), key: newKey(), instanceId: "instance-svc", subject: "importer", stateDir: dir });
    expect(r.kind).toBe("service");
    expect(resolveSharedLedgerCredential("importer", "service", r.centerId, "team-a", "project-a", "import", dir)).not.toBeNull();
    expect(() => admin("--person", "owner-x", "--code", "owner-x", "--role", "owner", "--actions", "read")).toThrow();
  });
});
