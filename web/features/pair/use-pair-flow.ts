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
  | { kind: "pending"; machineName: string }
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
        const ctrl = new AbortController();
        pollAbort.current = ctrl;
        setPhase({ kind: "pending", machineName: pend.machineName || target.name });
        const st = await pollApproval(target.fp, pend.approvalId, { signal: ctrl.signal });
        if (st.state === "paired") return void (await done(st.info, target.fp));
        setPhase({ kind: "error", message: st.state === "denied" ? "电脑上拒绝了这次配对" : "确认超时，请重新输入配对码" });
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return setPhase({ kind: "idle" });
        fail(e);
      } finally {
        pollAbort.current = null;
      }
    },
    [cfg, done],
  );

  /** 直托管 + 本机回环：一键 */
  const runLocal = useCallback(
    async (name: string) => {
      if (!cfg || cfg.mode !== "direct") return;
      setPhase({ kind: "busy", label: "正在配对本机…" });
      try {
        const fp = cfg.fp || LOCAL_FP;
        await done(await pairLocal(fp, name || defaultDeviceName(navigator.userAgent)), fp);
      } catch (e) {
        setPhase({ kind: "error", message: pairErrorText(e, true) });
      }
    },
    [cfg, done],
  );

  const cancel = useCallback(() => pollAbort.current?.abort(), []);
  return useMemo(() => ({ phase, runProof, runCode, runLocal, cancel }), [phase, runProof, runCode, runLocal, cancel]);
}
