#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_mass.py —— 大规模抓取 TG 公开频道的杜比/4K原盘网盘资源。

核心思路（"巨量"的三个杠杆）：
  1. 【翻页】TG 频道页一次只给最近 ~20 条，必须靠 ?before=<msgid> 一路往前翻历史，
     这是资源量的决定性因素（6 页 → 60 页，量级差 10 倍）。
  2. 【扩源】频道数量从 8 个扩到 20+ 个（夸克/阿里/百度/115 各类网盘频道）。
  3. 【并发】频道之间并发抓取（默认 5 线程，对 4GB 内存友好，不跑浏览器）。

三种联网方式（t.me 在国内被墙，本机直连通常不通，按需选一种）：
  A. 直连     ：python crawl_mass.py                               （能直连 t.me 时才有用）
  B. 本地代理 ：python crawl_mass.py --proxy http://127.0.0.1:7890  （开了 Clash/VPN 时用）
  C. 境外中转 ：python crawl_mass.py --via https://xxx.deno.dev
               经已部署的 Deno 函数（跑在海外）代抓 t.me，本机无需翻墙。
               前提是 deno_search/main.ts 已部署（它带 /tg 中转接口）。

其它参数：
  --max-pages N   每频道最多翻多少页（默认 60）
  --workers N     并发频道数（默认 5）
  --loose         放宽：4K原盘/REMUX 即使没标杜比也收（量更大、纯度略降）
  --dry-run       只统计不写文件
  --selftest      离线自测解析逻辑（无需网络）
