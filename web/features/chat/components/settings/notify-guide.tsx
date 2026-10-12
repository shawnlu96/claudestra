"use client";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import type { NotifyKind } from "@/lib/api/notify";
import { CenteredModal } from "../centered-modal";
import { CopyButton } from "../peers-shared";

/**
 * 通知渠道的设置向导（配置弹窗里点开，叠在上面）：ntfy / Bark 怎么装 App、拿 topic / key、自建服务器；Webhook 的请求格式与验签。
 * 链接与命令照各家官方文档（2026-10-11 核对）：ntfy docs install.md / config.md「iOS instant notifications」，Finb/Bark、Finb/bark-server README。
 * Webhook 的格式与 src/lib/notify-channels.ts buildRequest、src/bridge/notify/sink.ts 的重试 / 超时一致——改那边记得改这里。
 */
const LINKS = {
  ntfyIos: "https://apps.apple.com/us/app/ntfy/id1625396347",
  ntfyPlay: "https://play.google.com/store/apps/details?id=io.heckel.ntfy",
  ntfyDroid: "https://f-droid.org/en/packages/io.heckel.ntfy/",
  ntfyWeb: "https://ntfy.sh/app",
  bark: "https://apps.apple.com/app/bark-custom-notifications/id1403753865",
};
const NTFY_DOCKER = "docker run -p 80:80 -it binwiederhier/ntfy serve";
const NTFY_UPSTREAM = 'upstream-base-url: "https://ntfy.sh"';
const BARK_DOCKER = "docker run -dt --name bark -p 8080:8080 -v `pwd`/bark-data:/data finab/bark-server";
const WEBHOOK_BODY = `{
  "source": "claudestra",
  "type": "ask",
  "title": "待你处理 · agent-x",
  "body": "要不要发版？",
  "url": "https://relay.floka.ai/chat?ask=…&fp=…",
  "tag": "cstra-ask-…-open",
  "ts": 1791700000000,
  "urgent": false
}`;
const VERIFY_NODE = `import { createHmac, timingSafeEqual } from "node:crypto";
const ts = req.headers["x-claudestra-timestamp"];
const sig = req.headers["x-claudestra-signature"] ?? "";
const want = "sha256=" + createHmac("sha256", SECRET).update(\`\${ts}.\${rawBody}\`).digest("hex");
const ok = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want))
  && Math.abs(Date.now() / 1000 - Number(ts)) < 300;`;
const VERIFY_PY = `import hmac, hashlib, time
want = "sha256=" + hmac.new(SECRET.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(want, sig) and abs(time.time() - int(ts)) < 300`;

function Code({ text, block }: { text: string; block?: boolean }) {
  if (!block) {
    return (
      <span className="inline-flex items-center gap-1">
        <code className="break-all rounded bg-base-200 px-1.5 py-0.5 text-[12px]">{text}</code>
        <CopyButton text={text} label="复制" />
      </span>
    );
  }
  // 复制按钮放在代码块上方一行：叠在块里会盖住长命令的末尾（命令横向滚动，右内边距只在滚到底时才有用）
  return (
    <div className="mt-1 overflow-hidden rounded-lg bg-base-200">
      <div className="flex justify-end px-1 pt-1"><CopyButton text={text} label="复制" /></div>
      <pre className="overflow-x-auto whitespace-pre px-3 pb-3 text-[12px] leading-relaxed">{text}</pre>
    </div>
  );
}

function A({ href, children }: { href: string; children: ReactNode }) {
  return <a className="link link-primary" href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed">
      {items.map((x, i) => <li key={i}>{x}</li>)}
    </ol>
  );
}

function NtfyGuide({ topic, server }: { topic: string; server: string }) {
  const t = useT();
  return (
    <Steps items={[
      <>
        {t("在手机上装 ntfy：")}<A href={LINKS.ntfyIos}>App Store</A> · <A href={LINKS.ntfyPlay}>Google Play</A> · <A href={LINKS.ntfyDroid}>F-Droid</A>
        {t("；电脑上也可以直接开")} <A href={LINKS.ntfyWeb}>{t("网页版")}</A>。
      </>,
      <>
        {t("在 App 里点「+」订阅这个 topic：")}{topic ? <Code text={topic} /> : t("（先在配置里填好 topic）")}
        <span className="block text-xs text-base-content/60">{t("服务器用默认的 ntfy.sh；自建的话在订阅时填你的地址：")}{server || "https://ntfy.sh"}</span>
      </>,
      <>{t("公共服务器上 topic 就是口令：别人知道名字就能收到你的通知，所以用随机生成的长名字，别用好猜的词。")}</>,
      <>
        {t("自建服务器（可选）：")}<Code text={NTFY_DOCKER} block />
        <span className="mt-2 block">{t("要推给 iPhone，服务器配置 server.yml 里加：")}<Code text={NTFY_UPSTREAM} /></span>
        <span className="block text-xs text-base-content/60">{t("不加的话通知最终也会到，但可能要几个小时。")}</span>
        <span className="mt-2 block">{t("开了访问控制，就生成一个令牌，填到「访问令牌」：")}<Code text={`ntfy token add ${t("<用户名>")}`} /></span>
      </>,
      <>{t("回到配置点「发测试通知」，手机上收到就配好了。")}</>,
    ]} />
  );
}

