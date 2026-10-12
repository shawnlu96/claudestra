/** 设置 · 连接与集成 · 通知（features/chat/components/settings/notify-section.tsx、notify-channel-form.tsx、notify-guide.tsx）的英文 */
export const NOTIFY_DICT: Record<string, string> = {
  // ── 设置页列表 ──
  "把「待你处理」和安全、系统提醒推到你自己的 ntfy / Bark / Webhook。点开通知回到 Claudestra 处理。":
    "Send “Needs you” items and security / system alerts to your own ntfy, Bark or webhook. Tap a notification to handle it in Claudestra.",
  "还没有通知渠道。": "No notification channels yet.",
  "添加渠道": "Add channel",
  "编辑渠道": "Edit channel",
  "编辑": "Edit",
  "还没发过": "Nothing sent yet",
  "太频繁，跳过": "Too frequent, skipped",
  "点开通知打开的地址": "Address opened when you tap a notification",
  "留空用中继地址；手机要能打开这个地址。": "Leave empty to use the relay address; your phone must be able to open it.",
  "没配中继也没填地址：通知不带链接，点开不会跳转。": "No relay and no address set: notifications carry no link, tapping them goes nowhere.",
  // ── 配置弹窗 ──
  "选一种渠道：": "Pick a channel type:",
  "Android / iOS / 网页都能收，可用官方服务器或自建": "Android, iOS and web; official server or self-hosted",
  "仅 iPhone，App Store 装 Bark 即可": "iPhone only — install Bark from the App Store",
  "POST 一段 JSON 到你的地址，自己接其它系统": "POSTs JSON to your URL, for wiring up other systems",
  "第一次用？装 App、拿 key、接收格式都在向导里。": "First time? The guide covers installing the app, getting the key and the payload format.",
  "设置向导": "Setup guide",
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
  "用公共服务器 ntfy.sh 时 topic 就是口令，知道名字的人都能收到：用随机生成的长名字，或自建服务器加 token。":
    "On the public ntfy.sh server the topic name is the password — anyone who knows it gets the messages. Use a long random name, or a self-hosted server with a token.",
  "自建服务器：iPhone 上的 ntfy App 要即时收到，服务器需配": "Self-hosted: for the ntfy iPhone app to get notifications instantly, the server needs",
  "，否则通知可能要几个小时才到。详见设置向导。": "; otherwise notifications may take hours. See the setup guide.",
  "全部待你处理都推": "Push every “Needs you” item",
  "你不在时，要你选择、授权、亲自去做的卡片都另推一条「待你处理」，不看有没有标「卡住工作」。回复本身已经推过一次，所以打开后带按钮的回复会响两次。对这台电脑配对的所有设备都生效。":
    "While you're away, every item that needs your choice, approval or action gets its own “Needs you” push, whether or not it is marked as blocking work. " +
    "The reply itself is already pushed once, so replies with buttons will notify twice. Applies to every device paired with this computer.",
  "要你选择、授权、亲自去做的卡片都推。关掉后只推标了「卡住工作」的：带按钮的普通回复大多没标，会收不到":
    "Push every item that needs your choice, approval or action. When off, only items marked as blocking work are pushed; ordinary replies with buttons usually aren't marked and won't arrive",
  "只在我离开时推": "Only when I'm away",
  "待你处理、Talk @：你正在用网页时不推；安全与系统提醒照推":
    "“Needs you” and Talk mentions are skipped while you're using the web app; security and system alerts always go out",
  "不带正文": "Hide content",
  "只推「Claudestra · 类型」，谁发的、标题、内容都不出这台电脑":
    "Send only “Claudestra · type”: sender, title and content never leave this computer",
  "发测试通知": "Send test",
  "发送中…": "Sending…",
  "已发出，去手机上看看": "Sent — check your phone",
  "没发出去：": "Not sent: ",
  // ── 设置向导 ──
  "ntfy 设置向导": "ntfy setup guide",
  "Bark 设置向导": "Bark setup guide",
  "Webhook 接收格式": "Webhook payload format",
  "在手机上装 ntfy：": "Install ntfy on your phone: ",
  "；电脑上也可以直接开": "; on a computer you can also use the",
  "网页版": "web app",
  "在 App 里点「+」订阅这个 topic：": "In the app, tap “+” and subscribe to this topic: ",
  "（先在配置里填好 topic）": "(fill in the topic in the settings first)",
  "服务器用默认的 ntfy.sh；自建的话在订阅时填你的地址：": "Use the default ntfy.sh server, or enter your own when subscribing: ",
  "公共服务器上 topic 就是口令：别人知道名字就能收到你的通知，所以用随机生成的长名字，别用好猜的词。":
    "On the public server the topic is the password: anyone who knows the name receives your notifications, so use a long random name, not a guessable word.",
  "自建服务器（可选）：": "Self-hosting (optional):",
  "要推给 iPhone，服务器配置 server.yml 里加：": "To reach iPhones, add this to the server's server.yml: ",
  "不加的话通知最终也会到，但可能要几个小时。": "Without it notifications still arrive eventually, but it can take hours.",
  "开了访问控制，就生成一个令牌，填到「访问令牌」：": "With access control on, create a token and put it in “Access token”: ",
  "<用户名>": "<username>",
  "回到配置点「发测试通知」，手机上收到就配好了。": "Back in the settings, press “Send test” — if it reaches your phone, you're done.",
  "在 iPhone 上从 App Store 装": "On your iPhone, install",
  "，打开后允许通知。": " from the App Store and allow notifications.",
  "App 首页有一个地址，形如": "The app's home screen shows an address like",
  "，中间那段 XXXXXXXX 就是 Device Key，复制填进配置。": "; the XXXXXXXX part is the device key — copy it into the settings.",
  "建议在 iOS「设置 · 通知 · Bark」里打开「时效性通知」：待你处理和安全提醒在专注模式下也能弹出来。":
    "Turn on “Time Sensitive Notifications” in iOS Settings · Notifications · Bark so “Needs you” and security alerts break through Focus.",
  "在 Bark App 里添加这个服务器，配置里的服务器填它的地址，Device Key 用 App 在新服务器下显示的那个。":
    "Add that server in the Bark app, put its address in “Server” here, and use the device key the app shows for the new server.",
  "每条通知向你填的地址 POST 一段 JSON：": "Each notification is POSTed to your URL as JSON:",
  "type 是 ask（待你处理）/ security / system / talk；url 是点开要打开的地址，没配可达入口时为 null；开了「不带正文」时 title 和 body 只剩「Claudestra · 类型」。":
    "type is ask (needs you) / security / system / talk; url is the address to open, null when no reachable entry is set; " +
    "with “Hide content” on, title and body are only “Claudestra · type”.",
  "请求头：": "Headers:",
  "：同 type": ": same as type",
  "：秒级时间戳": ": Unix timestamp in seconds",
  "：填了签名密钥才有，= HMAC-SHA256(密钥, \"时间戳.原始请求体\")": ": only with a signing secret, = HMAC-SHA256(secret, \"timestamp.raw body\")",
  "验签（Node）：": "Verify (Node):",
  "验签（Python）：": "Verify (Python):",
  "rawBody 是收到的原始请求体字符串，别先解析成 JSON 再序列化回去，签名会对不上。":
    "rawBody is the raw request body string — don't parse it to JSON and re-serialize, or the signature won't match.",
  "回 2xx 算送达；5xx、429 或网络错误 2 秒后重试一次，其它 4xx 不重试；10 秒超时；每个渠道每分钟最多 20 条。":
    "A 2xx reply counts as delivered; 5xx, 429 or network errors are retried once after 2 s, other 4xx are not; 10 s timeout; at most 20 per channel per minute.",
  "飞书、钉钉、企业微信、Slack 的机器人 Webhook 各有自己的消息格式，不能直接填它们的地址：用 n8n 之类的工具或几行中转代码，把 title、body、url 拼成它们要的格式再转发。":
    "Feishu, DingTalk, WeCom and Slack bot webhooks each expect their own message format, so their URLs can't be used directly: " +
    "put n8n or a few lines of relay code in between to turn title, body and url into their format.",
};
