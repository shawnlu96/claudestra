/**
 * `ledger submit-verdict` 只收 bridge 签的一次性票据（T97）：bridge 过了身份门（requireVerified）才签，manager 读走即删。
 * 只防误用：agent 照旧习惯在 Bash 里跑子命令（继承了 DISCORD_CHANNEL_ID，照 registry 填 --session / --family）会被拒。
 * 票据 = 一次性文件里的随机数（T85 的一次性文件，lib/caller-cred.ts）+ 绑定 actor 与整张 wire 的哈希：换人、改结论、重放都对不上。
 * 不是安全边界：同用户进程能照这个格式自造一张（manager 没有独立来源可比对，换 MAC / 回 bridge 核销也一样），也能直接写 sqlite；
 * 与 T85 同一威胁模型。已知限制钉在 tests/review-tools.test.ts。
 */
import { createHash } from "node:crypto";
import { CALLER_CRED_FILE_ENV, newCredToken, takeCallerCred, writeOneShot } from "./caller-cred.js";

const proofOf = (token: string, agent: string, wire: string): string => createHash("sha256").update(`${token}\n${agent}\n${wire}`, "utf8").digest("hex");

/** bridge：身份门之后签；file 交给 withOneShot 兜底删 */
export function issueVerdictTicket(agent: string, wire: string): { file: string; proof: string } {
  const token = newCredToken();
  return { file: writeOneShot(token), proof: proofOf(token, agent, wire) };
}

/** manager：读走并删掉文件，按自己算出的 actor 与收到的 wire 重算；对不上或没有票据 = false */
export function redeemVerdictTicket(file: string | undefined, proof: string | undefined, agent: string, wire: string): boolean {
  const token = file ? takeCallerCred({ [CALLER_CRED_FILE_ENV]: file }) : undefined;
  return !!token && !!proof && proofOf(token, agent, wire) === proof;
}
