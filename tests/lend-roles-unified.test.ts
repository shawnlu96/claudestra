/** Unified lender grants: old review-only entries run writing/fixing orders and keep legacy wire shapes. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLend } from "../src/lib/doctor-lend.js";
import { lendPollCapacity } from "../src/lib/lend-claude-worker-capacity.js";
import { readLend, readLendSync, type BorrowEntry, type LendRole } from "../src/lib/lend-config.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { advance, getOrder } from "../src/lib/lend-journal.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { parseV2Request } from "../src/lib/lend-wire-v2.js";
import { ENTRY, FP, harness, polled, sha, TEXT, toStarted, wire } from "./lend-harness.js";

const ALL_ROLES: LendRole[] = ["review", "write"];

function writing(step: "write" | "fix") {
  const h = harness(); // Keeps the old review-only entry throughout the lifecycle.
  const branch = lendBranch("T93", FP)!;
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [{ ...polled(), step }], pollAfterMs: 30_000 } });
  h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: { ...wire(), step }, text: TEXT, sha256: sha(TEXT),
    lease: { gen: 1, expiresAt: 0, ms: 600_000 }, write: { branch, base: "main" } } });
  return h;
}

describe("old lender roles have no effect", () => {
  for (const step of ["write", "fix"] as const) {
    test(`review-only grant runs ${step}, renews, and delivers`, async () => {
      const h = writing(step);
      try {
        await toStarted(h);
        expect(h.lend.lend[0].roles).toEqual(["review"]);
        expect(h.log.created).toHaveLength(1);
        expect(h.log.sent).toHaveLength(1);
        h.advanceTime(61_000);
        await h.tick();
        expect(h.calls.some((c) => c.op === "lease" && c.body.action === "renew")).toBe(true);
        expect(getOrder(h.db, "o1")!.state).toBe("started");
        advance(h.db, "o1", "started", "result_pending", { work: { head: "c".repeat(40), summary: "done", selfCheck: "checked" } });
        await h.tick();
        expect(getOrder(h.db, "o1")!.state).toBe("acked");
        expect(h.ops()).toContain("result");
      } finally { h.db.close(); }
    });
  }

  test("review-only grant still rejects writing when push permission is missing", async () => {
    const h = writing("write");
    try {
      h.d.push.probe = async () => ({ ok: false, reason: "没有推送权限", retry: false });
      for (let n = 0; n < 5; n++) await h.tick();
      expect(getOrder(h.db, "o1")).toMatchObject({ state: "released", reason: expect.stringContaining("推送权限") });
      expect(h.log.created).toEqual([]);
      expect(h.calls.some((c) => c.op === "lease" && c.body.reason === "not_started")).toBe(true);
    } finally { h.db.close(); }
  });

  test("hello and v1 poll report both roles through unchanged parsers", () => {
    const h = harness();
    try {
      const body = helloBody(h.db, h.lend.lend[0], h.d.now());
      expect(body.grant!.roles).toEqual(ALL_ROLES);
      const parsed = parseV2Request("hello", { v: 1, ...body, boot: "compat-boot-0001", seq: 1 });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.grant!.roles.includes("write")).toBe(true);
      const capacity = lendPollCapacity(h.lend.lend[0], h.db, h.d.now());
      expect(capacity.roles).toEqual(ALL_ROLES);
      expect(parseLendRequest("poll", { v: 1, capacity }).ok).toBe(true);
      expect(helloBody(h.db, undefined, h.d.now()).grant).toBeNull();
    } finally { h.db.close(); }
  });

  test("read ignores missing or arbitrary lender roles, leaves borrow alone and never rewrites disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lend-roles-"));
    try {
      const path = join(dir, "lend.json");
      const borrow: BorrowEntry[] = [{ peer: "team-a", fp: FP, projects: ["orch"], roles: ["review"], maxOpen: 3 }];
      for (const roles of [undefined, ["review"], ["write"], [], ["admin"], null, "unused"]) {
        const raw = JSON.stringify({ version: 2, enabled: true, lend: [{ ...ENTRY, roles }], borrow });
        writeFileSync(path, raw);
        const read = await readLend(path);
        expect(read.status).toBe("ok");
        expect(read.file.lend[0].roles).toEqual(ALL_ROLES);
        expect(read.file.borrow).toEqual(borrow);
        expect(readLendSync(path)).toEqual(read);
        expect(readFileSync(path, "utf8")).toBe(raw);
      }
      const ctx = { contacts: [{ name: "team-a", fp: FP }], projects: [{ id: "orch", name: "orch", dirs: [dir], createdAt: "" }] };
      const checks = await checkLend(path, ctx, Date.parse(ENTRY.grantedAt!), join(dir, "missing.sqlite"));
      expect(checks[0].status).toBe("ok");
      expect(checks[0].detail).toContain("codex 2");
      expect(checks[0].detail).not.toMatch(/review|write|角色/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
