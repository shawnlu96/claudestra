"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ControlBar } from "./control-bar";
import { useT } from "@/lib/i18n";

/**
 * 远程终端视图（仅客户端，经 dynamic ssr:false 加载）。
 *
 * 数据面（设计文档 web-terminal-design.md）：
 * - 下行：GET /api/terminal/stream?agent=&cols=&rows=（SSE 透传 Bridge PTY 输出，
 *   帧 {"t":"o","d":base64} → term.write；{"t":"open"} 带 termId；{"t":"exit"} 结束）。
 * - 上行：term.onData 的原始转义序列 → 8ms 微批 → POST /api/terminal/input
 *   {id, d: base64}。**串行 promise 链保证字节序**（并发 fetch 不保序）。
 * - resize：ResizeObserver 防抖 150ms → fit → cols/rows 变了才 POST resize。
 *
 * 渲染主题对齐 ansi2html 的 catppuccin mocha（#1e1e2e/#cdd6f4）。
 * WebGL addon 尽力加载（失败静默降级 DOM renderer——xterm v6 已无 canvas）。
 */

type TermStatus = "connecting" | "connected" | "exited" | "error";

/** UTF-8 字符串 → base64（xterm onData 给 JS 字符串，先编 UTF-8 字节再 b64） */
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(d: string): Uint8Array {
  return Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
}

