/**
 * hardening-AUQID1：AUQ 弹框的「代」——身份比对与逐键重核（lib/auq-dialog-identity.ts）。
 * 全是合成画面 + 内存里的假 tmux（按 argv 应答、记每一个真正落地的键），不起进程、不碰 tmux。
 * 真实入口（API / Discord / JSONL / pane 观察器）在 tests/auq-audit-identity-entries.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { TmuxCommandError } from "../src/lib/tmux-failure.js";

// 本卡新模块：先红时旧代码里没有它，用到它的用例各自失败
const lib = () => import("../src/lib/auq-dialog-identity.ts");
type Lib = Awaited<ReturnType<typeof lib>>;
type Obs = Awaited<ReturnType<Lib["observeAuqByName"]>>;

const NAME = "master:=agent-x";
type Opt = [label: string, description?: string];

/** 单问单选（无 tab 栏）：cursor = 光标所在选项 */
const single = (header: string, question: string, opts: Opt[], cursor = 0) => [
  "⏺ working", "", ` ☐ ${header}`, "", question, "",
  ...opts.flatMap(([label, desc], i) => [`${i === cursor ? "❯" : " "} ${i + 1}. ${label}`, ...(desc ? [`     ${desc}`] : [])]),
  `  ${opts.length + 1}. Type something.`, "", "Enter to select · ↑/↓ to navigate · Esc to cancel", "",
].join("\n");

/** tabbed：tabs 是 tab 栏的段名（一段 = 单问多选，多段 = 多问表单），checked = 已勾选的下标 */
const tabbed = (tabs: string[], question: string, opts: Opt[], o: { cursor?: number; checked?: number[]; multi?: boolean; done?: string[] } = {}) => [
  `←  ${tabs.map((s) => `${o.done?.includes(s) ? "☒" : "☐"} ${s}`).join("  ")}  ✔ Submit  →`, "", question, "",
  ...opts.flatMap(([label, desc], i) => [
    `${i === (o.cursor ?? 0) ? "❯" : " "} ${i + 1}. ${o.multi === false ? "" : o.checked?.includes(i) ? "[✔] " : "[ ] "}${label}`, ...(desc ? [`  ${desc}`] : []),
  ]),
  `  ${opts.length + 1}. ${o.multi === false ? "" : "[ ] "}Type something`, "     Next", "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel", "",
].join("\n");

const review = (tabs: string[]) => [
  `←  ${tabs.map((s) => `☒ ${s}`).join("  ")}  ✔ Submit  →`, "", "Review your answers", "", "Ready to submit your answers?", "", "❯ 1. Submit answers", "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel", "",
].join("\n");

const IDLE = "⏺ 好的，已完成。\n\n❯ \n";
const Q1 = single("Color", "Which color?", [["Red", "Warm"], ["Blue", "Cold"]]);
const Q2 = single("Size", "Which size?", [["Small", "S"], ["Large", "L"]]);

/** 内存里的假 tmux：名字绑在哪个 pane、每个 pane 的画面 / 窗口，键只记真正落地的 */
function fakeTmux(screen: string) {
  const t = {
    owner: "%1" as string | null,
    panes: new Map<string, { screen: string; windowId: string; windowName: string }>([["%1", { screen, windowId: "@1", windowName: "agent-x" }]]),
    session: "sess-1",
    keys: [] as string[],
    argv: [] as string[][],
    captures: 0,
    /** 每次抓屏 / 每个键落地之后调：测试在这里换画面（模拟终端里换了弹框） */
    after: (_ev: "capture" | "key", _n: number) => {},
    failCapture: false,
  };
  const gone = (target: string): never => { throw new TmuxCommandError(["x"], 1, `can't find pane: ${target}`); };
  const paneOf = (target: string) => (target === NAME ? t.owner : target);
  const io = {
    query: async (args: string[]) => {
      t.argv.push(args);
      const target = args[args.indexOf("-t") + 1];
      const id = paneOf(target);
      const pane = id ? t.panes.get(id) : undefined;
      if (!id || !pane) return gone(target);
      if (args[0] === "list-panes") {
        const fmt = args[args.indexOf("-F") + 1];
        return fmt.includes("pane_active") ? `1\t${id}` : `${id}\t0\t${pane.windowId}\t${pane.windowName}`;
      }
      if (args[0] === "capture-pane") {
        if (t.failCapture) return gone(target);
        const out = pane.screen;
        t.after("capture", ++t.captures);
        return out;
      }
      if (args[0] === "if-shell") {
        const cond = args[4];
        if (!cond.includes(`#{==:#{window_id},${pane.windowId}}`) || !cond.includes(`#{==:#{window_name},${pane.windowName}}`)) return "claudestra-send-refused";
        t.keys.push(`${id} ${args[5].split(" ").pop()}`);
        t.after("key", t.keys.length);
        return "";
      }
      throw new Error(`fake tmux: unexpected ${args.join(" ")}`);
    },
    session: async () => t.session,
    locked: async (_target: string, gate: () => Promise<void>, send: () => Promise<void>) => { await gate(); await send(); },
    sleep: async () => {},
  };
  return { t, io };
}

