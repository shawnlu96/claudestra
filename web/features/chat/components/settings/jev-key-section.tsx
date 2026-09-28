"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import type { SharedBusy } from "./profile-section";
import { Section } from "./section";
import { getSettings, jevTest, putSettings, type JevTestResult } from "@/lib/api/settings";

/**
 * Jev（TypeSafe System One）的 API Key（owner 2026-09-28）。与 Groq 同款：完整 key 永不回显，已配置时展示尾四位；
 * 多一个「测试连接」——bridge 用固定英文样例打一次 Jev，回模型 / 耗时 / 三个答案，答案合理才标「通顺」。
 * key 只在 bridge（config.json），前端只见提示。
 */
export function useJevKey(open: boolean, { setBusy }: SharedBusy) {
  const [keyInput, setKeyInput] = useState("");
  const [hint, setHint] = useState("");
  const [msg, setMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<JevTestResult | { error: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setKeyInput("");
    setMsg("");
    setTest(null);
    getSettings()
      .then((j) => setHint(j.jevApiKeySet ? j.jevApiKeyHint || "已配置" : ""))
      .catch(() => {} /* 读不到设置就按未配置显示；保存 / 测试时会再报真实错误 */);
  }, [open]);

  const save = async (value: string) => {
    setBusy(true);
    setMsg("");
    setTest(null);
    try {
      const j = await putSettings({ jevApiKey: value });
      setHint(j.jevApiKeyHint || "");
      setKeyInput("");
      setMsg(value ? "已保存，Jev 调用即时生效" : "已清除");
    } catch (e) {
      setMsg((e as Error).message || "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await jevTest());
    } catch (e) {
      setTest({ error: (e as Error).message || "测试失败" });
    } finally {
      setTesting(false);
    }
  };
  return { keyInput, setKeyInput, hint, msg, save, testing, test, runTest };
}

function TestResult({ r }: { r: JevTestResult | { error: string } }) {
  const t = useT();
  if ("error" in r) return <div className="mt-2 rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{r.error}</div>;
  const a = r.answers;
  const fmt = (n: number | undefined) => (typeof n === "number" ? n.toFixed(2) : "—");
  return (
    <div className={`mt-2 rounded-lg px-3 py-2 text-xs ${r.plausible ? "bg-success/10 text-base-content/80" : "bg-warning/10 text-base-content/80"}`}>
      <div className="font-medium">{r.plausible ? `✓ ${t("Jev 连通，结果通顺")}` : `⚠ ${t("Jev 连通，但结果可疑（请检查 key 与模型）")}`}</div>
      <div className="mt-1 font-mono text-[11px] text-base-content/60">
        {t("模型")} {r.model} · {t("耗时")} {r.latencyMs} ms · {r.usage.input_tokens} tok · ${r.costUsd.toFixed(6)}
      </div>
      <div className="mt-1 font-mono text-[11px] text-base-content/60">
        is_urgent {fmt(a.is_urgent?.noul)} · category {a.category?.choice ?? "—"} ({fmt(a.category?.confidence)}) · frustration {fmt(a.frustration?.score)}
      </div>
    </div>
  );
}

export function JevKeySection({ jev, busy }: { jev: ReturnType<typeof useJevKey>; busy: boolean }) {
  const t = useT();
  const { keyInput, setKeyInput, hint, msg, save, testing, test, runTest } = jev;
  return (
    <Section
      title={t("Jev · TypeSafe API Key")}
      desc={
        hint
          ? `${t("当前:")}${t(hint)}${t("（输入新值覆盖）")}`
          : t("未配置。到 console.typesafe.ai/keys 生成 key。Jev 是 TypeSafe 的 System One 判断模型。")
      }
    >
      <input
        type="password"
        value={keyInput}
        onChange={(e) => setKeyInput(e.target.value)}
        placeholder="ts_…"
        autoComplete="off"
        className="input input-bordered input-sm w-full text-sm"
      />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2.5">
        {msg && <span className="text-xs text-base-content/60">{t(msg)}</span>}
        <button className="btn btn-ghost btn-sm" disabled={busy || testing || !hint} title={hint ? "" : t("未配置 key，先保存再测试")} onClick={() => void runTest()}>
          {testing ? t("测试中…") : t("测试连接")}
        </button>
        {hint && (
          <button className="btn btn-ghost btn-sm text-error/80" disabled={busy} onClick={() => save("")}>
            {t("清除")}
          </button>
        )}
        <button className="btn btn-primary btn-sm" disabled={busy || !keyInput.trim()} onClick={() => save(keyInput.trim())}>
          {t("保存")}
        </button>
      </div>
      {test && <TestResult r={test} />}
    </Section>
  );
}
