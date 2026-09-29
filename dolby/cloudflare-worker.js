// TVBox 杜比资源站 · 云端搜索代理（Cloudflare Worker · Service Worker 格式）
// ============================================================
// 作用：把 GitHub 上的「静态 catalog.json」变成一个「支持关键词过滤」的
//       MacCMS 兼容接口。影视仓用 type:0 原生方式就能搜索，不依赖壳子跑 JS。
//
// 影视仓搜索请求：  <本Worker地址>?ac=videolist&wd=泰坦尼克号
// 本 Worker 拉 catalog.json（内存缓存5分钟，jsDelivr 优先、raw 兜底），
// 按 wd 过滤后返回标准 MacCMS JSON。
//
// 注意：*.workers.dev 在国内部分 ISP 被 SNI 阻断（本机实测 TCP 不通）。
//       要在国内稳定使用，需给该 Worker 绑定自定义域名（Cloudflare 免费版即可）。

const CATALOG_SOURCES = [
  'https://cdn.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/catalog.json',
  'https://raw.githubusercontent.com/xiaohuya520/tvbox-dc/main/dolby/catalog.json',
];

// 每个 Worker 实例的内存缓存（不使用 caches.default：它对第三方 URL 行为不可靠）
let MEM = { data: null, ts: 0 };
const TTL = 5 * 60 * 1000;

async function loadCatalog() {
  if (MEM.data && Date.now() - MEM.ts < TTL) return MEM.data;
  for (const u of CATALOG_SOURCES) {
    try {
      const r = await fetch(u, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        cf: { cacheTtl: 300 },
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.list) && j.list.length) {
        MEM = { data: j, ts: Date.now() };
        return j;
      }
    } catch (e) { /* 换下一个源 */ }
  }
  return MEM.data; // 全部源失败时返回旧缓存（宁旧勿空）
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function macCMS(list, page) {
  return JSON.stringify({
    code: 1, msg: 'ok', page: page, pagecount: 1,
    limit: list.length, total: list.length, list: list,
  });
}

addEventListener('fetch', function (event) {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const url = new URL(request.url);

  // 健康检查：浏览器打开 /ping 能看到 JSON 即 Worker 正常
  if (url.pathname === '/ping') {
    return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), { headers: JSON_HEADERS });
  }

  const catalog = await loadCatalog();
  const all = (catalog && catalog.list) || [];
  if (!all.length) {
    return new Response(JSON.stringify({ code: 0, msg: 'catalog load failed', list: [] }), { headers: JSON_HEADERS });
  }

  const wd = (url.searchParams.get('wd') || '').trim();
  const ids = (url.searchParams.get('ids') || '').trim();
  const ac = url.searchParams.get('ac') || 'videolist';
  const pg = Math.max(1, parseInt(url.searchParams.get('pg') || '1', 10) || 1);

  let list = all;

  if (wd) {
    // 支持多关键词（空格分隔 = 同时包含）
    const kws = wd.toLowerCase().split(/\s+/).filter(Boolean);
    list = all.filter(function (it) {
      const hay = [it.vod_name, it.vod_remarks, it.vod_actor, it.vod_director,
                   it.vod_content, it.vod_year, it.type_name].join(' ').toLowerCase();
      return kws.every(function (k) { return hay.indexOf(k) >= 0; });
    });
  } else if (ids) {
    const set = {};
    ids.split(',').forEach(function (s) { set[s.trim()] = 1; });
    list = all.filter(function (it) { return set[String(it.vod_id)]; });
  } else if (ac === 'list') {
    // 分类接口（部分壳子打开站点时会请求 ac=list）
    const seen = {}; const cls = [];
    all.forEach(function (it) {
      const t = it.type_name || '杜比原盘';
      if (!seen[t]) { seen[t] = 1; cls.push({ type_id: cls.length + 1, type_name: t }); }
    });
    return new Response(JSON.stringify({ code: 1, msg: 'ok', class: cls, list: [] }), { headers: JSON_HEADERS });
  }

  return new Response(macCMS(list, pg), { headers: JSON_HEADERS });
}
