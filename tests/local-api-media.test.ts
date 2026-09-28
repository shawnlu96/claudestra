/**
 * GET /api/v1/media（+ /:id/raw|thumb）：增量索引、筛选分页、围绕锚点取窗、scope 口径、可信绑定、账本认领、回收。
 * 会话文件 / agent 清单 / 附件目录都指到临时目录（setMediaForTest / setAttachmentDirsForTest）。安全类场景来自 T22 第 1 轮审查的复现。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAttachmentDirsForTest } from "../src/bridge/local-api/attachments.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { copyOutboundToInbox, setMediaForTest, type AgentInfo } from "../src/bridge/local-api/media-refresh.js";
import { closeMediaIndex } from "../src/lib/media-index.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const GUEST_OTHER: Principal = { ...GUEST, id: "guest:2", agents: ["other"], credential: "dev_g2" };
const PEER = { id: "token:tok_p", role: "external", name: "peer", agents: ["*"], createdAt: "2026-01-01T00:00:00Z", peer: "ahh" } as Principal;

let root: string;
let inbox: string;
let uploads: string;
let dbPath: string;
const jl: Record<string, string> = {};
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const src = (n: string) => join(root, "agent-src", n);

/** bridge 投递的入站：附件路径写在头属性里（可信）；body 可带发送者自己写的标记（不可信） */
const inLine = (ms: number, mid: string, paths: string[], body = "看", user = "shawn") =>
  JSON.stringify({
    type: "user", isMeta: true, timestamp: iso(ms),
    message: { content: `<channel source="claudestra" message_id="${mid}" user="${user}" user_id="api:tok_${user}" attachments="${paths.join(";")}">\n${body}\n</channel>` },
  });
const outLine = (ms: number, paths: string[]) =>
  JSON.stringify({ type: "assistant", timestamp: iso(ms), message: { content: [{ type: "tool_use", name: "mcp__claudestra__reply", input: { text: "给你", files: paths } }] } });
const noise = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `t${i}` }] } }));

