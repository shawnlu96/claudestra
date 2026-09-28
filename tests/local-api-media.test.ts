/**
 * GET /api/v1/media（+ /:id/raw|thumb）：增量索引、筛选分页、围绕锚点取窗、scope 口径、歧义行只给 manage、id 探测与穿越。
 * 会话文件 / agent 清单 / 附件目录都指到临时目录（setMediaForTest / setAttachmentDirsForTest）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAttachmentDirsForTest } from "../src/bridge/local-api/attachments.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { setMediaForTest } from "../src/bridge/local-api/media.js";
import { closeMediaIndex } from "../src/lib/media-index.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const PEER: Principal = { id: "token:tok_p", role: "external", name: "peer", agents: ["*"], createdAt: "2026-01-01T00:00:00Z", peer: "ahh" } as Principal;

let root: string;
let inbox: string;
let dbPath: string;
const files: Record<string, string> = {};
const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const inLine = (ms: number, mid: string, path: string, user = "shawn") =>
  JSON.stringify({
    type: "user", isMeta: true, timestamp: iso(ms),
    message: { content: [{ type: "text", text: `<channel source="claudestra" message_id="${mid}" user="${user}">\n看\n\n[attachment: ${path}]\n</channel>` }] },
  });
const outLine = (ms: number, path: string) =>
  JSON.stringify({ type: "assistant", timestamp: iso(ms), message: { content: [{ type: "tool_use", name: "mcp__claudestra__reply", input: { text: "给你", files: [path] } }] } });
const noise = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `t${i}` }] } }));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "media-api-"));
  inbox = join(root, "inbox");
  mkdirSync(inbox);
  mkdirSync(join(root, "uploads"));
  dbPath = join(root, "media.sqlite");
  for (let i = 0; i < 5; i++) writeFileSync(join(inbox, `17000000000${i}0_p${i}.png`), `P${i}`);
  writeFileSync(join(inbox, `${T0 + 500}_report.pdf`), "PDF");
  writeFileSync(join(inbox, `${T0 + 20_000}_same.png`), "W1");
  writeFileSync(join(inbox, `${T0 + 20_500}_same.png`), "W2-different");
  writeFileSync(join(inbox, "1700000000999_shared.png"), "SHARED");
  writeFileSync(join(root, "secret.txt"), "SECRET");
  files.worker = join(root, "worker.jsonl");
  files.other = join(root, "other.jsonl");
  writeFileSync(files.worker, [
    ...noise(3),
    ...[0, 1, 2, 3, 4].map((i) => inLine(T0 - (5 - i) * 60_000, `m${i}`, `/x/inbox/17000000000${i}0_p${i}.png`)),
    outLine(T0, "/tmp/scratch/report.pdf"),
    outLine(T0 + 20_000, "/tmp/a/same.png"),
    inLine(T0 + 30_000, "mS", "/x/inbox/1700000000999_shared.png"),
    "",
  ].join("\n"));
  writeFileSync(files.other, [inLine(T0 + 40_000, "mO", "/x/inbox/1700000000999_shared.png"), inLine(T0 + 50_000, "mO2", `${root}/secret.txt`), ""].join("\n"));
  setAttachmentDirsForTest({ uploadDir: join(root, "uploads"), inboxDirs: [inbox] });
  setMediaForTest({
    db: dbPath,
    thumbs: join(root, "thumbs"),
    agents: async () => [{ name: "agent-worker" }, { name: "agent-other" }],
    sources: async (agents) => agents.map((a) => ({ agent: a.name, sessionId: `sid-${a.name}`, path: a.name === "agent-worker" ? files.worker : files.other })),
  });
});
afterAll(() => {
  setMediaForTest(undefined);
  setAttachmentDirsForTest(undefined);
  closeMediaIndex(dbPath);
  rmSync(root, { recursive: true, force: true });
});

async function get(path: string, p: Principal = OWNER): Promise<Response> {
  const r = new Request(`http://bridge.local/api/v1${path}`);
  return (await handleLocalApi(r, new URL(r.url), p))!;
}
async function list(q: string, p: Principal = OWNER): Promise<any> {
  const res = await get(`/media?${q}`, p);
  expect(res.status).toBe(200);
  return res.json();
}
/** 刷新有 10 秒节流：测试里要看到追加的内容就重置一次（换同一个库） */
function resetThrottle(): void {
  setMediaForTest({
    db: dbPath,
    thumbs: join(root, "thumbs"),
    agents: async () => [{ name: "agent-worker" }, { name: "agent-other" }],
    sources: async (agents) => agents.map((a) => ({ agent: a.name, sessionId: `sid-${a.name}`, path: a.name === "agent-worker" ? files.worker : files.other })),
  });
}

