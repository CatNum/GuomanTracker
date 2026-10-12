# 国漫个性化追番实施计划

## 重点

**Goal:** 用户补录缺失动漫、微信登录、管理追番和进度，并从「现在看什么」找到尚未看完的节目。

**Architecture:** EdgeOne Pages 托管 Next.js；CloudBase 身份验证和云函数负责账号、数据库与定时元数据扫描。没有配置时页面只显示访客浏览界面，云服务失败保留当前状态。

**Tech Stack:** Next.js、React、CloudBase Web SDK、CloudBase Node SDK、Node 内置测试。

**Spec:** 用户明确要求通用观看场景、占位配置、不保存动漫内容；通知功能仍延后。

**Global Constraints:** 官方 HTTPS 链接白名单；服务端身份来自 CloudBase 上下文；只记录元数据及手动确认的观看进度；完成检查后中文 commit 并推送当前 GitHub 仓库。

## 一、共享接口

节目沿用 `Anime`，新增可选 `latestEpisode`（官网确认的最新集数）、`monitoring`（queued / active / unsupported / error）、`lastScanAt`（上次成功核验）、`lastScanAttemptAt`（失败尝试时间）、`nextScanAt`、`scanError`。未来排期不能当成已发布集数。

观看状态：`seriesId`（节目标识）、`watchedEpisode`（最后完整看过的一集，初始 0）、`positionSeconds`（下一集的手动续看秒数，初始 0）、`paused`（暂停追番）、`updatedAt`、`lastOpenedAt`、`version`（乐观并发版本，初始 1）。打开链接仅更新 lastOpenedAt；进度需要用户确认。

云函数请求 `{action,payload}`，成功 `{ok:true,data}`，失败 `{ok:false,error:{code,message}}`。动作：`library` 返回 `{user:{uid,displayName,avatarUrl?},series,follows}`；`submit` 接收 `{title,url}` 返回 `{series,follow}`；`follow` 接收 `{seriesId}` 返回观看状态；`unfollow` 接收 `{seriesId}`；`progress` 接收 `{seriesId,watchedEpisode,positionSeconds,paused,version}` 返回新观看状态；`open` 接收 `{seriesId}`。客户端不传身份。

集合：`guoman_series`、`guoman_watch_state`、`guoman_monitor_targets`。后端使用目录快照作为已知节目来源，按需写入节目，不一次性扫描全部目录。补录须链接去重且自动追番；每用户每日限制 10 条新补录。监控优先用户补录，热门目标通过显式管理员种子导入，最多 30 条；每次最多扫描 20 条。

共享模块 `cloudbase/shared/official-links.mjs` 导出 `normalizeOfficialUrl(input)` 返回 `{url,platform,id}`，id 是规范化链接 SHA256 的稳定标识。仅允许白名单官网节目详情或播放路径，拒绝频道、搜索、短链、IP 和凭据。后端调用此模块进行补录验证。扫描适配器逐次校验跳转、超时及响应大小；不能可靠解析时保留原元数据并展示错误或 unsupported。

## 二、任务和验收

- [x] 根执行器：写追番领域测试，覆盖已发布/未来排期、已看/未看/暂停、未知进度、重复打开不自动完成；实现领域计算、邮箱登录与隔离存储测试后端。
- [x] 后端独立任务：`cloudbase/functions/guoman-user/`、`cloudbase/shared/user-service.mjs`、`cloudbase/shared/cloudbase-store.mjs`、`cloudbase/tests/user-service.test.mjs`；先失败测试再实现身份隔离、去重、限流、观看更新并发版本。
- [x] 扫描独立任务：`cloudbase/shared/official-links.mjs`、`cloudbase/shared/scanner.mjs`、`cloudbase/functions/guoman-scan/`、`cloudbase/tests/scanner.test.mjs`；先失败测试再实现白名单、限量扫描、退避和可靠元数据解析；提供管理员种子导入脚本，不提供客户端扫描入口。
- [x] 根执行器：Next 标准构建、CloudBase SDK 微信 OAuth 回调与一次性 state 校验、个性化界面和补录表单；保留国漫合集检索。
- [x] 根执行器：打包云函数、EdgeOne / CloudBase 配置模板、数据库权限规则和上线步骤、0.2.0 版本记录。
- [x] 合并检查：Node 测试、TypeScript、Next production build、云函数打包、桌面浏览器走查；真实微信/数据库/部署待账号配置，准确记录此限制。
- [x] 整体审查修复后中文 commit 并 push。

## 三、验收重点

个人数据不通过客户端提供的 UID 读取；重复节目补录不产生重复监控；进度不会因点击播放自动增加；尚未发布的排期不会出现于可看更新；配置缺失时不伪造用户会话；扫描不会下载媒体，不会访问非官网地址。

## 四、实施记录

- 场景已按用户补充抽象为「现在看什么」，不使用吃饭专用入口。
- CloudBase 官方要求入口为 CommonJS，改为 index.js 桥接 entry.mjs，保留共享 ES Module。
- 普通追番也按需建立监控，否则用户无法持续获知更新；新增目标加每日20条限额、追番总数500上限。
- 后端与前端共用官网链接解析和已发布集数判定，避免逻辑漂移。
- 34项本地业务测试、类型检查、生产构建与打包通过；详见 [验证记录](../../verification.md)。
- 按用户要求使用账号占位信息，真实微信/数据库/定时任务/EdgeOne部署留待填值后联调。