"""
import argparse
import html as html_mod
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
CATALOG_PATH = os.path.join(BASE, "data", "catalog.json")

# ---------------------------------------------------------------- 网盘识别
NETDISK_PATTERNS = [
    # 标签必须与 SUN jar 网盘站点的 key 完全一致（阿里云盘/迅雷云盘/天翼云盘），否则壳子路由不到 csp_Pan* 类
    ("夸克网盘", re.compile(r"https?://pan\.quark\.cn/s/[A-Za-z0-9]+")),
    ("百度网盘", re.compile(r"https?://pan\.baidu\.com/s/[A-Za-z0-9_\-]+(?:\?pwd=[A-Za-z0-9]+)?")),
    ("阿里云盘", re.compile(r"https?://(?:www\.)?(?:alipan\.com|aliyundrive\.com)/s/[A-Za-z0-9]+")),
    ("迅雷云盘", re.compile(r"https?://pan\.xunlei\.com/s/[A-Za-z0-9\-]+")),
    ("天翼云盘", re.compile(r"https?://cloud\.189\.cn/t/[A-Za-z0-9]+")),
]
REMUX_RE = re.compile(r"原盘|REMUX|remux|Remux|BluRay|blu-ray|蓝光|UHD|uhd|2160[Pp]|4K原盘|BDMV", re.I)
DOLBY_RE = re.compile(r"杜比视界|杜比全景声|杜比[Dd]olby|dolby\s*vision|dolby\s*atmos|全景声|视界版|杜比版|杜比", re.I)
MSG_RE = re.compile(
    r'<div[^>]*class="[^"]*tgme_widget_message[^"]*"[^>]*data-post="[^"]*?/(\d+)"',
    re.I | re.S,
)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def strip_tags(s):
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return html_mod.unescape(s)


# 广告/签名行特征词（聚合帖的固定标题会被误当成片名）
AD_RE = re.compile(
    r"网盘|分享|集中营|资源库|资源群|频道|群组|导航|电报|合集|整理|持续更新|"
    r"欢迎|关注|收藏|订阅|@\w+|加群|互助|线路|观影|搜索| robots|免责", re.I)
YEAR_RE = re.compile(r"(19|20)\d{2}")
RES_RE = re.compile(r"2160|4K|1080|720|REMUX|原盘|BluRay|UHD|BDMV|蓝光", re.I)


def clean_title(text):
    """从消息正文里提取一个干净的片名。

    很多聚合帖第一条是固定的频道广告语（如「懒狗集中营-115/阿里/百度…影视分享」），
    真正片名在后面。这里按「像不像片名」打分挑最合适的一行。
    """
    lines = [re.sub(r"\s{2,}", " ", l).strip() for l in text.split("\n") if l.strip()]
    if not lines:
        return ""

    def norm(t):
        t = re.sub(r"^[\s\-—【\[（(]*[#＃]?[\s]*", "", t)
        return re.sub(r"\s{2,}", " ", t).strip()[:120]

    def score(l):
        s = 0
        if YEAR_RE.search(l):
            s += 3
        if RES_RE.search(l):
            s += 2
        if AD_RE.search(l):
            s -= 4          # 广告语/频道签名
        if len(l) > 90:
            s -= 3          # 太长基本不是片名
        if re.match(r"^https?://", l):
            s -= 5          # 纯链接行
        return s

    best = max(lines[:12], key=score)
    title = norm(best)
    # 实在挑不出来（全是广告语）就用第一行，但截短
    if not title or AD_RE.search(title) and len(title) > 40:
        title = norm(lines[0])
    return title


def detect_netdisk(raw_html, text):
    """在原始 HTML 和纯文本里找网盘直链，返回 (盘名, 链接)。"""
    for label, pat in NETDISK_PATTERNS:
        m = pat.search(raw_html) or pat.search(text)
        if m:
            return label, m.group(0)
    return None, None


def detect_all_netdisks(raw_html, text):
    """提取一条消息里的【全部】网盘链接。

    聚合分享帖（如 @vip115hot）一条消息常带多个网盘链接，
    只取第一个会漏掉大量资源。夸克优先（本项目主盘），其余按配置顺序。
    """
    found = []
    for label, pat in NETDISK_PATTERNS:
        for m in pat.finditer(raw_html):
            found.append((label, m.group(0)))
        if not found:
            for m in pat.finditer(text):
                found.append((label, m.group(0)))
    # 去重保序；夸克排前面
    seen, out = set(), []
    for label, link in found:
        if link in seen:
            continue
        seen.add(link)
        out.append((label, link))
    out.sort(key=lambda x: 0 if x[0] == "夸克网盘" else 1)
    return out


def parse_channel_page(page_html, channel, cfg):
    """解析一个 t.me/s 页面，返回 (资源列表, 本页最小消息id)。"""
    items = []
    matches = list(MSG_RE.finditer(page_html))
    if not matches:
        return items, None

    bounds = [(m.start(), int(m.group(1))) for m in matches]
    for idx, (start, msgid) in enumerate(bounds):
        end = bounds[idx + 1][0] if idx + 1 < len(bounds) else len(page_html)
        chunk = page_html[start:end]

        raw_links = re.findall(r'href="(https?://[^"]+)"', chunk)
        text = strip_tags(chunk)
        blob = "\n".join(raw_links) + "\n" + text

        # 一条消息可能带多个网盘链接（聚合分享帖），全部提取
        pairs = detect_all_netdisks(chunk, text)
        if not pairs:
            continue

        if cfg.get("require_remux", True) and not REMUX_RE.search(blob):
            continue
        if cfg.get("require_dolby", True) and not DOLBY_RE.search(blob):
            continue
        if any(bad in text for bad in cfg.get("drop_keywords", [])):
            continue

        title = clean_title(text)
        if not title or len(title) < 2:
            continue

        base_feats = []
        if REMUX_RE.search(blob):
            base_feats.append("4K原盘" if ("原盘" in blob or "2160" in blob.lower()) else "蓝光")
        if re.search(r"杜比视界|dolby\s*vision", blob, re.I):
            base_feats.append("杜比视界")
        if re.search(r"杜比全景声|全景声|dolby\s*atmos", blob, re.I):
            base_feats.append("杜比全景声")

        # 每条消息最多取 6 个链接，避免聚合帖刷屏
        for i, (label, link) in enumerate(pairs[:6]):
            feats = base_feats + [label]
            # 同一消息多个盘时用盘名区分，避免影视仓里看起来完全重名
            name = title if i == 0 else "%s · %s" % (title, label)
            items.append({
                "_msgid": msgid,
                "vod_name": name,
                "vod_remarks": "|".join(dict.fromkeys(feats)),
                "vod_content": "来自 TG 公开频道 @%s 的真实原盘/杜比资源（%s）。" % (channel, label),
                "vod_play_from": label,
                "vod_play_url": "正片$" + link,
                "vod_netdisk": label,
                "_link": link,
            })

    min_id = min(m[1] for m in bounds)
    return items, min_id


def fetch(url, timeout=25, proxy=None):
    """发请求：无代理时优先 Scrapling（伪装 TLS 指纹）；有代理或失败则 urllib。"""
    if not proxy:
        try:
            from scrapling.fetchers import Fetcher  # 延迟导入，装不上也能跑
            page = Fetcher.get(url, impersonate="chrome", timeout=timeout, follow_redirects=True)
            body = page.html_content
            if isinstance(body, bytes):
                body = body.decode("utf-8", "ignore")
            if body:
                return body
        except Exception:
            pass
    if proxy:
        op = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    else:
        op = urllib.request.build_opener()
    op.addheaders = [("User-Agent", UA)]
    with op.open(url, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def build_url(channel, before, via):
    """构造频道页地址：可直连 t.me，也可经 Deno 函数中转。"""
    if via:
        u = via.rstrip("/") + "/tg?ch=" + urllib.parse.quote(channel)
        if before:
            u += "&before=%d" % before
        return u
    u = "https://t.me/s/%s" % channel
    if before:
        u += "?before=%d" % before
    return u


def crawl_channel(channel, max_pages, delay, cfg, via=None, proxy=None):
    """串行翻页抓一个频道的历史。"""
    got, before, seen = [], None, set()
    pages_ok = 0
    for _ in range(max_pages):
        url = build_url(channel, before, via)
        try:
            page_html = fetch(url, timeout=cfg.get("timeout", 25), proxy=proxy)
        except Exception as e:
            print("    [%s] 抓取失败: %s" % (channel, str(e)[:80]))
            break
        items, min_id = parse_channel_page(page_html, channel, cfg)
        for it in items:
            if it["_link"] not in seen:
                seen.add(it["_link"])
                got.append(it)
        pages_ok += 1
        if not min_id or min_id == before:
            break  # 没有更旧的消息了
        before = min_id
        time.sleep(delay)
    return channel, got, pages_ok


def merge_into_catalog(new_items, dry_run=False):
    """增量合并：不覆盖已有条目，按网盘链接/片名去重。"""
    catalog = {"code": 1, "msg": "ok", "page": 1, "pagecount": 1,
               "limit": 0, "total": 0, "list": []}
    existing_links, existing_titles = set(), set()
    if os.path.exists(CATALOG_PATH):
        try:
            catalog = json.load(open(CATALOG_PATH, encoding="utf-8"))
        except Exception:
            pass
        for it in catalog.get("list", []):
            u = str(it.get("vod_play_url", ""))
            if "$" in u:
                existing_links.add(u.split("$", 1)[1].strip())
            existing_titles.add(str(it.get("vod_name", "")).strip())

    added = 0
    for it in new_items:
        # 去重主键 = 网盘链接。不同链接就是不同资源，即使片名相同也要保留
        # （聚合帖同一条消息常带多个盘的链接，按片名去重会把它全丢光）
        if it["_link"] in existing_links:
            continue
        existing_links.add(it["_link"])
        existing_titles.add(it["vod_name"].strip())
        catalog["list"].append({
            "vod_id": len(catalog["list"]) + 1,
            "vod_name": it["vod_name"],
            "vod_pic": "",
            "vod_remarks": it["vod_remarks"],
            "vod_year": "",
            "vod_content": it["vod_content"],
            "vod_play_from": it["vod_play_from"],
            "vod_play_url": it["vod_play_url"],
            "vod_netdisk": it["vod_netdisk"],
            "vod_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "vod_hits": 0,
            "vod_score": 0.0,
            "vod_serial": "",
            "vod_status": 1,
            "vod_actor": "",
            "vod_director": "",
            "type_name": "杜比原盘",
        })
        added += 1

    for i, it in enumerate(catalog["list"], 1):
        it["vod_id"] = i
    catalog["total"] = len(catalog["list"])
    catalog["limit"] = len(catalog["list"])

    if not dry_run and added:
        os.makedirs(os.path.dirname(CATALOG_PATH), exist_ok=True)
        json.dump(catalog, open(CATALOG_PATH, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
    return len(catalog["list"]), added


SELFTEST_HTML = """
<div class="tgme_widget_message text_not_supported_wrap" data-post="dianying4K/500">
 <div class="tgme_widget_message_text">泰坦尼克号 1997 4K原盘REMUX 杜比视界 国英双音<br/>
  夸克网盘：https://pan.quark.cn/s/abc123xyz</div>
