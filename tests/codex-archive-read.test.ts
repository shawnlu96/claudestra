/**
 * T75：Codex 归档的读与写。
 *   specRev 1  首行超过 512 字节的 Codex 归档被嗅探成 CC → 历史 / 搜索为空。归档写 sidecar，老归档读完整首行，读不全算 untrusted
 *   specRev 2  thread/revert 的 `<threadId>_<rolloutId>.jsonl` 被定位器跳过 → ok:true 却只存旧正文。整条链每段各存一份，缺段 ok:false
 * rollout 根走 CODEX_HOME（codexSessionsRoot 每次调用现读环境变量），全部落在临时目录，不碰真实 ~/.codex。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { archiveAgentSession, archiveSession } from "../src/lib/session-archive.js";
import { isValidSessionId, readSessionHistory, searchSessionHistory } from "../src/lib/session-history.js";
import { UNTRUSTED_RUNTIME, sourceIdForPath } from "../src/lib/runtimes/index.js";
import { readFirstLineSync, sessionSidecarPath } from "../src/lib/session-sidecar.js";
import { headThenFrame } from "./zstd-test-kit.js";

const base = mkdtempSync(join(tmpdir(), "codex-archive-read-"));
const realCodexHome = process.env.CODEX_HOME;
const codexHome = join(base, "codex-home");
const sessions = join(codexHome, "sessions");
const cwd = join(base, "repo");
const TS = "2026-09-30T01:02:03.000Z";
const L = (o: unknown) => JSON.stringify(o);
let n = 0;

beforeAll(() => {
  process.env.CODEX_HOME = codexHome;
  mkdirSync(cwd, { recursive: true });
});
afterAll(() => {
  if (realCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = realCodexHome;
  rmSync(base, { recursive: true, force: true });
});

const sid = () => `019a2b3c-4d5e-7f60-8a9b-${String(++n).padStart(12, "0")}`;
const rid = (k: number) => `019a2b3d-1111-7777-8888-${String(k).padStart(12, "0")}`;
const userLine = (text: string) => L({ timestamp: TS, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

/** 写一段 rollout：name 为 `<threadId>` 或 `<threadId>_<rolloutId>`，meta 覆盖 session_meta.payload；.zst 写真的 zstd 流 */
function rollout(stamp: string, name: string, meta: Record<string, unknown>, body: string[], ext = ".jsonl"): string {
  const dir = join(sessions, "2026", "09", stamp.slice(8, 10));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-${stamp}-${name}${ext}`);
  const text = [L({ timestamp: TS, type: "session_meta", payload: { cwd, ...meta } }), ...body].join("\n") + "\n";
  writeFileSync(p, ext.endsWith(".zst") ? Bun.zstdCompressSync(Buffer.from(text)) : text);
  return p;
}

/** 模拟 Codex compression.rs：写 .zst、删明文 */
function compress(p: string): string {
  writeFileSync(`${p}.zst`, Bun.zstdCompressSync(readFileSync(p)));
  rmSync(p);
  return `${p}.zst`;
}

const archiveRoot = () => join(base, `archive-${++n}`);
const texts = async (p: string) => (await readSessionHistory(p)).messages.map((m) => m.text);

describe("specRev 1：首行超过 512 字节的 Codex 归档", () => {
  const OUTSIDER = '<channel source="claudestra" user="guest" user_id="api:guest">\nOUTSIDER MESSAGE\n</channel>';

  test("live 与归档的历史、搜索一致；删掉 sidecar 的老归档读完整首行也一致", async () => {
    const id = sid();
    const live = rollout("2026-09-30T01-02-03", id, { id, base_instructions: { text: "x".repeat(9000) } }, [userLine(OUTSIDER)]);
    expect(sourceIdForPath(live)).toBe("codex");
    const liveTexts = await texts(live);
    expect(liveTexts.join("\n")).toContain("OUTSIDER MESSAGE");
    const liveHits = await searchSessionHistory(live, "outsider message");
    expect(liveHits.length).toBe(1);

    const root = archiveRoot();
    const r = await archiveAgentSession("agent-cx", { cwd, sessionId: id, runtime: "codex" }, undefined, { archiveRoot: root });
    const dest = join(root, "agent-cx", `${id}.jsonl`);
    expect(r).toMatchObject({ ok: true, archived: [dest] });
    expect(JSON.parse(readFileSync(sessionSidecarPath(dest)!, "utf8"))).toEqual({ runtime: "codex" });
    expect(sourceIdForPath(dest)).toBe("codex");
    expect(await texts(dest)).toEqual(liveTexts);
    expect((await searchSessionHistory(dest, "outsider message")).length).toBe(1);

    const old = join(base, `old-archive-${n}`, `${id}.jsonl`); // T75 之前落的归档：没有 sidecar
    mkdirSync(join(old, ".."), { recursive: true });
    copyFileSync(dest, old);
    expect(existsSync(sessionSidecarPath(old)!)).toBe(false);
    expect(sourceIdForPath(old)).toBe("codex");
    expect(await texts(old)).toEqual(liveTexts);
    expect((await searchSessionHistory(old, "outsider message")).length).toBe(1);
  });

  test("Claude Code 的归档不写 sidecar：CC 归档目录保持原样", async () => {
    const src = join(base, `cc-${++n}.jsonl`);
    writeFileSync(src, `${L({ type: "user", timestamp: TS, message: { role: "user", content: "hi" } })}\n`);
    const root = archiveRoot();
    const r = await archiveSession("agent-cc", cwd, "0f1e2d3c-4b5a-6978-8a9b-acbdcedf0102", { srcPath: src, archiveRoot: root });
    expect(r.ok).toBe(true);
    expect(existsSync(sessionSidecarPath(r.archived[0]!)!)).toBe(false);
  });

  test("sidecar 认不出的 runtime 不采信，退回首行嗅探", () => {
    const p = join(base, `bogus-${++n}.jsonl`);
    writeFileSync(p, `${L({ type: "session_meta", payload: { id: "x" } })}\n`);
    writeFileSync(sessionSidecarPath(p)!, L({ runtime: "gpt-9" }));
    expect(sourceIdForPath(p)).toBe("codex");
  });

  test("首行读不全 / 坏 JSON：untrusted，不退成 Claude Code；还没写完换行的不缓存", () => {
    const p = join(base, `half-${++n}.jsonl`);
    writeFileSync(p, '{"type":"session_meta","payload":{"base_instructions":"');
    expect(sourceIdForPath(p)).toBe(UNTRUSTED_RUNTIME);
    writeFileSync(p, `${L({ type: "session_meta", payload: { id: "x" } })}\n`);
    expect(sourceIdForPath(p)).toBe("codex");
  });

  test("readFirstLineSync：跨过多次加宽读到完整首行；超上限 too-long；空文件 unreadable", () => {
    const p = join(base, `wide-${++n}.jsonl`);
    const head = "y".repeat(300_000);
    writeFileSync(p, `${head}\nsecond\n`);
    expect(readFirstLineSync(p)).toEqual({ kind: "line", text: head });
    expect(readFirstLineSync(p, 100_000)).toEqual({ kind: "too-long" });
    writeFileSync(p, "");
    expect(readFirstLineSync(p)).toEqual({ kind: "unreadable" });
    expect(readFirstLineSync(join(base, "nope.jsonl"))).toEqual({ kind: "unreadable" });
  });
});

describe("specRev 2：thread/revert 链", () => {
  const archive = (id: string, root: string) => archiveAgentSession("agent-cx", { cwd, sessionId: id, runtime: "codex" }, undefined, { archiveRoot: root });

  test("原文件 + revert 段：两段各存一份，ok:true，新正文在 `<rolloutId>.jsonl`（历史 API 的 id 白名单收得下）", async () => {
    const id = sid();
    const r1 = rid(n);
    const old = rollout("2026-09-29T01-02-03", id, { id }, [userLine("OLD_ONLY")]);
    const cur = rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id, end_ordinal_exclusive: 1, end_byte_offset: 10 } }, [userLine("LATEST_AFTER_REVERT")]);
    const root = archiveRoot();
    const r = await archive(id, root);
    const destOld = join(root, "agent-cx", `${id}.jsonl`);
    const destCur = join(root, "agent-cx", `${r1}.jsonl`);
    expect(r).toMatchObject({ ok: true, archived: [destOld, destCur] });
    expect(r.note).toContain("revert 链 2 段");
    expect(readFileSync(destOld, "utf8")).toBe(readFileSync(old, "utf8"));
    expect(readFileSync(destCur, "utf8")).toBe(readFileSync(cur, "utf8"));
    expect(await texts(destCur)).toContain("LATEST_AFTER_REVERT");
    expect(sourceIdForPath(destCur)).toBe("codex");
    expect(isValidSessionId(r1)).toBe(true);
  });

  test("旧归档比新段大：不被覆盖也不挡新段（各段文件名不同）", async () => {
    const id = sid();
    const r1 = rid(n);
    rollout("2026-09-29T01-02-03", id, { id }, [userLine("OLD ".repeat(500))]);
    const root = archiveRoot();
    expect((await archive(id, root)).ok).toBe(true);
    rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [userLine("NEW")]);
    const r = await archive(id, root);
    expect(r).toMatchObject({ ok: true, archived: [join(root, "agent-cx", `${r1}.jsonl`)] });
  });

  test("前缀段不在（只有 revert 段）：ok:false，写明缺哪段；能找到的段照拷", async () => {
    const id = sid();
    const r1 = rid(n);
    rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [userLine("LATEST")]);
    const root = archiveRoot();
    const r = await archive(id, root);
    expect(r.ok).toBe(false);
    expect(r.note).toContain(`缺段`);
    expect(r.note).toContain(id);
    expect(r.archived).toEqual([join(root, "agent-cx", `${r1}.jsonl`)]);
  });

  test("前缀段被 Codex 压成 .zst：解压后照样归档，ok:true，内容与压缩前一致", async () => {
    const id = sid();
    const r1 = rid(n);
    rollout("2026-09-29T01-02-03", id, { id }, [userLine("OLD")], ".jsonl.zst");
    rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [userLine("LATEST")]);
    const root = archiveRoot();
    const r = await archive(id, root);
    expect(r.ok).toBe(true);
    const dest = join(root, "agent-cx", `${id}.jsonl`);
    expect(await texts(dest)).toContain("OLD");
    expect(sourceIdForPath(dest)).toBe("codex");
  });

  test("最新段归档后又追加、再被压成 .zst：解压比大小，补上尾巴（不是「无变化」）", async () => {
    const id = sid();
    const r1 = rid(n);
    rollout("2026-09-29T01-02-03", id, { id }, [userLine("S0")]);
    const s1 = rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [userLine("S1_HEAD")]);
    const root = archiveRoot();
    expect((await archive(id, root)).ok).toBe(true);
    writeFileSync(s1, `${readFileSync(s1, "utf8")}${userLine("S1_TAIL_AFTER_ARCHIVE")}\n`);
    const plain = readFileSync(s1, "utf8");
    compress(s1);
    const dest = join(root, "agent-cx", `${r1}.jsonl`);
    expect(await archive(id, root)).toMatchObject({ ok: true, archived: [dest] });
    expect(readFileSync(dest, "utf8")).toBe(plain);
    expect(await archive(id, root)).toMatchObject({ ok: true, archived: [], note: "归档已是最新（无变化）；Codex revert 链 2 段，每段各存一份，最新 " + `rollout-2026-09-30T01-02-03-${id}_${r1}.jsonl.zst` });
  });

  test("整条线程都被压成 .zst、同一段明文和 .zst 都在（压缩中途崩溃）：都照常归档", async () => {
    const id = sid();
    const p = rollout("2026-09-29T01-02-03", id, { id }, [userLine("ONLY_ZST")]);
    compress(p);
    const root = archiveRoot();
    expect((await archive(id, root)).ok).toBe(true);
    expect(await texts(join(root, "agent-cx", `${id}.jsonl`))).toContain("ONLY_ZST");
    const id2 = sid();
    const p2 = rollout("2026-09-29T01-02-03", id2, { id: id2 }, [userLine("BOTH")]);
    writeFileSync(`${p2}.zst`, Bun.zstdCompressSync(readFileSync(p2)).subarray(0, 10)); // 半截 .zst
    expect(await archive(id2, root)).toMatchObject({ ok: true, archived: [join(root, "agent-cx", `${id2}.jsonl`)] });
  });

  // r3：.zst 解压在 bridge 的每日 sweep 里跑，不许全量同步解、不许无上限
  test("冷段帧头大小 ≤ 已有归档：只流式读首行，不整份解压（手搓帧声明与内容不符，真解会失败）", async () => {
    const id = sid();
    const p = rollout("2026-09-29T01-02-03", id, { id }, [userLine("COLD")], ".jsonl.zst");
    const root = archiveRoot();
    expect((await archive(id, root)).ok).toBe(true);
    const dest = join(root, "agent-cx", `${id}.jsonl`);
    const head = readFileSync(dest, "utf8").split("\n")[0]!;
    writeFileSync(p, headThenFrame(head, readFileSync(dest).length));
    const spy = spyOn(zlib, "createZstdDecompress");
    try {
      expect(await archive(id, root)).toMatchObject({ ok: true, archived: [], note: "归档已是最新（无变化）" });
      expect(spy).toHaveBeenCalledTimes(1); // 只有 pick 读首行那一次
    } finally {
      spy.mockRestore();
    }
  });

  test("解压炸弹（帧头声明 2GiB）：ok:false 写明上限，归档目录不留临时文件，旧段照拷", async () => {
    const id = sid();
    const r1 = rid(n);
    rollout("2026-09-29T01-02-03", id, { id }, [userLine("OLD")]);
    const p = rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [], ".jsonl.zst");
    const head = L({ timestamp: TS, type: "session_meta", payload: { cwd, id, history_base: { thread_id: id } } });
    writeFileSync(p, headThenFrame(head, 2 * 1024 * 1024 * 1024));
    const root = archiveRoot();
    const r = await archive(id, root);
    expect(r.ok).toBe(false);
    expect(r.note).toContain("解压超过上限");
    expect(readdirSync(join(root, "agent-cx")).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(r.archived).toEqual([join(root, "agent-cx", `${id}.jsonl`)]);
  });

  // P1（T75 r1）：文件名更新的同线程段没进归档时，不能 ok:true 只存旧正文
  const newerSkipped: Array<[string, (id: string, r1: string) => void, string]> = [
    ["最新段 .zst 解不开", (id, r1) => {
      const p = rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [userLine("NEW")], ".jsonl.zst");
      writeFileSync(p, "not a zstd stream\n");
    }, ".zst 解压失败"],
    ["最新段首行是半截 JSON", (id, r1) => {
      const p = rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id }, []);
      writeFileSync(p, L({ timestamp: TS, type: "session_meta", payload: { id, cwd } }).slice(0, 40));
    }, "首行读不出"],
    ["最新段首行 id 不符", (id, r1) => rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id: sid() }, [userLine("NEW")]), "首行 id 是"],
  ];
  for (const [label, make, why] of newerSkipped) {
    test(`${label}：ok:false，写明是最新段；旧段照拷`, async () => {
      const id = sid();
      const r1 = rid(n);
      rollout("2026-09-29T01-02-03", id, { id }, [userLine("OLD")]);
      make(id, r1);
      const root = archiveRoot();
      const r = await archive(id, root);
      expect(r.ok).toBe(false);
      expect(r.note).toContain(`最新段 ${r1} 没归档`);
      expect(r.note).toContain(why);
      expect(r.archived).toEqual([join(root, "agent-cx", `${id}.jsonl`)]);
    });
  }

  test("回退后被放弃的中间段：.zst 照常解压归档；解不开就 ok:false，写明是哪一段", async () => {
    const id = sid();
    const [a, b] = [rid(n * 10 + 1), rid(n * 10 + 2)];
    rollout("2026-09-28T01-02-03", id, { id }, [userLine("S0")]);
    const s1 = rollout("2026-09-29T01-02-03", `${id}_${a}`, { id, history_base: { thread_id: id } }, [userLine("S1")], ".jsonl.zst");
    rollout("2026-09-30T01-02-03", `${id}_${b}`, { id, history_base: { thread_id: id } }, [userLine("S2")]);
    const r = await archive(id, archiveRoot());
    expect(r.ok).toBe(true);
    expect(r.archived.map((p) => p.split("/").pop())).toEqual([`${id}.jsonl`, `${a}.jsonl`, `${b}.jsonl`]);
    writeFileSync(s1, "garbage");
    const r2 = await archive(id, archiveRoot());
    expect(r2.ok).toBe(false);
    expect(r2.note).toContain(`段 ${a} 没归档`);
    expect(r2.note).not.toContain("最新段");
    expect(r2.archived.map((p) => p.split("/").pop())).toEqual([`${id}.jsonl`, `${b}.jsonl`]);
  });

  test("两次 revert：三段按文件名时间 + rolloutId 排序，全部归档", async () => {
    const id = sid();
    const [a, b] = [rid(n * 10 + 1), rid(n * 10 + 2)];
    rollout("2026-09-28T01-02-03", id, { id }, [userLine("S0")]);
    rollout("2026-09-29T01-02-03", `${id}_${a}`, { id, history_base: { thread_id: id } }, [userLine("S1")]);
    rollout("2026-09-29T01-02-03", `${id}_${b}`, { id, history_base: { thread_id: a } }, [userLine("S2")]);
    const root = archiveRoot();
    const r = await archive(id, root);
    expect(r.ok).toBe(true);
    expect(r.archived.map((p) => p.split("/").pop())).toEqual([`${id}.jsonl`, `${a}.jsonl`, `${b}.jsonl`]);
    expect(r.note).toContain(`最新 rollout-2026-09-29T01-02-03-${id}_${b}.jsonl`);
  });

  test("分页 fork：前缀是父线程的 rollout，不算缺段，只记 note", async () => {
    const parent = sid();
    const id = sid();
    rollout("2026-09-28T01-02-03", parent, { id: parent }, [userLine("PARENT")]);
    rollout("2026-09-29T01-02-03", id, { id, forked_from_id: parent, history_base: { thread_id: parent } }, [userLine("CHILD")]);
    const r = await archive(id, archiveRoot());
    expect(r.ok).toBe(true);
    expect(r.note).toContain(`父线程 ${parent}`);
  });

  test("分页 fork 的父线程 rollout 已不在本机：原文件的前缀只能是父线程，不算缺段", async () => {
    const id = sid();
    const parent = sid();
    rollout("2026-09-29T01-02-03", id, { id, forked_from_id: parent, history_base: { thread_id: parent } }, [userLine("CHILD")]);
    const r = await archive(id, archiveRoot());
    expect(r.ok).toBe(true);
    expect(r.note).toContain(`前缀 ${parent} 属于父线程`);
  });

  test("同一段两份、cwd 分不开：仍然拒绝（T72 语义不变）", async () => {
    const id = sid();
    rollout("2026-09-28T01-02-03", id, { id }, [userLine("A")]);
    rollout("2026-09-27T01-02-03", id, { id }, [userLine("B")]);
    const r = await archive(id, archiveRoot());
    expect(r.ok).toBe(false);
    expect(r.note).toContain("分不清");
  });
});
