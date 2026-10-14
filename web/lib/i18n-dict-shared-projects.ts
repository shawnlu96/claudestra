/**
 * Team project copy (UXI18N1). Project, team, member and peer names are data, never translation keys.
 * Lib modules (shared-projects-model / -bindings) keep returning these Chinese sentences; components translate where they show them.
 */
const words: Record<string, string> = {
  // Dialog and shared status
  '团队项目': 'Team projects', '关闭': 'Close', '取消': 'Cancel', '操作已完成。': 'Done.',
  // projectErrorText (shared-projects-model)
  '请在项目确认卡中由本人继续确认，再刷新查看本机可用状态。': 'Continue in the project confirmation card yourself, then refresh to check availability on this machine.',
  '没有操作权限，请刷新项目权限后重试。': 'Not permitted. Refresh project permissions and try again.',
  '这台机器暂不支持此操作，或项目已不可用。': 'This machine does not support this action, or the project is no longer available.',
  '项目已被更新，请核对当前值后重试。': 'The project was updated. Check the current values and try again.',
  '设备凭据已失效，请重新配对。': 'Device credentials have expired. Pair this device again.',
  '操作未确认，请刷新查看结果后再试。': 'Action unconfirmed. Refresh to check the result before trying again.',
  // Sidebar source warnings (shared-projects-bindings)
  '这个团队项目在本机对应了多个绑定，已暂停显示；请到项目设置里核对。':
    'This team project matches several bindings on this machine and is hidden for now; check it in project settings.',
  '团队身份冲突：相关绑定来源已禁用；请核对入组身份，其他团队仍可用。':
    'Team identity conflict: the related binding sources are disabled. Check your team membership; other teams still work.',
  '部分绑定读取失败；请刷新核对权限与项目状态。': 'Some bindings could not be read. Refresh to check permissions and project status.',
  // Team settings
  '团队': 'Team', '团队显示名': 'Team display name', '保存团队名称': 'Save team name', '团队名称已保存。': 'Team name saved.',
  '结果未确认，请刷新': 'Result unconfirmed; please refresh', '当前名称：{name}': 'Current name: {name}', '按当前版本重试': 'Retry on current version',
  // Create project
  '中心暂未提供团队权限，创建项目暂不可用。': 'The center has not provided team permissions yet, so creating projects is unavailable.',
  '仅团队 owner 可以新建团队项目。': 'Only team owners can create team projects.',
  '新建团队项目': 'New team project', '请选择团队': 'Choose a team', '显示名': 'Display name',
  '项目 ID（可选，创建后不可改）': 'Project ID (optional, fixed after creation)', '本机对应项目': 'Local project on this machine',
  '原本机项目已不可绑定，请重新选择': 'The previous local project can no longer be bound; choose again',
  '新建本机项目（稍后设置目录）': 'New local project (set folders later)', '创建项目': 'Create project',
  '创建已处理，请查看本机可用状态。': 'Create handled. Check availability on this machine.',
  '「{name}」创建结果仍待可信读取；卡片结案和同名项目不能证明完成。':
    '"{name}" is still awaiting a trusted read; a closed card or a project with the same name does not prove it was created.',
  '继续完成项目': 'Finish project', '恢复已处理，请查看本机可用状态。': 'Recovery handled. Check availability on this machine.',
  '释放新建表单': 'Release the create form',
  // Project settings
  '已归档': 'Archived', '进行中': 'Active', '版本 {rev}': 'Version {rev}', '项目显示名': 'Project display name', '保存名称': 'Save name',
  '归档项目': 'Archive project', '恢复项目': 'Restore project', '当前状态：{status} · 版本 {rev}': 'Current status: {status} · Version {rev}',
  '本机对应关系': 'Local binding', '团队项目 {name}': 'Team project {name}', '本机项目 {name}（{id}）': 'local project {name} ({id})',
  '本机尚未绑定': 'not bound on this machine yet', '项目已可用': 'Project is ready', '中心项目已建，本机待完成': 'Created on the center; pending on this machine',
  '本机目录（每行一个）': 'Local folders (one per line)',
  '目录仅保存在这台机器；个人项目目录不能用于团队绑定。': 'Folders are saved on this machine only; personal project folders cannot be used for team bindings.',
  '设置目录': 'Set folders', '这台机器暂不支持退出团队项目。': 'This machine does not support leaving team projects yet.',
  '退出团队项目': 'Leave team project', '确认退出 {name}？本机将不再显示此项目的团队 feature。':
    'Leave {name}? This machine will stop showing the team features of this project.', '确认退出': 'Confirm leave',
  // Members and invitations
  '成员': 'Members', '项目 owner': 'Project owner', '成员#role': 'Member', '已加入': 'Joined', '待加入': 'Invited', '已移出': 'Removed', '移出': 'Remove',
  '将 {code} 移出项目 {name}？该成员将失去此项目的访问权限。': 'Remove {code} from {name}? They will lose access to this project.',
  '确认移出': 'Confirm removal', '邀请确认卡已生成，请由本人核对后发送。': 'Invitation card created; check it yourself before sending.',
  '邀请已发送，等待对方确认加入。': 'Invitation sent; waiting for them to accept.', '邀请成员': 'Invite member', '发送到 peer': 'Send via peer',
  '暂无已握手的 peer。': 'No paired peers yet.', '附言（可选）': 'Note (optional)',
  '邀请对象类型': 'Invitee type', '从团队目录选择': 'Choose from team directory', '已有成员（填写成员编号）': 'Existing member (enter member ID)',
  '新成员代号': 'New member code', '拟邀新成员代号': 'New member code to invite', '请选择团队成员': 'Choose a team member',
  '目录中暂无可邀请的成员': 'No one in the directory can be invited', '已有成员的编号': 'Existing member ID',
  '不在团队目录里的人请用新成员代号。本人和已加入成员不能重复邀请。机器仅用于发送邀请。':
    'Use a new member code for anyone not in the team directory. You and joined members cannot be invited again. Machines only deliver invitations.',
  '中心暂未提供团队成员目录；请填写准确的成员编号。本人和已加入成员不能重复邀请。机器仅用于发送邀请。':
    'The center has not provided a team directory yet; enter the exact member ID. You and joined members cannot be invited again. Machines only deliver invitations.',
  // Confirmation cards
  '项目确认卡': 'Project confirmation cards', '暂无待确认的项目操作。': 'No project actions to confirm.',
  '当前设备无权确认此操作。': 'This device cannot confirm this action.', '答复已记录，请刷新查看实际项目状态。': 'Answer recorded. Refresh to see the actual project status.',
  '加入后对应的本机项目': 'Local project after joining', '请选择本机项目': 'Choose a local project',
  '推荐选项已选中；': 'Recommended option selected. ', '本机项目已选中；': 'Local project selected. ', '请选择本机项目；': 'Choose a local project. ',
  '只有点击确认才会加入。': 'You join only after you confirm.',
  // Dialog entry to the inbox (UXASK2)
  '有 {n} 张团队项目确认待你处理': '{n} team project confirmations are waiting for you', '去处理': 'Review',
};

/**
 * zh returns the key as is; en looks it up and falls back to the key. A `#context` suffix tells apart equal Chinese words
 * (成员 heading vs 成员#role) and is dropped from the Chinese text. Placeholders are filled in one pass, so data never re-expands.
 */
export function sharedProjectsTr(language: 'zh' | 'en') {
  return (key: string, params?: Record<string, string | number>): string => {
    const zh = key.split('#')[0]!, value = language === 'en' ? words[key] ?? zh : zh;
    return params ? value.replace(/\{(\w+)\}/g, (m, k: string) => k in params ? String(params[k]) : m) : value;
  };
}
