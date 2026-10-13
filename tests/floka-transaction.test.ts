import { describe, expect, test, afterEach } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireLock } from "../src/lib/file-lock.ts";
import { lockPath } from "../src/lib/floka-migration/transaction/journal.ts";
import { effectiveMode, parseTxMode, rollbackTransaction, runTransaction, type TxOptions, type TxStep } from "../src/lib/floka-migration/transaction/executor.ts";

class Crash extends Error {}

interface Fx { root: string; input: string; state: string; applies: Record<string, number>; failCompensate: Set<string>; failApply: Set<string>; failVerify: Set<string> }

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture(): Fx {
  const root = mkdtempSync(join(tmpdir(), "floka-tx-"));
  roots.push(root);
  const input = join(root, "input");
  mkdirSync(input);
  writeFileSync(join(input, "s1.txt"), "old-1");
  writeFileSync(join(input, "s3.txt"), "old-3");
  return { root, input, state: join(root, "state"), applies: {}, failCompensate: new Set(), failApply: new Set(), failVerify: new Set() };
}

type Before = { exists: boolean; content: string };

/** 每步把 input/<id>.txt 改成 new-<id>;旧值仅包含恢复文件所需的无损内容 */
function fileStep(fx: Fx, id: string, item = "files"): TxStep<Fx> {
  const path = join(fx.input, `${id}.txt`);
  const want = `new-${id}`;
  return {
    id,
    item,
    recovery: `restore ${id}.txt`,
    read: async () => ({ exists: existsSync(path), content: existsSync(path) ? readFileSync(path, "utf8") : "" }),
    conflicts: async (_a, before) => ((before as Before).content === "conflict" ? [`${id}.txt 内容被人改过`] : []),
    done: async () => existsSync(path) && readFileSync(path, "utf8") === want,
    apply: async () => {
      fx.applies[id] = (fx.applies[id] ?? 0) + 1;
      if (fx.failApply.has(id)) throw new Error(`boom token=supersecretvalue123 at ${id}`);
      writeFileSync(path, want);
    },
    verify: async () => !fx.failVerify.has(id) && readFileSync(path, "utf8") === want,
    compensate: async (_a, before) => {
      if (fx.failCompensate.has(id)) throw new Error(`restore failed password=hunter2hunter2 at ${id}`);
      const b = before as Before;
      if (b.exists) writeFileSync(path, b.content);
      else rmSync(path, { force: true });
    },
  };
}

function opts(fx: Fx, over: Partial<TxOptions<Fx>> = {}): TxOptions<Fx> {
  return {
    txId: "tx-1",
    mode: "on",
    items: { files: "on" },
    steps: ["s1", "s2", "s3"].map((id) => fileStep(fx, id)),
    adapter: fx,
    stateDir: fx.state,
    ...over,
  };
}

const crashAt = (target: string) => (p: string) => { if (p === target) throw new Crash(target); };
const journalPath = (fx: Fx) => join(fx.state, "tx-1.journal.json");
const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")]));
const read = (fx: Fx, id: string) => readFileSync(join(fx.input, `${id}.txt`), "utf8");

describe("开关", () => {
  test("rename.transaction 缺省 / 非法值都是 off;分项取总开关和分项的较小者", () => {
    expect(parseTxMode(undefined)).toBe("off");
    expect(parseTxMode("ON")).toBe("off");
    expect(parseTxMode("observe")).toBe("observe");
    expect(effectiveMode("on", undefined)).toBe("off");
    expect(effectiveMode("on", "observe")).toBe("observe");
    expect(effectiveMode("observe", "on")).toBe("observe");
  });

  test("off 什么都不调,也不建状态目录", async () => {
    const fx = fixture();
    const r = await runTransaction(opts(fx, { mode: "off" }));
    expect(r.status).toBe("off");
    expect(fx.applies).toEqual({});
    expect(existsSync(fx.state)).toBe(false);
  });

  test("总开关 on 不覆盖没批准的分项:未批准的步骤只列出不执行", async () => {
    const fx = fixture();
    const steps = [fileStep(fx, "s1"), fileStep(fx, "s2", "names"), fileStep(fx, "s3", "later")];
    const r = await runTransaction(opts(fx, { steps, items: { files: "on", names: "observe" } }));
    expect(r.status).toBe("committed");
    expect(r.steps.map((s) => [s.id, s.mode, s.state])).toEqual([["s1", "on", "applied"], ["s2", "observe", "planned"], ["s3", "off", "skipped"]]);
    expect(fx.applies).toEqual({ s1: 1 });
    expect(read(fx, "s3")).toBe("old-3");
  });
});

