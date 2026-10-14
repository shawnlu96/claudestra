"use client";
/**
 * 协作视图整页的读取中 / 读失败 / 没有台账：和正常页同一个顶栏（返回 + 项目名，CollabTitle），手机上不用靠系统侧滑退出。
 * 读失败的原文默认收进「详情」；空状态只说 PM 派任务后会有什么，不给命令（导入旧台账是 PM 在 CLI 做的事）。
 * 失败页没有数据：不出团队版小字、指标条、手机上的「团队」「待你处理」。
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useChatNav } from "../chat/components/nav-context";
import { Icon } from "./collab-icons";
import type { Tr } from "./collab-model";
import type { CollabLoad } from "./use-collab";
import s from "./collab.module.css";
import v from "./v4/v4.module.css";

/** 本组件的新句子，写法照 work/work-i18n.ts：中文原样，英文先查这里再退回 tr */
const WORDS: Record<string, string> = {
  "PM 派任务后，这里会列出每个任务和进度。": "Once the PM assigns tasks, each task and its progress will be listed here.",
};
const say = (tr: Tr, text: string) => (tr("子 DAG") === "子 DAG" ? text : WORDS[text] ?? tr(text));

const NAME: CSSProperties = { flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };
const DETAILS: CSSProperties = { marginTop: 8, fontSize: "var(--fs-3)", color: "var(--muted)" };
const SUMMARY: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", listStyle: "none" };
const RAW: CSSProperties = { marginTop: 6, padding: "6px 10px", borderRadius: 6, background: "var(--panel-2)", color: "var(--text-2)", fontFamily: "var(--mono)",
  overflowWrap: "anywhere", textAlign: "left", transition: "opacity .2s ease-out, transform .2s ease-out" };

/** 顶栏的返回按钮 + 项目名：正常页把 CollabPageHead 作为 children 传进来，整页状态只给 name */
export function CollabTitle({ name, tr, children }: { name?: string; tr: Tr; children?: ReactNode }) {
  const nav = useChatNav();
  return (
    <>
      <button type="button" className={`${s.ib} ${v.back}`} aria-label={tr("返回")} onClick={nav.toList}>
        <Icon name="arrowLeft" size={16} />
      </button>
      {children ?? <span className={v.ttl} style={NAME}>{name}</span>}
    </>
  );
}

function Empty({ icon, title, children }: { icon: "listTree" | "clock" | "circleCheck"; title: string; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      <span className={s.emptyIc}>
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** 原文默认收起；展开时淡入下移（open 晚一拍才置上，过渡才有起点） */
function RawDetails({ text, tr }: { text: string; tr: Tr }) {
  const [open, setOpen] = useState(false);
  return (
    <details style={DETAILS} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary style={SUMMARY}>{tr("详情")}<Icon name={open ? "chevronUp" : "chevronDown"} size={12} /></summary>
      <div role="status" style={{ ...RAW, opacity: open ? 1 : 0, transform: open ? "none" : "translateY(-4px)" }}>{text}</div>
    </details>
  );
}

/** 台账没读到 / 没权限 / 读失败 / 还没有任务时整页一个空状态 */
export function LoadState({ load, projectName, refetch, tr }: { load: CollabLoad; projectName: string; refetch: () => void | Promise<void>; tr: Tr }) {
  let body: ReactNode;
  if (load.status === "loading") body = <Empty icon="clock" title={tr("正在读取台账…")} />;
  else if (load.status === "error" || (load.status === "ok" && load.error))
    body = (
      <Empty icon="listTree" title={tr("没取到，正在重试")}>
        <button type="button" className={s.ib} style={{ marginTop: 12 }} onClick={() => void refetch()}>{tr("重试")}</button>
        <RawDetails text={(load.status === "error" ? load.message : load.error) ?? ""} tr={tr} />
      </Empty>
    );
  else body = <Empty icon="listTree" title={tr("这个项目还没有台账")}>{say(tr, "PM 派任务后，这里会列出每个任务和进度。")}</Empty>;
  return (
    <div className={`${s.tokens} ${s.root} ${v.v4}`}>
      <div className={v.top}><CollabTitle name={projectName} tr={tr} /></div>
      <div className={s.home}>{body}</div>
    </div>
  );
}
