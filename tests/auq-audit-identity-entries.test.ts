/**
 * hardening-AUQID1：AUQ 换问题立即换代，旧卡作答前核完整现场身份——三条真实入口 + pane 观察器。
 *
 * 子进程：临时 HOME / 状态目录 / 运行目录、最小 env（testChildEnv）、死 bridge，PATH 最前面是一个假 tmux（sh 脚本）：
 * 按 argv 应答 list-panes / capture-pane / if-shell / send-keys，画面是临时目录里的合成文件，真正落到 pane 的键记进 keys 文件。
 * 入口都是真的：POST /api/v1/agents/:name/answer（serveApiRequest，真鉴权）、Discord interactionCreate 监听（按钮 / 选单）、
 * jsonl-watcher 读合成会话文件、permission-watcher 每轮调的 watchAuqPane。注入的只有 manager list（不起子进程）和假 Discord 客户端。
 * 「验收线 1」的两条用例只用旧代码也有的入口：在旧实现上跑得起来、断言失败（Q1 状态留下、旧卡的 Down+Enter 落进 Q2）。
 */
import { expect, mock, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { testChildEnv } from "./test-env.ts";

const CHILD_FLAG = "CLAUDESTRA_TEST_AUQID1_CHILD";
const FAKE_DIR = "CLAUDESTRA_TEST_AUQID1_FAKE";

/** 假 tmux：owner.<窗口名> = 名字绑在哪个 pane；screen.<n> = 画面；gone.<n> / failcap.<n> = pane 没了 / 抓屏失败；hook = 每次抓屏、每个键之后执行 */
const fakeTmux = (d: string) => `#!/bin/sh
d='${d}'
shift 4
cmd=$1; t=; fmt=; prev=
for a in "$@"; do
  [ "$prev" = -t ] && [ -z "$t" ] && t=$a
  [ "$prev" = -F ] && fmt=$a
  prev=$a
done
case "$t" in
  master:=*) n=$(cat "$d/owner.\${t#master:=}" 2>/dev/null) ;;
  %*|@*) n=\${t#?} ;;
  *) n= ;;
esac
[ -n "$n" ] && [ -f "$d/gone.$n" ] && n=
[ -n "$n" ] && [ ! -f "$d/screen.$n" ] && n=
if [ -z "$n" ]; then printf "can't find target: %s\\n" "$t" >&2; exit 1; fi
wname=$(cat "$d/wname.$n")
bump() { c=$(cat "$d/$1" 2>/dev/null || echo 0); count=$((c+1)); printf %s "$count" > "$d/$1"; }
hook() { ev=$1; if [ -f "$d/hook" ]; then . "$d/hook"; fi; return 0; }
landed() { printf '%%%s %s\\n' "$n" "$1" >> "$d/keys"; bump keycount; hook key; }
case "$cmd" in
  list-panes)
    case "$fmt" in
      *pane_active*) printf '1\\t%%%s\\n' "$n" ;;
      *pane_dead*) printf '%%%s\\t0\\t@%s\\t%s\\n' "$n" "$n" "$wname" ;;
      *window_id*) printf '@%s\\n' "$n" ;;
      *) printf '0\\n' ;;
    esac ;;
  capture-pane)
    if [ -f "$d/failcap.$n" ]; then echo "capture failed" >&2; exit 1; fi
    cat "$d/screen.$n"; bump "caps.$n"; hook cap ;;
  send-keys)
    for key in "$@"; do :; done
    landed "$key" ;;
  if-shell)
    ww=$(printf '%s' "$5" | sed -n 's/.*#{==:#{window_id},\\(@[0-9]*\\)}.*/\\1/p')
    wn=$(printf '%s' "$5" | sed -n 's/.*#{==:#{window_name},\\([^}]*\\)}.*/\\1/p')
    if [ "$ww" != "@$n" ] || [ "$wn" != "$wname" ]; then echo claudestra-send-refused; exit 0; fi
    landed "\${6##* }" ;;
esac
`;

if (process.env[CHILD_FLAG] !== "1") {
  test("auq-audit-identity-entries（子进程：假 tmux 在 PATH 最前，临时 HOME / 状态 / 运行目录，最小 env，死 bridge）", async () => {
    const root = mkdtempSync(join(tmpdir(), "auqid1-"));
    const [home, tmp, bin, fake] = ["home", "tmp", "bin", "fake"].map((x) => join(root, x));
    for (const dir of [home, tmp, bin, fake, join(tmp, "runtime")]) mkdirSync(dir); // 运行目录放按窗口的发键锁
    writeFileSync(join(root, "empty.env"), "");
    writeFileSync(join(bin, "tmux"), fakeTmux(fake));
    chmodSync(join(bin, "tmux"), 0o755);
    try {
      const child = Bun.spawn([process.execPath, `--env-file=${join(root, "empty.env")}`, "test", import.meta.path], {
        cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
        env: testChildEnv({
          HOME: home, TMPDIR: tmp, LANG: "C", PATH: `${bin}:/usr/bin:/bin`, [FAKE_DIR]: fake, [CHILD_FLAG]: "1",
          CLAUDESTRA_STATE_DIR: join(home, ".claude-orchestrator"), CLAUDESTRA_RUNTIME_DIR: join(tmp, "runtime"),
        }),
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`子进程 bun test 退出码 ${code}\n${(out + err).slice(-12000)}`);
      expect(err).toMatch(/\b0 fail\b/);
      expect(err).toMatch(/\b[1-9]\d* pass\b/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
} else {
  await childSuite();
}

type Opt = [label: string, description: string];
const single = (header: string, question: string, opts: Opt[], cursor = 0) => [
  "⏺ working", "", ` ☐ ${header}`, "", question, "",
  ...opts.flatMap(([label, desc], i) => [`${i === cursor ? "❯" : " "} ${i + 1}. ${label}`, `     ${desc}`]),
  `  ${opts.length + 1}. Type something.`, "", "Enter to select · ↑/↓ to navigate · Esc to cancel", "",
].join("\n");
const tabbed = (tabs: string[], question: string, labels: string[], checked: number[] = [], cursor = 0) => [
  `←  ${tabs.map((s) => `☐ ${s}`).join("  ")}  ✔ Submit  →`, "", question, "",
  ...labels.map((label, i) => `${i === cursor ? "❯" : " "} ${i + 1}. ${checked.includes(i) ? "[✔]" : "[ ]"} ${label}`),
  `  ${labels.length + 1}. [ ] Type something`, "     Next", "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel", "",
].join("\n");
const REVIEW = "←  ☒ Charts  ✔ Submit  →\n\nReview your answers\n\n❯ 1. Submit answers\n\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n";
const IDLE = "⏺ 好的，已完成。\n\n❯ \n";

const Q1_OPTS: Opt[] = [["Red", "Warm"], ["Blue", "Cold"]];
const Q2_OPTS: Opt[] = [["Small", "S"], ["Large", "L"]];
const Q1 = single("Color", "Which color?", Q1_OPTS);
const Q2 = single("Size", "Which size?", Q2_OPTS);
const asJsonl = (header: string, question: string, opts: Opt[]) => ({ question, header, multiSelect: false, options: opts.map(([label, description]) => ({ label, description })) });
const Q1_JSONL = asJsonl("Color", "Which color?", Q1_OPTS);
const Q2_JSONL = asJsonl("Size", "Which size?", Q2_OPTS);

interface Agent { name: string; channelId: string; pane: number; sessionId: string }

async function childSuite(): Promise<void> {
  const { describe, test: it, beforeAll, spyOn } = await import("bun:test");
  const fake = process.env[FAKE_DIR]!;
  const home = process.env.HOME!;
  const agent = (tag: string, pane: number, channelId = `local-auqid1-${tag}`): Agent => ({ name: `agent-auq-${tag}`, channelId, pane, sessionId: `sess-${tag}` });
  const A = {
    apiRotate: agent("api-rotate", 1), dcRotate: agent("dc-rotate", 2, "424200000000000002"), paneKeep: agent("pane-keep", 3),
    apiSession: agent("api-session", 4), dcPane: agent("dc-pane", 5, "424200000000000005"), jsonlPane: agent("jsonl-pane", 7),
    unread: agent("unread", 9, "424200000000000009"), midway: agent("midway", 10), vanish: agent("vanish", 11), multi: agent("multi", 13),
    form: agent("form", 14), cancel: agent("cancel", 15),
  };
  const all = Object.values(A);

  // ── 假 tmux 的状态文件 ──
  const screen = (pane: number, text: string) => writeFileSync(join(fake, `screen.${pane}`), text);
  const bind = (a: Agent, pane = a.pane) => {
    writeFileSync(join(fake, `owner.${a.name}`), String(pane));
    writeFileSync(join(fake, `wname.${pane}`), a.name);
  };
  const keys = () => (existsSync(join(fake, "keys")) ? readFileSync(join(fake, "keys"), "utf8").split("\n").filter(Boolean) : []);
  /** 清键记录与计数；hook = 之后每次抓屏（ev=cap，count 按 pane 计）/ 每个键（ev=key，count 全局）执行的 sh */
  const arm = (hook = "") => {
    for (const f of readdirSync(fake)) if (f === "keys" || f === "keycount" || f === "hook" || f.startsWith("caps.")) rmSync(join(fake, f));
    if (hook) writeFileSync(join(fake, "hook"), hook);
  };
  all.forEach((a) => bind(a));

  const { REGISTRY_PATH } = await import("../src/lib/registry.ts");
  const writeRegistry = () => writeFileSync(REGISTRY_PATH, JSON.stringify({
    agents: Object.fromEntries(all.map((a) => [a.name, {
      name: a.name, status: "active", cwd: join(home, "repo"), sessionId: a.sessionId, channelId: a.channelId, purpose: "t", created: "2026-10-01T00:00:00Z",
    }])),
  }));
  mkdirSync(join(home, ".claude-orchestrator"), { recursive: true });
  writeRegistry();

  const realMgmt = await import("../src/bridge/management.ts");
  mock.module(join(import.meta.dir, "../src/bridge/management.ts"), () => ({
    ...realMgmt,
    runManager: async (...args: string[]) => (args[0] === "list"
      ? { ok: true, agents: all.map((a) => ({ name: a.name, status: "active", idle: true, channelId: a.channelId, sessionId: a.sessionId, cwd: join(home, "repo") })) }
      : { ok: false, error: `manager ${args[0]} 不在本测试里` }),
  }));

  const { auqStates } = await import("../src/bridge/ask-user-question.ts");
  const { initApiRoutes, serveApiRequest } = await import("../src/bridge/api-routes.ts");
  const { setRequestContext } = await import("../src/bridge/request-context.ts");
  const { registerInteractionHandlers } = await import("../src/bridge/discord-interactions.ts");
  const { startWatching } = await import("../src/bridge/jsonl-watcher.ts");
  const { WATCHER_CONFIG } = await import("../src/bridge/config.ts");
  const { subscribeEvents } = await import("../src/bridge/event-bus.ts");
  const { initRuntimeAsks } = await import("../src/bridge/ask-runtime.ts");
  const { setAsksForTest } = await import("../src/bridge/asks.ts");
  const { listAsks } = await import("../src/lib/ledger-asks.ts");
  const { openLedger } = await import("../src/lib/ledger-store.ts");
  const { newTokenPrincipal, updatePrincipals } = await import("../src/lib/principals.ts");
  const sessionPaths = await import("../src/lib/session-path-resolve.ts");
  // 本卡新入口：旧代码里没有，只有用到它的用例失败
  const paneTick = async (a: Agent) => (await import("../src/bridge/ask-user-question.ts") as unknown as {
    watchAuqPane(agent: string, channel: string, pane: string, allow: string[], discord: unknown): Promise<boolean>;
  }).watchAuqPane(a.name, a.channelId, readFileSync(join(fake, `screen.${a.pane}`), "utf8"), [], discord);

  // ── 假 Discord：记每条发出的消息（卡片的按钮 id 从这里取）和之后对它的编辑 ──
  interface Posted { id: string; channel: string; content: string; components: { components: { custom_id: string }[] }[]; edits: { components?: unknown[] }[] }
  const posted: Posted[] = [];
  let fire: (interaction: unknown) => Promise<void> = async () => {};
  const discord = {
    on: (_ev: string, fn: typeof fire) => void (fire = fn),
    channels: { fetch: async (channel: string) => ({
      send: async (m: { content: string; components?: Posted["components"] }) => {
        posted.push({ id: `m${posted.length + 1}`, channel, content: m.content, components: m.components ?? [], edits: [] });
        return { id: `m${posted.length}` };
      },
      messages: { fetch: async (id: string) => ({ edit: async (e: Posted["edits"][number]) => void posted.find((p) => p.id === id)!.edits.push(e) }) },
    }) },
  } as never;
  const cards = (a: Agent) => posted.filter((p) => p.channel === a.channelId && p.components.length > 0);
  const idOf = (card: Posted, suffix: string) => card.components.flatMap((r) => r.components).map((c) => c.custom_id).find((c) => c.endsWith(suffix))!;
  /** 点 card 上的按钮（submit / cancel），或在它的选单上选 values；返回 bridge 的回执文字 */
  const click = async (a: Agent, card: Posted, suffix: string, values?: string[]) => {
    const replies: string[] = [];
    await fire({
      type: 3, channelId: a.channelId, user: { id: "u1", username: "u" }, customId: idOf(card, suffix), values: values ?? [], message: { id: card.id, content: card.content },
      isChatInputCommand: () => false, isButton: () => !values, isStringSelectMenu: () => !!values,
      deferUpdate: async () => {}, deferReply: async () => {}, editReply: async (r: { content: string }) => void replies.push(r.content),
    });
    return replies.join("\n");
  };

  // ── JSONL：每个 agent 一份合成会话文件 ──
  const sessionFile = (a: Agent) => join(home, `${a.sessionId}.jsonl`);
  spyOn(sessionPaths, "resolveSessionPath").mockImplementation((_rt, _cwd, sid) => (appendFileSync(join(home, `${sid}.jsonl`), ""), join(home, `${sid}.jsonl`)));
  const watch = (a: Agent) => startWatching(a.name, join(home, "repo"), a.sessionId, a.channelId, discord);
  const askInJsonl = async (a: Agent, question: unknown) => {
    const content = [{ type: "tool_use", id: `tool_${Date.now()}`, name: "AskUserQuestion", input: { questions: [question] } }];
    appendFileSync(sessionFile(a), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content } }) + "\n");
    await Bun.sleep(WATCHER_CONFIG.pollMs * 3);
  };

  // ── 事件、「待你处理」、API ──
  const events: { chat: string; type: string; reason?: unknown; text?: unknown }[] = [];
  subscribeEvents({}, (e) => {
    const d = (e.data ?? {}) as { reason?: unknown; text?: unknown };
    if (e.type === "question" || e.type === "question_cleared" || e.type === "assistant_text") events.push({ chat: e.chatId, type: e.type, reason: d.reason, text: d.text });
  });
  const seen = (a: Agent, type: string) => events.filter((e) => e.chat === a.channelId && e.type === type);
  const state = (a: Agent) => auqStates.get(a.channelId) as (ReturnType<typeof auqStates.get> & { gen?: string }) | undefined;
  const ledgerPath = join(home, "auqid1-ledger.sqlite");
  const auqAsks = (a: Agent) => listAsks(openLedger(ledgerPath), { source: "auq" }).filter((x) => x.fromChannelId === a.channelId);
  let secret = "";
  const answer = async (a: Agent, body: Record<string, unknown>) => {
    const req = new Request(`http://127.0.0.1:9/api/v1/agents/${a.name}/answer`, {
      method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "auq", ...body }),
    });
    setRequestContext(req, { source: "loopback", clientIp: null, https: false });
    const res = await serveApiRequest(req, new URL(req.url));
    return { status: res.status, body: (await res.json()) as { ok: boolean; code?: string; keys?: number; cancelled?: boolean } };
  };

  beforeAll(async () => {
    const owner = { ...newTokenPrincipal("auqid1-owner", ["*"]), name: "web-ui" }; // 老 web 前端的 owner 凭据：按名字认 owner
    secret = owner.secret!;
    await updatePrincipals((f) => (f.principals.push(owner), { changed: true, result: null }));
    openLedger(ledgerPath);
    setAsksForTest({
      path: ledgerPath, ownerChats: [], registry: all.map((a) => ({ name: a.name, channelId: a.channelId, status: "active", projectId: "p" })) as never,
      deps: { clients: new Map(), controlChannelId: "999", hold: () => {}, deliver: async (env: unknown) => ({ envelope: env, outcome: { kind: "sent" } }), editDiscord: async () => {} } as never,
    });
    initRuntimeAsks();
    initApiRoutes({
      clients: new Map(), deliver: async (env: unknown) => ({ envelope: env, outcome: { kind: "sent" } }), mirrorApiExchange: async () => {},
      startTypingWithSafety: () => {}, lastMessageSource: new Map(), handleEventsRequest: () => new Response("events"), scheduleClearRotation: () => {},
    } as never);
    registerInteractionHandlers(discord, {
      allowedDiscordIds: () => ["u1"], clients: new Map(), controlChannelId: "999", deliver: async () => { throw new Error("deliver 不该被调"); },
      startTypingWithSafety: () => {}, scheduleClearRotation: () => {}, runManager: async () => ({ ok: false }), buildStatusPanel: async () => ({ text: "", components: [] }),
      handleMgmtButton: async () => null, handleMgmtSelect: async () => null,
    } as never);
  });

  describe("[验收线 1] 连续 Q1 / Q2、选项数相同、中间没有空窗", () => {
    it("JSONL + API：question 事件 2 次、旧卡清、状态是 Q2；Q1 卡的提交 / 取消全 stale 且零键，Q2 正常作答", async () => {
      const a = A.apiRotate;
      screen(a.pane, Q1);
      await watch(a);
      await askInJsonl(a, Q1_JSONL);
      expect(state(a)?.questions[0].question).toBe("Which color?");
      const gen1 = state(a)?.gen;
      const [ask1] = auqAsks(a);
      screen(a.pane, Q2);
      await askInJsonl(a, Q2_JSONL);
      const rotated = { questions: seen(a, "question").length, cleared: seen(a, "question_cleared").map((e) => e.reason), now: state(a)?.questions[0].question };
      const gen2 = state(a)?.gen;
      const ask2 = auqAsks(a).find((x) => x.state === "open")!;

      arm();
      const oldCard: unknown[] = [];
      for (const old of [{ gen: gen1 }, { askId: ask1.id }, { gen: gen1, askId: ask2.id }]) {
        oldCard.push((await answer(a, { ...old, action: "submit", selections: [[1]] })).body.code, (await answer(a, { ...old, action: "cancel" })).status);
      }
      // 一次比完：旧实现在这里同时露出「Q1 状态留下」和「旧卡的第 2 项变成 Q2 上的 Down+Enter」
      expect({ rotated, oldCard, keysFromOldCard: keys(), selections: state(a)?.selections }).toEqual({
        rotated: { questions: 2, cleared: ["stale"], now: "Which size?" },
        oldCard: ["ask_stale", 409, "ask_stale", 409, "ask_stale", 409], keysFromOldCard: [], selections: [[]],
      });
      expect(auqAsks(a).find((x) => x.id === ask1.id)!.state).toBe("cancelled");
      expect(state(a)?.gen).toBe(gen2);

      const ok = await answer(a, { gen: gen2, askId: ask2.id, action: "submit", selections: [[1]] });
      expect(ok).toEqual({ status: 200, body: { ok: true, keys: 2 } });
      expect(keys()).toEqual([`%${a.pane} Down`, `%${a.pane} Enter`]);
      expect(state(a)).toBeUndefined();
      const done = auqAsks(a).find((x) => x.id === ask2.id)!;
      expect([done.state, done.answer?.labels]).toEqual(["answered", ["Large"]]);
    }, 30_000);

    it("JSONL + Discord：旧卡的选单 / Submit / Cancel 不改新状态、零键；新卡的选择照常发键", async () => {
      const a = A.dcRotate;
      screen(a.pane, Q1);
      await watch(a);
      await askInJsonl(a, Q1_JSONL);
      const [card1] = cards(a);
      await click(a, card1, ":q0", ["1"]);
      expect(state(a)?.selections).toEqual([[1]]);
      screen(a.pane, Q2);
      await askInJsonl(a, Q2_JSONL);
      expect(seen(a, "question").length).toBe(2);
      expect(state(a)?.questions[0].question).toBe("Which size?");
      const card2 = cards(a)[1];
      expect(card2.id).not.toBe(card1.id);
      expect(card1.edits.at(-1)?.components).toEqual([]); // 旧卡的按钮当场收掉

      arm();
      await click(a, card1, ":q0", ["1"]);
      expect(state(a)?.selections).toEqual([[]]);
      expect(await click(a, card1, ":submit")).toContain("作废");
      expect(await click(a, card1, ":cancel")).toContain("作废");
      expect(keys()).toEqual([]);
      expect(state(a)?.questions[0].question).toBe("Which size?");

      await click(a, card2, ":q0", ["1"]);
      expect(await click(a, card2, ":submit")).toContain("Q1: Large");
      expect(keys()).toEqual([`%${a.pane} Down`, `%${a.pane} Enter`]);
      expect(seen(a, "question_cleared").map((e) => e.reason)).toEqual(["stale", "submit"]);
    }, 30_000);
  });

  describe("[验收线 2] 同一规则：同问题不换卡，现场换代拒旧卡，pane 失读不盲发", () => {
    it("pane 观察器：光标 / 勾选变动不新建卡；换成另一个问题当轮换代", async () => {
      const a = A.paneKeep;
      const labels = ["Bar", "Line", "Area"];
      screen(a.pane, tabbed(["Charts"], "Which charts?", labels));
      expect(await paneTick(a)).toBe(true);
      const gen = state(a)?.gen;
      for (const [checked, cursor] of [[[1], 1], [[0, 2], 2]] as const) {
        screen(a.pane, tabbed(["Charts"], "Which charts?", labels, [...checked], cursor));
        expect(await paneTick(a)).toBe(true);
      }
      expect(seen(a, "question").length).toBe(1);
      expect(state(a)?.gen).toBe(gen);
      screen(a.pane, tabbed(["Charts"], "Which tables?", labels));
      expect(await paneTick(a)).toBe(true);
      expect(seen(a, "question").length).toBe(2);
      expect(state(a)?.gen).not.toBe(gen);
      expect(state(a)?.questions[0].question).toBe("Which tables?");
    });

    it("API：文字相同但会话已换——不带任何卡片标识的提交也是 stale、零键", async () => {
      const a = A.apiSession;
      screen(a.pane, Q1);
      await watch(a);
      await askInJsonl(a, Q1_JSONL);
      expect(state(a)).toBeDefined();
      a.sessionId = "sess-api-session-restarted";
      writeRegistry();
      arm();
      const r = await answer(a, { action: "submit", selections: [[1]] });
      expect([r.status, r.body.code, r.body.keys]).toEqual([409, "ask_stale", 0]);
      expect((await answer(a, { action: "cancel" })).status).not.toBe(200);
      expect(keys()).toEqual([]);
    }, 30_000);

    it("Discord：文字相同但名字已落到另一个 pane——旧卡零键，两个 pane 都没收到键", async () => {
      const a = A.dcPane;
      screen(a.pane, Q1);
      await watch(a);
      await askInJsonl(a, Q1_JSONL);
      const [card] = cards(a);
      screen(a.pane + 1, Q1);
      bind(a, a.pane + 1); // 窗口重建：同名、同一屏文字
      arm();
      expect(await click(a, card, ":submit")).toContain("作废");
      expect(await click(a, card, ":cancel")).not.toContain("已取消");
      expect(keys()).toEqual([]);
    }, 30_000);

    it("JSONL：文字相同但名字已落到另一个 pane——旧卡清、注册新一代；对不上屏的 tool_use 不开卡", async () => {
      const a = A.jsonlPane;
      screen(a.pane, Q1);
      await watch(a);
      await askInJsonl(a, Q1_JSONL);
      const gen = state(a)?.gen;
      expect(gen).toBeTruthy();
      screen(a.pane + 1, Q1);
      bind(a, a.pane + 1);
      await askInJsonl(a, Q1_JSONL);
      expect(seen(a, "question").length).toBe(2);
      expect(state(a)?.gen).not.toBe(gen);
      arm();
      expect((await answer(a, { gen, action: "submit", selections: [[1]] })).body.code).toBe("ask_stale");
      expect(keys()).toEqual([]);
      // 迟到的 Q2 tool_use（屏上仍是 Q1）：不给屏上的弹框换上 Q2 的文字
      await askInJsonl(a, Q2_JSONL);
      expect(state(a)?.questions[0].question).toBe("Which color?");
      expect(seen(a, "question").length).toBe(2);
    }, 30_000);

    it("pane 失读：API / Discord 都不盲发，JSONL 不开卡；读得到之后同一张卡照常作答", async () => {
      const a = A.unread;
      const dead = join(fake, `failcap.${a.pane}`);
      screen(a.pane, Q1);
      await watch(a);
      writeFileSync(dead, "");
      await askInJsonl(a, Q1_JSONL);
      expect(state(a)).toBeUndefined(); // 读不到屏 = 不知道弹框在不在：不开卡
      rmSync(dead);
      await askInJsonl(a, Q1_JSONL);
      const [card] = cards(a);
      await click(a, card, ":q0", ["1"]);
      writeFileSync(dead, "");
      arm();
      const r = await answer(a, { action: "submit", selections: [[1]] });
      expect([r.status, r.body.code, r.body.keys]).toEqual([409, "ask_stale", 0]);
      expect(await click(a, card, ":submit")).toContain("没有发键");
      expect(await click(a, card, ":cancel")).not.toContain("已取消");
      expect(keys()).toEqual([]);
      rmSync(dead);
      expect(await click(a, card, ":submit")).toContain("Q1: Blue");
      expect(keys()).toEqual([`%${a.pane} Down`, `%${a.pane} Enter`]);
    }, 30_000);
  });

  describe("[验收线 3] 作答途中换了弹框 / 现场：不注入新框；原有作答保持", () => {
    it("入口核完之后弹框换成 Q2：零键；Down 落地之后才换：Enter 不发", async () => {
      const a = A.midway;
      const swap = `cp "$d/q2" "$d/screen.$n"`;
      writeFileSync(join(fake, "q2"), Q2);
      screen(a.pane, Q1);
      expect(await paneTick(a)).toBe(true);
      arm(`[ "$ev:$count" = "cap:1" ] && ${swap}`); // 第 1 次抓屏 = 入口的现场核对；之后发第一个键前会再抓
      const early = await answer(a, { action: "submit", selections: [[1]] });
      expect([early.status, early.body.code, early.body.keys]).toEqual([409, "ask_stale", 0]);
      expect(keys()).toEqual([]);

      screen(a.pane, Q1);
      expect(await paneTick(a)).toBe(true);
      arm(`[ "$ev:$count" = "key:1" ] && ${swap}`);
      const late = await answer(a, { action: "submit", selections: [[1]] });
      expect([late.status, late.body.code, late.body.keys]).toEqual([409, "ask_stale", 1]);
      expect(keys()).toEqual([`%${a.pane} Down`]);
      expect(state(a)).toBeUndefined(); // 旧卡收掉；下一轮观察给 Q2 开新卡
      expect(await paneTick(a)).toBe(true);
      expect(state(a)?.questions[0].question).toBe("Which size?");
    }, 30_000);

    it("钉住的 pane 在入口核完之后消失、名字落到另一个同屏 pane：不重按名字找，零键", async () => {
      const a = A.vanish;
      screen(a.pane, Q1);
      screen(a.pane + 1, Q1);
      expect(await paneTick(a)).toBe(true);
      arm(`[ "$ev:$count" = "cap:1" ] && { : > "$d/gone.${a.pane}"; printf ${a.pane + 1} > "$d/owner.${a.name}"; printf ${a.name} > "$d/wname.${a.pane + 1}"; }`);
      const r = await answer(a, { action: "submit", selections: [[0]] });
      expect([r.status, r.body.code, r.body.keys]).toEqual([409, "ask_stale", 0]);
      expect(keys()).toEqual([]);
    }, 30_000);

    it("单问多选照常：按现场勾选态补差、Right、Enter；提交后清卡", async () => {
      const a = A.multi;
      const labels = ["Bar", "Line", "Area"];
      writeFileSync(join(fake, "review"), REVIEW);
      screen(a.pane, tabbed(["Charts"], "Which charts?", labels, [1]));
      expect(await paneTick(a)).toBe(true);
      expect(state(a)?.questions[0]).toMatchObject({ multiSelect: true, options: [{ label: "Bar" }, { label: "Line" }, { label: "Area" }] });
      arm(`[ "$ev" = key ] && [ "$key$1" = Right ] && cp "$d/review" "$d/screen.$n"`);
      const r = await answer(a, { gen: state(a)?.gen, action: "submit", selections: [[0, 2]] });
      expect(r).toEqual({ status: 200, body: { ok: true, keys: 5 } });
      expect(keys()).toEqual([1, 2, 3, "Right", "Enter"].map((k) => `%${a.pane} ${k}`)); // 已勾的 Line 取消，Bar / Area 勾上
      expect(seen(a, "question_cleared").map((e) => e.reason)).toEqual(["submit"]);
    }, 30_000);

    it("多问表单照旧降级：只发一次远程终端引导，不开交互卡；弹框消失两轮后才清", async () => {
      const a = A.form;
      screen(a.pane, tabbed(["Modules", "Theme"], "Which modules?", ["Cards", "Charts"]));
      expect(await paneTick(a)).toBe(true);
      expect(await paneTick(a)).toBe(true);
      expect(state(a)).toBeUndefined();
      const guide = seen(a, "assistant_text");
      expect(guide.length).toBe(1);
      expect(String(guide[0].text)).toContain("请开远程终端");

      screen(a.pane, Q1);
      expect(await paneTick(a)).toBe(true);
      screen(a.pane, IDLE);
      expect(await paneTick(a)).toBe(false);
      expect(state(a)).toBeDefined(); // 一轮没见到不清（可能正在重绘）
      expect(await paneTick(a)).toBe(false);
      expect(state(a)).toBeUndefined();
      expect(seen(a, "question_cleared").map((e) => e.reason)).toEqual(["stale"]);
    });

    it("取消照常：Esc 发到钉住的 pane；弹框已不在的取消不发 Esc", async () => {
      const a = A.cancel;
      screen(a.pane, Q1);
      expect(await paneTick(a)).toBe(true);
      arm();
      expect(await answer(a, { gen: state(a)?.gen, action: "cancel" })).toEqual({ status: 200, body: { ok: true, cancelled: true } });
      expect(keys()).toEqual([`%${a.pane} Escape`]);
      expect(seen(a, "question_cleared").map((e) => e.reason)).toEqual(["cancel"]);

      screen(a.pane, Q2);
      expect(await paneTick(a)).toBe(true);
      screen(a.pane, IDLE);
      arm();
      expect((await answer(a, { action: "cancel" })).body.code).toBe("ask_stale");
      expect(keys()).toEqual([]);
    }, 30_000);
  });
}
