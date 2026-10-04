# GuomanTracker

## 重点

- **当前版本 0.1.0**：国漫合集、更新时间与官方播放跳转已经实现；
  第一版按需求暂不提供提醒功能。
- **源码统一维护**：网站源码位于 `guoman-site/`，由当前 GitHub
  仓库直接跟踪；具体变更记录见 [CHANGELOG](CHANGELOG.md)。
- **收录范围**：当前快照共 3,250 个季或作品条目；
  哔哩哔哩已读取完整官方国创索引，其他平台仍为部分收录。

## 一、网站与功能

[访问国漫追更](https://guoman-update-hub.yxl19991104.chatgpt.site/)。
Sites 网站当前仅所有者可访问，GitHub 仓库负责源码版本管理。

网站支持按名称、平台、作品状态和星期筛选，展示官方已公布排期，
并通过链接跳转到视频平台。仅保存节目元数据与官方图片链接，
不下载或存储音视频。

手机端是否唤起 App、是否自动播放，由设备和平台支持决定。
具体收录范围、数据更新规则见 [网站说明](guoman-site/README.md)。

## 二、本地运行

需要 Node.js 22.13.0 或更新版本；采集脚本需要 Python 3。

```sh
cd guoman-site
npm ci
npm run dev
```

类型检查和构建命令：

```sh
npx tsc --noEmit
npm run build
```

## 三、版本与发布维护

以后以当前仓库为源码来源，在一个完整功能或修复通过相关检查后
提交 commit，并推送至 GitHub；在版本记录中说明实际功能与限制。

Sites 的 `project_id`（网站标识，用于关联现有部署）保存在
`guoman-site/.openai/hosting.json`，继续发布时应复用该标识。

原有 Sites 发布 Git 历史保存在本地忽略目录
`.sites-history/guoman-source.git`，用于恢复或准备独立发布目录。
后续 Sites 发布应使用独立目录（例如 `.sites-publish/`），
从当前仓库同步网站源码后再发布，避免在 `guoman-site/` 中重建
嵌套 Git 仓库，导致 GitHub 只记录目录指针而无法看到源码。

依赖、构建产物、编辑器配置、环境变量和发布历史备份均不提交。
