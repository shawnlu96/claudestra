/** Real Chromium + synthetic injected port, never a production bridge. Screenshots are private and head/hash bound. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shotIssues } from "./helpers/ui-shot-checks";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures";
import { sharedProjectsSnapshot } from "../src/bridge/local-api/shared-projects-snapshot";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects";
import { answerSharedProject } from "../src/bridge/local-api/shared-projects-actions";
import { proposeSharedProjectInvite, sendApprovedSharedProjectInvite, type ProjectInvitePorts } from "../src/bridge/local-api/shared-projects-invite";
import type { SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports";
import type { Ask } from "../src/lib/ledger-asks";

const scratch = mkdtempSync(join(tmpdir(), "cstra-test-project-ui-"));
const shots = process.env.SHARED_PROJECTS_SHOTS_DIR ? resolve(process.env.SHARED_PROJECTS_SHOTS_DIR) : join(scratch, "shots");
const entry = "web/features/collab/shared-projects/fixture-harness.tsx";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const manifest: { file: string; sha256: string }[] = [];
const n4 = n4UiFixture();

/** Actual N4 route/actions with public N1C fixtures and injected mint/transport; not a signed production center or N2 join. */
function n4UiFixture() {
  const f = createV2ProjectsFixtures(), asks: Ask[] = [], sent: unknown[] = [];
  const who = { ...f.person, ...f.requests.list, subject: "owner:self" as const };
  const delivery: ProjectInvitePorts = { now: Date.now, stateDir: scratch, receiptProject: "local-app",
    peers: async () => [{ name: "synthetic-transport", baseUrl: "https://synthetic.example", outToken: "synthetic-token", addedAt: "synthetic" }],
    project: async () => f.project, members: async () => [f.member, f.responses.invite.member],
    mint: async () => ({ url: "https://synthetic.example/", project: f.project, member: f.responses.invite.member,
      invite: { ...f.invite, expiresAt: Date.now() + 60000 } }),
    post: async (_peer, _url, body) => { sent.push(JSON.parse(body)); return new Response(null, { status: 202 }); },
  };
  const d = { now: Date.now, person: async () => who, list: async () => [f.project],
    members: async () => [f.member, f.responses.invite.member, { ...f.responses.invite.member, personId: "removed-person", code: "removed-code", status: "removed" }],
    bindings: () => [{ ...f.identity, localProjectId: "local-app" }], authorizeAnswer: async () => true,
    openAsk: input => {
      const a = { ...input, id: `synthetic-n4-card-${asks.length}`, state: "open", answer: null, fromAgent: null, extra: input.extra ?? {} } as Ask;
      asks.push(a); return a;
    }, getAsk: id => asks.find(a => a.id === id) ?? null,
    claimAsk: a => { if (a.extra.sharedProjectExecuted) return false; a.extra.sharedProjectExecuted = true; return true; },
    invite: (person, id, peers, note, recipient) => proposeSharedProjectInvite(person, id, peers, note, recipient, d, delivery),
    sendInvite: (person, ask) => sendApprovedSharedProjectInvite(person, ask, d, delivery),
  } satisfies Partial<SharedProjectsPorts> as unknown as SharedProjectsPorts;
  const handle = async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/asks") return Response.json({ asks: asks.map(a => ({ ...a, canAnswer: true })) });
    if (url.pathname.endsWith("/answer")) {
      const a = asks.find(a => url.pathname === `/api/v1/ledger/master/asks/${a.id}/answer`);
      if (!a || a.state !== "open") return Response.json({ ok: false }, { status: 409 });
      const b = await req.json() as { choices: string[] };
      a.state = "answered"; a.answer = { choices: b.choices, labels: [], text: "", via: "web_card", owner: true,
        principal: "owner:self", at: Date.now() };
      await answerSharedProject(a, d);
      return Response.json({ ok: true });
    }
    return handleSharedProjectsApi(req, url, { auth: async () => ({ id: "owner:self", role: "owner", agents: ["*"], manage: true, createdAt: "" }), ports: d,
      localSnapshot: async () => ({ projects: [{ id: "local-app", name: "不同本机名称", dirs: ["/synthetic/n4"], personal: false }],
        peers: [{ name: "synthetic-transport", enabled: true, invitable: true }] }) });
  };
  return { handle, sent };
}

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
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture.js") return new Response(Bun.file(join(scratch, "fixture-harness.js")));
    if (path === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
    if (path === "/app-config.json") return Response.json({ mode: "direct", fp: "synthetic-machine" });
    if (path.startsWith("/api/v1/")) return await n4.handle(request) ?? new Response(null, { status: 404 });
    if (path !== "/") return new Response(null, { status: 404 });
    return new Response(`<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>
      <body><div id="root"></div><script src="/fixture.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
  } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
}, 60_000);

afterAll(async () => {
  try {
    // Persist private evidence even if the existing Chromium cleanup subsequently fails its unchanged hook timeout.
    const [head, dirty] = await Promise.all([git("rev-parse", "HEAD"), git("status", "--porcelain", "--", "web", "tests")]);
    if (manifest.length) writeFileSync(join(shots, "manifest.json"), JSON.stringify({
      head, specRev: 1, round: 2,
      fixture: "synthetic UI/cards and machine entry, actual N4 snapshot/route/actions with N1C fixtures, injected teamRole/create/mint/transport; no production center or N2 join",
      summary: "Forms, permissions, CAS/local/recipient choices and N4 invitation approval; production composition and PM acceptance unverified",
      dirty: !!dirty,
      fixtureSha256: createHash("sha256").update(readFileSync(entry)).digest("hex"), shots: manifest,
      testSha256: createHash("sha256").update(readFileSync("tests/web-shared-projects-browser.test.ts")).digest("hex"),
      producerSha256: ["shared-projects.ts", "shared-projects-snapshot.ts", "shared-projects-invite.ts"].map(name => ({ name,
        sha256: createHash("sha256").update(readFileSync(`src/bridge/local-api/${name}`)).digest("hex") })),
    }, null, 2), { mode: 0o600 });
  } finally {
    server?.stop(true);
    try { await browser?.close(); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
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

test("actual N4 source renders binding and invitation approval without claiming unavailable creation or exit", async () => {
  const { page, errors } = await newPage(390, "?fixture=n4-source");
  await page.clock.install();
  try {
    await page.getByRole("button", { name: "合成项目 B", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "合成项目 B", exact: true }).getAttribute("title")).toBe("合成项目 B");
    expect(await page.locator("body").innerText()).not.toContain(createV2ProjectsFixtures().project.teamId);
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByText("中心暂未提供团队权限，创建项目暂不可用。", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "创建项目", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "合成项目 B", exact: true }).last().click();
    await page.getByText("这台机器暂不支持退出团队项目。", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "退出团队项目", exact: true }).count()).toBe(0);
    expect(await page.getByLabel("本机目录（每行一个）").inputValue()).toBe("/synthetic/n4");
    await page.getByLabel("邀请对象", { exact: true }).fill("person-peer");
    expect(await page.getByLabel("邀请对象", { exact: true }).evaluate(el => (el as unknown as { tagName: string }).tagName)).toBe("INPUT");
    expect(await page.getByRole("button", { name: "邀请成员", exact: true }).isDisabled()).toBe(true);
    await page.getByText("synthetic-transport", { exact: true }).click();
    await page.getByRole("button", { name: "邀请成员", exact: true }).click();
    await page.getByText("邀请确认卡已生成，请由本人核对后发送。", { exact: true }).waitFor();
    await page.clock.fastForward(2000); // Exercise the real cards polling timer without spending the test budget waiting on wall time.
    await page.getByText("邀请加入团队项目 合成项目 B", { exact: true }).waitFor();
    expect(n4.sent).toEqual([]);
    expect(await page.locator("body").innerText()).not.toContain(createV2ProjectsFixtures().invite.code);
    await screenshot(page, "n4-api-invite-approval-390");
    await page.getByRole("button", { name: "发送邀请", exact: true }).click();
    await page.getByText("暂无待确认的项目操作。", { exact: true }).waitFor();
    expect(n4.sent).toHaveLength(1);
    expect((n4.sent[0] as { projectInvite: { personId: string } }).projectInvite.personId).toBe("person-peer");
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

for (const width of [390, 1280]) test(`project forms, explicit CAS retry, invite and local actions at ${width}px`, async () => {
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
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await page.getByText("进行中 · 版本 2", { exact: true }).waitFor();
    expect(await page.getByLabel("项目显示名", { exact: true }).inputValue()).toBe("改名后的团队项目");
    expect(await page.getByRole("button", { name: "按当前版本重试", exact: true }).isVisible()).toBe(true);
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

test("existing recipient requires an explicit personId independent of the peer", async () => {
  const { page, errors } = await newPage(390, "?role=owner");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByLabel("显示名", { exact: true }).fill("邀请测试项目");
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await page.getByRole("button", { name: "邀请测试项目", exact: true }).last().click();
    const submit = page.getByRole("button", { name: "邀请成员", exact: true });
    const recipient = page.getByLabel("邀请对象", { exact: true });
    expect(await submit.isDisabled()).toBe(true);
    await recipient.fill("fixture-existing-person");
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
    await recipient.fill("fixture-existing-person");
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


test("archive then rename and external refresh use the current revision", async () => {
  const { page, errors } = await newPage(390, "?fixture=settings");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByRole("button", { name: "团队工作台", exact: true }).last().click();
    await page.getByRole("button", { name: "归档项目", exact: true }).click();
    await page.getByRole("button", { name: "恢复项目", exact: true }).waitFor();
    await page.getByLabel("项目显示名", { exact: true }).fill("连续修改名称");
    await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await page.getByText("已归档 · 版本 3", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "按当前版本重试", exact: true }).count()).toBe(0);
    await page.evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === '合成外部更新').click()");
    await page.getByText("已归档 · 版本 10", { exact: true }).waitFor();
    expect(await page.getByLabel("项目显示名", { exact: true }).inputValue()).toBe("外部更新名称");
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("external refresh preserves a dirty draft while saving uses the latest revision", async () => {
  const { page, errors } = await newPage(390, "?fixture=settings");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByRole("button", { name: "团队工作台", exact: true }).last().click();
    const name = page.getByLabel("项目显示名", { exact: true });
    await name.fill("我的修改意图");
    await page.evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === '合成外部更新').click()");
    await page.getByText("进行中 · 版本 10", { exact: true }).waitFor();
    expect(await name.inputValue()).toBe("我的修改意图");
    await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await page.getByText("进行中 · 版本 11", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "按当前版本重试", exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("conflict survives focus refresh and newer center values keep the original retry intent", async () => {
  const { page, errors } = await newPage(390, "?fixture=conflict-refresh");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByRole("button", { name: "团队工作台", exact: true }).last().click();
    const name = page.getByLabel("项目显示名", { exact: true });
    await name.fill("保留的名称修改");
    await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await page.getByText("当前名称：同事更新的名称", { exact: true }).waitFor();
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await page.getByText("进行中 · 版本 2", { exact: true }).waitFor();
    expect(await name.inputValue()).toBe("保留的名称修改");
    expect(await page.getByRole("button", { name: "按当前版本重试", exact: true }).isVisible()).toBe(true);
    await page.evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === '合成外部更新').click()");
    await page.getByText("当前名称：外部更新名称", { exact: true }).waitFor();
    await page.getByText("当前状态：进行中 · 版本 10", { exact: true }).waitFor();
    expect(await name.inputValue()).toBe("保留的名称修改");
    expect(JSON.parse((await page.locator("body").getAttribute("data-calls"))!)).toEqual(["patch"]);
    await page.getByRole("button", { name: "按当前版本重试", exact: true }).click();
    await page.getByText("进行中 · 版本 11", { exact: true }).waitFor();
    expect(await name.inputValue()).toBe("保留的名称修改");
    expect(await page.getByRole("button", { name: "按当前版本重试", exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("a transient read keeps the sidebar while revocation removes it", async () => {
  const { page, errors } = await newPage(390, "?fixture=resilience");
  try {
    await page.getByRole("button", { name: "团队工作台", exact: true }).waitFor();
    await page.getByRole("button", { name: "合成临时失败", exact: true }).click();
    await page.waitForFunction("Number(document.body.dataset.reads) >= 2");
    expect(await page.getByRole("button", { name: "团队工作台", exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "合成权限撤销", exact: true }).click();
    await page.waitForFunction("Number(document.body.dataset.reads) >= 3");
    expect(await page.getByRole("button", { name: "团队工作台", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "项目设置", exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("a machine with no binding has no unusable team entry", async () => {
  const { page, errors } = await newPage(390, "?fixture=no-binding");
  try {
    await page.waitForFunction("Number(document.body.dataset.reads) >= 1");
    expect(await page.getByRole("button", { name: "项目设置", exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});


for (const width of [390, 1280]) test(`multiple bindings survive creating a project in the real entry at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [], requested: string[] = [];
  const f = createV2ProjectsFixtures();
  let projects = [f.project];
  let hints = [{ center: f.project.centerId, team: f.project.teamId, project: f.project.projectId,
    person: f.person.personId, homeInstanceId: f.person.instanceId }];
  const local = { projects: [{ id: "local-original", name: "本机旧名", dirs: [], personal: false }], peers: [] };
  const d = { person: async () => ({ ...f.person, ...f.requests.list, subject: "owner:self" }), list: async () => projects,
    members: async (_who: unknown, id: string) => [{ ...f.member, projectId: id }], bindings: () => projects.map((p, i) => ({ centerId: p.centerId, teamId: p.teamId,
      projectId: p.projectId, localProjectId: i === 0 ? "local-original" : "local-new" })) } as unknown as SharedProjectsPorts;
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== String(server.url).replace(/\/$/, "")) { errors.push("non-loopback request"); return route.abort(); }
    if (url.pathname === "/api/v1/shared-ledger/context") return route.fulfill({ json: { identities: hints } });
    if (url.pathname === "/api/v1/shared-projects/snapshot") {
      const source = req.headers()["x-shared-ledger-project"]; requested.push(source ?? "UNSELECTED");
      if (!source) return route.fulfill({ status: 409, json: { error: "original_binding_required" } });
      const raw = await sharedProjectsSnapshot(d, local);
      return route.fulfill({ json: { ...raw, teamRole: { available: true, value: "owner" } } });
    }
    if (url.pathname === "/api/v1/shared-projects" && req.method() === "POST") {
      const input = req.postDataJSON();
      const added = { ...f.project, projectId: "created", name: input.name };
      projects = [...projects, added]; hints = [...hints, { ...hints[0]!, project: "created" }];
      local.projects.push({ id: "local-new", name: "不同的本机名", dirs: [], personal: false });
      return route.fulfill({ json: { ok: true, available: true, operationId: input.operationId } });
    }
    return route.continue();
  });
  try {
    await page.goto(`${server.url}?fixture=bindings-create`);
    await page.getByRole("button", { name: f.project.name, exact: false }).waitFor();
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByLabel("显示名", { exact: true }).fill("新项目中心核验名");
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload(); // A fresh entry now discovers >=2 identities, including the new creator binding.
    await page.getByRole("button", { name: "新项目中心核验名", exact: false }).waitFor();
    expect(await page.getByRole("button", { name: f.project.name, exact: false }).count()).toBe(1);
    expect(requested).toContain(f.project.projectId);
    expect(requested).toContain("created");
    expect(requested).not.toContain("UNSELECTED");
    expect(await page.locator("body").innerText()).not.toContain("项目已被更新");
    await screenshot(page, `multi-binding-entry-${width}`);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("explicit existing personId rejects self and active members but accepts another team member", async () => {
  const { page, errors } = await newPage(390, "?fixture=settings");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByRole("button", { name: "团队工作台", exact: true }).last().click();
    await page.getByText("协作伙伴的机器", { exact: true }).click();
    const recipient = page.getByLabel("邀请对象", { exact: true });
    const submit = page.getByRole("button", { name: "邀请成员", exact: true });
    await recipient.fill("fixture-owner");
    expect(await submit.isDisabled()).toBe(true);
    await recipient.fill("fixture-active-person");
    expect(await submit.isDisabled()).toBe(true);
    await recipient.fill("another-existing-team-person");
    expect(await submit.isEnabled()).toBe(true);
    expect(await page.getByText("中心暂未提供团队成员目录；", { exact: false }).count()).toBe(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});


test("answered-looking create stays pending while explicit release unlocks a new form without another POST", async () => {
  const { page, errors } = await newPage(390, "?fixture=pending");
  try {
    await page.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByLabel("显示名", { exact: true }).fill("已出现但结果未读");
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await page.getByRole("button", { name: "继续完成项目", exact: true }).click();
    expect(await page.getByRole("button", { name: "创建项目", exact: true }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "释放新建表单", exact: true }).click();
    expect(await page.getByRole("button", { name: "继续完成项目", exact: true }).count()).toBe(1);
    expect(await page.getByText("创建结果仍待可信读取；", { exact: false }).count()).toBe(1);
    await page.getByLabel("显示名", { exact: true }).fill("另一项明确新建");
    expect(await page.getByRole("button", { name: "创建项目", exact: true }).isEnabled()).toBe(true);
    expect(JSON.parse((await page.locator("body").getAttribute("data-calls"))!)).toEqual(["create", "complete"]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});


test("cross-team duplicate projectId disables its sources and shows the exact N4 dependency", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errors: string[] = [], snapshots: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== String(server.url).replace(/\/$/, "")) { errors.push("non-loopback request"); return route.abort(); }
    if (url.pathname === "/api/v1/shared-ledger/context") return route.fulfill({ json: { identities: ["team-a", "team-b"].map(team => ({
      center: "synthetic-center", team, project: "same-project", person: "synthetic-person", homeInstanceId: "synthetic-instance",
    })) } });
    if (url.pathname === "/api/v1/shared-projects/snapshot") snapshots.push(route.request().url());
    return route.continue();
  });
  try {
    await page.goto(`${server.url}?fixture=bindings-ambiguous`);
    await page.getByText("需要 N4 选择头带 center/team", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: "项目设置", exact: true }).isDisabled()).toBe(true);
    expect(await page.locator("body").innerText()).not.toContain("项目已被更新");
    expect(snapshots).toEqual([]);
    await screenshot(page, "cross-team-ambiguous-390");
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test("identity conflict removes only its team and leaves the healthy sidebar project visible", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const f = createV2ProjectsFixtures(), requested: string[] = [], errors: string[] = [];
  const raw = await sharedProjectsSnapshot({ person: async () => ({ ...f.person, ...f.requests.list, subject: "owner:self" }),
    list: async () => [f.project], members: async () => [f.member], bindings: () => [{ ...f.identity, localProjectId: "local-app" }],
  } as unknown as SharedProjectsPorts, { projects: [{ id: "local-app", name: "本机名", dirs: [], personal: false }], peers: [] });
  const healthy = { ...raw, identity: { ...raw.identity, teamId: "healthy-team" },
    projects: [{ ...raw.projects[0], teamId: "healthy-team", projectId: "healthy", name: "其他团队核验名" }] };
  const hints = [raw, { ...raw, identity: { ...raw.identity, personId: "old-person" },
    projects: [{ ...raw.projects[0], projectId: "old-project" }] }, healthy].map(r => ({ center: r.identity.centerId,
    team: r.identity.teamId, project: r.projects[0]!.projectId, person: r.identity.personId, homeInstanceId: r.identity.instanceId }));
  let conflict = false;
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== String(server.url).replace(/\/$/, "")) { errors.push("non-loopback request"); return route.abort(); }
    if (url.pathname === "/api/v1/shared-ledger/context") return route.fulfill({ json: {
      identities: conflict ? hints : hints.filter(h => h.person !== "old-person"),
    } });
    if (url.pathname === "/api/v1/shared-projects/snapshot") {
      const source = req.headers()["x-shared-ledger-project"]; requested.push(source ?? "UNSELECTED");
      return route.fulfill({ json: source === "healthy" ? healthy : raw });
    }
    return route.continue();
  });
  try {
    await page.goto(`${server.url}?fixture=bindings-person-conflict`);
    await page.getByRole("button", { name: f.project.name, exact: true }).waitFor();
    await page.getByRole("button", { name: "其他团队核验名", exact: true }).waitFor();
    conflict = true; requested.length = 0;
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await page.getByText("团队身份冲突", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: f.project.name, exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "其他团队核验名", exact: true }).isVisible()).toBe(true);
    expect(requested).toEqual(["healthy"]);
    expect(await page.getByRole("button", { name: "项目设置", exact: true }).isEnabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
