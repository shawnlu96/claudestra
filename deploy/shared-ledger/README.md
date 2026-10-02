# deploy/shared-ledger — 共享台账中心部署包

把共享台账中心（`src/shared-ledger.ts`）装到一台已有 nginx + TLS 的 Linux 主机上：独立账号、独立库、只听回环，
nginx 新增一个只反代台账 API 的 server 块，证书复用主机上已有的那一张。**不申请证书、不改 DNS、不动已有的 server 块文件。**

| 文件 | 用途 |
|---|---|
| `deploy.sh` | **开发机上跑**的入口：暂存源码 → rsync → 远端跑 `remote.sh` |
| `remote.sh` | 远端安装 / 卸载步骤；经 `ssh <主机> bash -s` 从 stdin 传过去，远端不留副本 |
| `closure.ts` | 用 bun 解析 `src/shared-ledger.ts` 的 import 闭包，得出要同步的源码清单（不手写清单） |
| `backup.ts` | 每日备份：`VACUUM INTO` 出一致性副本，保留 7 天 |

## 前置条件

- 部署须经 owner 在部署授权卡上批准，由 PM 执行。
- 开发机：`bun`、`git`、`rsync`、能免密 `ssh root@<主机>`。
- 远端（systemd 发行版，如 Ubuntu 22.04+）：`nginx`（`conf.d/*.conf` 已被 `http {}` include）、`rsync`、`curl`、`journalctl`；
  - **系统级 bun ≥ 1.3**，默认找 `/usr/local/bin/bun`（不能在 `/root`、`/home` 下：单元开了 `ProtectHome`）。没有就先装：
    `curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash`，或用 `--bun <路径>` 指向已有的。
  - 已有 server 块的证书要覆盖新域名：通常是 `server_name` 含 `*.<上级域>` 的通配站点（也可以是只听 80 等非 443 端口、`server_name` 精确等于 `<域名>` 且带证书的块）；
  - `<域名>` 不能已被已有的 443 server 块占用（`server_name` 精确等于它）：同 listener 同名时 nginx 只告警并忽略其一，请求会落到先加载的块。脚本在写任何东西之前就检查，冲突即退出，请换一个未被占用的域名；
  - 新域名的 DNS 已指向本机（本脚本不改 DNS）。

## 用法

```sh
# 先看要做什么：只读远端（rsync -n、nginx -T），打印每一步与将写入的单元 / nginx 块
deploy/shared-ledger/deploy.sh root@<主机> --host-name ledger.example.test --dry-run

# 安装或升级（可重跑：代码和渲染结果都没变就不写文件、不 reload、不重启；但每次都会经 https://<域名> 验一遍入口，入口不通就退出非 0）
deploy/shared-ledger/deploy.sh root@<主机> --host-name ledger.example.test [--port 8797] [--bun /usr/local/bin/bun]

# 主机上看
systemctl status claudestra-shared-ledger
journalctl -u claudestra-shared-ledger -n 50
cat /opt/claudestra-shared-ledger/.shared-ledger-commit       # 部署的 commit
systemctl list-timers claudestra-shared-ledger-backup.timer
```

安装时依次：检查 bun 版本与现有 `nginx -t` → 建 `claudestra-ledger` 系统账号与目录 → 写三个 systemd 单元 → 启动 / 必要时重启 →
回环健康检查（未签名请求应得 `401 bad_signature`；失败退出非 0 并打印日志尾部）→ 探测证书、写 nginx 块、`nginx -t`，通过才 reload
（不通过就删掉本次新写的文件、或恢复本脚本的上一版，退出非 0）→ 经本机 443 自检新入口（API 路径 401、其他 404）。

## 装到哪里

| 路径 | 内容 | 属主 / 权限 |
|---|---|---|
| `/opt/claudestra-shared-ledger/` | 中心源码（import 闭包）+ `backup.ts` + `.shared-ledger-commit` | root，755 / 644（服务只读） |
| `/var/lib/claudestra-shared-ledger/db/shared-ledger.sqlite` | 中心独立库（不与中继共用路径） | claudestra-ledger，目录 0700，库文件 0600（`UMask=0077`） |
| `/var/backups/claudestra-shared-ledger/` | 每日备份 `shared-ledger-<UTC 时间>.sqlite` | claudestra-ledger，0700 / 0600 |
| `/etc/systemd/system/claudestra-shared-ledger{.service,-backup.service,-backup.timer}` | 服务与备份 | root，644 |
| `/etc/nginx/conf.d/claudestra-shared-ledger.conf` | HTTPS 入口 | root，644 |

本脚本写的每个文件第一行是 `# managed-by: claudestra deploy/shared-ledger …` 标记头；同名文件已存在而没有标记头时，安装与卸载都拒绝动它。

- 服务：只在 `127.0.0.1:<端口>` 监听（服务端本身只接受回环地址，单元再加 `IPAddressAllow=localhost`），`Restart=on-failure`，
  `MemoryMax` / `TasksMax` / `CPUQuota` 上限，`ProtectSystem=strict` 等加固，只有库目录可写。
- nginx：只反代 `^/v1/teams/<team>/(features|commands|imports|projections)[/<id>]$`，其余 404；`client_max_body_size 1m`
  （与服务端 1 MiB 上限一致）、`proxy_read_timeout 15s`、每客户端 IP `limit_req`。
- 已知限制：服务端自己的限流按来源地址分桶，经 nginx 反代后来源都是 127.0.0.1，等于全体客户端共用一桶（每分钟 120 次）。
  每客户端限流目前靠 nginx 的 `limit_req`；团队请求量接近这个数时要先改服务端（按 `X-Forwarded-For` 分桶）。

## 回滚

- **代码回滚**：`git checkout <上一个 commit>` 后重跑 `deploy.sh`（库结构由中心启动时迁移，回滚前确认旧版本认得当前库结构，拿不准就先恢复备份）。
- **整体下线**：
  ```sh
  deploy/shared-ledger/deploy.sh root@<主机> --uninstall [--dry-run]
  ```
  停止并禁用服务与备份 timer，删掉本脚本的三个单元和 nginx 块，`nginx -t` 通过后 reload；**库、备份、代码目录都保留**。
  彻底清理（确认不再需要数据后手动）：`rm -rf /opt/claudestra-shared-ledger /var/lib/claudestra-shared-ledger /var/backups/claudestra-shared-ledger && userdel claudestra-ledger`。
- **从备份恢复库**：
  ```sh
  systemctl stop claudestra-shared-ledger
  cd /var/lib/claudestra-shared-ledger/db && mkdir -p ../db-broken && mv shared-ledger.sqlite* ../db-broken/
  install -o claudestra-ledger -g claudestra-ledger -m 600 /var/backups/claudestra-shared-ledger/shared-ledger-<时间>.sqlite shared-ledger.sqlite
  systemctl start claudestra-shared-ledger
  ```
- 手动触发一次备份：`systemctl start claudestra-shared-ledger-backup.service`。

## 测试

`bun test tests/shared-ledger-deploy.test.ts`：假 ssh / rsync / systemctl / nginx / curl 桩放在 PATH 最前，远端文件系统挪到临时目录
（`SHARED_LEDGER_FS_PREFIX`，仅测试用），不连任何主机。
