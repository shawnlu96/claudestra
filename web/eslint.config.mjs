// ESLint 9 flat config。
//
// web/package.json 一直声明着 "lint": "eslint"，但仓库里从来没有配置文件 ——
// eslint 9 要求 flat config，缺了就直接报错退出，也就是说这个脚本从未跑通过。
// eslint-config-next 16 已原生导出 flat config（./core-web-vitals、./typescript），
// 不需要 FlatCompat 桥接（用 compat 反而会撞 schema 校验失败）。
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  { ignores: [".next/**", "node_modules/**", ".packages/**", "public/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // React 19 的这条新规则在本项目里信噪比很低：首次跑出的 12 处命中中，11 处
      // 是**合法且无可替代**的用法 —— 在 effect 里读 window.matchMedia / navigator /
      // sessionStorage 做客户端能力检测（SSR 期不存在，只能在 effect 里做）、响应
      // 异步数据到达后切视图、以及 cleanup 里存草稿。规则真正针对的是"能在 render
      // 期直接算出来、却绕道 effect 同步"的反模式，与上述场景不是一回事。
      //
      // 剩下那 1 处真反模式（composer 里 text 变化时重置 slash 面板状态）评估后
      // 保留：修它要么把重置塞进 7 个 setText 调用点、要么包一层 setter 并调整状态
      // 声明顺序，而收益只是省一轮渲染——在输入框这个交互热路径上，风险大于收益。
      //
      // 降为 warn 而不是关掉：新写的代码如果真踩了反模式，仍然看得见。
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];
