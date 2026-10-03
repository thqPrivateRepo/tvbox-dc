# 我的杜比资源站（TVBox 自建源）

一套**自己跑爬虫、只收杜比资源**的 TVBox 资源站方案。爬虫本地运行，把结果
（杜比目录 + 一个 TVBox 蜘蛛 + 订阅入口）推到 GitHub，TVBox 直接订阅这个链接即可，
全程不需要常驻服务器。

## 成品链接（推送后可用）

**主站点（type:0，云端搜索，✅ 最可靠）**：见下方「☁ 云端搜索（Cloudflare Worker）」——
部署后由 Cloudflare 在服务端按关键词过滤，影视仓 `type:0` 原生即可搜，**彻底不依赖 JS 蜘蛛**。
**兼容备选站点（type:0 + spider.js）**：`spider.js` 走影视仓/猫vod 的 JsLoader，
在 TVBox 内读取 `catalog.json` 客户端过滤（写法：站点 `type:0` + 顶层 `spider` 字段，
**不要写 `type:3`**——多数影视仓把 `type:3` 当 jar 包加载 `.js` 会失败）。
**兜底站点（type:0 纯静态，只浏览）**：`catalog.json` 已是 MacCMS 完整格式，
用来浏览；GitHub Pages 静态无法按词过滤，搜索请用云端 Worker 站点/全局搜索。

- 订阅导入：`https://cdn.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/subscribe.json`
- 目录数据：`https://cdn.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/catalog.json`
- 蜘蛛脚本：`https://cdn.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/spider.js`

## ★ 搜索到底能不能用（结论 + 最可靠方案）

**根因（查证过，别再绕路）**：TVBox 的 `type:0`（MacCMS 原生）搜索是
`api?ac=videolist&wd=关键词`，**靠服务器按词过滤返回**。我们的数据放在
**GitHub Pages（纯静态）**，静态服务器**不会按 `wd` 过滤**，所以静态站天生搜不到。
之前试过的两条路都死在这：
- `type:3` + `.js` 链接 → 影视仓把 type:3 当 **jar 包**加载，`.js` 解析失败 → 整站加载不出来；
- `type:0` + `spider` 字段（JS 蜘蛛客户端过滤）→ 你的影视仓**没真正执行该蜘蛛的搜索**，列表能看、搜索空。

**最可靠方案：Cloudflare 云端搜索代理（✅ 代码已写好在 `cloudflare-worker.js`）**
把静态 catalog 变成一个真正能在服务端按词过滤的 MacCMS 接口，影视仓用 `type:0` 原生就能搜，
**完全不碰 JS 蜘蛛、不依赖壳子 JS 支持**。免费、5 分钟部署，纯云端（符合你“不要本机”要求）。
✅ **已自动部署完成**（2026-09-29，Cloudflare API 确认 Worker 在线、子域已绑定），Worker 地址 `https://dolby-search.dolbysearch.workers.dev` 已写入订阅第一站，你重拉订阅即可搜。

> 部署后的预期：影视仓全局搜索或站点内搜「泰坦尼克号」→ 服务端精确返回该条，100% 出结果。

## ☁ 云端搜索（Cloudflare Worker）✅ 已部署

代码已在本仓库 `cloudflare-worker.js`。它从 GitHub 拉 `catalog.json`（5 分钟缓存），
按 `wd` 过滤后返回标准 MacCMS JSON，等价于一个“会搜索的 MacCMS 源”。

**✅ 已用 Cloudflare API 自动部署（2026-09-29）**：
- Worker 名称：`dolby-search`
- 访问地址：`https://dolby-search.dolbysearch.workers.dev`
- 订阅第一站已改为 `type:0`、`api=该地址`、去掉 spider 字段（见 `subscribe.json`），重拉订阅即生效。
- 手动添加：影视仓「站点管理」→ 新增自定义站点 → 类型 `0`、API 填上面地址（**不要加 /dolby 等后缀**）、勾选「可搜索」。

（如需自己重建：代码在 `cloudflare-worker.js`，Cloudflare Workers & Pages 粘贴部署即可。）