describe("列表与筛选", () => {
  test("worker 的图片按时间倒序，seq = jsonl 行号，方向 / 发送方", async () => {
    const j = await list("agent=worker&kind=image");
    expect(j.building).toBe(false);
    expect(j.items.map((i: any) => i.name)).toEqual(["shared.png", "same.png", "p4.png", "p3.png", "p2.png", "p1.png", "p0.png"]);
    const p0 = j.items.at(-1);
    expect(p0).toMatchObject({ seq: 3, dir: "in", sender: "shawn", agent: "agent-worker", sessionId: "sid-agent-worker", available: true, size: 2 });
    expect(JSON.stringify(j)).not.toContain(inbox); // 不回服务器路径
    const pdf = (await list("agent=worker&kind=file")).items[0];
    expect(pdf).toMatchObject({ name: "report.pdf", dir: "out", sender: "agent-worker", cat: "pdf", available: true });
  });
  test("q 按名字、LIKE 通配被转义；dir / cat 筛选", async () => {
    expect((await list("q=p3")).items.map((i: any) => i.name)).toEqual(["p3.png"]);
    expect((await list("q=%25")).items).toEqual([]);
    expect((await list("dir=out&agent=worker")).items.map((i: any) => i.name).sort()).toEqual(["report.pdf", "same.png"]);
    expect((await list("cat=pdf")).total).toBe(1);
  });
  test("分页游标：before 往更早，after 往更新，total / newerCount", async () => {
    const a = await list("agent=worker&kind=image&limit=3");
    expect(a.items).toHaveLength(3);
    expect(a.total).toBe(7);
    expect(a.newer).toBeNull();
    const b = await list(`agent=worker&kind=image&limit=3&before=${a.older}`);
    expect(b.items.map((i: any) => i.name)).toEqual(["p3.png", "p2.png", "p1.png"]);
    expect(b.newerCount).toBe(3);
    const c = await list(`agent=worker&kind=image&limit=3&after=${b.newer}`);
    expect(c.items.map((i: any) => i.name)).toEqual(["shared.png", "same.png", "p4.png"]);
    expect(c.newer).toBeNull();
  });
  test("围绕锚点：按 id / 按气泡文件名 + session + seq", async () => {
    const all = (await list("agent=worker&kind=image")).items;
    const p2 = all.find((i: any) => i.name === "p2.png");
    const w = await list(`agent=worker&kind=image&around=${p2.id}&limit=4`);
    expect(w.anchor).toBe(p2.id);
    expect(w.items.map((i: any) => i.name)).toEqual(["p4.png", "p3.png", "p2.png", "p1.png", "p0.png"]);
    expect(w.newerCount).toBe(2);
    const byName = await list(`agent=worker&kind=image&name=${encodeURIComponent("17000000000" + "20_p2.png")}&session=sid-agent-worker&seq=${p2.seq}`);
    expect(byName.anchor).toBe(p2.id);
    expect((await get("/media?agent=worker&name=nope.png")).status).toBe(404);
  });
});

describe("增量", () => {
  test("追加的行接着扫（seq 延续）；文件被截短就重扫", async () => {
    appendFileSync(files.worker, `${inLine(T0 + 60_000, "m9", "/x/inbox/1700000000040_p4.png")}\n`);
    resetThrottle();
    const j = await list("agent=worker&kind=image&limit=1");
    expect(j.items[0]).toMatchObject({ seq: 11, name: "p4.png" });
    const size = Bun.file(files.worker).size;
    truncateSync(files.worker, size - 1); // 末行换行被截掉 = 变小 → 从头扫
    resetThrottle();
    expect((await list("agent=worker&kind=image")).total).toBe(8);
  });
});

describe("权限", () => {
  test("guest 只看 scope 内；点名 scope 外 403；peer 碰不到 master", async () => {
    const j = await list("", GUEST);
    expect(new Set(j.items.map((i: any) => i.agent))).toEqual(new Set(["agent-worker"]));
    expect((await get("/media?agent=other", GUEST)).status).toBe(403);
    expect((await get("/media?agent=master", PEER)).status).toBe(403);
  });
  test("raw：scope 内可取；scope 外与不存在同为 404；坏 id 不是本路由", async () => {
    const [pdf] = (await list("agent=worker&kind=file", GUEST)).items;
    const res = await get(`/media/${pdf.id}/raw`, GUEST);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PDF");
    expect(res.headers.get("content-disposition")).toContain("inline");
    const other = (await list("agent=other")).items[0];
    expect((await get(`/media/${other.id}/raw`, GUEST)).status).toBe(404);
    expect((await get("/media/000000000000000000000000/raw", GUEST)).status).toBe(404);
    expect(await handleLocalApi(new Request("http://b/api/v1/media/..%2Fsecret/raw"), new URL("http://b/api/v1/media/..%2Fsecret/raw"), OWNER)).toBeNull();
  });
  test("歧义出站副本 / 跨 agent 认领的同一文件：guest 看到 restricted 占位、取文件 403；manage 照常", async () => {
    const items = (await list("agent=worker&kind=image", GUEST)).items;
    const same = items.find((i: any) => i.name === "same.png");
    const shared = items.find((i: any) => i.name === "shared.png");
    for (const it of [same, shared]) {
      expect(it).toMatchObject({ available: false, restricted: true });
      expect((await get(`/media/${it.id}/raw`, GUEST)).status).toBe(403);
      expect((await get(`/media/${it.id}/raw`, OWNER)).status).toBe(200);
    }
  });
  test("记录里指向白名单外的路径：索引里是 missing，取不到", async () => {
    const it = (await list("agent=other&q=secret")).items[0];
    expect(it).toMatchObject({ available: false });
    expect((await get(`/media/${it.id}/raw`, OWNER)).status).toBe(404);
  });
});
