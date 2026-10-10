/**
 * N7W 截图与 DOM 断言（opt-in）：FEATURE_PROPOSALS_SHOTS_DIR=<审查目录> bun test tests/web-feature-proposals-browser.test.ts
 * （只跑断言不留图：FEATURE_PROPOSALS_BROWSER=1）。打包 web/features/collab/feature-proposals/fixture-harness.tsx，
 * 合成数据、假 port，不连 bridge / 中心 / 设备；390 / 1280 两档，每张过截图自动检查（tests/helpers/ui-shot-checks.ts）。
 */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { shotIssues, type ShotIssue } from "./helpers/ui-shot-checks";

const out = process.env.FEATURE_PROPOSALS_SHOTS_DIR;
const run = !!out || process.env.FEATURE_PROPOSALS_BROWSER === "1";

/** 截图清单编号对应规格「截图」1–11 */
const SCENES: { name: string; scene: string; act?: (page: Page) => Promise<void> }[] = [
  { name: "01-empty-form", scene: "form" },
  { name: "02-pending-approval", scene: "pending" },
  { name: "03-pending-sync", scene: "sync" },
  { name: "04-published", scene: "published" },
  { name: "05-rejected-expired-conflict", scene: "terminal" },
  { name: "06-owner-review", scene: "owner" },
  { name: "07-member-view", scene: "member" },
  { name: "08-reject-reason", scene: "reject", act: page => page.getByRole("button", { name: "驳回 网页提案表单与审批卡" }).click() },
  { name: "09a-decide-409", scene: "d409", act: page => page.getByRole("button", { name: "批准 网页提案表单与审批卡" }).click() },
  { name: "09b-decide-503", scene: "d503", act: page => page.getByRole("button", { name: "批准 网页提案表单与审批卡" }).click() },
  { name: "10-guest-403", scene: "guest", act: async page => {
    await page.getByRole("textbox", { name: "标题", exact: true }).fill("guest 提案");
    await page.getByRole("textbox", { name: "一句话描述 1" }).fill("一个节点");
    await page.getByRole("textbox", { name: "文件范围 1" }).fill("web/**");
    await page.getByRole("button", { name: "提交提案" }).click();
    await page.getByText("本机设备无权操作团队提案（403）").first().waitFor();
  } },
  { name: "11-center-unsupported-502", scene: "unsupported" },
];

async function serve(bundle: string) {
  const files = readdirSync(bundle);
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/app-config.json") return Response.json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path.startsWith("/api/")) return Response.json({ ok: false, error: "fixture has no network" }, { status: 599 });
    if (path !== "/") return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(bundle, path.slice(1)))) : new Response(null, { status: 404 });
    return new Response(`<!doctype html><html><head><meta charset="utf-8">
      ${files.filter(f => f.endsWith(".css")).map(f => `<link rel="stylesheet" href="/${f}">`).join("")}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}h5{margin:0}</style></head>
      <body><div id="root"></div><script type="module" src="/${files.find(f => f.endsWith(".js"))}"></script></body></html>`,
    { headers: { "content-type": "text/html" } });
  } });
}

test.skipIf(!run)("N7W 提案表单 / 状态 / 审批卡：390 / 1280 截图与 DOM 断言", async () => {
  const dir = out ?? mkdtempSync(resolve(tmpdir(), "n7w-"));
  mkdirSync(dir, { recursive: true });
  const bundle = resolve(dir, "fixture-bundle");
  const build = Bun.spawn([process.execPath, "build", "web/features/collab/feature-proposals/fixture-harness.tsx", "--target", "browser",
    "--outdir", bundle, "--tsconfig-override", "web/tsconfig.json"], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const server = await serve(bundle);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  const issues: Record<string, ShotIssue[]> = {};
  try {
    for (const width of [390, 1280]) for (const s of SCENES) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(5000);
      const errors: string[] = [], network: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) network.push(r.url()); });
      await page.goto(`${server.url}?scene=${s.scene}`);
      await page.getByText("待审提案", { exact: true }).waitFor();
      await page.getByText("正在读取…").waitFor({ state: "detached" });
      await s.act?.(page);
      await check(page, s.scene);
      await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const name = `${s.name}-${width}`;
      if (out) await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
      issues[name] = await shotIssues(page);
      expect({ name, errors, network }).toEqual({ name, errors: [], network: [] });
      await page.close();
    }
    if (out) await Bun.write(resolve(dir, "shot-issues.json"), JSON.stringify(issues, null, 2));
    for (const [name, list] of Object.entries(issues)) expect({ name, list }).toEqual({ name, list: [] });
  } finally { await browser.close(); server.stop(true); }
}, 180_000);

