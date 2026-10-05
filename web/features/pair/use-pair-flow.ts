"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig } from "@/lib/app-config";
import { LOCAL_FP } from "@/lib/app-config";
import { compactCode, defaultDeviceName, loadPendingPairing, savePendingPairing, type SavedPending } from "@/lib/pairing";
import { cancelLocalPairing, pairErrorText, pairLocal, type PairedInfo } from "@/lib/api/devices";
import { finishPairing, pairByProof, pollApproval, resolveCodeTarget, startCodePairing } from "./pair-flow";

export type PairPhase =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  /** code：本机全权请求的展示码，批准的设备 / 终端命令用同一个；approver：有没有已配对设备能批。手输短码的待确认两样都没有 */
  | { kind: "pending"; machineName: string; code?: string; approver?: boolean }
  | { kind: "error"; message: string };

const CODE_EXPIRED = "确认超时，请重新输入配对码";
const LOCAL_EXPIRED = "确认超时，请再点一次一键配对";

/** 用户点「取消」：记录清掉；本机请求通知 bridge 作废（同时待批有名额上限，废弃的别占着） */
function dropSavedPending(): void {
  const p = loadPendingPairing();
  savePendingPairing(null);
  if (p?.code) cancelLocalPairing(p.fp, p.approvalId).catch((e: Error) => console.warn("[pair] 作废本机待批没发出去，等它过期:", e.message));
}

/**
 * 配对页的三条流程 + 阶段状态；成功后 onPaired（页面跳 /chat）。等批准的请求记在 sessionStorage（lib/pairing.ts）：
 * 离开配对页只停轮询、不作废，回来 resume 接着等——否则终端 / 别的设备批准后凭据签了却没人领。只有点「取消」才作废。
 */
export function usePairFlow(cfg: AppConfig | null, onPaired: () => void) {
  const [phase, setPhase] = useState<PairPhase>({ kind: "idle" });
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);
  const cancel = useCallback(() => {
    dropSavedPending();
    pollAbort.current?.abort();
  }, []);

  const done = useCallback(
    async (info: PairedInfo, fp: string) => {
      savePendingPairing(null);
      await finishPairing(info, fp);
      onPaired();
    },
    [onPaired],
  );
  const fail = (e: unknown, local = false) => setPhase({ kind: "error", message: pairErrorText(e, local) });

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

  /** 进待确认后轮询到终态；denied / 过期给各自的提示。中止（离开页面 / 取消）回 idle，记录留给 resume 或已被 cancel 清掉 */
  const awaitApproval = useCallback(
    async (p: SavedPending) => {
      const ctrl = new AbortController();
      pollAbort.current = ctrl;
      savePendingPairing(p);
      setPhase({ kind: "pending", machineName: p.machineName, code: p.code, approver: p.approver });
      try {
        const st = await pollApproval(p.fp, p.approvalId, { signal: ctrl.signal });
        if (st.state === "paired") return void (await done(st.info, p.fp));
        savePendingPairing(null);
        setPhase({ kind: "error", message: st.state === "denied" ? "电脑上拒绝了这次配对" : p.code ? LOCAL_EXPIRED : CODE_EXPIRED });
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return setPhase({ kind: "idle" });
        fail(e, !!p.code);
      } finally {
        if (pollAbort.current === ctrl) pollAbort.current = null;
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
        await awaitApproval({ fp: target.fp, approvalId: pend.approvalId, machineName: pend.machineName || target.name, expiresAt: pend.expiresAt });
      } catch (e) {
        fail(e);
      }
    },
    [cfg, awaitApproval],
  );

  /** 直托管 + 本机回环：一键——全权要已配对的设备核对展示码批准，或在这台电脑的终端 claudestra pair approve <码>，这里轮询到结果 */
  const runLocal = useCallback(
    async (name: string) => {
      if (!cfg || cfg.mode !== "direct") return;
      setPhase({ kind: "busy", label: "正在配对本机…" });
      try {
        const fp = cfg.fp || LOCAL_FP;
        const r = await pairLocal(fp, name || defaultDeviceName(navigator.userAgent));
        if (!("pending" in r)) return void (await done(r, fp));
        await awaitApproval({ fp, approvalId: r.approvalId, machineName: r.machineName, code: r.code, approver: r.approver !== false, expiresAt: r.expiresAt });
      } catch (e) {
        fail(e, true);
      }
    },
    [cfg, done, awaitApproval],
  );

  /** 进页时接着等上次没等完的请求（离开过配对页 / 刷新过） */
  const resume = useCallback((): boolean => {
    const p = loadPendingPairing();
    if (p) void awaitApproval(p);
    return !!p;
  }, [awaitApproval]);

  return useMemo(() => ({ phase, runProof, runCode, runLocal, resume, cancel }), [phase, runProof, runCode, runLocal, resume, cancel]);
}
