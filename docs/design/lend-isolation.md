# 出借 worker 硬隔离（i28-W8 设计稿）

状态：设计稿，等 owner 拍板（§9）后由 PM 拆进 i28 子 DAG（§8）。本卡不改产品代码、系统配置、launchd、pf、用户账户。
依据：任务卡 i28-W8、`docs/design/remote-capacity.md` §4 §5、`docs/architecture/caller-identity.md`「Lend workers' lend profile」、
`src/lib/runtimes/clean-env.ts`、`src/lib/acp/adapter-proc.ts`、`src/lib/lend-clone.ts`、`src/lib/lend-push.ts`。
所有「实测」都是 §10 的只读探测，在出借方本机（macOS 26.5.2、Apple M1 / 16 GB、剩余磁盘约 18 GiB、codex-cli 0.159.3、codex-acp 2.0.0）上跑的。

## 0. 结论

- **推荐 B+**：出借 worker 执行命令的 shell 套 Codex 自带的 seatbelt 沙箱，用 Codex 0.159 的**命名权限档**（`[permissions.<名>]`），
  不用 ACP 现在给的 `agent-full-access`。权限档只放最小读集 + 工具链 + 本单目录可写，网络全关。
  另外三件事：
  - Codex 换成出借专用的 `CODEX_HOME`，单独登录；
  - 依赖预装和结果导出放到 worker 回合之外做；
  - 写单改走 MCP `deliver`。
- **两条路的关法**（实测依据见 §7.2）：
  - **路 ①（没登记的本机连接）**：沙箱里 TCP 连回环被拒，AF_UNIX 连接也被拒（tmux 主 socket、SSH agent 都连不上）。worker 的 shell 根本到不了 bridge。
    沙箱外只剩我们自己的 channel-server（lend 档），以及 W4 已有的代理和 bridge 两道闸。
  - **路 ②（直接读宿主凭据）**：auth.json、peers.json、实例私钥、仓库 `.env`、`~/.gitconfig` 都打不开；`~/.ssh`、`~/Library/Keychains` 列不出；
    默认钥匙串连不上；其他会话的 `/tmp` 用一条 deny 也挡住了。
- **Codex 登录**：模型请求由沙箱外的 Codex app-server 发，它读的是出借专用 `CODEX_HOME` 的登录。worker 的 shell 读不到这份登录，也读不到出借方的 `~/.codex`。
  不把 auth.json 交给 worker；额度仍记在出借方账号上，归属见 §9-2。
- **A（独立 macOS 用户）作二期纵深**：防的是 seatbelt 本身被突破（同一 OS 用户下，沙箱是唯一一层）。
  它要管理员权限，还要改 bridge 的回环信任，代价大，需要 owner 拍板（§9-4）。A 单独用还不够：Codex 不支持「模型请求用 A 用户、命令用 B 用户」，
  登录态只能放进专用用户，同一用户的 shell 照样能读到。
- **C（容器 / VM）一期不推荐**，原因有四（§5）：
  - colima 默认网络能直达宿主回环（实测连上 bridge 端口）；
  - colima 的 VM 默认挂着家目录；
  - Codex 要么在容器里持有登录，要么依赖没文档化的远端执行；
  - Apple container 要先安装。
- **现状另有一个缺口**（实测，审查单也受影响）：出借 worker 今天用的是出借方自己的 `~/.codex`。它会挂上出借方 config 里启用着的 MCP（记忆库、两个 REPL 类），
  还会带上 notify / hooks、全局 AGENTS.md 和记忆。这些都在沙箱外跑，等于后门。所以节点 W8b（专用 CODEX_HOME）排在最前，审查单也立刻受益。

## 1. 现状链路与两条路

