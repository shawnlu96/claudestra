"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

/**
 * 「点火即走 + 轮询日志」的后台任务（升级后端 / 全体重启）共用的一套逻辑。
 *
 * 以前两个设置项各抄了一份，而且判完成的口径都错（2026-09-23 D8-1）：
 *  - 重启：日志是追加写，第二次点火 3 秒就读到上一轮的 `"ok"` 汇总行，误报完成；
 *  - 升级：只认 commit 变化，「已是最新」时 commit 不变，空转 10 分钟再报超时；
 *  - 两者的 setTimeout 链卸载时不停，关掉弹窗再打开 busy 丢了，还能再点一次。
 *
 * 现在的口径：POST 回 runId，GET ?run=<runId> 只回本轮的行 + 明确的 done/result，
 * 前端只认本轮。bridge 在一轮没结束时拒绝再次点火（409 + 那一轮的 runId，这里接着
 * 看它的进度）。打开时先 GET 一次不带 run 的「最后一轮」，正在进行就接回去——
 * 刷新页面 / 关了弹窗再开，按钮都保持「进行中」。
 */

interface JobResult {
  ok?: boolean;
  error?: string;
  message?: string;
}

interface JobLogResp {
  lines?: string[];
  runId?: string | null;
  running?: boolean;
  done?: boolean;
  exitCode?: number | null;
  result?: JobResult | null;
}

const POLL_MS = 3000;
const RUN_ID_RE = /^\d{1,16}$/;

export function useBackgroundJob(opts: {
  /** BFF 路由：POST 点火，GET 读日志（?run=<runId>） */
  endpoint: string;
  /** 本轮最长等待；过了就停轮询并提示 */
  deadlineMs: number;
  deadlineMsg: string;
  /** 额外的完成判据（升级：commit 变了）。日志没写出结果行时兜底用 */
  extraDone?: () => Promise<boolean>;
  /** 完成后回调（升级完刷新版本号） */
  onDone?: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const runRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // 回调走 ref：轮询链跨很多次渲染，不能被旧闭包钉住
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    runRef.current = null;
  }, []);

  const finish = useCallback(
    (j: JobLogResp | null) => {
      stop();
      setBusy(false);
      const r = j?.result;
      if (r?.ok === false) setErr(r.error || t("失败"));
      else if (!r && j?.exitCode) setErr(`${t("退出码")} ${j.exitCode}`);
      else if (r?.message) setNote(r.message);
      optsRef.current.onDone?.();
    },
    [stop, t],
  );

  /** runId 为 null = 对端没给 runId（旧 bridge），退回看「最后一轮」 */
  const poll = useCallback(
    (runId: string | null, until: number) => {
      const key = runId ?? "";
      runRef.current = key;
      const tick = async () => {
        if (!alive.current || runRef.current !== key) return;
        let j: JobLogResp | null = null;
        try {
          const q = runId ? `?run=${runId}` : "";
          j = (await (await fetch(`${optsRef.current.endpoint}${q}`, { cache: "no-store" })).json()) as JobLogResp;
        } catch {
          /* bridge 重启期间接口会抖，正常 */
        }
        if (!alive.current || runRef.current !== key) return;
        if (j?.lines?.length) setLines(j.lines.slice(-12));
        let done = !!j?.done;
        if (!done && optsRef.current.extraDone) done = await optsRef.current.extraDone().catch(() => false);
        if (!alive.current || runRef.current !== key) return;
        if (done) return finish(j);
        if (Date.now() > until) {
          stop();
          setBusy(false);
          setErr(optsRef.current.deadlineMsg);
          return;
        }
        timer.current = setTimeout(() => void tick(), POLL_MS);
      };
      timer.current = setTimeout(() => void tick(), POLL_MS);
    },
    [finish, stop],
  );

  // 挂载：接回正在进行的一轮；卸载：停轮询（关弹窗后不再在后台空跑）
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const j = (await (await fetch(optsRef.current.endpoint, { cache: "no-store" })).json()) as JobLogResp;
        if (!alive.current || runRef.current !== null) return;
        if (j.running && j.runId && RUN_ID_RE.test(j.runId)) {
          setBusy(true);
          setLines(j.lines?.slice(-12) ?? []);
          poll(j.runId, Number(j.runId) + optsRef.current.deadlineMs);
        }
      } catch {
        /* 读不到就当没有进行中的，按钮照常可点；真撞上会被 409 接回 */
      }
    })();
    return () => {
      alive.current = false;
      stop();
    };
  }, [poll, stop]);

  const start = useCallback(async () => {
    if (busy) return;
    // 占位：POST 在飞时挂载那次「接回进行中」的 GET 回来了也别再起一条轮询链
    runRef.current = "starting";
    setBusy(true);
    setErr("");
    setNote("");
    setLines([]);
    let runId: string | null = null;
    try {
      const res = await fetch(optsRef.current.endpoint, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; runId?: string };
      const rid = typeof j.runId === "string" && RUN_ID_RE.test(j.runId) ? j.runId : null;
      if (res.status === 409 && rid) {
        // 上一轮还在跑：不再点一次，接着看那一轮
        setNote(j.error || t("上一轮还没结束，接着看它的进度"));
        runId = rid;
      } else if (!res.ok || j.ok === false) {
        throw new Error(j.error || `HTTP ${res.status}`);
      } else {
        runId = rid;
      }
    } catch (e) {
      runRef.current = null;
      if (!alive.current) return;
      setErr((e as Error).message);
      setBusy(false);
      return;
    }
    if (!alive.current) return;
    // 截止时间按本机时钟算（runId 是 bridge 的时钟，手机上可能有偏差）
    poll(runId, Date.now() + optsRef.current.deadlineMs);
  }, [busy, poll, t]);

  return { busy, lines, err, note, start };
}

/** 本轮日志的末尾几行 */
export function JobLog({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <pre className="mt-2 max-h-40 overflow-auto rounded bg-base-300/50 p-2 text-[11px] leading-snug">
      {lines.join("\n")}
    </pre>
  );
}
