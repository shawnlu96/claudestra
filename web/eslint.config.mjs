// ESLint 9 flat config。
//
// web/package.json 一直声明着 "lint": "eslint"，但仓库里从来没有配置文件 ——
// eslint 9 要求 flat config，缺了就直接报错退出，也就是说这个脚本从未跑通过。
// eslint-config-next 16 已经原生导出 flat config（./core-web-vitals、./typescript），
// 不需要 FlatCompat 桥接（用 compat 反而会撞 schema 校验失败）。
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  { ignores: [".next/**", "node_modules/**", ".packages/**", "public/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
];
