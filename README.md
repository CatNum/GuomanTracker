# GuomanTracker

## 重点

- **当前源码版本 0.2.0**：补录、微信 OAuth 登录接口、追番、手动观看进度与
  通用「现在看什么」入口已经实现；提醒功能仍延后。
- **部署目标**：EdgeOne Pages + CloudBase；账号配置均为占位符，尚未部署此版本或验证真实微信授权。
- **源码统一维护**：网站源码位于 `guoman-site/`，由当前 GitHub
  仓库直接跟踪；具体变更记录见 [CHANGELOG](CHANGELOG.md)。
- **收录范围**：当前快照共 3,250 个季或作品条目；
  哔哩哔哩已读取完整官方国创索引，其他平台仍为部分收录。

## 一、网站与功能

[旧版 Sites 网站](https://guoman-update-hub.yxl19991104.chatgpt.site/)仍为 0.1.0，仅所有者可访问。
0.2.0 改用 EdgeOne Pages 托管 Next.js，CloudBase 负责身份、个人数据及限量扫描。
部署配置与所需占位信息见 [部署说明](docs/deployment.md)。

网站支持按名称、平台、作品状态和星期筛选，展示官方已公布排期，
并通过链接跳转到视频平台。微信账号可保存追番与观看进度，
用户可以补录缺失的官方节目链接。「现在看什么」优先展示续看和未看内容，
区分已追平与更新待核验；点击播放不自动标记看完。
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
npm run cloudbase:prepare
```

## 三、版本与发布维护

以后以当前仓库为源码来源，在一个完整功能或修复通过相关检查后
提交 commit，并推送至 GitHub；在版本记录中说明实际功能与限制。

GitHub Actions 在 push / PR 时检查测试、类型、Next.js 构建和云函数打包。
EdgeOne 可连接当前仓库，在配置上线后按分支自动构建。
旧 Sites 配置与 `.sites-history/guoman-source.git`（本地发布历史备份）保留供恢复，
不再作为本版本运行或部署入口，不在网站目录重建嵌套 Git 仓库。

依赖、构建产物、编辑器配置、环境变量和发布历史备份均不提交。
