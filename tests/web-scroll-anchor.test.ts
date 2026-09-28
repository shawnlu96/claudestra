/**
 * 全量重拉后的滚动锚定（owner 2026-09-28「手机端用着用着会跳到上面的消息」，任务 T5）。
 * 判据与合并都是纯函数：web/features/chat/scroll-anchor.ts、reload-scroll.ts。
 */
import { describe, test, expect } from "bun:test";
import {
  anchorScrollDelta,
  captureAnchor,
  followAfterScroll,
  keepOlderPrefix,
  resolveAnchor,
  seqOfId,
  planWindow,
  scrollDecision,
  windowForTop,
} from "@/features/chat/scroll-anchor";
import { ReloadScroll, reloadKindFor } from "@/features/chat/reload-scroll";
import type { ChatMessage } from "@/features/chat/type";

const msg = (id: string): ChatMessage => ({ id, role: "assistant", content: id, ts: "2026-09-28T00:00:00Z" }) as ChatMessage;
const ids = (list: ChatMessage[]) => list.map((m) => m.id);

describe("seqOfId", () => {
  test("只认本 session 的 h<seq>", () => {
    expect(seqOfId("h42")).toBe(42);
    expect(seqOfId("h42~ab12")).toBeNull(); // 跨 session 翻页：seq 不可比
    expect(seqOfId("live_3")).toBeNull();
    expect(seqOfId("sessdiv_x")).toBeNull();
  });
});

describe("captureAnchor", () => {
  const view = { scrollTop: 1000, scrollHeight: 5000, clientHeight: 600 };
  test("取视口顶部第一条（部分）可见的气泡，偏移可为负", () => {
    const a = captureAnchor(
      [
        { id: "h10", top: -900, bottom: -120 },
        { id: "h12", top: -120, bottom: 300 },
        { id: "h15", top: 300, bottom: 800 },
      ],
      view,
    );
    expect(a).toEqual({ atBottom: false, following: false, id: "h12", seq: 12, offset: -120 });
  });

  test("吸底跟随中（手指按住时流式长高、几何上已离底）也记 atBottom", () => {
    expect(captureAnchor([], { ...view, following: true }).atBottom).toBe(true);
  });

  test("贴底（离底 < 90px）记 atBottom", () => {
    expect(captureAnchor([], { scrollTop: 4350, scrollHeight: 5000, clientHeight: 600 }).atBottom).toBe(true);
    expect(captureAnchor([], view)).toEqual({ atBottom: false, following: false, id: null, seq: null, offset: 0 });
  });

  test("顶部是直播气泡（重拉后 id 会变）→ 改用它前面最近的历史气泡，偏移按那条自己的", () => {
    const rows = [
      { id: "h20", top: -3500, bottom: -3300 },
      { id: "ru_1", top: -3300, bottom: -3200 },
      { id: "cm1", top: -3200, bottom: 400 },
      { id: "h30", top: 400, bottom: 900 },
    ];
    expect(captureAnchor(rows, view)).toEqual({ atBottom: false, following: false, id: "h20", seq: 20, offset: -3500 });
  });

  test("前面没有历史气泡 → 用后面的；都没有 → 仍记直播气泡（同 id 还在就能找回）", () => {
    const after = captureAnchor([{ id: "cm1", top: -10, bottom: 300 }, { id: "h30", top: 300, bottom: 900 }], view);
    expect(after).toMatchObject({ id: "h30", offset: 300 });
    expect(captureAnchor([{ id: "cm1", top: 0, bottom: 50 }], view)).toMatchObject({ id: "cm1", seq: null });
  });
});

describe("resolveAnchor", () => {
  test("同 id 优先", () => {
    expect(resolveAnchor({ id: "h12", seq: 12 }, ["h10", "h12", "h15"])).toEqual({ id: "h12", how: "same" });
  });

  test("id 没了按 seq 取包含它的合并气泡（seq ≤ 锚点的最后一个）", () => {
    expect(resolveAnchor({ id: "h13", seq: 13 }, ["h10", "h12", "h15"])).toEqual({ id: "h12", how: "seq" });
  });

  test("直播气泡换成正主后找不到、也没有 seq → none（调用方退回贴底）", () => {
    expect(resolveAnchor({ id: "live_1", seq: null }, ["h10", "h12"])).toEqual({ id: null, how: "none" });
    expect(resolveAnchor({ id: "h5", seq: 5 }, ["h10", "h12"])).toEqual({ id: null, how: "none" });
  });

  test("按 seq 回退时跳过跨 session 气泡与直播气泡", () => {
    expect(resolveAnchor({ id: "h9", seq: 9 }, ["h3~ab", "h8", "live_1"])).toEqual({ id: "h8", how: "seq" });
  });
});