```
tmux 窗口（出借方用户）
 └ env -i 白名单 → bun acp-host.ts（宿主，持 caller 凭据，连 bridge）
    └ codex-acp 2.0.0（INITIAL_AGENT_MODE=agent-full-access → approval never + dangerFullAccess）
       └ codex app-server（读 CODEX_HOME 的登录，发模型请求）
          ├ shell / apply_patch 等工具 ← 外来任务在这里跑，**今天不进任何沙箱**
          └ MCP：channel-server（lend 档，5 个派单工具 + whoami）→ 宿主回环代理（只转这几样）→ bridge（lendFrameGate）
```

- 路 ①：shell 直接开 ws 连 bridge 端口、不 register，原生帧就按「同一用户本来可信」放行（caller-identity.md 的 Known limit）。
  同理也能连出借方别的回环服务（本机的向量库、嵌入服务、Docker socket 等）。
- 路 ②：shell 和出借方同一个 OS 用户，`HOME` 下的文件、git 凭据助手、SSH agent、钥匙串都能用，读完写进审查报告带回 A。
- `env -i` 白名单（clean-env.ts）只清继承的环境变量，`WRITE_LOCK` 只是 git 配置，两者都不是边界（remote-capacity.md §5 已写明）。

## 2. 探测方法

- 只判断「能不能打开」，不读内容：文件用 `(: < 文件)`（打开、读 0 字节），目录用 `ls >/dev/null`，二者都不输出内容。
  `test -r` 也一并记了：它走 `access(2)`，在 seatbelt 下和真实打开的结果可能不一致，所以以 open 为准（本机两者一致）。
- 沙箱用 `codex sandbox -P <档名> -c 'permissions.<档名>.filesystem={…}' -- <脚本>` 起。这是 Codex 给 shell 套的同一个 seatbelt，
  沙箱运行时只读 `~/.codex/config.toml`，档案用 `-c` 现场覆盖，不写配置文件。
- 网络只连本机端口和一个公共地址做通断判断，不发内容；Docker 只用本机已有的镜像，加 `--rm --pull never`，没有下载或安装。
- 没碰的：peers.json、principals.json、peer-keys.json、`.env`、instance-key.pem、`~/.codex/auth.json` 的内容和钥匙串条目；
  launchd 任务（会改 launchd 状态的探测留给实现节点，§8 W8a）；pf 规则（读规则要 root）。

## 3. 方案 A：独立 macOS 用户

做法：建一个隐藏的服务用户（例如 `_clslend`，uid < 500、主组是它自己的组、不进 staff、登录 shell 为 `/usr/bin/false`），
worker 进程以它的身份运行。宿主（出借方用户）经一条只放行固定包装程序的 sudoers 规则 `sudo -n -u _clslend <包装程序>` 起适配器。

能防：
- 出借方 0600 的文件（auth.json、peers.json、instance-key.pem、`.env`）、`~/.ssh`（0700）、登录钥匙串、SSH agent、出借方的 launchd 域，
  都靠内核的用户隔离挡住，不依赖沙箱策略写得对不对。
- seatbelt 被突破后，进程落在专用用户身上，不是出借方本人。

不能防 / 要另补：
- **家目录是组可读的**（实测）：`~` 是 `drwxr-x---`，属主是出借方、组是 staff。`~/.gitconfig` 0644，`~/repos` 0755；
  `~/.claude-orchestrator` 是 0755，前两层里有 503 个组和其他人都可读的文件，其中包括 peer-keys.json（0644）。
  所以专用用户**绝不能进 staff 组**（`dsmemberutil checkmembership` 核对）；用系统设置图形界面建的普通用户默认就在 staff 里，不能用。
- **回环端口对所有用户开放**：bridge 把没登记的回环连接当成可信，专用用户照样能连 bridge 发原生帧，路 ① 没关上。
  要关就得让 bridge 对回环也要凭据：所有原生帧和 ws 升级都要带本机控制 token，token 放在出借方 0600 文件里，出借方自己的 manager / reply 脚本读得到，专用用户读不到。
  这一条改的是 bridge 的公共入口，影响面大。
  另一种办法是 pf 按用户过滤（`block out on lo0 proto tcp user _clslend`）：pf.conf(5) 有 `user` 条件，但本机读和装规则都要 root，**未实测**。
  而且专用用户的 channel-server 还要连宿主的回环代理，要给它单独开口子。
