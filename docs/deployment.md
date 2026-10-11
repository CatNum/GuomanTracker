# EdgeOne + CloudBase 部署说明

## 重点

- 网站采用 EdgeOne Pages 的 Next.js 模式；CloudBase 提供邮箱验证码身份认证，用户云函数正在接入 PG，元数据扫描仍待接入。微信授权回调保留为可选兼容路径。
- 已有 CloudBase 账号、上海环境和 EdgeOne 项目；本地真实配置保存在 Git 忽略文件中，EdgeOne 也已有环境配置。仓库中的 `.env.example` 与 `cloudbaserc.example.json` 仍是公开占位模板，不代表实际环境未配置，也不要把本地值提交到仓库。
- 当前环境是 CloudBase PG 共享集群，没有文档库或可用 TCP 端点。私有 PG 存储迁移已执行并通过结构后置检查；正式用户函数仍需完成代码审查、部署与真实邮箱追番持久化和隔离验收。用户已完成真实邮箱验证，但这不等于云端记录已接通；源码 0.2.2 尚未据此宣称上线。
- 「本机演示」只保存当前浏览器记录，不运行云端扫描，也不会自动并入邮箱账号。
- 通知、提醒和官方平台观看记录自动同步不在此版本。

## 一、配置位置

| 信息 | 配置位置 | 用途 |
| --- | --- | --- |
| CloudBase 环境 ID | EdgeOne `NEXT_PUBLIC_CLOUDBASE_ENV_ID`、本地忽略配置 | 连接身份和云函数环境；仓库模板保持占位符 |
| 环境地域 | `NEXT_PUBLIC_CLOUDBASE_REGION` | 默认上海 `ap-shanghai`，须与实际环境一致 |
| CloudBase 可发布密钥（若环境使用） | `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY` | SDK 的公开应用验证，不是腾讯云服务器密钥 |
| 邮箱验证码身份源与邮件代发 | CloudBase 身份认证控制台 | 当前默认登录方式；首次验证允许自动注册 |
| 微信开放平台网站应用 AppID / AppSecret（可选） | CloudBase 身份源控制台 | 仅旧微信授权兼容；AppSecret 不写入前端或仓库 |
| 网站来源域名 | EdgeOne、CloudBase 安全域名 | SDK 允许来源；仅启用微信时还需其授权回调域 |
| 扫描调度密钥 | 扫描云函数环境变量与定时触发器参数 | 只允许服务器定时任务执行扫描 |

邮箱验证码登录可在现有账号和 EdgeOne 项目上起步，不需要先申请微信 AppID 或购买域名。若将来启用旧微信路径，回调地址为 `https://YOUR_SITE_DOMAIN/auth/wechat/callback`，并须配置对应回调域。CloudBase 邮件代发限制按**整个环境**每分钟 10 封计，不是每人 10 封；前端 60 秒重发冷却只是交互保护，不能代替服务端频控。

## 二、EdgeOne 前端

在 EdgeOne Pages 导入当前 GitHub 仓库，选择 Next.js。配置项目目录为 `guoman-site`（前端项目目录），安装命令 `npm ci`，构建命令 `npm run build`，产物 `.next`（Next.js 构建目录），Node 使用 22.21.1 或兼容的较新版本。

前端依赖仓库同级 `cloudbase/shared` 中的两个纯领域模块，因此须保留整个 Git 仓库检出，不能仅上传前端子目录。`next.config.ts`（Next.js 构建配置）已设置仓库边界来解析共享模块。原 Vinext / Wrangler / Sites 文件仅保留历史，不再使用其部署命令。

在生产构建前核对 EdgeOne 中已有的公开变量。`NEXT_PUBLIC_*`（浏览器可见配置）会在构建时写入网页包，改值后重新构建；本地真实值留在忽略文件，仓库模板继续使用占位符。占位环境 ID 会使邮箱登录提示未配置，不会创建假会话。已有 EdgeOne 项目不代表本次 0.2.2 构建已经发布。

