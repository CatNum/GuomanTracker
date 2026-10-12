# GuomanTracker

## 重点

- **当前源码版本 0.2.2**：邮箱验证码是账号入口；追番、手动观看进度和合集浏览已实现，目前仅开放哔哩哔哩、腾讯视频与优酷。
- **部署架构**：普通 Next.js 构建保留 EdgeOne 兼容能力；CloudBase 静态网页已发布到[既有共享域名](https://guoman-d1goxm3hhb53752a4-1315191445.tcloudbaseapp.com/)，文件、资源、真实邮箱登录和刷新恢复均已验收。`guoman-user` 用户云函数于 2026-10-12 15:42:30（北京时间）部署并确认 `Active`，函数编号与原配置保留。旧 EdgeOne 三小时临时预览域名只作历史记录。
- **账号验收**：新域名真实邮箱登录后，原五部追番、优先级顺序和师兄啊师兄第 161 集已看完状态均恢复；整页刷新后会话与记录仍在。筛选、目录实时同步和推荐显示也已验证。未新增或删除追番，未修改优先级和观看进度。扫描云函数尚未接入 PG，未部署。仓库模板使用公开占位符，不代表本地环境未配置。
- **源码统一维护**：网站源码位于 `guoman-site/`，由当前 GitHub
  仓库直接跟踪；具体变更记录见 [CHANGELOG](CHANGELOG.md)。
- **收录范围**：当前快照共 3,250 个季或作品条目；
  哔哩哔哩已读取完整官方国创索引，其他平台仍为部分收录。

## 一、网站与功能

[旧版 Sites 网站](https://guoman-update-hub.yxl19991104.chatgpt.site/)仍为 0.1.0，仅所有者可访问。EdgeOne 曾承载 Next.js 预览；其默认三小时临时域名只作历史记录。
当前 Next.js 源码支持普通 `.next` 构建和 CloudBase 静态导出。CloudBase 托管页面调用现有邮箱认证与 `guoman-user`（用户云函数）；登录后通过可信目录动作同步官方日历，游客先浏览内置快照。限量扫描仍未接入 PG。
构建与部署步骤见 [部署说明](docs/deployment.md)。

网站支持按名称、平台、作品状态和星期筛选，展示官方已公布排期，
并通过链接跳转到视频平台。邮箱账号追番与观看进度的云端基本闭环已在真实邮箱会话中验收，
我的追番是个人记录的默认入口，顶部推荐一部有可靠未看更新的作品，下方显示完整追番清单。
清单可按完整名称拼音或账号优先级排序，并按本周更新、未看内容、正在追番和已追平筛选；
推荐不受列表筛选影响。用户可以补录缺失的官方节目链接，新节目标题在官网核验前会明确标为待核验。
点击播放不自动标记看完。观看进度只记录集数及这一集是否看完，集数两侧的「−」「+」按钮每次增减一集。
仅保存节目元数据、个人观看记录与官方图片链接，
不下载或存储音视频。

手机端是否唤起 App、是否自动播放，由设备和平台支持决定。
具体收录范围、数据更新规则见 [网站说明](guoman-site/README.md)。

## 二、本地运行

建议 Node.js 22.21.1；采集脚本需要 Python 3。

```sh
cd guoman-site
npm ci
npm run dev
```

类型检查和构建命令：

```sh
npm test
npm run typecheck
npm run build
node -e "require('@next/env').loadEnvConfig(process.cwd(), false); require('node:child_process').execFileSync('npm', ['run', 'build:cloudbase'], {stdio: 'inherit', env: process.env})"
npm run cloudbase:prepare
```

## 三、版本与发布维护

以后以当前仓库为源码来源，在一个完整功能或修复通过相关检查后
提交 commit，并推送至 GitHub；在版本记录中说明实际功能与限制。

GitHub Actions 在 push / PR 时检查测试、类型、Next.js 构建和云函数打包。
`npm run build` 保留普通 Next.js 构建；CloudBase 静态构建前应从本地忽略的
`.env.local` 加载公开环境配置，并运行 `npm run build:cloudbase`。
EdgeOne 构建能力作为兼容路径保留，旧临时预览域名不作为当前正式站点。
旧 Sites 配置与 `.sites-history/guoman-source.git`（本地发布历史备份）保留供恢复，
不再作为本版本运行或部署入口，不在网站目录重建嵌套 Git 仓库。

依赖、构建产物、编辑器配置、环境变量和发布历史备份均不提交。
