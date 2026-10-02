#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Deno Deploy 一键部署 TVBox 杜比站搜索函数。

前置：
  1) ~/.workbuddy/secrets/deno_token 存有 Deno Personal Access Token
     （生成地址：https://console.deno.com/account/access-tokens）
  2) deno CLI 已安装（默认 C:/Users/Administrator/Tools/deno/deno.exe；
     可用环境变量 DENO_EXE 覆盖）

运行：
  python deploy_deno.py

脚本会：部署函数 → 把 .deno.dev 地址写回 subscribe.json 第一站 → 推送 GitHub。
"""
import os
import sys
import json
import subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
DENO = os.environ.get("DENO_EXE", r"C:/Users/Administrator/Tools/deno/deno.exe")
PROJECT = "tvbox-dolby-search"
ENTRY = os.path.join(BASE, "deno_search", "main.ts")
TOKEN_PATH = os.path.expanduser("~/.workbuddy/secrets/deno_token")


def read_token():
    with open(TOKEN_PATH, encoding="utf-8") as f:
        return f.read().strip()


def deploy():
    if not os.path.exists(DENO):
        print("✗ 未找到 deno CLI:", DENO)
        print("  请先安装 deno，或设置环境变量 DENO_EXE 指向 deno.exe")
        sys.exit(1)
    if not os.path.exists(ENTRY):
        print("✗ 未找到入口文件:", ENTRY)
        sys.exit(1)
    token = read_token()
    print("[1] 部署到 Deno Deploy (project=%s) ..." % PROJECT)
    env = dict(os.environ, DENO_DEPLOY_TOKEN=token)
    try:
        r = subprocess.run(
            [DENO, "deploy", "--project", PROJECT, "--prod", ENTRY],
            env=env, capture_output=True, text=True, timeout=240,
        )
        if r.stdout:
            print(r.stdout)
        if r.stderr:
            print("STDERR:", r.stderr[:800])
        if r.returncode != 0:
            print("✗ 部署失败 (returncode=%d)" % r.returncode)
            sys.exit(1)
    except subprocess.TimeoutExpired:
        print("✗ 部署超时（240s）")
        sys.exit(1)
    url = "https://%s.deno.dev" % PROJECT
    print("[2] 部署完成，函数地址:", url)
    return url


def patch_subscribe(url):
    sp = os.path.join(BASE, "subscribe.json")
    cfg = json.load(open(sp, encoding="utf-8"))
    sites = cfg.get("sites", [])
    for s in sites:
        if s.get("key") == "DolbyDeno01":
            s["api"] = url
            s["searchable"] = 1
            s["quickSearch"] = 1
            s["playable"] = 1
            break
    else:
        sites.insert(0, {
            "key": "DolbyDeno01",
            "name": "杜比站·Deno云端搜索",
            "type": 0,
            "api": url,
            "searchable": 1,
            "quickSearch": 1,
            "playable": 1,
            "timeout": 20,
        })
    json.dump(cfg, open(sp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("[3] subscribe.json 第一站已切到", url)


def push():
    print("[4] 推送 subscribe.json ...")
    subprocess.run([sys.executable, os.path.join(BASE, "push_to_github.py")], check=True)


if __name__ == "__main__":
    url = deploy()
    patch_subscribe(url)
    push()
    print("\n✅ 完成！影视仓清缓存→重拉订阅后，第一站「杜比站·Deno云端搜索」可搜中文片名。")
    print("   自测地址:", url + "/?ac=videolist&wd=%E6%B3%B0%E5%9D%A6%E5%B0%BC%E5%85%8B%E5%8F%B7")
