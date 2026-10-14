/**
 * The explicit half of affected-test selection (merge-arch-IMPACT1): what the import graph cannot know, written down by hand.
 * - FULL_TRIGGERS: a change here always means the full suite (lockfiles, toolchain, discovery / sharding, workflow, guard, config).
 * - ALWAYS_RUN: tests run on every selection, whatever changed.
 * - INPUT_MAP: non-module files (fixtures, snapshots) → the modules that read them; selection continues from those modules.
 * - IMPLICIT_INPUTS: modules outside tests/ that read / walk / spawn at all (literal, variable or argument path alike), and modules
 *   anywhere that load a non-literal path; each names the repo files it really depends on (added as graph edges; [] = only external
 *   binaries, packages or runtime paths). A test-reachable module that does this and is not listed here sends the whole batch to
 *   full (ci-impact-select.ts) — so until the rest of the repo's io modules are registered, real batches mostly fall back to full.
 * - KNOWN_UNRESOLVED: specs that resolve to nothing on purpose (build-time generated files).
 * Adding a row is the review: say why in one line. tests/ci-impact-select.test.ts.
 */
interface FullTrigger { glob: string; why: string }
interface InputMapping { inputs: string; consumers: readonly string[]; why: string }
interface ImplicitInput { module: string; deps: readonly string[]; why: string }
export interface ImpactInputs {
  fullTriggers: readonly FullTrigger[];
  alwaysRun: readonly { test: string; why: string }[];
  inputMap: readonly InputMapping[];
  implicit: readonly ImplicitInput[];
  knownUnresolved: readonly { spec: string; why: string }[];
  docs: readonly string[];
}

const FULL_TRIGGERS: readonly FullTrigger[] = [
  { glob: "**/package.json", why: "依赖清单" },
  { glob: "**/bun.lock", why: "锁文件" },
  { glob: "**/bun.lockb", why: "锁文件" },
  { glob: "**/package-lock.json", why: "锁文件" },
  { glob: "**/tsconfig*.json", why: "工具链：模块解析 / 别名" },
  { glob: "**/bunfig.toml", why: "工具链：测试 preload 与发现" },
  { glob: ".bun-version", why: "工具链版本" },
  { glob: ".tool-versions", why: "工具链版本" },
  { glob: ".gitignore", why: "git ls-files 即测试发现的输入" },
  { glob: ".gitattributes", why: "全局仓库配置" },
  { glob: ".gitmodules", why: "子模块" },
  { glob: ".github/**", why: "workflow" },
  { glob: "tests/preload.ts", why: "每个测试文件先跑的全局 preload" },
  { glob: "src/lib/sync-fs-trace.ts", why: "bunfig 顶层 preload" },
  { glob: "scripts/ci-test-shard.ts", why: "测试发现 / 分片" },
  { glob: "scripts/ci-proof-artifact.ts", why: "CI 覆盖证明" },
  { glob: "scripts/guard/**", why: "guard 本身" },
  { glob: "scripts/skip-effects.ts", why: "guard 类检查" },
  { glob: "src/lib/ci-impact-*.ts", why: "选择器自己改了不能拿它自己证明" },
];

const ALWAYS_RUN = [
  { test: "tests/guard.test.ts", why: "guard 规则自测" },
  { test: "tests/guard-dropped.test.ts", why: "guard 规则自测" },
  { test: "tests/skip-effects.test.ts", why: "效果点清单与全仓扫描" },
  { test: "tests/repo-root.test.ts", why: "全仓扫描仓库定位写法的白名单" },
  { test: "tests/ci-test-shard.test.ts", why: "测试发现 / 分片" },
  { test: "tests/ci-impact-graph.test.ts", why: "选择器自测" },
  { test: "tests/ci-impact-select.test.ts", why: "选择器自测" },
] as const;

const fixture = (name: string, consumers: string[]) => ({ inputs: `tests/fixtures/${name}`, consumers: consumers.map((t) => `tests/${t}.test.ts`),
  why: "按 fixtures/<名> 字面量查得的读者" });
