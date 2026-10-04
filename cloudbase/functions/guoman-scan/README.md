# 国漫元数据定时扫描

## 重点

函数只读取官网节目文本和 JSON 元数据，不请求音视频。每次扫描最多 20 条到期监控，用户补录优先；热门名单仅由管理员显式导入，最多 30 条。B 站按已发布正片的发布时间与数字集号判定，剔除预告、花絮、未来剧集；其他平台仅在主节目页面的描述元数据明确写出已发布集数时更新，无可靠数据时标为 `unsupported`（暂时无法核验）。页面被限流或解析失败时保留已知进度，并按指数退避重试，最长 7 天。

## 一、必须完成的服务器权限配置

在 CloudBase「云函数 → 权限控制」中设置下列规则，阻止浏览器 SDK 调用扫描函数；该规则不限制定时触发器和管理员调用。完整规则还需包含用户服务函数的配置。

```json
{
  "*": { "invoke": false },
  "guoman-user": { "invoke": "auth != null && auth.loginType != 'ANONYMOUS'" },
  "guoman-scan": { "invoke": false }
}
```

同时为函数设置服务器环境变量 `GUOMAN_SCAN_SECRET`（调度密钥），使用管理员本地生成的 32 字节随机值的十六进制字符串；不能使用占位符，不能放入 `NEXT_PUBLIC_` 变量或前端。缺少密钥时函数会拒绝执行。

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

为定时触发器设置自定义 `Message`（定时入参）为 JSON 字符串 `{"scanKey":"<与服务器一致的随机密钥>"}`。CloudBase CLI 的普通 cron 配置不会自动设置此入参，需在云函数/SCF 控制台的定时触发器入参中设置，或使用 SCF API 的 `CustomArgument`（定时触发器自定义入参）字段。不要在仓库里保存密钥。客户端即使伪造 `Type: Timer` 也不能通过函数权限、可信用户身份检查和密钥验证。

推荐每 30 分钟触发一次：`0 */30 * * * * *`。用户目标正常间隔 6 小时，热门目标正常间隔 24 小时。设置函数超时至少 120 秒；数据库需建立 `source`（目标来源）与 `nextScanAt`（下次扫描时间）的组合索引。

参考官方说明：[CloudBase 云函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)、[定时触发器入参](https://cloud.tencent.com/document/product/583/9708)、[SCF 创建触发器与 CustomArgument](https://cloud.tencent.com/document/api/583/18589)。

## 二、管理员热门名单

从现有节目目录挑选最多 30 个明确节目 ID，手动运行管理员种子脚本。脚本默认只显示将要建立的目标，增加 `--apply`（实际写入）才连接数据库。它需要安装本函数的 SDK 依赖，并在管理员环境设置 CloudBase 环境 ID、腾讯云密钥或使用服务端工作负载身份。不要在浏览器调用。

```sh
cd cloudbase/functions/guoman-scan
npm ci
cd ../../..
node cloudbase/scripts/seed-monitor-targets.mjs --ids=bili-28747,youku-adaec02f09f9469ab8d8
# 完成账号配置后才写入：
node cloudbase/scripts/seed-monitor-targets.mjs --ids=bili-28747,youku-adaec02f09f9469ab8d8 --apply
```

脚本保留既有用户目标，不将其降为热门目标；增加热门目标前检查环境中累计热门目标上限。不会因为目录含 3,250 条记录而自动遍历或抓取它们。

## 三、共享模块

`normalizeOfficialUrl`（规范化官方链接）返回 `url`（去掉追踪参数的官方节目地址）、`platform`（平台标识）、`id`（规范地址 SHA256 标识）。目录已有节目标识由上层服务保留，扫描始终使用 `seriesId`（节目标识）找到原记录。

`runScanBatch`（执行限量扫描）通过注入 `store`（记录存取接口）运行，可独立测试；生产存取使用事务领取 10 分钟目标租约，避免重叠定时任务重复扫描。`authorizeScanner`（验证扫描调度权限）同时检查服务器密钥、可信运行时用户身份和定时消息；不能只检查事件类型。
