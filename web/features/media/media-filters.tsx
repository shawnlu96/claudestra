"use client";
import type { AgentSession } from "../chat/type";
import { useT } from "@/lib/i18n";
import { FileIcon, ImagesIcon } from "./media-icons";
import type { TimeRange } from "./media-logic";

/** 图片与文件视图的筛选状态（页签 + 名字 + 会话 + 谁发的 + 类型 + 时间） */
export interface MediaFilterState {
  tab: "image" | "file";
  q: string;
  pick: string;
  dir: "" | "in" | "out";
  cat: string;
  range: TimeRange;
}

const CATS: [string, string][] = [["", "全部类型"], ["pdf", "PDF"], ["doc", "文档"], ["code", "代码与日志"], ["archive", "压缩包"], ["media", "音视频"], ["other", "其他"]];
const RANGES: [TimeRange, string][] = [["all", "全部时间"], ["7d", "最近 7 天"], ["30d", "最近 30 天"], ["90d", "最近 90 天"], ["year", "最近一年"]];
const INPUT = "input input-sm input-bordered min-w-0 flex-1 basis-40 text-sm";
/** 文件名搜索框：关掉自动补全 / 首字母大写 / 拼写检查 */
const NO_ASSIST = { autoComplete: "off", autoCapitalize: "off", spellCheck: false } as const;
const SEL = "select select-sm select-bordered min-w-0 max-w-[10rem] bg-base-100 text-xs";

/** 页签 + 搜索框 + 下拉筛选；agents 不传 = 本会话视图，不出「会话」下拉 */
export function MediaFilters({ f, set, agents }: { f: MediaFilterState; set: (p: Partial<MediaFilterState>) => void; agents?: AgentSession[] }) {
  const t = useT();
  const tab = (id: MediaFilterState["tab"], label: string, icon: React.ReactNode) => (
    <button role="tab" className={`tab gap-1.5 ${f.tab === id ? "tab-active" : ""}`} onClick={() => set({ tab: id })}>
      {icon}
      {t(label)}
    </button>
  );
  return (
    <>
      <div role="tablist" className="tabs tabs-box tabs-sm w-fit">
        {tab("image", "图片", <ImagesIcon size={14} />)}
        {tab("file", "文件", <FileIcon size={14} />)}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <input type="search" value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder={t("按文件名搜索…")} {...NO_ASSIST} className={INPUT} />
        {agents && (
          <select className={SEL} value={f.pick} onChange={(e) => set({ pick: e.target.value })} aria-label={t("会话")}>
            <option value="">{t("全部会话")}</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <select className={SEL} value={f.dir} onChange={(e) => set({ dir: e.target.value as MediaFilterState["dir"] })} aria-label={t("谁发的")}>
          <option value="">{t("谁发的都看")}</option>
          <option value="in">{t("我发的")}</option>
          <option value="out">{t("agent 发的")}</option>
        </select>
        {f.tab === "file" && (
          <select className={SEL} value={f.cat} onChange={(e) => set({ cat: e.target.value })} aria-label={t("类型")}>
            {CATS.map(([v, l]) => (
              <option key={v} value={v}>
                {t(l)}
              </option>
            ))}
          </select>
        )}
        <select className={SEL} value={f.range} onChange={(e) => set({ range: e.target.value as TimeRange })} aria-label={t("时间")}>
          {RANGES.map(([v, l]) => (
            <option key={v} value={v}>
              {t(l)}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
