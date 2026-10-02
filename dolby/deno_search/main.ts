// TVBox 杜比站 · 云端搜索函数（Deno Deploy 版）
// 逻辑：拉 GitHub 上的 catalog.json → 按 wd 服务端过滤 → 返回 MacCMS JSON
// 部署：Deno Deploy 新建项目，关联本文件即可，自动获得 https://<项目>.deno.dev

const CATALOG_URLS = [
  "https://cdn.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/catalog.json",
  "https://raw.githubusercontent.com/xiaohuya520/tvbox-dc/main/dolby/catalog.json",
];

let cache: any = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function loadCatalog(): Promise<any> {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;
  for (const url of CATALOG_URLS) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (r.ok) {
        const data = await r.json();
        cache = data;
        cacheTime = now;
        return data;
      }
    } catch {
      // 尝试下一个源
    }
  }
  return cache ?? { code: 1, list: [] };
}

function filterItems(list: any[], wd: string): any[] {
  const keys = wd.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!keys.length) return list;
  return list.filter((it: any) => {
    const hay = [
      it.vod_name,
      it.vod_sub,
      it.vod_remarks,
      it.vod_actor,
      it.vod_director,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return keys.every((k) => hay.includes(k));
  });
}

function json(body: any): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // 健康检查
  if (path === "/ping") {
    return json({ ok: true, t: Date.now() });
  }

  // TG 频道页面中转：本机在国内直连不到 t.me 时，由这个跑在海外的函数代抓。
  // 用法：/tg?ch=频道名[&before=消息ID]
  if (path === "/tg") {
    const ch = url.searchParams.get("ch");
    if (!ch) return new Response("missing ch", { status: 400 });
    let tg = "https://t.me/s/" + encodeURIComponent(ch);
    const before = url.searchParams.get("before");
    if (before) tg += "?before=" + before;
    try {
      const r = await fetch(tg, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
        redirect: "follow",
      });
      const htmlTxt = await r.text();
      return new Response(htmlTxt, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      return new Response("tg fetch failed: " + String(e), { status: 502 });
    }
  }

  const ac = (url.searchParams.get("ac") || "videolist").toLowerCase();
  const wd = (url.searchParams.get("wd") || "").trim();

  // 详情接口
  if (ac === "detail" && url.searchParams.get("ids")) {
    const cat = await loadCatalog();
    const ids = (url.searchParams.get("ids") || "").split(",");
    const list = (cat.list || []).filter((it: any) => ids.includes(String(it.vod_id)));
    return json({ code: 1, msg: "ok", page: 1, pagecount: 1, limit: list.length, total: list.length, list });
  }

  // 搜索接口（核心）
  if (wd) {
    const cat = await loadCatalog();
    const list = filterItems(cat.list || [], wd);
    return json({
      code: 1,
      msg: "ok",
      page: 1,
      pagecount: 1,
      limit: list.length,
      total: list.length,
      list,
    });
  }

  // 无 wd：返回全量（浏览/分类）
  const cat = await loadCatalog();
  return json(cat);
});
