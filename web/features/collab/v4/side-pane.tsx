"use client";
/**
 * 左右两栏的外壳：朝画布那边一条 28px 的窄条，上面是收起 / 展开按钮（位置不随状态变）；收起时内容宽度过渡到 0。
 * float = 右栏临时浮出（use-panes.ts 的 peek）：内容盖在画布上而不挤它，画布不重排、视口不跳
 */
import type { Tr } from "../collab-model";
import { Icon } from "../collab-icons";
import { usePanes } from "./use-panes";
import v from "./v4.module.css";

function SidePane(props: { side: "left" | "right"; open: boolean; float?: boolean; label: { open: string; close: string }; onToggle: () => void; children: React.ReactNode }) {
  const { side, open } = props;
  const icon = side === "left" ? (open ? "panelLeftClose" : "panelLeftOpen") : open ? "panelRightClose" : "panelRightOpen";
  const rail = (
    <div className={v.rail}>
      <button type="button" className={v.railBtn} aria-label={open ? props.label.close : props.label.open} aria-expanded={open} onClick={props.onToggle}>
        <Icon name={icon} size={15} />
      </button>
    </div>
  );
  return (
    <div className={`${v.pane} ${v[`pane_${side}`]} ${open ? "" : v.paneShut} ${props.float ? v.paneFloat : ""}`}>
      {side === "right" && rail}
      <div className={v.paneBody} inert={!open}>{props.children}</div>
      {side === "left" && rail}
    </div>
  );
}

/** v4 桌面主区：大纲 | 画布（children）| 右栏。peekKey = 右栏此刻有没有详情要看（任务 / 边 / 折叠组…），收起时靠它临时浮出 */
export function PaneLayout(props: { peekKey: string | null; left: React.ReactNode; right: React.ReactNode; children: React.ReactNode; tr: Tr }) {
  const { tr } = props;
  const p = usePanes(props.peekKey);
  return (
    <div className={v.main}>
      <SidePane side="left" open={p.left} label={{ open: tr("展开大纲"), close: tr("收起大纲") }} onToggle={p.toggleLeft}>{props.left}</SidePane>
      {props.children}
      <SidePane side="right" open={p.right} float={p.peek} label={{ open: tr("展开右栏"), close: tr("收起右栏") }} onToggle={p.toggleRight}>{props.right}</SidePane>
    </div>
  );
}