- **Codex 登录放哪**（阻塞点）：Codex 没有「app-server 用 A 用户、命令用 B 用户」的选项（文档和 0.159.3 的 CLI 帮助里都没有）。
  所以 app-server 只能整个跑在专用用户下，登录（auth.json，或者以 CODEX_HOME 为键的钥匙串条目）也只能放进专用用户。
  同一用户的 shell 照样读得到，等于把一份能消耗出借方额度的凭据交给了 worker。**A 单独用不满足验收线 3**，必须叠加 B 的读限制。
- **git 推送凭据**：推送仍由出借服务以出借方身份在另一个目录做（lend-push.ts 不变）。结果从专用用户的目录交回来，要有交接目录和文件属主约定。

一次性准备（需要管理员权限，绕不开的原因：往本地目录服务里加账户、写 `/etc/sudoers.d`，macOS 都要求 admin 授权）：
- 建用户和组、建它的家目录、装 sudoers 片段和 root 拥有的包装程序。
- 不让本人敲终端的做法：
  - 网页按钮 → bridge 弹出 macOS 标准的管理员授权框，owner 在系统框里输密码。实现上要用 `osascript … with administrator privileges`，
    这和现有「不在 owner 屏幕上用 osascript」的规矩冲突，**要 owner 给例外**。
  - 或者做一个签名的特权助手（SMAppService）。要有 macOS 签名 App，目前没有，成本大。
- 系统设置图形界面也能建用户，但只能建 staff 组里的普通用户，不合格（见上）。

对 Codex 的影响：要再登录一份（同上，放在专用用户下）。额度记在登录的那个账号上。

## 4. 方案 B：Codex 自带沙箱（seatbelt）

Codex 0.159 在 macOS 上用 `/usr/bin/sandbox-exec` 给每条命令套 seatbelt。app-server 本身不进沙箱，所以模型凭据和命令天然分在两边。
沙箱基础策略是 `(deny default)`，再逐项放行（§10.5 摘录）。

**缺省策略对读不设限**（实测，§10.1）：`:read-only` 和旧版 `workspace-write` 都是 `(allow file-read*)`，所以 auth.json、peers.json、实例私钥、`.env`、
`~/.ssh`、钥匙串目录全都能打开。只开缺省沙箱**防不住路 ②**。网络关闭时回环连接被拒，路 ① 是能挡住的。

**0.159 的命名权限档可以限制读**（实测，§10.2 – §10.4）：

```toml
default_permissions = "lend"
[permissions.lend]
filesystem.":minimal" = "read"                          # 系统最小读集
filesystem."/opt/homebrew" = "read"                     # 工具链：按 PATH 里 bun / git 的实际位置生成
filesystem."/Library/Developer/CommandLineTools" = "read"  # /usr/bin/git 依赖 xcode-select -p
filesystem."/private/tmp" = "deny"                      # :minimal 默认放行 /tmp，里面有别的会话的临时文件
filesystem."/private/var/folders" = "deny"
filesystem.":workspace_roots"."." = "write"             # 本单目录（§7.1）
network.enabled = false
```

上面是示意，具体写法以 W8a 定稿为准；探测时是用 `-c` 内联表写的，见 §10。实测结果：
- 凭据文件全部打不开，`~/.ssh`、钥匙串目录列不出；
- `security show-keychain-info` 返回 37（宿主上是 0），SSH agent 返回 2，表示连不上；
- 回环 TCP、tmux 主 socket 都连不上；`ps -E` 读不到别的进程的环境，也不能给宿主进程发信号；
- 本单目录可写，`bun` 能跑 TS，`git commit` 正常。前提是 shell 的 `HOME` / `TMPDIR` 指到本单目录，否则 git 读 `~/.gitconfig` 遇到 EPERM 直接 fatal。

