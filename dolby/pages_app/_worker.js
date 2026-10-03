// TVBox 杜比资源站 · 云端服务（Cloudflare Pages Advanced Mode · ES Module 格式）
// ============================================================
// 能力一览：
//   1) /ping                         健康检查
//   2) /?ac=videolist&wd=泰坦尼克号    服务端按 wd 过滤（type:1 JSON 接口，影视仓原生可搜）
//   3) /tg?ch=频道[&before=id]         境外代抓 t.me（crawl_mass.py --via 免翻墙扩充资源）
//   4) /log                           请求诊断日志（Cache API 存储）
//   5) /login                         云端网盘配置面板（复刻 SUN，扫码登录拿 cookie）
//   6) /api/qr/start|status           夸克/百度扫码登录（无状态，参数由前端回传）
//   7) /api/cookie/get|save|clear     cookie 读写清（存 KV，绝不进代码/聊天/GitHub）
//   8) /parse?url=分享链接             服务端解析成直链并 302（兜底）
//   9) /papi?url=分享链接              ★JSON 解析接口（type:1 解析）：返回 {"code":200,"url":直链,"header":{UA/Referer/Cookie}}
//  10) detail 把网盘链接注入 vod_content 简介（手动转存兜底）
//
// 播放策略（2026-10-03 定案）：type:1 站点返回裸网盘链接时壳子【不会】调 jar 的 csp_Pan* 类
//   （FongMi 源码实证：壳子本体无任何网盘代码，网盘解析只发生在 type:3 spider 类内部）。
//   正确机制 = 订阅 parses 里加 flags=盘名 的 JSON 解析入口 → 壳子播「夸克网盘」组时自动调
//   /papi 换直链并带上夸克专用 UA 头（与 SUN jar 的 QuarkApi 同款流程：转存→download→带 UA 播放）。
//   云端 cookie 需在 /login 扫码存 KV（与壳子内的 cookie 是两套独立存储）。
// 注意：_worker.js 接管全部请求；cookie 存 KV，解析出网走 drive-pc.quark.cn / pan.baidu.com。

const CATALOG_SOURCES = [
  'https://raw.githubusercontent.com/xiaohuya520/tvbox-dc/main/dolby/catalog.json',
  'https://cdn.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/catalog.json',
  'https://fastly.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/catalog.json',
];

let MEM = { data: null, ts: 0 };
const TTL = 5 * 60 * 1000;

const LOG_URL = 'https://tvbox-dolby-search.pages.dev/__logstore__';
const LOG_MAX = 80;
const QUARK_DEV = 'tvboxdolby00000001';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------------- KV 工具 ----------------
async function kvGet(env, k) {
  try { return await env.KV.get(k); } catch (e) { return null; }
}
async function kvPut(env, k, v) {
  try { await env.KV.put(k, v); return true; } catch (e) { return false; }
}
async function kvPutTtl(env, k, v, ttlSec) {
  try { await env.KV.put(k, v, { expirationTtl: ttlSec }); return true; } catch (e) { return false; }
}

// ---------------- 日志 ----------------
async function getLogs() {
  try { const r = await caches.default.match(LOG_URL); if (r) return await r.json(); } catch (e) {}
  return [];
}

async function logLine(msg) {
  try {
    const logs = await getLogs();
    logs.unshift({ t: new Date().toISOString().slice(11, 19), p: msg, ua: 'note' });
    await caches.default.put(LOG_URL, new Response(JSON.stringify(logs.slice(0, LOG_MAX)), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=31536000' },
    }));
  } catch (e) {}
}

// 取壳子拼进来的分享链接。壳子是【直接拼接】（api 以 ?url= 结尾），且不会 URL 编码，
// 所以百度那种带 ?pwd= 的链接要原样保留尾部，不能只取 searchParams。
function extractShareUrl(url) {
  const s = url.search || '';
  const i = s.indexOf('url=');
  let raw = i >= 0 ? s.slice(i + 4) : (url.searchParams.get('url') || '');
  try { if (/%[0-9A-Fa-f]{2}/.test(raw)) raw = decodeURIComponent(raw); } catch (e) {}
  return raw.trim();
}

async function loadCatalog() {
  if (MEM.data && Date.now() - MEM.ts < TTL) return MEM.data;
  for (const u of CATALOG_SOURCES) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 300 } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.list) && j.list.length) { MEM = { data: j, ts: Date.now() }; return j; }
    } catch (e) {}
  }
  return MEM.data;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};
