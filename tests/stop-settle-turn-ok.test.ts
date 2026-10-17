/**
 * NRT-2 turn-ok-depends-on-card-close：正常结束的一轮按频道通知续跑计数清零（api-error-resume channelTurnOk），
 * 不经关卡（closeRecoveredCards 在没有 ledger 库 / registry 里没有这个频道 / master 时直接返回）。
 */
import { expect, test } from "bun:test";
import { settleStopTurn, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.ts";
import { onChannelTurnOk } from "../src/lib/api-error-resume.ts";

const deps = {
  answerable: () => undefined, waiting: () => [], rearmResume: () => {}, consume: () => {}, pushBack: async () => {}, nudgeAmbiguous: () => {},
  markApiError: () => undefined, clearWithheld: () => {}, takeApiErrorNotice: () => [], notify: async () => {}, metric: () => {},
  recovered: () => { throw new Error("关卡出错也不该挡住清零"); },
} as unknown as CallerSettleDeps;
const turn = (event: string, drain: StopTurn["drain"]): StopTurn => ({ cid: "c-master", stopChannelId: "c-master", stopWs: 1, candidateWs: 1, event, drain });

test("正常结束一轮：按频道通知清零，与有没有卡要关无关；以 API 错误结束的不算", async () => {
  const seen: string[] = [];
  onChannelTurnOk((cid) => void seen.push(cid));
  await settleStopTurn(deps, turn("Stop", { text: null })).catch(() => {}); // recovered 抛错：清零已在它之前做完
  expect(seen).toEqual(["c-master"]);
  await settleStopTurn({ ...deps, recovered: () => {} }, turn("StopFailure", { text: null, apiError: true }));
  await settleStopTurn({ ...deps, recovered: () => {} }, turn("Stop", { text: null, apiError: true }));
  expect(seen).toEqual(["c-master"]);
});
