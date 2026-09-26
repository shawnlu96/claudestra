# 自己跑一台中继

一台中继就是一个 Bun 进程 + 一个 SQLite 文件，放在 nginx（或任何会转发 WebSocket 的反代）后面。它不存任何会话内容；目录库里只有实例的指纹、公钥、名字、最后在线时间和配对短码的映射。协议见 [protocol.md](./protocol.md)。

## 1. 域名

需要两条 DNS 记录指向主机：

| 记录 | 值 | 用途 |
|---|---|---|
| `relay.example.com` | A / AAAA → 主机 | 实例的 wss 入口、配对与邀请落地页 |
| `*.relay.example.com` | A / AAAA → 主机 | 每台实例的网页 `https://<slug>.relay.example.com` |

下文的 `RELAY_BASE` = `relay.example.com`。

## 2. 证书

一张证书要同时覆盖 `RELAY_BASE` 和 `*.RELAY_BASE`。通配符只能用 DNS-01 签，用 acme.sh 的 DNS API 举例（Cloudflare）：

```sh
export CF_Token=<只读 DNS 编辑权限的 token>
acme.sh --issue --dns dns_cf -d relay.example.com -d '*.relay.example.com'
acme.sh --install-cert -d relay.example.com \
  --fullchain-file /etc/nginx/ssl/relay.example.com/fullchain.pem \
  --key-file       /etc/nginx/ssl/relay.example.com/key.pem \
  --reloadcmd      "systemctl reload nginx"
```

主机上已经有覆盖这两个名字的证书就直接把 nginx 指过去。

## 3. 代码与服务

第一次：

```sh
# 开发机：写 .relay-commit、rsync 主仓库（中继只用 src/ 与 package.json，web / native 不传）、远端跑 install.sh、重启、看 healthz
deploy/relay/deploy.sh root@<host>            # 第二个参数可改远端目录，默认 /opt/claudestra

# 主机：把单元文件里的 RELAY_BASE 改成你的域名，再启用
sed -i 's/RELAY_BASE=relay.example.com/RELAY_BASE=relay.yourdomain.com/' /etc/systemd/system/claudestra-relay.service
systemctl daemon-reload
systemctl enable --now claudestra-relay
journalctl -u claudestra-relay -n 20
```

第一次跑 deploy.sh 时单元文件还是模板值，服务会因为 RELAY_BASE 不合法退出（退出码 2）——改完 RELAY_BASE 再 `systemctl restart` 即可；之后每次升级就是再跑一遍 `deploy/relay/deploy.sh root@<host>`。

环境变量（都在单元文件里）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_BASE` | 必填 | 公网主机名；front 按它切子域名，实例按它拼网页地址 |
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `8787` | 只听本机，TLS 交给 nginx |
| `RELAY_DATA` | — | 数据目录，SQLite 在其下 `relay.sqlite`；或 `RELAY_DB` 直接指定文件 |
| `RELAY_TRUST_PROXY` | `0` | 反代之后设 `1`：客户端地址与主机名按 `X-Forwarded-*` 算。直接对外时别开 |
| `RELAY_MAX_FRAME_BYTES` | 262144 | 单帧上限；正文按块走，一般不用改 |
| `RELAY_COMMIT` | — | 写进 `/healthz`，方便核对线上跑的是哪个版本；没设就读仓库根 `.relay-commit`（deploy.sh 每次部署写入） |

## 4. nginx

```sh
sed "s/RELAY_BASE/relay.yourdomain.com/g" /opt/claudestra/deploy/relay/nginx.conf > /etc/nginx/sites-available/claudestra-relay.conf
ln -s /etc/nginx/sites-available/claudestra-relay.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

要点：`/v1/ws` 带 Upgrade 头；所有路径 `proxy_buffering off`、`proxy_read_timeout 3600s`（SSE 与长连接）；`Host` 与 `X-Forwarded-Host` 原样传给中继——它靠主机名分流。

## 5. 验证

```sh
curl -s https://relay.yourdomain.com/healthz          # {"ok":true,"online":0,"pending":0,"version":"…"}
curl -sI https://anything.relay.yourdomain.com/ | head -1   # HTTP/2 404：通配符证书与子域名转发都通了
```

实例侧：`.env` 写 `RELAY_URL=wss://relay.yourdomain.com`（可选 `RELAY_NAME=<想要的 slug>`），重启 bridge，日志里应出现 `上线 slug=…`；`/healthz` 的 `online` 变 1。然后在实例机器上 `claudestra pair`，用打印的短码或链接从任何浏览器进入。

## 6. 升级与运维

- 升级 = 再跑一遍 `deploy/relay/deploy.sh root@<host>`（rsync + install.sh + restart + healthz）。重启时中继给所有连接发 1012，实例秒级重连；在途请求会失败一次（与断网同一种失败），没有别的状态要迁。`/healthz` 的 `commit` 就是刚部署的短 sha，对得上才算部署成功。
- 备份：只有 `RELAY_DATA/relay.sqlite`。丢了也只是实例要重新登记，联系人关系在实例本机。
- 日志只记信封（谁、给谁、路径前缀、大小、耗时），不含请求头、正文、短码值。
- 限流写在 [protocol.md](./protocol.md)：连接侧（§3.4、§4）每连接 120 请求 / 分钟、64 在途，握手每 IP 10 次 / 分钟，兑换邀请每发起方 6 次 / 分钟；front 侧（§6.1）短码查询每 IP 30 次 / 分钟，隧道请求每 IP 600 次 / 分钟，每台实例 256 条在途隧道请求。数值在 `src/lib/relay-protocol.ts` 的 `LIMITS`。