const json = (obj, code = 200) => new Response(JSON.stringify(obj), { status: code, headers: JSON_HEADERS });

function macCMS(list, page) {
  return JSON.stringify({
    code: 1, msg: 'ok', page: page, pagecount: 1,
    limit: list.length, total: list.length, list: list,
  });
}

// ---------------- 境外代抓 t.me ----------------
async function tgProxy(ch, before) {
  if (!/^[A-Za-z0-9_]{3,64}$/.test(ch)) return json({ error: 'bad channel' }, 400);
  let url = 'https://t.me/s/' + ch;
  if (before) url += '?before=' + encodeURIComponent(before);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) { return json({ error: String(e) }, 502); }
}

// ---------------- 夸克扫码（移植自 netdisk_config/server.py）----------------
async function quarkStart() {
  const request_id = crypto.randomUUID();
  const url = 'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=' + request_id;
  const r = await fetch(url, { headers: { 'Referer': 'https://pan.quark.cn/', 'Origin': 'https://pan.quark.cn' } });
  const d = await r.json();
  const members = (d.data && d.data.members) || {};
  const token = members.token;
  if (!token) throw new Error('夸克获取token失败: ' + JSON.stringify(d).slice(0, 200));
  return { qrUrl: 'https://su.quark.cn/4_eMHBJ?token=' + token + '&client_id=532&ssb=weblogin', token, request_id };
}
async function quarkPoll(token, request_id) {
  const url = 'https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&request_id=' + request_id + '&token=' + token;
  const r = await fetch(url, { headers: { 'Referer': 'https://pan.quark.cn/', 'Origin': 'https://pan.quark.cn' } });
  const d = await r.json();
  if (d.status !== 2000000) return { st: 'waiting', ticket: '' };
  const m = (d.data && d.data.members) || {};
  const ns = m.newStatus || 0;
  if (ns >= 3) return { st: 'confirmed', ticket: m.serviceTicket || '' };
  if (ns === 2) return { st: 'scanned', ticket: '' };
  return { st: 'waiting', ticket: '' };
}
function setCookieList(headers) {
  let sc = [];
  try {
    if (typeof headers.getSetCookie === 'function') sc = headers.getSetCookie() || [];
  } catch (e) {}
  if (!sc.length) {
    const h = headers.get('set-cookie');
    if (h) sc = h.split(/,(?=[^;,=]+=)/);
  }
  return sc;
}
// 用扫码得到的 serviceTicket 兑换登录 cookie（关键：不做这一步，云端拿到的只是匿名会话）
async function quarkExtractCookie(ticket) {
  const kv = {};
  const push = (headers) => {
    for (const line of setCookieList(headers)) {
      const first = String(line).split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) kv[first.slice(0, i).trim()] = first.slice(i + 1).trim();
    }
  };
  try {
    const url = 'https://pan.quark.cn/account/info?st=' + encodeURIComponent(ticket || '') + '&lw=scan&fr=pc&platform=pc';
    const r = await fetch(url, { headers: { 'User-Agent': QUARK_UA, 'Referer': 'https://pan.quark.cn/', 'Origin': 'https://pan.quark.cn' }, redirect: 'manual' });
    push(r.headers);
  } catch (e) {}
  if (!Object.keys(kv).length) {
    try {
      const r2 = await fetch('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc', { headers: { 'User-Agent': QUARK_UA, 'Referer': 'https://pan.quark.cn/' } });
      push(r2.headers);
    } catch (e) {}
  }
  const parts = Object.entries(kv).map(([k, v]) => k + '=' + v);
  return parts.join('; ');
}