describe("anchorScrollDelta", () => {
  test("锚点被往下顶了 200px → scrollTop 加 200 放回原偏移", () => {
    expect(anchorScrollDelta(80, -120)).toBe(200);
    expect(anchorScrollDelta(-120, -120)).toBe(0);
  });
});

describe("followAfterScroll（被夹回 / 回弹落位不算用户上滑）", () => {
  const at = (top: number, max: number) => ({ top, max });

  test("用户上滑离开底部 → 退出吸底", () => {
    expect(followAfterScroll(at(4400, 4400), 4380, 5000, 600)).toBe(false);
  });

  test("内容变矮，scrollTop 被夹到新的最底 → 仍吸底（复现 trace：max 27470→27446）", () => {
    expect(followAfterScroll(at(27470, 27470), 27446, 28088, 642)).toBe(true);
  });

  test("视口变高（输入框收起）被夹回 → 仍吸底", () => {
    expect(followAfterScroll(at(4400, 4400), 4370, 5000, 630)).toBe(true);
  });

  test("iOS 底部回弹落位（上一拍 scrollTop 越过 max）→ 仍吸底", () => {
    expect(followAfterScroll(at(4430, 4400), 4400, 5000, 600)).toBe(true);
  });

  test("桌面高 DPR 触控板慢速上滑、单帧 ≤1px（max 没变）→ 退出吸底，不被当成夹回", () => {
    expect(followAfterScroll(at(4400, 4400), 4399.5, 5000, 600)).toBe(false);
    expect(followAfterScroll(at(4400, 4400), 4399, 5000, 600)).toBe(false);
  });

  test("往下滑到接近底部 → 恢复吸底；在中间往下滑 → 不吸", () => {
    expect(followAfterScroll(at(4300, 4400), 4350, 5000, 600)).toBe(true);
    expect(followAfterScroll(at(1000, 4400), 1200, 5000, 600)).toBe(false);
  });
});

describe("keepOlderPrefix（往上翻时全量重拉保留已翻出的更早前缀）", () => {
  const current = ["h1~ab", "sessdiv_ab", "h5", "h8", "h10", "h12", "live_1"].map(msg);

  test("拼接顺序正确、同一 seq 只出现一次", () => {
    const next = ["h10", "h12", "h14"].map(msg);
    const out = keepOlderPrefix(current, next);
    expect(ids(out)).toEqual(["h1~ab", "sessdiv_ab", "h5", "h8", "h10", "h12", "h14"]);
    expect(new Set(ids(out)).size).toBe(out.length);
  });

  test("新窗口与当前视图不重叠（切走期间来了一整页以上）→ 不拼，免得中间漏一段", () => {
    const next = ["h40", "h42"].map(msg);
    expect(ids(keepOlderPrefix(current, next))).toEqual(["h40", "h42"]);
  });

  test("没有更早的部分 / 新窗口没有 h 气泡 → 原样", () => {
    const next = ["h5", "h8", "h10"].map(msg);
    expect(ids(keepOlderPrefix(["h5", "h8"].map(msg), next))).toEqual(["h5", "h8", "h10"]);
    expect(ids(keepOlderPrefix(current, [msg("live_9")]))).toEqual(["live_9"]);
  });

  test("拼回的前缀让 loadOlder 的「首条 h 气泡」仍是原来最早那条（游标可继续往上翻）", () => {
    const out = keepOlderPrefix(["h5", "h8", "h10"].map(msg), ["h8", "h10", "h11"].map(msg));
    expect(out.find((m) => m.id.startsWith("h"))?.id).toBe("h5");
  });
});

