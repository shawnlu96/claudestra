/**
 * 邀请落地页 GET /api/v1/invite（不需要 token）：被邀请人点开邀请链接，打开的是**邀请方机器上**的这张页。
 * 邀请码在 # 后面，只在对方浏览器里解，不进任何服务器日志。页面不发请求、不存东西，只负责把对方送回
 * **他自己的** Claudestra 去确认（加入必须由他那边的 bridge 做：我方 token 要存在他那边，我们多半连不到他）。
 * 对方的 Claudestra 地址这张页不知道，也绝不让人填：手机走 App 链接 claudestra://，电脑走浏览器登记过的
 * web+claudestra: 链接，都不行就复制邀请，他打开自己的 Claudestra 时会从剪贴板认出来。
 * 挂在 /api/v1 下是因为 HTTPS 反代和 peer 专用端口都只转发这一段。
 */

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claudestra 协作邀请</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--mute:#6b7385;--line:#e3e6ec;--pri:#3b5bdb;--pri-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--fg:#e8eaf0;--mute:#9aa1b2;--line:#2c3039;--pri:#6f8cff;--pri-fg:#0d1020}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
main{max-width:440px;margin:0 auto;padding:40px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}
h1{font-size:19px;margin:0 0 6px;text-wrap:balance}p{margin:6px 0;color:var(--mute);font-size:13.5px}
.btn{display:block;width:100%;margin-top:12px;padding:12px;border:0;border-radius:11px;background:var(--pri);color:var(--pri-fg);font-size:15px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.btn.sec{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
.small{font-size:12px;color:var(--mute);margin-top:12px}.err{color:#d9480f}.ok{color:#2b8a3e}
</style></head><body><main><div class="card">
<h1 id="title">Claudestra 协作邀请</h1><p id="sub"></p><div id="act"></div>
<p class="small">加入在<b>你自己的</b> Claudestra 里确认。这一页只负责把你送过去，不会存任何东西。</p>
</div></main>
<script>
(function(){
  var code = location.hash.replace(/^#/, "").trim();
  var $ = function(id){ return document.getElementById(id); };
  var inv = null;
  try { inv = JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g,"+").replace(/_/g,"/"))))); } catch (e) {}
  if (!inv || inv.v !== 2 || !inv.name) {
    $("title").textContent = "邀请链接不完整";
    $("sub").innerHTML = '<span class="err">链接里的邀请码缺了或被截断了。请让对方重新复制整条链接发给你。</span>';
    return;
  }
  $("title").textContent = inv.name + " 邀请你的 Claudestra 一起协作";
  $("sub").textContent = "加入后，你的 agent 可以直接找 " + inv.name + " 开放给你的 agent。";
  var mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  var act = $("act");
  function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; act.appendChild(n); return n; }
  function copy(btn){
    var text = inv.name + " 邀请你的 Claudestra 一起协作：" + location.href;
    var done = function(){ btn.textContent = "已复制，现在打开你的 Claudestra"; btn.className = "btn sec ok"; };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, function(){ legacy(text) && done(); }); }
    else if (legacy(text)) done();
  }
  function legacy(text){
    var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove(); return ok;
  }
  var open = el("a", "btn", mobile ? "在 Claudestra App 中打开" : "在我的 Claudestra 中打开");
  open.href = (mobile ? "claudestra://join#" : "web+claudestra:") + code;
  var c = el("button", "btn sec", "复制邀请");
  c.onclick = function(){ copy(c); };
  el("p", "small", mobile
    ? "没装 Claudestra App，或者点了没反应？点「复制邀请」，再打开你的 Claudestra 网页，它会认出剪贴板里的邀请。"
    : "点了没反应，说明你的浏览器还没允许 Claudestra 打开这类链接。点「复制邀请」，再打开你的 Claudestra，它会认出剪贴板里的邀请，并提示你允许，下次就能一键打开。");
})();
</script></body></html>`;

export function invitePageResponse(): Response {
  return new Response(HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // 页面只有内联脚本、不发任何请求；不许被别的站点嵌进 iframe
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}
