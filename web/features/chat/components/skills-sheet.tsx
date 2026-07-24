"use client";
import { useEffect, useMemo, useState } from "react";
import { getLang, useT } from "@/lib/i18n";
import { ResponsiveShell } from "./responsive-shell";

/** 与 composer 的 SlashCmd 同形（bridge /skills 端点）。 */
export interface SkillItem {
  name: string;
  invokeName: string;
  description: string;
  scope: string;
  argHint?: string;
}

export interface SkillPrefs {
  pins: string[];
  counts: Record<string, number>;
}

/** 冷启动默认靠前的常用技能（无置顶、无使用记录时的兜底顺序,owner 点名）。 */
const DEFAULT_HOT = ["save-compact", "compact", "clear", "status", "context"];

const SCOPE_LABEL: Record<string, string> = {
  builtin: "内建",
  native: "CC",
  plugin: "插件",
  user: "技能",
  project: "项目",
};

/** 排序:置顶组(置顶先后)→ 高频组(次数降序)→ 冷启动热门 → 其余原序。 */
export function sortSkills(skills: SkillItem[], prefs: SkillPrefs): SkillItem[] {
  const pinRank = new Map(prefs.pins.map((n, i) => [n, i]));
  const hotRank = new Map(DEFAULT_HOT.map((n, i) => [n, i]));
  return skills
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const pa = pinRank.has(a.s.name) ? pinRank.get(a.s.name)! : Infinity;
      const pb = pinRank.has(b.s.name) ? pinRank.get(b.s.name)! : Infinity;
      if (pa !== pb) return pa - pb;
      const ca = prefs.counts[a.s.name] || 0;
      const cb = prefs.counts[b.s.name] || 0;
      if (ca !== cb) return cb - ca;
      const ha = hotRank.has(a.s.name) ? hotRank.get(a.s.name)! : Infinity;
      const hb = hotRank.has(b.s.name) ? hotRank.get(b.s.name)! : Infinity;
      if (ha !== hb) return ha - hb;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

/** 置顶图钉(线性)。 */
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className="size-4"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

/**
 * Skills 面板（owner 2026-07-15:「斜杠太隐蔽,加按钮呼出;常用靠前;
 * 加管理页可置顶,其余按使用频率排」）。全屏 sheet,列表/管理双视图:
 * 列表点击 → 填入输入框;管理模式每行图钉切置顶、显示使用次数。
 * 形态走 ResponsiveShell:窄屏全屏 sheet / 桌面居中弹窗(owner 2026-07-24)。
 */
export function SkillsSheet({
  skills,
  onPick,
  onClose,
}: {
  skills: SkillItem[];
  onPick: (s: SkillItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [prefs, setPrefs] = useState<SkillPrefs>({ pins: [], counts: {} });
  const [manage, setManage] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch("/api/skills/prefs")
      .then((r) => r.json())
      .then((j: { data?: SkillPrefs }) => {
        if (j.data) setPrefs({ pins: j.data.pins || [], counts: j.data.counts || {} });
      })
      .catch(() => {});
  }, []);

  const togglePin = (name: string) => {
    const pinned = !prefs.pins.includes(name);
    // 乐观更新,失败不回滚(下次打开会校准)
    setPrefs((p) => ({
      ...p,
      pins: pinned ? [...p.pins, name] : p.pins.filter((n) => n !== name),
    }));
    void fetch("/api/skills/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, pinned }),
    }).catch(() => {});
  };

  const term = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const sorted = sortSkills(skills, prefs);
    if (!term) return sorted;
    return sorted.filter(
      (s) => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term)
    );
  }, [skills, prefs, term]);

  return (
    <ResponsiveShell z="z-50" panelClass="sm:max-w-lg sm:h-[72dvh]" onClose={onClose}>
      <div
        className="flex shrink-0 items-center gap-2 border-b border-base-300 px-3 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
      >
        <button className="btn btn-ghost btn-sm -ml-1 px-2 sm:hidden" onClick={onClose} aria-label={t("关闭 Skills")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="text-sm font-semibold">Skills</span>
        <span className="text-[11px] text-base-content/40">
          {getLang() === "en" ? `${skills.length} total` : `${skills.length} 个`}
        </span>
        <button
          className={`btn btn-sm ml-auto ${manage ? "btn-primary" : "btn-ghost text-base-content/60"}`}
          onClick={() => setManage((v) => !v)}
        >
          {manage ? t("完成") : t("管理")}
        </button>
        <button className="btn btn-ghost btn-sm max-sm:hidden" onClick={onClose} aria-label={t("关闭 Skills")}>
          ✕
        </button>
      </div>
      <div className="shrink-0 px-3 py-2">
        <label className="flex items-center gap-2 rounded-lg bg-base-300/60 px-2.5 py-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 opacity-40">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("搜索 skill…")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-base-content/35 [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
      </div>
      <div
        className="flex-1 touch-pan-y overflow-y-auto overscroll-contain px-2"
        style={{ WebkitOverflowScrolling: "touch", paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
      >
        {shown.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-base-content/40">
            {skills.length
              ? getLang() === "en"
                ? `No skills matching "${q.trim()}"`
                : `没有匹配「${q.trim()}」的 skill`
              : t("加载中…")}
          </div>
        )}
        {shown.map((s) => {
          const pinned = prefs.pins.includes(s.name);
          const count = prefs.counts[s.name] || 0;
          return (
            <div
              key={s.name}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${
                manage ? "" : "cursor-pointer transition-colors hover:bg-base-300/50 active:bg-base-300/60"
              }`}
              onClick={manage ? undefined : () => onPick(s)}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  {pinned && !manage && (
                    <span className="shrink-0 text-primary/70">
                      <PinIcon filled />
                    </span>
                  )}
                  <span className="truncate font-mono text-[13.5px] font-medium">/{s.name}</span>
                  <span className="shrink-0 rounded bg-base-300/80 px-1 text-[10px] text-base-content/45">
                    {t(SCOPE_LABEL[s.scope] || s.scope)}
                  </span>
                  {count > 0 && (
                    <span className="shrink-0 text-[10px] tabular-nums text-base-content/35">
                      {getLang() === "en" ? `used ${count}×` : `用过 ${count} 次`}
                    </span>
                  )}
                </span>
                {s.description && (
                  <span className="line-clamp-2 text-[11.5px] leading-snug text-base-content/50">
                    {s.description}
                  </span>
                )}
              </span>
              {manage && (
                <button
                  className={`grid size-8 shrink-0 place-items-center rounded-lg transition-colors ${
                    pinned ? "bg-primary/15 text-primary" : "text-base-content/35 hover:bg-base-300/60"
                  }`}
                  title={pinned ? t("取消置顶") : t("置顶")}
                  aria-label={pinned ? t("取消置顶") : t("置顶")}
                  onClick={() => togglePin(s.name)}
                >
                  <PinIcon filled={pinned} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </ResponsiveShell>
  );
}
