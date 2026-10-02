#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_mass.py —— 用 Scrapling 大规模抓取 TG 公开频道的杜比/4K原盘网盘资源。

核心思路（"巨量"的三个杠杆）：
  1. 【翻页】TG 频道页一次只给最近 ~20 条，必须靠 ?before=<msgid> 一路往前翻历史，
     这是资源量的决定性因素（首页 6 页 → 60 页，量级差 10 倍）。
  2. 【扩源】频道数量从 8 个扩到 20+ 个（夸克/阿里/百度/115 各类网盘频道）。
  3. 【并发】频道之间并发抓取（默认 5 线程，对 4GB 内存友好，不跑浏览器）。

技术上用 Scrapling 的 Fetcher（伪装 Chrome TLS 指纹）发请求，失败自动回退 urllib；
解析用正则，不依赖浏览器，轻量稳定。

用法（必须在【能上 t.me 的机器】上运行，沙箱网络到不了 t.me）：
  python crawl_mass.py                  # 默认抓，增量合并进 data/catalog.json
  python crawl_mass.py --max-pages 80   # 每频道最多翻 80 页
  python crawl_mass.py --workers 6      # 并发频道数
  python crawl_mass.py --loose          # 放宽：4K原盘/REMUX 即使没标杜比也收
  python crawl_mass.py --dry-run        # 只统计不写文件
  python crawl_mass.py --selftest       # 离线自测解析逻辑（无需网络）
"""
import argparse
import html as html_mod
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
CATALOG_PATH = os.path.join(BASE, "data", "catalog.json")

# ---------------------------------------------------------------- 网盘识别
NETDISK_PATTERNS = [
    ("夸克网盘", re.compile(r"https?://pan\.quark\.cn/s/[A-Za-z0-9]+")),
    ("百度网盘", re.compile(r"https?://pan\.baidu\.com/s/[A-Za-z0-9_\-]+(?:\?pwd=[A-Za-z0-9]+)?")),
    ("阿里网盘", re.compile(r"https?://(?:www\.)?(?:alipan\.com|aliyundrive\.com)/s/[A-Za-z0-9]+")),
    ("迅雷网盘", re.compile(r"https?://pan\.xunlei\.com/s/[A-Za-z0-9\-]+")),
    ("天翼网盘", re.compile(r"https?://cloud\.189\.cn/t/[A-Za-z0-9]+")),
]
REMUX_RE = re.compile(r"原盘|REMUX|remux|Remux|BluRay|blu-ray|蓝光|UHD|uhd|2160[Pp]|4K原盘|BDMV", re.I)
DOLBY_RE = re.compile(r"杜比视界|杜比全景声|杜比[Dd]olby|dolby\s*vision|dolby\s*atmos|全景声|视界版|杜比版|杜比", re.I)
MSG_RE = re.compile(
    r'<div[^>]*class="[^"]*tgme_widget_message[^"]*"[^>]*data-post="[^"]*?/(\d+)"',
    re.I | re.S,
)


def strip_tags(s):
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return html_mod.unescape(s)


def clean_title(text):
    """从消息正文里提取一个干净的片名。"""
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if not lines:
        return ""
    title = lines[0]
    # 去掉开头的频道标签/序号噪音
    title = re.sub(r"^[\s\-—【\[（(]*[#＃]?[\s]*", "", title)
    title = re.sub(r"\s{2,}", " ", title).strip()
    return title[:120]


def detect_netdisk(raw_html, text):
    """在原始 HTML 和纯文本里找网盘直链，返回 (盘名, 链接)。"""
    for label, pat in NETDISK_PATTERNS:
        m = pat.search(raw_html) or pat.search(text)
        if m:
            return label, m.group(0)
    return None, None


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

        label, link = detect_netdisk(blob, text)
        if not link:
            continue

        # 过滤：原盘/REMUX
        if cfg.get("require_remux", True) and not REMUX_RE.search(blob):
            continue
        # 过滤：杜比（--loose 时跳过）
        if cfg.get("require_dolby", True) and not DOLBY_RE.search(blob):
            continue
        # 排除枪版等
        if any(bad in text for bad in cfg.get("drop_keywords", [])):
            continue

        title = clean_title(text)
        if not title or len(title) < 2:
            continue

        feats = []
        if REMUX_RE.search(blob):
            feats.append("4K原盘" if "原盘" in blob or "2160" in blob.lower() else "蓝光")
        if re.search(r"杜比视界|dolby\s*vision", blob, re.I):
            feats.append("杜比视界")
        if re.search(r"杜比全景声|全景声|dolby\s*atmos", blob, re.I):
            feats.append("杜比全景声")
        feats.append(label)

        items.append({
            "_msgid": msgid,
            "vod_name": title,
            "vod_remarks": "|".join(dict.fromkeys(feats)),
            "vod_content": "来自 TG 公开频道 @%s 的真实原盘/杜比资源（%s）。" % (channel, label),
            "vod_play_from": label,
            "vod_play_url": "正片$" + link,
            "vod_netdisk": label,
            "_link": link,
        })

    min_id = min(m[1] for m in bounds)
    return items, min_id


def fetch(url, timeout=25):
    """发请求：优先 Scrapling（伪装 TLS 指纹），失败回退 urllib。"""
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
    # 1) Scrapling
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
    # 2) urllib 兜底
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def crawl_channel(channel, max_pages, delay, cfg):
    """串行翻页抓一个频道的历史。"""
    got, before, seen = [], None, set()
    pages_ok = 0
    for _ in range(max_pages):
        url = "https://t.me/s/%s" % channel
        if before:
            url += "?before=%d" % before
        try:
            page_html = fetch(url, timeout=cfg.get("timeout", 25))
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
        if it["_link"] in existing_links:
            continue
        if it["vod_name"].strip() in existing_titles:
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

    # 重排 vod_id
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
    print("频道数: %d | 每频道最多 %d 页 | 并发 %d | 杜比严格过滤: %s"
          % (len(channels), args.max_pages, args.workers, cfg["require_dolby"]))
    print("注：本脚本需要能访问 t.me 的网络环境；沙箱内跑会因网络不通而 0 条。\n")

    all_items, stats = [], {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(crawl_channel, ch, args.max_pages, args.delay, cfg): ch
                for ch in channels}
        for f in as_completed(futs):
            ch, got, pages = f.result()
            stats[ch] = (len(got), pages)
            all_items.extend(got)
            print("  [%-22s] 翻 %2d 页 → 命中 %d 条" % (ch, pages, len(got)))

    print("\n合计新抓到: %d 条" % len(all_items))
    total, added = merge_into_catalog(all_items, dry_run=args.dry_run)
    print("去重后新增: %d 条 | catalog.json 现有总量: %d 条" % (added, total))
    if args.dry_run:
        print("（--dry-run：未写入文件）")
    elif added:
        print("已写入 data/catalog.json。下一步：python push_to_github.py")


if __name__ == "__main__":
    main()
