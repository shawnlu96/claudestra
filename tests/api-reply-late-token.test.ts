/**
 * reply 发到 api:<tokenId>：开头核对 token 之后还要 await 着登记附件，期间 token 被删除 / 停用，回复不能再交出去
 * （src/lib/api-reply-target.ts settleApiReply，bridge.ts deliverToApi 交结果的那一步）。
 * 这里按 deliverToApi 的顺序原样走：开头核对 → 认领请求 → 登记附件（真的拷文件、算 sha256）→ settleApiReply → 发事件。
 * principals.json、inbox、媒体索引全在临时目录。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingReplyFiles, stageApiReplyFiles } from "../src/bridge/api-reply-files";
import type { ApiFileEntry } from "../src/bridge/api-files";
import { setAttachmentDirsForTest } from "../src/bridge/local-api/attachments";
import { setMediaForTest } from "../src/bridge/local-api/media-refresh";
import { deadApiTarget, settleApiReply } from "../src/lib/api-reply-target";
import { closeMediaIndex } from "../src/lib/media-index";
import { claimApiReply } from "../src/lib/pending-reply-scope";
import { readPrincipalsStrict, readPrincipalsStrictSync, type Principal } from "../src/lib/principals";

const SECRET = "s3cr3t-never-in-reasons";
const CID = "chan-worker";
const AGENT = "agent-worker";
const TEXT = "这一轮的答复正文";
const tok = (id: string, extra: Partial<Principal> = {}): Principal =>
  ({ id: `token:${id}`, role: "external", name: `n-${id}`, agents: ["*"], secret: SECRET, createdAt: "2026-10-01T00:00:00Z", ...extra });

interface Result { reply: string | null; files?: { name: string; url: string }[]; threadId: string; agent: string }
interface Waiter {
  tokenId: string; agentChannelId: string; threadId: string; messageId?: string; siblingThreadId?: string; ts: number;
  resolve?: (r: Result) => void;
}

let root: string;
let attachment: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "api-reply-late-token-"));
  const jsonl = join(root, `${AGENT}.jsonl`);
  writeFileSync(jsonl, "");
  mkdirSync(join(root, "inbox"));
  attachment = join(root, "report.txt");
  writeFileSync(attachment, "附件内容".repeat(2000));
  setAttachmentDirsForTest({ uploadDir: join(root, "uploads"), inboxDirs: [join(root, "inbox")] });
  setMediaForTest({
    db: join(root, "media.sqlite"), thumbs: join(root, "thumbs"),
    agents: async () => [{ name: AGENT }], sources: async () => [{ agent: AGENT, sessionId: "sid-w", path: jsonl }],
  });
});
afterAll(() => {
  setMediaForTest(undefined);
  setAttachmentDirsForTest(undefined);
  closeMediaIndex(join(root, "media.sqlite"));
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;
/** 一套 bridge 状态：真的 principals.json + 请求队列 + 已结结果 + 附件登记 + 发出去的事件 */
function bridge(...principals: Principal[]) {
  const path = join(root, `principals-${++seq}.json`);
  const write = (list: Principal[]) => writeFileSync(path, JSON.stringify({ principals: list }));
  const current = (): Principal[] => JSON.parse(readFileSync(path, "utf8")).principals;
  write(principals);
  const h = {
    path,
    queues: new Map<string, Waiter[]>(),
    results: new Map<string, { result: Result; ts: number; tokenId?: string; messageId?: string; agentChannelId?: string }>(),
    table: new Map<string, ApiFileEntry>(),
    events: [] as { chatId: string; text: string }[],
    logs: [] as string[],
    reads: 0,
    onRead: undefined as (() => void) | undefined,
    revoke: (id: string) => write(current().filter((p) => p.id !== `token:${id}`)),
    disable: (id: string) => write(current().map((p) => (p.id === `token:${id}` ? { ...p, disabled: true } : p))),
    corrupt: () => writeFileSync(path, `{"principals":[{"secret":"${SECRET}"`),
    /**
     * 对方发来一条请求；wait = 同步等待开着（api-routes 的写法：到点 resolve(null)，条目留在队里）。
     * 「到点」由用例调 expire() 触发，不挂真实计时器：登记附件要拷文件、算 sha256，CI 慢机上一次就超过原来的 60ms，
     * 别的请求会在轮到它之前先超时。expire() 做的事和 api-routes 的到点回调一样；已经交过结果的请求再到点不改结果。
     */
    hang(tokenId: string, n: number, ts = n): { w: Waiter; got: Promise<Result | null>; expire: () => Promise<Result | null> } {
      const w: Waiter = { tokenId, agentChannelId: CID, threadId: `thr_${tokenId}_${n}`, messageId: `m_${tokenId}_${n}`, ts };
      let expire!: () => Promise<Result | null>;
      const got = new Promise<Result | null>((resolve) => {
        w.resolve = resolve;
        expire = () => (w.resolve = undefined, resolve(null), got);
      });
      const key = `${tokenId}|${CID}`;
      h.queues.set(key, [...(h.queues.get(key) ?? []), w]);
      return { w, got, expire };
    },
  };
  return h;
}
type Bridge = ReturnType<typeof bridge>;

