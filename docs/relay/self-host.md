# 自己跑一台中继

一台中继就是一个 Bun 进程 + 一个 SQLite 文件，放在 nginx（或任何会转发 WebSocket 的反代）后面，顺带托管前端静态站。它不存任何会话内容；目录库里只有实例的指纹、公钥、名字、最后在线时间和配对短码的映射。协议见 [protocol.md](./protocol.md)，产品形态见 [../design-hosted-frontend.md](../design-hosted-frontend.md)。

## 1. 域名

**一条**记录就够：

| 记录 | 值 | 用途 |
|---|---|---|
| `relay.example.com` | A / AAAA → 主机 | 用户打开的网页、实例的 wss 入口、配对与邀请落地页、`/m/<指纹>/api/v1/…` 转发 |

下文的 `RELAY_BASE` = `relay.example.com`。

兼容期（v2.28 的 bridge / 老网页还在用子域名 `https://<slug>.relay.example.com`）想继续接住它们，再加一条 `*.relay.example.com`；新装机不需要。

## 2. 证书

单主机名证书：HTTP-01 就能签，Caddy / certbot / acme.sh 任选：

```sh
acme.sh --issue -d relay.example.com --nginx
acme.sh --install-cert -d relay.example.com \
  --fullchain-file /etc/nginx/ssl/relay.example.com/fullchain.pem \
  --key-file       /etc/nginx/ssl/relay.example.com/key.pem \
  --reloadcmd      "systemctl reload nginx"
```

兼容期要覆盖 `*.RELAY_BASE` 的话，通配符只能用 DNS-01（`acme.sh --issue --dns dns_cf -d relay.example.com -d '*.relay.example.com'`）。

## 3. 代码、前端与服务

第一次：

```sh
# 开发机：写 .relay-commit、rsync 主仓库（中继只用 src/ 与 package.json）、构建前端静态导出并一起同步（RELAY_WITH_WEB=1）、远端跑 install.sh、重启、看 healthz
RELAY_WITH_WEB=1 deploy/relay/deploy.sh root@<host>     # 第二个参数可改远端目录，默认 /opt/claudestra

# 主机：把单元文件里的 RELAY_BASE 改成你的域名，再启用
sed -i 's/RELAY_BASE=relay.example.com/RELAY_BASE=relay.yourdomain.com/' /etc/systemd/system/claudestra-relay.service
systemctl daemon-reload
systemctl enable --now claudestra-relay
journalctl -u claudestra-relay -n 20
```

第一次跑 deploy.sh 时单元文件还是模板值，服务会因为 RELAY_BASE 不合法退出（退出码 2）——改完 RELAY_BASE 再 `systemctl restart` 即可；之后每次升级就是再跑一遍 `RELAY_WITH_WEB=1 deploy/relay/deploy.sh root@<host>`（前端与中继一起换代；用户下次打开就是新版本，不用每台 Mac 各自 build）。

环境变量（都在单元文件里）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_BASE` | 必填 | 公网主机名；网页地址、`/m/<fp>` 路由、（兼容期）子域名都按它算 |
| `RELAY_STATIC_DIR` | — | 前端静态导出目录（deploy.sh 同步到 `<远端目录>/web/out`）；不配就只有中继自己的页面（输短码、邀请落地） |
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `8787` | 只听本机，TLS 交给 nginx |
| `RELAY_DATA` | — | 数据目录，SQLite 在其下 `relay.sqlite`；或 `RELAY_DB` 直接指定文件 |
| `RELAY_TRUST_PROXY` | `0` | 反代之后设受信反代的层数（一层 nginx 就是 `1`，最多 `5`）：主机名按 `X-Forwarded-Host`，客户端地址取 `X-Forwarded-For` 从右数第这么多项（左边的客户端能自己写，不认）。**必须等于实际的受信层数**：配少了会把反代地址当客户端，配多了项数不够时退回连接对端，限流都会偏严或失效。受信反代追加的应是不带端口的地址（nginx 的 `$remote_addr` 就是）；带端口的中继会去掉端口再计数，认不出的写法全部共用一个桶。直接对外时别开 |
| `RELAY_MAX_FRAME_BYTES` | 262144 | 单帧上限；正文按块走，一般不用改 |
| `RELAY_COMMIT` | — | 写进 `/healthz`，方便核对线上跑的是哪个版本；没设就读仓库根 `.relay-commit`（deploy.sh 每次部署写入） |
| `RELAY_VAPID_KEYS` | `<数据目录>/vapid.json` | 推送网关（protocol.md §3.5）的 VAPID 密钥对文件；不存在就首次启动生成（0600）。**别换、别丢**：换钥匙 = 所有浏览器的推送订阅作废 |
| `RELAY_VAPID_SUBJECT` | `mailto:relay@<RELAY_BASE>` | VAPID subject；必须是合法 `mailto:` 或 `https://`（Apple 的推送服务严格校验） |
| `RELAY_APNS_KEY_PATH` / `RELAY_APNS_KEY_ID` / `RELAY_APNS_TEAM_ID` | — | 原生 iOS 壳的 APNs 凭据（.p8 路径、Key ID、团队 ID）。三个都给才开 APNs；自建中继一般只做 Web Push，不配即可。KEY_ID 没给时从文件名 `AuthKey_<ID>.p8` 解析 |
| `RELAY_APNS_TOPIC` / `RELAY_APNS_ENV` | `com.claudestra.app` / `sandbox` | bundle id 与环境（`sandbox` \| `production`）。发布版 App 用 `production`；配错环境 Apple 回 BadDeviceToken，实例会把好 token 当失效删掉 |

