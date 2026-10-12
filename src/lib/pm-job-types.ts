/**
 * PM 处理员（agents-PMJOB1，docs/architecture/pm-job.md）的落盘形状：statePath("pm-job/<askId>.json") 每单一个文件。
 * 先落盘再认领；bridge 只写 queued / sending / 终态，一次性 worker 只写 running / drafted。
 */
import type { DigestMode } from "./pm-digest.js";

export type PmJobMode = DigestMode;
/** queued → running → drafted → sending → sent；unknown = 发了但结果不明；escalated / observed / dropped 是另外三个终态 */
export type PmJobState = "queued" | "running" | "drafted" | "sending" | "sent" | "unknown" | "escalated" | "observed" | "dropped";
/** 还没有结局的状态：重启扫单看这些 */
export const PM_JOB_OPEN: readonly PmJobState[] = ["queued", "running", "drafted", "sending"];
export const PM_JOB_STATES: readonly PmJobState[] = [...PM_JOB_OPEN, "sent", "unknown", "escalated", "observed", "dropped"];

/** 首版白名单（规格 PM 定 2）；模型不能自己加 */
export const PM_JOB_TYPES = { acceptance: "验收编号 / 范围解释", standard: "标准答复查证", location: "实现位置查证" } as const;

export interface PmJobEvidence { file: string; line: number }

export interface PmJobResult {
  verdict: "answer" | "escalate";
  /** 白名单类型，或升级时模型 / 代码给的类别 */
  type: string;
  answer: string;
  evidence: PmJobEvidence[];
  /** 升级原因（verdict = answer 时为空） */
  reason: string;
  /** 升级时留给 PM 的待批项 */
  pending: string[];
}

export interface PmJobUsage { requests: number; elapsedMs: number; promptChars: number; answerChars: number }

export interface PmJob {
  v: 1;
  askId: string;
  /** 原通知的 messageId（ledger-ask:<askId>）：升级时沿用，同一条不发两次 */
  messageId: string;
  project: string;
  card: string;
  orderId: string;
  /** 提问者：本机 agent 名或 worker@peer */
  target: string;
  /** 接单时的当班 PM：换人就不直回 */
  pm: string;
  specRev: number;
  specPath: string;
  specHash: string;
  repoDir: string;
  /** 批准读取 / 引用的仓库相对路径或 glob */
  paths: string[];
  question: string;
  options: string[];
  mode: PmJobMode;
  modeGen: number;
  /** on 且事先没被代码判成必须升级：成功才直回；false = 只出草稿 */
  direct: boolean;
  /** 接单时代码按问题原文判出的必须升级类别 */
  forbidden: string | null;
  state: PmJobState;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  lease?: { token: string; pid: number; until: number };
  draftPath: string;
  result?: PmJobResult;
  usage?: PmJobUsage;
  /** 终态说明（升级 / 作罢 / 结果不明的原因） */
  note?: string;
  /** 给 PM 的那条（升级原文 / 草稿提示）交出去没有 */
  pmNotice?: "pending" | "handed";
}