const INPUT_MAP: readonly InputMapping[] = [
  fixture("cc-bypass-consent-pane.txt", ["send-key-guard", "lp-state", "modal-numbered-options", "modal-parser", "modal-confirm"]),
  fixture("codex-app-server/**", ["codex-adapter-schema", "adapter-proc-stderr"]),
  fixture("codex-rollout-tui.jsonl", ["codex-session-items"]),
  fixture("e2e-vectors.json", ["e2e-vectors"]),
  fixture("hpke-p256-aes256.json", ["e2e-hpke"]),
  fixture("ledger-acpt3-adversarial.json", ["ledger-merge-gate-scheduler-adv"]),
  fixture("ledger-legacy.json", ["manager-ledger-import"]),
  fixture("ledger-read-reviews-adva1.json", ["ledger-read-reviews-scheduler"]),
  fixture("lp/**", ["ctx-boundary-lp", "fleet-runner", "inject-lock", "lp-state", "quota-wall-runtime"]),
  { inputs: "tests/fixtures/pi-rpc-0.99.1.jsonl", consumers: ["tests/pi-acp-replay.test.ts", "tests/peer-pr-surface.test.ts", "tests/acp-contract/pi-replay.ts"],
    why: "按文件名字面量查得的读者（含 acp-contract 驱动）" },
  fixture("quota-wall/**", ["busy-windows", "ctx-boundary-inject", "ctx-boundary-policy", "ctx-boundary", "held-idle-batch-flush", "interrupt-gate",
    "limit-menu", "pm-digest", "quota-audit-resume-facts", "quota-audit-resume", "quota-wall-text", "stop-settle-wf2", "turn-zone"]),
  fixture("switch-confirm/**", ["restart-expect-restore-cli", "switch-confirm"]),
  fixture("turn-zone/**", ["pane-main-turn", "quota-wall-text", "turn-zone", "send-key-guard", "modal-confirm"]),
  { inputs: "tests/__snapshots__/order-wire-render.test.ts.snap", consumers: ["tests/order-wire-render.test.ts"], why: "bun 快照" },
];

