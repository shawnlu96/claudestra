/**
 * 仓库路径的唯一来源（给会被搬动位置的模块用）。
 *
 * 为什么收口：`${import.meta.dir}/..` 这种写法的含义取决于**文件所在目录**——manager.ts
 * 的命令族一搬进 src/manager/，同一行就静默指向 src/，install-cli 会把错路径写进
 * launchd plist 且不报错。所以被拆出去的模块一律从这里取路径，本文件的相对跳数只写一次；
 * 搬动本文件时同步改。
 *
 * REPO_ROOT 刻意保留 `<repo>/src/..` 的原样形态：与 manager.ts 原来的
 * `${import.meta.dir}/..` 逐字相同（master/CLAUDE.md 渲染、plist、日志里的路径都不变）。
 * ⚠ 它带 `..`，拿去做**目录比较**前先 path.resolve（lib/control-registrant.ts 记过这个坑）。
 *
 * 入口文件（launcher / cron / setup / bridge/config 等）各自的 import.meta.dir 写法暂留原样，
 * 它们不会被搬动；清单见 tests/repo-root.test.ts 的白名单。
 */
import { resolve } from "path";

/** 源码根：`<repo>/src`（干净路径） */
export const SRC_DIR = resolve(import.meta.dir, "..");
/** 仓库根：`<repo>/src/..`（形态见文件头） */
export const REPO_ROOT = `${SRC_DIR}/..`;
