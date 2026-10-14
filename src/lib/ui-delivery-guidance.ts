/** UI requirements are appended after project templates and reused by both author-order entry points. */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";

export const UI_DELIVERY_SECTION = `
## ui 卡：合并前要过前后截图验收
- 每轮交付都带正规截图清单：首次 build、普通 fix、fix-swap 换作者修复均须带 uiEvidence；deliver 工具填写 uiEvidence。
- CLI 用 \`ledger deliver {TASK} --from build|fix --head <完整 sha> --pr <完整 PR 链接> --ui-evidence '<正规 JSON>'\`。
- 正规交付只登记证据；审查通过后调度器把截图发给 PM 验收（改整体观感的卡由 owner 看），仍须 PM 的 ui-approve；不通过退回 fix，意见在修复单里。
- 用 headless 脚本拍图，不用 Playwright MCP 工具。before 对照规格要求的基线，after 对应本次交付 HEAD；深浅色、桌面/手机按规格，同一展示状态 view 和尺寸 size 成对。
- 代码改过必须重拍 after，重新核整组图片、前后配对和逐图实际字节 sha256，生成本次 head / specRev / 目标 round 的新清单，不能沿用上一轮清单。
- 合并 before-manifest 与 after-manifest 的 shots：card 映射为 taskId；web 留作拍摄材料，不带入正规清单；每项只留 view、size、phase、ref、sha256。
- file 转为本机工件根 {LEDGER}/ui-artifacts/{TASK}/ 下的相对 ref，例如 r2/after-home-390x844.png；图片须实际在本卡目录，不得简单给已有绝对路径加前缀。
- 正规清单只含 v/taskId/head/specRev/round/source/summary/shots/digest：v=1、head 为本次完整 40 位 SHA、specRev 为当前规格版本、source=local、summary 为一行说明。
- 目标 round：卡已在 review 则取当前 round，否则取当前 round + 1；目录名 rN 不作为轮次依据。
- shots 同一 view + size 各有 before / after，ref 不重复，最多 16 张。digest 复用 src/lib/order-deliver-ui.ts 的 uiEvidenceDigest，按 canonical JSON 计算，shots 按 view、size、before→after 排序。
- 不使用 PNG 按文件名排序拼接原始字节的摘要。生成后用同模块 readUiEvidence 严格校验，交付还会核每张实际字节 sha256；旧 card/web/shots、file 字段不能原样提交。
`;

const UI_AUTHOR_REMINDER = "本卡是 ui 卡：本轮交付（含换作者修复）仍须带正规 uiEvidence／CLI `--ui-evidence`；" +
  "代码改过重拍 after、重核前后配对与逐图摘要，清单绑定本次 head、specRev 和目标审查轮次，不能沿用上一轮清单。";

/** Review/restate orders share convergence text; only a current UI author stage needs this instruction. */
export function uiAuthorDeliveryLines(db: Database | undefined, task: LedgerTask): string[] {
  return db && (task.stage === "build" || task.stage === "fix") && getWorkflow(db, task.id)?.template === "ui"
    ? [UI_AUTHOR_REMINDER] : [];
}