/** deliverToApi 的顺序。during 在登记附件已经开始、还没结束时同步执行（撤销就发生在这里） */
async function reply(h: Bridge, tokenId: string, o: { files?: string[]; replyTo?: string; during?: () => void } = {}) {
  const files = o.files ?? [];
  const refused = await deadApiTarget(tokenId, () => readPrincipalsStrict(h.path)) ?? await missingReplyFiles(files);
  if (refused) return { error: refused, at: "start" };
  const key = `${tokenId}|${CID}`;
  const queue = h.queues.get(key) ?? [];
  const claim = claimApiReply(queue, h.results, { tokenId, channelId: CID, replyTo: o.replyTo });
  if (!queue.length) h.queues.delete(key);
  if (claim.error) return { error: claim.error, at: "claim" };
  const pending = claim.taken, threadId = pending?.threadId || claim.threadId || "thr_new";
  const staging = stageApiReplyFiles(files, { agent: AGENT, tokenId, table: h.table, lookup: async () => null });
  o.during?.();
  const staged = await staging;
  const result: Result = { reply: TEXT, files: staged.files.length ? staged.files : undefined, threadId, agent: AGENT };
  const read = () => (h.reads++, h.onRead?.(), readPrincipalsStrictSync(h.path));
  const late = settleApiReply({ tokenId, threadId, result, pending, results: h.results, queues: h.queues, key }, read, (m) => h.logs.push(m));
  if (late) return { error: late, at: "settle", staged };
  h.events.push({ chatId: `api:${tokenId}`, text: TEXT });
  return { sent: true, staged };
}

describe("登记附件期间 token 被撤销：回复不送达", () => {
  const cases: [string, Principal, (h: Bridge) => void, string[]][] = [
    ["删除", tok("tok_a"), (h) => h.revoke("tok_a"), ["api:tok_a 的 token 不存在", "没有投递"]],
    ["停用（peer 重新配对后的旧 token）", tok("tok_a", { peer: "Shawn" }), (h) => h.disable("tok_a"), ["peer「Shawn」已停用的旧 token", "没有投递"]],
  ];
  for (const [how, principal, revoke, reason] of cases) {
    test(`${how}：报错，没有结果、没有事件，等待方拿到超时，请求还在队里`, async () => {
      const h = bridge(principal);
      const { w, expire } = h.hang("tok_a", 1);
      const r = await reply(h, "tok_a", { files: [attachment], during: () => revoke(h) });
      expect(r.at).toBe("settle"); // 开头那次核对是通过的，拦在交结果这一步
      for (const s of reason) expect(r.error).toContain(s);
      expect(r.error).not.toContain(SECRET);
      expect(r.staged!.files).toHaveLength(1); // 附件确实登记完了：撤销发生在登记期间，不是之前
      expect(existsSync(h.table.values().next().value!.path)).toBe(true);
      expect(h.results.size).toBe(0);
      expect(h.events).toEqual([]);
      expect(h.queues.get(`tok_a|${CID}`)).toEqual([w]);
      expect(h.queues.get(`tok_a|${CID}`)![0]).toBe(w); // 同一个对象：HTTP 那头的等待还挂在它上面
      expect(w.resolve).toBeFunction(); // 等待还开着：没人替它交过结果
      expect(await expire()).toBeNull();
    });
  }

  test("没带附件也一样：开头核过之后才撤销，不交", async () => {
    const h = bridge(tok("tok_a"));
    const { w, expire } = h.hang("tok_a", 1);
    const r = await reply(h, "tok_a", { during: () => h.revoke("tok_a") });
    expect(r.at).toBe("settle");
    expect([h.results.size, h.events.length]).toEqual([0, 0]);
    expect(h.queues.get(`tok_a|${CID}`)).toEqual([w]);
    expect(await expire()).toBeNull();
  });

  test("对照：token 一直有效 → 带着附件送达，结果记在这条请求名下，请求出队", async () => {
    const h = bridge(tok("tok_a"));
    const { got } = h.hang("tok_a", 1);
    const r = await reply(h, "tok_a", { files: [attachment] });
    expect(r.sent).toBe(true);
    const result = await got;
    expect(result?.reply).toBe(TEXT);
    expect(result?.files?.[0]?.name).toBe("report.txt");
    const settled = h.results.get("thr_tok_a_1")!;
    expect([settled.tokenId, settled.messageId, settled.agentChannelId]).toEqual(["tok_a", "m_tok_a_1", CID]);
    expect(settled.result).toBe(result!);
    expect(h.events).toEqual([{ chatId: "api:tok_a", text: TEXT }]);
    expect(h.queues.has(`tok_a|${CID}`)).toBe(false);
    expect(h.reads).toBe(1);
  });

  test("只拦被撤销的那个 token：别的 token 同时在等的请求不受影响", async () => {
    const h = bridge(tok("tok_a"), tok("tok_b"));
    const a = h.hang("tok_a", 1), b = h.hang("tok_b", 1);
    expect((await reply(h, "tok_a", { files: [attachment], during: () => h.revoke("tok_a") })).at).toBe("settle");
    expect((await reply(h, "tok_b")).sent).toBe(true);
    expect((await b.got)?.reply).toBe(TEXT);
    expect(await a.expire()).toBeNull();
    expect(h.events).toEqual([{ chatId: "api:tok_b", text: TEXT }]);
  });
});