describe("[验收线 1] 崩溃注入与重跑", () => {
  const points = ["s1", "s2", "s3"].flatMap((id) => ["before", "journaled", "applied", "committed"].map((p) => `${p}:${id}`));
  for (const point of points) {
    test(`崩在 ${point} 后重跑:每步副作用恰好一次`, async () => {
      const fx = fixture();
      await expect(runTransaction(opts(fx, { crashAt: crashAt(point) }))).rejects.toBeInstanceOf(Crash);
      const r = await runTransaction(opts(fx));
      expect(r.status).toBe("committed");
      expect(fx.applies).toEqual({ s1: 1, s2: 1, s3: 1 });
      expect(["s1", "s2", "s3"].map((id) => read(fx, id))).toEqual(["new-s1", "new-s2", "new-s3"]);
      expect(existsSync(join(fx.state, "tx-1.lock"))).toBe(false);
      const again = await runTransaction(opts(fx));
      expect(again.status).toBe("committed");
      expect(fx.applies).toEqual({ s1: 1, s2: 1, s3: 1 });
    });
  }

  test("回滚中途崩溃,重跑续上逆序补偿", async () => {
    const fx = fixture();
    fx.failVerify.add("s3");
    await expect(runTransaction(opts(fx, { crashAt: crashAt("compensate:s1") }))).rejects.toBeInstanceOf(Crash);
    const r = await runTransaction(opts(fx));
    expect(r.status).toBe("rolled_back");
    expect(snapshot(fx.input)).toEqual(snapshot(fixtureLike(fx)));
  });

  const corruptions: [string, (raw: string) => string, RegExp][] = [
    ["日志不是 JSON", () => "{garbage", /损坏/],
    ["版本未知", (raw) => raw.replace(/"version": 2/, '"version": 9'), /版本/],
    ["内容被改(校验不符)", (raw) => raw.replace(/"status": "running"/, '"status": "committed"'), /校验/],
  ];
  for (const [name, mutate, msg] of corruptions) {
    test(`${name} → 拒绝继续,不碰输入`, async () => {
      const fx = fixture();
      await expect(runTransaction(opts(fx, { crashAt: crashAt("journaled:s2") }))).rejects.toBeInstanceOf(Crash);
      writeFileSync(journalPath(fx), mutate(readFileSync(journalPath(fx), "utf8")));
      const before = snapshot(fx.input);
      const r = await runTransaction(opts(fx));
      expect(r.status).toBe("refused");
      expect(r.error).toMatch(msg);
      expect(snapshot(fx.input)).toEqual(before);
      expect(fx.applies).toEqual({ s1: 1 });
      expect((await rollbackTransaction(opts(fx))).status).toBe("refused");
    });
  }

  test("步骤清单和日志对不上 → 拒绝", async () => {
    const fx = fixture();
    await expect(runTransaction(opts(fx, { crashAt: crashAt("before:s2") }))).rejects.toBeInstanceOf(Crash);
    const r = await runTransaction(opts(fx, { steps: [fileStep(fx, "s1"), fileStep(fx, "s3")] }));
    expect(r.status).toBe("refused");
    expect(r.error).toMatch(/步骤/);
  });

  test("锁被别人拿着 → 拒绝,不执行", async () => {
    const fx = fixture();
    mkdirSync(fx.state);
    const lock = await acquireLock(join(fx.state, "tx-1.lock"), 0);
    try {
      const r = await runTransaction(opts(fx, { lockWaitMs: 0 }));
      expect(r.status).toBe("refused");
      expect(r.error).toMatch(/锁/);
      expect(fx.applies).toEqual({});
    } finally { lock?.release(); }
  });
});