// ---------------- 百度扫码 ----------------
async function baiduStart() {
  const gid = crypto.randomUUID().toUpperCase();
  const url = 'https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=' + gid + '&apiver=v3';
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://pan.baidu.com/' } });
  const d = await r.json();
  if (d.errno !== 0) throw new Error('百度获取二维码失败');
  let img = d.imgurl || '';
  if (img.startsWith('/')) img = 'https://passport.baidu.com' + img;
  return { imgUrl: img, gid, channel_id: d.uid || d.sign || '', sign: d.sign || '' };
}
async function baiduPoll(gid, channel_id) {
  const ts = Date.now();
  const url = 'https://passport.baidu.com/channel/unicast?channel_id=' + channel_id + '&tpl=netdisk&gid=' + gid + '&apiver=v3&tt=' + ts;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://pan.baidu.com/' } });
  const body = await r.text();
  const mm = body.match(/\{.*\}/s);
  if (!mm) return { st: 'waiting', v: null };
  let j; try { j = JSON.parse(mm[0]); } catch (e) { return { st: 'waiting', v: null }; }
  if (j.errno === 0) {
    const v = j.channel_v || {};
    if (v.status === 0) return { st: 'confirmed', v };
    return { st: 'scanned', v };
  }
  return { st: 'waiting', v: null };
}
async function baiduExtractBduss(v) {
  const vcode = v.vcode || '', code = v.code || '', uid = v.uid || '', gid = v.gid || v.callback || '';
  const url = 'https://passport.baidu.com/v3/login/main/qrbdusslogin?'
    + 'vcode=' + encodeURIComponent(vcode) + '&code=' + encodeURIComponent(code)
    + '&cl_v=' + encodeURIComponent(String(v)) + '&gid=' + encodeURIComponent(gid)
    + '&dv=win10_2004&u=' + encodeURIComponent('https://pan.baidu.com/');
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://pan.baidu.com/' } });
  const set = r.headers.get('set-cookie') || '';
  for (const c of set.split(',')) if (c.trim().startsWith('BDUSS=')) return c.trim().split(';')[0];
  return '';
}

// ---------------- 解析：夸克（按 SUN jar QuarkApi 流程重写：token→detail递归→save转存→task轮询→download直链）----------------
// 2026-10-03 实测修正三处（都曾导致解析失败）：
//   ① sharepage/detail 必须 GET —— POST 会被网关拒（405 "Request method 'POST' not supported"）
//   ② 目录判断用 dir:true / file:true —— file_type 恒为 0，区分不了文件与目录
//   ③ 令牌字段是 share_fid_token —— fid_token 为 null；且影片常藏在 1~3 层子目录（根目录多是引流图）
const QUARK_API = 'https://drive-pc.quark.cn/1/clouddrive/';
const QUARK_PR = 'pr=ucpro&fr=pc';
const QUARK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const QUARK_REFERER = 'https://pan.quark.cn/';
const VIDEO_EXT = /\.(mkv|mp4|ts|m2ts|m2t|avi|wmv|mov|flv|iso|webm|m4v|mpg|mpeg|vob|rmvb)$/i;

