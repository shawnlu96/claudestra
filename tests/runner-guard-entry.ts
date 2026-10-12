/**
 * 兼当模块的执行体把它放在第一条 import：静态 import 按顺序求值，这里先于后面的依赖（有的加载时就建运行目录，如 src/lib/paths.ts）。
 * 只在进程入口就是执行体时验；被测试文件 import 时什么都不做。main 分支第一句的 guardRunner() 照留。
 */
import { guardRunner, isRunnerEntry } from "./runner-guard.ts";

if (isRunnerEntry(Bun.main)) guardRunner();
