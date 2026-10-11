"use client";
import { useEffect, useState } from "react";
import { useLang, useT } from "@/lib/i18n";
import { getNotify, putNotify, toWire, type NotifyChannelView, type NotifyChannelWire, type NotifyConfig, type NotifyKind } from "@/lib/api/notify";
import { fmtAgo } from "../../fmt-time";
import { Section } from "./section";
import { KIND_LABEL, newChannel, NotifyChannelForm, resultText, TYPE_LABEL } from "./notify-channel-form";

/**
 * 设置 · 连接与集成 · 通知（docs/design-notify-channels.md）：把「待你处理」、安全 / 系统提醒、Talk @ 推到自己配的 ntfy / Bark / Webhook，
 * 点开回 Claudestra 处理。整份配置一次 PUT；密钥只在 bridge，这里只见尾四位。只给全权设备（ConnectPage 已按 s.full 挡）。
 */
const KINDS: NotifyKind[] = ["ntfy", "bark", "webhook"];
const MAX_CHANNELS = 10;

/** 拉配置 + 30 s 重拉（刷新最近结果与「几分钟前」）；状态只在 promise 回调里改（react-hooks/set-state-in-effect） */
function useNotifyConfig() {
  const [cfg, setCfg] = useState<NotifyConfig | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      getNotify().then(
        (c) => {
          if (!live) return;
          setCfg(c);
          setErr("");
        },
        (e: Error) => {
          if (live) setErr(e.message);
        },
      );
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  /** 整份保存；成功返回 true */
  const save = async (channels: NotifyChannelWire[], openUrl: string): Promise<boolean> => {
    setBusy(true);
    setErr("");
    try {
      setCfg(await putNotify(channels, openUrl.trim()));
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { cfg, err, busy, save };
}

function ChannelRow({ c, cfg, busy, onToggle, onEdit }: { c: NotifyChannelView; cfg: NotifyConfig; busy: boolean; onToggle: (on: boolean) => void; onEdit: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 rounded-lg bg-base-100 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium">{c.name}</span>
          <span className="badge badge-ghost badge-sm">{KIND_LABEL[c.kind]}</span>
        </div>
        <div className="truncate text-xs text-base-content/50">
          {c.types.map((ty) => t(TYPE_LABEL[ty])).join(" · ")} · {resultText(cfg.recent[c.id]?.[0], t, fmtAgo)}
        </div>
      </div>
      <input type="checkbox" className="toggle toggle-sm toggle-primary" checked={c.enabled} disabled={busy} onChange={(e) => onToggle(e.target.checked)} />
      <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={onEdit}>{t("编辑")}</button>
    </div>
  );
}

/** 点开通知打开的地址：留空用中继首页；改了才出「保存」 */
function OpenUrlField({ cfg, busy, onSave }: { cfg: NotifyConfig; busy: boolean; onSave: (url: string) => void }) {
  const t = useT();
  const [url, setUrl] = useState(cfg.openUrl);
  return (
    <label className="block pt-2">
      <span className="text-xs text-base-content/60">{t("点开通知打开的地址")}</span>
      <div className="mt-1 flex items-center gap-2">
        <input className="input input-bordered input-sm w-full text-sm" value={url} spellCheck={false} placeholder={cfg.linkBase ?? "https://…"} onChange={(e) => setUrl(e.target.value)} />
        {url.trim() !== cfg.openUrl && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onSave(url)}>{t("保存")}</button>
        )}
      </div>
      <span className="mt-1 block text-xs text-base-content/50">
        {url.trim() || cfg.linkBase ? t("留空用中继地址；手机要能打开这个地址。") : t("没配中继也没填地址：通知不带链接，点开不会跳转。")}
      </span>
    </label>
  );
}

export function NotifySection() {
  const t = useT();
  useLang();
  const { cfg, err, busy, save } = useNotifyConfig();
  /** 正在编辑的渠道（id 空 = 新加的） */
  const [editing, setEditing] = useState<NotifyChannelView | null>(null);
  if (!cfg) return <Section title={t("通知")} desc={err ? `${t("加载失败")}：${err}` : t("加载中…")} />;
  const wires = (map: (c: NotifyChannelView) => NotifyChannelWire | null = toWire) => cfg.channels.map(map).filter((w): w is NotifyChannelWire => !!w);
  const commit = (channels: NotifyChannelWire[]) => void save(channels, cfg.openUrl).then((ok) => ok && setEditing(null));
  const upsert = (w: NotifyChannelWire) => commit(w.id ? wires((c) => (c.id === w.id ? w : toWire(c))) : [...wires(), w]);
  const form = (c: NotifyChannelView, del?: () => void) => (
    <NotifyChannelForm key={c.id || "new"} initial={c} busy={busy} onSave={upsert} onDelete={del} onCancel={() => setEditing(null)} />
  );
  return (
    <Section title={t("通知")} desc={t("把「待你处理」和安全、系统提醒推到你自己的 ntfy / Bark / Webhook。点开通知回到 Claudestra 处理。")}>
      <div className="space-y-2">
        {cfg.channels.length === 0 && !editing && <p className="text-xs text-base-content/50">{t("还没有通知渠道。")}</p>}
        {cfg.channels.map((c) =>
          editing?.id === c.id ? form(c, () => commit(wires((x) => (x.id === c.id ? null : toWire(x))))) : (
            <ChannelRow
              key={c.id} c={c} cfg={cfg} busy={busy} onEdit={() => setEditing(c)}
              onToggle={(enabled) => commit(wires((x) => (x.id === c.id ? { ...toWire(x), enabled } : toWire(x))))}
            />
          ),
        )}
        {editing && !editing.id && form(editing)}
        {!editing && cfg.channels.length < MAX_CHANNELS && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-base-content/60">{t("添加：")}</span>
            {KINDS.map((k) => (
              <button key={k} type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing(newChannel(k))}>+ {KIND_LABEL[k]}</button>
            ))}
          </div>
        )}
        {err && <p className="text-xs text-error">{err}</p>}
        <OpenUrlField key={cfg.openUrl} cfg={cfg} busy={busy} onSave={(url) => void save(wires(), url)} />
      </div>
    </Section>
  );
}
