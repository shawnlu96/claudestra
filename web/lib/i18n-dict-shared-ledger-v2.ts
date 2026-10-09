/** Execution labels; server-provided titles and refusal reasons remain data. */
const words: Record<string, string> = {
  '共享执行': 'Shared execution', '开卡': 'Create task', '编辑': 'Edit', '审批': 'Approval', '主场': 'Home', '执行地': 'Executor',
  '中心 serverSeq': 'Center serverSeq', '数据已过期，请刷新': 'Data is stale; refresh', '刷新': 'Refresh',
  '执行数据暂不可用': 'Execution data unavailable', '查询回执': 'Check receipt', '提交状态未知，请查回执': 'Submission unknown; check receipt',
  '未查到回执，保留草稿': 'Receipt unknown; draft retained', '已保存': 'Saved', '能力尚未开放': 'Capability unavailable',
  '新建 spec 卡': 'New spec task', '编辑 spec 卡': 'Edit spec task', '关闭': 'Close', '数据过期时间': 'Data expires at',
  '绑卡': 'Bind task', '改阶段': 'Change stage', '分配': 'Assign', '当前版本已更新；草稿仍在。': 'Version changed; draft retained.',
  '刷新版本并保留草稿': 'Refresh version and retain draft', '提交失败': 'Submission failed', '所属 feature': 'Feature', '卡': 'Task',
  '标题': 'Title', '规划说明': 'Plan', '新规格摘要': 'New specification summary', '改规格原因': 'Reason for specification change',
  '提交后产生 specRev': 'Creates specRev', '提交新 specRev': 'Submit new specRev', '保存': 'Save', '取消': 'Cancel',
  '无权提交': 'Submission forbidden', '共享执行尚未开放': 'Shared execution unavailable', '暂时无法提交': 'Submission unavailable',
  '版本已过期': 'Version expired', '数据已更新': 'Data updated', '请检查填写内容': 'Check the form',
  '待审批': 'Pending approval', '基础版已变化': 'Base version changed', '已过期': 'Expired', '已撤销': 'Revoked', '已答复': 'Answered',
  '无授权绑定': 'No authorization binding', '仅 owner 可签': 'Only the owner can sign', '无权签署': 'Signing forbidden',
  '版本已变化': 'Version changed', '提案状态已变化': 'Proposal changed', '授权已过期': 'Authorization expired',
  '绑定内容不一致': 'Binding mismatch', '请求无效': 'Invalid request', '批准': 'Approve', '驳回': 'Reject',
  '提案摘要': 'Proposal digest', '基础版': 'Base version', '期限': 'Expiry', '动作': 'Actions', '提案': 'Proposal', '节点': 'Nodes',
  '原文': 'Original', '原文哈希': 'Original digest', '副本哈希': 'Copy digest', '已批准': 'Approved', '已驳回': 'Rejected',
  '无共享材料': 'No shared material', '仅在主场': 'Home only', '共享副本': 'Shared copy', '脱敏摘要': 'Redacted summary',
  '尚未接线': 'Not connected',
};
export const sharedExecTr = (language: 'zh' | 'en') => (key: string): string => language === 'en' ? words[key] ?? key : key;