能防：路 ① 和路 ②（上面这组实测）。没有一次性准备，不要管理员权限，不装任何东西；每条命令的额外开销可以忽略。

不能防 / 局限：
- **同一 OS 用户**：seatbelt 一旦被突破（内核或沙箱漏洞），进程就是出借方本人。`sandbox-exec` 已被 Apple 标为弃用，但仍随系统发布、仍在修，Codex 官方也在用。
- **launchd 与 LaunchServices**：沙箱里 `launchctl print`、`lsappinfo` 都能用。`launchctl kickstart` / `bootstrap` 对不存在目标的报错和宿主上一样。
  基础策略没有放行 `job-creation` / `lsopen`（§10.5），按 SBPL 语义提交任务、拉起 App 都会被拒；但真正提交一个任务会改 launchd 状态，本卡**没测**，
  留给 W8a 当闸门，见 §7.4。
- **沙箱外的东西不受约束**：app-server 自己做的事（apply_patch、view_image 等内建工具是否也走沙箱，要 W8a 实测）、所有 MCP server、notify / hooks。
  所以必须换专用 CODEX_HOME，只挂 channel-server。
- `/etc`、`/Applications` 由基础策略放行，deny 盖不掉（实测给 `/private/etc/pf.anchors` 加 deny 后仍然能列）。
  `/etc` 里的 pf 锚点和 hosts 能读到，所以 `/etc` 下不要放秘密。
- ACP 路径今天每一轮都下发旧版 `sandboxPolicy`（codex-acp 2.0.0 的四种模式：read-only / workspace-write / agent 都是旧版 `workspaceWrite`、
  全盘可读；agent-full-access 是 dangerFullAccess）。app-server 的协议里有 `permissionProfile`（二进制里的字符串），但 codex-acp 没有用它。
  要让权限档生效，就得改 codex-acp 的调用（本仓按哈希锁定了安装，可以带补丁版）或者换一种起法，见 W8a。

对 Codex 的影响：模型请求仍由 app-server 发，登录不进沙箱。换专用 CODEX_HOME 后要单独登录一次（§7.3）。

## 5. 方案 C：容器或虚拟机

本机现状：已经装了 colima，VZ 虚拟机在跑（2 CPU / 2 GiB 内存 / 100 GiB 磁盘，给别的服务用）；有 `oven/bun:1.3.14` 镜像（335 MB）；
没有 Apple `container`；也有 Lima，但没有 Lima 实例。

实测（§10.6）：
- 只挂本单目录、`--network none`：容器里看不到 `/Users`，bun 跑得起 TS，也连不到宿主回环。
  虚拟机已经在跑的情况下，`docker run --rm` 冷启约 1.6 s、热启约 0.25 s。
- **缺省网络能直达宿主回环**：容器里用 `host.docker.internal`、`host.lima.internal` 或 Lima 网关地址都能连上 bridge 端口和嵌入服务端口。
  Lima 的网关就映射到宿主的 127.0.0.1，所以一旦开网，路 ① 立刻打开。

能防：`--network none` 加只挂本单目录时，路 ① 和路 ② 在容器边界处都关上了，而且不依赖同一用户下的 seatbelt。

不能防 / 代价：
- **Codex 的位置两难**：
  - 放在容器里：要联网发模型请求（开网就能到回环，除非在 VM 里另加 iptables），登录也要放进容器，同一容器里的 shell 读得到（除非在容器里再套 Codex 的 Linux 沙箱）。
  - 放在宿主、只把命令送进容器：Codex 0.159 二进制里有 exec-server / remote environment 的字符串，但没有文档化的用法，**未验证**。
- **MCP 回传**：容器里的 channel-server 要连宿主的回环代理，和 `--network none` 冲突。
- **colima 的 VM 默认挂着家目录**（`mounts: []` 表示用缺省挂载）。容器一旦逃逸到 VM，就能看到出借方家目录；Docker socket 是出借方的，绝不能给 worker。
  要隔离就得另起一个只挂出借目录的 colima profile：多常驻约 2 GiB 内存，外加镜像和磁盘。本机剩余约 18 GiB，别的出借方机器可能根本没装 colima。