const q = (question: string, labels: Opt[], multiSelect = false, header = "") => ({ question, header, multiSelect, options: labels.map(([label, description]) => ({ label, description })) });

async function registered(screen: string, questions?: ReturnType<typeof q>[]) {
  const m = await lib();
  const f = fakeTmux(screen);
  const obs = await m.observeAuqByName(f.io, NAME);
  if (obs.kind !== "dialog") throw new Error(`fixture is not a dialog: ${obs.kind}`);
  const qs = questions ?? [m.auqQuestionFromScreen(obs.parse)];
  return { m, ...f, obs, id: m.auqDialogIdentity(qs, obs) };
}

describe("[验收线 2] 同一个弹框：光标 / 勾选是渲染变化，不换代", () => {
  test("单选挪光标、多选勾选项、tab 栏标记答过：仍是同一代", async () => {
    const a = await registered(Q1);
    a.t.panes.get("%1")!.screen = single("Color", "Which color?", [["Red", "Warm"], ["Blue", "Cold"]], 1);
    expect(a.m.sameAuqDialog(a.id, await a.m.observeAuqPinned(a.io, a.id.target), "fresh")).toBe(true);

    const opts: Opt[] = [["Bar", "bars"], ["Line", "lines"], ["Area", "areas"]];
    const b = await registered(tabbed(["Charts"], "Which charts?", opts));
    b.t.panes.get("%1")!.screen = tabbed(["Charts"], "Which charts?", opts, { cursor: 2, checked: [0, 2], done: ["Charts"] });
    expect(b.m.sameAuqDialog(b.id, await b.m.observeAuqPinned(b.io, b.id.target), "fresh")).toBe(true);
  });

  test("问题、选项文字、选项顺序、描述、多选规则有一处不同就是另一代（选项数相同也是）", async () => {
    const a = await registered(Q1);
    const other = [
      Q2,
      single("Color", "Which colour?", [["Red", "Warm"], ["Blue", "Cold"]]),
      single("Color", "Which color?", [["Blue", "Cold"], ["Red", "Warm"]]),
      single("Color", "Which color?", [["Red", "Warm"], ["Blue", "Delete /tmp/reports /tmp/archive"]]),
      tabbed(["Color"], "Which color?", [["Red", "Warm"], ["Blue", "Cold"]]),
    ];
    for (const screen of other) {
      a.t.panes.get("%1")!.screen = screen;
      expect([screen, a.m.sameAuqDialog(a.id, await a.m.observeAuqPinned(a.io, a.id.target), "midway")]).toEqual([screen, false]);
    }
    // 描述里差一个空格是另一个对象
    const spaced = await registered(single("Clean", "Delete?", [["Delete", "Delete /tmp/reports /tmp/archive"], ["Cancel"]]));
    spaced.t.panes.get("%1")!.screen = single("Clean", "Delete?", [["Delete", "Delete /tmp/reports/tmp/archive"], ["Cancel"]]);
    expect(spaced.m.sameAuqDialog(spaced.id, await spaced.m.observeAuqPinned(spaced.io, spaced.id.target), "midway")).toBe(false);
  });
});

