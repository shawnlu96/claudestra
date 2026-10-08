import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendCheckPermit, type LendCheckConfig } from "../src/lib/lend-check-permit.ts";

// FLK3 A regression guard: the unlinked-journal window is too short to hit deterministically with real processes,
// so the exact lstat snapshot is injected at the product's own lstat boundary. Only suffix=-journal, isFile=true,
// nlink=0 may become retryable store_busy; every neighbouring shape must stay blocked. All cases write nothing.
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const config: LendCheckConfig = { mode: "on", ownerApproval: { maxConcurrentFullChecks: 2, approvedBy: "fixture-owner", reference: "test-only" } };
const deps = { verifyOwnerApproval: () => true, observeCheckTree: () => "absent" as const };
const acquire = (directory: string, id: string) =>
  lendCheckPermit({ directory, request: { id, orderId: "o", workerId: "w", cost: "full" }, action: "acquire", config }, undefined, deps);

type Snapshot = { isFile: boolean; nlink: number } | { code: string };
function withSidecar(suffix: string, snapshot: Snapshot, run: () => ReturnType<typeof acquire>) {
  const real = fs.lstatSync;
  const seen: string[] = [];
  const spy = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    const name = String(path);
    if (name.endsWith("lend-check-permit.sqlite" + suffix)) {
      seen.push(suffix);
      if ("code" in snapshot) throw Object.assign(new Error(`injected ${snapshot.code}`), { code: snapshot.code });
      return { isFile: () => snapshot.isFile, nlink: snapshot.nlink };
    }
    if (/lend-check-permit\.sqlite(-journal|-wal|-shm)?$/.test(name)) seen.push(name.slice(name.lastIndexOf(".sqlite") + 7));
    return (real as (...args: unknown[]) => unknown)(path, ...rest);
  }) as never);
  try { return { result: run(), seen }; } finally { spy.mockRestore(); }
}
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "check-permit-exact-")); roots.push(dir);
  expect(acquire(dir, "seed").status).toBe("granted");
  const path = join(fs.realpathSync(dir), "lend-check-permit.sqlite");
  return { dir, path, before: readFileSync(path).toString("base64") };
}
function unchanged(path: string, before: string) {
  expect(readFileSync(path).toString("base64")).toBe(before);
  for (const suffix of ["-journal", "-wal", "-shm"]) expect(existsSync(path + suffix)).toBe(false);
}

test("exact unlinked -journal snapshot is store_busy before the store is opened: zero grant, zero write", () => {
  const { dir, path, before } = seeded();
  const { result, seen } = withSidecar("-journal", { isFile: true, nlink: 0 }, () => acquire(dir, "next"));
  expect(result).toMatchObject({ status: "busy", reasonCode: "store_busy", retryable: true, allowed: false });
  // Short-circuits at -journal: no later sidecar check, no Database open or transaction.
  expect(seen).toEqual(["", "-journal"]);
  unchanged(path, before);
  // The existing busy retry then proceeds normally once the window has passed.
  expect(acquire(dir, "next")).toMatchObject({ status: "granted", allowed: true });
  expect(acquire(dir, "third")).toMatchObject({ status: "queued", allowed: false });
});

test("every neighbouring sidecar shape and read failure stays a non-retryable block with zero writes", () => {
  const cases: Array<[string, string, Snapshot]> = [
    ["main nlink=0", "", { isFile: true, nlink: 0 }],
    ["-wal nlink=0", "-wal", { isFile: true, nlink: 0 }],
    ["-shm nlink=0", "-shm", { isFile: true, nlink: 0 }],
    ["-journal non-regular nlink=0", "-journal", { isFile: false, nlink: 0 }],
    ["-journal hardlink nlink=2", "-journal", { isFile: true, nlink: 2 }],
    ["-journal non-regular nlink=1", "-journal", { isFile: false, nlink: 1 }],
    ["-journal EACCES", "-journal", { code: "EACCES" }],
    ["-journal EPERM", "-journal", { code: "EPERM" }],
    ["-journal EIO", "-journal", { code: "EIO" }],
    ["main EACCES", "", { code: "EACCES" }],
  ];
  for (const [name, suffix, snapshot] of cases) {
    const { dir, path, before } = seeded();
    const { result } = withSidecar(suffix, snapshot, () => acquire(dir, "next"));
    expect({ name, result }).toMatchObject({ name, result: { status: "blocked", reasonCode: "store_or_identity", retryable: false, allowed: false } });
    unchanged(path, before);
  }
});