- **Apple container**（macOS 26 起支持）：一个容器一个轻量 VM，边界更强。但要装 pkg（管理员权限）并下载内核和镜像，本卡按约束没装，也没测。
- 代码进出：进是挂载 clone；出是在挂载目录里写 bundle 或报告。审查报告和写单结果都经挂载目录交回，宿主侧按外来文件处理。

一次性准备：装容器运行时和镜像（Apple container 需要管理员权限）。对 Codex 的影响同上：要么容器里再登录一份，要么依赖未验证的远端执行。

## 6. 对比

| | 路 ① 回环 | 路 ② 读凭据 | Codex 登录不交 worker | 一次性准备 | 每单代价 | 已实测 |
|---|---|---|---|---|---|---|
| A 独立用户（单用） | 不关（要改 bridge 或 pf） | 关，但要求家目录不组可读 | 不满足（登录只能放进专用用户） | 要 admin | sudo 起进程、跨用户交接文件 | 只测了权限现状 |
| B 缺省沙箱 | 关 | **不关**（全盘可读） | 满足 | 无 | 可忽略 | 是 |
| **B+ 命名权限档** | 关 | 关 | 满足 | 无（登录点按钮） | 可忽略 | 是（launchd 提交除外） |
| C 容器 | 只在无网时关 | 关 | 不满足或依赖未验证能力 | 装运行时（Apple container 要 admin） | VM 内存、0.25–1.6 s 启动 | 是（colima） |
| B+ 再叠 A（二期） | 关（再加 bridge token） | 关，两层 | 满足 | 要 admin | sudo + 交接 | 部分 |

## 7. 推荐方案：B+（一期），A 二期纵深

### 7.1 构成

1. **专用 CODEX_HOME**：`statePath("lend","codex-home")`，0700。config.toml 由代码生成，内容只有：
   - claudestra（lend 档 channel-server）一个 MCP；
   - 没有 notify / hooks / 插件 / skills / 记忆 / 全局 AGENTS.md；
   - `default_permissions = "lend"`；
   - `shell_environment_policy.inherit = "none"`，`set` 只给 PATH / LANG，以及指向本单目录的 HOME / TMPDIR，宿主回环代理的 `BRIDGE_URL` 不会传给 shell。
   实测：用空 CODEX_HOME 时 `codex mcp list` 是空的；用出借方 `~/.codex` 时是 4 个，3 个启用。按名字逐个关（`-c mcp_servers.<名>.enabled=false`）能生效，
   但插件会动态加 server（实测多出一个 config.toml 里没有的），名单式关不全，所以用白名单式的专用目录。
2. **本单目录**：`statePath("lend",<单>)/{repo,home,tmp,out}`，可写根就是本单目录，`repo/.git` 可写，worker 自己 commit。
   读根按启动时 `PATH` 里 bun / git 的实际位置和 `xcode-select -p` 生成；deny `/private/tmp`、`/private/var/folders`、专用 CODEX_HOME。审查单用同一个权限档。
3. **网络全关**。依赖由出借服务在 worker 起来之前装好：
   - 用另一个联网的权限档（读限制相同，可写的只有本单目录），`bun install --frozen-lockfile --ignore-scripts`，加 `--config=/dev/null`；
   - 安装前删掉 clone 里的 `.npmrc` / `bunfig.toml`；
   - 只接受 lockfile 里来源全是公共 registry 的仓库。
   联网档能连回环（实测 `network.enabled=true` 下回环可达，`mode="limited"` 在 `codex sandbox` 里没起代理），所以这一步不执行任何外来代码。残余风险见 §7.4。
4. **结果导出**：
   - worker 的 `.git` 按敌意对待，出借服务**不在沙箱外**以它为仓库跑 git（fsmonitor、hooks、配置都可能被改）；
   - 先在同一个读限制档里跑 `git bundle create out/<单>.bundle <base>..<head>`；
   - 再在推送目录里 `git bundle verify` + `git fetch <bundle>`，然后照 lend-push.ts 现在的规矩推送。