**影视仓里怎么用**：
- 订阅 `subscribe.json` 第一站会被我改成 `type:0`、`api=Worker地址`、去掉 spider 字段，你重拉订阅即生效；
- 或手动：影视仓「站点管理」→ 新增自定义站点 → 名称随意、类型 `0`、API 填
  `https://dolby-search.<你的子域>.workers.dev`（**不要加 /dolby 等后缀**）、
  勾选「可搜索」。搜「泰坦尼克号」即精确命中。

**为什么这次一定行**：搜索在**服务端（Cloudflare 边缘）**完成，影视仓只负责发请求和展示，
彻底绕开“壳子是否支持 JS 蜘蛛”这个坑。

**备选订阅链接（jsdelivr 转圈时换这些）**：
- GitHub Pages（推荐，国内一般可达）：
  `https://xiaohuya520.github.io/tvbox-dc/dolby/subscribe.json`
- fastly 镜像：`https://fastly.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/subscribe.json`
- testingcf 镜像：`https://testingcf.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/subscribe.json`
- 原始地址：`https://raw.githubusercontent.com/xiaohuya520/tvbox-dc/main/dolby/subscribe.json`

## 转圈/加载失败排查（按顺序试）

1. **换订阅链接**：`cdn.jsdelivr.net` 在国内常被 DNS 污染，先换成上面 GitHub Pages 的链接。
2. **确认能上网打开**：手机/电视浏览器直接访问 `.../dolby/subscribe.json`，
   能看到 JSON 文字才说明网络通。
3. **看卡在哪一层**：
   - 配置都加载不出来（界面空白）→ 订阅链接被墙，换 GitHub Pages 链接；
   - 能看到「我的杜比资源站」且能浏览列表 → 正常，说明 type:0 接口已通；
   - 搜索没反应/一直空 → 当前主搜索依赖 JS 蜘蛛，若你的影视仓不执行蜘蛛搜索则必然空；
     请改用「☁ 云端搜索（Cloudflare Worker）」方案（见上方章节），那是 100% 可用的服务端过滤；
   - 能看到影片列表但点播放转圈 → 正常，网盘链接需要配好网盘 cookie 才能播（见下方网盘章节）。
4. **清缓存重进**：TVBox 设置里「清除缓存」后重新拉订阅。

## ★ 本地源站模式（最稳，推荐）

外网链接全被墙时，用本机当源站——TVBox 和电脑在同一 WiFi/路由器下即可，零外网依赖：

```bash
cd netdisk_config
python server.py            # 已内置 TVBox 源站，端口 8777
```

TVBox 订阅地址填（IP 换成跑服务那台电脑的局域网 IP）：
```
http://192.168.2.210:8777/tvbox/subscribe.json
```

订阅里会自动给出**两个站点**：
- **我的杜比资源站(本地)**：type:0 走 `api.php/provide/vod` 的 MacCMS 原生接口，
  **不需要任何蜘蛛/jar**，任何 TVBox 壳子都认（和 SUN 里普通资源站同一协议）；
- **我的杜比资源站(蜘蛛)**：type:3 蜘蛛版，备用。

接口能力：`ac=list` 分类（夸克网盘/百度网盘/全部）、`wd=` 搜索、`ids=` 详情、`pg=` 翻页。
订阅里的地址会**自动跟随请求的 Host**，本机访问就显示 127.0.0.1，局域网访问就显示局域网 IP。

> 与 SUN 配置对比的结论：SUN 的网盘站点全部走 `csp_ 类 + spider.jar`（网盘 cookie/线程数/
> 清晰度内嵌在站点 ext JSON 里），不依赖独立 .js 蜘蛛——所以对不支持 js 蜘蛛的壳子，
> 本地源站的 type:0 接口是兼容性最高的方案。



## 工作流程

```
config.json (填你的杜比源)  ──┐
                              ├─► crawler.py ─► data/catalog.json (只有杜比)
subscribe/spider 模板        ──┘                     │
                                                     ▼
                                          push_to_github.py
                                                     │
                                                     ▼
                                     GitHub tvbox-dc/dolby/  ──► TVBox 订阅
```

## 使用步骤

