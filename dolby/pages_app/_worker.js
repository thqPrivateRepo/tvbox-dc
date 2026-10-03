// TVBox 杜比资源站 · 云端服务（Cloudflare Pages Advanced Mode · ES Module 格式）
// ============================================================
// 为什么用 Pages 而不是 Workers：
//   *.workers.dev 在国内被 ISP 的 SNI 阻断（实测 TCP 连接被重置）；
//   新分配的 *.deno.net 同样被阻断；而 ***.pages.dev 实测国内可达（HTTP 200）**。
//   Cloudflare Pages 支持在项目根目录放 _worker.js 接管全部请求（Advanced Mode），
//   等价于一个 Worker，但域名是 pages.dev —— 这是本项目唯一稳定可用的免费云端。
//
// 三个能力：
//   1) /ping                         健康检查
//   2) /?ac=videolist&wd=泰坦尼克号    服务端按 wd 过滤 → 影视仓 type:0 原生可搜
//   3) /tg?ch=频道名[&before=消息ID]   境外代抓 t.me 页面（本服务跑在海外，能访问 t.me）
//                                    → crawl_mass.py --via <本地址> 免翻墙扩充资源
//
// 注意：_worker.js 会接管全部请求，Pages 里的静态文件不再直接对外暴露。

// 注意顺序：raw.githubusercontent 是实时的（推送即生效），必须放第一。
// jsDelivr 有 12 小时缓存，放前面会让刚抓的新资源拉不到旧数据。
const CATALOG_SOURCES = [
  'https://raw.githubusercontent.com/xiaohuya520/tvbox-dc/main/dolby/catalog.json',
  'https://cdn.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/catalog.json',
  'https://fastly.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/catalog.json',
];

let MEM = { data: null, ts: 0 };
const TTL = 5 * 60 * 1000;

// 请求日志（Cache API 存储：同一数据中心跨实例共享，比单实例内存可靠）
const LOG_URL = 'https://tvbox-dolby-search.pages.dev/__logstore__';
const LOG_MAX = 80;

async function getLogs() {
  try {
    const r = await caches.default.match(LOG_URL);
    if (r) return await r.json();
  } catch (e) { /* 空日志 */ }
  return [];
}

async function loadCatalog() {
  if (MEM.data && Date.now() - MEM.ts < TTL) return MEM.data;
  for (const u of CATALOG_SOURCES) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 300 } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.list) && j.list.length) {
        MEM = { data: j, ts: Date.now() };
        return j;
      }
    } catch (e) { /* 换下一个源 */ }
  }
  return MEM.data;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

const json = (obj, code = 200) =>
  new Response(JSON.stringify(obj), { status: code, headers: JSON_HEADERS });

function macCMS(list, page) {
  return JSON.stringify({
    code: 1, msg: 'ok', page: page, pagecount: 1,
    limit: list.length, total: list.length, list: list,
  });
}

// 境外代抓：只允许 t.me，防止被当成开放代理滥用
async function tgProxy(ch, before) {
  if (!/^[A-Za-z0-9_]{3,64}$/.test(ch)) return json({ error: 'bad channel' }, 400);
  let url = 'https://t.me/s/' + ch;
  if (before) url += '?before=' + encodeURIComponent(before);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ua = request.headers.get('user-agent') || '';

    // 诊断日志端点：查看壳子到底发没发请求/发了什么参数
    if (url.pathname === '/log') {
      const logs = await getLogs();
      return json({ count: logs.length, logs: logs.slice(0, LOG_MAX) });
    }

    // 记录请求（诊断用）
    try {
      const logs = await getLogs();
      logs.unshift({
        t: new Date().toISOString().slice(11, 19),
        p: url.pathname + url.search,
        ua: ua.slice(0, 60),
      });
      ctx.waitUntil(caches.default.put(LOG_URL, new Response(
        JSON.stringify(logs.slice(0, LOG_MAX)),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=31536000' } }
      )));
    } catch (e) { /* 日志失败不影响主流程 */ }

    if (url.pathname === '/ping') {
      return json({ ok: true, service: 'tvbox-dolby', time: new Date().toISOString() });
    }

    // 境外代抓 t.me（供 crawl_mass.py --via 使用）
    if (url.pathname === '/tg') {
      return tgProxy(url.searchParams.get('ch') || '', url.searchParams.get('before') || '');
    }

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
        const hay = [it.vod_name, it.vod_remarks, it.vod_actor, it.vod_director,
                     it.vod_content, it.vod_year, it.type_name].join(' ').toLowerCase();
        return kws.every((k) => hay.indexOf(k) >= 0);
      });
    } else if (ids) {
      const set = {};
      ids.split(',').forEach((s) => { set[s.trim()] = 1; });
      list = all.filter((it) => set[String(it.vod_id)]);
    } else if (ac === 'list') {
      const seen = {}; const cls = [];
      all.forEach((it) => {
        const t = it.type_name || '杜比原盘';
        if (!seen[t]) { seen[t] = 1; cls.push({ type_id: cls.length + 1, type_name: t }); }
      });
      return json({ code: 1, msg: 'ok', class: cls, list: [] });
    }

    return new Response(macCMS(list, pg), { headers: JSON_HEADERS });
  },
};
