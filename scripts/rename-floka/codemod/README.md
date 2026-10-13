# rename.codemod：带允许表的机械改名

Claudestra → Floka 改名里「可以按文本替换」的那一小部分。清点见 [`../inventory.ts`](../inventory.ts)，迁移说明见
[`docs/migrations/floka.md`](../../../docs/migrations/floka.md)。本目录不改仓库里任何现有文件，也不接启动、合并、调度路径。

## 开关

`rename.codemod` 取 `off` / `observe` / `on`，缺省 `observe`。只从 `--mode` 或显式给的 `--config` 文件读，不读真实状态目录里的配置。

| 值 | 行为 |
| --- | --- |
| `off` | 什么都不做，连目录都不看 |
| `observe` | 扫描并把计划（分类 diff）写到标准输出；不写任何文件；退出码 0，拒绝项看计划里的 `ok` / `rejections` |
| `on` | 把获准的 brand 编辑写进 `--target` 指的临时目录；源目录不动；任何一条拒绝都退出码 1、一个文件都不写 |

```bash
bun scripts/rename-floka/codemod/cli.ts --root .                      # observe，输出 JSON 计划
bun scripts/rename-floka/codemod/cli.ts --root . --format diff        # 同一份计划，给人看的写法
bun scripts/rename-floka/codemod/cli.ts --root . --mode on \
  --plan /tmp/floka-plan.json --target "$(mktemp -d)" --rules brand.display-docs,brand.display-comments
```

`on` 的三样必须显式给：`--plan`（先前 observe 出来、人看过的那份）、`--target`（已存在、在系统临时目录里、和扫描根互不包含）、
`--rules`（获准的规则 id，只能是 brand 类）。目标根里只出现被改写的文件；已有逐字相同的文件就跳过，内容不同就拒绝。

## 三类规则（`rules.json`）

- **history**：保留，只在计划的 `kept` 里计数。
- **protocol**：只列进 `manual`，等人工做兼容（双读、双认、迁移步骤）。这里不替换。
- **brand**：唯一可执行的一类。一条规则必须写明 `files`（不许通配全仓）、`positions`（词法位置）、`match`、`replace`（旧写法 → 新值），缺一样整张表作废。

一处旧名只要有 history / protocol 规则认领，就轮不到 brand，不比匹配长短。另有一层换表也松不掉的保护：写死在 `rules.ts` 的协议形状
（环境变量、签名用途、HTTP 头、MCP 前缀、反向域名 label、状态目录、cookie / 存储键、网络地址、身份句柄），加上自带 `rules.json` 里
每一条 history / protocol 规则（含按路径整份认下的文件）。`--rules-file` 换进来的表里，brand 规则认领到它们时记
`brand_over_protocol` / `brand_over_history` 拒绝。文件名里的旧名一律列为 `builtin.path-rename` 待人工（改文件名是 `git mv`）。

词法位置：JS / TS 用 oxc-parser 分出 `comment` / `string` / `jsx-text` / `code`，解析报错的文件位置未知、brand 认领不了；
`.md` 等文档是 `text`；其余文件（JSON、YAML、shell、Swift…）不分，一律 `data`。

## 拒绝执行

| kind | 什么时候 |
| --- | --- |
| `unclassified` | 有旧名没有任何规则认领（含计划生成之后才加进来的） |
| `brand_over_protocol` | brand 规则认领到受保护的协议名（写死的形状，或自带 `rules.json` 里任何一条 protocol 规则） |
| `brand_over_history` | brand 规则认领到自带 `rules.json` 里 history 规则保留的名字或文件 |
| `binary_input` | 含 NUL、不是合法 UTF-8 或超过 2 MB 的文件里有旧名 |
| `symlink_escape` | 源里有软链指到扫描根外面 |
| `source_changed` / `rules_changed` | 现在重算的计划和交回的那份 digest 不同（每个命中文件的 sha256 都绑在计划里） |
| `plan_tampered` / `path_escape` | 交回的计划内容和它的 digest 对不上，或路径不是根内相对路径 |
| `target_*` | 目标根没给、不存在、不在临时目录、和根重叠、路径上有软链、已有内容不同的同名文件 |

## 排除名单

计划的 `exclusions` 里是完整名单：`dirNames`（按目录名排除：`.git`、`node_modules`、`Pods`、`vendor`、`.packages`、`.next`、`target`、
`out`、`dist`、`build`、`DerivedData`、`coverage`）、`protectedDirs`（真实状态目录、运行时目录及环境变量指过去的目录，外部安装副本：
`~/.local/bin`、`~/.bun/bin`、`~/Library/LaunchAgents`、`~/.config/systemd/user`、`/Applications/Claudestra.app`、`/opt/claudestra`、
`/etc/systemd/system`、`/etc/nginx`）、`skipped`（这次实际跳过的路径和原因）。扫描根是受保护目录、在它里面或是它的上级时直接拒绝；
例外只有状态目录下面带 `.git` 的检出（出借 worker 的工作副本）。