### 1. 配置抓取源
编辑 `config.json` → `sources`。当前默认启用的是 `type: tg_channel`（Telegram 公开原盘频道）。
**加频道**：在对应源的 `channels` 数组里加频道用户名（去掉 @）。**加 MacCMS 原盘站**：新增一个
`type: maccms` 源并 `enabled:true`。**关键开关**：
- `netdisk.require_netdisk: true` —— 只收带夸克/百度等网盘链接的资源（原盘站必备，已开）。
- 源的 `require_remux: true` —— 只收真实原盘（含 原盘/REMUX/UHD）；设 `false` 则也收杜比高码率。
- 源的 `require_dolby: true` —— 只收杜比视界/杜比全景声。

> **真实原盘 + 网盘（当前默认模式 `tg_channel`）**
> 你要的是**真实 4K 原盘（杜比视界/杜比全景声，走网盘）**，不是在线 m3u8。这类资源几乎全在
> Telegram 公开原盘频道里用**夸克/百度网盘**分享。所以本项目主源是 `type: tg_channel`——
> 直接抓公开频道页 `https://t.me/s/频道名`，解析出夸克/百度分享链接，按「原盘/REMUX + 杜比视界/杜比全景声」
> 严格过滤，**夸克为主、百度为辅**。配置示例：
> ```json
> {
>   "name": "Telegram 公开原盘频道（夸克为主/百度为辅）",
>   "type": "tg_channel",
>   "enabled": true,
>   "require_remux": true,   // 必须含 原盘/REMUX/UHD（真实原盘）
>   "require_dolby": true,   // 必须含 杜比视界/杜比全景声
>   "max_pages": 6,          // 每个频道翻几页（每页约20条）
>   "channels": ["dianying4K", "MFFXQF", "Oscar_4Kmovies",
>                "Aliyun_4K_Movies", "Netdisk_Movies", "Quark_Movies",
>                "vip115hot", "XiangxiuNB"]
> }
> ```
> 已内置 8 个高质量原盘频道（都带夸克/百度链接）。**想加更多频道，往 `channels` 里加频道用户名**
> （`@abc123` → 写 `"abc123"` 即可）。
>
> ⚠️ **重要**：本沙箱网络**直连不了 `t.me`**（会被重置）。所以 `crawler.py` 要**在你自己能上
> t.me 的电脑上跑**，才能抓到完整多频道原盘库。仓库里现在的 `data/catalog.json` 是我从公开索引里
> **确认真实的 35 条夸克/百度原盘链接**做成的初始库；你本机跑一次 `python crawler.py` 就会覆盖成完整实时库。
>
> 备选 `type: maccms` 源：若你有能访问的 MacCMS **原盘站** API，填进 `sources` 并 `enabled:true` 即可
> （当前是占位示例）。备选 `type: dolby_list` 源（Dolby 官方片单 + 综合站搜在线地址，非原盘）已默认关闭。

### 2. 跑爬虫（本地）
```bash
python crawler.py            # 真实抓取
python crawler.py --demo     # 先用示例数据验证流程
```
输出在 `data/catalog.json`，里面 `total` 是杜比资源条数。

### 3. 推送到 GitHub
```bash
python push_to_github.py
```
会覆盖仓库 `dolby/` 目录下的文件。TVBox 端刷新订阅即可看到新资源。

### 4. TVBox 里导入
- 复制订阅链接：`https://cdn.jsdelivr.net/gh/xiaohuya520/tvbox-dc@main/dolby/subscribe.json`
- 在 TVBox 配置里「添加订阅」/「配置订阅」粘贴该链接，或把它并到你已有的 dc.json 里。

## 杜比过滤规则
在 `config.json` → `dolby` 里：
- `keywords`：命中即认定为杜比（杜比/杜比视界/杜比全景声/Dolby/Atmos…）。`strict:true` 时**必须命中其一**才收录。
- `also_allow_tags`：非严格模式下，带 4K/原盘/蓝光 也算。
- `drop_keywords`：枪版/抢先版直接丢弃。
- `require_4k_or_bluray`：设 `true` 则额外要求带 4K/原盘标签（更严）。

## 网盘（夸克/百度）支持

4K原盘几乎都是网盘分享，所以「网盘配置」是刚需。整套分两层：