function quarkShareId(u) { const m = u.match(/pan\.quark\.cn\/s\/([A-Za-z0-9]+)/); return m ? m[1] : ''; }
function quarkHeaders(cookie) {
  const h = { 'User-Agent': QUARK_UA, 'Referer': QUARK_REFERER, 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  return h;
}
async function quarkGet(path, cookie) {
  const u = QUARK_API + path + (path.includes('?') ? '&' : '?') + QUARK_PR;
  const r = await fetch(u, { headers: quarkHeaders(cookie) });
  return r.json();
}
async function quarkPost(path, cookie, body) {
  const u = QUARK_API + path + (path.includes('?') ? '&' : '?') + QUARK_PR;
  const r = await fetch(u, { method: 'POST', headers: quarkHeaders(cookie), body: JSON.stringify(body) });
  return r.json();
}
async function quarkStoken(sid, cookie) {
  const u = QUARK_API + 'share/sharepage/token?' + QUARK_PR;
  const r = await fetch(u, { method: 'POST', headers: quarkHeaders(cookie), body: JSON.stringify({ pwd_id: sid, passcode: '' }) });
  const d = await r.json();
  return (d && d.data && d.data.stoken) || '';
}
async function quarkLs(sid, stoken, pdir, cookie) {
  const path = 'share/sharepage/detail?'
    + 'pwd_id=' + encodeURIComponent(sid) + '&stoken=' + encodeURIComponent(stoken)
    + '&pdir_fid=' + encodeURIComponent(pdir || '0')
    + '&force=1&_page=1&_size=200&_sort=' + encodeURIComponent('file_type:asc,file_name:asc') + '&_dir=asc';
  const d = await quarkGet(path, cookie);
  return (d && d.data && d.data.list) || [];
}
// 递归收集视频文件（最多 4 层，避开根目录的引流图）
async function quarkVideos(sid, stoken, cookie, pdir, depth, acc) {
  if (depth > 4) return acc;
  let list = [];
  try { list = await quarkLs(sid, stoken, pdir, cookie); } catch (e) { return acc; }
  const dirs = [];
  for (const f of list) {
    if (f.dir) { dirs.push(f.fid); continue; }
    const nm = String(f.file_name || '');
    if (f.obj_category === 'video' || VIDEO_EXT.test(nm)) {
      acc.push({ fid: f.fid, token: f.share_fid_token || f.fid_token || '', name: nm, size: f.size || 0 });
    }
  }
  for (const d of dirs) await quarkVideos(sid, stoken, cookie, d, depth + 1, acc);
  return acc;
}
// 返回 {url,name,size} 或 {err}
async function resolveQuark(shareUrl, cookie, env) {
  const sid = quarkShareId(shareUrl);
  if (!sid) return { err: '不是有效的夸克分享链接' };
  // 0) 直链缓存（30 分钟）：避免重复转存占网盘空间
  const ck = 'qc2:' + sid;
  const cached = await kvGet(env, ck);
  if (cached) { try { const j = JSON.parse(cached); if (j.url) return { url: j.url, name: j.name || '', size: j.size || 0 }; } catch (e) {} }
  // 1) stoken
  const stoken = await quarkStoken(sid, cookie);
  if (!stoken) return { err: '获取 stoken 失败（分享可能已失效或需要提取码）' };
  // 2) 递归找视频（取最大的）
  const vids = await quarkVideos(sid, stoken, cookie, '0', 0, []);
  if (!vids.length) return { err: '分享里没找到视频文件' };
  const pick = vids.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  if (!pick.token) return { err: '视频缺少转存令牌（share_fid_token 为空）' };
  // 3) 转存到自己网盘根目录
  const s = await quarkPost('share/sharepage/save', cookie, {
    fid_list: [pick.fid], fid_token_list: [pick.token], to_pdir_fid: '0',
    pwd_id: sid, stoken, pdir_fid: '0', scene: 'link',
  });
  const taskId = s && s.data && s.data.task_id;
  if (!taskId) {
    const fail = s && s.data && s.data.fail_list ? JSON.stringify(s.data.fail_list).slice(0, 160) : '';
    return { err: '转存失败：' + ((s && s.message) || fail || '未知') + '（检查夸克容量/会员）' };
  }
  // 4) 轮询任务拿新 fid
  let newFid = '';
  for (let i = 0; i < 6 && !newFid; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const tr = await quarkGet('task?task_id=' + encodeURIComponent(taskId) + '&retry_index=' + i, cookie);
      const fids = tr && tr.data && tr.data.save_as && tr.data.save_as.save_as_top_fids;
      if (fids && fids.length) newFid = fids[0];
    } catch (e) {}
  }
  if (!newFid) return { err: '转存任务未完成（网盘空间不足或超时）' };
  // 5) 取下载直链
  const dl = await quarkPost('file/download', cookie, { fids: [newFid] });
  const durl = dl && dl.data && Array.isArray(dl.data) && dl.data[0];
  if (!durl) return { err: '取直链失败：' + ((dl && dl.message) || '未知') };
  await kvPutTtl(env, ck, JSON.stringify({ url: durl, name: pick.name, size: pick.size }), 1800);
  return { url: durl, name: pick.name, size: pick.size };
}
// ---------------- 解析：百度（骨架 + PARSE_API 兜底）----------------
function baiduSurl(u) { const m = u.match(/pan\.baidu\.com\/s\/([A-Za-z0-9_-]+)/); return m ? m[1] : ''; }
async function parseBaidu(shareUrl, cookie, parseApi) {
  if (parseApi) {
    try {
      const r = await fetch(parseApi + '?type=baidu&url=' + encodeURIComponent(shareUrl), { headers: { 'User-Agent': UA } });
      const j = await r.json(); return j.url || '';
    } catch (e) { return ''; }
  }
  return '';
}

