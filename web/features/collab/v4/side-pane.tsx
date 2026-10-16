"use client";
/**
 * v4 桌面主区外壳：标签区（children）占满宽度。左大纲和常驻右栏都去掉了（PROJTABS1）：详情改由 project-tabs/task-drawer.tsx 的抽屉盖在上面，
 * drawer 不占位，关掉后内容宽度不变。
 */
import v from "./v4.module.css";

export function PaneLayout(props: { drawer: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={v.main}>
      {props.children}
      {props.drawer}
    </div>
  );
}
