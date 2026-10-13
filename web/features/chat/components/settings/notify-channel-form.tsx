"use client";
import { useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { NOTIFY_TYPES, testNotify, type NotifyChannelView, type NotifyChannelWire, type NotifyKind, type NotifyResult, type NotifyType } from "@/lib/api/notify";
import { CenteredModal } from "../centered-modal";
import { NotifyGuideModal } from "./notify-guide";

/**
 * 单个通知渠道的配置弹窗（设置 · 连接与集成 · 通知，notify-section.tsx 打开）：新加的先选类型再填，编辑的直接填。
 * 密钥输入框留空 = 沿用已保存的（bridge 只给了尾四位），可选密钥（ntfy token、Webhook 签名密钥）另有「清除」；
 * 「发测试通知」测的是表单里的草稿，不用先保存；「设置向导」叠一层讲怎么装 App / 接 Webhook（notify-guide.tsx）。
 * 字段小组件定义在模块层：定义在组件里每次渲染都是新类型，输入框会丢焦点（同 section.tsx 的提醒）。
 */
export const TYPE_LABEL: Record<NotifyType, string> = { ask: "待你处理", security: "安全提醒", system: "系统提醒", talk: "Talk 里 @ 你" };
const TYPE_DESC: Record<NotifyType, string> = { ask: "", security: "新设备配对", system: "订阅额度、状态文件", talk: "" };
export const KIND_LABEL: Record<NotifyKind, string> = { ntfy: "ntfy", bark: "Bark", webhook: "Webhook" };
const KIND_DESC: Record<NotifyKind, string> = {
  ntfy: "Android / iOS / 网页都能收，可用官方服务器或自建",
  bark: "仅 iPhone，App Store 装 Bark 即可",
  webhook: "POST 一段 JSON 到你的地址，自己接其它系统",
};
const KINDS: NotifyKind[] = ["ntfy", "bark", "webhook"];
const NTFY_HOME = "https://ntfy.sh";
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

function newChannel(kind: NotifyKind): NotifyChannelView {
  return { id: "", kind, name: KIND_LABEL[kind], enabled: true, types: ["ask", "security", "system"], onlyWhenAway: false, allAsks: true, hideContent: false };
}

function draftOf(v: NotifyChannelView): Draft {
  const topic = v.topic ?? (v.kind === "ntfy" && !v.id ? randomTopic() : "");
  return { view: v, server: v.server ?? "", topic, secrets: { token: "", deviceKey: "", url: "", secret: "" }, cleared: [] };
}

function wireOf(d: Draft): NotifyChannelWire {
  const { id, kind, name, enabled, types, onlyWhenAway, allAsks, hideContent } = d.view;
  const w: NotifyChannelWire = { ...(id ? { id } : {}), kind, name, enabled, types, onlyWhenAway, allAsks: allAsks !== false, hideContent };
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

function Field({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  const t = useT();
  return (
    <label className="block">
      <span className="text-xs text-base-content/60">{t(label)}</span>
      <div className="mt-1 flex items-center gap-2">{children}</div>
      {note}
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

/** 自建 ntfy：iPhone 要即时收到，服务器得把轮询转给 ntfy.sh（ntfy 文档 config.md「iOS instant notifications」） */
function NtfyServerNote({ server }: { server: string }) {
  const t = useT();
  const s = server.trim().replace(/\/+$/, "");
  if (!s || s === NTFY_HOME) return null;
  return (
    <span className="mt-1 block text-xs text-warning">
      {t("自建服务器：iPhone 上的 ntfy App 要即时收到，服务器需配")} <code>upstream-base-url: &quot;https://ntfy.sh&quot;</code>
      {t("，否则通知可能要几个小时才到。详见设置向导。")}
    </span>
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
  const server = (placeholder: string, note?: ReactNode) => (
    <Field label="服务器" note={note}>
      <input className={INPUT} value={d.server} spellCheck={false} placeholder={placeholder} onChange={(e) => setD((x) => ({ ...x, server: e.target.value }))} />
    </Field>
  );
  if (v.kind === "ntfy") {
    return (
      <>
        {server(NTFY_HOME, <NtfyServerNote server={d.server} />)}
        <Field label="Topic">
          <input className={INPUT} value={d.topic} spellCheck={false} placeholder="cstra-…" onChange={(e) => setD((x) => ({ ...x, topic: e.target.value }))} />
          <button type="button" className="btn btn-ghost btn-xs shrink-0" onClick={() => setD((x) => ({ ...x, topic: randomTopic() }))}>{t("随机生成")}</button>
        </Field>
        {secret("token", "访问令牌（可选）", v.tokenSet ? v.tokenHint : undefined, "tk_…", true)}
        <p className="text-xs leading-relaxed text-base-content/50">{t("用公共服务器 ntfy.sh 时 topic 就是口令，知道名字的人都能收到：用随机生成的长名字，或自建服务器加 token。")}</p>
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

/** 新加渠道的第一步：选类型 */
function KindPicker({ onPick }: { onPick: (k: NotifyKind) => void }) {
  const t = useT();
  return (
    <div className="space-y-2 px-5 pb-5">
      <p className="text-xs text-base-content/60">{t("选一种渠道：")}</p>
      {KINDS.map((k) => (
        <button key={k} type="button" className="flex w-full flex-col items-start rounded-lg border border-base-300 px-3 py-2.5 text-left hover:bg-base-200" onClick={() => onPick(k)}>
          <span className="text-sm font-medium">{KIND_LABEL[k]}</span>
          <span className="text-xs text-base-content/50">{t(KIND_DESC[k])}</span>
        </button>
      ))}
    </div>
  );
}

function ChannelForm(props: { initial: NotifyChannelView; busy: boolean; error?: string; onSave: (w: NotifyChannelWire) => void; onDelete?: () => void }) {
  const t = useT();
  const [d, setD] = useState(() => draftOf(props.initial));
  const [testMsg, setTestMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [guide, setGuide] = useState(false);
  /** 删除要点两下：第一下按钮变「确认删除」 */
  const [confirmDel, setConfirmDel] = useState(false);
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
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-3">
        <p className="flex items-center justify-between gap-2 rounded-lg bg-base-200/60 px-3 py-2 text-xs text-base-content/60">
          {t("第一次用？装 App、拿 key、接收格式都在向导里。")}
          <button type="button" className="btn btn-ghost btn-xs shrink-0" onClick={() => setGuide(true)}>{t("设置向导")}</button>
        </p>
        <Field label="名称">
          <input className={INPUT} value={v.name} placeholder={KIND_LABEL[v.kind]} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <KindFields d={d} setD={setD} />
        <TypePicker types={v.types} set={(types) => patch({ types })} />
        <ToggleRow
          label="全部待你处理都推"
          desc="要你选择、授权、亲自去做的卡片都推。关掉后只推标了「卡住工作」的：带按钮的普通回复大多没标，会收不到"
          on={v.allAsks !== false}
          set={(b) => patch({ allAsks: b })}
        />
        <ToggleRow label="只在我离开时推" desc="待你处理、Talk @：你正在用网页时不推；安全与系统提醒照推" on={v.onlyWhenAway} set={(b) => patch({ onlyWhenAway: b })} />
        <ToggleRow label="不带正文" desc="只推「Claudestra · 类型」，谁发的、标题、内容都不出这台电脑" on={v.hideContent} set={(b) => patch({ hideContent: b })} />
        {testMsg && <p className="text-xs text-base-content/60">{testMsg}</p>}
        {props.error && <p className="text-xs text-error">{props.error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-base-300 px-5 py-3">
        {props.onDelete && (
          <button type="button" className="btn btn-ghost btn-sm mr-auto text-error-soft-80" disabled={props.busy} onClick={confirmDel ? props.onDelete : () => setConfirmDel(true)}>
            {confirmDel ? t("确认删除") : t("删除")}
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={props.busy || testing} onClick={test}>{testing ? t("发送中…") : t("发测试通知")}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={props.busy || !v.types.length} onClick={() => props.onSave(wireOf(d))}>{t("保存")}</button>
      </div>
      {guide && <NotifyGuideModal kind={v.kind} topic={d.topic.trim()} server={d.server.trim()} onClose={() => setGuide(false)} />}
    </>
  );
}

/** initial = null：新加（先选类型）；否则编辑这一个 */
export function NotifyChannelModal(props: {
  initial: NotifyChannelView | null; busy: boolean; error?: string; onSave: (w: NotifyChannelWire) => void; onDelete?: () => void; onClose: () => void;
}) {
  const t = useT();
  const [view, setView] = useState<NotifyChannelView | null>(props.initial);
  const title = view ? (view.id ? `${t("编辑渠道")} · ${view.name}` : `${t("添加渠道")} · ${KIND_LABEL[view.kind]}`) : t("添加渠道");
  return (
    <CenteredModal onClose={props.onClose} layer="top">
      <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
        <span className="truncate text-base font-semibold">{title}</span>
        <button type="button" className="btn btn-ghost btn-sm shrink-0" aria-label={t("关闭")} onClick={props.onClose}>✕</button>
      </div>
      {view ? (
        <ChannelForm key={view.kind} initial={view} busy={props.busy} error={props.error} onSave={props.onSave} onDelete={props.onDelete} />
      ) : (
        <KindPicker onPick={(k) => setView(newChannel(k))} />
      )}
    </CenteredModal>
  );
}
