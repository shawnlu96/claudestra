/**
 * 仓库路径的唯一来源。
 *
 * 为什么收口：各处曾各写各的 `${import.meta.dir}/..` / `/../..`——文件一挪位置，
 * 同一行代码就静默指向别处（src/ 或 src/bridge/），install-cli 会把错路径写进
 * launchd plist 且不报错。另外带 `..` 的原样字符串在做目录比较时会失配
 * （lib/control-registrant.ts 记录的 2026-09-21 事故），所以这里一律 resolve 成干净路径。
 *
 * 本文件位于 src/lib/，下面两个相对跳数只在这里写一次；搬动本文件时同步改。
 */
import { resolve } from "path";

/** 源码根：`<repo>/src` */
export const SRC_DIR = resolve(import.meta.dir, "..");
/** 仓库根：`<repo>`（含 package.json / .env / master/ / web/） */
export const REPO_ROOT = resolve(import.meta.dir, "../..");
