"use client";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore } from "../chat-store";
import { ExportContext } from "../export-context";
import { selRange, setShareOn } from "../share-mode";
import { buildHtmlDoc, collectCss, deliverFile, exportFileName, inlineImages, printHtml } from "../share-export";
import type { ChatMessage } from "../type";
import { useT } from "@/lib/i18n";
import { useShare } from "./share-ui";
import { Composer } from "./composer";
import { Message } from "./message-list";
import { ExportHeader, type ExportMeta } from "./export-header";

/**
 * 分享模式的底部 dock（顶替输入框的位置）：已选数量 / 导出 HTML / 导出 PDF / 返回对话。
 *
 * 导出 = 把选中的消息用**同一套消息组件**在一个离屏容器里再渲染一遍（portal，仍在
 * ChatStoreProvider 之下，所以 Message 里的 store 订阅照常工作），等 markdown / 代码
 * 高亮落地后把 DOM 序列化，内联全部 CSS 和图片，得到自包含 HTML（share-export.ts）。
 * PDF 不自己生成——同一份 HTML 走系统打印，用户在对话框里「存为 PDF」。
 * 分享面板 / 打印都要用户手势，所以是两步：先「生成」，好了再点「保存 / 打印」；
 * 生成结果绑定当时的选区——选区一变就作废回到第一步，也有「取消」可退（owner 2026-09-25
 * 「回退不了了，必须退出再重进」）。
 */
export function ComposerOrDock() {
  const { on } = useShare();
  return on ? <ShareDock /> : <Composer />;
}

type Kind = "html" | "pdf";
type Job = { kind: Kind; key: string; msgs: ChatMessage[] };
type Ready = { kind: Kind; key: string; html: string; name: string };

/** 导出树：抬头 + 选中消息；ExportContext 打开 → 旁白强制展开、进度句不渲染；每条外面保留 data-mid */
function ExportDoc({ msgs, meta, agent }: { msgs: ChatMessage[]; meta: ExportMeta; agent: string }) {
  return (
    <ExportContext.Provider value={true}>
      <div className="text-base-content">
        <ExportHeader meta={meta} agent={agent} count={msgs.length} at={new Date()} />
        {msgs.map((m) => (
          <div key={m.id} data-mid={m.id}>
            <Message m={m} streaming={false} isLast={false} awaiting={false} />
          </div>
        ))}
      </div>
    </ExportContext.Provider>
  );
}

/** 离屏容器：挂在 body 上、移出视口；宽度定 820 让排版接近桌面阅读宽度。第一次点导出时才建，dock 卸载时移除。 */
function makeHost(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "bg-base-100";
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:820px;padding:16px;pointer-events:none";
  document.body.appendChild(el);
  return el;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 离屏树挂上后：等一拍让 Prism 语法 / 图片落地 → 内联图片 → 抄样式 → 拼文档 */
async function packExport(host: HTMLElement, title: string): Promise<string> {
  await sleep(600);
  await inlineImages(host);
  const { css, links } = await collectCss(document);
  const root = document.documentElement;
  const htmlAttrs: Record<string, string> = { lang: root.lang || "zh-CN" };
  // 只带主题，不抄 html 的 class：canvas-list / kb-open 那些是壳的运行态（画布色、键盘），导出文件不要
  const theme = root.getAttribute("data-theme");
  if (theme) htmlAttrs["data-theme"] = theme;
  return buildHtmlDoc({ title, bodyHtml: host.innerHTML, css, links, htmlAttrs, bodyClass: document.body.className });
}

/** 抬头用的版本 / 导出人：进 dock 时拉一次，拉不到就留空 */
function useExportMeta(): ExportMeta {
  const nickname = useChatStore((s) => s.state.profile.nickname);
  const [meta, setMeta] = useState<ExportMeta>({ version: "", commit: "", exporter: "" });
  useEffect(() => {
    let dead = false;
    Promise.all([
      fetch("/api/version").then((r) => (r.ok ? r.json() : null)).catch(() => null /* 版本拿不到抬头就不写版本，导出照常 */),
      fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).catch(() => null /* 用户名拿不到就用昵称或留空，导出照常 */),
    ]).then(([v, me]) => {
      if (dead) return;
      const ver = (v ?? {}) as { version?: string; commit?: string };
      const user = ((me ?? {}) as { data?: { username?: string } }).data?.username ?? "";
      setMeta({ version: ver.version ?? "", commit: ver.commit ?? "", exporter: user });
    });
    return () => {
      dead = true;
    };
  }, []);
  return { ...meta, exporter: nickname || meta.exporter };
}

