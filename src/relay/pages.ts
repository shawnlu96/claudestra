/**
 * front 自己的三张页（docs/relay/protocol.md §6）：首页输短码、/i 邀请落地、实例离线。
 * 无状态、无 secret：短码与邀请载荷都只在浏览器里（# 后面或输入框），页面不发请求给中继、不存东西。
 * base 由 env 校验过是主机名，仍按 HTML / JS 字符串各转义一次，页面模板不信任任何输入。
 */

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--mute:#6b7385;--line:#e3e6ec;--pri:#3b5bdb;--pri-fg:#fff;--err:#d9480f}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--fg:#e8eaf0;--mute:#9aa1b2;--line:#2c3039;--pri:#6f8cff;--pri-fg:#0d1020;--err:#ff8a65}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
main{max-width:440px;margin:0 auto;padding:40px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}
h1{font-size:19px;margin:0 0 6px;text-wrap:balance}p{margin:6px 0;color:var(--mute);font-size:13.5px}
label{display:block;margin-top:14px;font-size:13px;color:var(--mute)}
input{width:100%;margin-top:6px;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font-size:16px}
.btn{display:block;width:100%;margin-top:12px;padding:12px;border:0;border-radius:11px;background:var(--pri);color:var(--pri-fg);
font-size:15px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.btn.sec{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
.small{font-size:12px;color:var(--mute);margin-top:12px}.err{color:var(--err)}
`;

function page(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main><div class="card">${body}</div></main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

/** 首页：输入配对短码 → /c/<code>。没有 JS 时表单以 GET /c?code= 提交，front 同样认 */
export function homePage(base: string, err?: string): string {
  const hint = err === "code" ? `<p class="err">这个配对码无效或已过期，在电脑上重新运行 <code>claudestra pair</code> 拿一个新的。<br>Invalid or expired code.</p>` : "";
  const body = `<h1>Claudestra 中继</h1>
<p>这是一台中继（${esc(base)}）。要用 Claudestra，先在你自己的电脑上安装 bridge，再用它给的配对码登录。<br>
This is a relay. Install Claudestra on your computer first, then sign in with the pairing code it prints.</p>${hint}
<form id="f" method="get" action="/c"><label for="code">配对码 / Pairing code</label>
<input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required>
<button class="btn" type="submit">打开我的 Claudestra · Open</button></form>
<a class="btn sec" href="https://github.com/shawnlu96/claudestra">安装 Claudestra · Install</a>
<p class="small">中继只负责把你送到自己的电脑；不存任何内容。</p>`;
  const script = `document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();
var c=document.getElementById("code").value.toUpperCase().replace(/[\\s-]/g,"");if(c.length!==8)return;location.href="/c/"+c;});`;
  return page("Claudestra 中继", body, script);
}

/**
 * /i 邀请落地（没有 cstra_home cookie 时）：解 # 里的邀请载荷显示「谁邀你」，用户填自己的 slug 或短码就跳到
 * 自己的实例 /join#<载荷>（短码走 /c/<code>，302 时浏览器保留 fragment）。载荷解不出来也照样能用输入框。
 */
export function invitePage(base: string): string {
  const body = `<h1 id="title">Claudestra 协作邀请</h1><p id="sub">正在读取邀请…</p>
<form id="f"><label for="who">你的 Claudestra 名字（网页地址里的那一段）或配对码<br>Your Claudestra name or pairing code</label>
<input id="who" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="mini 或 XXXX-XXXX" required>
<button class="btn" type="submit">去我的 Claudestra 确认 · Continue</button></form>
<a class="btn sec" href="https://github.com/shawnlu96/claudestra">还没有 Claudestra？先安装 · Install first</a>
<p class="small">加入在<b>你自己的</b> Claudestra 里确认。这一页不会存任何东西，邀请码只在你的浏览器里。</p>`;
  const script = `(function(){
var base=${JSON.stringify(base)};var hash=location.hash.replace(/^#/,"");var $=function(i){return document.getElementById(i)};
var inv=null;try{var b=hash.replace(/-/g,"+").replace(/_/g,"/");inv=JSON.parse(decodeURIComponent(escape(atob(b))))}catch(e){}
if(!hash){$("title").textContent="邀请链接不完整";$("sub").innerHTML='<span class="err">链接里的邀请码缺了。请让对方重新复制整条链接。</span>';}
else if(inv&&inv.name){$("title").textContent=inv.name+" 邀请你的 Claudestra 一起协作";$("sub").textContent="加入后，你的 agent 可以直接找 "+inv.name+" 开放给你的 agent。";}
else{$("sub").textContent="有人邀请你的 Claudestra 一起协作。";}
$("f").addEventListener("submit",function(e){e.preventDefault();var v=$("who").value.trim();if(!v)return;
var code=v.toUpperCase().replace(/[\\s-]/g,"");
if(/^[A-Z2-9]{8}$/.test(code)&&!/^[a-z0-9-]{1,32}$/.test(v)){location.href="/c/"+code+"#"+hash;return;}
var slug=v.toLowerCase().replace(/^https?:\\/\\//,"").split("/")[0].split(".")[0];
if(!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug)){$("sub").innerHTML='<span class="err">名字只能是小写字母、数字和中划线。</span>';return;}
location.href="https://"+slug+"."+base+"/join#"+hash;});})();`;
  return page("Claudestra 协作邀请", body, script);
}

/** 隧道目标不在线（或根本没登记）：给一张能看懂的页，不是裸 503 */
export function offlinePage(slug: string, base: string, known: boolean): string {
  const what = known
    ? `<h1>${esc(slug)} 这台电脑现在不在线</h1>
<p>它的 Claudestra 没有连到中继：电脑可能睡眠、关机或断网。等它上线后刷新即可。<br>This computer is offline right now.</p>`
    : `<h1>没有叫 ${esc(slug)} 的 Claudestra</h1>
<p>这个地址没有对应的电脑。检查拼写，或在电脑上运行 <code>claudestra pair</code> 用配对码进入。<br>No such Claudestra on this relay.</p>`;
  const body = `${what}<a class="btn sec" href="javascript:location.reload()">刷新 · Retry</a>
<a class="btn sec" href="https://${esc(base)}/">用配对码进入 · Use a pairing code</a>`;
  return page(known ? "电脑不在线" : "未知的 Claudestra", body);
}
