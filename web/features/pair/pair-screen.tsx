"use client";
/**
 * /pair：把这个浏览器配对到一台 Mac（docs/design-hosted-frontend.md §4）。三种进来法：
 *   扫二维码 / 点链接 → 地址带 `#<fp>.<secret>`，自动走挑战应答，秘密不出浏览器；
 *   手输 8 位短码 → 中继查到机器 → 进待确认，Mac 侧点头才发凭据（这里每 1.5s 轮询）；
 *   直托管 + 本机回环 → 一键配对。
 * 片段只在浏览器里读（# 不上服务器）。成功后机器进清单、设为当前，去 /chat。
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import type { AppConfig } from "@/lib/app-config";
import { codeFromFragment, compactCode, defaultDeviceName, formatCode, isLoopbackHost, parsePairFragment } from "@/lib/pairing";
import { bootMachines, useMachines } from "../machines/use-machines";
import { usePairFlow } from "./use-pair-flow";

export function PairScreen() {
  const t = useT();
  const router = useRouter();
  const { list } = useMachines();
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [loopback, setLoopback] = useState(false);
  const flow = usePairFlow(cfg, () => router.replace("/chat"));
  const autoRan = useRef(false);

  // 进页：拉配置；地址里带东西就自动走（扫码 / 老短码链接），等首帧渲染完再动（effect 里同步 setState 会级联重渲染）
  useEffect(() => {
    let dead = false;
    void bootMachines().then((c) => {
      if (dead) return;
      setCfg(c);
      setLoopback(c.mode === "direct" && isLoopbackHost(window.location.hostname));
      setDeviceName(defaultDeviceName(navigator.userAgent, navigator.platform));
    });
    return () => {
      dead = true;
    };
  }, []);
  useEffect(() => {
    if (!cfg || autoRan.current) return;
    autoRan.current = true;
    const name = defaultDeviceName(navigator.userAgent, navigator.platform);
    const frag = parsePairFragment(window.location.hash);
    const legacy = frag ? "" : codeFromFragment(window.location.hash);
    const timer = setTimeout(() => {
      if (frag) void flow.runProof(frag.fp, frag.secret, name);
      else if (legacy) {
        setCode(formatCode(legacy));
        void flow.runCode(legacy, name);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [cfg, flow]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 px-4">
      <div className="card w-full max-w-sm bg-base-100 shadow-lg">
        <div className="card-body">
          <h1 className="mb-1 text-center text-xl font-bold">Claudestra</h1>
          <p className="mb-4 text-center text-xs text-base-content/60">{t("把这个浏览器配对到你的电脑")}</p>
          {flow.phase.kind === "pending" ? (
            <PendingCard machineName={flow.phase.machineName} onCancel={flow.cancel} />
          ) : (
            <PairForm
              code={code}
              deviceName={deviceName}
              phase={flow.phase}
              loopback={loopback}
              onCode={(v) => setCode(formatCode(v))}
              onDeviceName={setDeviceName}
              onSubmit={() => void flow.runCode(code, deviceName)}
              onLocal={() => void flow.runLocal(deviceName)}
            />
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-base-content/50">
            {t("在电脑的终端里运行")} <code className="font-mono">claudestra pair</code>
            {t("，扫二维码直接进；手输 8 位码则要在电脑上确认一次。码 10 分钟内有效，只能用一次。")}
          </p>
          {list.length > 0 && (
            <Link href="/chat" className="btn btn-ghost btn-sm mt-2 w-full">
              {t("回到 Claudestra")}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

interface FormProps {
  code: string;
  deviceName: string;
  phase: ReturnType<typeof usePairFlow>["phase"];
  loopback: boolean;
  onCode: (v: string) => void;
  onDeviceName: (v: string) => void;
  onSubmit: () => void;
  onLocal: () => void;
}

function PairForm({ code, deviceName, phase, loopback, onCode, onDeviceName, onSubmit, onLocal }: FormProps) {
  const t = useT();
  const busy = phase.kind === "busy";
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="form-control">
        <span className="label-text mb-1 text-sm">{t("配对码")}</span>
        <input
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX"
          className="input input-bordered w-full text-center font-mono text-lg tracking-[0.2em]"
          value={code}
          disabled={busy}
          onChange={(e) => onCode(e.target.value)}
          autoFocus
        />
      </label>
      <label className="form-control">
        <span className="label-text mb-1 text-sm">{t("这台设备叫什么")}</span>
        <input type="text" className="input input-bordered input-sm w-full" value={deviceName} disabled={busy} maxLength={60} onChange={(e) => onDeviceName(e.target.value)} />
      </label>
      {phase.kind === "error" && <div className="alert alert-error alert-sm py-2 text-sm">{t(phase.message)}</div>}
      <button type="submit" className="btn btn-primary btn-sm w-full" disabled={busy || compactCode(code).length !== 8}>
        {phase.kind === "busy" ? (
          <>
            <span className="loading loading-spinner loading-xs" /> {t(phase.label)}
          </>
        ) : (
          t("配对")
        )}
      </button>
      {loopback && (
        <button type="button" className="btn btn-outline btn-sm w-full" disabled={busy} onClick={onLocal}>
          {t("这就是那台电脑 · 一键配对本机")}
        </button>
      )}
    </form>
  );
}

function PendingCard({ machineName, onCancel }: { machineName: string; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="space-y-3 text-center">
      <span className="loading loading-dots loading-md text-primary" />
      <div className="text-sm font-medium">
        {t("等待电脑确认")}
        {machineName ? ` · ${machineName}` : ""}
      </div>
      <div className="text-xs leading-relaxed text-base-content/60">{t("回到运行 claudestra pair 的终端（或电脑上的网页）确认这台设备。确认后这里会自动进入。")}</div>
      <button className="btn btn-ghost btn-sm" onClick={onCancel}>
        {t("取消")}
      </button>
    </div>
  );
}
