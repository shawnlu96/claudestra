/** 设置 · 连接与集成 · 通知（features/chat/components/settings/notify-section.tsx、notify-channel-form.tsx）的英文 */
export const NOTIFY_DICT: Record<string, string> = {
  "把「待你处理」和安全、系统提醒推到你自己的 ntfy / Bark / Webhook。点开通知回到 Claudestra 处理。":
    "Send “Needs you” items and security / system alerts to your own ntfy, Bark or webhook. Tap a notification to handle it in Claudestra.",
  "还没有通知渠道。": "No notification channels yet.",
  "添加：": "Add:",
  "编辑": "Edit",
  "还没发过": "Nothing sent yet",
  "太频繁，跳过": "Too frequent, skipped",
  "点开通知打开的地址": "Address opened when you tap a notification",
  "留空用中继地址；手机要能打开这个地址。": "Leave empty to use the relay address; your phone must be able to open it.",
  "没配中继也没填地址：通知不带链接，点开不会跳转。": "No relay and no address set: notifications carry no link, tapping them goes nowhere.",
  "安全提醒": "Security alerts",
  "系统提醒": "System alerts",
  "Talk 里 @ 你": "@-mentions in Talk",
  "新设备配对": "new device paired",
  "订阅额度、状态文件": "subscription quota, state files",
  "推送哪些": "What to send",
  "服务器": "Server",
  "地址": "URL",
  "访问令牌（可选）": "Access token (optional)",
  "签名密钥（可选）": "Signing secret (optional)",
  "留空则不签名": "Leave empty to skip signing",
  "（留空沿用）": " (leave empty to keep)",
  "随机生成": "Generate",
  "只在我离开时推": "Only when I'm away",
  "待你处理、Talk @：你正在用网页时不推；安全与系统提醒照推":
    "“Needs you” and Talk mentions are skipped while you're using the web app; security and system alerts always go out",
  "不带正文": "Hide content",
  "只推「Claudestra · 类型」，谁发的、标题、内容都不出这台电脑":
    "Send only “Claudestra · type”: sender, title and content never leave this computer",
  "在 ntfy App 里订阅同一个 topic。用公共服务器 ntfy.sh 时 topic 就是口令，知道名字的人都能收到：用随机生成的长名字，或自建服务器加 token。":
    "Subscribe to the same topic in the ntfy app. On the public ntfy.sh server the topic name is the password — anyone who knows it gets the messages. " +
    "Use a long random name, or a self-hosted server with a token.",
  "Bark App 首页的地址形如 https://api.day.app/XXXX/…，XXXX 就是 Device Key。":
    "The address on the Bark app's home screen looks like https://api.day.app/XXXX/… — XXXX is the device key.",
  "每条通知向这个地址 POST 一段 JSON。填了签名密钥会带 X-Claudestra-Signature 头：HMAC-SHA256(密钥, \"时间戳.请求体\")。":
    "Each notification is POSTed here as JSON. With a signing secret it carries an X-Claudestra-Signature header: HMAC-SHA256(secret, \"timestamp.body\").",
  "发测试通知": "Send test",
  "发送中…": "Sending…",
  "已发出，去手机上看看": "Sent — check your phone",
  "没发出去：": "Not sent: ",
};
