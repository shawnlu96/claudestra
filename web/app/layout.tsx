import type { Metadata, Viewport } from "next";
import "./globals.css";
// 图片查看器 PhotoSwipe(相册级手势:捏合/双击/下拉关闭)——全局 CSS 只能在根 layout 引
import "photoswipe/dist/photoswipe.css";
import { I18nInit } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Claudestra",
  description: "Claudestra Web 客户端 — 远程操控本地 Claude Code 会话",
  applicationName: "Claudestra",
  // Next 自动注入 <link rel="manifest">（来自 app/manifest.ts），此处只补齐 iOS 主屏相关
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Claudestra",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS「添加到主屏幕」用 apple-touch-icon（全出血方图，iOS 自动圆角）
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Next 16 的 appleWebApp.capable 只发新标准 mobile-web-app-capable；显式补经典
  // apple-mobile-web-app-capable，最大化老版 iOS 触发 standalone 全屏的可靠性。
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 装成 App 后禁止双指缩放/双击放大，贴近原生手感（standalone 下也更稳）
  maximumScale: 1,
  userScalable: false,
  // prin-fc2966：PWA 必须 viewport-fit=cover，否则 env(safe-area-inset-*) 恒为 0
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "rgb(23,24,25)" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning:下面的内联脚本会在水合前给 html 加 data-theme
    <html lang="zh-CN" suppressHydrationWarning>
      {/* body 不设 bg：iOS 取画布色时 body 的 bg 会盖过 html，画布色跟随（globals.css
          canvas-list）必须落在 html 上。页面自身背景由应用壳根容器/面板各自绘制。 */}
      <body className="min-h-full text-base-content antialiased">
        {/* 明暗偏好 paint 前应用(lib/theme.ts 的 localStorage 键)——放 React 里
            要等水合,暗色用户会先白闪一帧 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("cstra_theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`,
          }}
        />
        {/* v2.17.2 启动看门狗(peer 报告:慢链路(DERP 中继)上主 bundle 加载失败/
            超时 → 黑屏/无限转圈,JS 完全没跑,连 client.log 上报都发不出,前端
            一声不吭。内联脚本不依赖 bundle,是唯一能在这种状态下发声的东西):
            25s 内没有任何页面宣告挂载(I18nInit 水合时置 __cstraMounted)就盖一层
            纯 HTML 提示 + 重载按钮,把「静默假死」变成可操作的失败。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{setTimeout(function(){if(window.__cstraMounted)return;var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(20,21,23,.96);color:#e8e8ea;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;font-family:system-ui';d.innerHTML='<div style=\\'font-size:15px;line-height:1.6\\'>\\u9875\\u9762\\u8d44\\u6e90\\u52a0\\u8f7d\\u5931\\u8d25\\u6216\\u7f51\\u7edc\\u8fc7\\u6162<br><span style=\\'font-size:12.5px;opacity:.65\\'>\\u4e3b\\u7a0b\\u5e8f 25 \\u79d2\\u5185\\u672a\\u80fd\\u542f\\u52a8</span></div><button style=\\'padding:9px 26px;border-radius:9px;background:#2b2d31;color:#fff;border:1px solid #4a4d52;font-size:14px\\' onclick=\\'location.reload()\\'>\\u91cd\\u65b0\\u52a0\\u8f7d</button>';document.body.appendChild(d)},25000)}catch(e){}})();`,
          }}
        />
        {/* v2.21.4 iPad 壳:Capacitor Keyboard 插件 resize=native 在 iPad 上按「键盘停靠
            在底部」算 webview 高度,且首帧算出的偏移在本次键盘会话内钉死(stageManagerOffset)
            ——分离/悬浮键盘、键盘期旋转都会把 WebView 缩成一条,下面露出黑底(owner
            2026-09-04 iPad 截图:只剩顶栏+输入框,中间一大块黑)。iPad 改 resize=none:
            WebView 不动,停靠键盘走 Safari 同款视觉视口收缩,悬浮键盘直接盖在上面。
            iPhone 不受影响(插件的 iPad 分支才有这段算法)。要赶在首次弹键盘之前生效,
            所以放内联脚本;Capacitor 的桥在 document start 注入,拿不到就每 100ms 重试 2s。 */}
        <script dangerouslySetInnerHTML={{ __html: "(function(){try{function go(){var C=window.Capacitor;if(!C||!C.isNativePlatform||!C.isNativePlatform())return true;var ipad=navigator.maxTouchPoints>1&&/iPad|Macintosh/.test(navigator.userAgent);if(!ipad){window.__cstraKbMode=\"native\";return true}var K=C.Plugins&&C.Plugins.Keyboard;if(!K||!K.setResizeMode)return false;K.setResizeMode({mode:\"none\"}).then(function(){window.__cstraKbMode=\"none\"},function(){window.__cstraKbMode=\"none?\"});return true}if(!go()){var n=0,t=setInterval(function(){if(go()||++n>20)clearInterval(t)},100)}}catch(e){}})();" }} />
        {/* v2.21.4 React 提交突发探测(追 #185):以「DevTools 钩子」身份在 React 加载前
            挂上 onCommitFiberRoot——同一个宏任务里 ≥30 次提交就是同步更新链;从第 20 次
            起遍历 fiber 树记下本次重渲染的组件名 / 变动的 hook 序号 / 函数指纹(压缩后
            名字不可靠,指纹对回 chunk 再走 source map),派发 cstra:commit-burst 事件由
            应用侧上报到 client.log。真 DevTools 扩展在场时让位(它先装钩子)。 */}
        <script dangerouslySetInnerHTML={{ __html: "(function(){try{if(window.__REACT_DEVTOOLS_GLOBAL_HOOK__)return;var R=new Map(),I=0,C=0,A=false,S=0,T=null,W=0,P=0;function fnOf(t){return typeof t===\"function\"?t:(t&&(typeof t.render===\"function\"?t.render:(typeof t.type===\"function\"?t.type:null)))}function hooksChanged(f){var a=f.alternate;if(!a)return\"new\";var h=f.memoizedState,g=a.memoizedState,i=0,o=[];while(h&&g&&i<40){if(h.memoizedState!==g.memoizedState)o.push(i);h=h.next;g=g.next;i++}return o.join(\",\")}function collect(root){var cur=root.current,n=cur.child;while(n){var fn=fnOf(n.type);if(fn&&n.alternate&&(n.memoizedProps!==n.alternate.memoizedProps||n.memoizedState!==n.alternate.memoizedState)){var k=fn.displayName||fn.name||\"?\";var e=T[k]||(T[k]={n:0,h:{},fp:String(fn).slice(0,140).replace(/\\s+/g,\" \")});e.n++;var hc=hooksChanged(n);if(hc)e.h[hc]=(e.h[hc]||0)+1}if(n.child){n=n.child;continue}while(n&&!n.sibling){n=n.return;if(!n||n===cur){n=null;break}}if(n)n=n.sibling}}function flush(){A=false;var n=C,span=Math.round(performance.now()-S);C=0;if(n>=30&&P<5&&T){P++;var top=Object.keys(T).map(function(k){return[k,T[k]]}).sort(function(a,b){return b[1].n-a[1].n}).slice(0,8).map(function(p){var e=p[1],hs=Object.keys(e.h).map(function(x){return x+\":\"+e.h[x]}).join(\"|\");return p[0]+\"×\"+e.n+(hs?\"{h \"+hs+\"}\":\"\")+' fp:\"'+e.fp+'\"'});var d={n:n,span:span,walked:W,top:top};(window.__cstraCommitBursts=window.__cstraCommitBursts||[]).push(d);try{window.dispatchEvent(new CustomEvent(\"cstra:commit-burst\",{detail:d}))}catch(e){}}T=null;W=0}window.__REACT_DEVTOOLS_GLOBAL_HOOK__={isDisabled:false,supportsFiber:true,renderers:R,inject:function(r){R.set(++I,r);return I},on:function(){},off:function(){},emit:function(){},sub:function(){return function(){}},checkDCE:function(){},setStrictMode:function(){},onCommitFiberUnmount:function(){},onPostCommitFiberRoot:function(){},onCommitFiberRoot:function(id,root){try{if(!A){A=true;S=performance.now();setTimeout(flush,0)}C++;if(C>=20&&W<12){T=T||{};W++;collect(root)}}catch(e){}}}}catch(e){}})();" }} />
        <I18nInit />
        {children}
      </body>
    </html>
  );
}