依据：[EdgeOne Next.js 框架支持与构建设置](https://pages.edgeone.ai/document/framework-nextjs)。

## 三、CloudBase 身份与数据库

1. 在当前环境开启邮箱验证码登录与邮件代发，允许首次验证码验证建立用户。网页调用 `signInWithOtp`（发送验证码并智能注册或登录），使用本次发码返回的 `verifyOtp`（校验该邮件验证码的回调）完成验证；再次登录应取得同一账号。环境共享发信上限及前端冷却见第一节。
2. 为网站实际来源配置 CloudBase 安全域名。只有选择继续启用微信兼容路径时，才配置微信网站应用 AppID、AppSecret、授权回调域和对应身份源；邮箱路径不依赖微信配置。
3. 应用 [云函数调用权限](../cloudbase/function-rules.json)：用户函数要求有效非匿名会话，扫描函数禁止客户端调用。云函数入口还须从可信运行时身份读取用户编号，拒绝匿名与空编号，不接受前端自行传入的编号作为授权依据。
4. 当前 PG 共享集群没有文档数据库，旧 `createCloudbaseStore`（文档库访问适配器）不能在本环境使用。[私有 PG 迁移](../cloudbase/migrations/pg-private-v1/README.md)已执行并通过结构后置检查；受信服务端适配器仍需通过代码审查、部署及真实账号验收。不能只凭数据库结构验收宣称页面已经保存成功。

**仅在实际启用文档数据库的环境中**，下列步骤才适用，不能用于当前 PG 共享集群：创建 `guoman_series`（共享节目元数据）、`guoman_watch_state`（用户追番、进度及限额）、`guoman_monitor_targets`（有限扫描目标）三个集合；为每个集合应用 [数据库规则](../cloudbase/database-rules.json) 中的 `{read:false,write:false}`（拒绝客户端直接访问）规则；为观看集合建立 `owner + kind + _id`（所属账号、文档用途、文档标识）组合索引，为监控集合建立 `source + nextScanAt`（来源、下次扫描时间）组合索引。规则文件只是映射模板，不会自动部署。

正式验收还须用真实邮箱完成退出后同邮箱登录、追番及集数和是否看完状态持久化；再用另一邮箱确认相互隔离。还需实测未登录或仅公开访问凭证的请求被用户云函数拒绝、邮箱会话的可信编号能被云函数识别，以及库失败时页面保留当前记录并可重试。本机演示和本地业务测试不能作为云端追番成功的证据。

正式函数采用单次 SCF `context`（本次调用上下文）中的 `environment`（新格式环境对象）或 `environ`（旧格式环境对象）读取可信账号编号与明确非匿名标记。部署前用一次只读探针核验当前平台字段形状：日志仅记录上下文/两种字段是否存在及类型、解析是否成功、账号编号是否存在且非空、匿名标记是否明确为非匿名等布尔值。先用无登录请求确认门禁拒绝且没有管理 SQL，再由已登录用户发一次只读账号库请求。不得记录 `context` 内容、账号编号及其摘要或长度、邮箱、header、token、进程环境或原始解析错误；若字段不完整，保持拒绝并排查运行时合同，不回退到进程环境身份。

依据：[邮箱验证码配置](https://docs.cloudbase.net/authentication-v2/method/email-login)、[云函数权限](https://docs.cloudbase.net/cloud-function/security-rules)、[PG 模式概述](https://docs.cloudbase.net/quick-start/pg-overview)。

## 四、云函数打包与部署

```sh
cd guoman-site
npm ci
npm test
npm run typecheck
npm run build
npm run cloudbase:prepare
cd ..
# 首次配置时才从模板复制；不要覆盖已有且被 Git 忽略的真实配置：
test -f cloudbaserc.json || cp cloudbaserc.example.json cloudbaserc.json
# 核对本地 cloudbaserc.json 的目标环境，再使用已登录的官方 CLI：
# 仅在正式用户函数完成代码审查及 PG 验证后部署；当前不要执行。
tcb fn deploy guoman-user
```

`cloudbase:prepare`（云函数打包命令）生成忽略目录 `.cloudbase-deploy`，将独立函数入口、锁定依赖、共享模块和用户函数所需目录快照打包，并检查相对导入。不要直接上传源码函数目录，它的开发导入路径依赖仓库共享目录。

打包和函数部署只验证部署物及入口可运行，不证明真实账号的追番写入成功。正式 `guoman-user` 仍待代码审查及真实验收；`guoman-scan` 尚未接入同一 PG 事务协议，当前不得部署或启用定时调度。部署命令使用本地忽略配置，禁止把环境凭证复制进仓库或终端输出。

`index.main`（云函数执行入口）采用 CommonJS 桥接 `entry.mjs`（业务模块），兼容 CloudBase Nodejs20.19。依赖由云端安装；也可以在各部署包目录 `npm ci` 后上传包内容，入口应位于压缩包最外层。

`cloudbaserc.json`（真实环境部署配置）已被 Git 忽略。模板不自动创建定时触发器，避免没有正确密钥时部署一个失效任务。服务器环境变量 `GUOMAN_SCAN_SECRET`（扫描调度密钥）从管理员环境读取，不能放入公开变量。

依据：[CloudBase CLI 配置](https://docs.cloudbase.net/cli-v1/functions/configs)、[部署命令](https://docs.cloudbase.net/cli-v1/functions/deploy)、[CommonJS 与 ES Module 入口](https://docs.cloudbase.net/cloud-function/how-coding)。

## 五、扫描与上线核验

扫描器仍需另行接入 PG 事务协议和审查，当前不要部署或建立定时触发器。未来启用时按 [扫描函数说明](../cloudbase/functions/guoman-scan/README.md) 生成服务器密钥，先手动通过管理员工具验证一条节目能更新，再启用定时任务；客户端伪造定时事件或缺少密钥均应被拒绝。

只有显式管理员热门名单和用户补录 / 追番目标会进入扫描，热门不超过 30 条，每次不超过 20 条。用户目标通常间隔 6 小时，热门 24 小时，失败最长退避 7 天。哔哩哔哩读取官方公开节目元数据；其他平台仅接受主节目描述明确的更新集数，无可靠信息时保留原记录并展示无法核验。

补录只上传节目名称和官网链接，不上传任何媒体文件。链接规范化去重；同作品的不同平台或无法识别为同一节目的不同页面仍可能分别收录，不进行猜测合并。每账号每日最多补录 10 部新动漫、创建 20 个新扫描目标，最多同时追番 500 部。页面仅保存手动集数和这一集是否看完，未看完推荐继续该集，看完推荐下一集。只能直达官方节目页，不能保证跳到指定一集或跨平台自动播放。前端与用户云函数需同时采用 0.2.2 源码中的进度协议；旧记录在读取时兼容转换，再次保存或打开官网后移除旧秒数字段。

上线验收须覆盖：邮箱新用户与返回用户、账号隔离、同链接补录去重、到期扫描、官网限流与失败退避、未来预告排除、打开链接不增加已看集数、不同浏览器并发改进度的版本冲突。查看 CloudBase 日志和实际持久化结果，确认每一步后才宣称用户功能上线。旧微信路径若继续启用，另行验收其回调。

## 六、依赖与维护

用户云函数锁定 `@cloudbase/node-sdk` 3.18.3 与 `@cloudbase/manager-node` 5.9.0。安装时 npm 在线审计曾报告上游传递依赖 5 项告警（4 高、1 中），离线检查无报告不表示已消除。上线前重新执行函数目录 `npm audit` 并优先检查官方升级；没有强制覆盖 SDK 依赖或降级。业务写入使用固定字段，不将用户提供的对象原样写入数据库。

GitHub Actions 负责源码可验证检查，不能代替真实邮箱 / CloudBase / EdgeOne 联调。源码版本与已部署版本分别记录，发布 0.2.2 后再更新正式访问链接。
