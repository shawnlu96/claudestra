"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStoreApi } from "../chat-store";
import { enablePush, disablePush, getPushSubscription } from "@/lib/push/client";
import { useT, useLang, setLang } from "@/lib/i18n";
import { MODEL_OPTIONS, EFFORT_OPTIONS } from "../claude-options";
import { useThemePref, setThemePref } from "@/lib/theme";

/** 选中的图片 → 128×128 居中裁剪 jpeg data URL（~10-20KB,存库直出）。 */
async function fileToAvatar(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.max(size / bmp.width, size / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** 一行「头像选择器 + 昵称输入」——我的资料与 Claude 的资料共用。 */
function AvatarNickRow({
  label,
  fallback,
  avatar,
  nick,
  nickPlaceholder,
  onAvatar,
  onNick,
  onError,
}: {
  label: string;
  fallback: string;
  avatar: string;
  nick: string;
  nickPlaceholder: string;
  onAvatar: (v: string) => void;
  onNick: (v: string) => void;
  onError: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();
  return (
    <div className="mb-2.5 flex items-center gap-3">
      <span className="w-12 shrink-0 text-xs text-base-content/50">{label}</span>
      <button
        className="group relative size-11 shrink-0 overflow-hidden rounded-full border border-base-300 bg-base-200"
        title={t("选择头像(再点一次图可移除)")}
        onClick={() => {
          if (avatar) onAvatar("");
          else fileRef.current?.click();
        }}
      >
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-base opacity-40">{fallback}</span>
        )}
        <span className="absolute inset-0 grid place-items-center bg-black/40 text-[9px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {avatar ? t("移除") : t("选图")}
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          fileToAvatar(f).then(onAvatar).catch(onError);
          e.target.value = "";
        }}
      />
      <input
        type="text"
        value={nick}
        onChange={(e) => onNick(e.target.value)}
        placeholder={nickPlaceholder}
        maxLength={32}
        autoComplete="off"
        className="input input-bordered input-sm w-full text-sm"
      />
    </div>
  );
}

/** 全局默认模型/effort 选项——与会话级切换器共用（claude-options.ts） */
const GLOBAL_MODEL_OPTIONS = MODEL_OPTIONS;
const GLOBAL_EFFORT_OPTIONS = EFFORT_OPTIONS;


