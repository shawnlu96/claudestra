/** scripts/scheduler-memory-probe.ts 读 footprint(1) 的输出：读错单位或行，探针的通过 / 不通过就是假的 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFootprint, snapshot } from "../scripts/scheduler-memory-probe.ts";

const SAMPLE = `======================================================================
bun [53917]: 64-bit    Footprint: 3626 MB (16384 bytes per page)
======================================================================

  Dirty      Clean  Reclaimable    Regions    Category
    ---        ---          ---        ---    ---
3554 MB        0 B        15 MB        120    WebKit malloc
  48 MB        0 B      5920 KB         10    IOAccelerator
6880 KB        0 B      3456 KB        545    JS VM Gigacage
`;

test("取总 footprint 与 WebKit malloc 的 Dirty 列", () => {
  expect(parseFootprint(SAMPLE)).toEqual({ physMb: 3626, webkitMb: 3554 });
});

test("KB / GB 换算成 MB", () => {
  const out = SAMPLE.replace("Footprint: 3626 MB", "Footprint: 2 GB").replace("3554 MB        0 B", "512 KB        0 B");
  expect(parseFootprint(out)).toEqual({ physMb: 2048, webkitMb: 0.5 });
});

test("缺行 → NaN（不当成 0，免得把读不到算成没涨）", () => {
  const r = parseFootprint("nothing here");
  expect(Number.isNaN(r.physMb) && Number.isNaN(r.webkitMb)).toBe(true);
});

/** 快照带着整份私有台账和出借 journal（Shawn PR863-r1 P1 snapshot-permissions）：只用合成数据 */
describe("snapshot 权限", () => {
  const mode = (p: string) => statSync(p).mode & 0o777;
  let oldMask = 0;
  beforeEach(() => { oldMask = process.umask(0o022); });
  afterEach(() => { process.umask(oldMask); });

  function source(): string {
    const from = mkdtempSync(join(tmpdir(), "smp-src-"));
    writeFileSync(join(from, "registry.json"), JSON.stringify({ agents: {} }));
    writeFileSync(join(from, "scheduler.json"), "{}");
    mkdirSync(join(from, "acp-activity"));
    writeFileSync(join(from, "acp-activity", "agent-x.json"), "{}");
    symlinkSync(join(from, "registry.json"), join(from, "acp-activity", "link.json"));
    mkdirSync(join(from, "lend", "claude-config", "agent-lend-x"), { recursive: true });
    writeFileSync(join(from, "lend", "claude-config", "agent-lend-x", "run.json"), "{}");
    for (const f of ["ledger.sqlite", join("lend", "journal.sqlite")]) {
      const db = new Database(join(from, f));
      db.run("PRAGMA journal_mode = WAL");
      db.run("CREATE TABLE secret (v TEXT)");
      db.run("INSERT INTO secret VALUES ('合成私有行')");
      db.close();
    }
    return from;
  }

  test("umask 022 下：目录 0700、库与其余复制件 0600、源里的 symlink 不跟", () => {
    const to = join(mkdtempSync(join(tmpdir(), "smp-dst-")), "snap");
    snapshot(source(), to);
    for (const d of ["", "lend", "run", "acp-activity", join("lend", "claude-config"), join("lend", "claude-config", "agent-lend-x")])
      expect([d, mode(join(to, d))]).toEqual([d, 0o700]);
    for (const f of ["ledger.sqlite", join("lend", "journal.sqlite"), "registry.json", "scheduler.json", join("acp-activity", "agent-x.json"),
      join("lend", "claude-config", "agent-lend-x", "run.json")]) expect([f, mode(join(to, f))]).toEqual([f, 0o600]);
    expect(existsSync(join(to, "acp-activity", "link.json"))).toBe(false);
    const db = new Database(join(to, "ledger.sqlite"), { readonly: true });
    expect(db.query("SELECT v FROM secret").get()).toEqual({ v: "合成私有行" }); // 回放要的是同一份内容
    db.close();
  });

  test("已存在的目标：只收本用户的空 0700 目录", () => {
    const from = source(), base = mkdtempSync(join(tmpdir(), "smp-dst-"));
    const open = join(base, "open"); mkdirSync(open); chmodSync(open, 0o755);
    expect(() => snapshot(from, open)).toThrow(/not an empty private directory/);
    const full = join(base, "full"); mkdirSync(full, { mode: 0o700 }); writeFileSync(join(full, "x"), "");
    expect(() => snapshot(from, full)).toThrow(/not an empty private directory/);
    const empty = join(base, "empty"); mkdirSync(empty, { mode: 0o700 });
    snapshot(from, empty);
    expect(mode(join(empty, "ledger.sqlite"))).toBe(0o600);
  });

  test("目标本身或上级是（非 root 的）symlink：拒绝，什么都不写", () => {
    const from = source(), base = mkdtempSync(join(tmpdir(), "smp-dst-")), real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(base, "link"));
    expect(() => snapshot(from, join(base, "link"))).toThrow(/symlink/);
    expect(() => snapshot(from, join(base, "link", "snap"))).toThrow(/symlink/);
    expect(readdirSync(real)).toEqual([]);
  });
});
