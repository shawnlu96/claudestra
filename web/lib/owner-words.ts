/**
 * 给 owner 看的词表（UXTERM1）：阶段、可以开工、任务所在的机器、低优先级、借出。界面上这些叫法只在这里定，
 * 各处的字典键、模型文案都从这里取；owner 对某个词有意见，只改这一个文件。纯数据，不 import React。
 * {x} 是变量，由调用方的 t() / ownerWordsTr 填。
 */

/** 台账阶段（键同 src/lib/ledger-stages.ts 的 STAGES） */
export const STAGE_WORD: Record<string, string> = {
  spec: "规格", restate: "确认需求", build: "开发", review: "审查", fix: "返工", merge: "合并",
  live: "上线", verified: "验证", done: "完成", blocked: "受阻", cancelled: "取消",
};
export const OTHER_STAGE_WORD = "其他";

/** 阶段键 → 词；不认识的键一律「其他」，不把原始英文键露给 owner。Object.hasOwn：键取到 "constructor" 也不摸原型 */
export const stageWord = (key: string): string => (Object.hasOwn(STAGE_WORD, key) ? STAGE_WORD[key] : OTHER_STAGE_WORD);

/** 卡内步骤 */
export const STEP_WORD: Record<string, string> = {
  restate: "确认需求", write: "开发", review: "审查", final_review: "终审", fix: "返工", merge: "合并",
  deploy: "部署", publishing: "交付中", verify: "验证", ui_check: "看界面",
};

export const READY_WORD = "可以开工";

/** 团队项目：任务实际在跑的那台机器（UXTERM2 用） */
export const MACHINE_WORDS = {
  machine: "任务所在的机器",
  otherMembers: "别的机器上的成员",
  syncSection: "同步",
  readOnlyCopy: "只读副本",
  staleMinutes: "{n} 分钟没收到任务所在机器的更新",
  staleHours: "{n} 小时没收到任务所在机器的更新",
  noProgress: "还没收到任务所在机器的进度",
  fresh: "进度是最新的",
  stale: "进度可能不是最新的",
  staleModules: "{n} 个模块的进度可能不是最新的",
  openQuestions: "任务所在的机器上有 {n} 个问题在等回答",
  planOnly: "这里只能看和规划；开工、合并要在任务所在的机器上做",
  fullTextThere: "全文只在任务所在的机器上",
  visibleThere: "只在任务所在的机器上能看", originalThere: "原文只在任务所在的机器上能看", openSessionThere: "会话要在任务所在的机器上打开",
  replayThere: "回放要在任务所在的机器上看",
  planningMachine: "默认由哪台机器规划", boundHere: "项目和任务所在的机器由本机绑定决定，不可改",
} as const;

/** 低优先级徽章与批量面板 */
export const LP_WORDS = {
  badgeExhausted: "低优先级用完",
  badgeWalled: "额度用完，等重置",
  walledTitle: "额度用完，到 {time} 自动继续",
  compactLabel: "转低优先级再压缩",
  onLabel: "开低优先级",
  offLabel: "关低优先级",
  compactLpHint: "额度用完的会话：转低优先级 → 打断自动续跑 → 带保留清单压缩。",
  offHint: "只对开着低优先级的会话发；关着的跳过。",
  compactHint: "带保留清单发 /compact；忙的排队，额度用完又没开低优先级的不发。",
  onHint: "只对额度用完的会话；开着的跳过，忙的不发。",
} as const;

/**
 * 额度（QUOTA1）：顶部额度卡、「今天 · 团队与额度」的额度行、用量看板顶部摘要、低优先级徽章、设置开关共用一套说法。
 * 族名直接写 Claude / Codex；名词只叫「额度」。{family} 由调用方填 Claude / Codex。
 */