5. **写单回写走 MCP `deliver`**（lend 档已经有 `take_order` / `deliver`，W4 在绑定里拒了写单）。沙箱里的 shell 跑不起 `manager lend submit`，也不该能跑。
6. **ACP 下发权限档**：codex-acp 每轮带 `permissionProfile`（或不带 sandboxPolicy，让 `default_permissions` 生效），approval 用 never。
   用补丁版 codex-acp（沿用安装时的哈希锁定），还是改走别的起法，由 W8a 定。

### 7.2 两条路怎么关、依据在哪

| 路 | 关法 | 依据 |
|---|---|---|
| ① shell 开 ws 连 bridge 端口 | 权限档 `network.enabled=false`：TCP 回环被拒 | §10.2「loopback connect=no」 |
| ① 经 unix socket 控制本机（tmux、SSH agent） | 基础策略不放行 AF_UNIX 连接 | §10.3 tmux-master=denied、ssh-agent rc=2（宿主 rc=0） |
| ① 经沙箱外进程转发 | 只挂 lend 档 channel-server；代理只转 5 个工具；bridge `lendFrameGate` | W4（caller-identity.md）＋ §7.1-1 白名单式 CODEX_HOME |
| ② 读出借方文件 | `:minimal` 读集外一律拒；`/tmp` 等显式 deny | §10.2 / §10.4：auth.json、peers.json、instance-key.pem、.env、.gitconfig 均 open=no |
| ② 用钥匙串 / SSH agent / git 凭据助手 | 读集外 + 不放行 AF_UNIX；钥匙串文件读不到 | §10.3：keychain-info rc=37（宿主 0）；`~/Library/Keychains` 列不出 |
| ② 读别的进程环境 / 发信号 | 基础策略 `process-info*` / `signal` 只放行同沙箱 | §10.3 ps-E=no、signal-host-proc=no |
| ② 读出借方 Codex 登录 | 登录只在 app-server（沙箱外）；专用 CODEX_HOME 显式 deny | §10.2 `.codex/auth.json` open=no |

### 7.3 Codex 登录与额度

- 专用 CODEX_HOME 单独登录一次。Codex 的登录按 CODEX_HOME 分开存（文件模式是 `<CODEX_HOME>/auth.json`；
  钥匙串模式按 CODEX_HOME 路径的哈希分条目），刷新链和出借方主登录互不影响。
- 不让本人敲命令：网页「出借登录」按钮 → 服务以专用 CODEX_HOME 跑 `codex login --device-auth`（0.159.3 的帮助里有这个选项），
  把验证网址和一次性码显示在网页上，owner 在浏览器里确认就行。也可以在网页表单里填 API key，经 stdin 交给 `codex login --with-api-key`。
  有的 ChatGPT 工作区要管理员先开设备码登录，开不了就只能走 API key。
- **不把 auth.json 交给 worker**：只有沙箱外的 app-server 读它；shell 读不到（实测出借方 `~/.codex/auth.json` open=no，专用目录也在 deny 里）。
  收回：网页按钮 `codex logout`（只作用于专用目录）。
- 额度：同一个 ChatGPT 账号再登录一份，用的还是出借方套餐的同一池额度，和今天出借的行为一致；也可以换账号或 API key 单独计费（§9-2）。

### 7.4 残余风险（推荐方案也防不住的）

- seatbelt 被突破之后就是出借方本人（同一 OS 用户）。这正是二期 A 要补的。
- launchd 提交任务、LaunchServices 拉起 App 是否真被拒，本卡没实测（会改 launchd 状态）。**W8a 的闸门**：
  在测试机上从 lend 档沙箱里提交一个一次性任务并拉起 App，确认都被拒，然后清理。如果哪一项没被拒，**写单不开**，等二期 A。
