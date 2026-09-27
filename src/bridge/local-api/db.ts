/** 本地 API 各端点族共用的 web 状态库句柄（lib/web-state.ts）；单测把它指到 ":memory:" 或临时路径 */
import { openWebState } from "../../lib/web-state.js";
import type { Database } from "bun:sqlite";

let dbPath: string | undefined;

export function webDb(): Database {
  return openWebState(dbPath);
}

export function setWebStatePathForTest(path: string | undefined): void {
  dbPath = path;
}
