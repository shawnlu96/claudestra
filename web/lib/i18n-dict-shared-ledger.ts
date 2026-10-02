/** Shared planning copy. Unknown project titles and machine codes are data, never translation keys. */
const words: Record<string, string> = {
  '团队规划': 'Team planning', '全部 feature': 'All features', '新建 feature': 'New feature', '项目': 'Project',
  '标题': 'Title', '描述': 'Description', '默认规划主场': 'Default planning home', '创建': 'Create', '取消': 'Cancel',
  '状态': 'Status', '完成 / 总数': 'Done / total', '阻塞': 'Blocked', '主场': 'Home', '执行机器': 'Executors',
  '最近更新': 'Updated', '缺失': 'Missing', '过期': 'Stale', '最新': 'Fresh', '待规划': 'Planned',
  '进行中': 'Active', '已完成': 'Done', '已阻塞': 'Blocked', '返回': 'Back', '编辑规划': 'Edit plan',
  '节点': 'Node', '依赖': 'Dependencies', '文件范围': 'File globs', '估时': 'Estimate', '改图原因': 'Rewrite reason',
  '添加节点': 'Add node', '删除节点': 'Remove node', '提交新版本': 'Submit new version', '已绑卡，节点锁定': 'Bound task; node locked',
  '逐条处理冲突': 'Resolve each conflict', '用我的': 'Use mine', '用最新': 'Use latest',
  '草稿': 'Draft', '最新图': 'Latest graph', '规划已被他人更新': 'Someone updated the plan',
  '重读后编辑': 'Reload and edit', '放弃草稿': 'Discard draft', '全文仅在主场': 'Full text at home only',
  '开卡': 'Create task', '绑卡': 'Bind task', '阶段': 'Stage', '审批': 'Approval',
  'V1 仅共享规划，执行操作仍在主场': 'V1 shares planning; execution stays at home',
  '来源镜像只读': 'Source mirror is read-only', '主场在线状态未知': 'Home presence unknown',
  '主场镜像过期': 'Home mirror is stale', '主场镜像最新': 'Home mirror is fresh', '尚无执行镜像': 'No execution mirror yet',
  '读取失败，保留缓存与草稿': 'Read failed; cache and draft retained', '重试': 'Retry', '暂无 feature': 'No features yet',
  '提交失败，草稿已保留': 'Submit failed; draft retained', '正在读取…': 'Loading…', '对比': 'Compare',
  '增': 'Added', '删': 'Removed', '带入有改': 'Changed', '已完成被改写': 'Rewritten completed',
  '版本': 'Version', '找不到这张卡': 'Task unavailable', '计划中': 'Planned', '未派': 'Unassigned',
  '节点需有唯一代号、标题和文件范围；依赖必须存在且无环': 'Nodes need unique keys, titles and globs; dependencies must exist and be acyclic',
  '请填写改图原因': 'Provide a rewrite reason', '提交状态未知，请查回执': 'Submission unknown; check receipt',
  '同名 feature 已存在，请修改标题；表单已保留': 'A feature with this title exists; change the title. Form retained',
  '查询回执': 'Check receipt', '未查到回执，保留草稿': 'Receipt unknown; draft retained',
};
export function sharedLedgerTr(language: 'zh' | 'en') {
  return (key: string, params?: Record<string, string | number>): string => {
    let value = language === 'en' ? words[key] ?? key : key;
    for (const [k, v] of Object.entries(params ?? {})) value = value.replaceAll(`{${k}}`, String(v));
    return value;
  };
}
