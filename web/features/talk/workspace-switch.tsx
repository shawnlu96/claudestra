"use client";
import Link from "next/link";
import { useT } from "@/lib/i18n";
import { showWorkspaceSwitch } from "@/lib/talk-gate";
import { useTalkEnabled } from "./use-talk-enabled";

/**
 * 侧栏顶部的「工作台 | Chat」分段切换：工作台 = 人 ↔ agent（/chat，每条都烧 token），Chat = 人 ↔ 人（/talk，不烧 token）。
 * 路由和代码标识符不改名（/chat 仍是工作台），只改显示文案。两个页面各自挂这一个组件；Chat 入口缺省收起，工作台那边经 WorkbenchTitle 判断。
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

/** 工作台侧栏顶部：Chat 入口开着出切换；关着（缺省）显示原来的「会话」标题（lib/talk-gate.ts） */
export function WorkbenchTitle() {
  const t = useT();
  return showWorkspaceSwitch(useTalkEnabled()) ? <WorkspaceSwitch active="workbench" /> : <span className="font-semibold">{t("会话")}</span>;
}