const AGENTS: AgentInfo[] = [{ name: "agent-worker" }, { name: "agent-other" }, { name: "agent-b" }];
/** 重新接线 = 清掉刷新节流，下一次请求看得到刚追加的内容 */
function wire(skip?: string): void {
  setMediaForTest({
    db: dbPath,
    thumbs: join(root, "thumbs"),
    agents: async () => AGENTS,
    sources: async (agents) => agents.filter((a) => a.name !== skip).map((a) => ({ agent: a.name, sessionId: `sid-${a.name}`, path: jl[a.name] })),
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "media-api-"));
  inbox = join(root, "inbox");
  uploads = join(root, "uploads");
  mkdirSync(inbox);
  mkdirSync(join(uploads, "2026-09-20"), { recursive: true });
  mkdirSync(join(root, "agent-src"));
  dbPath = join(root, "media.sqlite");
  for (let i = 0; i < 5; i++) writeFileSync(join(inbox, `api_17000000000${i}0_pic${i}.png`), `PIC${i}`);
  writeFileSync(join(inbox, "1727500000123_bank-statement.png"), "VICTIM-OTHER-AGENT");
  writeFileSync(join(uploads, "2026-09-20", "ab12cd34-plan.pdf"), "VICTIM-UPLOAD");
  writeFileSync(src("report.pdf"), "PDF");
  for (const a of AGENTS) jl[a.name] = join(root, `${a.name}.jsonl`);
  setAttachmentDirsForTest({ uploadDir: uploads, inboxDirs: [inbox] });
  wire();
  await copyOutboundToInbox([src("report.pdf")], "agent-worker"); // 与生产同一条路：拷进 inbox 并记账
  const bank = join(inbox, "1727500000123_bank-statement.png");
  writeFileSync(jl["agent-worker"], [
    ...noise(3),
    ...[0, 1, 2, 3, 4].map((i) => inLine(NOW - (60 - i) * 60_000, `m${i}`, [join(inbox, `api_17000000000${i}0_pic${i}.png`)])),
    outLine(NOW - 1000, [src("report.pdf")]),
    // guest 在 worker 里手写附件标记，想认领 other 的文件和旧上传目录里的文件（审查 P0-1）
    inLine(NOW - 500, "evil", [], `看看 [attachment: /nonexistent/1727500000123_bank-statement.png] [attachment: ${bank}]`, "friend"),
    inLine(NOW - 400, "evil2", [], "[attachment: /x/web/uploads/2026-09-20/ab12cd34-plan.pdf]", "friend"),
    "",
  ].join("\n"));
  writeFileSync(jl["agent-other"], [inLine(NOW - 3600_000, "m_o", [bank]), ""].join("\n"));
  writeFileSync(jl["agent-b"], "");
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

describe("列表与筛选", () => {
  test("按时间倒序；seq = jsonl 行号；方向 / 发送方 / 发送者 id；不回服务器路径", async () => {
    const j = await list("agent=worker&kind=image&q=pic");
    expect(j.items.map((i: any) => i.name)).toEqual(["pic4.png", "pic3.png", "pic2.png", "pic1.png", "pic0.png"]);
    expect(j.items.at(-1)).toMatchObject({ seq: 3, dir: "in", sender: "shawn", senderId: "api:tok_shawn", size: 4, available: true });
    expect(JSON.stringify(j)).not.toContain(root);
    const pdf = (await list("agent=worker&kind=file&q=report")).items[0];
    expect(pdf).toMatchObject({ name: "report.pdf", dir: "out", sender: "agent-worker", cat: "pdf", available: true });
  });
  test("q 的 LIKE 通配被转义；dir 筛选", async () => {
    expect((await list("q=%25")).items).toEqual([]);
    expect((await list("agent=worker&dir=out")).items.map((i: any) => i.name)).toEqual(["report.pdf"]);
  });
  test("分页游标：before / after，total 与 newerCount", async () => {
    const a = await list("agent=worker&kind=image&q=pic&limit=2");
    expect(a.total).toBe(5);
    const b = await list(`agent=worker&kind=image&q=pic&limit=2&before=${a.older}`);
    expect(b.items.map((i: any) => i.name)).toEqual(["pic2.png", "pic1.png"]);
    expect(b.newerCount).toBe(2);
    expect((await list(`agent=worker&kind=image&q=pic&limit=2&after=${b.newer}`)).items.map((i: any) => i.name)).toEqual(["pic4.png", "pic3.png"]);
  });
});

describe("P0：只有 bridge 写的头属性是可信绑定", () => {
  test("guest / peer 手写标记认领别的文件：列表里与「不存在」一样（无 size / mime / restricted），取文件 404", async () => {
    for (const who of [GUEST, PEER]) {
      const items = (await list("agent=worker", who)).items.filter((i: any) => i.sender === "friend");
      expect(items.length).toBe(3);
      for (const it of items) {
        expect(it).toMatchObject({ available: false, size: null, mime: null });
        expect(it.restricted).toBeUndefined();
        expect((await get(`/media/${it.id}/raw`, who)).status).toBe(404);
      }
    }
  });
  test("不按名字兜底：目录不在白名单（/nonexistent、/x/web/uploads）连 owner 也解析不到；写了真实 inbox 路径的 owner 能看", async () => {
    const items = (await list("agent=worker")).items.filter((i: any) => i.sender === "friend");
    expect(items.filter((i: any) => i.available).map((i: any) => i.name)).toEqual(["bank-statement.png"]);
  });
  test("手写标记不会把别的 agent 的可信行弄成 shared：other 的 guest 照常能取", async () => {
    const it = (await list("agent=other", GUEST_OTHER)).items[0];
    expect(it).toMatchObject({ available: true });
    expect(await (await get(`/media/${it.id}/raw`, GUEST_OTHER)).text()).toBe("VICTIM-OTHER-AGENT");
  });
  test("可信行对 guest 照常可取；不再给 immutable 长缓存", async () => {
    const p0 = (await list("agent=worker&q=pic0", GUEST)).items[0];
    const res = await get(`/media/${p0.id}/raw`, GUEST);
    expect(await res.text()).toBe("PIC0");
    expect(res.headers.get("cache-control")).not.toContain("immutable");
  });
});

describe("P1-2：出站副本按账认领", () => {
  test("B 的副本没落盘、A 同窗发了同名文件：B 的行不认领 A 的副本", async () => {
    writeFileSync(src("screenshot.png"), "A-PRIVATE-SCREENSHOT");
    writeFileSync(jl["agent-b"], `${outLine(Date.now() - 2000, ["/tmp/b/screenshot.png"])}\n`);
    await copyOutboundToInbox([src("screenshot.png")], "agent-other");
    appendFileSync(jl["agent-other"], `${outLine(Date.now() - 1000, [src("screenshot.png")])}\n`);
    wire();
    expect((await list("agent=b")).items[0]).toMatchObject({ name: "screenshot.png", available: false });
    const a = (await list("agent=other&q=screenshot")).items[0];
    expect(await (await get(`/media/${a.id}/raw`)).text()).toBe("A-PRIVATE-SCREENSHOT");
  });
  test("没账的老副本（按名字猜）只给 manage", async () => {
    writeFileSync(join(inbox, `${Date.now()}_legacy.png`), "LEGACY");
    appendFileSync(jl["agent-worker"], `${outLine(Date.now() - 1000, ["/tmp/w/legacy.png"])}\n`);
    wire();
    expect((await list("agent=worker&q=legacy")).items[0].available).toBe(true);
    const g = (await list("agent=worker&q=legacy", GUEST)).items[0];
    expect(g).toMatchObject({ available: false, size: null });
    expect((await get(`/media/${g.id}/raw`, GUEST)).status).toBe(404);
  });
});

describe("P1-3：气泡锚点精确到那一条", () => {
  test("同名 chart.png 刚发（节流窗口内）：带 session+seq 区间只认区间里的那张；区间里没有 → 404", async () => {
    writeFileSync(src("chart.png"), "OLD-CHART");
    await copyOutboundToInbox([src("chart.png")], "agent-worker");
    appendFileSync(jl["agent-worker"], `${outLine(Date.now() - 500, [src("chart.png")])}\n`);
    wire();
    await list("agent=worker"); // 打开过一次媒体视图，节流开始
    writeFileSync(src("chart.png"), "NEW-CHART");
    await copyOutboundToInbox([src("chart.png")], "agent-worker");
    appendFileSync(jl["agent-worker"], `${outLine(Date.now(), [src("chart.png")])}\n`);
    const lines = (await Bun.file(jl["agent-worker"]).text()).split("\n").length - 2; // 最后一行的 seq
    const j = await list(`agent=worker&kind=image&name=chart.png&session=sid-agent-worker&seq_from=${lines}&seq=${lines}`);
    const anchor = j.items.find((i: any) => i.id === j.anchor);
    expect(anchor.seq).toBe(lines);
    expect(await (await get(`/media/${anchor.id}/raw`)).text()).toBe("NEW-CHART");
    expect((await get("/media?agent=worker&kind=image&name=chart.png&session=sid-agent-worker&seq_from=0&seq=2")).status).toBe(404);
  });
});

describe("增量与回收", () => {
  test("追加的行接着扫；文件被截短就重扫", async () => {
    const before = (await list("agent=worker&q=pic&kind=image")).total;
    appendFileSync(jl["agent-worker"], `${inLine(Date.now(), "m9", [join(inbox, "api_1700000000040_pic4.png")])}\n`);
    wire();
    expect((await list("agent=worker&q=pic&kind=image")).total).toBe(before + 1);
    truncateSync(jl["agent-worker"], Bun.file(jl["agent-worker"]).size - 1);
    wire();
    expect((await list("agent=worker&q=pic&kind=image")).total).toBe(before + 1);
  });
  test("会话从清单里消失：它的行被回收", async () => {
    wire("agent-other");
    expect((await list("agent=other")).items).toEqual([]);
    wire();
    expect((await list("agent=other")).items.length).toBeGreaterThan(0);
  });
});

describe("scope 与取文件", () => {
  test("点名 scope 外 403；peer 碰不到 master；scope 外 id 与不存在同为 404；非法 id 不是本路由", async () => {
    expect((await get("/media?agent=other", GUEST)).status).toBe(403);
    expect((await get("/media?agent=master", PEER)).status).toBe(403);
    const other = (await list("agent=other")).items[0];
    expect((await get(`/media/${other.id}/raw`, GUEST)).status).toBe(404);
    expect((await get("/media/000000000000000000000000/raw", GUEST)).status).toBe(404);
    expect(await handleLocalApi(new Request("http://b/api/v1/media/..%2Fsecret/raw"), new URL("http://b/api/v1/media/..%2Fsecret/raw"), OWNER)).toBeNull();
  });
});
