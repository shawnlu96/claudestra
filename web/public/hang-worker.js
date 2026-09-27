/*
 * 主线程卡死探针（boot.js ④ 起的 Worker）：主线程每秒 beat 一次，5 秒没心跳就往当前机器的 /api/v1/client-log 报 [hang]，
 * 恢复后再报一条。单独成文件是为了托管方的 CSP 能保持 worker-src 'self'（blob: Worker 会被拦）；请求基址由主线程的 init
 * 消息给（lib/machines.ts 写在 localStorage 的 cstra_api_base 镜像），同源相对路径即可。
 */
var BASE = "", last = Date.now(), paused = false, hung = false, ctx = "", tick = Date.now();
function post(m) {
  fetch(BASE + "/api/v1/client-log", {
    method: "POST", headers: { "Content-Type": "application/json", "x-cstra-device": "1" }, body: JSON.stringify({ lines: [m] }), credentials: "include",
  }).catch(function () {}); // 打点失败无所谓：探针本身不能再制造噪音
}
onmessage = function (e) {
  var m = e.data || {};
  if (m.k === "init") BASE = m.base || "";
  else if (m.k === "beat") {
    if (hung) { hung = false; post("[hang] recovered after " + Math.round((Date.now() - last) / 1000) + "s"); }
    last = Date.now();
    ctx = m.ctx || "";
  } else if (m.k === "vis") { paused = !m.visible; last = Date.now(); }
};
setInterval(function () {
  var now = Date.now(), late = now - tick - 2000;
  tick = now;
  if (paused || hung) return;
  var gap = now - last;
  if (gap > 5000) {
    if (late > gap - 4000) { last = now; return; } // Worker 自己也被冻住（iOS 整页挂起）：不是主线程卡死
    hung = true;
    try { postMessage({ k: "hang", gap: gap }); } catch (e) {} // 主线程真卡死时消息送不出去也没关系，日志已经 post
    post("[hang] main thread unresponsive " + Math.round(gap / 1000) + "s " + ctx);
  }
}, 2000);