const calls = (page: Page) => page.evaluate("window.__proposalCalls") as Promise<Record<string, unknown>[]>;
const approve = (page: Page, title: string) => page.getByRole("button", { name: `批准 ${title}`, exact: true });

/** 验收线 1 / 3 / 4 / 5 / 6 / 7 的 DOM 一侧 */
async function check(page: Page, scene: string) {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/Bearer|person-a|fixture has no network/);
  if (scene === "form") {
    for (const label of ["项目", "默认规划主场", "主场", "中心", "团队"]) expect(await page.getByRole("textbox", { name: label, exact: true }).count()).toBe(0);
    await page.getByRole("textbox", { name: "标题", exact: true }).fill("表单提交");
    await page.getByRole("textbox", { name: "一句话描述 1" }).fill("一个节点");
    await page.getByRole("textbox", { name: "文件范围 1" }).fill("web/**");
    await page.getByRole("button", { name: "提交提案" }).click();
    await page.getByText("已提交，待项目 owner 批准").first().waitFor();
    const submit = (await calls(page)).filter(c => c.kind === "submit");
    expect(submit).toHaveLength(1);
    expect(Object.keys(submit[0]!.input as object).sort()).toEqual(["description", "nodes", "title"]);
    await page.reload(); // 截图要空表单
    await page.getByText("暂无待审提案").waitFor();
  }
  if (scene === "sync") {
    expect(await page.getByText("待同步，结果未确认").count()).toBe(2);
    expect(await page.getByText("已发布", { exact: true }).count()).toBe(0);
    await page.getByText("缓存状态：已提交，待项目 owner 批准").waitFor();
  }
  if (scene === "published") await page.getByText("中心 feature feature-7f3a · v1").waitFor();
  if (scene === "owner" || scene === "reject") {
    expect(await approve(page, "网页提案表单与审批卡").isEnabled()).toBe(true);
    for (const t of ["已漂移的提案", "已过期的提案"]) expect(await approve(page, t).isDisabled()).toBe(true);
    await page.getByText("漂移：中心版本已变，不能决定").waitFor();
    await page.getByText("已过期，不能决定").waitFor();
  }
  if (scene === "member" || scene === "guest") expect(await page.getByRole("button", { name: /^(批准|驳回)/ }).count()).toBe(0);
  if (scene === "member") await page.getByText("仅项目 owner 可批准或驳回").waitFor();
  if (scene === "guest") await page.getByText("待审列表需要本机 owner 设备（403）").waitFor();
  if (scene === "reject") {
    const confirm = page.getByRole("button", { name: "确认驳回" });
    expect(await confirm.isDisabled()).toBe(true);
    await page.getByText("请填写驳回理由").waitFor();
    expect((await calls(page)).filter(c => c.kind === "decide")).toHaveLength(0);
  }
  if (scene === "d409") {
    await page.getByText("提案已变化，已重读，请重新决定").waitFor();
    expect((await calls(page)).filter(c => c.kind === "decide")).toEqual([{ kind: "decide", local: "proj-bound", proposalId: "proposal-ok",
      decision: "approve", proposalDigest: "sha256:proposal-ok", proposalRev: 2, reason: "" }]);
  }
  if (scene === "d503") {
    await page.getByText("决定结果未确认，未自动重发；请重读后再看").waitFor();
    expect(await approve(page, "网页提案表单与审批卡").isDisabled()).toBe(true);
    expect((await calls(page)).filter(c => c.kind === "decide")).toHaveLength(1);
  }
  if (scene === "unsupported") expect(await page.getByText("中心不支持提案协议（502）").count()).toBe(2);
}