/** 夹具的初始输入(给逐字节比对用) */
function fixtureLike(fx: Fx): string {
  const dir = join(fx.root, "expected");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.txt"), "old-1");
  writeFileSync(join(dir, "s3.txt"), "old-3");
  return dir;
}

describe("[验收线 2] observe 只读", () => {
  test("只返回计划与冲突,不建事务文件和锁文件,输入逐字节不变", async () => {
    const fx = fixture();
    writeFileSync(join(fx.input, "s3.txt"), "conflict");
    const before = snapshot(fx.input);
    const r = await runTransaction(opts(fx, { mode: "observe" }));
    expect(r.status).toBe("observed");
    expect(r.steps.map((s) => [s.id, s.state])).toEqual([["s1", "planned"], ["s2", "planned"], ["s3", "planned"]]);
    expect(r.steps[2]!.conflicts).toEqual(["s3.txt 内容被人改过"]);
    expect(existsSync(fx.state)).toBe(false);
    expect(snapshot(fx.input)).toEqual(before);
    expect(fx.applies).toEqual({});
  });

  test("on 遇到冲突先拒绝,不建日志、不动输入", async () => {
    const fx = fixture();
    writeFileSync(join(fx.input, "s3.txt"), "conflict");
    const before = snapshot(fx.input);
    const r = await runTransaction(opts(fx));
    expect(r.status).toBe("refused");
    expect(r.error).toMatch(/冲突/);
    expect(existsSync(journalPath(fx))).toBe(false);
    expect(snapshot(fx.input)).toEqual(before);
  });
});

describe("[验收线 3] 回滚", () => {
  test("校验失败 → 逆序补偿,输入回到原样", async () => {
    const fx = fixture();
    fx.failVerify.add("s2");
    const r = await runTransaction(opts(fx));
    expect(r.status).toBe("rolled_back");
    expect(r.failedStep).toBe("s2");
    expect(r.steps.map((s) => s.state)).toEqual(["compensated", "compensated"]);
    expect(snapshot(fx.input)).toEqual(snapshot(fixtureLike(fx)));
    expect((await runTransaction(opts(fx))).status).toBe("refused");
  });

  test("补偿失败保留可诊断步骤、报告错误,报告和日志都不含凭据明文", async () => {
    const fx = fixture();
    fx.failApply.add("s3");
    fx.failCompensate.add("s2");
    const r = await runTransaction(opts(fx));
    expect(r.status).toBe("rollback_failed");
    expect(r.failedStep).toBe("s3");
    expect(r.error).toContain("boom");
    expect(r.steps.map((s) => [s.id, s.state])).toEqual([["s1", "applied"], ["s2", "compensate_failed"], ["s3", "compensated"]]);
    expect(r.steps[1]!.error).toContain("restore failed");
    const raw = readFileSync(journalPath(fx), "utf8");
    for (const leak of ["supersecretvalue123", "hunter2hunter2", "sk-livesecret"]) {
      expect(JSON.stringify(r)).not.toContain(leak);
      expect(raw).not.toContain(leak);
    }
    expect(read(fx, "s1")).toBe("new-s1");

    const stuck = await runTransaction(opts(fx));
    expect(stuck.status).toBe("refused");
    expect(stuck.error).toMatch(/回滚/);
    fx.failCompensate.clear();
    const done = await rollbackTransaction(opts(fx));
    expect(done.status).toBe("rolled_back");
    expect(snapshot(fx.input)).toEqual(snapshot(fixtureLike(fx)));
  });

  test("读旧值失败也走补偿(只补偿已动过的步骤)", async () => {
    const fx = fixture();
    const steps = opts(fx).steps;
    const s2 = steps[1]!;
    // 预检时读得到,s1 动手之后才读失败(执行途中权限变了)
    steps[1] = { ...s2, read: async (a) => { if (fx.applies.s1) throw new Error("read denied secret=abcdefgh1234"); return s2.read(a); } };
    const r = await runTransaction(opts(fx, { steps }));
    expect(r.status).toBe("rolled_back");
    expect(r.failedStep).toBe("s2");
    expect(r.error).not.toContain("abcdefgh1234");
    expect(read(fx, "s1")).toBe("old-1");
  });
});

