/**
 * Next.js instrumentation(服务端启动钩子)——拉起 Web Push 派发器
 * (常驻订阅 bridge 事件流,回给 api 用户的 reply → 推送)。
 * dev/prod 都会执行;dispatcher 自身幂等(globalThis 单例)。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 登录限流要知道真实对端（是不是本机反代），Route Handler 拿不到 socket，在这里盖章
    const { installPeerStamp } = await import("@/lib/peer-stamp");
    installPeerStamp();
    const { startPushDispatcher } = await import("@/lib/push/dispatcher");
    startPushDispatcher();
  }
}
