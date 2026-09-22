"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import type { SharedBusy } from "./profile-section";
import { Section } from "./section";

/**
 * 语音识别的 Groq API Key。完整 key 永不回显——已配置时展示尾四位提示。
 * busy 与「保存资料」共用（见 SharedBusy）。
 */
export function useGroqKey(open: boolean, { setBusy }: SharedBusy) {
  const [keyInput, setKeyInput] = useState("");
  const [hint, setHint] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    setKeyInput("");
    setMsg("");
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j: { groqApiKeySet?: boolean; groqApiKeyHint?: string }) => {
        setHint(j.groqApiKeySet ? j.groqApiKeyHint || "已配置" : "");
      })
      .catch(() => {});
  }, [open]);

  const save = async (value: string) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groqApiKey: value }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string; groqApiKeyHint?: string };
      if (res.ok && j.ok) {
        setHint(j.groqApiKeyHint || "");
        setKeyInput("");
        setMsg(value ? "已保存,语音输入即时生效" : "已清除");
      } else {
        setMsg(j.error || "保存失败");
      }
    } catch {
      setMsg("保存失败");
    } finally {
      setBusy(false);
    }
  };

  return { keyInput, setKeyInput, hint, msg, save };
}

export function GroqKeySection({ groq, busy }: { groq: ReturnType<typeof useGroqKey>; busy: boolean }) {
  const t = useT();
  const { keyInput, setKeyInput, hint, msg, save } = groq;
  return (
        <Section
          title={t("语音识别 · Groq API Key")}
          desc={
            hint
              ? `${t("当前:")}${t(hint)}${t("（输入新值覆盖）")}`
              : t("未配置。console.groq.com 免费注册,API Keys 页生成。")
          }
        >
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="gsk_…"
            autoComplete="off"
            className="input input-bordered input-sm w-full text-sm"
          />
          <div className="mt-3 flex items-center justify-end gap-2.5">
            {msg && <span className="text-xs text-base-content/60">{t(msg)}</span>}
            {hint && (
              <button className="btn btn-ghost btn-sm text-error/80" disabled={busy} onClick={() => save("")}>
                {t("清除")}
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || !keyInput.trim()}
              onClick={() => save(keyInput.trim())}
            >
              {t("保存")}
            </button>
          </div>
        </Section>
  );
}
