// TVBox 杜比资源站 · 云端搜索代理（Cloudflare Worker · Service Worker 格式）
// ============================================================
// 作用：把 GitHub 上的「静态 catalog.json」变成一个「支持关键词过滤」的
//       MacCMS 兼容接口。影视仓用 type:0 原生方式就能搜索，不需要任何 JS 蜘蛛。
//
// 影视仓搜索时会请求：  <本Worker地址>?ac=videolist&wd=泰坦尼克号
// 本 Worker 从 GitHub 拉取 catalog.json（带5分钟缓存），按 wd 过滤后返回标准
// MacCMS JSON。这样「搜索」100% 在服务端完成，不依赖壳子是否支持 JS。
//
// 部署（免费，5分钟）：
//   1. 打开 https://www.cloudflare.com/ 注册/登录（免费）
//   2. 左侧菜单 Workers & Pages → 创建 → 创建 Worker
//   3. Worker 名称随便填（如 dolby-search），把默认代码全删，粘贴本文件
//   4. 点「部署」
//   5. 得到地址： https://dolby-search.<你的子域>.workers.dev
//   6. 把该地址填进影视仓 type:0 站点的 api 即可（见 README「云端搜索」章节）
//
// 注意：影视仓 type:0 站点 api 填这个地址即可，不要加 /dolby 之类后缀。

const CATALOG_URL =
  'https://raw.githubusercontent.com/xiaohuya520/tvbox-dc/main/dolby/catalog.json';

addEventListener('fetch', function (event) {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const url = new URL(request.url);
  const wd = (url.searchParams.get('wd') || '').trim();
  const ids = url.searchParams.get('ids') || '';
  const pg = Math.max(1, parseInt(url.searchParams.get('pg') || '1', 10) || 1);

  // ---- 拉取并缓存 catalog（避免每次搜索都打 GitHub）----
  let catalog;
  try {
    const cache = caches.default;
    const cacheKey = new Request(CATALOG_URL);
    const cached = await cache.match(cacheKey);
    if (cached) {
      catalog = await cached.json();
    } else {
      const resp = await fetch(CATALOG_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      catalog = await resp.json();
      const toCache = new Response(JSON.stringify(catalog), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'max-age=300',
        },
      });
      event.waitUntil(cache.put(cacheKey, toCache));
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ code: 0, msg: 'fetch catalog failed: ' + e, list: [] }),
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  let list = catalog.list || [];

  // ---- 搜索过滤（wd 存在时）----
  if (wd) {
    const kw = wd.toLowerCase();
    list = list.filter(function (it) {
      return (
        (it.vod_name || '').toLowerCase().includes(kw) ||
        (it.vod_remarks || '').toLowerCase().includes(kw) ||
        (it.vod_actor || '').toLowerCase().includes(kw) ||
        (it.vod_director || '').toLowerCase().includes(kw)
      );
    });
  } else if (ids) {
    // ---- 详情请求（ac=detail&ids=xxx）----
    const idSet = ids.split(',').map(function (s) { return s.trim(); });
    list = list.filter(function (it) { return idSet.indexOf(String(it.vod_id)) >= 0; });
  }

  const out = {
    code: 1,
    msg: 'ok',
    page: pg,
    pagecount: 1,
    limit: list.length,
    total: list.length,
    list: list,
  };

  return new Response(JSON.stringify(out), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
