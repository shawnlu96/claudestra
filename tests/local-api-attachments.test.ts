/** 本地 API：GET /api/v1/attachments/:name——manage 专用；上传目录（按天）→ inbox → inbox 后缀匹配；只认 basename，穿越拒 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAttachmentDirsForTest } from "../src/bridge/local-api/attachments.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { attachmentMime, findAttachment, safeAttachmentName } from "../src/lib/attachment-lookup.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };

let dir: string;
let uploadDir: string;
let inbox: string;
let oldInbox: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "attachments-"));
  uploadDir = join(dir, "web", "uploads");
  inbox = join(dir, "inbox");
  oldInbox = join(dir, "old-inbox");
  mkdirSync(join(uploadDir, "2026-09-01"), { recursive: true });
  mkdirSync(join(uploadDir, "2026-09-20"), { recursive: true });
  mkdirSync(inbox);
  mkdirSync(oldInbox);
  writeFileSync(join(uploadDir, "2026-09-01", "aaaa1111-shot.png"), "PNG-old");
  writeFileSync(join(uploadDir, "2026-09-20", "bbbb2222-shot.png"), "PNG-new");
  writeFileSync(join(inbox, "api_1700000000000_report.pdf"), "PDF");
  writeFileSync(join(inbox, "1700000000001_朱耷-新.png"), "PNG-1");
  writeFileSync(join(inbox, "1700000000009_朱耷-新.png"), "PNG-9");
  writeFileSync(join(inbox, "1700000000005_logo.svg"), "<svg/>");
  writeFileSync(join(oldInbox, "legacy.txt"), "legacy");
  writeFileSync(join(dir, "secret.txt"), "nope");
  writeFileSync(join(dir, "id_rsa"), "PRIVATE");
  symlinkSync(join(dir, "id_rsa"), join(inbox, "1700000000010_key.txt")); // 目录里指向外面的软链
  setAttachmentDirsForTest({ uploadDir, inboxDirs: [inbox, oldInbox] });
});
afterAll(() => {
  setAttachmentDirsForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, p: Principal = OWNER): Promise<Response> {
  const r = new Request(`http://bridge.local${path}`);
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("GET /api/v1/attachments/:name", () => {
  test("guest（无 manage）403", async () => {
    expect((await get("/api/v1/attachments/report.pdf", GUEST)).status).toBe(403);
  });
  test("上传目录：?d= 直取那一天；没 d 倒序扫日期目录取最新；MIME + 长缓存 + inline", async () => {
    const res = await get("/api/v1/attachments/aaaa1111-shot.png?d=2026-09-01");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNG-old");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=604800, immutable");
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''aaaa1111-shot.png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await (await get("/api/v1/attachments/bbbb2222-shot.png")).text()).toBe("PNG-new");
    expect((await get("/api/v1/attachments/aaaa1111-shot.png?d=2026-09-20")).status).toBe(404);
    expect((await get("/api/v1/attachments/aaaa1111-shot.png?d=../")).status).toBe(404);
  });
  test("inbox 精确名；旧 inbox 兜底；后缀匹配取时间戳最大的；中文名经同一套清洗", async () => {
    expect(await (await get("/api/v1/attachments/api_1700000000000_report.pdf")).text()).toBe("PDF");
    expect((await get("/api/v1/attachments/api_1700000000000_report.pdf")).headers.get("content-type")).toBe("application/pdf");
    expect(await (await get("/api/v1/attachments/legacy.txt")).text()).toBe("legacy");
    const res = await get(`/api/v1/attachments/${encodeURIComponent("朱耷-新.png")}`);
    expect(await res.text()).toBe("PNG-9");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename*=UTF-8''${encodeURIComponent("1700000000009_朱耷-新.png")}`);
  });
  test("SVG 直出带禁脚本 CSP；其它类型不带", async () => {
    const svg = await get("/api/v1/attachments/1700000000005_logo.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect((await get("/api/v1/attachments/legacy.txt")).headers.get("content-security-policy")).toBeNull();
  });
  test("穿越 / 隐藏文件 / 非法编码 → 400，绝不读目录之外；不存在 404；别的方法 null", async () => {
    for (const bad of ["..%2Fsecret.txt", "%2E%2E%2Fsecret.txt", ".env", "a%00b", "%zz", "x%5C..%5Cy"]) {
      expect((await get(`/api/v1/attachments/${bad}`)).status).toBe(400);
    }
    // 裸 `..` 在 URL 解析层就被折掉（路径变成 /api/v1/），到不了这个端点
    const dots = new Request("http://bridge.local/api/v1/attachments/..");
    expect(new URL(dots.url).pathname).toBe("/api/v1/");
    expect(await handleLocalApi(dots, new URL(dots.url), OWNER)).toBeNull();
    expect((await get("/api/v1/attachments/secret.txt")).status).toBe(404);
    expect((await get("/api/v1/attachments/missing.png")).status).toBe(404);
    const r = new Request("http://bridge.local/api/v1/attachments/legacy.txt", { method: "POST" });
    expect(await handleLocalApi(r, new URL(r.url), OWNER)).toBeNull();
  });
  test("T31c：卡片里的任意路径发不出去——整条路径 400，只剩 basename 时只在白名单目录找；目录里的软链不跟", async () => {
    // 外源正文 [attachment: /not-an-upload/id_rsa] 若被画成卡片，url 只会是 basename；整条路径编码进来被拒
    for (const bad of ["%2Fnot-an-upload%2Fid_rsa", encodeURIComponent(join(dir, "id_rsa"))]) expect((await get(`/api/v1/attachments/${bad}`)).status).toBe(400);
    expect((await get("/api/v1/attachments/id_rsa")).status).toBe(404); // 目录外同名文件不算
    expect((await get("/api/v1/attachments/1700000000010_key.txt")).status).toBe(404); // 精确名命中的是软链
    expect((await get("/api/v1/attachments/key.txt")).status).toBe(404); // 后缀匹配命中的也是软链
    expect(findAttachment("1700000000010_key.txt", null, { uploadDir, inboxDirs: [inbox] })).toBeNull();
  });
});

describe("lib/attachment-lookup 纯函数", () => {
  test("safeAttachmentName / attachmentMime", () => {
    expect(safeAttachmentName("a.png")).toBe("a.png");
    expect(safeAttachmentName("%E6%9C%B1.png")).toBe("朱.png");
    expect(safeAttachmentName("a%2Fb.png")).toBeNull();
    expect(safeAttachmentName(".hidden")).toBeNull();
    expect(safeAttachmentName("")).toBeNull();
    expect(attachmentMime("X.JPG")).toBe("image/jpeg");
    expect(attachmentMime("notes.log")).toBe("text/plain; charset=utf-8");
    expect(attachmentMime("blob")).toBe("application/octet-stream");
    expect(attachmentMime("设计稿.MD")).toBe("text/markdown; charset=utf-8");
    expect(attachmentMime("a.csv")).toBe("text/csv; charset=utf-8");
    expect(attachmentMime("a.json")).toBe("application/json; charset=utf-8");
    expect(attachmentMime("page.html")).toBe("application/octet-stream");
  });
  test("findAttachment：目录不存在时安静地空手而归", () => {
    expect(findAttachment("x.png", null, { uploadDir: join(dir, "nope"), inboxDirs: [join(dir, "nope2")] })).toBeNull();
    expect(findAttachment("x.png", "2026-01-01", { uploadDir, inboxDirs: [] })).toBeNull();
  });
});
