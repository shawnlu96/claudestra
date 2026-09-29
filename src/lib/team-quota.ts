/** Team view reads the persisted cache only: opening it must not refresh credentials or probe providers. */
import type { QuotaState } from "./quota-state.js";

export function teamQuota(state: QuotaState, now: number) {
  return (["claude", "codex"] as const).map((provider) => {
    const key = state.current[provider];
    const account = key ? state.accounts[key] : undefined;
    const snapshot = account?.snapshots[provider === "claude" ? "claude_usage" : "codex_usage"];
    const fresh = snapshot && now >= snapshot.observedAt && now - snapshot.observedAt <= 5 * 60_000;
    const windows = snapshot?.data.windows.filter((w) => w.kind !== "weekly_scoped") ?? [];
    const known = fresh && !account?.uncertain && windows.length > 0 &&
      windows.every((w) => w.resetsAtMs !== null && w.resetsAtMs > now && Number.isFinite(w.usedPct));
    const used = known ? Math.max(...windows.map((w) => w.usedPct)) : null;
    return { provider, used, observedAt: snapshot?.observedAt ?? null };
  });
}