describe("P1 review regressions", () => {
  const secret = "sk-livesecretAAAABBBBCCCC1234";
  test("conflicts and recovery descriptions never disclose credentials", async () => {
    const fx = fixture();
    const base = fileStep(fx, "s1");
    for (const mode of ["observe", "on"] as const) {
      const r = await runTransaction(opts(fx, { mode, steps: [{ ...base, conflicts: async () => [secret] }] }));
      expect(JSON.stringify(r)).not.toContain(secret);
    }
    fx.failVerify.add("s1");
    fx.failCompensate.add("s1");
    const r = await runTransaction(opts(fx, { steps: [{ ...base, recovery: secret }] }));
    expect(r.status).toBe("rollback_failed");
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(readFileSync(journalPath(fx), "utf8")).not.toContain(secret);
  });

  test("lossy old values are refused before mutation, including restart", async () => {
    const fx = fixture();
    const base = fileStep(fx, "s1");
    const steps = [{
      ...base,
      read: async () => ({ password: secret }),
      compensate: async (_a: Fx, before: unknown) => writeFileSync(join(fx.input, "s1.txt"), JSON.stringify(before)),
    }];
    fx.failVerify.add("s1");
    const o = opts(fx, { steps });
    expect((await runTransaction(o)).status).toBe("refused");
    expect(fx.applies).toEqual({});
    expect((await runTransaction(o)).status).toBe("refused");
    expect(fx.applies).toEqual({});
    expect(existsSync(journalPath(fx))).toBe(false);
  });

  test("duplicate ids are refused without adapter calls or state files", async () => {
    const fx = fixture();
    const s = fileStep(fx, "s1");
    let reads = 0;
    const duplicate = { ...s, read: async () => { reads++; return null; } };
    const r = await runTransaction(opts(fx, { steps: [duplicate, duplicate] }));
    expect(r.status).toBe("refused");
    expect(reads).toBe(0);
    expect(fx.applies).toEqual({});
    expect(existsSync(fx.state)).toBe(false);
  });
});

test("protected backup references survive crash and restore exact secret content", async () => {
  const fx = fixture();
  const secret = "sk-livesecretAAAABBBBCCCC1234";
  const path = join(fx.input, "s1.txt");
  const backup = join(fx.root, "protected-backup");
  writeFileSync(path, secret);
  writeFileSync(backup, secret, { mode: 0o600 });
  const base = fileStep(fx, "s1");
  const steps = [{
    ...base,
    read: async () => ({ backupRef: "original-s1" }),
    compensate: async (_a: Fx, before: unknown) => {
      expect(before).toEqual({ backupRef: "original-s1" });
      writeFileSync(path, readFileSync(backup));
    },
  }];
  fx.failVerify.add("s1");
  await expect(runTransaction(opts(fx, { steps, crashAt: crashAt("applied:s1") }))).rejects.toBeInstanceOf(Crash);
  expect(readFileSync(journalPath(fx), "utf8")).not.toContain(secret);
  expect((await runTransaction(opts(fx, { steps }))).status).toBe("rolled_back");
  expect(read(fx, "s1")).toBe(secret);
  expect(fx.applies).toEqual({ s1: 1 });
});