- app-server 内建工具（view_image、apply_patch 等）是否遵守权限档，W8a 要实测；不遵守的就在生成的 config 里关掉。
- 依赖安装那一步联网、沙箱里能到回环：只靠「不执行外来代码」（`--ignore-scripts`、不读 clone 的 bunfig / npmrc）来兜底。
- `/etc`、`/Applications` 可读；出借方的 pf 锚点里有对端地址，算低敏信息。
- 公开仓库的提示注入照样存在，但注入之后能做的事被限制在本单目录和 5 个派单工具里。

## 8. 实现节点（供 PM 加进子 DAG）

| 节点 | 一句话 | 依赖 | 文件范围 | 验收线 |
|---|---|---|---|---|
| W8a | 闸门 spike：ACP 路径能按回合下发 lend 权限档 + 逃逸探针 | — | `scripts/lend-isolation-probe.ts`（新）、`src/lib/acp/install.ts`、`src/lib/acp/adapter-proc.ts`、补丁版 codex-acp | 真 Codex 出借 worker 的 shell 复现 §7.2 全表；launchd 提交和 App 拉起被拒；view_image / apply_patch 越界被拒；探针输出归档到报告 |
| W8b | 出借专用 CODEX_HOME + 网页登录按钮（审查单也切过去） | — | `src/lib/lend-codex-home.ts`（新）、`src/lib/runtimes/clean-env.ts`、`src/lib/acp/adapter-proc.ts`、`src/lib/doctor-lend.ts`、`src/lib/lend-beat.ts`、网页设置面板 | `codex mcp list` 在专用目录下只有 claudestra；没登录时按 not_started 拒起 worker；出借方 `~/.codex` 一个字节不改；doctor 显示登录状态 |
| W8c | 权限档生成 + 本单目录布局（审查单 / 写单共用） | W8a、W8b | `src/lib/lend-sandbox-profile.ts`（新）、`src/lib/lend-clone.ts`、`tests/lend-sandbox-profile.test.ts` | 读根按 PATH 生成并有单测；探针在真 worker 里通过；`/tmp`、专用 CODEX_HOME 有 deny |
| W8d | 依赖预装与 bundle 导出 | W8c | `src/lib/lend-push.ts`、`src/lib/lend-deps-install.ts`（新）、`tests/lend-write.test.ts` | clone 里放恶意 hooks / fsmonitor / 配置 / npmrc / bunfig 都不会被执行；沙箱外不以 worker 的 `.git` 为仓库跑 git；registry 不是公共源的仓库拒领 |
| W8e | 开放写单 | W8a–W8d、§9-1 拍板 | `src/lib/lend-tools.ts`、`src/lib/lend-policy.ts`、`docs/design/remote-capacity.md` §5、`docs/architecture/caller-identity.md` | 写单走 take_order / deliver；隔离档没生效或探针没过就拒；文档里「做不到」更新为新边界 |
| W8f（二期，可选） | 专用系统用户 + bridge 回环凭据 | W8e、§9-4 拍板 | 另出规格 | 另定 |

## 9. 要 owner 拍板的事

1. **路线**：
   - 采纳「B+ 一期就开写单，A 二期」（推荐）；
   - 或「A + B 都做完才开写单」；
   - 或「写单暂不开，只做 W8b / W8c 加固审查单」。
2. **出借用的 Codex 登录与额度归属**：
   - 同一 ChatGPT 账号再登录一份，额度共用，和现状一致（推荐）；
   - 或另一个账号；
   - 或 API key 单独计费。
3. **写单要不要支持需要装依赖的仓库**：要支持就接受 §7.4 的联网安装残余风险；不支持就只领不用装依赖的单。
4. **二期 A 要不要做**：
   - 建不建专用系统用户；
   - 一次性管理员授权用哪种方式：给「不用 osascript」开一个例外、弹系统授权框，还是另做签名助手；
   - 用 bridge 回环 token 还是 pf 按用户过滤（pf 方案未实测）。
