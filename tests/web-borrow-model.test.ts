/**
 * 借入面板的纯函数（web/features/borrow/borrow-model.ts）：hello 年龄（抵掉时钟差）与分档、peer 三态（proto 1 = 只轮询、不算故障）、
 * 排序、项目开关至少留一个、上限夹紧、可加的联系人、新条目能不能提交；以及面板源码里没有命令文本、没有 write 角色。
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { BorrowView, PeerView, RemoteRow } from "@/features/borrow/borrow-api";
import {
  addableContacts, ageBand, ageParts, canSubmitNew, canToggleOff, clampMaxOpen, helloAgeSec, HELLO_FRESH_SEC, peerState, placementKind, reportedFree,
  sortPeers, sortRemote, stalePeers, toggleProject,
} from "@/features/borrow/borrow-model";
import { BORROW_DICT } from "@/lib/i18n-dict-borrow";

const cap = (over: Partial<NonNullable<PeerView["capacity"]>> = {}) => ({ peer: "p", proto: 2, helloAt: 1, open: 0, slots: { codex: 1, claude: 0 }, why: null, ...over });
const peer = (name: string, capacity: PeerView["capacity"]): PeerView => ({ peer: name, maxOpen: 3, projects: ["a"], capacity, reported: null, paused: null, grant: null });

describe("hello 年龄", () => {
  test("按服务端 now 算，再加上拿到数据之后本机过了多久；tick 0 = 刚拿到", () => {
    expect(helloAgeSec(null, 100_000, 5, 0)).toBeNull();
    expect(helloAgeSec(40_000, 100_000, 5_000, 0)).toBe(60);
    expect(helloAgeSec(40_000, 100_000, 5_000, 35_000)).toBe(90);
    expect(helloAgeSec(200_000, 100_000, 5_000, 5_000)).toBe(0); // 对方时钟快：不出负数
  });
  test("分档：180 秒（与 HELLO_FRESH_MS 同值）起算过期", () => {
    expect([ageBand(null), ageBand(0), ageBand(89), ageBand(90), ageBand(HELLO_FRESH_SEC - 1), ageBand(HELLO_FRESH_SEC)])
      .toEqual(["none", "fresh", "fresh", "aging", "aging", "stale"]);
  });
  test("显示单位", () => {
    expect([ageParts(59), ageParts(60), ageParts(3599), ageParts(7200)]).toEqual([
      { n: 59, unit: "s" }, { n: 1, unit: "m" }, { n: 59, unit: "m" }, { n: 2, unit: "h" },
    ]);
  });
});

describe("peer 三态与排序", () => {
  test("proto 1 → poll（不是 down），proto 2 能放 → push，proto 2 有 why → down，没有 lend 表 → unknown", () => {
    expect(peerState(peer("a", cap({ proto: 1, helloAt: null, why: "没有 hello（按 proto 1，只轮询）" })))).toBe("poll");
    expect(peerState(peer("a", cap()))).toBe("push");
    expect(peerState(peer("a", cap({ why: "hello 超过 180 秒没更新" })))).toBe("down");
    expect(peerState(peer("a", null))).toBe("unknown");
  });
  test("排序：push → poll → down → unknown，同态按名字", () => {
    const list = [peer("z", null), peer("d", cap({ why: "x" })), peer("p", cap({ proto: 1 })), peer("b", cap()), peer("a", cap())];
    expect(sortPeers(list).map((p) => p.peer)).toEqual(["a", "b", "p", "d", "z"]);
  });
  test("远端行：按 peer，再按 claimed → pooled → unknown", () => {
    const row = (orderId: string, peerName: string, status: string) => ({ orderId, peer: peerName, status }) as RemoteRow;
    expect(sortRemote([row("1", "b", "pooled"), row("2", "a", "unknown"), row("3", "a", "claimed"), row("4", "b", "claimed")]).map((r) => r.orderId))
      .toEqual(["3", "2", "4", "1"]);
  });
  test("上报空闲 = total − busy；没有 hello → null", () => {
    expect(reportedFree({ reported: { codex: { total: 3, busy: 1 }, claude: { total: 0, busy: 2 } } }, "codex")).toBe(2);
    expect(reportedFree({ reported: { codex: { total: 3, busy: 1 }, claude: { total: 0, busy: 2 } } }, "claude")).toBe(0);
    expect(reportedFree({ reported: null }, "codex")).toBeNull();
  });
});

describe("按钮", () => {
  test("项目开关：最后一个不能关；结果按可选顺序", () => {
    expect(canToggleOff(["a"], "a")).toBe(false);
    expect(canToggleOff(["a"], "b")).toBe(true);
    expect(canToggleOff(["a", "b"], "a")).toBe(true);
    expect(toggleProject(["c"], "a", ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(toggleProject(["a", "c"], "a", ["a", "b", "c"])).toEqual(["c"]);
  });
  test("上限夹在 1..limit", () => {
    expect([clampMaxOpen(0, 20), clampMaxOpen(21, 20), clampMaxOpen(4, 20)]).toEqual([1, 20, 4]);
  });
  test("新条目：至少一个项目、上限合法才能提交", () => {
    expect(canSubmitNew([], 3, 20)).toBe(false);
    expect(canSubmitNew(["a"], 0, 20)).toBe(false);
    expect(canSubmitNew(["a"], 3, 20)).toBe(true);
  });
  test("可加的联系人 = 联系人里还没声明过的", () => {
    const v = { borrow: { contacts: ["a", "b", "c"], declared: [{ peer: "b" }] } } as unknown as BorrowView;
    expect(addableContacts(v)).toEqual(["a", "c"]);
  });
});

describe("失效的借入与放置形态", () => {
  const e = (peer: string, projects = ["a"]) => ({ peer, projects, roles: ["review"], maxOpen: 3 });
  test("全部项目失效 → projects_gone 可重选；部分失效还生效 → 不进失效行；联系人失效 → 只能删", () => {
    const v = { borrow: {
      declared: [e("all", ["gone", "diary"]), e("part", ["a", "gone"]), e("off"), e("nobody")],
      effective: [e("part", ["a"])],
      dropped: [{ peer: "all", project: "gone", code: "project_gone" }, { peer: "all", project: "diary", code: "personal" }, { peer: "part", project: "gone", code: "project_gone" },
        { peer: "off", code: "contact_disabled" }, { peer: "nobody", code: "contact_gone" }],
      contacts: ["all", "part"],
    } } as unknown as BorrowView;
    expect(stalePeers(v)).toEqual([
      { peer: "all", reason: "projects_gone", maxOpen: 3, canRepick: true },
      { peer: "off", reason: "contact_disabled", maxOpen: 3, canRepick: false },
      { peer: "nobody", reason: "contact_gone", maxOpen: 3, canRepick: false },
    ]);
  });
  test("放置形态：本机 / peer / 等着 / 不放置；算不出或老 bridge 不显示", () => {
    expect(placementKind({ role: "review", where: "local", reason: "x" })).toBe("local");
    expect(placementKind({ role: "review", where: "peer:mate", reason: "挂池" })).toBe("peer");
    expect(placementKind({ role: "write", where: "peer:mate", reason: "等：远端写代码等 W8" })).toBe("wait");
    expect(placementKind({ role: null, where: "-", reason: "merge 阶段不放置" })).toBe("none");
    expect([placementKind({ error: "unavailable" }), placementKind(undefined)]).toEqual([null, null]);
  });
});

describe("面板源码", () => {
  const dir = new URL("../web/features/borrow/", import.meta.url);
  // 注释不上屏：先剥掉块注释与行注释，只看会渲染出来的代码和字典
  const code = (f: string) => readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const src = readdirSync(dir).map(code).join("\n") + JSON.stringify(BORROW_DICT);
  // 「没有 write 角色开关」是 R7b 时远端写代码还没做（W8）的约束；W9 后 i28-Q1 规格要求分配表每行有「审查 / 开发」勾选，这条撤掉
  test("没有要人去跑的命令文本", () => {
    expect(src).not.toMatch(/manager|bun |borrow set|borrow off|claudestra |--max-open|--projects/);
  });
  test("不用 emoji", () => expect(src).not.toMatch(/\p{Extended_Pictographic}/u));
});