export const QUOTA_WORDS = {
  noun: "额度",
  used: "{family} 本周已用 {pct}%",
  warn: "{family} 本周已用 {pct}%，到提醒线了",
  stop: "{family} 本周已用 {pct}%，不再接新活",
  weekOut: "{family} 本周额度用完，{when} 重置",
  sessionOut: "{family} 5 小时额度用完，{when} 重置",
  anyOut: "{family} 额度用完，{when} 重置",
  weekOutNoTime: "{family} 本周额度用完",
  sessionOutNoTime: "{family} 5 小时额度用完",
  anyOutNoTime: "{family} 额度用完",
  recovering: "额度已恢复，正在关菜单、补投消息、续跑",
  credits: "有 {n} 次重置可用，在会话里发 /limit-reset",
  tagWarn: "到提醒线",
  tagStop: "不再接新活",
  tagOut: "用完 · {when} 重置",
  tagOutNoTime: "用完",
  lpOn: "低优先级开着，到 {time}",
  lpOut: "低优先级额度用完",
  lpLabel: "低优先级",
  viewQuota: "看额度",
  viewUsage: "看用量",
  liveTitle: "实时读取额度",
  liveWhere: "额度在「今天 · 团队与额度」看",
  noticeLabel: "额度提醒",
} as const;

/** 借出 / 借入页 */
export const LEND_WORDS = {
  slots: "能同时跑几个",
  grantLine: "同时 {slots} 个 · 每天 {n} 个",
  lentWork: "借出中的活",
  noLentWork: "暂无借出的活",
  stopLine: "不再接新活的线",
  stopped: "已不再接新活",
  overStopLine: "超过不再接新活的线（未执行）",
  warnBelowStop: "提醒线要低于不再接新活的线",
  stopLineNote: "本机 Claude / Codex 各自本周用量到了这条线就不再接新活，在跑的活不受影响",
  warnLineNote: "到了提醒线，能同时跑的数量减半（至少留 1 个；原来是 0 的仍是 0）",
  statusStopped: "已不再接新活，在跑的活照常做完",
  statusObserveStop: "只观察：没停，仍在接新活",
  statusHalved: "仍在接新活，能同时跑的数量已减半",
  statusObserveWarn: "只观察：仍在接新活，能同时跑的数量没减",
} as const;

/** 优先级面板：来源、提示与操作共用 owner 叫法。 */
export const PRIORITY_WORDS = {
  sourceExplicit: "owner 显式登记",
  sourceModule: "跟随所属模块",
  sourceSystem: "系统缺省",
  moduleTitle: "{title}\n模块：{module}",
  noModule: "不属于任何模块",
  unnamedModule: "所属模块名称未知",
  dependencyDetail: "等待依赖：{refs}",
  externalUnknown: "外部结果不明，需核实",
  noReliableState: "数据未知：尚无可靠的执行或等待状态",
  plannedUnknown: "未绑卡计划：开工及停滞数据未知",
  externalResult: "外部结果不明",
  capacityFull: "本机容量已满",
  setBand: "改为{band}",
  sessionAction: "本会应用：{action}",
  moveUp: "同档前移",
  moveDown: "同档后移",
  sourceLabel: "档位来源：",
  sourceTitle: "档位来源：{source} · {module}",
  now: "现在做",
  next: "接着做",
  later: "可以拖",
  dependency: "等待依赖",
  capacity: "等容量",
  owner: "等 owner",
  uncertain: "结果不明",
  unknown: "数据未知",
  working: "执行中",
  waiting: "等待中",
  ready: "待开工",
  durationUnknown: "时长未知",
  durationDays: "{d} 天 {h} 小时",
  durationHours: "{h} 小时 {m} 分",
  durationMinutes: "{m} 分钟",
  plannedNode: "计划节点 · 未开卡 · 节点 key：{key}",
  durationTitle: "当前状态已持续；警示阈值 {h} 小时",
  stalled: "停滞 ",
  order: "同档顺序：",
  defaultOrder: "默认",
  actions: "{title}优先级操作",
  adjustTitle: "调整：{title}",
  adjust: "调整",
  options: "调整选项",
  record: "记录本会",
  inherit: "恢复继承",
  up: "前移",
  down: "后移",
  off: "已关闭",
  observe: "观察中",
  on: "已启用",
  versionChanged: "版本已变，请刷新后重试",
  failed: "操作失败，请刷新核对",
  readbackFailed: "命令已处理，但当前读回不一致，请刷新核对",
  recorded: "已记录本会调整，业务档位与顺序未变。",
  applied: "已应用，服务端读回一致。",
  heading: "当前现在做",
  count: "{n} 张",
  noData: "· 数据未知",
  switches: "排序：{sort} · 开工：{start} · 升级：尚未启用（配置{stall}）",
  stale: "旧快照 · 禁止操作",
  readFailed: "读取失败",
  expand: "展开",
  collapse: "收起",
  mechanism: "登记 now 不代表机制已生效",
  refresh: "刷新",
  history: "优先级历史",
  observeInfo: "观察中：只读展示。owner 可记录「本会调整」，不会应用调档或排序。",
  expired: "旧快照已过期，操作已停用。",
  retry: "无法确认 now 工作，请重试。",
  unbound: "当前团队未绑定本机项目，优先级数据未知。",
  loading: "正在读取 now 工作…",
  empty: "当前没有有效 now 工作。已完成卡仍可在原卡与优先级历史查询。",
  expiredRetry: "旧快照已过期，请刷新后重试",
  busy: "正在处理请求",
  unavailable: "操作不可用",
  confirmRequest: "确认优先级请求",
  target: "目标：{id} · 版本 {rev}",
  extra: "补充原话（可选）",
  confirmRecord: "确认记录",
  confirmApply: "确认应用",
  loadingHistory: "正在读取历史…",
  noHistory: "暂无优先级历史",
  nodeDialog: "本机计划节点详情",
  close: "关闭",
  nodeGone: "原节点已移出当前 DAG，请刷新",
  loadingNode: "正在读取原节点…",
} as const;

