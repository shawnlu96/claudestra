"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStoreApi } from "../chat-store";
import { enablePush, disablePush, getPushSubscription } from "@/lib/push/client";
import { useT, useLang, setLang } from "@/lib/i18n";
import { MODEL_OPTIONS, EFFORT_OPTIONS } from "../claude-options";
import { useThemePref, setThemePref } from "@/lib/theme";
import { kbFixEnabled, setKbFixEnabled } from "../use-keyboard-viewport";
import { isNativeShell, nativeServerConfig } from "@/lib/native";
import { PeersModal } from "./peers-modal";
import { CronModal } from "./cron-modal";

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

/** 设置分区卡片(owner 2026-07-24「排版丑」→ iOS 分组式):统一「标题+右侧
 *  控件+说明+内容」结构,六个功能块同一版式。⚠ 必须定义在模块层——组件内
 *  定义每次渲染都是新类型,内部输入框会随重挂载丢焦点。 */
/**
 * TOTP 两步验证板块（登录安全第二期）。三态：未启用 → enroll（二维码+验码）
 * → 已启用。恢复码只在生成那一刻展示一次，用户必须自己存下来——这套系统没有
 * 第二个管理员能帮忙重置，认证器丢了没恢复码就是永久失联。
 */
function TotpSection() {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [enroll, setEnroll] = useState<{ secret: string; uri: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = () =>
    fetch("/api/auth/totp")
      .then((r) => r.json())
      .then((j: { enabled?: boolean; recoveryRemaining?: number }) => {
        setEnabled(!!j.enabled);
        setRemaining(j.recoveryRemaining ?? 0);
      })
      .catch(() => {});
  useEffect(() => { void refresh(); }, []);

  const post = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/auth/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) { setMsg(j.error || "操作失败"); return null; }
      return j;
    } catch {
      setMsg("网络错误");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const j = await post("begin");
    if (j) { setEnroll({ secret: j.secret, uri: j.uri, qrSvg: j.qrSvg }); setCode(""); }
  };
  const finish = async () => {
    const j = await post("complete", { code });
    if (j) { setEnroll(null); setCodes(j.recoveryCodes); await refresh(); }
  };
  const turnOff = async () => {
    if (!confirm(t("关闭两步验证？恢复码也会一并作废。"))) return;
    if (await post("disable")) { setCodes(null); await refresh(); }
  };
  const regen = async () => {
    const j = await post("regen");
    if (j) { setCodes(j.recoveryCodes); await refresh(); }
  };

  return (
    <Section
      title={t("登录安全 · 两步验证")}
      aside={
        enabled ? (
          <button className="btn btn-sm btn-ghost text-error" disabled={busy} onClick={() => void turnOff()}>
            {t("关闭")}
          </button>
        ) : enroll ? null : (
          <button className="btn btn-sm" disabled={busy} onClick={() => void start()}>
            {t("启用")}
          </button>
        )
      }
      desc={t("登录时除密码外再要一个认证器 App 的 6 位动态码。不启用则与现在完全一样。")}
    >
      {msg && <div className="mb-2 text-xs text-error">{t(msg)}</div>}

      {/* enroll 中：二维码 + 手输 secret + 验一次码 */}
      {enroll && (
        <div className="space-y-3">
          <div className="text-xs text-base-content/60">
            {t("用认证器 App（1Password / Authy / Google Authenticator 等）扫码，然后填入它显示的 6 位数字。")}
          </div>
          <div
            className="mx-auto w-40 rounded-lg bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: enroll.qrSvg }}
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-base-content/60">{t("扫不了？手动输入密钥")}</summary>
            <code className="mt-1 block break-all rounded bg-base-300/60 p-2 font-mono text-[11px]">
              {enroll.secret}
            </code>
          </details>
          <div className="flex gap-2">
            <input
              className="input input-bordered input-sm flex-1 font-mono tracking-widest"
              inputMode="numeric"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button className="btn btn-sm btn-primary" disabled={busy || code.length < 6} onClick={() => void finish()}>
              {t("验证并启用")}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setEnroll(null)}>
              {t("取消")}
            </button>
          </div>
        </div>
      )}

      {/* 恢复码：仅生成那一刻展示一次 */}
      {codes && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <div className="text-xs font-semibold text-warning">
            {t("⚠️ 恢复码只显示这一次，请立刻保存到密码管理器")}
          </div>
          <div className="grid grid-cols-2 gap-1 font-mono text-[12.5px]">
            {codes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <div className="flex gap-2">
            <button
              className="btn btn-xs"
              onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).then(() => setMsg("已复制"))}
            >
              {t("复制全部")}
            </button>
            <button className="btn btn-xs btn-ghost" onClick={() => setCodes(null)}>{t("我已保存")}</button>
          </div>
        </div>
      )}

      {enabled && !codes && (
        <div className="flex items-center justify-between text-xs text-base-content/60">
          <span>{t("已启用 · 剩余恢复码")} {remaining}</span>
          <button className="btn btn-xs btn-ghost" disabled={busy} onClick={() => void regen()}>
            {t("重新生成恢复码")}
          </button>
        </div>
      )}
    </Section>
  );
}

