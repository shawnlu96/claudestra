/** web/features/machines/local-hop-logic.ts：桌面判定、本机入口地址、探测 fp 校验、偏好交接的键白名单与「只补缺」 */
import { describe, expect, test } from "bun:test";
import {
  applyHandoff,
  collectHandoff,
  handoffIdFromHash,
  isDesktopBrowser,
  isHandoffKey,
  localEntryUrl,
  probeMatches,
} from "@/features/machines/local-hop-logic";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

function storage(seed: Record<string, string>) {
  const data = { ...seed };
  return {
    data,
    get length() {
      return Object.keys(data).length;
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => void (data[k] = v),
  };
}

describe("isDesktopBrowser", () => {
  test("Mac 桌面算；iPhone / Android / 报 Mac UA 的 iPad（多触点）不算", () => {
    expect(isDesktopBrowser(MAC, 0)).toBe(true);
    expect(isDesktopBrowser(IPHONE, 5)).toBe(false);
    expect(isDesktopBrowser(ANDROID, 5)).toBe(false);
    expect(isDesktopBrowser(MAC, 5)).toBe(false);
  });
});

describe("localEntryUrl / handoffIdFromHash / probeMatches", () => {
  test("固定 127.0.0.1:<端口>/chat，只留 agent 参数，交接 id 走片段", () => {
    expect(localEntryUrl(3847, "")).toBe("http://127.0.0.1:3847/chat");
    expect(localEntryUrl(3847, "?agent=claudestra&fp=16f9&relay=0", "abcdef0123456789abcdef0123456789")).toBe(
      "http://127.0.0.1:3847/chat?agent=claudestra#handoff=abcdef0123456789abcdef0123456789",
    );
  });
  test("片段只认 #handoff=<16–64 位安全字符>", () => {
    expect(handoffIdFromHash("#handoff=abcdef0123456789abcdef0123456789")).toBe("abcdef0123456789abcdef0123456789");
    expect(handoffIdFromHash("#handoff=short")).toBeNull();
    expect(handoffIdFromHash("#handoff=abcdef0123456789abcdef01234567&x=1")).toBeNull();
    expect(handoffIdFromHash("")).toBeNull();
  });
  test("fp 必须与当前机器一致（同一台电脑上的沙箱实例不算）", () => {
    expect(probeMatches({ ok: true, fp: "aa-bb" }, "aa-bb")).toBe(true);
    expect(probeMatches({ ok: true, fp: "cc-dd" }, "aa-bb")).toBe(false);
    expect(probeMatches(null, "aa-bb")).toBe(false);
  });
});

describe("偏好交接", () => {
  test("白名单：原始偏好与草稿带；预生成的 CSS、API 基址、邀请处理、别家的键不带", () => {
    for (const k of ["cstra_theme", "cstra_theme_vars", "cstra_font_prefs", "cstra_chat_prefs", "cstra_lang", "cstra_draft_claudestra"]) expect(isHandoffKey(k)).toBe(true);
    for (const k of ["cstra_theme_vars_css", "cstra_font_prefs_css", "cstra_api_base", "cstra_invite_handler", "cstra_draft_", "update-toast-dismissed"]) {
      expect(isHandoffKey(k)).toBe(false);
    }
  });
  test("collectHandoff 只收白名单；applyHandoff 只补本机缺的键，返回写入的键", () => {
    const from = storage({ cstra_theme: "dark", cstra_theme_vars_css: ":root{}", cstra_api_base: "/m/x", cstra_draft_a: "hi" });
    const entries = collectHandoff(from);
    expect(entries).toEqual({ cstra_theme: "dark", cstra_draft_a: "hi" });
    const to = storage({ cstra_theme: "light" });
    expect(applyHandoff({ ...entries, cstra_theme_vars_css: "body{}", cstra_lang: 1 }, to)).toEqual(["cstra_draft_a"]);
    expect(to.data).toEqual({ cstra_theme: "light", cstra_draft_a: "hi" });
  });
});