const words: Record<string, string> = {
  [PRIORITY_WORDS.sourceExplicit]: "Explicitly set by owner",
  [PRIORITY_WORDS.sourceModule]: "Follows its module",
  [PRIORITY_WORDS.sourceSystem]: "System default",
  [PRIORITY_WORDS.moduleTitle]: "{title}\nModule: {module}",
  [PRIORITY_WORDS.noModule]: "Not part of any module",
  [PRIORITY_WORDS.unnamedModule]: "Module name unknown",
  [PRIORITY_WORDS.dependencyDetail]: "Waiting for dependencies: {refs}",
  [PRIORITY_WORDS.externalUnknown]: "External result uncertain; verification required",
  [PRIORITY_WORDS.noReliableState]: "No reliable execution or waiting state yet",
  [PRIORITY_WORDS.plannedUnknown]: "Planned node without a card: start and stall data unknown",
  [PRIORITY_WORDS.externalResult]: "External result uncertain",
  [PRIORITY_WORDS.capacityFull]: "Local capacity is full",
  [PRIORITY_WORDS.setBand]: "Change to {band}",
  [PRIORITY_WORDS.sessionAction]: "Record for this session: {action}",
  [PRIORITY_WORDS.moveUp]: "Move up within band",
  [PRIORITY_WORDS.moveDown]: "Move down within band",
  [PRIORITY_WORDS.sourceLabel]: "Priority source:",
  [PRIORITY_WORDS.sourceTitle]: "Priority source: {source} · {module}",
  [PRIORITY_WORDS.now]: "Do now",
  [PRIORITY_WORDS.next]: "Do next",
  [PRIORITY_WORDS.later]: "Can wait",
  [PRIORITY_WORDS.dependency]: "Waiting for dependencies",
  [PRIORITY_WORDS.capacity]: "Waiting for capacity",
  [PRIORITY_WORDS.owner]: "Waiting for owner",
  [PRIORITY_WORDS.uncertain]: "Result uncertain",
  [PRIORITY_WORDS.unknown]: "Data unknown",
  [PRIORITY_WORDS.working]: "In progress",
  [PRIORITY_WORDS.waiting]: "Waiting",
  [PRIORITY_WORDS.ready]: "Ready to start",
  [PRIORITY_WORDS.durationUnknown]: "Duration unknown",
  [PRIORITY_WORDS.durationDays]: "{d} d {h} h",
  [PRIORITY_WORDS.durationHours]: "{h} h {m} min",
  [PRIORITY_WORDS.durationMinutes]: "{m} min",
  [PRIORITY_WORDS.plannedNode]: "Planned node · No card yet · Node key: {key}",
  [PRIORITY_WORDS.durationTitle]: "Time in current state; warning threshold {h} h",
  [PRIORITY_WORDS.stalled]: "Stalled ",
  [PRIORITY_WORDS.order]: "Order in band:",
  [PRIORITY_WORDS.defaultOrder]: "Default",
  [PRIORITY_WORDS.actions]: "Priority actions for {title}",
  [PRIORITY_WORDS.adjustTitle]: "Adjust: {title}",
  [PRIORITY_WORDS.adjust]: "Adjust",
  [PRIORITY_WORDS.options]: "Adjustment options",
  [PRIORITY_WORDS.record]: "Record for this session: ",
  [PRIORITY_WORDS.inherit]: "Restore inheritance",
  [PRIORITY_WORDS.up]: "Move up",
  [PRIORITY_WORDS.down]: "Move down",
  [PRIORITY_WORDS.off]: "Off",
  [PRIORITY_WORDS.observe]: "Observing",
  [PRIORITY_WORDS.on]: "On",
  [PRIORITY_WORDS.versionChanged]: "Version changed; refresh and try again",
  [PRIORITY_WORDS.failed]: "Operation failed; refresh to verify",
  [PRIORITY_WORDS.readbackFailed]: "Command processed, but readback differs; refresh to verify",
  [PRIORITY_WORDS.recorded]: "Session adjustment recorded; work priority and order are unchanged.",
  [PRIORITY_WORDS.applied]: "Applied; server readback matches.",
  [PRIORITY_WORDS.heading]: "Current work",
  [PRIORITY_WORDS.count]: "{n} cards",
  [PRIORITY_WORDS.noData]: "· Data unknown",
  [PRIORITY_WORDS.switches]: "Sorting: {sort} · Starting: {start} · Escalation: not enabled (configured {stall})",
  [PRIORITY_WORDS.stale]: "Old snapshot · Actions disabled",
  [PRIORITY_WORDS.readFailed]: "Read failed",
  [PRIORITY_WORDS.expand]: "Expand",
  [PRIORITY_WORDS.collapse]: "Collapse",
  [PRIORITY_WORDS.mechanism]: "A now priority does not mean the mechanism is active",
  [PRIORITY_WORDS.refresh]: "Refresh",
  [PRIORITY_WORDS.history]: "Priority history",
  [PRIORITY_WORDS.observeInfo]: "Observing: read-only. Owners can record session adjustments; priority and order will not change.",
  [PRIORITY_WORDS.expired]: "Snapshot expired; actions disabled.",
  [PRIORITY_WORDS.retry]: "Cannot confirm current work; try again.",
  [PRIORITY_WORDS.unbound]: "This team has no local project binding; priority data is unknown.",
  [PRIORITY_WORDS.loading]: "Loading current work…",
  [PRIORITY_WORDS.empty]: "No active current work. Completed cards remain available in their original view and priority history.",
  [PRIORITY_WORDS.expiredRetry]: "Snapshot expired; refresh and try again",
  [PRIORITY_WORDS.busy]: "Processing request",
  [PRIORITY_WORDS.unavailable]: "Action unavailable",
  [PRIORITY_WORDS.confirmRequest]: "Confirm priority request",
  [PRIORITY_WORDS.target]: "Target: {id} · Version {rev}",
  [PRIORITY_WORDS.extra]: "Additional words (optional)",
  [PRIORITY_WORDS.confirmRecord]: "Confirm recording",
  [PRIORITY_WORDS.confirmApply]: "Confirm application",
  [PRIORITY_WORDS.loadingHistory]: "Loading history…",
  [PRIORITY_WORDS.noHistory]: "No priority history yet",
  [PRIORITY_WORDS.nodeDialog]: "Local planned node details",
  [PRIORITY_WORDS.close]: "Close",
  [PRIORITY_WORDS.nodeGone]: "The original node is no longer in the current plan; refresh",
  [PRIORITY_WORDS.loadingNode]: "Loading original node…",

  规格: "Spec", 确认需求: "Confirm", 开发: "Build", 审查: "Review", 返工: "Fix", 合并: "Merge", 上线: "Live", 验证: "Verify",
  完成: "Done", 受阻: "Blocked", 取消: "Cancelled", 终审: "Final review", 部署: "Deploy", 交付中: "Delivering", 看界面: "UI check",
  [OTHER_STAGE_WORD]: "Other", [READY_WORD]: "Ready to start",
  [MACHINE_WORDS.machine]: "The machine running the task", [MACHINE_WORDS.otherMembers]: "Members on other machines",
  [MACHINE_WORDS.syncSection]: "Sync", [MACHINE_WORDS.readOnlyCopy]: "Read-only copy",
  [MACHINE_WORDS.staleMinutes]: "No update from the task's machine for {n} min",
  [MACHINE_WORDS.staleHours]: "No update from the task's machine for {n} h",
  [MACHINE_WORDS.noProgress]: "No progress received from the task's machine yet",
  [MACHINE_WORDS.fresh]: "Progress is up to date", [MACHINE_WORDS.stale]: "Progress may be out of date",
  [MACHINE_WORDS.staleModules]: "Progress may be out of date for {n} modules",
  [MACHINE_WORDS.openQuestions]: "{n} questions are waiting for an answer on the task's machine",
  [MACHINE_WORDS.planOnly]: "View and plan only here; start and merge on the machine running the task",
  [MACHINE_WORDS.fullTextThere]: "Full text is only on the machine running the task",
  [MACHINE_WORDS.visibleThere]: "Only visible on the machine running this task",
  [MACHINE_WORDS.originalThere]: "Original text is only visible on the machine running this task",
  [MACHINE_WORDS.openSessionThere]: "Open sessions on the machine running this task",
  [MACHINE_WORDS.replayThere]: "Replay on the machine running this task",
  [MACHINE_WORDS.planningMachine]: "Machine that plans by default",
  [MACHINE_WORDS.boundHere]: "Project and the machine running this task come from this machine's binding; not editable",
  [LP_WORDS.badgeExhausted]: "Low priority used up", [LP_WORDS.badgeWalled]: "Limit hit, waiting for reset",
  [LP_WORDS.walledTitle]: "Usage limit hit, continuing automatically at {time}",
  [LP_WORDS.compactLabel]: "Low priority + compact", [LP_WORDS.onLabel]: "Low priority on", [LP_WORDS.offLabel]: "Low priority off",
  [LP_WORDS.compactLpHint]: "Sessions at the limit: low priority on → interrupt the auto-continue → compact with the keep list.",
  [LP_WORDS.offHint]: "Only sessions with low priority on; ones already off are skipped.",
  [LP_WORDS.compactHint]: "Sends /compact with the keep list; busy ones queue it, ones at the limit without low priority are skipped.",
  [LP_WORDS.onHint]: "Sessions at the limit only; ones already on are skipped, busy ones are left alone.",
  [QUOTA_WORDS.noun]: "Usage limits", [QUOTA_WORDS.used]: "{family} used {pct}% this week",
  [QUOTA_WORDS.warn]: "{family} used {pct}% this week — warn line reached",
  [QUOTA_WORDS.stop]: "{family} used {pct}% this week — taking no new work",
  [QUOTA_WORDS.weekOut]: "{family} weekly limit used up, resets {when}",
  [QUOTA_WORDS.sessionOut]: "{family} 5-hour limit used up, resets {when}",
  [QUOTA_WORDS.anyOut]: "{family} limit used up, resets {when}",
  [QUOTA_WORDS.weekOutNoTime]: "{family} weekly limit used up", [QUOTA_WORDS.sessionOutNoTime]: "{family} 5-hour limit used up",
  [QUOTA_WORDS.anyOutNoTime]: "{family} limit used up",
  [QUOTA_WORDS.recovering]: "Usage restored — closing menus, delivering queued messages, resuming agents",
  [QUOTA_WORDS.credits]: "{n} reset(s) available: send /limit-reset in the session",
  [QUOTA_WORDS.tagWarn]: "warn line reached", [QUOTA_WORDS.tagStop]: "taking no new work",
  [QUOTA_WORDS.tagOut]: "used up · resets {when}", [QUOTA_WORDS.tagOutNoTime]: "used up",
  [QUOTA_WORDS.lpOn]: "Low priority on until {time}", [QUOTA_WORDS.lpOut]: "Low priority allowance used up",
  [QUOTA_WORDS.lpLabel]: "Low priority",
  [QUOTA_WORDS.viewQuota]: "View limits", [QUOTA_WORDS.viewUsage]: "View usage", [QUOTA_WORDS.liveTitle]: "Read limits live",
  [QUOTA_WORDS.liveWhere]: "Limits are shown in \"Today · Team & limits\"", [QUOTA_WORDS.noticeLabel]: "Usage limit notice",
  [LEND_WORDS.slots]: "Concurrent runs", [LEND_WORDS.grantLine]: "{slots} at once · {n} per day",
  [LEND_WORDS.lentWork]: "Lent work", [LEND_WORDS.noLentWork]: "No lent work", [LEND_WORDS.stopLine]: "No-new-work line",
  [LEND_WORDS.stopped]: "Not accepting", [LEND_WORDS.overStopLine]: "Over stop line (not enforced)",
  [LEND_WORDS.warnBelowStop]: "Warn line must be below stop line",
  [LEND_WORDS.stopLineNote]: "At this line Claude / Codex each take no new work on this machine; running work continues",
  [LEND_WORDS.warnLineNote]: "At the warn line concurrent runs are halved (at least 1; 0 stays 0)",
  [LEND_WORDS.statusStopped]: "Not accepting new work; running work continues",
  [LEND_WORDS.statusObserveStop]: "Observe only: still accepting new work",
  [LEND_WORDS.statusHalved]: "Still accepting; concurrent runs halved",
  [LEND_WORDS.statusObserveWarn]: "Observe only: still accepting, concurrent runs unchanged",
};