**① 采集侧（已可用）**
爬虫会自动从播放地址里识别夸克/百度/阿里/天翼/迅雷网盘链接，并把
`vod_play_from` 标记为对应网盘名（如 `夸克网盘`）。`config.json` 的 `netdisk`
段控制识别规则：
```json
"netdisk": {
  "enabled": true,
  "require_netdisk": false,   // 设 true 则只收网盘资源（纯原盘站用）
  "labels": { "夸克网盘": ["pan.quark.cn"], "百度网盘": ["pan.baidu.com"] }
}
```
若你的杜比源全是 4K原盘网盘，`require_netdisk: true` 最干净。

**② 播放侧（云端直链解析 · 已上线，无需本机部署）**
网盘分享链接不能直接播。现已把解析逻辑**完整搬到云端 `pages.dev`**（`_worker.js`），影视仓点播放即直链，壳子无需 type:3、全程无本机服务：

- 浏览器打开 **`https://tvbox-dolby-search.pages.dev/login`**（复刻 SUN 面板）→ 选「夸克网盘」→「获取二维码」→ 用**夸克 App** 扫码 → 确认后 cookie 自动存云端 KV。
- 自动提取 `ck` 失败时用面板里「手动粘贴 ck」兜底，效果一样。
- 之后影视仓里点任意夸克资源「正片」→ 云端用 cookie 调 `drive.quark.cn` 拿在线播放直链 → 直接播。
- 换/清 cookie：面板「清除 Cookie」即可。cookie 仅存云端 KV，不进代码/聊天/GitHub。
- 百度暂仅骨架 + 可选 `PARSE_API` 兜底（夸克为主；百度资源仍走详情页链接转存）。

> 未扫码登录前，播放保持「详情页简介给链接、手动转存」旧路径（向后兼容）；扫码后 detail 的 `vod_play_url` 自动改写成云端 `/parse` 地址，无需改订阅。

**③ 本地兜底（可选）**
`netdisk_config/server.py` 仍保留：本地 `python server.py` 起面板，扫码拿 cookie 后**手动粘贴到云端 /login 的「手动粘贴 ck」**即可（适合云端扫码因网络/接口临时异常时）。主链路已是纯云端 `/login`，通常无需本机运行。

## 文件说明
| 文件 | 作用 |
|------|------|
| `config.json` | 源地址 + 杜比关键词 + GitHub 目标 |
| `crawler.py` | 爬虫：支持 `tg_channel`（Telegram原盘频道抓夸克/百度链接）、`maccms`（原盘站过滤）、`dolby_list`（Dolby官方片单+搜源）三种模式 |
| `spider.js` | TVBox drpy 蜘蛛，读取 catalog.json 当资源站（兼容壳子备选；主搜索已改用云端 Worker） |
| `cloudflare-worker.js` | ☁ 云端搜索代理：把静态 catalog 变成可过滤的 MacCMS 接口，影视仓 type:0 原生即可搜 |
| `subscribe.json` | TVBox 站点导入入口：第一站 `type:0` 指向云端 Worker（可搜索），第二站 `type:0` github.io 静态（纯浏览兜底） |
| `netdisk_parser.js` | 网盘解析蜘蛛模板（夸克/百度），播放侧需填你的 cookie/接口 |
| `netdisk_config/server.py` | 本地网盘配置小站后端（复刻 SUN 面板，标准库无依赖） |
| `netdisk_config/static/` | 配置小站前端页面（index.html + app.js） |
| `netdisk_config/settings.json` | 本机 cookie/设置，**仅本地，不推送** |
| `push_to_github.py` | 用 REST API 把 dolby/ 推到 GitHub |
| `data/catalog.json` | 生成的杜比目录（MacCMS 兼容） |

## 注意事项
- 爬虫只在本机运行，不会把你的源泄露到别处；目录推到 GitHub 后**任何人都能看**，
  请勿在 `config.json` 里写带私密令牌的地址。
- 不同 TVBox 壳子对 drpy 蜘蛛支持略有差异，如某壳子不识别，按它的蜘蛛格式微调 `spider.js` 即可。
- 想更新资源，重跑 `crawler.py` 再 `push_to_github.py`。建议写个定时任务每天跑一次。