for (const kind of ["duplicate", "reordered", "legacy"] as const) {
  test(`loaded ${kind} journal refuses replay and compensation`, async () => {
    const fx = fixture();
    await expect(runTransaction(opts(fx, { crashAt: crashAt("journaled:s2") }))).rejects.toBeInstanceOf(Crash);
    const { checksum: _sum, ...body } = JSON.parse(readFileSync(journalPath(fx), "utf8"));
    if (kind === "duplicate") body.steps.push(body.steps[0]);
    if (kind === "reordered") body.steps.reverse();
    if (kind === "legacy") body.version = 1;
    const checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    writeFileSync(journalPath(fx), JSON.stringify({ ...body, checksum }));
    const before = snapshot(fx.input);
    expect((await runTransaction(opts(fx))).status).toBe("refused");
    expect((await rollbackTransaction(opts(fx))).status).toBe("refused");
    expect(snapshot(fx.input)).toEqual(before);
    expect(fx.applies).toEqual({ s1: 1 });
  });
}

test("secret-looking file content is refused before any earlier step mutates", async () => {
  for (const content of ["sk-livesecretAAAABBBBCCCC1234", "a".repeat(64)]) {
    const fx = fixture();
    writeFileSync(join(fx.input, "s3.txt"), content);
    const before = snapshot(fx.input);
    expect((await runTransaction(opts(fx))).status).toBe("refused");
    expect(fx.applies).toEqual({});
    expect(snapshot(fx.input)).toEqual(before);
    expect(existsSync(journalPath(fx))).toBe(false);
  }
});

describe("round 2 review regressions", () => {
  test("P1 JSON-lossy old values refuse before apply with or without crash", async () => {
    for (const before of [{ quota: Infinity, ratio: NaN }, { missing: undefined }, { negativeZero: -0 }]) {
      for (const crash of [undefined, crashAt("applied:s1")]) {
        const fx = fixture();
        fx.failVerify.add("s1");
        const s = fileStep(fx, "s1");
        const steps = [{ ...s, read: async () => before as unknown as Awaited<ReturnType<typeof s.read>> }];
        const r = await runTransaction(opts(fx, { steps, crashAt: crash }));
        expect(r.status).toBe("refused");
        expect(fx.applies).toEqual({});
        expect(read(fx, "s1")).toBe("old-1");
        expect(existsSync(journalPath(fx))).toBe(false);
      }
    }
  });

  test("P1 on with observe/off items leaves zero state and can later enable same txId", async () => {
    const fx = fixture();
    const before = snapshot(fx.input);
    const observed = await runTransaction(opts(fx, { items: { files: "observe" } }));
    expect(existsSync(fx.state)).toBe(false);
    expect(observed.status).toBe("observed");
    expect(snapshot(fx.input)).toEqual(before);
    expect((await runTransaction(opts(fx, { items: {} }))).status).toBe("observed");
    expect(existsSync(fx.state)).toBe(false);
    expect((await runTransaction(opts(fx))).status).toBe("committed");
    expect(fx.applies).toEqual({ s1: 1, s2: 1, s3: 1 });
  });

  test("P2 unsafe transaction ids refuse without reads or state", async () => {
    for (const txId of ["../escaped", ".", "..", "", "/absolute", "a/b", "a".repeat(129)]) {
      const fx = fixture();
      let reads = 0;
      const s = fileStep(fx, "s1");
      const steps = [{ ...s, read: async () => { reads++; return null; } }];
      expect((await runTransaction(opts(fx, { txId, steps }))).status).toBe("refused");
      expect((await rollbackTransaction(opts(fx, { txId, steps }))).status).toBe("refused");
      expect((await runTransaction(opts(fx, { mode: "observe", txId, steps }))).status).toBe("refused");
      expect(() => lockPath(fx.state, txId)).toThrow("txId");
      expect(reads).toBe(0);
      expect(existsSync(fx.state)).toBe(false);
      expect(existsSync(join(fx.root, "escaped.journal.json"))).toBe(false);
    }
  });

  test("P2 losing lease in apply stops before verify, next apply or journal write", async () => {
    const fx = fixture();
    const s = fileStep(fx, "s1");
    let saved = "";
    let verifies = 0;
    const steps = [{
      ...s,
      apply: async (a: Fx) => {
        await s.apply(a);
        saved = readFileSync(journalPath(fx), "utf8");
        writeFileSync(join(fx.state, "tx-1.lock", "owner"), "replacement-owner");
      },
      verify: async () => { verifies++; return true; },
    }, fileStep(fx, "s2")];
    const r = await runTransaction(opts(fx, { steps }));
    expect(r.status).toBe("refused");
    expect(r.error).toMatch(/租/);
    expect(fx.applies).toEqual({ s1: 1 });
    expect(verifies).toBe(0);
    expect(readFileSync(journalPath(fx), "utf8")).toBe(saved);
    expect(readFileSync(join(fx.state, "tx-1.lock", "owner"), "utf8")).toBe("replacement-owner");
  });
});