describe("核不过时请求放回原位", () => {
  test("按到达顺序放回：比它早的在前，登记附件期间新挂上的在后", async () => {
    const h = bridge(tok("tok_a"));
    const first = h.hang("tok_a", 1), second = h.hang("tok_a", 2);
    let third!: ReturnType<Bridge["hang"]>;
    // 认领的是 agent 看到过的最新一条（second）；登记期间又来了一条，然后 token 被撤销
    const r = await reply(h, "tok_a", { files: [attachment], during: () => (third = h.hang("tok_a", 3), h.revoke("tok_a")) });
    expect(r.at).toBe("settle");
    expect(h.queues.get(`tok_a|${CID}`)).toEqual([first.w, second.w, third.w]);
    expect(h.results.size).toBe(0);
  });

  test("认领后队列空了、key 被删掉的，重新建回来", async () => {
    const h = bridge(tok("tok_a"));
    const { w } = h.hang("tok_a", 1);
    await reply(h, "tok_a", { during: () => (expect(h.queues.has(`tok_a|${CID}`)).toBe(false), h.revoke("tok_a")) });
    expect(h.queues.get(`tok_a|${CID}`)).toEqual([w]);
  });

  test("写回旧 thread（reply_to 指向已结掉、对方还在轮询的那条）：核不过就不写，旧结果原样", async () => {
    const h = bridge(tok("tok_a", { peer: "Shawn" }));
    const empty = { result: { reply: null, threadId: "thr_old", agent: AGENT }, ts: 1, tokenId: "tok_a", messageId: "m_old", agentChannelId: CID };
    h.results.set("thr_old", empty);
    const r = await reply(h, "tok_a", { replyTo: "m_old", during: () => h.disable("tok_a") });
    expect(r.at).toBe("settle");
    expect(h.results.get("thr_old")).toBe(empty);
    expect(h.queues.size).toBe(0); // 没认领到请求，没有东西可放回
    expect(h.events).toEqual([]);
  });
});

describe("settleApiReply：核对和交结果在同一段同步代码里", () => {
  test("读盘前一刻才撤销也拦得住；核对到 resolve 之间插不进别的任务", async () => {
    const h = bridge(tok("tok_a"));
    const { expire } = h.hang("tok_a", 1);
    h.onRead = () => h.revoke("tok_a");
    expect((await reply(h, "tok_a")).at).toBe("settle");
    expect(await expire()).toBeNull();

    const ok = bridge(tok("tok_b"));
    const order: string[] = [];
    const waiting = ok.hang("tok_b", 1);
    const [pending] = ok.queues.get(`tok_b|${CID}`)!.splice(0, 1);
    const inner = pending!.resolve!;
    pending!.resolve = (r) => (order.push("resolved"), inner(r));
    queueMicrotask(() => order.push("microtask"));
    const timer = new Promise<void>((done) => setTimeout(() => (order.push("timer"), done()), 0));
    const result: Result = { reply: TEXT, threadId: pending!.threadId, agent: AGENT };
    const late = settleApiReply({ tokenId: "tok_b", threadId: pending!.threadId, result, pending, results: ok.results, queues: ok.queues, key: `tok_b|${CID}` },
      () => (order.push("check"), readPrincipalsStrictSync(ok.path)));
    order.push("returned");
    expect(late).toBeNull();
    expect((await waiting.got)?.reply).toBe(TEXT);
    await timer;
    expect(order).toEqual(["check", "resolved", "returned", "microtask", "timer"]);
  });

  test("owner:self 不核对、不读盘（网页没配对过设备时 principals 里没有它）", async () => {
    const h = bridge();
    const { got } = h.hang("owner:self", 1);
    expect((await reply(h, "owner:self", { files: [attachment] })).sent).toBe(true);
    expect((await got)?.reply).toBe(TEXT);
    expect(h.reads).toBe(0);
  });

  test("principals.json 读坏 → 放行照交，日志只有 token id，不带文件内容和路径", async () => {
    const h = bridge(tok("tok_a"));
    const { got } = h.hang("tok_a", 1);
    expect((await reply(h, "tok_a", { during: () => h.corrupt() })).sent).toBe(true);
    expect((await got)?.reply).toBe(TEXT);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("api:tok_a");
    for (const s of [SECRET, h.path, root, TEXT]) expect(h.logs[0]).not.toContain(s);
  });

  test("核不过时不记日志（原因走报错回给 agent），原因里没有密钥和回复正文", async () => {
    const h = bridge(tok("tok_a"));
    h.hang("tok_a", 1);
    const r = await reply(h, "tok_a", { during: () => h.revoke("tok_a") });
    expect(h.logs).toEqual([]);
    for (const s of [SECRET, TEXT, h.path]) expect(r.error).not.toContain(s);
  });
});
