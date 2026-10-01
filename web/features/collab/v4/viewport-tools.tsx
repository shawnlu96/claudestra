"use client";
/** 画布右下角的「适配全部」和四边的「还有 N 件」：因果线画布和子 DAG 图共用（视口状态在 use-viewport.ts） */
import type { Tr } from "../collab-model";
import type { useViewport } from "./use-viewport";
import v from "./v4.module.css";

const MORE = { right: "还有 {n} 件在右边 →", down: "下面还有 {n} 件 ↓", left: "← 左边还有 {n} 件", up: "↑ 上面还有 {n} 件" } as const;

export function ViewportTools({ vp, tr }: { vp: Pick<ReturnType<typeof useViewport>, "bump" | "fitAll" | "pan" | "off">; tr: Tr }) {
  const { bump, fitAll, pan, off } = vp;
  return (
    <>
      <div className={v.tools}>
        <button type="button" className={`${v.tool} ${bump ? v.bump : ""}`} onClick={fitAll}>{tr("适配全部")}</button>
      </div>
      {off && (Object.keys(MORE) as (keyof typeof MORE)[]).filter((d) => off[d] > 0).map((d) => (
        <button key={d} type="button" className={`${v.more} ${v[`more_${d}`]} ${bump ? v.beckon : ""}`} onClick={() => pan(d)}>{tr(MORE[d], { n: off[d] })}</button>
      ))}
    </>
  );
}
