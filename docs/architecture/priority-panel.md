# 当前现在做面板

入口沿用工作看板，团队页只展示当前设备所绑定的本机项目队列。
不合并其他实例的顺序，也不根据旧事项 priority 文本推断 now。
团队入口的行打开本机原卡；未绑卡节点复用 NodePage 展示本机原节点，
不把本机 feature id 当成中心镜像的坐标。

## 读取与状态

`GET /api/v1/ledger/:project/priority` 复用 `canReadLedger`。
只读事务查询 PRIO1 有效档位、继承来源、同档顺序及四个独立开关，
列出所有未完成 now 卡和 active feature 的未绑卡 now 节点。
verified、done、cancelled 不进入当前列表；历史独立保留。

等待事实沿用 work-board，单独区分依赖、容量、owner、结果不明、未知。
不把无可靠运行事实的卡推断为正在运行。计划节点没有可靠停滞起点时显示未知。
停滞警示优先读取本项目 meta 的 `priority-stall-threshold`（正数小时），
当前基线尚无 PRIO3 配置读取器；不存在或值不符合正数小时格式时固定缺省 24 小时。
服务端以 `stallThresholdMs` 返回毫秒；超过阈值用看板相同的 `--warn` 色标记行和时长。
这只是基础时长警示，不代表升级机制已启用。计划节点起点未知时不标停滞。
PRIO3 尚未接入，升级明确显示“尚未启用”；排序、开工显示各自配置，
登记 now 不代表排序、开工、升级均已生效。

快照版本绑定当前目标集合、阶段、PRIO1 版本与继承结果、队列版本、开关版本。
时间与轮询本身不改变版本。复用 collabLoader 的退避重试；失败保留快照并标过期，
超过一分钟、页面隐藏再显示、断线重连均须重新验证。隐藏页面不持续轮询。
数据库不可用返回 503，不伪装成空列表。

## owner 操作

`POST /api/v1/ledger/:project/priority/requests` 仅认证的 owner 且有全量台账读权限可用。
客户端只提交目标、rev、操作、档位、快照版本与读取时间，不传 actor 或 owner 证据。
服务端重核快照，生成最多一分钟有效的系统 ask，bindHash 绑定完整请求、模式与版本。

页面确认通过现有 `POST /ledger/:project/asks/:id/answer`，继续使用现有 owner 身份识别。
`bridge/asks.ts` 的一行接线在 `answerAsk` 同一事务中调用新模块：
只认认证入口的 `owner:true` 且非 external，再核服务器保存的 ask、绑定哈希、
目标生命周期与队列/开关版本，通过 PRIO1 `setPriority` / `setPriorityOrder` 应用。
版本冲突整笔回滚，答案也不落库。普通 agent、PM、guest、peer 不得应用。

操作选项和补充原话来自认证作答，连同 ask 来源、时间写入 PRIO1 优先级历史。
恢复继承使用 clear；前后移动只交换当前 now 列表相邻项，保留原队列里其他有效成员。
同档队列是项目内 `project`，和 PRIO1 查询一致，最多 200 项。

`off` 不显示面板并拒绝新请求；`observe` 按钮明确是“记录本会调整”，
确认仅追加 `would_apply` 审计，不写业务档位/顺序；`on` 才应用。
批准后切换开关使旧请求冲突，不会借旧授权改变新配置下的业务。

作答后 `GET /priority/result?askId=…` 在只读事务中将 PRIO1 审计结果与当前查询比较，
页面只有确认读回一致并刷新后才显示成功。网络失败或结果不明不自动重发命令。
`GET /priority/history` 允许查询已离开当前列表的优先级历史。

## 精准接线与验证

PM 批准的三个入口文件仅 import 与一处调用：
`dag/use-dag-panes.tsx`、`local-api/index.ts`、`bridge/asks.ts`。
实现和样式集中在 priority 新模块，未变更认证、设备或凭据读取路径。

`tests/ledger-priority-panel.test.ts` 覆盖权限拒绝、CAS 回滚、observe、off、
排序、恢复继承、原话审计与读回，浏览器证据覆盖 390/1280 两宽度和异常状态。

## 收起摘要与调整菜单

面板默认收起，摘要保留 now 数量、观察标签以及排序 / 开工 / 升级各自状态。
按页面路径与项目在 sessionStorage 记住展开状态；存储受限时用页面内存保留。
展开后每张工作一行，长标题、feature 全名和来源详情通过悬停提示查看。
同一句状态标签与说明只显示一次；未绑卡节点明确写“计划节点 · 未开卡 · 节点 key”。
owner 每行一个“调整”入口，菜单含三档、恢复继承、前移、后移。
旧快照禁用入口并提示原因；observe 菜单项以“记录本会”开头。

作答接线仍是一处调用，import 改指向 `local-api/ledger-priority-panel-answer.ts`。
该适配器把业务 CAS 失败转换成 `AskRejected(409, "priority_conflict", …)`，
网页和 Discord 均提示“版本已变，请刷新后重试”，不误报“已处理”；
权限失败转换成 `AskRejected(403, "priority_forbidden", 原因)`。
原业务事务、PRIO1 写入逻辑和已结案 ask 的处理保持原有语义。

浏览器复现：`PRIO_PANEL_SHOTS_DIR=ui-shots bun test tests/ledger-priority-panel.test.ts --test-name-pattern browser:`。
两种宽度都截混合、空态、失败、旧快照及收起首屏，夹具固定同一个当前时间与阶段起点。
收起截图分别使用 1280×800 / 390×844，并断言看板列头位于首屏。
基线以 `origin/main` 的 fixture-harness bundle 配合 `PRIO_PANEL_BASELINE=1`、
`PRIO_PANEL_BUNDLE=<基线 bundle 目录>` 跑相同测试；不需合并 main。
上传清单受 8 对上限约束：混合、空态和收起各两宽度，加桌面失败与窄屏旧快照。
其余两张异常状态截图仍保留在本地证据目录；操作与页面错误记录在 `after-operations.json`。