test("lease lost while checking done prevents apply", async () => {
  const fx = fixture();
  const base = fileStep(fx, "s1");
  let saved = "";
  const steps = [{
    ...base,
    done: async () => {
      saved = readFileSync(journalPath(fx), "utf8");
      writeFileSync(join(fx.state, "tx-1.lock", "owner"), "successor");
      return false;
    },
  }];
  expect((await runTransaction(opts(fx, { steps }))).status).toBe("refused");
  expect(fx.applies).toEqual({});
  expect(readFileSync(journalPath(fx), "utf8")).toBe(saved);
});

for (const point of ["before:s1", "journaled:s1", "compensate:s2"]) {
  test(`lease lost at ${point} prevents the next protected action`, async () => {
    const fx = fixture();
    fx.failVerify.add("s2");
    let saved = "";
    const r = await runTransaction(opts(fx, {
      crashAt: (p) => {
        if (p !== point) return;
        saved = readFileSync(journalPath(fx), "utf8");
        writeFileSync(join(fx.state, "tx-1.lock", "owner"), "successor");
      },
    }));
    expect(r.status).toBe("refused");
    expect(readFileSync(journalPath(fx), "utf8")).toBe(saved);
    if (point === "compensate:s2") {
      expect(read(fx, "s1")).toBe("new-s1");
      expect(read(fx, "s2")).toBe("new-s2");
    } else expect(fx.applies).toEqual({});
  });
}

test("lease lost during compensation stops journal writes and earlier compensation; restart resumes", async () => {
  const fx = fixture();
  fx.failVerify.add("s2");
  const base = fileStep(fx, "s2");
  let saved = "";
  const steps = [fileStep(fx, "s1"), {
    ...base,
    compensate: async (a: Fx, before: Parameters<typeof base.compensate>[1]) => {
      await base.compensate(a, before);
      saved = readFileSync(journalPath(fx), "utf8");
      writeFileSync(join(fx.state, "tx-1.lock", "owner"), "successor");
    },
  }];
  expect((await runTransaction(opts(fx, { steps }))).status).toBe("refused");
  expect(readFileSync(journalPath(fx), "utf8")).toBe(saved);
  expect(read(fx, "s1")).toBe("new-s1");
  expect(existsSync(join(fx.input, "s2.txt"))).toBe(false);
  // Release the synthetic successor lock so a new executor can resume idempotent compensation.
  rmSync(join(fx.state, "tx-1.lock"), { recursive: true });
  expect((await rollbackTransaction(opts(fx, { steps: [fileStep(fx, "s1"), base] }))).status).toBe("rolled_back");
  expect(read(fx, "s1")).toBe("old-1");
});

test("safe txId punctuation remains supported", async () => {
  const fx = fixture();
  expect((await runTransaction(opts(fx, { txId: "tx.1-A_b" }))).status).toBe("committed");
  expect(existsSync(join(fx.state, "tx.1-A_b.journal.json"))).toBe(true);
});
