"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig } from "@/lib/app-config";
import { LOCAL_FP } from "@/lib/app-config";
import { compactCode, defaultDeviceName } from "@/lib/pairing";
import { pairErrorText, pairLocal, type PairedInfo } from "@/lib/api/devices";
import { finishPairing, pairByProof, pollApproval, resolveCodeTarget, startCodePairing } from "./pair-flow";

export type PairPhase =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  /** code：本机全权请求的展示码，批准的设备上显示同一个；手输短码的待确认没有 */
  | { kind: "pending"; machineName: string; code?: string }
  | { kind: "error"; message: string };

/** 配对页的三条流程 + 阶段状态；成功后 onPaired（页面跳 /chat）。离开页面时中止轮询。 */
export function usePairFlow(cfg: AppConfig | null, onPaired: () => void) {
  const [phase, setPhase] = useState<PairPhase>({ kind: "idle" });
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);

  const done = useCallback(
    async (info: PairedInfo, fp: string) => {
      await finishPairing(info, fp);
      onPaired();
    },
    [onPaired],
  );
  const fail = (e: unknown) => setPhase({ kind: "error", message: pairErrorText(e) });

  /** 扫码 / 链接：挑战应答 */
  const runProof = useCallback(
    async (fp: string, secret: string, name: string) => {
      setPhase({ kind: "busy", label: "正在与电脑握手…" });
      try {
        await done(await pairByProof(fp, secret, name), fp);
      } catch (e) {
        fail(e);
      }
    },
    [done],
  );

  /** 进待确认后轮询到终态；denied / 过期给各自的提示 */
  const awaitApproval = useCallback(
    async (fp: string, approvalId: string, pending: Extract<PairPhase, { kind: "pending" }>, expiredMsg: string) => {
      const ctrl = new AbortController();
      pollAbort.current = ctrl;
      setPhase(pending);
      try {
        const st = await pollApproval(fp, approvalId, { signal: ctrl.signal });
        if (st.state === "paired") return void (await done(st.info, fp));
        setPhase({ kind: "error", message: st.state === "denied" ? "电脑上拒绝了这次配对" : expiredMsg });
      } finally {
        pollAbort.current = null;
      }
    },
    [done],
  );

  /** 手输短码：查机器 → 待确认 → 轮询到终态 */
  const runCode = useCallback(
    async (raw: string, name: string) => {
      const c = compactCode(raw);
      if (c.length !== 8) return setPhase({ kind: "error", message: "配对码是 8 位" });
      if (!cfg) return;
      setPhase({ kind: "busy", label: "正在查找这台机器…" });
      try {
        const target = await resolveCodeTarget(cfg, c);
        const pend = await startCodePairing(target.fp, c, name);
        await awaitApproval(target.fp, pend.approvalId, { kind: "pending", machineName: pend.machineName || target.name }, "确认超时，请重新输入配对码");
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return setPhase({ kind: "idle" });
        fail(e);
      }
    },
    [cfg, awaitApproval],
  );

  /** 直托管 + 本机回环：一键——全权要在已配对的设备上核对展示码批准，这里轮询到结果 */
  const runLocal = useCallback(
    async (name: string) => {
      if (!cfg || cfg.mode !== "direct") return;
      setPhase({ kind: "busy", label: "正在配对本机…" });
      try {
        const fp = cfg.fp || LOCAL_FP;
        const r = await pairLocal(fp, name || defaultDeviceName(navigator.userAgent));
        if (!("pending" in r)) return void (await done(r, fp));
        await awaitApproval(fp, r.approvalId, { kind: "pending", machineName: r.machineName, code: r.code }, "确认超时，请再点一次一键配对");
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return setPhase({ kind: "idle" });
        setPhase({ kind: "error", message: pairErrorText(e, true) });
      }
    },
    [cfg, done, awaitApproval],
  );

  const cancel = useCallback(() => pollAbort.current?.abort(), []);
  return useMemo(() => ({ phase, runProof, runCode, runLocal, cancel }), [phase, runProof, runCode, runLocal, cancel]);
}