## 4. nginx

```sh
sed "s/RELAY_BASE/relay.yourdomain.com/g" /opt/claudestra/deploy/relay/nginx.conf > /etc/nginx/sites-available/claudestra-relay.conf
ln -s /etc/nginx/sites-available/claudestra-relay.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

要点：`/v1/ws` 带 Upgrade 头；所有路径 `proxy_buffering off`、`proxy_read_timeout 3600s`（SSE 与长连接）；`Host` 与 `X-Forwarded-Host` 原样传给中继。模板里的 `server_name` 同时列了 `*.RELAY_BASE`（兼容期），不需要就删掉那一项和通配证书。

**443 前面还有一层四层分流时（nginx `stream` 按 SNI 转发、HAProxy tcp 模式等）必须把真实 IP 传下来**，否则 http 这层看到的客户端全是 127.0.0.1，`X-Forwarded-For` 也就是 127.0.0.1，中继按 IP 的限流会变成全局限流（中继日志会警告一次「X-Forwarded-For 里是回环地址」）。做法是 PROXY protocol：stream 侧 `proxy_protocol on;`，中继站点 `listen 127.0.0.1:<port> ssl proxy_protocol;` 加 `set_real_ip_from 127.0.0.1; real_ip_header proxy_protocol;`；同一台上不认 PROXY 头的其它后端（比如 DERP、别的站点）各经一个 `listen <port> proxy_protocol; proxy_pass <原后端>;` 的 stream server 剥掉再转。

## 5. 验证

```sh
curl -s https://relay.yourdomain.com/healthz              # {"ok":true,"online":0,"pending":0,"version":"…"}
curl -s https://relay.yourdomain.com/app-config.json      # {"mode":"relay","relayBase":"relay.yourdomain.com",…}：前端入口配置
curl -sI https://relay.yourdomain.com/chat | head -1      # HTTP/2 200：静态站在（配了 RELAY_STATIC_DIR）
curl -s https://relay.yourdomain.com/m/0000-0000-0000-0000/api/v1/agents   # {"ok":false,"error":"machine_unknown"}：路径模式在
```

实例侧：`.env` 写 `RELAY_URL=wss://relay.yourdomain.com`（可选 `RELAY_NAME=<想要的名字>`），重启 bridge，日志里应出现 `上线 slug=…`；`/healthz` 的 `online` 变 1。然后在实例机器上 `claudestra pair`，手机扫码或在 `https://relay.yourdomain.com` 输入短码即配对登录。

## 6. 升级与运维

- 升级 = 再跑一遍 `RELAY_WITH_WEB=1 deploy/relay/deploy.sh root@<host>`（rsync + 前端构建同步 + install.sh + restart + healthz）。重启时中继给所有连接发 1012，实例秒级重连；在途请求会失败一次（与断网同一种失败），没有别的状态要迁。`/healthz` 的 `commit` 就是刚部署的短 sha，对得上才算部署成功。前端与 bridge 版本不一致时网页按 `/api/v1/version` 的 `minClient` 提示「这台机器需要升级」，不会坏掉。
- 备份：只有 `RELAY_DATA/relay.sqlite`（加推送网关的 VAPID 密钥文件——丢了所有浏览器要重新订阅推送）。丢了目录库也只是实例要重新登记，联系人关系在实例本机。
- 日志只记信封（谁、给谁、路径前缀、大小、耗时），不含请求头、正文、短码值、推送正文。
- 限流写在 [protocol.md](./protocol.md)：连接侧（§3.4、§4）每连接 120 请求 / 分钟、64 在途，握手每 IP 10 次 / 分钟，兑换邀请每发起方 6 次 / 分钟；front 侧（§6.1）短码查询每 IP 30 次 / 分钟，隧道请求每 IP 600 次 / 分钟，每台实例 256 条在途隧道请求；推送每实例 60 次 / 分钟。数值在 `src/lib/relay-protocol.ts` 的 `LIMITS`。
- 信任边界：中继是 TLS 终点并托管前端 JS，信任托管中继等于信任运营方（与任何 SaaS 相同）；不想经过别人的服务器就自己跑一台——代码、前端、更新源都在自己手里。