/**
 * 全局设置弹窗（侧栏 ⚙️ 进入）：个人资料（我的 + Claude 的头像/昵称,
 * owner 2026-07-14）+ Claude 全局默认(模型/effort,owner 2026-07-16)
 * + 语音识别的 Groq API Key。portal 到 body（规则 5.5）。
 * 完整 key 永不回显——已配置时展示尾四位提示。
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useChatStoreApi();
  const t = useT();
  const lang = useLang();
  const themePref = useThemePref();
  const [keyInput, setKeyInput] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // 个人资料草稿（打开时从 store 取当前值,保存才写回）:我的 + Claude 的
  const [nick, setNick] = useState("");
  const [avatar, setAvatar] = useState("");
  const [cNick, setCNick] = useState("");
  const [cAvatar, setCAvatar] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  // Claude 全局默认(直读写 ~/.claude/settings.json,经 bridge)
  const [gModel, setGModel] = useState("");
  const [gEffort, setGEffort] = useState("");
  const [gLoaded, setGLoaded] = useState(false);
  const [gMsg, setGMsg] = useState("");
  // Web Push(owner 2026-07-16):本设备订阅状态
  const [pushOn, setPushOn] = useState(false);
  const [pushMsg, setPushMsg] = useState("");
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKeyInput("");
    setMsg("");
    setProfileMsg("");
    setGMsg("");
    setGLoaded(false);
    const p = store.state.profile;
    setNick(p.nickname);
    setAvatar(p.avatar);
    setCNick(p.claudeNickname);
    setCAvatar(p.claudeAvatar);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j: { groqApiKeySet?: boolean; groqApiKeyHint?: string }) => {
        setHint(j.groqApiKeySet ? j.groqApiKeyHint || "已配置" : "");
      })
      .catch(() => {});
    fetch("/api/settings/claude-defaults")
      .then((r) => r.json())
      .then((j: { data?: { model: string | null; effort: string | null } }) => {
        if (j.data) {
          setGModel(j.data.model || "");
          setGEffort(j.data.effort || "");
          setGLoaded(true);
        }
      })
      .catch(() => setGMsg("读取失败"));
    // 本设备是否已订阅推送(看本地 pushManager,与服务端表无关——多设备各自管各自)
    setPushMsg("");
    void getPushSubscription().then((sub) => setPushOn(!!sub));
  }, [open, store]);

  const togglePush = async () => {
    setPushBusy(true);
    setPushMsg("");
    const r = pushOn ? await disablePush() : await enablePush();
    if (r.ok) setPushOn(!pushOn);
    setPushMsg(r.msg);
    setPushBusy(false);
  };

  if (!open) return null;

  const saveProfile = async () => {
    setBusy(true);
    setProfileMsg("");
    const ok = await store.saveProfile({
      nickname: nick.trim(),
      avatar,
      claudeNickname: cNick.trim(),
      claudeAvatar: cAvatar,
    });
    setProfileMsg(ok ? "已保存" : "保存失败");
    setBusy(false);
  };

  const saveGlobalDefault = async (patch: { model?: string; effort?: string }) => {
    setGMsg("保存中…");
    try {
      const res = await fetch("/api/settings/claude-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = (await res.json()) as { data?: { model: string | null; effort: string | null }; error?: string };
      if (res.ok && j.data) {
        setGModel(j.data.model || "");
        setGEffort(j.data.effort || "");
        setGMsg("已保存");
      } else {
        setGMsg(j.error || "保存失败");
      }
    } catch {
      setGMsg("保存失败");
    }
  };

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

  return createPortal(
    <div className="overlay-in fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="panel-pop w-full max-w-md rounded-2xl bg-base-100 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-base font-semibold">{t("设置")}</span>
          <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* ── 外观(明暗主题,owner 2026-07-24)─────────────── */}
        <div className="mb-5 flex items-center justify-between gap-3">
          <label className="text-sm font-medium">{t("外观")}</label>
          <div className="join">
            {(
              [
                ["auto", t("跟随系统")],
                ["light", t("浅色")],
                ["dark", t("深色")],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                className={`btn btn-sm join-item ${themePref === v ? "btn-primary" : "btn-ghost border-base-300"}`}
                onClick={() => setThemePref(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ── 语言 / Language ─────────────── */}
        <div className="mb-5 flex items-center justify-between gap-3">
          <label className="text-sm font-medium">语言 / Language</label>
          <div className="join">
            <button
              className={`btn btn-sm join-item ${lang === "zh" ? "btn-primary" : "btn-ghost border-base-300"}`}
              onClick={() => setLang("zh")}
            >
              中文
            </button>
            <button
              className={`btn btn-sm join-item ${lang === "en" ? "btn-primary" : "btn-ghost border-base-300"}`}
              onClick={() => setLang("en")}
            >
              English
            </button>
          </div>
        </div>

        {/* ── 个人资料（我的 + Claude 的）─────────────── */}
        <label className="mb-1.5 block text-sm font-medium">{t("个人资料")}</label>
        <p className="mb-2 text-xs text-base-content/50">
          {t("头像和昵称显示在对话里（只影响本界面展示,不进对话数据）。")}
        </p>
        <AvatarNickRow
          label={t("我")}
          fallback="👤"
          avatar={avatar}
          nick={nick}
          nickPlaceholder={t("你的昵称")}
          onAvatar={setAvatar}
          onNick={setNick}
          onError={() => setProfileMsg("图片读取失败")}
        />
        <AvatarNickRow
          label="Claude"
          fallback="✦"
          avatar={cAvatar}
          nick={cNick}
          nickPlaceholder={t("Claude 的名称")}
          onAvatar={setCAvatar}
          onNick={setCNick}
          onError={() => setProfileMsg("图片读取失败")}
        />
        <div className="mb-5 flex items-center gap-2">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveProfile()}>
            {t("保存资料")}
          </button>
          {profileMsg && <span className="text-xs text-base-content/60">{t(profileMsg)}</span>}
        </div>

        {/* ── Claude 全局默认（模型 + Effort）─────────────── */}
        <label className="mb-1.5 block text-sm font-medium">{t("Claude 全局默认")}</label>
        <p className="mb-2 text-xs text-base-content/50">
          {t("影响所有未单独钉模型/effort 的新会话（含终端里直接开的 claude）。已钉的 agent 不受影响。")}
        </p>
        <div className="mb-1 grid grid-cols-2 gap-3">
          <label className="form-control">
            <span className="label-text mb-1 text-xs text-base-content/60">{t("模型")}</span>
            <select
              className="select select-bordered select-sm w-full"
              value={gModel}
              disabled={!gLoaded}
              onChange={(e) => {
                setGModel(e.target.value);
                void saveGlobalDefault({ model: e.target.value });
              }}
            >
              {gModel !== "" && !GLOBAL_MODEL_OPTIONS.some((o) => o.value === gModel) && (
                <option value={gModel}>{gModel}</option>
              )}
              {gModel === "" && <option value="">{t("未设置")}</option>}
              {GLOBAL_MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-xs text-base-content/60">Effort</span>
            <select
              className="select select-bordered select-sm w-full"
              value={gEffort}
              disabled={!gLoaded}
              onChange={(e) => {
                setGEffort(e.target.value);
                void saveGlobalDefault({ effort: e.target.value });
              }}
            >
              {gEffort !== "" && !GLOBAL_EFFORT_OPTIONS.includes(gEffort as (typeof GLOBAL_EFFORT_OPTIONS)[number]) && (
                <option value={gEffort}>{gEffort}</option>
              )}
              {gEffort === "" && <option value="">{t("未设置")}</option>}
              {GLOBAL_EFFORT_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mb-5 min-h-4 text-xs text-base-content/60">{t(gMsg)}</div>

        {/* ── Web Push 推送(本设备)─────────────── */}
        <label className="mb-1.5 block text-sm font-medium">{t("推送通知")}</label>
        <div className="mb-1 flex items-center justify-between gap-3">
          <p className="text-xs text-base-content/50">
            {t("Web 端发起的对话有回复时,推送到本设备(页面开着时不打扰)。Discord 发起的照旧走 Discord @。")}
          </p>
          <input
            type="checkbox"
            className="toggle toggle-sm shrink-0"
            checked={pushOn}
            disabled={pushBusy}
            onChange={() => void togglePush()}
          />
        </div>
        <div className="mb-5 min-h-4 text-xs text-base-content/60">{t(pushMsg)}</div>

        <label className="mb-1.5 block text-sm font-medium">
          {t("语音识别 · Groq API Key")}
        </label>
        <p className="mb-2 text-xs text-base-content/50">
          {hint ? `${t("当前:")}${t(hint)}${t("（输入新值覆盖）")}` : t("未配置。console.groq.com 免费注册,API Keys 页生成。")}
        </p>
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="gsk_…"
          autoComplete="off"
          className="input input-bordered w-full text-sm"
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !keyInput.trim()}
            onClick={() => save(keyInput.trim())}
          >
            {t("保存")}
          </button>
          {hint && (
            <button className="btn btn-ghost btn-sm text-error/80" disabled={busy} onClick={() => save("")}>
              {t("清除")}
            </button>
          )}
          {msg && <span className="text-xs text-base-content/60">{t(msg)}</span>}
        </div>
      </div>
    </div>,
    document.body
  );
}
