# deploy/relay — 中继主机部署件

| 文件 | 用途 |
|---|---|
| `deploy.sh` | **开发机上跑**：`deploy/relay/deploy.sh <user@host> [远端目录]` —— 写 `.relay-commit`、rsync 主仓库、远端跑 install.sh、重启服务、打印 healthz |
| `install.sh` | root 运行一次：建 `relay` 用户、装 bun、`bun install`、装 systemd 单元（幂等） |
| `claudestra-relay.service` | systemd 单元；**改 `RELAY_BASE`** 为你的域名后再启用 |
| `nginx.conf` | nginx 站点模板：`RELAY_BASE` 与 `*.RELAY_BASE` 两个主机名共用一张通配符证书 |

完整步骤（DNS、证书、健康检查、升级）在 [docs/relay/self-host.md](../../docs/relay/self-host.md)。

日常：

```sh
# 升级（开发机）：rsync + install.sh + restart + healthz，一条命令
deploy/relay/deploy.sh root@<host>

# 主机上看
curl -s https://<RELAY_BASE>/healthz         # version 与 commit 对得上刚部署的
journalctl -u claudestra-relay -f
```