export function ShareDock() {
  const t = useT();
  const { sel } = useShare();
  const messages = useChatStore((s) => s.state.messages);
  const active = useChatStore((s) => s.state.activeAgent);
  const agents = useChatStore((s) => s.state.agents);
  const title = agents.find((a) => a.name === active)?.displayName || active || "Claudestra";
  const order = useMemo(() => messages.map((m) => m.id), [messages]);
  const range = selRange(sel, order);
  const count = range ? range.hi - range.lo + 1 : 0;
  const selKey = sel ? `${sel.a}|${sel.b}` : "";
  const meta = useExportMeta();
  const [job, setJob] = useState<Job | null>(null);
  const [readyRaw, setReady] = useState<Ready | null>(null);
  const ready = readyRaw && readyRaw.key === selKey ? readyRaw : null; // 选区变了就作废
  const [err, setErr] = useState("");
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => () => host?.remove(), [host]);

  useEffect(() => {
    if (!job || !host) return;
    let cancelled = false;
    packExport(host, title)
      .then((html) => {
        if (cancelled) return;
        setReady({ kind: job.kind, key: job.key, html, name: exportFileName(title) });
        setJob(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr((e as Error).message || "export failed");
        setJob(null);
      });
    return () => {
      cancelled = true;
    };
  }, [job, host, title]);

  const start = (kind: Kind) => {
    if (!range) return;
    setErr("");
    setReady(null);
    if (!host) setHost(makeHost());
    setJob({ kind, key: selKey, msgs: messages.slice(range.lo, range.hi + 1) });
  };
  const finish = () => {
    if (!ready) return;
    if (ready.kind === "pdf") printHtml(ready.html);
    else void deliverFile(new File([ready.html], ready.name, { type: "text/html" })).catch((e: unknown) => setErr((e as Error).message));
  };

  return (
    <div className="bg-base-100 px-4 pb-3 pt-2 sm:px-7" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}>
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-base-300 bg-base-200/60 px-3 py-2 lg:max-w-[min(92%,1600px)]">
        <span className="text-sm font-medium">
          {t("已选")} <span className="font-mono tabular-nums">{count}</span>
        </span>
        {count === 0 && <span className="text-xs text-base-content/45">{t("先点消息旁的方框选一段")}</span>}
        {err && <span className="text-xs text-error/80">{t("导出失败:")}{err}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {ready ? (
            <>
              <button className="btn btn-primary btn-sm" onClick={finish}>
                {ready.kind === "pdf" ? t("打开打印（存为 PDF）") : t("保存 HTML")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setReady(null)}>
                {t("取消")}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-sm" disabled={!count || !!job} onClick={() => start("html")}>
                {job?.kind === "html" ? <span className="loading loading-spinner loading-xs" /> : null} {t("导出 HTML")}
              </button>
              <button className="btn btn-sm" disabled={!count || !!job} onClick={() => start("pdf")}>
                {job?.kind === "pdf" ? <span className="loading loading-spinner loading-xs" /> : null} {t("导出 PDF")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShareOn(false)}>
                {t("返回对话")}
              </button>
            </>
          )}
        </span>
      </div>
      {job && host && createPortal(<ExportDoc msgs={job.msgs} meta={meta} agent={title} />, host)}
    </div>
  );
}
