import { EnrollmentResponses } from "./shared-ledger-migration-http-fixture.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSharedLedgerJoin, parseJoinArgs, readJoinCodeFile } from "../src/manager/shared-ledger-join-cmd.js";
import { writeProjects } from "../src/lib/projects.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";

let root: string, responses: EnrollmentResponses, url: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sl-migration-http-"));
  responses = new EnrollmentResponses();
  url = responses.url;
});
afterAll(() => { responses.close(); rmSync(root, { recursive: true, force: true }); });
const stateFiles = ["shared-ledger-bindings.json", "shared-ledger-credentials.json", "projects.json"].map((name) => join(STATE_DIR, name));
let savedState: { content: Buffer; mode: number }[];
beforeEach(async () => {
  savedState = stateFiles.map((path) => existsSync(path)
    ? { content: readFileSync(path), mode: statSync(path).mode & 0o777 } : { content: Buffer.alloc(0), mode: 0 });
  await writeProjects({ projects: [{ id: "project-a", name: "Local", dirs: [], createdAt: "" }] });
});
afterEach(() => {
  for (const [i, path] of stateFiles.entries()) {
    const saved = savedState[i]!;
    if (saved.mode) writeFileSync(path, saved.content, { mode: saved.mode });
    else rmSync(path, { force: true });
  }
});
const mint = (person: string) => responses.invite({ personId: person, actions: ["read"] }).joinCode;

async function run(args: string[], stdin = async () => "") {
  const out: string[] = [];
  const spies = (["log", "error", "warn"] as const).map((m) => spyOn(console, m).mockImplementation((...a) => { out.push(a.join(" ")); }));
  try { await cmdSharedLedgerJoin(args, stdin); } finally { for (const s of spies) s.mockRestore(); }
  return { text: out.join("\n"), result: JSON.parse(out.at(-1) ?? "{}") as Record<string, unknown> };
}

describe("manager shared-ledger-join", () => {
  test("no explicit project refuses before stdin is read", async () => {
    let reads = 0;
    const result = await run(["--url", url], async () => { reads++; return mint("no-choice"); });
    expect(result.result.ok).toBe(false);
    expect(reads).toBe(0);
    expect(parseJoinArgs(["--url", url])).toContain("usage");
  });
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
    const r = await run(["--url", url, "--project", "project-a"], async () => `${code}\n`);
    expect(r.result).toMatchObject({ ok: true, teamId: "team-a", personId: "peer-a", projectId: "project-a", kind: "person" });
    const cred = resolveSharedLedgerCredential("owner:self", "person", String(r.result.centerId), "team-a", "project-a", "read")!;
    expect(statSync(join(STATE_DIR, "shared-ledger-credentials.json")).mode & 0o777).toBe(0o600);
    for (const s of [code, cred.bearer]) expect(r.text.includes(s)).toBe(false);
    const again = await run(["--url", url, "--project", "project-a"], async () => code); // Same instance key retrying its redeemed code is idempotent (i28-JN2).
    expect(again.result).toMatchObject({ ok: true, personId: "peer-a" });
  });

  test("code file path joins; a rejected code yields a fixed error", async () => {
    const file = join(root, "code.txt");
    writeFileSync(file, mint("peer-a"), { mode: 0o600 }); // Same instance re-enrolls as the same person.
    const viaFile = await run(["--url", url, "--project", "project-a", "--code-file", file]);
    expect(viaFile.result).toMatchObject({ ok: true });
    expect((await run(["--url", url, "--project", "project-a"], async () => "not-a-code")).result).toEqual({ ok: false, error: "invalid join code" });
    expect((await run(["--url", "http://example.com/", "--project", "project-a"], async () => mint("peer-c"))).result).toEqual({ ok: false, error: "center requires HTTPS" });
  });
});
