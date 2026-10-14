/** Same synthetic data and production components for both git-archive baseline and working tree; no live bridge traffic. */
import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardedPage } from "./helpers/collab-fixture-serve";
import { shotIssues } from "./helpers/ui-shot-checks";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { BANNED_OWNER_WORDS, MACHINE_WORDS, STEP_WORD, ownerWordEn } from "../web/lib/owner-words";
import type { TaskDetail } from "../web/features/collab/collab-detail-model";

const out = process.env.UXTERM3_SHOTS_DIR;
const base = process.env.UXTERM3_BASE_REPO;
const repoRoot = resolve(import.meta.dir, "..");
const PHRASES = [MACHINE_WORDS.visibleThere, MACHINE_WORDS.originalThere, MACHINE_WORDS.openSessionThere];
const EN = ["Only visible on the machine running this task", "Original text is only visible on the machine running this task",
  "Open sessions on the machine running this task"];

function fixture(variant: string) {
  const home = generateHomeFixture();
  const original = home.details["i28-A5"]!;
  const task = { ...original.task, title: "统一任务展示用语", agent: null, pm: null, pr: null, extra: {} };
  const event = { seq: 1, ts: home.now, actor: "agent-dev", target: task.id, kind: "note", text: "已准备实现", data: {} };
  const detail: TaskDetail = { task, now: home.now, timeline: [],
    sessions: variant === "empty" ? {} : { author: { agent: "agent-dev" } }, events: variant === "empty" ? [] : [event],
    stepLine: { steps: [{ step: "write", executor: "agent-dev", state: "assigned", round: 0 }], active: { step: "write", round: 0 } } };
  if (variant === "review") detail.events.push({ ...event, seq: 2, kind: "review", text: "需要调整用语", data: { round: 1, verdict: "changes", reviewer: "agent-reviewer" } });
  return { detail, ov: { ...home.overview, tasks: [task], items: [], deps: [] } };
}

async function bundle(repo: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const from = (path: string) => JSON.stringify(resolve(repo, path));
  const entry = resolve(dir, "entry.ts");
  await Bun.write(entry, `import { createElement as h } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { setLang } from ${from("web/lib/i18n.tsx")};
import { useCollabT } from ${from("web/features/collab/collab-i18n.ts")};
import { CollabDetail } from ${from("web/features/collab/collab-detail.tsx")};
import { CollabSourceContext } from ${from("web/features/collab/team-source-context.ts")};
import { ChatStoreProvider } from ${from("web/features/chat/chat-store.ts")};
import { TeamSessionSec } from ${from("web/features/collab/team-session/team-session-view.tsx")};
import { sharedCollabProject } from ${from("web/features/collab/team-source-key.ts")};
import styles from ${from("web/features/collab/collab.module.css")};
const q = new URLSearchParams(location.search);
setLang(q.get("lang") === "en" ? "en" : "zh");
const { detail, ov } = await (await fetch('/fixture.json?variant=' + (q.get('variant') || 'detail'))).json();
const project = sharedCollabProject({ center: 'center', team: 'team-a', person: 'person-a', project: 'fixture', machine: 'local' });
const source = { homeOnly: new Set(['events.text', 'review.text', 'sessions']),
  task: async () => detail, overview: async () => ov, follow: async () => {} };
function App() {
  const tr = useCollabT();
  return q.get('view') === 'session' ? h('aside', { className: styles.tokens, style: { width: 'min(100%, 560px)', padding: 16 } },
    h(TeamSessionSec, { project, featureId: 'F1', cardId: 'CARD1', tr })) : h(CollabSourceContext.Provider, { value: source },
    h(CollabDetail, { project, id: detail.task.id, rev: 1, now: detail.now, ov, reviewers: [], actions: new Map(),
      action: () => ({ kind: 'idle', text: '' }), onClose: () => {} }));
}
createRoot(document.getElementById('root')).render(h(ChatStoreProvider, null, h(App)));
`);
  const p = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", resolve(dir, "dist"),
    "--tsconfig-override", "web/tsconfig.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return resolve(dir, "dist");
}