/** 词表里某个词的英文；不在词表里 → undefined（各功能字典用它就地给被换掉的键取 en 值） */
export const ownerWordEn = (zh: string): string | undefined => (Object.hasOwn(words, zh) ? words[zh] : undefined);

export function ownerWordsTr(language: "zh" | "en") {
  return (key: string, params?: Record<string, string | number>): string => {
    let value = language === "en" ? ownerWordEn(key) ?? key : key;
    for (const [k, v] of Object.entries(params ?? {})) value = value.replaceAll(`{${k}}`, String(v));
    return value;
  };
}

/** Server system copy is not owner-authored text; unknown Chinese reasons use a localized state/error fallback. */
export function prioritySystemText(text: string, fallback: string, language: "zh" | "en"): string {
  const tr = ownerWordsTr(language);
  if (text === "本机名额满") return tr(PRIORITY_WORDS.capacityFull);
  if (language === "zh") return text;
  const dependency = text.match(/^等待依赖[：:](.*)$/);
  if (dependency) return tr(PRIORITY_WORDS.dependencyDetail, { refs: dependency[1]!.split("、").join(", ") });
  const translated = tr(text);
  return /[\u4e00-\u9fff]/.test(translated) ? tr(fallback) : translated;
}

/** Translate only the recorded system action label; preserve the owner's appended words verbatim. */
export function priorityHistoryText(text: string, language: "zh" | "en"): string {
  if (language === "zh") return text;
  const tr = ownerWordsTr(language), W = PRIORITY_WORDS;
  const sessionPrefix = W.sessionAction.replace("{action}", "");
  const session = text.startsWith(sessionPrefix);
  const value = session ? text.slice(sessionPrefix.length) : text;
  const actions: [string, string][] = [W.inherit, W.moveUp, W.moveDown].map(label => [label, tr(label)]);
  for (const band of [W.now, W.next, W.later]) {
    actions.push([ownerWordsTr("zh")(W.setBand, { band }), tr(W.setBand, { band: tr(band) })]);
  }
  const action = actions.find(([label]) => value === label || value.startsWith(`${label}；`));
  if (!action) return text;
  return (session ? tr(W.sessionAction, { action: action[1] }) : action[1]) + value.slice(action[0].length);
}

/** 不该再给 owner 看到的内部词；只给测试用 */
export const BANNED_OWNER_WORDS = ["主场", "镜像", "V1", "LP", "撞墙", "家族", "名额", "停接线", "复述", "feature"];
