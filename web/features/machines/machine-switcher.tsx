"use client";
import Link from "next/link";
import { machines } from "@/lib/machines";
import { useT } from "@/lib/i18n";
import { useMachines } from "./use-machines";

/**
 * 顶栏的机器切换（只在中继模式且配对了不止一台时出现）：下拉列出机器、当前项打勾、凭据失效的标出来，
 * 末尾「添加另一台机器」去 /pair。切换 = machines.setCurrent（API 客户端顺手中止旧机器的在途请求 / SSE）
 * + onSwitched 让聊天 store 清空重拉——同一个 store 实例换数据源，不整页刷新。
 */
export function MachineSwitcher({ onSwitched }: { onSwitched: () => void }) {
  const t = useT();
  const { list, current, multi } = useMachines();
  if (!multi || list.length < 2) return null;
  const pick = async (fp: string) => {
    (document.activeElement as HTMLElement | null)?.blur(); // 收起 daisyUI 的 focus 下拉
    if (fp === current?.fp) return;
    await machines.setCurrent(fp);
    onSwitched();
  };
  return (
    <div className="dropdown dropdown-end">
      <button
        tabIndex={0}
        className="flex h-7 max-w-[9rem] items-center gap-1 rounded-lg px-1.5 text-xs text-base-content/70 transition-colors hover:bg-base-300 hover:text-base-content"
        title={t("切换机器")}
        aria-label={t("切换机器")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <rect width="20" height="14" x="2" y="3" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
        <span className="truncate">{current?.name ?? t("选择机器")}</span>
      </button>
      <ul tabIndex={0} className="menu dropdown-content z-50 mt-1 w-56 rounded-xl border border-base-300 bg-base-100 p-1.5 text-[13px] shadow-lg">
        {list.map((m) => {
          const active = m.fp === current?.fp;
          const repair = machines.healthOf(m.fp) === "repair";
          return (
            <li key={m.fp}>
              <button className={active ? "font-semibold" : ""} onClick={() => void pick(m.fp)}>
                <span className="w-4 shrink-0">{active ? "✓" : ""}</span>
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {repair && <span className="badge badge-warning badge-xs">{t("需重新配对")}</span>}
              </button>
            </li>
          );
        })}
        <li className="mt-1 border-t border-base-300 pt-1">
          <Link href="/pair">＋ {t("添加另一台机器")}</Link>
        </li>
      </ul>
    </div>
  );
}
