/** Real Chromium + synthetic injected port, never a production bridge. Screenshots are private and head/hash bound. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shotIssues } from "./helpers/ui-shot-checks";

const scratch = mkdtempSync(join(tmpdir(), "cstra-test-project-ui-"));
const shots = process.env.SHARED_PROJECTS_SHOTS_DIR ? resolve(process.env.SHARED_PROJECTS_SHOTS_DIR) : join(scratch, "shots");
const entry = "web/features/collab/shared-projects/fixture-harness.tsx";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const manifest: { file: string; sha256: string }[] = [];

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true, mode: 0o700 }); chmodSync(shots, 0o700);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", scratch,
    "--tsconfig-override", "web/tsconfig.json"], { stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const req = createRequire(resolve("web/package.json"));
  const postcss = req("postcss") as typeof import("../web/node_modules/postcss/lib/postcss");
  const tw = req("@tailwindcss/postcss") as (o: { base: string }) => import("../web/node_modules/postcss/lib/postcss").AcceptedPlugin;
  const from = resolve("web/app/globals.css");
  const css = (await postcss([tw({ base: resolve("web") })]).process(readFileSync(from, "utf8"), { from })).css;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture.js") return new Response(Bun.file(join(scratch, "fixture-harness.js")));
    if (path === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
    if (path !== "/") return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>
      <body><div id="root"></div><script src="/fixture.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
  } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 60_000);

afterAll(async () => {
  try {
    const [, head, dirty] = await Promise.all([
      browser?.close(), git("rev-parse", "HEAD"), git("status", "--porcelain", "--", "web", "tests"),
    ]);
    if (manifest.length) writeFileSync(join(shots, "manifest.json"), JSON.stringify({
      head, specRev: 1, round: 0,
      fixture: "synthetic injected SharedProjectsPort and synthetic choice card; not N1-N4 integration",
      summary: "Isolated forms, permissions, explicit CAS/local/recipient choices; production combination pending frozen N4 and PM acceptance",
      dirty: !!dirty,
      fixtureSha256: createHash("sha256").update(readFileSync(entry)).digest("hex"), shots: manifest,
    }, null, 2), { mode: 0o600 });
  } finally {
    server?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
});

async function screenshot(page: Page, name: string) {
  const png = await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" });
  chmodSync(join(shots, `${name}.png`), 0o600);
  manifest.push({ file: `${name}.png`, sha256: createHash("sha256").update(png).digest("hex") });
  expect(await shotIssues(page)).toEqual([]);
}

async function newPage(width: number, query = "") {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === String(server.url).replace(/\/$/, "")) return route.continue();
    errors.push("non-loopback request"); return route.abort();
  });
  await page.goto(`${server.url}${query}`);
  return { page, errors };
}

for (const width of [390, 1200]) test(`project forms, explicit CAS retry, invite and local actions at ${width}px`, async () => {
  const { page, errors } = await newPage(width);
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByLabel("显示名", { exact: true }).fill("示例协作项目");
    await screenshot(page, `create-${width}`);
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await page.getByRole("button", { name: "示例协作项目", exact: true }).last().click();
    await page.getByLabel("项目显示名", { exact: true }).fill("改名后的团队项目");
    await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await page.getByText("当前名称：同事更新的名称", { exact: true }).waitFor();
    await screenshot(page, `conflict-${width}`);
    expect(JSON.parse((await page.locator("body").getAttribute("data-calls"))!).filter((v: string) => v === "patch")).toHaveLength(1);
    await page.getByRole("button", { name: "按当前版本重试", exact: true }).click();
    await page.getByText("协作伙伴的机器", { exact: true }).click();
    expect(await page.getByRole("button", { name: "邀请成员", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByLabel("邀请对象", { exact: true }).inputValue()).toBe("");
    await page.getByLabel("邀请对象类型", { exact: true }).selectOption("new");
    await page.getByLabel("拟邀新成员代号", { exact: true }).fill("synthetic-new-person");
    await page.getByRole("button", { name: "邀请成员", exact: true }).click();
    await page.getByText("邀请已发送，等待对方确认加入。", { exact: true }).waitFor();
    expect(JSON.parse((await page.locator("body").getAttribute("data-last-invite"))!)).toEqual({
      peers: ["fixture-peer"], note: "", recipient: { code: "synthetic-new-person" },
    });
    await page.getByText("邀请已发送，等待对方确认加入。", { exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, `invite-${width}`);
    await page.getByRole("button", { name: "移出 协作伙伴", exact: true }).click();
    await page.getByRole("button", { name: "确认移出", exact: true }).click();
    await page.getByLabel("本机目录（每行一个）", { exact: true }).fill("/synthetic/work");
    await page.getByRole("button", { name: "设置目录", exact: true }).click();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await screenshot(page, `sidebar-${width}`);
    await page.getByRole("button", { name: "改名后的团队项目", exact: true }).click();
    expect(await page.locator("body").getAttribute("data-opened")).toBe("sample");
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByRole("button", { name: "退出团队项目", exact: true }).click();
    await page.getByRole("button", { name: "确认退出", exact: true }).click();
    await page.getByText("暂无团队项目。加入后会自动出现在这里。", { exact: true }).waitFor();
    expect(JSON.parse((await page.locator("body").getAttribute("data-calls"))!)).toEqual([
      "create", "patch", "patch", "invite", "remove", "directories", "leave",
    ]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 60_000);

test("ordinary member has no owner actions and no create form", async () => {
  const { page, errors } = await newPage(390, "?role=member&theme=dark");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    expect(await page.getByRole("button", { name: "创建项目", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "团队工作台", exact: true }).last().click();
    for (const name of ["保存名称", "归档项目", "邀请成员", "移出 项目创建人"]) {
      expect(await page.getByRole("button", { name, exact: true }).count()).toBe(0);
    }
    await screenshot(page, "member-dark-390");
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("existing recipient requires an explicit member choice independent of the peer", async () => {
  const { page, errors } = await newPage(390, "?role=owner");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByLabel("显示名", { exact: true }).fill("邀请测试项目");
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await page.getByRole("button", { name: "邀请测试项目", exact: true }).last().click();
    const submit = page.getByRole("button", { name: "邀请成员", exact: true });
    const recipient = page.getByLabel("邀请对象", { exact: true });
    expect(await submit.isDisabled()).toBe(true);
    await recipient.selectOption("fixture-existing-person");
    expect(await submit.isDisabled()).toBe(true);
    await page.getByText("协作伙伴的机器", { exact: true }).click();
    expect(await submit.isEnabled()).toBe(true);
    await page.getByLabel("邀请对象类型", { exact: true }).selectOption("new");
    expect(await submit.isDisabled()).toBe(true);
    await page.getByLabel("拟邀新成员代号", { exact: true }).fill("   ");
    expect(await submit.isDisabled()).toBe(true);
    await page.getByLabel("拟邀新成员代号", { exact: true }).fill("synthetic-new-person");
    expect(await submit.isEnabled()).toBe(true);
    await page.getByLabel("邀请对象类型", { exact: true }).selectOption("existing");
    expect(await recipient.inputValue()).toBe("");
    expect(await submit.isDisabled()).toBe(true);
    expect(await page.locator("body").getAttribute("data-last-invite")).toBeNull();
    await recipient.selectOption("fixture-existing-person");
    await page.getByLabel("附言（可选）", { exact: true }).fill("合成邀请附言");
    await submit.click();
    await page.getByText("邀请已发送，等待对方确认加入。", { exact: true }).waitFor();
    expect(JSON.parse((await page.locator("body").getAttribute("data-last-invite"))!)).toEqual({
      peers: ["fixture-peer"], note: "合成邀请附言", recipient: { personId: "fixture-existing-person" },
    });
    expect(await submit.isDisabled()).toBe(true);
    expect(await recipient.inputValue()).toBe("");
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("recommendation is selected in the DOM and clearing it disables confirmation", async () => {
  const { page, errors } = await newPage(390, "?fixture=choice");
  try {
    const select = page.getByLabel("加入后对应的本机项目", { exact: true });
    const confirm = page.getByRole("button", { name: "确认加入", exact: true });
    await select.waitFor();
    expect(await select.inputValue()).toBe("create");
    expect(await confirm.isEnabled()).toBe(true);
    expect(await page.locator("body").getAttribute("data-answers")).toBeNull();
    await screenshot(page, "choice-default-390");
    await select.selectOption("");
    expect(await confirm.isDisabled()).toBe(true);
    expect(await page.getByText("推荐选项已选中；", { exact: false }).count()).toBe(0);
    await screenshot(page, "choice-empty-390");
    await page.getByRole("button", { name: "相同选项的新卡", exact: true }).click();
    expect(await select.inputValue()).toBe("create");
    expect(await page.locator("body").getAttribute("data-answers")).toBeNull();
    await select.selectOption("local-app");
    await confirm.click();
    expect(JSON.parse((await page.locator("body").getAttribute("data-answers"))!)).toEqual([
      "[button:fixture-accept]", "[select:fixture-binding:local-app]",
    ]);
    expect(await confirm.isDisabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("a card with no recommendation starts disabled; a replacement card resets selection", async () => {
  const { page, errors } = await newPage(390, "?fixture=choice&recommended=none&theme=dark");
  try {
    const select = page.getByLabel("加入后对应的本机项目", { exact: true });
    const confirm = page.getByRole("button", { name: "确认加入", exact: true });
    await select.waitFor();
    expect(await select.inputValue()).toBe("");
    expect(await confirm.isDisabled()).toBe(true);
    await select.selectOption("create");
    await page.getByRole("button", { name: "替换合成卡", exact: true }).click();
    expect(await select.inputValue()).toBe("local-app");
    expect(await page.locator("body").getAttribute("data-answers")).toBeNull();
    await page.getByRole("button", { name: "不加入", exact: true }).click();
    expect(JSON.parse((await page.locator("body").getAttribute("data-answers"))!)).toEqual(["[button:fixture-decline]"]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("an uncertain create resumes the same operation without exposing the error or creating twice", async () => {
  const { page, errors } = await newPage(390, "?fixture=recovery");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByLabel("显示名", { exact: true }).fill("待恢复项目");
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    const resume = page.getByRole("button", { name: "继续完成项目", exact: true });
    await resume.waitFor();
    expect(await page.getByRole("button", { name: "创建项目", exact: true }).isDisabled()).toBe(true);
    expect(await page.locator("body").innerText()).not.toContain("synthetic-sensitive-sentinel");
    await resume.click();
    await page.getByText("恢复已处理，请查看本机可用状态。", { exact: true }).waitFor();
    expect(await page.getByLabel("显示名", { exact: true }).inputValue()).toBe("");
    expect(JSON.parse((await page.locator("body").getAttribute("data-calls"))!)).toEqual(["create", "complete"]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
