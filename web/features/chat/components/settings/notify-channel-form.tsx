"use client";
import { useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { NOTIFY_TYPES, testNotify, type NotifyChannelView, type NotifyChannelWire, type NotifyKind, type NotifyResult, type NotifyType } from "@/lib/api/notify";

/**
 * 一个通知渠道的编辑表单（设置 · 连接与集成 · 通知，notify-section.tsx 用）。密钥输入框留空 = 沿用已保存的（bridge 只给了尾四位），
 * 可选密钥（ntfy token、Webhook 签名密钥）另有「清除」。「发测试通知」测的是表单里的草稿，不用先保存。
 * 字段小组件定义在模块层：定义在组件里每次渲染都是新类型，输入框会丢焦点（同 section.tsx 的提醒）。
 */
export const TYPE_LABEL: Record<NotifyType, string> = { ask: "待你处理", security: "安全提醒", system: "系统提醒", talk: "Talk 里 @ 你" };
const TYPE_DESC: Record<NotifyType, string> = { ask: "", security: "新设备配对", system: "订阅额度、状态文件", talk: "" };
export const KIND_LABEL: Record<NotifyKind, string> = { ntfy: "ntfy", bark: "Bark", webhook: "Webhook" };
const HELP: Record<NotifyKind, string> = {
  ntfy: "在 ntfy App 里订阅同一个 topic。用公共服务器 ntfy.sh 时 topic 就是口令，知道名字的人都能收到：用随机生成的长名字，或自建服务器加 token。",
  bark: "Bark App 首页的地址形如 https://api.day.app/XXXX/…，XXXX 就是 Device Key。",
  webhook: "每条通知向这个地址 POST 一段 JSON。填了签名密钥会带 X-Claudestra-Signature 头：HMAC-SHA256(密钥, \"时间戳.请求体\")。",
};
/** 不用 type="password"：浏览器会把设置页当登录表单乱填（同 groq-key-section.tsx），遮挡改由 text-security 做 */
const SECRET_STYLE = { WebkitTextSecurity: "disc" } as CSSProperties;
const INPUT = "input input-bordered input-sm w-full text-sm";
const randomTopic = () => `cstra-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("")}`;

type SecretKey = "token" | "deviceKey" | "url" | "secret";
interface Draft {
  view: NotifyChannelView;
  server: string;
  topic: string;
  /** 密钥：空 = 沿用；cleared 里的字段回传空串 = 清除 */
  secrets: Record<SecretKey, string>;
  cleared: SecretKey[];
}

export function newChannel(kind: NotifyKind): NotifyChannelView {
  return { id: "", kind, name: KIND_LABEL[kind], enabled: true, types: ["ask", "security", "system"], onlyWhenAway: true, hideContent: false };
}

function draftOf(v: NotifyChannelView): Draft {
  const topic = v.topic ?? (v.kind === "ntfy" && !v.id ? randomTopic() : "");
  return { view: v, server: v.server ?? "", topic, secrets: { token: "", deviceKey: "", url: "", secret: "" }, cleared: [] };
}

function wireOf(d: Draft): NotifyChannelWire {
  const { id, kind, name, enabled, types, onlyWhenAway, hideContent } = d.view;
  const w: NotifyChannelWire = { ...(id ? { id } : {}), kind, name, enabled, types, onlyWhenAway, hideContent };
  if (kind !== "webhook") w.server = d.server.trim();
  if (kind === "ntfy") w.topic = d.topic.trim();
  for (const k of ["token", "deviceKey", "url", "secret"] as const) {
    const v = d.secrets[k].trim();
    if (v) w[k] = v;
    else if (d.cleared.includes(k)) w[k] = "";
  }
  return w;
}

export function resultText(r: NotifyResult | undefined, t: ReturnType<typeof useT>, ago: (ts: number) => string): string {
  if (!r) return t("还没发过");
  return r.ok ? `✓ ${ago(r.at)}` : `✗ ${r.error === "rate_limited" ? t("太频繁，跳过") : (r.error ?? `HTTP ${r.status}`)} · ${ago(r.at)}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const t = useT();
  return (
    <label className="block">
      <span className="text-xs text-base-content/60">{t(label)}</span>
      <div className="mt-1 flex items-center gap-2">{children}</div>
    </label>
  );
}

/** 密钥输入：已保存的显示尾四位提示，留空沿用；clearable 的多一个「清除」 */
function SecretField(p: { label: string; value: string; onChange: (s: string) => void; savedHint?: string; cleared: boolean; placeholder: string; onClear?: () => void }) {
  const t = useT();
  const saved = p.savedHint && !p.cleared;
  return (
    <Field label={p.label}>
      <input
        type="text" autoComplete="off" spellCheck={false} style={SECRET_STYLE} className={INPUT} value={p.value} onChange={(e) => p.onChange(e.target.value)}
        placeholder={saved ? `${t("已保存")} ${p.savedHint}${t("（留空沿用）")}` : p.placeholder}
      />
      {saved && p.onClear && (
        <button type="button" className="btn btn-ghost btn-xs" onClick={p.onClear}>{t("清除")}</button>
      )}
    </Field>
  );
}

function ToggleRow({ label, desc, on, set }: { label: string; desc: string; on: boolean; set: (b: boolean) => void }) {
  const t = useT();
  return (
    <label className="flex items-start justify-between gap-3">
      <span>
        <span className="text-sm">{t(label)}</span>
        <span className="block text-xs text-base-content/50">{t(desc)}</span>
      </span>
      <input type="checkbox" className="toggle toggle-sm toggle-primary mt-0.5" checked={on} onChange={(e) => set(e.target.checked)} />
    </label>
  );
}

/** 按渠道类型不同的那几格：服务器 / topic / 密钥 */
function KindFields({ d, setD }: { d: Draft; setD: (f: (x: Draft) => Draft) => void }) {
  const t = useT();
  const v = d.view;
  const secret = (k: SecretKey, label: string, hint: string | undefined, placeholder: string, clearable = false) => (
    <SecretField
      label={label} value={d.secrets[k]} savedHint={hint} cleared={d.cleared.includes(k)} placeholder={placeholder}
      onChange={(s) => setD((x) => ({ ...x, secrets: { ...x.secrets, [k]: s } }))}
      onClear={clearable ? () => setD((x) => ({ ...x, cleared: [...x.cleared, k] })) : undefined}
    />
  );
  const server = (placeholder: string) => (
    <Field label="服务器">
      <input className={INPUT} value={d.server} spellCheck={false} placeholder={placeholder} onChange={(e) => setD((x) => ({ ...x, server: e.target.value }))} />
    </Field>
  );
  if (v.kind === "ntfy") {
    return (
      <>
        {server("https://ntfy.sh")}
        <Field label="Topic">
          <input className={INPUT} value={d.topic} spellCheck={false} placeholder="cstra-…" onChange={(e) => setD((x) => ({ ...x, topic: e.target.value }))} />
          <button type="button" className="btn btn-ghost btn-xs shrink-0" onClick={() => setD((x) => ({ ...x, topic: randomTopic() }))}>{t("随机生成")}</button>
        </Field>
        {secret("token", "访问令牌（可选）", v.tokenSet ? v.tokenHint : undefined, "tk_…", true)}
      </>
    );
  }
  if (v.kind === "bark") {
    return (
      <>
        {server("https://api.day.app")}
        {secret("deviceKey", "Device Key", v.deviceKeySet ? v.deviceKeyHint : undefined, "XXXXXXXXXXXXXXXXXXXXXX")}
      </>
    );
  }
  return (
    <>
      {secret("url", "地址", v.urlSet ? v.urlHint : undefined, "https://example.com/hook")}
      {secret("secret", "签名密钥（可选）", v.secretSet ? v.secretHint : undefined, t("留空则不签名"), true)}
    </>
  );
}

function TypePicker({ types, set }: { types: NotifyType[]; set: (x: NotifyType[]) => void }) {
  const t = useT();
  return (
    <div>
      <span className="text-xs text-base-content/60">{t("推送哪些")}</span>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
        {NOTIFY_TYPES.map((ty) => (
          <label key={ty} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" className="checkbox checkbox-sm" checked={types.includes(ty)} onChange={() => set(types.includes(ty) ? types.filter((x) => x !== ty) : [...types, ty])} />
            {t(TYPE_LABEL[ty])}
            {TYPE_DESC[ty] && <span className="text-xs text-base-content/40">{t(TYPE_DESC[ty])}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

export function NotifyChannelForm(props: { initial: NotifyChannelView; busy: boolean; onSave: (w: NotifyChannelWire) => void; onDelete?: () => void; onCancel: () => void }) {
  const t = useT();
  const [d, setD] = useState(() => draftOf(props.initial));
  const [testMsg, setTestMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const v = d.view;
  const patch = (p: Partial<NotifyChannelView>) => setD((x) => ({ ...x, view: { ...x.view, ...p } }));
  const test = async () => {
    setTesting(true);
    setTestMsg("");
    try {
      const r = await testNotify({ channel: wireOf(d) });
      setTestMsg(r.ok ? t("已发出，去手机上看看") : `${t("没发出去：")}${r.error ?? `HTTP ${r.status}`}`);
    } catch (e) {
      setTestMsg((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-base-300 bg-base-100 p-3">
      <Field label="名称">
        <input className={INPUT} value={v.name} placeholder={KIND_LABEL[v.kind]} onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      <KindFields d={d} setD={setD} />
      <p className="text-xs leading-relaxed text-base-content/50">{t(HELP[v.kind])}</p>
      <TypePicker types={v.types} set={(types) => patch({ types })} />
      <ToggleRow label="只在我离开时推" desc="待你处理、Talk @：你正在用网页时不推；安全与系统提醒照推" on={v.onlyWhenAway} set={(b) => patch({ onlyWhenAway: b })} />
      <ToggleRow label="不带正文" desc="只推「Claudestra · 类型」，谁发的、标题、内容都不出这台电脑" on={v.hideContent} set={(b) => patch({ hideContent: b })} />
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {testMsg && <span className="mr-auto text-xs text-base-content/60">{testMsg}</span>}
        {props.onDelete && (
          <button type="button" className="btn btn-ghost btn-sm text-error-soft-80" disabled={props.busy} onClick={props.onDelete}>{t("删除")}</button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" disabled={props.busy} onClick={props.onCancel}>{t("取消")}</button>
        <button type="button" className="btn btn-sm" disabled={props.busy || testing} onClick={test}>{testing ? t("发送中…") : t("发测试通知")}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={props.busy || !v.types.length} onClick={() => props.onSave(wireOf(d))}>{t("保存")}</button>
      </div>
    </div>
  );
}
