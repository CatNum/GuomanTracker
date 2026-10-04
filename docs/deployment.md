# EdgeOne + CloudBase 部署说明

## 重点

- 网站采用 EdgeOne Pages 的 Next.js 模式；CloudBase 管理微信身份、文档数据库、用户云函数和元数据定时扫描。
- 所有环境标识和密钥均为占位值。本次没有创建外部账号或部署资源，没有验证真实微信授权、数据库事务或定时执行。
- 已配置功能可以本地审查；「本机演示」不代表微信登录，也不会运行扫描或同步到账号。
- 通知、提醒和官方平台观看记录自动同步不在此版本。

## 一、需要替换的信息

| 信息 | 配置位置 | 用途 |
| --- | --- | --- |
| CloudBase 环境 ID | EdgeOne `NEXT_PUBLIC_CLOUDBASE_ENV_ID`、本地 `cloudbaserc.json` | 连接身份和云函数环境 |
| 环境地域 | `NEXT_PUBLIC_CLOUDBASE_REGION` | 默认上海 `ap-shanghai`，须与实际环境一致 |
| CloudBase 可发布密钥（若环境使用） | `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY` | SDK 的公开应用验证，不是腾讯云服务器密钥 |
| 微信开放平台网站应用 AppID / AppSecret | CloudBase 身份源控制台 | 微信授权；AppSecret 不写入前端或仓库 |
| 正式网站域名 | EdgeOne、微信开放平台、CloudBase 安全域名 | 授权回调和 SDK 允许来源 |
| 扫描调度密钥 | 扫描云函数环境变量与定时触发器参数 | 只允许服务器定时任务执行扫描 |

微信回调地址固定为 `https://YOUR_SITE_DOMAIN/auth/wechat/callback`。浏览器发起授权时会使用当前域名，因此预览域名也要单独配置。

## 二、EdgeOne 前端

在 EdgeOne Pages 导入当前 GitHub 仓库，选择 Next.js。配置项目目录为 `guoman-site`（前端项目目录），安装命令 `npm ci`，构建命令 `npm run build`，产物 `.next`（Next.js 构建目录），Node 使用 22.21.1 或兼容的较新版本。

前端依赖仓库同级 `cloudbase/shared` 中的两个纯领域模块，因此须保留整个 Git 仓库检出，不能仅上传前端子目录。`next.config.ts`（Next.js 构建配置）已设置仓库边界来解析共享模块。原 Vinext / Wrangler / Sites 文件仅保留历史，不再使用其部署命令。

在生产构建前填入上表的公开变量。`NEXT_PUBLIC_*`（浏览器可见配置）会在构建时写入网页包，改值后重新构建。占位环境 ID 会使微信登录显示未配置，不会创建假会话。