const ext = (module: string, why: string): ImplicitInput => ({ module, deps: [], why });
/** tests/ code loading a temp copy it wrote itself; it reads the repo too, so it is always-run anyway. */
const tmpCopy = (name: string) => ext(`tests/${name}.test.ts`, "import 的是自己写到临时目录的副本");
/** web tests that import web modules through a path helper (`mod("x.tsx")`, a URL constant, an alias string). */
const webLoader = (name: string): ImplicitInput => ({ module: `tests/${name}.test.ts`, deps: ["web/**"], why: "经路径变量 import web 模块" });
const IMPLICIT_INPUTS: readonly ImplicitInput[] = [
  ext("scripts/acp-stub.ts", "子进程 argv 来自它收到的命令；cwd 只是透传"),
  { module: "scripts/bridge-memory-probe.ts", deps: ["src/bridge/event-bus.ts", "src/bridge/bg-activity-watcher.ts", "src/lib/jsonl-cost.ts", "src/lib/agent-stats.ts"],
    why: "按仓库根动态 import 这几个固定文件" },
  { module: "scripts/ci-proof-artifact.ts", deps: [], why: "读 CI 下载的分片目录与 git；本身是全量触发" },
  ext("scripts/guard/rules/fn.ts", "动态 import 的是 oxc-parser 包名"),
  { module: "scripts/ledger-import-deps.ts", deps: ["src/manager.ts"], why: "子进程跑 src/manager.ts" },
  { module: "scripts/scheduler-memory-probe.ts", deps: ["src/lib/**"], why: "按名字动态 import src/lib 下模块" },
  { module: "scripts/skip-effects.ts", deps: ["src/lib/**"], why: "按文件名读 src/lib 源码" },
  ext("src/bridge/api-routes.ts", "readdir 的是运行时归档目录；动态 import 都是字面量"),
  { module: "src/bridge/bg-jobs-http.ts", deps: ["src/manager.ts"], why: "bash 子进程跑 src/manager.ts" },
  ext("src/bridge/local-api/version.ts", "git rev-parse，只读 git 元数据"),
  ext("src/bridge/relay-link.ts", "读运行时 .env（不入库）"),
  { module: "src/bridge/screenshot.ts", deps: ["src/html2png.ts"], why: "子进程跑 src/html2png.ts，其余是外部命令" },
  ext("src/channel-server.ts", "tmux 外部命令；仓库根只拼进给 agent 的说明文字"),
  { module: "src/cron.ts", deps: ["src/manager.ts"], why: "子进程跑 src/manager.ts；其余读运行时状态" },
  ext("src/lib/acp/adapter-proc.ts", "适配器入口已是字面量 URL 边；其余是外部 codex 进程"),
  { module: "src/lib/acp/codex-adapter/main.ts", deps: ["src/lib/acp/codex-adapter/*.ts"], why: "给本目录 .ts 源码算哈希" },
  { module: "src/lib/acp/codex-compat-lock.ts", deps: ["tests/fixtures/codex-app-server/**"], why: "读锁文件目录；子进程是外部 codex" },
  ext("src/lib/acp/pi-adapter/mcp-mount.ts", "动态 import 的是 Pi 包名"),
  { module: "src/lib/acp/stub.ts", deps: ["scripts/acp-stub.ts"], why: "按真实路径认本仓 stub" },
  { module: "src/lib/agent-lifecycle-deps.ts", deps: ["src/manager.ts"], why: "子进程跑 src/manager.ts；du 是外部命令" },
  ext("src/lib/caller-witness.ts", "ps 外部命令与 cwd"),
  { module: "src/lib/card-role-definitions.ts", deps: [".claude/agents/**"], why: "读仓库 .claude/agents 角色定义" },
  { module: "src/lib/codex-auto-update.ts", deps: ["src/manager.ts"], why: "子进程跑 src/manager.ts；读运行时状态" },
  ext("src/lib/dag-write-scrub.ts", "git / gh 查询提交，只读 git 元数据"),
  ext("src/lib/env-file.ts", "读运行时 .env（不入库）"),
  { module: "src/lib/github-release.ts", deps: ["package.json"], why: "读 package.json 版本；git remote 是元数据" },
  { module: "src/lib/instance-tag.ts", deps: ["package.json"], why: "读 package.json 版本" },
  ext("src/lib/lend-claude-worker-host.ts", "起的是 claude 外部进程，路径来自启动计划"),
  { module: "src/lib/lend-claude-worker.ts", deps: ["src/channel-server.ts", "src/lib/lend-claude-worker-host.ts"], why: "启动计划里子进程跑这两个文件" },
  { module: "src/lib/lend-deps.ts", deps: ["src/manager.ts"], why: "子进程跑 src/manager.ts" },
  { module: "src/lib/lend-update-gap-host.ts", deps: ["src/lib/recovery-policy.ts"], why: "动态 import CFG 读取器" },
  { module: "src/lib/peer-ingress-config.ts", deps: ["web/package.json"], why: "读 web/package.json；.env 是运行时文件" },
  ext("src/lib/peer-trust.ts", "stat 运行时 .env"),
  ext("src/lib/pi-env-snapshot.ts", "动态 import 的是 Pi 包名"),
  ext("src/lib/pm-deploy-lock-gate.ts", "子进程跑的是调用方给的 argv"),
  ext("src/lib/project-dirs.ts", "cwd 只用来判相对路径；realpath 的是用户给的目录"),
  { module: "src/lib/recovery-materials-wiring.ts", deps: ["src/lib/recovery-policy.ts"], why: "动态 import CFG 读取器" },
  ext("src/lib/review-converge-followup.ts", "git ls-tree 调用方给的仓库根"),
  ext("src/lib/review-converge-scope.ts", "git diff 运行时工作树"),
  ext("src/lib/runtimes/codex-deps.ts", "外部 codex / npm 进程"),
  ext("src/lib/sandbox-parent-watchdog.ts", "Worker 跑内联 Blob 源码"),
  { module: "src/lib/scheduler-auto-deps.ts", deps: ["src/manager.ts"], why: "子进程跑 src/manager.ts；其余是运行时检出" },
  { module: "src/lib/scheduler-autostart-deps.ts", deps: ["src/manager.ts"], why: "子进程跑 src/manager.ts；读运行时状态" },
  { module: "src/lib/scheduler-deploy-job.ts", deps: ["src/scheduler.ts"], why: "子进程跑 src/scheduler.ts" },
  { module: "src/lib/scheduler-model-wiring.ts", deps: ["src/lib/recovery-policy.ts"], why: "动态 import CFG 读取器" },
  { module: "src/lib/scheduler-retire-deps.ts", deps: ["src/manager.ts"], why: "子进程跑 src/manager.ts" },
  ext("src/lib/scheduler-review-rebase.ts", "git diff 运行时工作树"),
  { module: "src/lib/shared-ledger-auto-share-run.ts", deps: ["scripts/shared-ledger-auto-share-pass.ts"], why: "子进程跑该脚本" },
  { module: "src/lib/skill-library.ts", deps: ["skills/**"], why: "列仓库 skills/ 目录" },
  { module: "src/lib/team-roles.ts", deps: ["roles/**"], why: "读仓库 roles/ 模板" },
  ext("src/lib/update-status.ts", "git 元数据"),
  { module: "src/manager.ts", deps: ["src/html2png.ts"], why: "截图子进程跑 src/html2png.ts，其余是外部命令" },
  ext("src/manager/ledger-feature-migrate-cmd.ts", "读调用方给的计划文件；仓库根只给 git 查询"),
  ext("src/manager/ledger-review-export-cmd.ts", "cwd 是缺省仓库目录给 git；读的是导出目录"),
  ext("src/manager/lend-submit.ts", "ps / git 外部命令"),
  ext("src/manager/retire-web.ts", "列运行时备份目录"),
  { module: "src/manager/update.ts", deps: ["src/manager.ts", "skills/**"], why: "子进程跑 src/manager.ts migrate；装仓库 skills" },
  { module: "src/manager/web-release.ts", deps: ["web/**"], why: "按 web 源码判过期并重建 / 发布" },
  ext("src/relay/env.ts", "读构建生成的 .relay-commit（不入库）"),
  { module: "src/setup.ts", deps: ["master/CLAUDE.md.template", ".env.example"], why: "读模板；which 是外部命令" },
  { module: "tests/acp-compact-stub.test.ts", deps: ["src/channel-server.ts"], why: "把 channel-server 路径当配置传给 stub 子进程" },
  { module: "tests/api-files-route.test.ts", deps: ["src/bridge/api-routes.ts"], why: "带查询串重载 api-routes.ts" },
  tmpCopy("lend-reborrow-conv"),
  tmpCopy("modal-numbered-options"),
  { module: "tests/push-read-all.test.ts", deps: ["src/bridge/push/routes.ts"], why: "把 git show 出的旧版 routes.ts 打包进缓存目录再 import" },
  tmpCopy("session-history-parse-extraction"),
  tmpCopy("skip-effects"),
  { module: "tests/switch-confirm.test.ts", deps: ["tests/fixtures/switch-confirm/**"], why: "按名读 switch-confirm fixture" },
  webLoader("web-asks-store"),
  webLoader("web-borrow-limit"),
  webLoader("web-dom-agent-list-recovery"),
  webLoader("web-dom-ask-codex-hint"),
  webLoader("web-dom-bg-shell-state"),
  webLoader("web-dom-collab-count"),
  webLoader("web-dom-collab-detail-now"),
  webLoader("web-dom-collab-detail-pause"),
  webLoader("web-dom-collab-edge-meta"),
  webLoader("web-dom-collab-mirror-clock"),
  webLoader("web-dom-collab-team-body"),
  webLoader("web-dom-collab-team-home"),
  webLoader("web-dom-collab-team-session"),
  webLoader("web-dom-collab-waits-page"),
  webLoader("web-dom-notify-section"),
  webLoader("web-dom-peer-scope-filter"),
  webLoader("web-dom-product-panes-loading"),
  webLoader("web-dom-product-panes-narrow-team"),
  webLoader("web-dom-project-pm"),
  webLoader("web-dom-quota-reset"),
  webLoader("web-dom-review-line"),
  webLoader("web-dom-settings-notify-page"),
  webLoader("web-dom-shared-ledger-v2-approve-ui"),
  webLoader("web-dom-shared-ledger-v2-stage2"),
  webLoader("web-dom-sidebar-history-folds"),
  webLoader("web-dom-subdag-focus-jump"),
  webLoader("web-dom-subdag-full-entry"),
  webLoader("web-dom-subdag-work-share"),
  webLoader("web-dom-team-counts-unknown"),
  webLoader("web-dom-team-parity-calls"),
  webLoader("web-dom-team-parity-home-only"),
  webLoader("web-dom-team-project-ask"),
  webLoader("web-dom-team-source-counts"),
  webLoader("web-dom-team-source-focus"),
  webLoader("web-dom-team-work-board"),
  webLoader("web-dom-team-worker-context"),
  webLoader("web-domd-probe"),
  webLoader("web-guard-store"),
  webLoader("web-ledger-meta-guard"),
  webLoader("web-md-guard"),
  webLoader("web-shared-audit-editor-contested"),
  webLoader("web-shared-audit-snapshot"),
  webLoader("web-shared-audit-submit-retry"),
  webLoader("web-shared-audit-submit"),
  webLoader("web-shared-audit-wiring-dom"),
  { module: "tests/web-shared-ledger-browser.test.ts", deps: ["web/**", "tests/helpers/ui-shot-checks.ts"], why: "基线 web 目录来自环境变量" },
  webLoader("web-term-font-fit"),
  webLoader("web-unread-race"),
  ext("web/components/domd/prism.ts", "动态 import 的是 prismjs 包内语言"),
  { module: "web/public/boot.js", deps: ["web/public/hang-worker.js"], why: "按站点根路径起 Worker" },
  ext("web/scripts/dev-proxy.ts", "起 web/node_modules 里的 next，外部包"),
  { module: "web/scripts/gen-build-info.mjs", deps: ["package.json"], why: "读 package.json 版本；git 只读元数据" },
  ext("web/scripts/resolve-stack.mjs", "读构建产物里的 source map（不入库）"),
];

export const DEFAULT_IMPACT_INPUTS: ImpactInputs = {
  fullTriggers: FULL_TRIGGERS,
  alwaysRun: ALWAYS_RUN,
  inputMap: INPUT_MAP,
  implicit: IMPLICIT_INPUTS,
  knownUnresolved: [
    { spec: "@/lib/build-info", why: "web 构建前由 web/scripts/gen-build-info.mjs 生成，不入库" },
    { spec: "/hang-worker.js", why: "站点根路径，即 web/public/hang-worker.js（IMPLICIT_INPUTS 记了这条边）" },
  ],
  docs: ["**/*.md", "docs/**", "LICENSE", "**/*.LICENSE.txt"],
};

const globCache = new Map<string, InstanceType<typeof Bun.Glob>>();
/** Bun's glob, cached; `**` crosses directories, a leading `**\/` also matches top-level files. */
export function globMatch(glob: string, path: string): boolean {
  let g = globCache.get(glob);
  if (!g) globCache.set(glob, (g = new Bun.Glob(glob)));
  return g.match(path) || (glob.startsWith("**/") && globMatch(glob.slice(3), path));
}
