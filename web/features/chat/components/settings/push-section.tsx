"use client";
import { useEffect, useState } from "react";
import { enablePush, disablePush, getPushSubscription } from "@/lib/push/client";
import { getSettings, putSettings } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { Section } from "./section";

/**
 * 「推送不带正文」：整台电脑的开关（bridge 的 config.json，每条推送现读；src/lib/push-redact.ts），不是本设备的。
 * 写要 manage 权限，guest 点了拿到 403 就把错误显示出来。
 */
function usePushNoContent(open: boolean) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    getSettings()
      .then((j) => setOn(j.pushNoContent))
      .catch((e: Error) => setErr(e.message));
  }, [open]);
  const toggle = async () => {
    if (on === null) return;
    setBusy(true);
    setErr("");
    try {
      setOn((await putSettings({ pushNoContent: !on })).pushNoContent);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { on, busy, err, toggle };
}

/** Web Push(owner 2026-07-16):本设备订阅状态 + 这台电脑的「不带正文」开关 */
export function usePushToggle(open: boolean) {
  const noContent = usePushNoContent(open);
  const [pushOn, setPushOn] = useState(false);
  const [pushMsg, setPushMsg] = useState("");
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // 本设备是否已订阅推送(看本地 pushManager,与服务端表无关——多设备各自管各自)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置：拆分前与语音 Key 同属一个 effect（那条 warning 留在 groq-key-section），不新增基线
    setPushMsg("");
    void getPushSubscription().then((sub) => setPushOn(!!sub));
  }, [open]);

  const togglePush = async () => {
    setPushBusy(true);
    setPushMsg("");
    const r = pushOn ? await disablePush() : await enablePush();
    if (r.ok) setPushOn(!pushOn);
    setPushMsg(r.msg);
    setPushBusy(false);
  };

  return { pushOn, pushMsg, pushBusy, togglePush, noContent };
}

export function PushSection({ push }: { push: ReturnType<typeof usePushToggle> }) {
  const t = useT();
  const { pushOn, pushMsg, pushBusy, togglePush, noContent } = push;
  return (
      <>
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
        <Section
          title={t("推送不带正文")}
          aside={
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={noContent.on === true}
              disabled={noContent.busy || noContent.on === null}
              onChange={() => void noContent.toggle()}
            />
          }
          desc={t("打开后，这台电脑发出的推送只写「有新消息」，不带 agent 名和消息内容，点开再看。推送要经过中继和 Apple / Google 的推送服务，打开后它们看不到内容。对这台电脑配对的所有设备都生效。")}
        >
          {noContent.err ? <div className="text-xs text-error">{noContent.err}</div> : null}
        </Section>
      </>
  );
}