// ---------------- detail 增强：链接注入简介 + play_url 改写 ----------------
function withLinksInContent(list) {
  return list.map((it) => {
    const raw = String(it.vod_play_url || '');
    if (!raw) return it;
    const links = raw.split(/[#$$$]/).map((seg) => { const i = seg.indexOf('$'); return i >= 0 ? seg.slice(i + 1) : seg; }).filter((u) => /^https?:\/\//.test(u));
    if (!links.length) return it;
    const tag = links.map((u) => {
      if (u.includes('pan.quark.cn')) return '夸克: ' + u;
      if (u.includes('pan.baidu.com')) return '百度: ' + u;
      if (u.includes('pan.xunlei.com')) return '迅雷: ' + u;
      if (u.includes('alipan.com') || u.includes('aliyundrive')) return '阿里: ' + u;
      if (u.includes('189.cn')) return '天翼: ' + u;
      return '网盘: ' + u;
    }).join('\n');
    if (String(it.vod_content || '').indexOf(links[0]) >= 0) return it;
    return Object.assign({}, it, {
      vod_content: (it.vod_content ? it.vod_content + '\n\n' : '') + '【网盘链接】复制到浏览器/网盘App打开转存:\n' + tag,
    });
  });
}
// ---------------- 云端网盘配置面板（复刻 SUN，自包含单页）----------------
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>杜比资源站 · 网盘配置</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e6e6;min-height:100vh;display:flex;justify-content:center;padding:24px}
.wrap{width:100%;max-width:560px}.head{background:linear-gradient(90deg,#7b2ff7,#2f80ed);padding:20px 24px;border-radius:14px 14px 0 0;text-align:center}
.head h1{font-size:20px;font-weight:600}.head p{font-size:12px;opacity:.85;margin-top:6px}
.card{background:#1a1d24;border-radius:0 0 14px 14px;padding:20px 22px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.tabs{display:flex;gap:8px;margin-bottom:16px}.tab{flex:1;text-align:center;padding:10px;border-radius:10px;background:#23272f;cursor:pointer;font-size:14px;border:1px solid transparent}
.tab.active{border-color:#2f80ed;color:#fff;background:#2a2f3a}
.row{display:flex;align-items:center;justify-content:space-between;margin:14px 0}
.row label{font-size:14px;color:#b9c0cc}
select,.btn{background:#23272f;color:#e6e6e6;border:1px solid #333a45;border-radius:8px;padding:8px 12px;font-size:14px;cursor:pointer}
.btn:hover{border-color:#2f80ed}.btn.danger{border-color:#b3261e;color:#ff8a80}.btn.primary{background:#2f80ed;border-color:#2f80ed;color:#fff}
.qrbox{margin:14px 0;border:1px dashed #333a45;border-radius:12px;min-height:240px;display:flex;align-items:center;justify-content:center;background:#fff;padding:10px;overflow:hidden}
.qrbox img{width:220px;height:220px;border:0}.qrbox .ph{color:#999;font-size:13px}
.status{text-align:center;min-height:22px;font-size:14px;font-weight:500;margin:8px 0}
.status.waiting{color:#ffb74d}.status.scanned{color:#4fc3f7}.status.confirmed{color:#66bb6a}.status.error{color:#ff8a80}
.cookie-line{font-size:12px;color:#8a93a3;word-break:break-all}.manual{margin-top:12px}
.manual textarea{width:100%;height:64px;background:#11141a;color:#cfd6e0;border:1px solid #333a45;border-radius:8px;padding:8px;font-size:12px;resize:vertical}
.hint{font-size:11px;color:#6b7280;margin-top:6px;line-height:1.5}.divider{height:1px;background:#23272f;margin:18px 0}
.ext-box{margin-top:10px;background:#11141a;border:1px solid #333a45;border-radius:8px;padding:10px;font-size:12px;color:#9fb3c8;word-break:break-all;white-space:pre-wrap;max-height:120px;overflow:auto}
.small{font-size:12px;color:#8a93a3}
</style></head>
<body><div class="wrap"><div class="head"><h1>杜比资源站 · 网盘配置</h1><p>云端扫码登录 · 复刻 SUN 面板 · cookie 仅存云端 KV</p></div>
<div class="card"><div class="tabs"><div class="tab active" data-prov="quark">夸克网盘</div><div class="tab" data-prov="baidu">百度网盘</div></div>
<div class="divider"></div>
<div class="row"><label>扫码登录</label><button class="btn primary" id="loginBtn">获取二维码</button></div>
<div class="qrbox"><span class="ph">点击「获取二维码」后用对应 App 扫描</span></div>
<div class="status" id="status"></div>
<div class="manual"><label class="small">自动提取失败？手动粘贴 cookie（仅存云端，不进聊天/代码）：</label>
<textarea id="manualCookie" placeholder="夸克粘贴 ck=... 整段 / 百度粘贴 BDUSS=... 整段"></textarea>
<div style="margin-top:8px;text-align:right"><button class="btn" id="manualBtn">保存粘贴的Cookie</button></div></div>
<div class="divider"></div>
<div class="row"><div><div class="small">当前Cookie</div><div class="cookie-line" id="cookieState">—</div></div><button class="btn danger" id="clearBtn">清除Cookie</button></div>
<div class="divider"></div>
<div class="row"><label class="small">TVBox 网盘站点 ext（复制后粘到影视仓对应网盘站点 ext）</label></div>
<div class="ext-box" id="extBox">点击「生成 ext」</div><div style="margin-top:8px;text-align:right"><button class="btn" id="extBtn">生成 ext</button></div>
<div class="hint">提示：扫码后 cookie 自动存入云端 KV，影视仓点播放即可直链播放，全程无需本机部署。夸克扫码若提示「接口调整」，用下方手动粘贴 ck 即可。</div>
</div></div>
<script>
var curProv='quark', cur=null;
function setStatus(s,m){var e=document.getElementById('status');e.className='status '+s;e.textContent=m;}
document.querySelectorAll('.tab').forEach(function(t){t.onclick=function(){document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');curProv=t.dataset.prov;refresh();};});
document.getElementById('loginBtn').onclick=function(){
  fetch('/api/qr/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:curProv})}).then(r=>r.json()).then(function(j){
    if(!j.ok){setStatus('error',j.message||'启动失败');return;}
    cur=j;var box=document.querySelector('.qrbox');box.innerHTML='';
    var img=document.createElement('img');
    if(j.imgUrl)img.src=j.imgUrl; else if(j.qrUrl)img.src='https://api.qrserver.com/v1/create-qr-code/?size=220x220&data='+encodeURIComponent(j.qrUrl);
    box.appendChild(img); poll();
  }).catch(function(e){setStatus('error','网络错误');});
};
function poll(){
  fetch('/api/qr/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:curProv,token:cur.token,request_id:cur.request_id,gid:cur.gid,channel_id:cur.channel_id})}).then(r=>r.json()).then(function(j){
    setStatus(j.status,j.message);
    if(j.status==='confirmed'){refresh();return;}
    if(j.status==='error')return;
    setTimeout(poll,2000);
  }).catch(function(){setTimeout(poll,3000);});
}
document.getElementById('manualBtn').onclick=function(){
  var c=document.getElementById('manualCookie').value.trim();if(!c)return;
  fetch('/api/cookie/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:curProv,cookie:c})}).then(r=>r.json()).then(function(j){setStatus(j.ok?'confirmed':'error',j.ok?'已保存':'保存失败');refresh();});
};
document.getElementById('clearBtn').onclick=function(){
  fetch('/api/cookie/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:curProv})}).then(()=>refresh());
};
document.getElementById('extBtn').onclick=function(){
  fetch('/api/tvbox-ext').then(r=>r.json()).then(function(j){document.getElementById('extBox').textContent=j.ext||'—';});
};
function refresh(){
  fetch('/api/cookie/get').then(r=>r.json()).then(function(s){
    var c=s[curProv];document.getElementById('cookieState').textContent=(curProv==='quark'?'夸克: ':'百度: ')+(c&&c.set?(c.masked||'已填'):'未配置');
  });
}
refresh();
</script></body></html>`;

// ---------------- 主入口 ----------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ua = request.headers.get('user-agent') || '';
    const path = url.pathname;
    const isPost = request.method === 'POST';
    const origin = url.origin;

    // 诊断日志端点
    if (path === '/log') { const logs = await getLogs(); return json({ count: logs.length, logs: logs.slice(0, LOG_MAX) }); }
    // 登录面板走独立 /login 路径（根 / 必须留给影视仓的 MacCMS 接口 /?ac=...）
    if (path === '/login') {
      return new Response(LOGIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 记录请求（诊断）
    try {
      const logs = await getLogs();
      logs.unshift({ t: new Date().toISOString().slice(11, 19), p: path + url.search, ua: ua.slice(0, 60) });
      ctx.waitUntil(caches.default.put(LOG_URL, new Response(JSON.stringify(logs.slice(0, LOG_MAX)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=31536000' } })));
    } catch (e) {}

    if (path === '/ping') return json({ ok: true, service: 'tvbox-dolby', time: new Date().toISOString() });
    if (path === '/tg') return tgProxy(url.searchParams.get('ch') || '', url.searchParams.get('before') || '');

    // === 网盘 cookie / 扫码 API ===
    if (path === '/api/cookie/get') {
      const q = await kvGet(env, 'quark_cookie'), b = await kvGet(env, 'baidu_cookie');
      const mask = (c) => c && c.length > 20 ? (c.slice(0, 12) + '…' + c.slice(-6)) : (c ? '已填' : '');
      return json({ quark: { set: !!q, masked: mask(q) }, baidu: { set: !!b, masked: mask(b) } });
    }
    if (path === '/api/cookie/clear' && isPost) {
      const p = await request.json().catch(() => ({})); const prov = p.provider || 'all';
      if (prov === 'all' || prov === 'quark') await kvPut(env, 'quark_cookie', '');
      if (prov === 'all' || prov === 'baidu') await kvPut(env, 'baidu_cookie', '');
      return json({ ok: true });
    }
    if (path === '/api/cookie/save' && isPost) {
      const p = await request.json().catch(() => ({})); const prov = p.provider, cookie = (p.cookie || '').trim();
      if ((prov === 'quark' || prov === 'baidu') && cookie) { await kvPut(env, prov + '_cookie', cookie); return json({ ok: true }); }
      return json({ ok: false }, 400);
    }
    if (path === '/api/qr/start' && isPost) {
      const p = await request.json().catch(() => ({})); const prov = p.provider;
      try {
        if (prov === 'quark') { const r = await quarkStart(); return json({ ok: true, provider: 'quark', qrUrl: r.qrUrl, token: r.token, request_id: r.request_id }); }
        if (prov === 'baidu') { const r = await baiduStart(); return json({ ok: true, provider: 'baidu', imgUrl: r.imgUrl, gid: r.gid, channel_id: r.channel_id }); }
        return json({ ok: false, message: '未知 provider' });
      } catch (e) { return json({ ok: false, message: String(e.message || e) }); }
    }
    if (path === '/api/qr/status' && isPost) {
      const p = await request.json().catch(() => ({})); const prov = p.provider;
      try {
        if (prov === 'quark') {
          const st = await quarkPoll(p.token, p.request_id);
          if (st.st === 'confirmed') {
            const ck = await quarkExtractCookie(st.ticket);
            const good = ck && ck.length > 20 && /__pus|__puus|__uid/.test(ck);
            if (good) await kvPut(env, 'quark_cookie', ck);
            await logLine('qr quark confirmed ck=' + (good ? 'OK(' + ck.length + ')' : 'EMPTY(ticket=' + (st.ticket ? 'Y' : 'N') + ')'));
            return json({ status: 'confirmed', message: good ? '扫码成功，已自动保存 cookie' : '扫码成功，但自动提取失败：请用下方「手动粘贴 ck」保存' });
          }
          return json({ status: st.st === 'scanned' ? 'scanned' : 'waiting', message: st.st === 'scanned' ? '已扫描，请在手机确认' : '等待扫码…' });
        }
        if (prov === 'baidu') {
          const st = await baiduPoll(p.gid, p.channel_id);
          if (st.st === 'confirmed') { const bduss = await baiduExtractBduss(st.v || {}); if (bduss) await kvPut(env, 'baidu_cookie', bduss); return json({ status: 'confirmed', message: '扫码成功' + (bduss ? '（已自动提取BDUSS）' : '（请手动粘贴BDUSS）') }); }
          return json({ status: st.st === 'scanned' ? 'scanned' : 'waiting', message: st.st === 'scanned' ? '已扫描，请在手机确认' : '等待扫码…' });
        }
        return json({ status: 'error', message: '未知 provider' });
      } catch (e) { return json({ status: 'error', message: String(e.message || e) }); }
    }
    if (path === '/api/tvbox-ext') {
      const q = await kvGet(env, 'quark_cookie'), b = await kvGet(env, 'baidu_cookie');
      return json({ ok: true, ext: JSON.stringify({ quark: q || '', baidu: b || '' }) });
    }

    // === 解析接口 ===
    // /papi：TVBox JSON 解析接口（订阅 parses 里 flags=盘名 路由到这里）
    // 返回 {"code":200,"url":直链,"header":{UA/Referer/Cookie}} —— 壳子会带着这些头去播直链
    if (path === '/papi') {
      const u = extractShareUrl(url);
      if (!u) return json({ code: -1, msg: 'missing url' });
      const prov = /pan\.baidu\.com/.test(u) ? 'baidu' : 'quark';
      const cookie = await kvGet(env, prov + '_cookie');
      await logLine('papi ' + prov + ' u=' + u.slice(0, 70) + ' ck=' + (cookie ? 'Y' : 'N'));
      if (!cookie) return json({ code: -1, msg: '云端未登录网盘：请用浏览器打开 ' + origin + '/login 扫码登录夸克（一次即可）' });
      try {
        if (prov === 'quark') {
          const r = await resolveQuark(u, cookie, env);
          if (r.err) { await logLine('papi quark ERR: ' + r.err); return json({ code: -1, msg: r.err }); }
          await logLine('papi quark OK size=' + Math.round((r.size || 0) / 1073741824 * 100) / 100 + 'G');
          // 头部【必须放顶层】：壳子 ParseJob.getHeader() 只读顶层 User-Agent/Referer/Cookie/ua；
          // 另附一份 nested header 兼容其它分支。
          const H = { 'User-Agent': QUARK_UA, 'Referer': QUARK_REFERER, 'Cookie': cookie };
          return json(Object.assign({ code: 200, url: r.url, name: r.name || '', size: r.size || 0, header: H }, H));
        }
        return json({ code: -1, msg: '百度云端解析暂不支持：请用详情页简介里的链接手动转存' });
      } catch (e) { await logLine('papi EXC: ' + String(e.message || e)); return json({ code: -1, msg: '解析异常: ' + String(e.message || e) }); }
    }
    // /parse：302 直链兜底（播放器不带自定义头，夸克原画可能失败；首选走 /papi）
    if (path === '/parse') {
      const u = url.searchParams.get('url') || '';
      if (!u) return json({ error: 'missing url' }, 400);
      const prov = url.searchParams.get('prov') || (/pan\.baidu\.com/.test(u) ? 'baidu' : 'quark');
      const cookie = prov === 'quark' ? await kvGet(env, 'quark_cookie') : await kvGet(env, 'baidu_cookie');
      if (!cookie) return new Response('未配置' + (prov === 'quark' ? '夸克' : '百度') + ' cookie，请先到 /login 扫码登录', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      let play = '';
      try {
        if (prov === 'quark') { const r = await resolveQuark(u, cookie, env); play = r.url || ''; }
        else play = await parseBaidu(u, cookie, await kvGet(env, 'baidu_parse_api'));
      } catch (e) {}
      if (!play) return new Response('解析失败（cookie 可能过期或不支持），请用详情页链接手动转存', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return Response.redirect(play, 302);
    }

    // === 影视仓 MacCMS ===
    const catalog = await loadCatalog();
    const all = (catalog && catalog.list) || [];
    if (!all.length) return json({ code: 0, msg: 'catalog load failed', list: [] });

    const wd = (url.searchParams.get('wd') || '').trim();
    const ids = (url.searchParams.get('ids') || '').trim();
    const ac = url.searchParams.get('ac') || 'videolist';
    const pg = Math.max(1, parseInt(url.searchParams.get('pg') || '1', 10) || 1);

    let list = all;
    if (wd) {
      const kws = wd.toLowerCase().split(/\s+/).filter(Boolean);
      list = all.filter((it) => {
        const hay = [it.vod_name, it.vod_remarks, it.vod_actor, it.vod_director, it.vod_content, it.vod_year, it.type_name].join(' ').toLowerCase();
        return kws.every((k) => hay.indexOf(k) >= 0);
      });
    } else if (ids) {
      const set = {}; ids.split(',').forEach((s) => { set[s.trim()] = 1; });
      list = all.filter((it) => set[String(it.vod_id)]);
    } else if (ac === 'list') {
      const seen = {}; const cls = [];
      all.forEach((it) => { const t = it.type_name || '杜比原盘'; if (!seen[t]) { seen[t] = 1; cls.push({ type_id: cls.length + 1, type_name: t }); } });
      return json({ code: 1, msg: 'ok', class: cls, list: [] });
    }

    // detail：仅把网盘链接注入简介（便于手动转存兜底）。
    // play_url 保持原始分享链接；播放靠订阅 parses 里 flags=盘名 的 JSON 解析入口路由到 /papi。
    if (ac === 'detail') {
      list = withLinksInContent(list);
    }
    return new Response(macCMS(list, pg), { headers: JSON_HEADERS });
  },
};
