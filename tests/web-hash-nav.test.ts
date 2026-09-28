/** web/lib/hash-nav.ts：窄屏伪路由（#chat 会话页 / #asks「待你处理」）的压栈、出栈判定与 back 在途闸 */
import { describe, expect, test } from "bun:test";
import { askFromLink, createBackGuard, hashBase, leavePlan, ownsEntry, shouldPush, swipeDir, type NavTag } from "@/lib/hash-nav";

describe("压栈 / 出栈判定", () => {
  test("只在窄屏、且还不在这页上时压一条", () => {
    expect(shouldPush("", "#asks", true)).toBe(true);
    expect(shouldPush("#chat", "#asks", true)).toBe(true); // 会话页上点横幅打开抽屉
    expect(shouldPush("#asks", "#asks", true)).toBe(false); // 刷新恢复 / 重复点，不叠两条
    expect(shouldPush("", "#asks", false)).toBe(false); // 桌面是侧边抽屉
  });

  test("hash 里的 ?参数 不影响判页（协作详情 #chat?collab=x 仍是会话页）", () => {
    expect(hashBase("#chat?collab=t1")).toBe("#chat");
    expect(leavePlan("#chat?collab=t1", "#chat", { cstraCollab: true }, "chat", false)).toBe("strip");
  });

  test("自己打过标的条目 back；没标的基础条目（刷新 / 深链带 hash 进来）只摘 hash", () => {
    expect(leavePlan("#chat", "#chat", { cstra: "chat" }, "chat", false)).toBe("back");
    expect(leavePlan("#chat", "#chat", null, "chat", false)).toBe("strip");
    expect(leavePlan("#asks", "#asks", { cstra: "asks" }, "asks", false)).toBe("back");
    // 标不对也不 back：抽屉的条目不能被会话页当成自己的
    expect(leavePlan("#asks", "#asks", { cstra: "chat" }, "asks", false)).toBe("strip");
  });

  test("不在这页上：只改界面状态", () => {
    expect(leavePlan("", "#chat", null, "chat", false)).toBe("none");
    expect(leavePlan("#asks", "#chat", { cstra: "asks" }, "chat", true)).toBe("none");
  });

  test("back 在途时再触发：什么都不做（快速返回白屏的第一道闸）", () => {
    expect(leavePlan("#chat", "#chat", { cstra: "chat" }, "chat", true)).toBe("wait");
    expect(leavePlan("#chat", "#chat", null, "chat", true)).toBe("wait");
  });

  test("ownsEntry 只认对象上的 cstra 标", () => {
    expect(ownsEntry({ cstra: "asks" }, "asks")).toBe(true);
    expect(ownsEntry("asks", "asks")).toBe(false);
    expect(ownsEntry(undefined, "chat")).toBe(false);
  });
});

describe("横滑判定", () => {
  test("横向为主且够长才算，右滑 = 返回", () => {
    expect(swipeDir(80, 10)).toBe("back");
    expect(swipeDir(-80, 10)).toBe("forward");
    expect(swipeDir(69, 0)).toBeNull(); // 不够长
    expect(swipeDir(80, 60)).toBeNull(); // 斜着滑 = 在滚列表
    expect(swipeDir(160, 100)).toBe("back"); // 恰好 1.6 倍
  });
});

describe("推送深链", () => {
  test("/chat?ask=<id> 取出 id，其余不是", () => {
    expect(askFromLink("/chat?ask=ask_1")).toBe("ask_1");
    expect(askFromLink("https://h.example/chat?fp=abc&ask=a%2Fb#asks")).toBe("a/b");
    expect(askFromLink("/chat")).toBeNull();
    expect(askFromLink("/chat?ask=")).toBeNull();
    expect(askFromLink(undefined)).toBeNull();
    expect(askFromLink(42)).toBeNull();
  });
});

/**
 * 模拟浏览器历史栈：history.back() 是异步的（popstate 下一轮才到），这正是连点返回会多退一格的原因。
 * leave() 按 chat.tsx toList / asks-store leave 的写法走：wait 什么都不做，back 走闸，strip 摘 hash。
 */
function fakeBrowser(entries: { hash: string; state: unknown }[]) {
  const stack = [{ hash: "", state: null as unknown, outside: true }, ...entries.map((e) => ({ ...e, outside: false }))];
  let idx = stack.length - 1;
  const pops: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const queued: (() => void)[] = [];
  const guard = createBackGuard({
    back: () => queued.push(() => {
      idx = Math.max(0, idx - 1);
      for (const f of pops.splice(0)) f();
    }),
    onceOnPop: (f) => pops.push(f),
    later: (f) => timers.push(f),
  });
  const cur = () => stack[idx];
  return {
    guard,
    cur,
    leave(page: string, tag: NavTag) {
      const plan = leavePlan(cur().hash, page, cur().state, tag, guard.busy());
      if (plan === "back") guard.back();
      else if (plan === "strip") stack[idx] = { ...cur(), hash: "", state: null };
      return plan;
    },
    /** 让在途的 back 落地（下一轮事件循环） */
    flush: () => queued.splice(0).forEach((f) => f()),
    fireTimers: () => timers.splice(0).forEach((f) => f()),
  };
}

describe("出栈闸回归（chat.tsx toList 原行为）", () => {
  test("连点两下返回：只退一格，不退出应用", () => {
    const b = fakeBrowser([{ hash: "", state: null }, { hash: "#chat", state: { cstra: "chat" } }]);
    expect(b.leave("#chat", "chat")).toBe("back");
    expect(b.leave("#chat", "chat")).toBe("wait"); // popstate 还没到，hash 仍是 #chat
    b.flush();
    expect(b.cur()).toMatchObject({ hash: "", outside: false });
    expect(b.leave("#chat", "chat")).toBe("none"); // 已在列表，第三下也不动栈
  });

  test("popstate 到达即解锁：之后再进再退照常", () => {
    const b = fakeBrowser([{ hash: "", state: null }, { hash: "#asks", state: { cstra: "asks" } }]);
    b.leave("#asks", "asks");
    expect(b.guard.busy()).toBe(true);
    b.flush();
    expect(b.guard.busy()).toBe(false);
  });

  test("popstate 迟迟不来：800ms 兜底解锁，不永久锁死", () => {
    const b = fakeBrowser([{ hash: "", state: null }, { hash: "#chat", state: { cstra: "chat" } }]);
    b.leave("#chat", "chat");
    expect(b.leave("#chat", "chat")).toBe("wait");
    b.fireTimers();
    expect(b.guard.busy()).toBe(false);
  });

  test("刷新 / 深链带 #chat 进来（基础条目没标）：摘 hash，不 back 出应用", () => {
    const b = fakeBrowser([{ hash: "#chat", state: null }]);
    expect(b.leave("#chat", "chat")).toBe("strip");
    b.flush();
    expect(b.cur()).toMatchObject({ hash: "", outside: false });
  });

  test("「回到对话」之后：会话页返回落回抽屉，抽屉再返回落回列表", () => {
    const b = fakeBrowser([{ hash: "", state: null }, { hash: "#asks", state: { cstra: "asks" } }, { hash: "#chat", state: { cstra: "chat" } }]);
    expect(b.leave("#chat", "chat")).toBe("back");
    expect(b.leave("#chat", "chat")).toBe("wait");
    b.flush();
    expect(b.cur().hash).toBe("#asks"); // asks-store 的 popstate 据此重新打开抽屉
    expect(b.leave("#asks", "asks")).toBe("back");
    b.flush();
    expect(b.cur()).toMatchObject({ hash: "", outside: false });
  });
});