describe("[验收线 2] 相同文字但会话 / pane / 窗口换代：旧卡拒", () => {
  test("会话 id 变了、名字落到另一个 pane、窗口换了 id 或名字：都不是同一代", async () => {
    const a = await registered(Q1);
    a.t.session = "sess-2";
    expect(a.m.sameAuqDialog(a.id, await a.m.observeAuqByName(a.io, NAME), "fresh")).toBe(false);
    a.t.session = "sess-1";
    expect(a.m.sameAuqDialog(a.id, await a.m.observeAuqByName(a.io, NAME), "fresh")).toBe(true);

    a.t.panes.set("%2", { screen: Q1, windowId: "@2", windowName: "agent-x" });
    a.t.owner = "%2"; // 窗口重建：同名、同一屏文字，但已是另一个 pane
    const moved = await a.m.observeAuqByName(a.io, NAME);
    expect(moved.kind).toBe("dialog");
    expect(a.m.sameAuqDialog(a.id, moved, "fresh")).toBe(false);

    a.t.owner = "%1";
    a.t.panes.get("%1")!.windowName = "agent-y";
    expect(a.m.sameAuqDialog(a.id, await a.m.observeAuqPinned(a.io, a.id.target), "fresh")).toBe(false);
  });

  test("pane 读不到（没了 / 抓屏失败 / 名字解析不到）= unreadable，不算同一代", async () => {
    const a = await registered(Q1);
    a.t.failCapture = true;
    const unread = await a.m.observeAuqPinned(a.io, a.id.target);
    expect(unread.kind).toBe("unreadable");
    expect(a.m.sameAuqDialog(a.id, unread, "midway")).toBe(false);
    a.t.failCapture = false;
    a.t.panes.delete("%1");
    expect((await a.m.observeAuqPinned(a.io, a.id.target)).kind).toBe("unreadable");
    a.t.owner = null;
    expect((await a.m.observeAuqByName(a.io, NAME)).kind).toBe("unreadable");
  });
});

describe("[验收线 2] JSONL 里的问题只给屏上对得上的那个弹框开卡", () => {
  test("一问：问题 / 选项 / 多选规则 / 看得见的描述都对上才算；Q1 的 tool_use 不能给屏上的 Q2 开卡", async () => {
    const { m, obs } = await registered(Q1);
    const q1 = q("Which color?", [["Red", "Warm"], ["Blue", "Cold"]]);
    expect(m.auqQuestionsOnScreen([q1], obs)).toBe(true);
    expect(m.auqQuestionsOnScreen([q("Which  color?\n", [["Red", "Warm"], ["Blue", "Cold"]])], obs)).toBe(true); // 折行 / 多空白归一
    expect(m.auqQuestionsOnScreen([q("Which size?", [["Small", "S"], ["Large", "L"]])], obs)).toBe(false);
    expect(m.auqQuestionsOnScreen([q("Which color?", [["Blue", "Cold"], ["Red", "Warm"]])], obs)).toBe(false);
    expect(m.auqQuestionsOnScreen([q("Which color?", [["Red", "Warm"], ["Blue", "Icy"]])], obs)).toBe(false);
    expect(m.auqQuestionsOnScreen([q("Which color?", [["Red", "Warm"], ["Blue", "Cold"]], true)], obs)).toBe(false);
    const absent: Obs = { kind: "none", target: obs.target };
    expect(m.auqQuestionsOnScreen([q1], absent)).toBe(false);
  });

  test("多问：tab 栏段名逐个对上、当前段是其中一问", async () => {
    const mods: Opt[] = [["Cards"], ["Charts"], ["Table"]];
    const form = [q("Which modules?", mods, true, "Modules"), q("Which theme?", [["Light"], ["Dark"]], false, "Theme")];
    const { m, obs } = await registered(tabbed(["Modules", "Theme"], "Which modules?", mods), form);
    expect(m.auqQuestionsOnScreen(form, obs)).toBe(true);
    expect(m.auqQuestionsOnScreen([form[0], { ...form[1], header: "Palette" }], obs)).toBe(false);
    expect(m.auqQuestionsOnScreen([form[1]], obs)).toBe(false);
  });
});

