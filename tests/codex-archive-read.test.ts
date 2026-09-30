/**
 * T75：Codex 归档的读与写。
 *   specRev 1  首行超过 512 字节的 Codex 归档被嗅探成 CC → 历史 / 搜索为空。归档写 sidecar，老归档读完整首行，读不全算 untrusted
 *   specRev 2  thread/revert 的 `<threadId>_<rolloutId>.jsonl` 被定位器跳过 → ok:true 却只存旧正文。整条链每段各存一份，缺段 ok:false
 * rollout 根走 CODEX_HOME（codexSessionsRoot 每次调用现读环境变量），全部落在临时目录，不碰真实 ~/.codex。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAgentSession, archiveSession } from "../src/lib/session-archive.js";
import { isValidSessionId, readSessionHistory, searchSessionHistory } from "../src/lib/session-history.js";
import { UNTRUSTED_RUNTIME, sourceIdForPath } from "../src/lib/runtimes/index.js";
import { readFirstLineSync, sessionSidecarPath } from "../src/lib/session-sidecar.js";

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

/** 写一段 rollout：name 为 `<threadId>` 或 `<threadId>_<rolloutId>`，meta 覆盖 session_meta.payload */
function rollout(stamp: string, name: string, meta: Record<string, unknown>, body: string[], ext = ".jsonl"): string {
  const dir = join(sessions, "2026", "09", stamp.slice(8, 10));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-${stamp}-${name}${ext}`);
  writeFileSync(p, [L({ timestamp: TS, type: "session_meta", payload: { cwd, ...meta } }), ...body].join("\n") + "\n");
  return p;
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

  test("前缀段被 Codex 压成 .zst：ok:false，说明是压缩", async () => {
    const id = sid();
    const r1 = rid(n);
    rollout("2026-09-29T01-02-03", id, { id }, [userLine("OLD")], ".jsonl.zst");
    rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [userLine("LATEST")]);
    const r = await archive(id, archiveRoot());
    expect(r.ok).toBe(false);
    expect(r.note).toContain(".zst");
  });

  test("前缀段后来被压成 .zst、归档里已有：算已存，ok:true（每日 sweep 不报假失败）", async () => {
    const id = sid();
    const r1 = rid(n);
    const old = rollout("2026-09-29T01-02-03", id, { id }, [userLine("OLD")]);
    rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [userLine("LATEST")]);
    const root = archiveRoot();
    expect((await archive(id, root)).ok).toBe(true);
    renameSync(old, `${old}.zst`);
    const r = await archive(id, root);
    expect(r).toMatchObject({ ok: true, archived: [] });
    rmSync(join(root, "agent-cx", `${id}.jsonl`));
    expect((await archive(id, root)).ok).toBe(false); // 归档里没有了就还是缺段
  });

  // P1（T75 r1）：文件名更新的同线程段没进归档时，不能 ok:true 只存旧正文
  const newerSkipped: Array<[string, (id: string, r1: string) => void, string]> = [
    ["最新段是 .zst", (id, r1) => rollout("2026-09-30T01-02-03", `${id}_${r1}`, { id, history_base: { thread_id: id } }, [userLine("NEW")], ".jsonl.zst"), ".zst"],
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

  test("回退后被放弃的中间段是 .zst：ok:false，写明是哪一段", async () => {
    const id = sid();
    const [a, b] = [rid(n * 10 + 1), rid(n * 10 + 2)];
    rollout("2026-09-28T01-02-03", id, { id }, [userLine("S0")]);
    rollout("2026-09-29T01-02-03", `${id}_${a}`, { id, history_base: { thread_id: id } }, [userLine("S1")], ".jsonl.zst");
    rollout("2026-09-30T01-02-03", `${id}_${b}`, { id, history_base: { thread_id: id } }, [userLine("S2")]);
    const r = await archive(id, archiveRoot());
    expect(r.ok).toBe(false);
    expect(r.note).toContain(`段 ${a} 没归档`);
    expect(r.note).not.toContain("最新段");
    expect(r.archived.map((p) => p.split("/").pop())).toEqual([`${id}.jsonl`, `${b}.jsonl`]);
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