依据：[EdgeOne Next.js 框架支持与构建设置](https://pages.edgeone.ai/document/framework-nextjs)。

## 三、CloudBase 身份与数据库

1. 创建 CloudBase 文档数据库环境，开启「微信开放平台登录」，填入网站应用的 AppID、AppSecret。核验身份源的登录模式支持创建新用户；若该环境仅允许登录已有账号，需要先注册并绑定微信，本版本会提示未建立账号而不会伪造注册成功。
2. 在微信开放平台添加正式授权回调域，在 CloudBase 配置同一来源为安全域名。
3. 创建 `guoman_series`（共享节目元数据）、`guoman_watch_state`（用户追番、进度及限额）、`guoman_monitor_targets`（有限扫描目标）三个集合。
4. 每个集合分别应用 [数据库规则](../cloudbase/database-rules.json) 中对应的 `{read:false,write:false}`（拒绝客户端直接访问）规则；该文件是各集合规则映射，不是声称会自动部署的配置。用户通过云函数访问，由 CloudBase 服务端身份判定记录所属账号。
5. 建立观看集合的 `owner + kind + _id`（所属账号、文档用途、文档标识）组合索引；监控集合的 `source + nextScanAt`（来源、下次扫描时间）组合索引，按时间升序。
6. 应用 [云函数调用权限](../cloudbase/function-rules.json)：用户函数要求有效非匿名会话，扫描函数禁止客户端调用。即使规则配置错误，用户函数仍拒绝匿名身份，扫描函数仍校验服务器密钥。

第一次上线需要用两个真实微信账号验证各自追番、进度、退出、重新登录和相互隔离。自动注册是否可用取决于身份源配置，须在控制台验证，不能仅凭本地演示认为完成。

依据：[微信授权流程](https://docs.cloudbase.net/authentication-v2/method/wechat-login)、[身份源登录与注册模式](https://docs.cloudbase.net/api-reference/webv2/authentication_v2)、[云函数权限](https://docs.cloudbase.net/cloud-function/security-rules)。

## 四、云函数打包与部署

```sh
cd guoman-site
npm ci
npm test
npm run typecheck
npm run build
npm run cloudbase:prepare
cd ..
cp cloudbaserc.example.json cloudbaserc.json
# 替换本地 cloudbaserc.json 中的环境 ID，再使用已登录的官方 CLI：
tcb fn deploy guoman-user
tcb fn deploy guoman-scan
```

`cloudbase:prepare`（云函数打包命令）生成忽略目录 `.cloudbase-deploy`，将独立函数入口、锁定依赖、共享模块和用户函数所需目录快照打包，并检查相对导入。不要直接上传源码函数目录，它的开发导入路径依赖仓库共享目录。

`index.main`（云函数执行入口）采用 CommonJS 桥接 `entry.mjs`（业务模块），兼容 CloudBase Nodejs20.19。依赖由云端安装；也可以在各部署包目录 `npm ci` 后上传包内容，入口应位于压缩包最外层。

`cloudbaserc.json`（真实环境部署配置）已被 Git 忽略。模板不自动创建定时触发器，避免没有正确密钥时部署一个失效任务。服务器环境变量 `GUOMAN_SCAN_SECRET`（扫描调度密钥）从管理员环境读取，不能放入公开变量。

依据：[CloudBase CLI 配置](https://docs.cloudbase.net/cli-v1/functions/configs)、[部署命令](https://docs.cloudbase.net/cli-v1/functions/deploy)、[CommonJS 与 ES Module 入口](https://docs.cloudbase.net/cloud-function/how-coding)。

## 五、扫描与上线核验

按 [扫描函数说明](../cloudbase/functions/guoman-scan/README.md) 生成服务器密钥，在 SCF 定时触发器配置每 30 分钟运行与自定义 `Message` 参数。部署后先手动通过管理员工具验证一条节目能更新，再启用定时任务。客户端伪造定时事件或缺少密钥均应被拒绝。

只有显式管理员热门名单和用户补录 / 追番目标会进入扫描，热门不超过 30 条，每次不超过 20 条。用户目标通常间隔 6 小时，热门 24 小时，失败最长退避 7 天。哔哩哔哩读取官方公开节目元数据；其他平台仅接受主节目描述明确的更新集数，无可靠信息时保留原记录并展示无法核验。

补录只上传节目名称和官网链接，不上传任何媒体文件。链接规范化去重；同作品的不同平台或无法识别为同一节目的不同页面仍可能分别收录，不进行猜测合并。每账号每日最多补录 10 部新动漫、创建 20 个新扫描目标，最多同时追番 500 部。页面可保存手动集数和续看秒数，但只能直达官方节目页，不能保证跳到指定一集、定位秒数或跨平台自动播放。

上线验收须覆盖：微信新用户与返回用户、账号隔离、同链接补录去重、到期扫描、官网限流与失败退避、未来预告排除、打开链接不增加已看集数、不同浏览器并发改进度的版本冲突。查看 CloudBase 日志和实际数据库，确认每一步，之后再切换正式域名。

## 六、依赖与维护

当前云函数锁定 `@cloudbase/node-sdk` 3.18.3。安装时 npm 在线审计报告上游传递依赖 5 项告警（4 高、1 中），离线检查无报告不表示已消除。上线前重新执行函数目录 `npm audit` 并优先检查官方升级；没有强制覆盖 SDK 依赖或降级。业务写入使用固定字段，不将用户提供的对象原样写入数据库。

GitHub Actions 负责本地可验证检查，不能代替真实微信 / CloudBase / EdgeOne 联调。源码版本和旧 Sites 地址的运行版本分别记录，发布后再更新正式访问链接。
