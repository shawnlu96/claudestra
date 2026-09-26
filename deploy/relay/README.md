# deploy/relay — 中继主机部署件

| 文件 | 用途 |
|---|---|
| `install.sh` | root 运行一次：建 `relay` 用户、装 bun、`bun install`、装 systemd 单元（幂等） |
| `claudestra-relay.service` | systemd 单元；**改 `RELAY_BASE`** 为你的域名后再启用 |
| `nginx.conf` | nginx 站点模板：`RELAY_BASE` 与 `*.RELAY_BASE` 两个主机名共用一张通配符证书 |

完整步骤（DNS、证书、健康检查、升级）在 [docs/relay/self-host.md](../../docs/relay/self-host.md)。

日常：

```sh
# 升级：本机
rsync -az --delete --exclude node_modules --exclude web --exclude native --exclude legacy --exclude .git ./ root@<host>:/opt/claudestra/
# 主机
bash /opt/claudestra/deploy/relay/install.sh && systemctl restart claudestra-relay
curl -s https://<RELAY_BASE>/healthz
journalctl -u claudestra-relay -f
```