export function TerminalView({
  agent,
  mobile,
}: {
  agent: string;
  /** 手机端：控制条显示专用输入框（绕开 xterm 吞字的 textarea） */
  mobile?: boolean;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const termIdRef = useRef<string | null>(null);
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<TermStatus>("connecting");
  const [errMsg, setErrMsg] = useState("");
  // 手动重连计数：+1 触发 effect 重跑（销毁旧 PTY、建新的）
  const [connectSeq, setConnectSeq] = useState(0);
  // [mobile] 当前镜像尺寸——留白区显示一行说明（视口高被桌面端 iTerm 钳住时,
  // 画布只有 window 那么高,下方空白需要「有解释」而不是像没加载完）
  const [mirror, setMirror] = useState<{ cols: number; rows: number } | null>(null);

  // 断连/结束时收起软键盘：xterm 隐藏 textarea 仍持焦点会让 iOS 键盘赖着不走,
  // 且键盘弹着时点「重新连接」的首个 tap 会被 blur→键盘收起→布局重排吃掉
  // （点了没反应,2026-07-13 真机截图）。
  useEffect(() => {
    if (status === "exited" || status === "error") {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }, [status]);

  const statusRef = useRef<TermStatus>("connecting");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  // 自愈重连的一次性闸：连上(open 帧)即归零;防 bridge 长宕时 error→重连→error 空转
  const autoRetriedRef = useRef(false);

  // 断流自愈(2026-07-14 owner:「终端的重连从来没有成功过」)：
  // - 页面可见时断到 error/exited → 2s 后自动重连一次(bridge 重启 ~15s 才检测到
  //   断流,那时服务多半已回来,不需要用户手点「重新连接」)
  // - 回前台(iOS 后台必断) → 直接自动重连,用户无感接上
  useEffect(() => {
    if (status !== "error" && status !== "exited") return;
    if (document.visibilityState !== "visible" || autoRetriedRef.current) return;
    autoRetriedRef.current = true;
    const t = window.setTimeout(() => setConnectSeq((n) => n + 1), 2000);
    return () => window.clearTimeout(t);
  }, [status]);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (statusRef.current === "error" || statusRef.current === "exited") {
        autoRetriedRef.current = true;
        setConnectSeq((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /** 上行：微批 + 串行链（字节序！）。ControlBar 也走这里。 */
  const queueInput = (data: string) => {
    if (!data) return;
    pendingRef.current += data;
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      const id = termIdRef.current;
      const d = pendingRef.current;
      pendingRef.current = "";
      if (!id || !d) return;
      sendChainRef.current = sendChainRef.current.then(() =>
        fetch("/api/terminal/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, d: b64encode(d) }),
        }).then(
          () => undefined,
          () => undefined
        )
      );
    }, 8);
  };
  const queueInputRef = useRef(queueInput);
  queueInputRef.current = queueInput;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const abort = new AbortController();
    setStatus("connecting");
    setErrMsg("");
    termIdRef.current = null;

    // [mobile] 初始就按容器宽估 cols（xterm 默认 80×24 在手机上横向溢出一半），
    // 行数按视口粗估——连上后 open 帧会立刻校正成 window 实际尺寸。
    let initCols: number | undefined;
    let initRows: number | undefined;
    if (mobile) {
      const w = container.clientWidth || 360;
      const h = (window.visualViewport?.height ?? window.innerHeight) - 230;
      initCols = Math.max(20, Math.floor((w - 2) / (13 * 0.62)));
      initRows = Math.max(8, Math.floor(h / (13 * 1.25)));
    }
    const term = new Terminal({
      ...(mobile ? { cols: initCols, rows: initRows } : {}),
      cursorBlink: true,
      scrollback: 2000,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Mono", "Courier New", monospace',
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b70",
      },
      // iOS 软键盘：xterm 隐藏 textarea 自带 autocorrect/autocapitalize off
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    // debug 句柄：后台 tab 里 WebGL 不 paint（rAF 冻结），验证数据面要靠读 buffer
    (window as unknown as Record<string, unknown>).__claudestraTerm = term;
    // WebGL 尽力（不支持/上下文丢失 → DOM renderer）。
    // ?noWebgl=1 强制 DOM renderer（后台 tab 自动化验证用：WebGL 在 hidden tab
    // 不 paint，DOM 内容 CDP 截图可见）
    const noWebgl =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("noWebgl");
    if (!noWebgl) {
      (async () => {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          term.loadAddon(webgl);
        } catch {
          /* DOM renderer 兜底 */
        }
      })();
    }

    // [mobile] 不用 fit：PTY 尺寸由 tmux window 决定（完整镜像），手机只负责
    // 显示缩放——fit 会把 rows 撑到视口高，被后端 clamp 后画布上方 23 行、
    // 下方半屏留白（2026-07-13 真机「大量留白」）。桌面 modal 照旧 fit。
    if (!mobile) fit.fit();
    const cols = term.cols;
    const rows = term.rows;

    // [mobile] 字号自适应：window 的完整列数正好铺满容器宽（iTerm 镜像的
    // window 常比手机视口宽——缩字号而不是裁内容）。measureText 估 cell 宽，
    // floor 保守取整；rAF 后校验一轮，字体舍入导致溢出就再缩 1px。
    // ⚠ 不做高度方向的字号约束（2026-07-15 一小时命）：44 行塞进可用高会把
    // 字号压到看不清,画布缩成窄条+底下大片空白,比溢出难看得多(owner:「被
    // 你修坏了」)。超高改由画布 wrap 的底锚裁顶处理(render 处 justify-end)。
    const adaptFontSize = (cc: number) => {
      if (!mobile || !cc) return;
      const avail = container.clientWidth;
      if (!avail) return;
      const fs0 = term.options.fontSize ?? 13;
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return;
      ctx.font = `${fs0}px ${term.options.fontFamily}`;
      const ratio = ctx.measureText("W").width / fs0;
      if (!ratio || !isFinite(ratio)) return;
      // 字号整数 floor 的余量摊进 letterSpacing——52 列的取整损失能到几十 px,
      // 右侧一条空白很显眼(owner 2026-07-15:「右边没有填充满」)
      const cellW = (avail - 2) / cc;
      const fs = Math.max(8, Math.min(16, Math.floor(cellW / ratio)));
      const ls = Math.max(0, Math.min(3, cellW - fs * ratio));
      if (fs !== fs0) term.options.fontSize = fs;
      term.options.letterSpacing = ls;
      // 多轮 rAF 链式收敛(measureText 估算与 renderer 实测有偏差,一轮定不准):
      // 溢出 → 先清字距 → 仍溢出缩字号;有空隙 → 幂等公式(实测反推真实字符宽)
      // 把空隙精确摊进字间距。上限 6 轮防振荡。
      const settle = (n: number) => {
        if (n <= 0) return;
        requestAnimationFrame(() => {
          if (disposed) return;
          const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
          if (!screen || !screen.offsetWidth) return;
          const lsNow = term.options.letterSpacing ?? 0;
          if (screen.offsetWidth > avail + 1) {
            if (lsNow > 0.05) term.options.letterSpacing = 0;
            else if ((term.options.fontSize ?? 8) > 8) {
              term.options.fontSize = (term.options.fontSize ?? 9) - 1;
            } else return;
            settle(n - 1);
            return;
          }
          const rawCell = screen.offsetWidth / cc - lsNow;
          if (rawCell <= 0) return;
          const lsT = Math.max(0, Math.min(4, (avail - 2) / cc - rawCell));
          if (Math.abs(lsT - lsNow) > 0.05) {
            term.options.letterSpacing = lsT;
            settle(n - 1);
          }
        });
      };
      settle(6);
    };

    term.onData((data) => queueInputRef.current(data));
    term.onBinary((data) => queueInputRef.current(data));

    // ── SSE 下行 ──
    // ⚠ 延迟 50ms 再连：React dev 双 effect 的第一个 effect 会被同步清理——若
    // 它已发出 fetch，abort 落在「Bridge 已开 PTY、Next 响应流未建立」的 race
    // 窗口时取消传导会丢（实测漏过一条 → Bridge 僵尸 PTY，靠 TTL 才能回收）。
    // 延迟让第一个 effect 的连接根本不发生；50ms 对真人无感。
    const connectTimer = window.setTimeout(connect, 50);
    // 僵尸连接看门狗：iOS 回前台的挂起 socket 常常既不报错也不关闭——终端永远
    // 冻结且无重连入口。bridge 每 5s 发 ping,>15s 无任何字节 = 连接已死,主动
    // abort 走 error 分支,配合上面的自愈逻辑自动重连。
    let lastByteAt = Date.now();
    const stallTimer = window.setInterval(() => {
      if (!disposed && Date.now() - lastByteAt > 15_000) abort.abort();
    }, 5_000);
    async function connect() {
      let res: Response;
      try {
        res = await fetch(
          `/api/terminal/stream?agent=${encodeURIComponent(agent)}&cols=${cols}&rows=${rows}`,
          { signal: abort.signal }
        );
      } catch {
        if (!disposed) {
          setStatus("error");
          setErrMsg("连接失败");
        }
        return;
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        if (!disposed) {
          setStatus("error");
          setErrMsg(text || `${t("连接失败")} (${res.status})`);
        }
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastByteAt = Date.now(); // ping 注释帧也算——有字节就是活的
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const dataLines = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue; // 心跳注释
            let evt: { t: string; d?: string; id?: string; cols?: number; rows?: number; wcols?: number; wrows?: number };
            try {
              evt = JSON.parse(dataLines.join("\n"));
            } catch {
              continue;
            }
            if (evt.t === "o" && evt.d) {
              term.write(b64decode(evt.d));
            } else if (evt.t === "open" && evt.id) {
              termIdRef.current = evt.id;
              // 后端把 PTY clamp 到 tmux window 实际尺寸（被 iTerm 钳住时 < 视口）
              // ——xterm 同步到实际值,视口=window 就没有 tmux 填充点区域。
              // [mobile] 完整镜像：window 比初始请求宽时把 PTY 提到 window 尺寸
              // （wcols/wrows），字号按屏宽自适应——不裁内容、不残留半屏空白。
              const wc = evt.wcols ?? evt.cols;
              const wr = evt.wrows ?? evt.rows;
              if (mobile && evt.cols && evt.rows && wc && wr) {
                const apply = (c: number, r: number) => {
                  if (disposed) return;
                  if (term.cols !== c || term.rows !== r) term.resize(c, r);
                  lastCols = c;
                  lastRows = r;
                  adaptFontSize(c);
                  setMirror({ cols: c, rows: r });
                };
                if (wc !== evt.cols || wr !== evt.rows) {
                  fetch("/api/terminal/resize", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: evt.id, cols: wc, rows: wr }),
                  })
                    .then((r) => r.json())
                    .then((j: { cols?: number; rows?: number }) => apply(j.cols ?? wc, j.rows ?? wr))
                    .catch(() => apply(evt.cols!, evt.rows!));
                } else {
                  apply(evt.cols, evt.rows);
                }
              } else if (evt.cols && evt.rows && (term.cols !== evt.cols || term.rows !== evt.rows)) {
                term.resize(evt.cols, evt.rows);
              }
              if (!disposed) setStatus("connected");
              autoRetriedRef.current = false; // 连上了,自愈闸复位
            } else if (evt.t === "resize" && evt.cols && evt.rows) {
              // 后端 settle 校正推送（iTerm 钳制解除失败的降级/恢复）——同步 xterm
              if (!disposed) {
                if (term.cols !== evt.cols || term.rows !== evt.rows) term.resize(evt.cols, evt.rows);
                lastCols = evt.cols;
                lastRows = evt.rows;
                if (mobile) {
                  adaptFontSize(evt.cols);
                  setMirror({ cols: evt.cols, rows: evt.rows });
                }
              }
            } else if (evt.t === "exit") {
              if (!disposed) setStatus("exited");
            }
          }
        }
        // 流正常收尾（Bridge 关闭）——不是用户主动关就标记结束
        if (!disposed) setStatus((s) => (s === "connected" ? "exited" : s));
      } catch {
        if (!disposed) {
          setStatus((s) => (s === "connected" || s === "connecting" ? "error" : s));
          setErrMsg("连接中断");
        }
      }
    }

    // ── resize 跟随容器 ──
    let lastCols = cols;
    let lastRows = rows;
    let resizeTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (disposed) return;
        // [mobile] PTY 尺寸 = window 尺寸（不跟手机容器走）；容器宽变
        // （旋转/字号自适应回流）只需重算字号，幂等收敛不 POST。
        if (mobile) {
          adaptFontSize(term.cols);
          return;
        }
        try {
          fit.fit();
        } catch {
          return;
        }
        const id = termIdRef.current;
        if (id && (term.cols !== lastCols || term.rows !== lastRows)) {
          lastCols = term.cols;
          lastRows = term.rows;
          fetch("/api/terminal/resize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, cols: term.cols, rows: term.rows }),
          })
            .then((r) => r.json())
            .then((j: { cols?: number; rows?: number }) => {
              // 后端按 tmux window 实际尺寸 clamp 过（iTerm 钳制时 < 请求值），
              // xterm 收敛到实际值——视口=window 才没有填充点区域。
              if (
                j.cols && j.rows &&
                (term.cols !== j.cols || term.rows !== j.rows) &&
                !disposed
              ) {
                lastCols = j.cols;
                lastRows = j.rows;
                term.resize(j.cols, j.rows);
              }
            })
            .catch(() => {});
        }
      }, 150);
    });
    ro.observe(container);

    // ── 触摸滑动 → 滚轮（xterm 移动端触摸滚动官方短板 #5377；CC TUI 在
    //    alternate screen 无滚动缓冲，手指划屏本来毫无反应）。把竖向拖动合成
    //    WheelEvent 派发到 .xterm-screen，由 xterm 按 CC 当前鼠标模式正确编码
    //    上行——滑动始终是「滚动」，不会像补发方向键那样误碰输入/命令历史。
    //    手指下拉 = 看更早历史（wheel up），上推 = 回到最新。[fork]
    const screenEl = container.querySelector(".xterm-screen") as HTMLElement | null;
    let touchY: number | null = null;
    let lastMoveTs = 0;
    let velocity = 0; // px/ms（平滑估计，touchend 后惯性滑行用）
    let pendingDy = 0; // rAF 帧内合并的手指位移
    let wheelRaf: number | null = null;
    let inertiaRaf: number | null = null;
    const WHEEL_FACTOR = 2.2; // 手指位移 → 滚轮像素放大系数（真机手感可调）
    const dispatchWheel = (dyPx: number) => {
      (screenEl ?? container).dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -dyPx * WHEEL_FACTOR, // 下拉(dy>0) → deltaY<0 → wheel up → 看更早
          deltaMode: 0, // DOM_DELTA_PIXEL
          bubbles: true,
          cancelable: true,
        })
      );
    };
    // 帧内合并：touchmove 在 iOS 上每秒 60-120 发，逐发合成滚轮 = 每步一个
    // 「上行→tmux 重绘→SSE 回显」远端往返，快滑一屏几十个来回，渲染跟不上
    // 手指（2026-07-13 真机「滑动卡卡的」）。一帧最多一发、位移累积，xterm 把
    // 大 delta 一次编码成整批滚轮报告 → 一个 POST 一次重绘。
    const flushWheel = () => {
      wheelRaf = null;
      if (pendingDy !== 0) {
        const d = pendingDy;
        pendingDy = 0;
        dispatchWheel(d);
      }
    };
    const stopInertia = () => {
      if (inertiaRaf !== null) {
        cancelAnimationFrame(inertiaRaf);
        inertiaRaf = null;
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      stopInertia();
      touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
      velocity = 0;
      lastMoveTs = e.timeStamp;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = y - touchY;
      touchY = y;
      if (dy === 0) return;
      e.preventDefault(); // 吃掉原生滚动/橡皮筋，交给 xterm
      const dt = Math.max(1, e.timeStamp - lastMoveTs);
      lastMoveTs = e.timeStamp;
      velocity = 0.8 * velocity + 0.2 * (dy / dt);
      pendingDy += dy;
      if (wheelRaf === null) wheelRaf = requestAnimationFrame(flushWheel);
    };
    const onTouchEnd = () => {
      touchY = null;
      // 轻惯性：按抬手速度衰减滑行——远端回显本就有 RTT，没有惯性会
      // 「手一停画面立刻钉死」，显得格外卡。上限防 copy-mode 滚飞。
      let v = velocity * 16; // px/帧（≈16ms）
      velocity = 0;
      if (Math.abs(v) < 4) return;
      const MAX_GLIDE = 2000;
      let glided = 0;
      const step = () => {
        inertiaRaf = null;
        v *= 0.93;
        if (Math.abs(v) < 2 || glided > MAX_GLIDE) return;
        glided += Math.abs(v);
        dispatchWheel(v);
        inertiaRaf = requestAnimationFrame(step);
      };
      inertiaRaf = requestAnimationFrame(step);
    };
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      disposed = true;
      clearTimeout(connectTimer); // dev 双 effect：首个 effect 的连接在 fire 前取消
      clearInterval(stallTimer);
      ro.disconnect();
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      if (wheelRaf !== null) cancelAnimationFrame(wheelRaf);
      stopInertia();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        pendingRef.current = "";
      }
      abort.abort(); // 断 SSE → Bridge 销毁 PTY + viewer session
      term.dispose();
      termRef.current = null;
    };
    // agent 或手动重连时整体重建
  }, [agent, connectSeq]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1e1e2e]">
      {/* [mobile] 容器高 = 画布自然高（window 行数 × 行高），ControlBar 紧贴
          其下，剩余空白由底部 spacer 沉底——修「画布 23 行 + 控制条钉屏底，
          中间半屏留白」；且总高变小后 iOS 键盘弹出多数不再需要平移页面。
          shrink + justify-end + overflow-hidden（2026-07-15）：远端行数多到
          画布自然高超出可用高时（52×44 真机），容器被压缩、画布底对齐、裁的
          是**顶部**——CC 的输入框/状态栏全在底部，裁顶无感;之前 shrink-0
          会把键条下的提示行挤出屏（「底部截断」）。 */}
      <div className={mobile ? "relative flex min-h-0 shrink flex-col items-center justify-end overflow-hidden px-2 pt-2" : "relative min-h-0 flex-1 px-2 pt-2"}>
        {/* touchAction:none —— 触摸手势全归我们处理（合成 wheel 滚动），
            iOS 才不会在 preventDefault 前先把首个 move 吃成原生滚动/橡皮筋 */}
        <div
          ref={containerRef}
          className={mobile ? "w-full" : "h-full w-full"}
          style={{ touchAction: "none" }}
        />
        {status !== "connected" && (
          // onPointerDown preventDefault：断连遮罩区域内的任何触点都不许改焦点
          // （否则点偏一点就聚焦到输入通道弹键盘,重连按钮跟着位移点不中,
          // 2026-07-13 真机）;按钮走 pointerup,不受影响
          <div
            className="absolute inset-0 grid place-items-center bg-[#1e1e2e]/70"
            onPointerDown={(e) => e.preventDefault()}
          >
            {status === "connecting" && (
              <span className="flex items-center gap-2 text-sm text-[#cdd6f4]/70">
                <span className="loading loading-spinner loading-sm" />
                {t("连接终端…")}
              </span>
            )}
            {(status === "exited" || status === "error") && (
              <div className="flex flex-col items-center gap-2">
                <span className="text-sm text-[#cdd6f4]/70">
                  {status === "exited" ? t("终端会话已结束") : t(errMsg || "连接出错")}
                </span>
                {/* pointerup 而非 click：键盘尚未收完时布局还在重排,click 的
                    press-release 配对会因元素位移被 iOS 判废,pointerup 不受影响 */}
                <button
                  className="btn btn-sm"
                  onPointerUp={() => setConnectSeq((n) => n + 1)}
                >
                  {t("重新连接")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <ControlBar
        onKeys={(seq) => {
          // 「⤓ 底」按场景分流(镜像画面就在 xterm buffer 里,按画面特征判断):
          //  1. tmux copy-mode:右上角有右对齐 [n/m] 指示器 → 发 q 退出,回实时底部
          //  2. CC 转录视图(^O):底部状态栏含 "transcript" → 发 G(vi 键位,
          //     ? 帮助实测 g/G=top/bottom;End 不在表里,首版栽在这)
          //  3. 主界面(owner 的高频场景,前两版「一点用没有」的真因):PgUp 翻
          //     上去的 CC 内部滚动,End/Esc/wheel 都拉不回来(逐一实测),唯一
          //     可靠的是连发 PageDown——到底后多余的是无操作,天然无害
          //  裸发 q/G 有毒(主界面会打进输入框,实验真打出过 ❯ GG),必须先验画面。
          if (seq === "\x1b[F") {
            const term = termRef.current;
            term?.scrollToBottom();
            let out: string | null = null;
            if (term) {
              const buf = term.buffer.active;
              const line = (y: number) => buf.getLine(y)?.translateToString() || "";
              // 主界面否决条件:底部有 ❯ 输入框行(转录视图没有输入框)。
              // 光看 "transcript" 字样会踩正文地雷——聊「⤓ 底」功能本身的会话,
              // 叙述文本全是这些词,真机误判发 G 打进了输入框(❯ GG,2026-07-14)。
              const top = Math.max(0, buf.length - term.rows);
              let hasPromptLine = false;
              for (let y = Math.max(top, buf.length - 8); y < buf.length; y++) {
                if (/^\s*❯/.test(line(y))) {
                  hasPromptLine = true;
                  break;
                }
              }
              // copy-mode 指示器:屏幕区最顶行、右对齐的 [n/m](tmux overlay)
              if (/\[\d+\/\d+\]\s*$/.test(line(top).trimEnd())) out = "q";
              if (out === null && !hasPromptLine) {
                for (let y = Math.max(0, buf.length - 8); y < buf.length; y++) {
                  if (/transcript/i.test(line(y))) {
                    out = "G";
                    break;
                  }
                }
              }
            }
            queueInputRef.current(out ?? "\x1b[6~".repeat(12));
            return;
          }
          queueInputRef.current(seq);
        }}
        onFocusTerm={() => termRef.current?.focus()}
        disabled={status !== "connected"}
        mobile={mobile}
      />
      {mobile && (
        <>
          {/* 尺寸提示 shrink-0 常驻:空间不足时缺口全由画布 wrap 裁顶承担,
              提示行永不半截(2026-07-15,「底部截断」的最终收口) */}
          {status === "connected" && mirror && (
            <p className="shrink-0 pt-2 text-center font-mono text-[10px] text-[#cdd6f4]/25">
              {mirror.cols}×{mirror.rows} · {t("跟随桌面端窗口尺寸")}
            </p>
          )}
          <div className="min-h-0 flex-1" />
        </>
      )}
    </div>
  );
}

export default TerminalView;