function serve(dist: string) {
  const files = readdirSync(dist);
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const u = new URL(req.url), path = u.pathname;
    if (path === "/fixture.json") return Response.json(fixture(u.searchParams.get("variant") ?? "detail"));
    if (path === "/app-config.json") return Response.json({ mode: "direct", fp: "local", machineName: "fixture" });
    if (path === "/api/v1/shared-ledger/features/F1") return Response.json({ tasks: [{ sourceTaskId: "CARD1", taskId: "task-1" }] });
    if (path.endsWith("/session-pages")) return Response.json({ code: "not_open" }, { status: 409 });
    if (path === "/") return new Response(`<!doctype html><html data-theme="light"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      ${files.filter(f => f.endsWith('.css')).map(f => `<link rel="stylesheet" href="/${f}">`).join('')}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0}
      h5{margin:0}#root{height:100vh;display:flex;justify-content:flex-end;position:relative}</style></head>
      <body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
    if (files.includes(path.slice(1))) return new Response(Bun.file(resolve(dist, path.slice(1))));
    return Response.json({ ok: false, error: "not in fixture" }, { status: 404 });
  } });
}

async function save(page: Page, phase: string, view: string, width: number, lang: string, texts: Record<string, string>) {
  await page.evaluate("document.fonts.ready");
  const text = await page.locator("body").innerText();
  const name = `${phase}-${view}-${width}-${lang}`;
  texts[name] = text;
  if (phase === "after") expect(BANNED_OWNER_WORDS.filter(w => text.includes(w))).toEqual([]);
  if (lang === "zh") {
    await page.screenshot({ path: resolve(out!, `${name}.png`) });
    expect(await shotIssues(page)).toEqual([]);
  }
  return text;
}

async function details(page: Page, url: string, phase: string, width: number, lang: "zh" | "en", texts: Record<string, string>) {
  for (const variant of ["detail", "empty", "review"]) {
    await page.goto(`${url}?lang=${lang}&variant=${variant}`);
    await page.locator('[data-home-only="events.text"]').waitFor();
    await page.locator("aside").evaluate(el => {
      const pane = el as unknown as { scrollTop: number; scrollHeight: number };
      pane.scrollTop = pane.scrollHeight;
    });
    const text = variant === "detail" ? await save(page, phase, "detail", width, lang, texts) : await page.locator("body").innerText();
    if (phase !== "after") continue;
    expect(text).not.toMatch(/主场|\bhome\b/i);
    const words = lang === "zh" ? PHRASES : EN;
    expect(await page.locator('[data-home-only="events.text"]').innerText()).toBe(words[variant === "empty" ? 0 : 1]!);
    expect(await page.locator('[data-home-only="review.text"]').innerText()).toBe(words[variant === "review" ? 1 : 0]!);
    expect(await page.locator('[data-home-only="sessions"]').innerText()).toBe(words[variant === "empty" ? 0 : 2]!);
    const steps = (await page.locator('[data-step]').allInnerTexts()).join(' ');
    for (const key of ["restate", "write", "review", "fix", "ui_check"]) expect(steps).toContain(lang === "zh" ? STEP_WORD[key]! : ownerWordEn(STEP_WORD[key]!)!);
    if (lang === "en") expect(steps).not.toMatch(/\bRestate\b|\bWrite\b/);
  }
}

async function sessions(page: Page, url: string, phase: string, width: number, lang: "zh" | "en", texts: Record<string, string>) {
  for (const [code, status, zh, en] of [
    ["home_offline", 503, "任务所在的机器离线，暂时看不了会话", "The machine running this task is offline, sessions cannot be viewed right now"],
    ["gate_refused", 403, "任务所在的机器拒绝提供这张卡的会话", "The machine running this task declined to send this card's sessions"],
    ["not_open", 409, "任务所在的机器未开放会话", "The machine running this task has not opened sessions"],
  ] as const) {
    await page.route('**/session-pages', r => r.fulfill({ status, json: { code } }));
    await page.goto(`${url}?view=session&lang=${lang}`);
    await page.locator('[data-session-toggle]').click();
    await page.locator(`[data-session-status="${code}"]`).waitFor();
    const error = code === "not_open" ? await save(page, phase, "session-error", width, lang, texts) : await page.locator("body").innerText();
    if (phase === "after") {
      expect(error).not.toMatch(/主场|home machine/i);
      expect(error).toContain(lang === "zh" ? zh : en);
    }
    await page.unroute('**/session-pages');
  }
  await page.route('**/session-pages', r => r.fulfill({ json: { requestId: 'req-fixture', expiresAt: Date.now() + 60_000 } }));
  // Hold the poll at a stable real loading state until the page closes; no artificial DOM replacement.
  await page.route('**/session-pages/req-fixture', r => r.fulfill({ json: { status: 'pending', requestId: 'req-fixture', expiresAt: Date.now() + 60_000, result: null } }));
  await page.reload();
  await page.locator('[data-session-toggle]').click();
  await page.locator('[data-session-status="loading"]').waitFor();
  const loading = await save(page, phase, "session-loading", width, lang, texts);
  if (phase === "after") {
    expect(loading).not.toMatch(/主场|home machine/i);
    expect(loading).toContain(lang === "zh" ? "正在向任务所在的机器读取会话…" : "Reading the session from the machine running this task…");
    expect(loading).toContain(lang === "zh" ? "按页向任务所在的机器读取，只读" : "Read page by page from the machine running this task, read-only");
  }
}

test.skipIf(!out)("UXTERM3 三处占位、步骤线及会话读取/错误，中英桌面手机前后对照", async () => {
  mkdirSync(out!, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const texts: Record<string, string> = {};
  try {
    const sides = [...(base ? [{ phase: "before", repo: base }] : []), { phase: "after", repo: repoRoot }];
    for (const { phase, repo } of sides) {
      const server = serve(await bundle(repo, resolve(out!, `bundle-${phase}`)));
      try {
        for (const width of [1280, 390]) for (const lang of ["zh", "en"] as const) {
          const g = await guardedPage(browser, String(server.url), { width });
          await g.page.clock.setFixedTime(fixture("detail").detail.now);
          await details(g.page, String(server.url), phase, width, lang, texts);
          await sessions(g.page, String(server.url), phase, width, lang, texts);
          expect({ external: g.external, errors: g.errors }).toEqual({ external: [], errors: [] });
          await g.ctx.close();
        }
      } finally { server.stop(true); }
    }
  } finally {
    await browser.close();
    await Bun.write(resolve(out!, "inner-text.json"), JSON.stringify(texts, null, 2));
  }
}, 600_000);
