# rename.repo:仓库转移核对清单

公共仓 `shawnlu96/claudestra` 转移到新组织(建议 `floka-ai/floka`)前后要逐项人工核的事。
本地工具 [`repo-preflight.ts`](repo-preflight.ts) 只迁本机 checkout 的 origin,**不连 GitHub、不做转移、不发版**;
它在 observe 输出的 `prerequisites` 就是下面这张表的 id,状态恒为 `manual`。

## 开关与本地行为

| `rename.repo` | 行为 |
| --- | --- |
| `off`(缺省) | 一次 git 都不调 |
| `observe` | 只读本仓 remote 原值,出计划:要改的值、不动的值与原因、先决条件;零 Git 写入 |
| `on` | 交回 observe 的计划;remote 与计划时不一致就拒绝。原值先写进 `<git 公共目录>/floka-repo-migration.json`,再改 origin |

- 只迁 `origin`,且只迁**精确等于**旧官方地址的值:`https://github.com/shawnlu96/claudestra(.git)`、
  `git@github.com:shawnlu96/claudestra(.git)`、`ssh://git@github.com/…`、`ssh://git@ssh.github.com:443/…`。
  SSH 还是 SSH、HTTPS 还是 HTTPS,端口与 `.git` 后缀原样。origin 的 pushurl 同理。
- fork、`upstream` 等额外 remote、带凭据 / 自定义 / 大小写不同的地址一律不动,列进 `untouched`。
- 目标不能是 `floka-ai/cloud`(N7C 私仓):公共仓转到独立新仓,不并进 cloud。私仓闭包 pin 另核。
- 本地 cwd、worktree、hooks 路径都不搬(仓库目录名不变)。

```bash
bun scripts/rename-floka/repo-preflight.ts --mode observe --repo ~/repos/claudestra > /tmp/repo-plan.json
bun scripts/rename-floka/repo-preflight.ts --mode on --repo ~/repos/claudestra --plan /tmp/repo-plan.json
bun scripts/rename-floka/repo-preflight.ts --mode on --repo ~/repos/claudestra --rollback
```

## 回滚边界

本地回滚只把 origin 放回记录里的原值;当前值既不是迁移写的新值也不是原值(有人改过)就拒绝,一处不写。
**GitHub 上的反向转移不能由本地配置完成**,要 owner 在 GitHub 网页上另做,且旧名可能已被占用(见 `old-name.squat`)。

## 安装与自动更新

- `install.sh` 的 `CLAUDESTRA_REPO` 缺省值与 `src/lib/floka-repo/migrate.ts` 的 `OFFICIAL_REPO` 同一提交改,测试逐字核。
  转移完成、owner 批准之前不改缺省值(新仓还不存在)。
- 自动更新(`src/lib/github-release.ts`)每次现读 origin 认仓库;install.sh 的 sed 与它同义(`releaseSlugOf`),
  测试拿同一组地址对两边,并用 fake curl / fetch 证明同一个新地址解析出同一个 release API。
- 没迁 origin 的机器靠 GitHub 重定向继续能更新;重定向不是保证(旧名被重新占用就断)。

## GitHub 侧先决条件(逐项人工核)

| id | 核什么 |
| --- | --- |
| `org.permissions` | 目标组织存在;转移人在源仓 admin、在目标组织有建仓权限;成员 / team 权限在新组织重新授予 |
| `org.separate-cloud` | 目标是独立新仓,不是 `floka-ai/cloud`,也不并入它;私仓闭包 pin 另核 |
| `apps.integrations` | GitHub App / OAuth App / webhook 在目标组织重新安装授权,回调地址核过 |
| `actions.secrets-runners` | 仓库 / 组织 secrets、variables、environments、自托管 runner 组在新组织可用(组织级的不随仓走) |
| `branch.protection` | 分支保护 / ruleset、必过检查、CODEOWNERS 转移后逐条核 |
| `deploy.permissions` | deploy key、部署权限、`GITHUB_TOKEN` 权限、environments 审批人 |
| `pages.actions-refs` | Pages 域名;workflow 里写死的 owner/repo、`uses:` 引用;README / SETUP / desktop 里的 raw.githubusercontent 安装链接 |
| `releases.tags` | tag / Release 随仓转移;此后每次 tag / Release 仍由 owner 单独审批 |
| `old-name.squat` | 旧名被重新占用(同名新仓 / fork)会让重定向失效:转移后保留占位或监控旧名 |
| `redirect.not-guarantee` | 仓库重定向只覆盖 git / 网页 / API 地址,不等于发布设施(安装脚本、Pages、App、runner)已迁好 |

## 上线顺序(PM)

1. 本卡合入:工具只在 off / observe 可用,不改任何机器。
2. 观察期 24 小时;核完上表与发布设施清单后,PM 另批 `rename.repo` on 与外部转移。
3. 转移由 owner 在 GitHub 上做;之后各机器 observe → on 迁 origin;install.sh 缺省值另提交切换。
