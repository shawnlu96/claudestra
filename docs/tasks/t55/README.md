# T55 v4 团队视图

独立 TeamPanel：桌面节点连线图，手机成员卡与往来记录，T58 可重新挂载。
只用现有 registry/session、quota-state、peer-presence、台账和 bridge 投递环，缺失值未知。
只画最近 10 分钟有明确双方身份的真实往来；无收件人的交付/审查只列记录，不猜连线。
稳定事件 ID 去重，新线闪一次；bridge 环重启清空，活动最多 200 条、图最多 40 条并标注截断。
节点点击查询本项目当前卡；本机另有打开会话。未改 T51 文件或 guard baseline。

## 验证

新增 11 测试/54 断言、根/Web 类型检查、严格 guard、Web 和六入口构建通过。
全量本分支 6125 pass / 12 fail / 1 error；未修改基线 6114 pass / 12 fail / 1 error。
相同失败涉及 APNs 监听、BoringSSL/Ed25519 解码及依赖初始化的 relay/E2E 测试。
PR 以 GitHub CI 验收，不将本机结果报成全绿。

## 截图

8 张图放独立 pr-shots 分支，由 PR 正文引用，不合进 main。
before 为 0f66706a bundle，after 为当前代码；均通过临时独立 CollabView 预览连接真实沙箱 23957。
只替换静态 bundle，不伪造 API。临时入口源码已移除，页面标明独立预览。
脚本在本机 /tmp/t55-v4-screens.mjs，桌面 1440×1000、手机 390×844，浅/深色各一套前后图。

沙箱 registry 无执行 agent（创建超时已清理），API 系统 master 条目照实展示。
没有最近真实往来，只验空态；不声称截图覆盖连线动画或外部成员。
实测 projects 200、peers/contacts 403（sandbox:true）、team/activity 200 且 interactions 为空。
未改隔离规则；入口受两成员条件和 peer 403 误判 fullScope 影响，已记台账 2197，不在 T55 顺手修。
手机 flex 压缩裁切活动区已修复重拍；两个视口均无 body 横溢出。
旧列表合成图不作为 v4 证据。仍需 owner UI 验收，PR 不自动合并。