describe("ReloadScroll（store ↔ 列表交接）", () => {
  const view = (atBottom: boolean, following = atBottom) => ({
    capture: () => ({ atBottom, following, id: "h8", seq: 8, offset: -40 }),
    bottom: () => {},
  });
  const current = ["h5", "h8", "h10"].map(msg);
  const next = ["h8", "h10", "h11"].map(msg);
  const base = { sameSession: true, current, next };

  test("不传 reload（首次打开 / 切会话 / 历史现场）→ 不交接、不拼前缀", () => {
    const r = new ReloadScroll();
    r.attach(view(false));
    expect(ids(r.merge("a", base))).toEqual(["h8", "h10", "h11"]);
    expect(r.take("a")).toBeNull();
  });

  test("align + 往上翻 → 拼前缀并交出锚点（只交一次）", () => {
    const r = new ReloadScroll();
    r.attach(view(false));
    expect(ids(r.merge("a", { ...base, reload: "align" }))).toEqual(["h5", "h8", "h10", "h11"]);
    expect(r.take("a")).toMatchObject({ agent: "a", why: "anchor", prefix: 1, anchor: { seq: 8 } });
    expect(r.take("a")).toBeNull();
  });

  test("align + 贴底 → 不拼前缀，落底", () => {
    const r = new ReloadScroll();
    r.attach(view(true));
    expect(ids(r.merge("a", { ...base, reload: "align" }))).toEqual(["h8", "h10", "h11"]);
    expect(r.take("a")?.why).toBe("bottom");
  });

  test("latest（点推送 / 深链 / 重点当前会话）→ 不看位置，一律落底", () => {
    const r = new ReloadScroll();
    r.attach(view(false));
    expect(ids(r.merge("a", { ...base, reload: "latest" }))).toEqual(["h8", "h10", "h11"]);
    expect(r.take("a")).toMatchObject({ why: "latest", anchor: null, prefix: 0 });
  });

  test("align 但 session 轮转了（/clear 之后）→ 不拼、不锚定，落底并注明 rotated", () => {
    const r = new ReloadScroll();
    r.attach(view(false));
    expect(ids(r.merge("a", { ...base, reload: "align", sameSession: false }))).toEqual(["h8", "h10", "h11"]);
    expect(r.take("a")?.why).toBe("rotated");
  });

  test("差量替换直播气泡（delta）：新视图本就含全部历史气泡 → 不会重复拼前缀，照样交出锚点", () => {
    const r = new ReloadScroll();
    r.attach(view(false));
    const composed = ["h5", "h8", "h10", "h11"].map(msg);
    expect(ids(r.merge("a", { reload: "align", delta: true, sameSession: true, current: ["h5", "h8", "h10", "live_1"].map(msg), next: composed }))).toEqual(
      ["h5", "h8", "h10", "h11"],
    );
    expect(r.take("a")).toMatchObject({ why: "anchor", prefix: 0, delta: true });
  });

  test("差量对齐只认「正在吸底」：刚开始上滑、几何上还离底不到 90px 的不落底，走锚点；全量对齐几何贴底也算", () => {
    const r = new ReloadScroll();
    r.attach(view(true, false));
    r.merge("a", { ...base, reload: "align", delta: true });
    expect(r.take("a")?.why).toBe("anchor");
    r.merge("a", { ...base, reload: "align" });
    expect(r.take("a")?.why).toBe("bottom");
  });

  test("requestBottom 交给列表立刻落底；没挂载时无事", () => {
    const r = new ReloadScroll();
    let n = 0;
    r.requestBottom();
    r.attach({ capture: () => null, bottom: () => void n++ });
    r.requestBottom();
    expect(n).toBe(1);
  });

  test("快照不交给别的会话；列表没挂载时 align 不交接", () => {
    const r = new ReloadScroll();
    r.attach(view(false));
    r.merge("a", { ...base, reload: "align" });
    expect(r.take("b")).toBeNull();
    const bare = new ReloadScroll();
    expect(ids(bare.merge("a", { ...base, reload: "align" }))).toEqual(["h8", "h10", "h11"]);
    expect(bare.take("a")).toBeNull();
  });

  test("注销只清自己", () => {
    const r = new ReloadScroll();
    const off1 = r.attach(view(false));
    r.attach(view(true));
    off1();
    r.merge("a", { ...base, reload: "align" });
    expect(r.take("a")?.why).toBe("bottom");
  });
});

describe("windowForTop（往上翻着时窗口按顶部那条定位）", () => {
  const list = ["h1", "h2", "h3", "h4", "h5", "h6"];
  test("尾部新增：原顶部 h3、窗口 3 条（已被滑掉）→ 扩到 4", () => {
    expect(windowForTop("h3", list, 3)).toBe(4);
    expect(windowForTop("h1", list, 4)).toBe(6);
  });
  test("尾部合并 / 清掉：原顶部 h4、窗口 5 条（顶部插进了更早的 h2）→ 缩到 3", () => {
    expect(windowForTop("h4", list, 5)).toBe(3);
  });
  test("原顶部正好在窗口顶 / 已不在列表里 / 没有记录 → null", () => {
    expect(windowForTop("h3", list, 4)).toBeNull();
    expect(windowForTop("h9", list, 4)).toBeNull();
    expect(windowForTop(null, list, 4)).toBeNull();
  });
});

