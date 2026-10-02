import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/shared-ledger/store.js";
import { LedgerService } from "../src/shared-ledger/service.js";
import { startServer } from "../src/shared-ledger/server.js";
import { createJoinCode } from "../src/shared-ledger/join.js";
import { cmdSharedLedgerJoin, parseJoinArgs, readJoinCodeFile } from "../src/manager/shared-ledger-join-cmd.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";

let root: string, store: Store, server: ReturnType<typeof startServer>, url: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sl-join-cmd-"));
  store = new Store(join(root, "center.sqlite"));
  server = startServer(new LedgerService(store));
  url = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => { server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });
const mint = (person: string) => createJoinCode(store, { teamId: "team-a", projectId: "project-a", personId: person, memberCode: person,
  role: "member", actions: ["read"], ttlMs: 3_600_000 }).code;
async function run(args: string[], stdin = async () => "") {
  const out: string[] = [];
  const spies = (["log", "error", "warn"] as const).map((m) => spyOn(console, m).mockImplementation((...a) => { out.push(a.join(" ")); }));
  try { await cmdSharedLedgerJoin(args, stdin); } finally { for (const s of spies) s.mockRestore(); }
  return { text: out.join("\n"), result: JSON.parse(out.at(-1) ?? "{}") as Record<string, unknown> };
}

describe("manager shared-ledger-join", () => {
  test("join codes are refused in argv without echoing them", async () => {
    const code = mint("peer-argv");
    expect(parseJoinArgs(["--url", url, "--code", code])).toContain("命令行");
    expect(parseJoinArgs(["--url", url, code])).toContain("命令行");
    const r = await run(["--url", url, "--code", code]);
    expect(r.result.ok).toBe(false);
    expect(r.text.includes(code)).toBe(false);
    expect(parseJoinArgs([])).toContain("usage");
  });

  test("code files must be 0600", () => {
    const loose = join(root, "loose.txt");
    writeFileSync(loose, mint("peer-loose"), { mode: 0o644 });
    expect(() => readJoinCodeFile(loose)).toThrow("0600");
    const tight = join(root, "tight.txt");
    writeFileSync(tight, "x", { mode: 0o600 });
    expect(readJoinCodeFile(tight)).toBe("x");
  });

  test("stdin join writes a 0600 credential and prints neither code nor bearer", async () => {
    const code = mint("peer-a");
    const r = await run(["--url", url], async () => `${code}\n`);
    expect(r.result).toMatchObject({ ok: true, teamId: "team-a", personId: "peer-a", projectId: "project-a", kind: "person" });
    const cred = resolveSharedLedgerCredential("owner:self", "person", String(r.result.centerId), "team-a", "project-a", "read")!;
    expect(statSync(join(STATE_DIR, "shared-ledger-credentials.json")).mode & 0o777).toBe(0o600);
    for (const s of [code, cred.bearer]) expect(r.text.includes(s)).toBe(false);
    const again = await run(["--url", url], async () => code);
    expect(again.result).toEqual({ ok: false, error: "join rejected" });
  });

  test("code file path joins; a rejected code yields a fixed error", async () => {
    const file = join(root, "code.txt");
    writeFileSync(file, mint("peer-a"), { mode: 0o600 }); // Same instance re-enrolls as the same person.
    const viaFile = await run(["--url", url, "--code-file", file]);
    expect(viaFile.result).toMatchObject({ ok: true });
    expect((await run(["--url", url], async () => "not-a-code")).result).toEqual({ ok: false, error: "invalid join code" });
    expect((await run(["--url", "http://example.com/"], async () => mint("peer-c"))).result).toEqual({ ok: false, error: "center requires HTTPS" });
  });
});
