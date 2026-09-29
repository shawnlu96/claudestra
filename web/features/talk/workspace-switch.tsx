"use client";
import Link from "next/link";
import { useT } from "@/lib/i18n";

/**
 * 侧栏顶部的「工作台 | Chat」分段切换：工作台 = 人 ↔ agent（/chat，每条都烧 token），Chat = 人 ↔ 人（/talk，不烧 token）。
 * 路由和代码标识符不改名（/chat 仍是工作台），只改显示文案。两个页面各自挂这一个组件。
 */
export function WorkspaceSwitch({ active }: { active: "workbench" | "talk" }) {
  const t = useT();
  const tab = (on: boolean) =>
    `whitespace-nowrap rounded-md px-2 py-0.5 text-sm transition-colors ${on ? "bg-base-100 font-semibold text-base-content shadow-sm" : "text-base-content/60 hover:text-base-content"}`;
  return (
    <nav className="flex shrink-0 items-center gap-0.5 rounded-lg bg-base-300/60 p-0.5" aria-label={t("切换工作台与 Chat")}>
      <Link href="/chat" className={tab(active === "workbench")} aria-current={active === "workbench" ? "page" : undefined}>
        {t("工作台")}
      </Link>
      <Link href="/talk" className={tab(active === "talk")} aria-current={active === "talk" ? "page" : undefined}>
        Chat
      </Link>
    </nav>
  );
}
