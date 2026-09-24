/**
 * 原生壳（Capacitor）判「站外导航」是拿 **保存的服务器地址字符串** 去做前缀比较的：主框架导航的 URL 不以它开头，
 * 就交给系统浏览器打开。WebKit 会把页面地址规范成小写主机名、去掉默认端口，所以保存的地址只要写法和页面实际
 * origin 不一样（大小写、`:443`、多一段路径），冷启动照样能进，之后**每一次**整页导航——刷新、登录后跳转、会话
 * 过期跳登录页——都会被踢去 Chrome。把保存的地址字面对齐成页面 origin 一次即可根治。
 */
export function shellUrlNeedsAlign(saved: string, origin: string): boolean {
  if (!saved || saved === origin) return false;
  try {
    return new URL(saved).origin === origin; // 同一个站、只是写法不同；换了站（另一台机器 / IP）不碰
  } catch {
    return false;
  }
}
