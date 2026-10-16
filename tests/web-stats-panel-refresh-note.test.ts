/**
 * 看板刷新提示（web/features/chat/components/stats-panel.tsx）：账号接口的 Claude 卡是实时读数时，
 * /status 探测失败不再说「读取账号用量失败，显示的是上次读数或未知」——那句只在卡片不是实时的时候出（含冷却时刻）。
 */
import { describe, expect, test } from "bun:test";
import { claudeAccountLive, refreshNoteMessage, type RefreshNote } from "../web/features/chat/components/stats-panel";
import { quotaPanelData } from "../web/features/chat/quota-view";
import { t } from "../web/lib/i18n";

const FAIL = "读取账号用量失败，显示的是上次读数或未知；{time} 前不再重试";
const next = new Date(2026, 9, 16, 10, 30).getTime();
const failed: RefreshNote = { outcome: "failed", nextAllowedAt: next, reason: "probe_input_unexpected" };
const backoff: RefreshNote = { outcome: "backoff", nextAllowedAt: next, reason: "probe_input_unexpected" };
const sub = (layer: string, id = "claude") =>
  quotaPanelData({ snapshot: { generatedAt: 1, providers: [{ id, name: "Claude", source: { layer, observedAt: 1 } }] } });
const time = new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("claudeAccountLive", () => {
  test("只认 id=claude 且 layer=live", () => {
    expect(claudeAccountLive(sub("live"))).toBe(true);
    for (const l of ["live_stale", "local_cache", "none"]) expect(claudeAccountLive(sub(l))).toBe(false);
    expect(claudeAccountLive(sub("live", "codex"))).toBe(false);
    expect(claudeAccountLive(sub("live", "claude.local"))).toBe(false);
    expect(claudeAccountLive(null)).toBe(false);
  });
});

describe("refreshNoteMessage", () => {
  for (const note of [failed, backoff]) {
    test(`${note.outcome} + 账号卡实时 → 不出「读取账号用量失败…」，也不暗示上面的数是旧的`, () => {
      const m = refreshNoteMessage(note, claudeAccountLive(sub("live")));
      expect(m?.key).not.toBe(FAIL);
      const text = t(m!.key, m!.params);
      expect(text).toContain("实时");
      expect(text).not.toMatch(/失败|上次读数/);
    });

    test(`${note.outcome} + 账号卡非实时 → 照旧出失败提示，含冷却时刻`, () => {
      const m = refreshNoteMessage(note, claudeAccountLive(sub("live_stale")));
      expect(m?.key).toBe(FAIL);
      expect(t(m!.key, m!.params)).toContain(`${time} 前不再重试`);
    });
  }

  test("没有 /quota 数据（老 bridge / 非 owner）→ 照旧出失败提示", () => {
    expect(refreshNoteMessage(failed, claudeAccountLive(null))?.key).toBe(FAIL);
  });

  test("refreshed / busy 不出；unknown 照旧", () => {
    expect(refreshNoteMessage({ outcome: "refreshed", nextAllowedAt: null, reason: null }, false)).toBeNull();
    expect(refreshNoteMessage({ outcome: "busy", nextAllowedAt: null, reason: null }, true)).toBeNull();
    expect(refreshNoteMessage({ outcome: "unknown", nextAllowedAt: null, reason: null }, true)?.key).toContain("账号用量未知");
  });
});