</div>
<div class="tgme_widget_message text_not_supported_wrap" data-post="dianying4K/499">
 <div class="tgme_widget_message_text">随便一部片 1080P 在线观看 https://example.com/watch</div>
</div>
<div class="tgme_widget_message text_not_supported_wrap" data-post="dianying4K/498">
 <div class="tgme_widget_message_text">沙丘2 2024 2160P UHD 杜比全景声<br/>百度：https://pan.baidu.com/s/1xyzabc</div>
</div>
"""


def selftest():
    cfg = {"require_remux": True, "require_dolby": True, "drop_keywords": ["枪版"]}
    items, min_id = parse_channel_page(SELFTEST_HTML, "dianying4K", cfg)
    print("[自测] 解析到 %d 条有效资源（期望 2 条：泰坦尼克号 + 沙丘2）" % len(items))
    for it in items:
        print("   -", it["vod_name"], "|", it["vod_play_from"], "|", it["_link"])
    print("[自测] 最小消息id =", min_id, "（期望 498，用于 ?before= 翻页）")
    ok = len(items) == 2 and min_id == 498
    print("[自测] 结果:", "✅ 通过" if ok else "❌ 不通过")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-pages", type=int, default=60, help="每个频道最多翻多少页")
    ap.add_argument("--workers", type=int, default=5, help="并发频道数")
    ap.add_argument("--delay", type=float, default=1.0, help="每次翻页间隔秒")
    ap.add_argument("--loose", action="store_true", help="放宽：不强制杜比标注")
    ap.add_argument("--dry-run", action="store_true", help="只统计不写文件")
    ap.add_argument("--proxy", default=None, help="本地代理，如 http://127.0.0.1:7890（开VPN时用）")
    ap.add_argument("--via", default=None, help="境外 Deno 函数中转，如 https://xxx.deno.dev")
    ap.add_argument("--selftest", action="store_true", help="离线自测解析逻辑")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    cfg_all = json.load(open(CONFIG_PATH, encoding="utf-8"))
    src = next((s for s in cfg_all.get("sources", [])
                if s.get("type") == "tg_channel" and s.get("enabled")), None)
    if not src:
        print("✗ config.json 里没有启用的 tg_channel 源")
        sys.exit(1)

    cfg = {
        "require_remux": src.get("require_remux", True),
        "require_dolby": src.get("require_dolby", True) and not args.loose,
        "drop_keywords": cfg_all.get("dolby", {}).get("drop_keywords", []),
        "timeout": cfg_all.get("crawl", {}).get("timeout", 25),
    }
    channels = src.get("channels", [])
    mode = ("经 Deno 中转 " + args.via if args.via
            else ("经代理 " + args.proxy if args.proxy else "直连 t.me"))
    print("联网方式: %s" % mode)
    print("频道数: %d | 每频道最多 %d 页 | 并发 %d | 杜比严格过滤: %s\n"
          % (len(channels), args.max_pages, args.workers, cfg["require_dolby"]))

    all_items = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(crawl_channel, ch, args.max_pages, args.delay, cfg,
                          args.via, args.proxy): ch for ch in channels}
        for f in as_completed(futs):
            ch, got, pages = f.result()
            all_items.extend(got)
            print("  [%-22s] 翻 %2d 页 → 命中 %d 条" % (ch, pages, len(got)))

    print("\n合计新抓到: %d 条" % len(all_items))
    if not all_items:
        print("⚠️  0 条：说明当前联网方式拿不到 t.me 内容，请改用 --proxy 或 --via。")
        return
    total, added = merge_into_catalog(all_items, dry_run=args.dry_run)
    print("去重后新增: %d 条 | catalog.json 现有总量: %d 条" % (added, total))
    if args.dry_run:
        print("（--dry-run：未写入文件）")
    elif added:
        print("已写入 data/catalog.json。下一步：python push_to_github.py")


if __name__ == "__main__":
    main()
