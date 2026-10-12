# GuomanTracker 双构建部署说明

## 重点

- **双构建架构**：普通 Next.js 构建保留 EdgeOne 兼容能力；CloudBase 静态构建发布到既有 Hosting（静态托管）域名。CloudBase 提供邮箱验证码认证、PG 用户云函数和可信目录读取；元数据扫描仍未接入。
- **当前网页地址**：[CloudBase 既有共享域名](https://guoman-d1goxm3hhb53752a4-1315191445.tcloudbaseapp.com/) 已发布静态页面，文件、资源、真实邮箱登录、目录同步和刷新恢复均已验收。默认域名适用于开发测试，长期自定义域名需另行配置。
- **公开构建配置**：本地公开构建值保存在 Git 忽略的 `.env.local`；仓库中的 `.env.example` 与 `cloudbaserc.example.json` 是占位模板。不要提交本地配置或云函数管理凭证。
- **后端状态**：当前环境使用 CloudBase PG 共享集群，没有文档库或可用 TCP 端点。私有 PG 存储迁移已执行并通过结构后置检查。`guoman-user` 已于 2026-10-12 15:42:30（北京时间）部署并读回 `Active`，函数编号与原配置保留。本地真实邮箱的保存、刷新恢复、重登恢复和双邮箱隔离已验收；扫描函数尚未接入 PG，未部署。
- **功能范围**：通知、提醒和官方平台观看记录自动同步不在此版本。

2026-10-12 09:19:22（北京时间）的 `guoman-user` 更新与 EdgeOne 构建记录属于历史发布记录；当前函数版本已于 15:42:30 再次部署并确认 `Active`。CloudBase 静态前端发布、线上资源核验和邮箱验收记录见第五节。

## 一、配置位置

| 信息 | 配置位置 | 用途 |
| --- | --- | --- |
| CloudBase 环境 ID | 本地 `.env.local` 中的 `NEXT_PUBLIC_CLOUDBASE_ENV_ID`；旧 EdgeOne 构建值仅作历史记录 | 连接身份和云函数环境；仓库模板保持占位符 |
| 环境地域 | `NEXT_PUBLIC_CLOUDBASE_REGION` | 默认上海 `ap-shanghai`，须与实际环境一致 |
| CloudBase 可发布密钥（若环境使用） | `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY` | SDK 的公开应用验证，不是腾讯云服务器密钥 |
| 邮箱验证码身份源与邮件代发 | CloudBase 身份认证控制台 | 当前默认登录方式；首次验证允许自动注册 |
| 微信开放平台网站应用 AppID / AppSecret（可选） | CloudBase 身份源控制台 | 仅旧微信授权兼容；AppSecret 不写入前端或仓库 |
| 网站来源域名 | CloudBase 既有 Hosting 共享域名、CloudBase 安全域名 | SDK 允许来源；仅启用微信时还需其授权回调域 |
| 扫描调度密钥 | 扫描云函数环境变量与定时触发器参数 | 只允许服务器定时任务执行扫描 |

邮箱验证码登录使用现有 CloudBase 账号和函数，不依赖 EdgeOne。若将来启用旧微信路径，回调地址为 `https://YOUR_SITE_DOMAIN/auth/wechat/callback`，并须配置对应回调域。CloudBase 邮件代发限制按**整个环境**每分钟 10 封计，不是每人 10 封；前端 60 秒重发冷却只是交互保护，不能代替服务端频控。

## 二、双构建架构与 EdgeOne 历史记录

`npm run build`（普通 Next.js 构建）继续生成 `.next`，可用于既有 EdgeOne Pages 配置；`npm run build:cloudbase`（CloudBase 静态构建）在隔离临时源码副本生成 `guoman-site/.cloudbase-static/out/`。静态构建仅排除动态 `/api/catalog` 路由，原源码与 `.next` 不会被改写。

CloudBase 构建需从 `guoman-site/.env.local` 读取公开 `NEXT_PUBLIC_CLOUDBASE_*`（浏览器可见 CloudBase 配置），并在同一进程调用构建脚本。脚本不会复制 `.env` 文件；CloudBase 前端与云函数继续共用 `cloudbase/shared` 中的领域模块。

从 `guoman-site` 目录运行检查及双构建：

```sh
cd guoman-site
npm ci
npm test
npm run typecheck
npm run build
node -e "require('@next/env').loadEnvConfig(process.cwd(), false); require('node:child_process').execFileSync('npm', ['run', 'build:cloudbase'], {stdio: 'inherit', env: process.env})"
```

`node -e`（Node.js 单次脚本）先用 Next 的 `loadEnvConfig`（加载 Next 环境配置函数）把 `.env.local` 注入本进程，再由同一进程启动静态构建。不要把任何服务器密钥放入公开变量。CloudBase 游客展示内置目录快照，登录账号通过可信 `getCatalog`（读取目录动作）刷新；普通 Next 模式仍通过 `/api/catalog`（公开目录接口）刷新。

EdgeOne 部署 `dp9qucw95x3k` 和提交 `0f74c69` 是 2026-10-12 的历史发布记录；当时使用的 `guoman-tracker-qukvrr5l.edgeone.dev` 是临时预览域名，生命周期约三小时，不能作为正式站点地址。普通 Next 构建保留为既有部署兼容路径，不代表当前 CloudBase 站点使用该 EdgeOne 域名。

依据：[EdgeOne Next.js 框架支持与构建设置](https://pages.edgeone.ai/document/framework-nextjs)。

## 三、CloudBase 身份与数据库

1. 在当前环境开启邮箱验证码登录与邮件代发，允许首次验证码验证建立用户。网页调用 `signInWithOtp`（发送验证码并智能注册或登录），使用本次发码返回的 `verifyOtp`（校验该邮件验证码的回调）完成验证；再次登录应取得同一账号。环境共享发信上限及前端冷却见第一节。
2. 为网站实际来源配置 CloudBase 安全域名。只有选择继续启用微信兼容路径时，才配置微信网站应用 AppID、AppSecret、授权回调域和对应身份源；邮箱路径不依赖微信配置。
3. 应用 [云函数调用权限](../cloudbase/function-rules.json)：用户函数要求有效非匿名会话，扫描函数禁止客户端调用。云函数入口还须从可信运行时身份读取用户编号，拒绝匿名与空编号，不接受前端自行传入的编号作为授权依据。
4. 当前 PG 共享集群没有文档数据库，旧 `createCloudbaseStore`（文档库访问适配器）不能在本环境使用。[私有 PG 迁移](../cloudbase/migrations/pg-private-v1/README.md)已执行并通过结构后置检查；受信服务端 PG 适配器已完成代码审查并随用户函数部署。真实邮箱会话已验证页面读写与刷新恢复。

**历史 EdgeOne 来源限制（2026-10-12）：**当时测试的临时来源 `https://guoman-tracker-qukvrr5l.edgeone.dev` 未列入环境 `guoman-d1goxm3hhb53752a4` 的安全域名。SDK 默认使用 `GATEWAY`（CloudBase 网关）模式，邮箱验证码请求目标为 `https://guoman-d1goxm3hhb53752a4.api.tcloudbasegateway.com/auth/v1/verification`。按 SDK 请求头执行无发信副作用的 `OPTIONS`（跨域预检）时，该 EdgeOne 来源返回 403 且没有 `Access-Control-Allow-Origin`（允许跨域来源响应头），本地 `http://localhost:3000` 返回 204 并精确允许本地来源。向安全域名列表精确追加 EdgeOne 临时域名的官方 CLI 请求被服务端以 `OperationDenied.FreePackageDenied` 拒绝；读回确认列表未变。此记录解释的是当时 EdgeOne 来源受限，不表示当前 CloudBase Hosting 域名的预检或邮箱登录结果。不可将地域级 `tcb-api` 端点的预检结果代替实际网关验收，也不可使用通配域名或关闭跨域校验。

**仅在实际启用文档数据库的环境中**，下列步骤才适用，不能用于当前 PG 共享集群：创建 `guoman_series`（共享节目元数据）、`guoman_watch_state`（用户追番、进度及限额）、`guoman_monitor_targets`（有限扫描目标）三个集合；为每个集合应用 [数据库规则](../cloudbase/database-rules.json) 中的 `{read:false,write:false}`（拒绝客户端直接访问）规则；为观看集合建立 `owner + kind + _id`（所属账号、文档用途、文档标识）组合索引，为监控集合建立 `source + nextScanAt`（来源、下次扫描时间）组合索引。规则文件只是映射模板，不会自动部署。

此前在本地前端连接真实 CloudBase 的自动验收已用真实邮箱会话完成云端追番列表加载，添加一部原未追番节目，保存第 2 集已看完与未看完状态，并分别整页刷新确认恢复；随后取消该次测试追番，再次刷新确认清单恢复原状。2026-10-12 用户在本地前端手工退出并以同一邮箱重登，确认追番及第 2 集已看完记录恢复；随后保留 A 邮箱窗口，在新无痕窗口登录另一邮箱 B，确认 B 看不到 A 的追番，B 新增另一部追番与进度后，A 刷新仍保留原记录且看不到 B 的新增记录。用户本次新增追番未清理。CloudBase Hosting 页面、资源、邮箱登录、记录恢复、实时目录及整页刷新已验收；未登录或仅公开访问凭证的拒绝、数据库故障时页面保留当前记录并可重试，也仍应作为独立验收项。

正式函数采用单次 SCF `context`（本次调用上下文）中的 `environment`（新格式编码环境字符串）或 `environ`（旧格式编码环境字符串）读取可信账号编号与明确非匿名标记。部署前已用有限只读探针核验：无凭证与仅公开访问凭证的请求在网关被拒绝，CLI 缺少本次身份的调用在函数门禁被拒绝；真实邮箱会话出现本次可信非匿名身份、固定管理 SQL 与数据库角色匹配的成功信号，并确认运行时数据库角色不具有创建角色权限。探针只记录字段是否存在及类型、解析是否成功、账号编号是否存在且非空、匿名标记等布尔信号；日志与客户端响应不包含账号编号、邮箱、凭证或原始上下文及错误详情。当前未开通付费云函数日志；若需排查，继续使用经审查的有限安全信号与真实页面结果，不为诊断擅自开启付费日志。

依据：[邮箱验证码配置](https://docs.cloudbase.net/authentication-v2/method/email-login)、[云函数权限](https://docs.cloudbase.net/cloud-function/security-rules)、[PG 模式概述](https://docs.cloudbase.net/quick-start/pg-overview)。

## 四、云函数打包与部署

```sh
cd guoman-site
npm ci
npm test
npm run typecheck
npm run build
node -e "require('@next/env').loadEnvConfig(process.cwd(), false); require('node:child_process').execFileSync('npm', ['run', 'build:cloudbase'], {stdio: 'inherit', env: process.env})"
npm run cloudbase:prepare
cd ..
# 首次配置时才从模板复制；不要覆盖已有且被 Git 忽略的真实配置：
test -f cloudbaserc.json || cp cloudbaserc.example.json cloudbaserc.json
# 核对本地 cloudbaserc.json 的目标环境，仅覆盖部署现有用户函数：
tcb fn deploy guoman-user -e guoman-d1goxm3hhb53752a4 --force --install-dependency true
# 仅将静态产物上传至既有共享域名根目录；省略远端路径参数，不要传 /，也不要 prune：
tcb hosting deploy guoman-site/.cloudbase-static/out -e guoman-d1goxm3hhb53752a4 --safe --verify
```

Hosting 上传命令必须省略第二个远端路径参数，不能传 `/`。当前使用的 CloudBase CLI 3.8.6 对 manifest 中的前导斜线路径存在缺陷，会导致 `--safe --verify` 校验失败并回滚。不要使用 `--prune` 或清空托管目录；应用包不得覆盖既有 `__auth/**` 认证系统文件或 `cloud-admin/index.html` 管理页。上传到既有共享域名，不创建新域名或购买升级套餐。默认域名用于开发测试，长期自定义域名需另行配置。

`cloudbase:prepare`（云函数打包命令）生成忽略目录 `.cloudbase-deploy`，将独立函数入口、锁定依赖、共享模块和用户函数所需目录快照打包，并检查相对导入。不要直接上传源码函数目录，它的开发导入路径依赖仓库共享目录。

`--force`（覆盖现有同名函数）仅用于已审核的 `guoman-user` 单函数代码；不要使用 `--all`（部署配置中的全部函数），也不要部署 `guoman-scan`。历史版本已通过真实邮箱基本读写验收；本次更新验证了登录、原记录读取、目录同步与刷新恢复，未执行写操作。部署命令本身不能证明跨账号隔离。扫描器尚未接入同一 PG 事务协议，当前不得部署或启用定时调度。部署命令使用本地忽略配置，禁止把环境凭证复制进仓库或终端输出。

`index.main`（云函数执行入口）采用 CommonJS 桥接 `entry.mjs`（业务模块），兼容 CloudBase Nodejs20.19。依赖由云端安装；也可以在各部署包目录 `npm ci` 后上传包内容，入口应位于压缩包最外层。

`cloudbaserc.json`（真实环境部署配置）已被 Git 忽略。模板不自动创建定时触发器，避免没有正确密钥时部署一个失效任务。服务器环境变量 `GUOMAN_SCAN_SECRET`（扫描调度密钥）从管理员环境读取，不能放入公开变量。

依据：[CloudBase CLI 配置](https://docs.cloudbase.net/cli-v1/functions/configs)、[部署命令](https://docs.cloudbase.net/cli-v1/functions/deploy)、[CommonJS 与 ES Module 入口](https://docs.cloudbase.net/cloud-function/how-coding)。

## 五、扫描与上线核验

2026-10-12，静态包已发布到 [CloudBase 既有共享域名](https://guoman-d1goxm3hhb53752a4-1315191445.tcloudbaseapp.com/)。CLI 报告 47 个产物文件上传成功，`verified: true`（校验成功）；远端共 53 个文件，由原有 6 个系统文件和新增 47 个产物组成。原有 6 个系统文件的 eTag（对象版本标记）均保持不变。

首页、`404.html`、微信授权回调页以及首屏 10 个 CSS/JavaScript 资源共 13 个 HTTP 资源均返回 200，响应 SHA-256 与本地静态产物一致。对邮箱验证码地址执行的 `OPTIONS` 预检返回 204，并精确允许当前 CloudBase 来源。浏览器已进入最新页面；首次访问会显示默认域名提示，用户确认后页面可见。

用户随后在该新域名输入邮箱验证码并完成登录，账号页展示完整邮箱和“云端追番记录已加载”。原有五部追番与师兄啊师兄第 161 集已看完状态恢复。登录前游客目录有 3 条快照排期；登录后目录刷新为 19 条，并显示“已同步官方国创更新日历”，证明本次读取为实时数据。筛选“已追平”只显示师兄啊师兄，推荐李熊猫仍可见；清除筛选后恢复五项。名称排序显示为“成也萧河、李熊猫、师兄啊师兄、有兽焉、掌门低调点”，切回优先级顺序时没有写入账号数据。整页刷新后同邮箱会话、五部追番、优先级顺序、第 161 集已看完状态、统计 `0/4/5/1` 与四候选卡组均保持。此次验收未新增或删除追番，也未修改优先级和观看进度。

静态构建与线上页面验收已完成；此前记录的拖动排序手势浏览器验收仍未完成，不影响已验证的排序按钮与持久化路径。未登录/仅公开访问凭证拒绝、数据库故障恢复等独立验收项见验证记录。

扫描器仍需另行接入 PG 事务协议和审查，当前不要部署或建立定时触发器。未来启用时按 [扫描函数说明](../cloudbase/functions/guoman-scan/README.md) 生成服务器密钥，先手动通过管理员工具验证一条节目能更新，再启用定时任务；客户端伪造定时事件或缺少密钥均应被拒绝。

只有显式管理员热门名单和用户补录 / 追番目标会进入扫描，热门不超过 30 条，每次不超过 20 条。用户目标通常间隔 6 小时，热门 24 小时，失败最长退避 7 天。哔哩哔哩读取官方公开节目元数据；其他平台仅接受主节目描述明确的更新集数，无可靠信息时保留原记录并展示无法核验。

补录只上传官方节目链接，不上传任何媒体文件。已收录节目保留目录原名；无法确认名称的新节目明确标记待核验。链接规范化去重；同作品的不同平台或无法识别为同一节目的不同页面仍可能分别收录，不进行猜测合并。每账号每日最多补录 10 部新动漫、创建 20 个新扫描目标，最多同时追番 500 部。页面仅保存手动集数和这一集是否看完，未看完推荐继续该集，看完推荐下一集。只能直达官方节目页，不能保证跳到指定一集或跨平台自动播放。前端与用户云函数需同时采用 0.2.2 源码中的进度协议；旧记录在读取时兼容转换，再次保存或打开官网后移除旧秒数字段。

仍可继续验证邮箱首次注册边界、同链接补录去重、到期扫描、官网限流与失败退避、未来预告排除、打开链接不增加已看集数、不同浏览器并发改进度的版本冲突。新域名登录、账号恢复、目录实时同步和刷新会话均已通过。旧 EdgeOne 预览发布属于历史。扫描器仍未接入 PG、不得部署。云端日志为付费能力，当前使用有限安全信号和真实页面持久化结果作为用户函数验收证据；如未来开通日志，应逐项核对实际结果。旧微信路径若继续启用，另行验收其回调。

## 六、依赖与维护

用户云函数锁定 `@cloudbase/node-sdk` 3.18.3 与 `@cloudbase/manager-node` 5.9.0。安装时 npm 在线审计曾报告上游传递依赖 5 项告警（4 高、1 中），离线检查无报告不表示已消除。上线前重新执行函数目录 `npm audit` 并优先检查官方升级；没有强制覆盖 SDK 依赖或降级。业务写入使用固定字段，不将用户提供的对象原样写入数据库。

GitHub Actions 负责源码可验证检查，不能代替真实邮箱、CloudBase Hosting 与用户函数联调。`0f74c69` 是旧 EdgeOne 预览部署所对应的业务提交；当前静态页面与真实邮箱验收对应实现提交 `6764f48`，验证记录见第五节。
