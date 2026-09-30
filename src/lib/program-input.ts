/**
 * 程序往 agent 窗口里敲过的键（cron / manager tmux-send-keys 敲进 TUI 的字、重启清场和 tmux-send-keys 发的 C-c）：
 * CC 的会话记录里它们和人在终端里打的没有区别（origin=human、[Request interrupted by user]），bridge 靠这里的记录认出「不是 owner」——
 * 否则 cron 一触发就替 owner 解除了「停」，manager 的 C-c 被记成 owner 叫停（wf2 stop-semantics-3 / esc-keys-2）。
 * 按窗口一个文件（tmux-helper 用和 Esc 护栏同一把窗口钥匙），发键之前写，跨进程共享；写读失败只少认一次，不挡发键。
 * 单测 tests/program-input.test.ts。
 */
import { readFileSync } from "node:fs";
import { assertSchedulerLease } from "./scheduler-lease-env.js";
import { writeJsonAtomicSync } from "./state-file.js";

/** 一次敲键：h = 敲的字的指纹（纯按键如 C-c / Enter 是 ""） */
export interface ProgramInput {
  at: number;
  h: string;
}

const KEEP = 8;
const KEEP_MS = 3_600_000;
/** 会话记录里的一行离程序敲键这么近 = 就是那次敲的（CC 在键到之后几百毫秒内写） */
const NEAR_MS = 5_000;
/** CC 忙时敲进去的字排到回合结束才写进记录：同样的字这么久之内敲过也算程序敲的 */
const SAME_TEXT_MS = 30 * 60_000;

export const inputHash = (text: string): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? Bun.hash(t).toString(36) : "";
};

const near = (list: readonly ProgramInput[], at: number) => list.some((e) => at >= e.at - 500 && at - e.at <= NEAR_MS);

/** 会话记录里的打断标记（at = 写进记录的时刻）是不是程序发的键引起的 */
export const isProgramKey = (list: readonly ProgramInput[], at: number): boolean => near(list, at);

/** 会话记录里一条「终端里打的」（h = inputHash(正文)）是不是程序敲的：刚敲过键，或者同样的字不久前敲过 */
export function isProgramText(list: readonly ProgramInput[], at: number, h: string): boolean {
  return near(list, at) || (!!h && list.some((e) => e.h === h && e.at <= at + 500 && at - e.at <= SAME_TEXT_MS));
}

export function readProgramInputs(path: string): ProgramInput[] {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((e): e is ProgramInput => typeof e?.at === "number" && typeof e?.h === "string") : [];
  } catch {
    return []; // 还没有程序给这个窗口敲过键（或文件坏了）：当没敲过，最坏把这一次当成人
  }
}

/** 记一次敲键（发之前调）。记不下来不抛（bridge 少认一次，键照发）；调度服务子进程失租才抛：这次键本来就不该发 */
export function recordProgramInput(path: string, text: string, now = Date.now()): void {
  assertSchedulerLease();
  try {
    const list = readProgramInputs(path).filter((e) => now - e.at < KEEP_MS);
    writeJsonAtomicSync(path, [...list, { at: now, h: inputHash(text) }].slice(-KEEP));
  } catch (e) {
    console.warn(`⚠️ 程序敲键没记下（bridge 可能把这次当成人在终端里操作）: ${(e as Error).message}`);
  }
}
