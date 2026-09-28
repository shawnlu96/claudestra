"use client";
import { useState } from "react";
import type { AgentSession } from "../type";
import { useT } from "@/lib/i18n";
import { ShareButton, ShareMenuItem } from "./share-ui";
import { SearchIcon, SearchOverlay, SessionSearchButton } from "./session-search";
import { TerminalButton, TerminalIcon, useTerminalEntry } from "../../terminal/terminal-button";
import { AgentActions, MoreMenu, closeDropdown, hasActionMenu } from "./agent-actions";
import { OpenButton } from "./open-button";
import { InfoButton } from "./info-button";
import { ImagesIcon } from "../../media/media-icons";
import { MediaPanel } from "../../media/media-panel";
import { useFullScope } from "../contacts-data";

/** 管理：四宫格（lucide layout-grid），只在折叠菜单里用——平铺时仍是文字按钮 */
function ManageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/**
 * 会话顶栏右侧操作组。顶栏够宽（自身内容宽 ≥36rem，按 @container 判而不是视口断点——
 * 桌面侧栏可拖宽，视口宽不代表顶栏宽）时平铺；窄了就把分享 / 管理 / 搜索 / 终端收进
 * ⋮ 菜单（图片与文件同理）：普通 active agent 并进 AgentActions 已有的下拉，大总管 / 非 active 另起一个。
 * 平铺按钮和菜单项只是两个入口，搜索覆盖层、终端页/模态各自只挂一份。
 */
export function TopBarActions({ agent, busy, onManage }: { agent: AgentSession; busy: boolean; onManage: () => void }) {
  const t = useT();
  const [searchOpen, setSearchOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const term = useTerminalEntry(agent);
  const full = useFullScope() === true;
  // 「管理」（重启 / 停止 / 新建 agent）只挂在大总管页，且只给全权设备：scope 含大总管但不是全权的设备点进去全是 403
  const manage = !!agent.pinnedMaster && full;
  const merged = hasActionMenu(agent, full);
  const pick = (fn: () => void) => () => {
    closeDropdown();
    fn();
  };
  // 每项都带 @xl:hidden：并进 AgentActions 下拉时，宽顶栏下它们已经平铺在外面
  const lead = (
    <>
      <ShareMenuItem busy={busy} className="@xl:hidden" onPick={closeDropdown} />
      {manage && (
        <li className="@xl:hidden">
          <button onClick={pick(onManage)}>
            <ManageIcon />
            {t("管理")}
          </button>
        </li>
      )}
      <li className="@xl:hidden">
        <button onClick={pick(() => setSearchOpen(true))}>
          <SearchIcon />
          {t("搜索")}
        </button>
      </li>
      <li className="@xl:hidden">
        <button onClick={pick(() => setMediaOpen(true))}>
          <ImagesIcon size={15} />
          {t("图片与文件")}
        </button>
      </li>
      {term.available && (
        <li className="@xl:hidden">
          <button onClick={pick(term.open)}>
            <TerminalIcon />
            {t("终端")}
          </button>
        </li>
      )}
    </>
  );
  // ⚠ 子节点位置必须固定（条件项用 && 占位）：AgentActions 若因分支换位会重挂载，
  // 重启/停止进行中的 busy 与错误提示就丢了
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      {/* 打开目录下拉：本机打开网页时才渲染（组件内判），窄顶栏也不收进 ⋮——只有一个图标 */}
      <OpenButton agent={agent} />
      <InfoButton agent={agent} />
      {/* 窄顶栏只是 CSS 隐藏，不能改成条件渲染：ShareButton 里的「工作中 / 切会话自动退出分享」守卫靠它挂着 */}
      <span className="hidden items-center gap-0.5 @xl:flex">
        <ShareButton busy={busy} />
        {manage && (
          <button
            className="btn btn-ghost btn-sm px-2 text-[13px]"
            title={t("Agent 管理(生命周期操作,不经过 LLM)")}
            onClick={onManage}
          >
            {t("管理")}
          </button>
        )}
        <SessionSearchButton onClick={() => setSearchOpen(true)} />
        <button className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content" title={t("图片与文件")} aria-label={t("图片与文件")} onClick={() => setMediaOpen(true)}>
          <ImagesIcon size={15} />
        </button>
        {term.available && <TerminalButton onClick={term.open} />}
      </span>
      {!merged && (
        <span className="@xl:hidden">
          <MoreMenu>{lead}</MoreMenu>
        </span>
      )}
      <AgentActions
        agent={agent}
        menuLead={
          merged ? (
            <>
              {lead}
              <li aria-hidden className="pointer-events-none mx-2 my-1 h-px bg-base-300 @xl:hidden" />
            </>
          ) : undefined
        }
      />
      {searchOpen && <SearchOverlay agentName={agent.name} onClose={() => setSearchOpen(false)} />}
      {mediaOpen && <MediaPanel agent={agent.name} onClose={() => setMediaOpen(false)} />}
      {term.view}
    </span>
  );
}
