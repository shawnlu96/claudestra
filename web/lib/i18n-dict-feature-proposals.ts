/** Feature proposal copy (N7W). Titles, node text and member codes are data, never translation keys. */
const words: Record<string, string> = {
  '新建 feature 提案': 'New feature proposal', '标题': 'Title', '描述': 'Description', '原话（可选）': 'Owner words (optional)',
  '节点': 'Node', '节点代号': 'Node key', '一句话描述': 'One-line summary', '依赖': 'Dependencies', '文件范围': 'File globs',
  '估时': 'Estimate', '添加节点': 'Add node', '删除节点': 'Remove node', '提交提案': 'Submit proposal', '取消': 'Cancel',
  '提交中…': 'Submitting…', '项目、主场由本机绑定决定，不可改': 'Project and home come from this machine binding',
  '节点需有唯一代号、描述和文件范围；依赖必须存在': 'Nodes need unique keys, summaries and globs; dependencies must exist',
  '我的提案': 'My proposals', '最近提交': 'Latest submission', '查询结果': 'Check result',
  '已提交，待项目 owner 批准': 'Submitted; awaiting project owner', '已批准，待中心发布': 'Approved; awaiting publish',
  '待同步，结果未确认': 'Pending sync; result unconfirmed', '已发布': 'Published', '中心 feature': 'Center feature',
  '已驳回': 'Rejected', '已过期': 'Expired', '冲突：内容与中心不一致，请改后重新提交': 'Conflict: change content and resubmit',
  '本机设备无权操作团队提案（403）': 'This device cannot act on team proposals (403)',
  '中心不支持提案协议（502）': 'Center does not support proposals (502)', '提案内容不符合要求': 'Proposal content is invalid',
  '本机未绑定该团队项目': 'This machine is not bound to the team project', '结果未确认': 'Result unconfirmed',
  '缓存状态': 'Cached state', '待审提案': 'Proposals to review', '暂无待审提案': 'No proposals to review',
  '版本': 'Version', '新 feature': 'New feature', '提案人': 'Proposer', '过期时间': 'Expires', '节点数': 'Nodes',
  '我': 'Me', '成员': 'Member', '服务凭据': 'Service', '批准': 'Approve', '驳回': 'Reject', '驳回理由': 'Rejection reason',
  '确认驳回': 'Confirm rejection', '请填写驳回理由': 'Provide a rejection reason', '漂移：中心版本已变，不能决定': 'Drift: center changed; cannot decide',
  '已过期，不能决定': 'Expired; cannot decide', '仅项目 owner 可批准或驳回': 'Only the project owner can approve or reject',
  '提案已变化，已重读，请重新决定': 'Proposal changed; list reloaded, decide again',
  '决定结果未确认，未自动重发；请重读后再看': 'Decision unconfirmed; not resent. Reload to check',
  '决定已记录': 'Decision recorded', '重读列表': 'Reload list', '读取失败': 'Read failed', '正在读取…': 'Loading…',
  '待审列表需要本机 owner 设备（403）': 'Review list needs this machine owner device (403)',
  '自己的提案也要再点一次批准': 'Your own proposal still needs an explicit approval',
};
export function featureProposalsTr(language: 'zh' | 'en') {
  return (key: string, params?: Record<string, string | number>): string => {
    let value = language === 'en' ? words[key] ?? key : key;
    for (const [k, v] of Object.entries(params ?? {})) value = value.replaceAll(`{${k}}`, String(v));
    return value;
  };
}