describe("[验收线 3] 逐键重核：每一键之前都重读钉住的 pane", () => {
  const sent = (r: { sent: number; stopped: string | null }) => [r.sent, r.stopped === null];

  test("弹框没变：键全部发到钉住的 pane id，带窗口绑定条件", async () => {
    const a = await registered(Q1);
    const r = await a.m.sendAuqKeysChecked(a.io, a.id, ["Down", "Enter"], () => true, 0);
    expect(sent(r)).toEqual([2, true]);
    expect(a.t.keys).toEqual(["%1 Down", "%1 Enter"]);
    const sends = a.t.argv.filter((x) => x[0] === "if-shell");
    expect(sends.map((x) => [x[3], x[5]])).toEqual([["%1", "send-keys -t '%1' Down"], ["%1", "send-keys -t '%1' Enter"]]);
    expect(sends[0][4]).toContain("#{==:#{window_id},@1}");
    expect(sends[0][4]).toContain("#{==:#{pane_dead},0}");
  });

  test("发第一个键之前弹框已换成同选项数的 Q2：零键", async () => {
    const a = await registered(Q1);
    a.t.panes.get("%1")!.screen = Q2;
    const r = await a.m.sendAuqKeysChecked(a.io, a.id, ["Down", "Enter"], () => true, 0);
    expect(sent(r)).toEqual([0, false]);
    expect(a.t.keys).toEqual([]);
  });

  test("Down 落地之后弹框换成 Q2：Enter 不发（旧选择不落进新框）", async () => {
    const a = await registered(Q1);
    a.t.after = (ev, n) => { if (ev === "key" && n === 1) a.t.panes.get("%1")!.screen = Q2; };
    const r = await a.m.sendAuqKeysChecked(a.io, a.id, ["Down", "Enter"], () => true, 0);
    expect(sent(r)).toEqual([1, false]);
    expect(a.t.keys).toEqual(["%1 Down"]);
  });

  test("钉住的 pane 没了、名字已落到另一个同屏 pane：不改按名字找，零键", async () => {
    const a = await registered(Q1);
    a.t.panes.set("%2", { screen: Q1, windowId: "@2", windowName: "agent-x" });
    a.t.owner = "%2";
    a.t.panes.delete("%1");
    const r = await a.m.sendAuqKeysChecked(a.io, a.id, ["Enter"], () => true, 0);
    expect(sent(r)).toEqual([0, false]);
    expect(a.t.keys).toEqual([]);
    expect(a.t.argv.some((x) => x.includes(NAME) && x[0] !== "list-panes")).toBe(false);
  });

  test("抓屏失败、会话换了、登记的已不是这一代、窗口被改名：都是零键", async () => {
    const unread = await registered(Q1);
    unread.t.failCapture = true;
    expect(sent(await unread.m.sendAuqKeysChecked(unread.io, unread.id, ["Enter"], () => true, 0))).toEqual([0, false]);
    const session = await registered(Q1);
    session.t.session = "sess-2";
    expect(sent(await session.m.sendAuqKeysChecked(session.io, session.id, ["Enter"], () => true, 0))).toEqual([0, false]);
    const superseded = await registered(Q1);
    expect(sent(await superseded.m.sendAuqKeysChecked(superseded.io, superseded.id, ["Enter"], () => false, 0))).toEqual([0, false]);
    const renamed = await registered(Q1);
    renamed.t.panes.get("%1")!.windowName = "agent-y";
    expect(sent(await renamed.m.sendAuqKeysChecked(renamed.io, renamed.id, ["Enter"], () => true, 0))).toEqual([0, false]);
    for (const f of [unread, session, superseded, renamed]) expect(f.t.keys).toEqual([]);
  });

  test("最后一次观察之后才改名（观察与发键之间）：server 端条件拒掉这一键", async () => {
    const a = await registered(Q1);
    a.t.after = (ev) => { if (ev === "capture") a.t.panes.get("%1")!.windowName = "agent-y"; };
    const r = await a.m.sendAuqKeysChecked(a.io, a.id, ["Enter"], () => true, 0);
    expect(sent(r)).toEqual([0, false]);
    expect(a.t.keys).toEqual([]);
  });

  test("单问多选：勾选、Right 到 Submit 段、Enter——中途停在 Review 段仍是同一代；发第一个键前就在 Review 段则不发", async () => {
    const opts: Opt[] = [["Bar"], ["Line"], ["Area"]];
    const a = await registered(tabbed(["Charts"], "Which charts?", opts));
    a.t.after = (ev, n) => {
      if (ev !== "key") return;
      a.t.panes.get("%1")!.screen = n === 1 ? tabbed(["Charts"], "Which charts?", opts, { checked: [1] }) : review(["Charts"]);
    };
    expect(sent(await a.m.sendAuqKeysChecked(a.io, a.id, ["2", "Right", "Enter"], () => true, 0))).toEqual([3, true]);
    expect(a.t.keys).toEqual(["%1 2", "%1 Right", "%1 Enter"]);

    const b = await registered(tabbed(["Charts"], "Which charts?", opts));
    b.t.panes.get("%1")!.screen = review(["Charts"]);
    expect(sent(await b.m.sendAuqKeysChecked(b.io, b.id, ["2", "Right", "Enter"], () => true, 0))).toEqual([0, false]);
    const c = await registered(tabbed(["Charts"], "Which charts?", opts));
    c.t.after = (ev, n) => { if (ev === "key" && n === 2) c.t.panes.get("%1")!.screen = review(["Other"]); };
    expect(sent(await c.m.sendAuqKeysChecked(c.io, c.id, ["2", "Right", "Enter"], () => true, 0))).toEqual([2, false]); // 另一个表单的 Review 段
  });

  test("多问表单：逐段作答时当前段在变，仍是同一代；不在第一段就不开始", async () => {
    const mods: Opt[] = [["Cards"], ["Charts"], ["Table"]];
    const themes: Opt[] = [["Light"], ["Dark"]];
    const form = [q("Which modules?", mods, true, "Modules"), q("Which theme?", themes, false, "Theme")];
    const a = await registered(tabbed(["Modules", "Theme"], "Which modules?", mods), form);
    a.t.after = (ev, n) => {
      if (ev !== "key") return;
      const p = a.t.panes.get("%1")!;
      if (n === 2) p.screen = tabbed(["Modules", "Theme"], "Which theme?", themes, { multi: false, done: ["Modules"] });
      if (n === 4) p.screen = review(["Modules", "Theme"]);
    };
    expect(sent(await a.m.sendAuqKeysChecked(a.io, a.id, ["2", "Right", "2", "Enter", "Enter"], () => true, 0))).toEqual([5, true]);

    const b = await registered(tabbed(["Modules", "Theme"], "Which modules?", mods), form);
    b.t.panes.get("%1")!.screen = tabbed(["Modules", "Theme"], "Which theme?", themes, { multi: false });
    expect(sent(await b.m.sendAuqKeysChecked(b.io, b.id, ["2", "Right", "2", "Enter", "Enter"], () => true, 0))).toEqual([0, false]);
    expect(b.t.keys).toEqual([]);
  });
});

test("[验收线 3] 屏上没有弹框 / 只有 Review 段：观察结果分得清，Review 段不当成可答的问题", async () => {
  const m = await lib();
  const idle = fakeTmux(IDLE);
  expect((await m.observeAuqByName(idle.io, NAME)).kind).toBe("none");
  const rev = fakeTmux(review(["A", "B"]));
  const obs = await m.observeAuqByName(rev.io, NAME);
  expect(obs).toMatchObject({ kind: "review", tabs: ["A", "B"], target: { pane: "%1", windowId: "@1", windowName: "agent-x", session: "sess-1" } });
});