5. 一期**不需要**改 pf、launchd、用户账户，也不用装软件；现有 bridge 端口的 pf 锚点不动。

## 10. 附：只读探测输出（路径已脱敏：`~` = 出借方家目录，`<ws>` = 临时工作目录）

10.1 宿主直跑 vs `codex sandbox` 缺省档：

```
                                  宿主            缺省沙箱
.codex/auth.json                  open=yes        open=yes
.claude-orchestrator/peers.json   open=yes        open=yes
.claude-orchestrator/instance-key open=yes        open=yes
.ssh / .gitconfig / 仓库 .env      yes             yes
Library/Keychains list            yes             yes
loopback:bridge-port connect      yes             no
```

10.2 lend 权限档（`:minimal` 读 + 工具链读 + 工作区写）：

```
.codex/auth.json: open=no   .claude-orchestrator/peers.json: open=no   instance-key.pem: open=no
.gitconfig: open=no   仓库 .env: open=no   .ssh list=no   Keychains list=no
workspace write=yes   home write=no   loopback connect=no   bun runs=yes
git（HOME/TMPDIR 指到工作区）: commit-ok；不改 HOME 时：fatal: unable to access '~/.gitconfig': Operation not permitted
.git 在可写根顶层：index.lock Operation not permitted（Codex 默认保护）；显式给 <repo>/.git 写权限后 commit-ok
```

10.3 socket、钥匙串、进程（同一个 lend 档；右边是宿主）：

```
tmux-master=denied（宿主 connect）   ssh-agent rc=2（宿主 0）   default-keychain-info rc=37（宿主 0）
pg/嵌入服务端口=no   公网=no   ps-E=no   signal-host-proc=no
launchctl print=yes   lsappinfo=yes   kickstart/bootstrap 不存在目标的报错与宿主相同（未做真实提交）
```

10.4 `/tmp` 与 `/etc`：

```
:minimal 下 other-scratch-list=yes（能列其他会话的临时目录）→ 加 "/private/tmp"="deny" 后 =no，工作区仍可写
"/private/etc/pf.anchors"="deny" 后仍 pf-anchors=list（基础策略放行 /private/etc，deny 盖不掉）
network.enabled=true, mode="limited"：raw-loopback=yes（codex sandbox 未起代理）
```

10.5 codex-cli 0.159.3 seatbelt 基础策略摘录（二进制字符串）：

```
(deny default) (allow process-exec) (allow process-fork)
(allow signal (target same-sandbox)) (allow process-info* (target same-sandbox))
(allow file-read* (subpath "/private/etc")) (allow file-read* (subpath "/Applications"))
mach-lookup 白名单：dirhelper / opendirectoryd / SecurityServer / trustd / cfprefsd / logd / notification_center …（未见 job-creation、lsopen 的放行）
```

10.6 colima（VZ，已在跑），`oven/bun:1.3.14`，`--rm --pull never`：

```
--network none, 只挂 <ws>：sees-host-users=no  bun-ts=ok  host-loopback=no  wall=1.60s / 0.26s / 0.25s
缺省网络：host.docker.internal:3847 connect  host.lima.internal:3847 connect  网关:3847 connect  网关:嵌入服务端口 connect
```

10.7 权限现状：`~` drwxr-x---（属主出借方、组 staff）；`~/.gitconfig` 0644；`~/.claude-orchestrator` 0755，前两层 503 个文件组 / 其他人可读（含 peer-keys.json 0644），
15 个不可读；peers.json、instance-key.pem、auth.json、仓库 `.env` 均 0600；`~/.ssh` 0700；本机 uid ≥ 500 的本地用户只有出借方一个，没有出借专用用户。

参考：Codex 配置参考 `learn.chatgpt.com/docs/config-file/config-reference`（permissions / default_permissions / shell_environment_policy）；
Codex 认证文档 `developers.openai.com/codex/auth`（cli_auth_credentials_store、按 CODEX_HOME 分存）；Apple container `github.com/apple/container`。