/**
 * Passkey 板块（登录安全第三期）。指纹/面容免密登录——三期里唯一不可钓鱼、
 * 不可爆破的因素，且体验是负成本（比打密码快）。
 *
 * ⚠️ rpID 约束：WebAuthn 凭据绑定域名且不可跨域。这套 web 有多个入口
 * （claude.sunstriker.cc / Tailscale MagicDNS / localhost），每个域要各注册
 * 一个；明文 IP 入口浏览器根本不给 API，此时 supported=false 不展示注册。
 */
function PasskeySection() {
  const t = useT();
  const [supported, setSupported] = useState(false);
  const [rpID, setRpID] = useState<string | null>(null);
  const [creds, setCreds] = useState<
    { id: string; name: string; rpID: string; createdAt: string; lastUsedAt: string | null; usableHere: boolean }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = () =>
    fetch("/api/auth/passkey")
      .then((r) => r.json())
      .then((j) => {
        setSupported(!!j.supported && typeof window !== "undefined" && !!window.PublicKeyCredential);
        setRpID(j.rpID ?? null);
        setCreds(j.credentials ?? []);
      })
      .catch(() => {});
  useEffect(() => { void refresh(); }, []);

  const register = async () => {
    setBusy(true);
    setMsg("");
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const b = await fetch("/api/auth/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "begin" }),
      });
      const bj = await b.json();
      if (!b.ok) { setMsg(bj.error || "无法开始注册"); return; }
      const att = await startRegistration({ optionsJSON: bj.options });
      // 默认名带上设备线索，多设备时能分清是哪台
      const guess = /iPhone|iPad/i.test(navigator.userAgent)
        ? "iPhone"
        : /Mac/i.test(navigator.userAgent) ? "Mac" : "这台设备";
      const f = await fetch("/api/auth/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finish", challengeId: bj.challengeId, response: att, name: guess }),
      });
      const fj = await f.json();
      if (!f.ok) { setMsg(fj.error || "注册失败"); return; }
      setMsg("已添加");
      await refresh();
    } catch (e) {
      const m = (e as Error).message || "";
      if (!/NotAllowed|abort/i.test(m)) setMsg(m || "注册失败"); // 用户取消不报错
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(t(`删除 Passkey「${name}」？该设备将无法再免密登录。`))) return;
    setBusy(true);
    await fetch("/api/auth/passkey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    }).catch(() => {});
    setBusy(false);
    await refresh();
  };

  return (
    <Section
      title={t("登录安全 · Passkey")}
      aside={
        supported ? (
          <button className="btn btn-sm" disabled={busy} onClick={() => void register()}>
            {t("添加")}
          </button>
        ) : null
      }
      desc={t("用指纹 / 面容代替密码登录。不可钓鱼、不可爆破，而且比打密码快。凭据绑定当前域名，换入口需各加一个。")}
    >
      {msg && <div className="mb-2 text-xs text-base-content/60">{t(msg)}</div>}
      {!supported && (
        <div className="text-xs text-base-content/50">
          {t("当前访问地址不支持 Passkey——需要 HTTPS 域名或 localhost（明文 IP 访问时浏览器不提供该能力）。")}
        </div>
      )}
      {creds.length > 0 && (
        <ul className="flex list-none flex-col gap-1.5 p-0">
          {creds.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-xs">
              <span className="truncate font-medium">{c.name}</span>
              <span className="truncate text-base-content/40">{c.rpID}</span>
              {!c.usableHere && (
                <span className="shrink-0 rounded bg-base-300 px-1.5 py-0.5 text-[10px] text-base-content/50">
                  {t("其它入口")}
                </span>
              )}
              <button
                className="btn btn-ghost btn-xs ml-auto text-error"
                disabled={busy}
                onClick={() => void remove(c.id, c.name)}
              >
                {t("删除")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {supported && creds.length === 0 && (
        <div className="text-xs text-base-content/50">
          {t("还没有 Passkey。点「添加」用本机指纹 / 面容注册一个")}
          {rpID ? `（${rpID}）` : ""}。
        </div>
      )}
    </Section>
  );
}

/** 设置分组标题(owner 2026-08-26「按 type 归类,不是 tab」):卡片流里的轻量组头。 */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-0.5 mt-4 px-1 text-[11px] font-semibold uppercase tracking-wider text-base-content/40 first:mt-0">
      {children}
    </div>
  );
}

/**
 * v2.21.3+ 原生壳的服务器地址(存在手机本机,不编进包——owner 2026-09-04 壳要分发给别人):
 * 显示当前地址 + 两步确认更换。独立组件:随设置面板打开而挂载,关掉即卸载,armed 态自然复位。
 */
function ShellServerSection() {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const cfg = nativeServerConfig();
    if (!cfg) return;
    let dead = false;
    cfg.get().then((u) => { if (!dead) setUrl(u); }).catch(() => {});
    return () => { dead = true; };
  }, []);
  return (
    <Section
      title={t("App 连接的服务器")}
      desc={url || t("(读取中…)")}
      aside={
        armed ? (
          <div className="join">
            <button
              className="btn btn-error btn-sm join-item"
              onClick={() => {
                // clear 后原生侧重建 WebView 回到首次设置页,这里不会再有回调
                void nativeServerConfig()?.clear();
              }}
            >
              {t("确认更换")}
            </button>
            <button className="btn btn-ghost btn-sm join-item border-base-300" onClick={() => setArmed(false)}>
              {t("取消")}
            </button>
          </div>
        ) : (
          <button className="btn btn-ghost btn-sm border-base-300" onClick={() => setArmed(true)}>
            {t("更换服务器")}
          </button>
        )
      }
    />
  );
}