describe("reloadKindFor（reconnect(full) 的落点）", () => {
  test("force（点推送 / 深链 / 重点当前会话）→ latest 落底", () => {
    expect(reloadKindFor({ force: true })).toBe("latest");
  });
  test("同步失败 pill 的重试（force + keepPlace）→ align 停在原位", () => {
    expect(reloadKindFor({ force: true, keepPlace: true })).toBe("align");
  });
  test("非 force（后台恢复 / 断线重连 / 回到页面）→ align", () => {
    expect(reloadKindFor()).toBe("align");
    expect(reloadKindFor({ force: false })).toBe("align");
  });
});

describe("planWindow（每次提交后的窗口决策）", () => {
  /** 模拟连续提交：按决策改窗口大小 / 记顶部 / 放锚点，直到稳定；返回提交次数（不收敛 = -1） */
  function simulate(ids: string[], start: { windowSize: number; top: string | null; placeId: string | null }) {
    let { windowSize, top, placeId } = start;
    for (let commit = 1; commit <= 60; commit++) {
      const p = planWindow({ following: false, top, ids, windowSize, placeId });
      top = p.recordTop;
      if (p.place !== "wait") placeId = null;
      if (p.resize === null || p.resize === windowSize) return { commits: commit, windowSize, placeId };
      windowSize = p.resize;
    }
    return { commits: -1, windowSize, placeId };
  }

  test("重拉后旧窗口顶那条消失（ru_ 被正主替换）+ 锚点在新窗口顶之上 → 扩窗放锚点后收敛，不来回抖", () => {
    const ids = Array.from({ length: 100 }, (_, k) => `h${k + 1}`);
    const r = simulate(ids, { windowSize: 30, top: "ru_x", placeId: "h50" });
    expect(r.commits).toBeGreaterThan(0);
    expect(r.placeId).toBeNull();
    expect(r.windowSize).toBeGreaterThanOrEqual(100 - 49);
  });

  test("吸底时不按顶部定位、归零自动扩缩", () => {
    const p = planWindow({ following: true, top: "h1", ids: ["h1", "h2", "h3"], windowSize: 2, placeId: null });
    expect(p).toMatchObject({ resize: null, reset: true, recordTop: "h2" });
  });

  test("往上翻着、尾部来了新消息 → 扩窗保住原顶部", () => {
    const p = planWindow({ following: false, top: "h2", ids: ["h1", "h2", "h3", "h4"], windowSize: 2, placeId: null });
    expect(p).toMatchObject({ resize: 3, recordTop: "h2" });
  });
});

describe("scrollDecision（校正期内分清自己写的 / 被夹 / 用户在滚）", () => {
  const prev = { top: 2000, max: 4400 };
  const at = (settle: "anchor" | "bottom" | null, top: number, sh = 5000, ch = 600) => scrollDecision({ settle, prev, top, scrollHeight: sh, clientHeight: ch });

  test("自己写的（与上次记下的相同）→ 不结束校正，锚点校正期内不吸底", () => {
    expect(at("anchor", 2000)).toEqual({ endSettle: false, follow: false });
  });

  test("被夹（max 变小）→ 不结束校正，也不当成回到吸底", () => {
    expect(at("anchor", 1800, 2400, 600)).toEqual({ endSettle: false, follow: false });
  });

  test("跨过提交时刻的拖动 / 惯性往上 → 结束校正（惯性不再被 RO 拽回），不吸底", () => {
    expect(at("anchor", 1900)).toEqual({ endSettle: true, follow: false });
  });

  test("校正期内拖动 / 键盘滚到最底 → 结束校正并恢复吸底（此前要等下一个 scroll 事件才恢复）", () => {
    expect(scrollDecision({ settle: "anchor", prev: { top: 4300, max: 4400 }, top: 4400, scrollHeight: 5000, clientHeight: 600 })).toEqual({
      endSettle: true,
      follow: true,
    });
  });

  test("落底校正期里用户滚动 → 也结束（记日志），吸底照常判", () => {
    expect(at("bottom", 1900)).toEqual({ endSettle: true, follow: false });
  });

  test("没有校正期 → 就是 followAfterScroll", () => {
    expect(at(null, 1900)).toEqual({ endSettle: false, follow: false });
    expect(scrollDecision({ settle: null, prev: { top: 4300, max: 4400 }, top: 4390, scrollHeight: 5000, clientHeight: 600 }).follow).toBe(true);
  });
});