function BarkGuide() {
  const t = useT();
  return (
    <Steps items={[
      <>{t("在 iPhone 上从 App Store 装")} <A href={LINKS.bark}>Bark</A>{t("，打开后允许通知。")}</>,
      <>{t("App 首页有一个地址，形如")} <code className="rounded bg-base-200 px-1.5 py-0.5 text-[12px]">https://api.day.app/XXXXXXXX/…</code>{t("，中间那段 XXXXXXXX 就是 Device Key，复制填进配置。")}</>,
      <>{t("建议在 iOS「设置 · 通知 · Bark」里打开「时效性通知」：待你处理和安全提醒在专注模式下也能弹出来。")}</>,
      <>
        {t("自建服务器（可选）：")}<Code text={BARK_DOCKER} block />
        <span className="mt-2 block">{t("在 Bark App 里添加这个服务器，配置里的服务器填它的地址，Device Key 用 App 在新服务器下显示的那个。")}</span>
      </>,
      <>{t("回到配置点「发测试通知」，手机上收到就配好了。")}</>,
    ]} />
  );
}

function WebhookGuide() {
  const t = useT();
  return (
    <div className="space-y-4 text-sm leading-relaxed">
      <p>{t("每条通知向你填的地址 POST 一段 JSON：")}</p>
      <Code text={WEBHOOK_BODY} block />
      <p className="text-xs text-base-content/60">{t("type 是 ask（待你处理）/ security / system / talk；url 是点开要打开的地址，没配可达入口时为 null；开了「不带正文」时 title 和 body 只剩「Claudestra · 类型」。")}</p>
      <div>
        <p>{t("请求头：")}</p>
        <ul className="list-disc space-y-1 pl-5 text-xs">
          <li><code>Content-Type: application/json</code></li>
          <li><code>X-Claudestra-Event</code>{t("：同 type")}</li>
          <li><code>X-Claudestra-Timestamp</code>{t("：秒级时间戳")}</li>
          <li><code>X-Claudestra-Signature: sha256=…</code>{t("：填了签名密钥才有，= HMAC-SHA256(密钥, \"时间戳.原始请求体\")")}</li>
        </ul>
      </div>
      <p>{t("验签（Node）：")}<span className="block text-xs text-base-content/60">{t("rawBody 是收到的原始请求体字符串，别先解析成 JSON 再序列化回去，签名会对不上。")}</span></p>
      <Code text={VERIFY_NODE} block />
      <p>{t("验签（Python）：")}</p>
      <Code text={VERIFY_PY} block />
      <p className="text-xs text-base-content/60">{t("回 2xx 算送达；5xx、429 或网络错误 2 秒后重试一次，其它 4xx 不重试；10 秒超时；每个渠道每分钟最多 20 条。")}</p>
      <p className="text-xs text-base-content/60">{t("飞书、钉钉、企业微信、Slack 的机器人 Webhook 各有自己的消息格式，不能直接填它们的地址：用 n8n 之类的工具或几行中转代码，把 title、body、url 拼成它们要的格式再转发。")}</p>
    </div>
  );
}

export function NotifyGuideModal({ kind, topic = "", server = "", onClose }: { kind: NotifyKind; topic?: string; server?: string; onClose: () => void }) {
  const t = useT();
  const title = { ntfy: t("ntfy 设置向导"), bark: t("Bark 设置向导"), webhook: t("Webhook 接收格式") }[kind];
  return (
    <CenteredModal onClose={onClose} layer="top">
      <div className="flex items-center justify-between px-5 pb-2 pt-4">
        <span className="text-base font-semibold">{title}</span>
        <button type="button" className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {kind === "ntfy" ? <NtfyGuide topic={topic} server={server} /> : kind === "bark" ? <BarkGuide /> : <WebhookGuide />}
      </div>
    </CenteredModal>
  );
}