function Section({
  title,
  aside,
  desc,
  children,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <span className="text-[13.5px] font-semibold">{title}</span>
        {aside}
      </div>
      {desc && <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">{desc}</p>}
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}


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
  // iOS 键盘修正实验开关(use-keyboard-viewport):挂载时读 localStorage
  const [kbFixOn, setKbFixOn] = useState(false);
  useEffect(() => setKbFixOn(kbFixEnabled()), []);
  const [pushMsg, setPushMsg] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  // HTTP peer 管理(owner 2026-07-24):独立弹窗
  const [showPeers, setShowPeers] = useState(false);
  // 定时任务管理(owner 2026-08-26):独立弹窗
  const [showCron, setShowCron] = useState(false);
  // 登录安全(owner 2026-08-09):累进封禁开关。TOTP 由 TotpSection 自管
  const [bruteForceOn, setBruteForceOn] = useState(true);
  const [secBusy, setSecBusy] = useState(false);
  // 记忆卫生(owner 2026-08-26):mem0 定期审查的开关+频率,事实源是 cron 任务
  const [hyg, setHyg] = useState<{
    exists: boolean;
    enabled: boolean;
    freq: string | null;
    schedule: string | null;
    lastRun: string | null;
    nextRun: string | null;
  } | null>(null);
  const [hygBusy, setHygBusy] = useState(false);
  const [hygMsg, setHygMsg] = useState("");
  // 自动存记忆+Compact(owner 2026-08-27「设置里看不到」):阈值+闲置门槛,写 config.json
  const [ac, setAc] = useState<{
    window: number | null;
    idleHours: number | null;
    /** v2.21.3+ 93% 救命线独立开关(常规线关了它也兜底) */
    emergency?: boolean;
    defaults: { window: number; idleHours: number; emergency?: boolean; emergencyRatio?: number };
  } | null>(null);
  const [acBusy, setAcBusy] = useState(false);
  const [acMsg, setAcMsg] = useState("");

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
    // 登录安全配置
    fetch("/api/auth/config")
      .then((r) => r.json())
      .then((j: { bruteForceOn?: boolean }) => {
        setBruteForceOn(j.bruteForceOn !== false);
      })
      .catch(() => {});
    // 记忆卫生状态
    setHygMsg("");
    fetch("/api/memory-hygiene")
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) setHyg(j);
        else setHygMsg(j?.error || "读取失败");
      })
      .catch(() => setHygMsg("读取失败"));
    // autoCompact 配置
    setAcMsg("");
    fetch("/api/auto-compact")
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) setAc(j);
        else setAcMsg(j?.error || "读取失败");
      })
      .catch(() => setAcMsg("读取失败"));
  }, [open, store]);

  // 记忆卫生写入:开关/频率共用一条路,bridge 侧同步 cron 任务
  const saveHyg = async (enabled: boolean, freq: string) => {
    setHygBusy(true);
    setHygMsg("");
    try {
      const r = await fetch("/api/memory-hygiene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, freq }),
      });
      const j = await r.json();
      if (j?.ok) setHyg(j);
      else setHygMsg(j?.error || "保存失败");
    } catch {
      setHygMsg("保存失败");
    } finally {
      setHygBusy(false);
    }
  };

  // autoCompact 写入:两个下拉共用一条路,POST 后用 bridge 回读的状态刷新
  const saveAc = async (patch: { window?: number; idleHours?: number; emergency?: boolean }) => {
    setAcBusy(true);
    setAcMsg("");
    try {
      const r = await fetch("/api/auto-compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (j?.ok) setAc(j);
      else setAcMsg(j?.error || "保存失败");
    } catch {
      setAcMsg("保存失败");
    } finally {
      setAcBusy(false);
    }
  };

  // 当前生效值(null=未设→用默认);选项表兜住手工改过的非标准值
  const acWindow = ac ? (ac.window ?? ac.defaults.window) : null;
  const acIdle = ac ? (ac.idleHours ?? ac.defaults.idleHours) : null;
  const acWindowOpts = [400_000, 500_000, 750_000, 1_000_000];
  if (acWindow !== null && acWindow !== 0 && !acWindowOpts.includes(acWindow)) {
    acWindowOpts.push(acWindow);
    acWindowOpts.sort((a, b) => a - b);
  }
  const acIdleOpts = [0, 1, 3, 6, 12];
  if (acIdle !== null && !acIdleOpts.includes(acIdle)) {
    acIdleOpts.push(acIdle);
    acIdleOpts.sort((a, b) => a - b);
  }
  const fmtTokens = (w: number) => (w >= 1_000_000 ? `${w / 1_000_000}M` : `${Math.round(w / 1000)}K`);

  const toggleBruteForce = async () => {
    const next = !bruteForceOn;
    setSecBusy(true);
    setBruteForceOn(next); // 乐观
    try {
      const r = await fetch("/api/auth/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bruteForceOn: next }),
      });
      if (!r.ok) setBruteForceOn(!next); // 回滚
    } catch {
      setBruteForceOn(!next);
    } finally {
      setSecBusy(false);
    }
  };

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
        className="panel-pop flex max-h-[88dvh] w-full max-w-md flex-col rounded-2xl bg-base-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <span className="text-base font-semibold">{t("设置")}</span>
          <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-5 pt-1">{/* 分区卡片流 */}

        <GroupLabel>{t("界面与个人")}</GroupLabel>
        {/* ── 原生壳:服务器地址(只在 iOS App 里出现;地址存本机,可换)─────────────── */}
        {isNativeShell() && open && <ShellServerSection />}
        {/* ── 界面(外观 + 语言)─────────────── */}
        <Section
          title={t("外观")}
          aside={
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
          }
        />
        <Section
          title="语言 / Language"
          aside={
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
          }
        />

        {/* ── 个人资料（我的 + Claude 的）─────────────── */}
        <Section
          title={t("个人资料")}
          desc={t("头像和昵称显示在对话里（只影响本界面展示,不进对话数据）。")}
        >
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
        <div className="mt-3 flex items-center justify-end gap-2.5">
          {profileMsg && <span className="text-xs text-base-content/60">{t(profileMsg)}</span>}
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveProfile()}>
            {t("保存资料")}
          </button>
        </div>
        </Section>

        <GroupLabel>{t("Claude")}</GroupLabel>
        {/* ── Claude 全局默认（模型 + Effort）─────────────── */}
        <Section
          title={t("Claude 全局默认")}
          desc={t("影响所有未单独钉模型/effort 的新会话（含终端里直接开的 claude）。已钉的 agent 不受影响。")}
        >
        <div className="grid grid-cols-2 gap-3">
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
        {gMsg && <div className="mt-2 text-xs text-base-content/60">{t(gMsg)}</div>}
        </Section>

        <GroupLabel>{t("通知")}</GroupLabel>
        {/* ── Web Push 推送(本设备)─────────────── */}
        <Section
          title={t("推送通知")}
          aside={
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={pushOn}
              disabled={pushBusy}
              onChange={() => void togglePush()}
            />
          }
          desc={t("Web 端发起的对话有回复时,推送到本设备(页面开着时不打扰)。Discord 发起的照旧走 Discord @。")}
        >
          {pushMsg ? <div className="text-xs text-base-content/60">{t(pushMsg)}</div> : null}
        </Section>

        <GroupLabel>{t("自动化")}</GroupLabel>
        <Section
          title={t("定时任务")}
          aside={
            <button className="btn btn-sm" onClick={() => setShowCron(true)}>
              {t("管理")}
            </button>
          }
          desc={t("到点起临时 agent 执行指令。查看/新建/原地编辑频率与指令/停用。")}
        />

        {/* ── 记忆卫生(owner 2026-08-26:「mem0 会变粪坑」) ─────────────── */}
        <Section
          title={t("记忆卫生（mem0）")}
          aside={
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={!!hyg?.enabled}
              disabled={hygBusy || !hyg}
              onChange={() => void saveHyg(!hyg?.enabled, hyg?.freq && hyg.freq !== "custom" ? hyg.freq : "weekly")}
            />
          }
          desc={t("定期审查 mem0 记忆库:找出过时/矛盾/重复的记忆,出报告供处置——只报告不动手。")}
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              {t("频率")}
              <select
                className="select select-sm select-bordered"
                value={hyg?.freq && hyg.freq !== "custom" ? hyg.freq : "weekly"}
                disabled={hygBusy || !hyg?.enabled}
                onChange={(e) => void saveHyg(true, e.target.value)}
              >
                <option value="weekly">{t("每周（周一）")}</option>
                <option value="biweekly">{t("半月（1/15 号）")}</option>
                <option value="monthly">{t("每月（1 号）")}</option>
              </select>
            </label>
            {hyg?.freq === "custom" && hyg.schedule && (
              <span className="text-xs text-base-content/50">
                {t("当前为手工表达式")} <code>{hyg.schedule}</code>
              </span>
            )}
          </div>
          {hyg?.enabled && (hyg.lastRun || hyg.nextRun) && (
            <div className="mt-2 text-xs text-base-content/50">
              {hyg.lastRun ? `${t("上次")} ${new Date(hyg.lastRun).toLocaleString()} · ` : ""}
              {hyg.nextRun ? `${t("下次")} ${new Date(hyg.nextRun).toLocaleString()}` : ""}
            </div>
          )}
          {hygMsg && <div className="mt-2 text-xs text-error/80">{t(hygMsg)}</div>}
        </Section>

        {/* ── 自动存记忆+Compact(owner 2026-08-27:「设置里看不到」) ─────────────── */}
        <Section
          title={t("自动存记忆 + Compact")}
          desc={t("常规线:上下文超过阈值且闲置满时长后,先抢救记忆再压缩上下文,对所有 agent 生效;实际触发线取「此阈值」与「该 agent 真实窗口 85%」的较小者。救命线:涨到真实窗口 93%(1M = 930K)时无视闲置门槛强制触发一次——Claude Code 自己在 ~967K 裸压且不存记忆,这是最后一道兜底,常规线关了它也在。")}
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              {t("上下文阈值")}
              <select
                className="select select-sm select-bordered"
                value={acWindow === null ? "" : String(acWindow)}
                disabled={acBusy || !ac}
                onChange={(e) => void saveAc({ window: Number(e.target.value) })}
              >
                {acWindowOpts.map((w) => (
                  <option key={w} value={String(w)}>
                    {fmtTokens(w)}
                    {ac && w === ac.defaults.window ? ` (${t("默认")})` : ""}
                  </option>
                ))}
                <option value="0">{t("关闭")}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              {t("闲置时长")}
              <select
                className="select select-sm select-bordered"
                value={acIdle === null ? "" : String(acIdle)}
                disabled={acBusy || !ac || acWindow === 0}
                onChange={(e) => void saveAc({ idleHours: Number(e.target.value) })}
              >
                {acIdleOpts.map((h) => (
                  <option key={h} value={String(h)}>
                    {h === 0 ? t("立即") : `${h} ${t("小时")}`}
                    {ac && h === ac.defaults.idleHours ? ` (${t("默认")})` : ""}
                  </option>
                ))}
              </select>
            </label>
            {/* 救命线独立于常规线:window=0 时也可用(这正是它存在的意义) */}
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-error"
                checked={ac?.emergency !== false}
                disabled={acBusy || !ac}
                onChange={(e) => void saveAc({ emergency: e.target.checked })}
              />
              {t("93% 救命线")}
            </label>
          </div>
          {acMsg && <div className="mt-2 text-xs text-error/80">{t(acMsg)}</div>}
        </Section>

        <GroupLabel>{t("安全")}</GroupLabel>
        {/* ── 登录安全(owner 2026-08-09) ─────────────── */}
        <Section
          title={t("登录安全 · 失败封禁")}
          aside={
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={bruteForceOn}
              disabled={secBusy}
              onChange={() => void toggleBruteForce()}
            />
          }
          desc={t("连续登录失败越多，锁定越久（5次→1分钟，逐级升到60分钟），登录成功即清零。防密码爆破/喷洒。默认开启，不影响正常登录。")}
        />

        {/* ── 登录安全 · 两步验证(第二期) ─────────────── */}
        <TotpSection />

        {/* ── 登录安全 · Passkey(第三期) ─────────────── */}
        <PasskeySection />

        <GroupLabel>{t("连接与集成")}</GroupLabel>
        {/* ── HTTP peer 协作 ─────────────── */}
        <Section
          title={t("Peer 协作")}
          aside={
            <button className="btn btn-sm" onClick={() => setShowPeers(true)}>
              {t("管理")}
            </button>
          }
          desc={t("跨 Claudestra 实例互访：查看/编辑对方的访问权限、测试连通、完成握手。")}
        />

        {/* ── 语音识别 Key ─────────────── */}
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
        <GroupLabel>{t("实验")}</GroupLabel>
        {/* ── iOS 键盘修正(实验,2026-07-27 重构) ─────────────── */}
        <Section
          title={t("iOS 键盘修正（实验）")}
          aside={
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={kbFixOn}
              onChange={() => {
                setKbFixEnabled(!kbFixOn);
                setKbFixOn(!kbFixOn);
                // 钩子在页面挂载时读开关——刷新生效,PWA 里 reload 即可
                window.location.reload();
              }}
            />
          }
          desc={t("Telegram 式文档流布局：修正 iOS 弹键盘时输入光标/附件菜单错位。有任何异常关掉即恢复原布局。")}
        />

        </div>
      </div>
      <PeersModal open={showPeers} onClose={() => setShowPeers(false)} />
      <CronModal open={showCron} onClose={() => setShowCron(false)} />
    </div>,
    document.body
  );
}
