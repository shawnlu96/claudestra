/**
 * POST /api/v1/lend/shot（LENDUI1）：出借方把 ui 卡开工 / 修复单的一张前后截图传给发起方。闸与 lend/* 同一道（lendCallerRefusal）。
 * 这里只做闸、读正文、接依赖、映射回包：格式规则在 lib/lend-ui-wire.ts，谁能传与落盘在 lib/lend-ui-store.ts。
 * 图片进不了命令行参数，所以不起 manager 子进程：bridge 只读台账，文件由 bridge 自己写到导入工件根（交付时 ledger-deliver-ui.ts 从那里读）。
 * 收下只是存盘，不登记证据；登记在交付入账那一步（lib/lend-ui-deliver.ts）。日志每个新存下的文件一行（重传不记），只记 peer、单号、文件名、大小、宽高、模式。
 * tests/lend-ui-shot-api.test.ts。
 */
import type { Database } from "bun:sqlite";
import { uiDeliverPort } from "../../lib/ledger-deliver-ui-port.js";
import { inOrderOf, receiveLendShot, type LendShotStoreDeps } from "../../lib/lend-ui-store.js";
import { LEND_SHOT_LIMITS, LEND_SHOT_STATUS, parseLendShot, shotRefusal, type LendShotRefusal } from "../../lib/lend-ui-wire.js";
import { strictUtf8 } from "../../lib/pool-review-proof-raw.js";
import type { Principal } from "../../lib/principals.js";
import { recoveryPolicy } from "../../lib/recovery-policy.js";
import { apiJson } from "../api-respond.js";
import { ledgerDb } from "../ledger-feed.js";
import { lendCallerRefusal } from "./lend.js";

export interface LendShotApiDeps extends LendShotStoreDeps {
  refusal(req: Request, principal: Principal): string | null;
  /** 只读台账；null = 这台机器没有台账 */
  db(): Database | null;
  log(line: string): void;
}

const refused = (r: LendShotRefusal): Response => apiJson(LEND_SHOT_STATUS[r.code], r);
const tooLarge = (): Response => refused(shotRefusal("too_large", `请求体超过 ${LEND_SHOT_LIMITS.body} 字节`));

/** 正文先按 Content-Length 挡一道，读完再按实际字节核：头可以不带也可以说谎 */
async function readShot(req: Request): Promise<ReturnType<typeof parseLendShot> | Response> {
  if (Number(req.headers.get("content-length") || 0) > LEND_SHOT_LIMITS.body) return tooLarge();
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > LEND_SHOT_LIMITS.body) return tooLarge();
  const text = strictUtf8(bytes);
  if (text === null) return refused(shotRefusal("invalid", "请求体不是合法 UTF-8"));
  try {
    return parseLendShot(JSON.parse(text));
  } catch {
    return refused(shotRefusal("invalid", "请求体不是合法 JSON"));
  }
}

export function lendShotApi(deps: LendShotApiDeps) {
  return async (req: Request, path: string, principal: Principal): Promise<Response | null> => {
    if (path !== "/lend/shot") return null;
    if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
    const why = deps.refusal(req, principal);
    if (why) return refused(shotRefusal("unauthorized", why));
    const shot = await readShot(req);
    if (shot instanceof Response) return shot;
    if (!shot.ok) return refused(shot);
    const peer = principal.peer as string;
    const r = await inOrderOf(shot.value.orderId, () => {
      try {
        const db = deps.db();
        return db ? receiveLendShot(db, peer, shot.value, deps) : shotRefusal("unavailable", "这台机器没有台账");
      } catch {
        return shotRefusal("unavailable", "台账暂时读不了，稍后重传"); // 原因可能带本机路径，不回给对方
      }
    });
    if (!r.ok) return refused(r);
    const { mode, stored, ...answer } = r;
    // 一个 ref 一行：同图重传没有新文件，不记（上线后按行数核收到几张）
    if (stored) deps.log(`🖼️ [lend-shot] ${peer} ${shot.value.orderId} ${r.ref} ${r.bytes} 字节 ${r.width}x${r.height} lendUiShots=${mode}`);
    return apiJson(200, answer);
  };
}

export const handleLendShotApi = lendShotApi({
  refusal: lendCallerRefusal, db: ledgerDb, log: (line) => console.log(line), now: () => Date.now(),
  importedRoot: uiDeliverPort().roots.imported,
  mode: (project) => recoveryPolicy(project, "lendUiShots").mode,
});
