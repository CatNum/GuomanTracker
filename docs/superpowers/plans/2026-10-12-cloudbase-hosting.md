# CloudBase 既有域名部署实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 最新追番页面在既有 CloudBase 域名完成真实邮箱登录与功能验收。

**Architecture:** 双构建共用前端源码；目录服务在普通 Next.js API
及可信账号云函数中复用，静态前端通过 SDK 读取目录。

**Tech Stack:** Next.js 16.3.4、React 19、CloudBase SDK、Node.js ES modules。

**Spec:** `docs/superpowers/specs/2026-10-12-cloudbase-hosting.md`

## Global Constraints

- 使用 6.1 sol 设计和审查，6 luna 开发，禁止 6 astra。
- 保留账号、PG、用户云函数权限及现有数据。
- 不新增匿名访问，不部署尚未接入 PG 的扫描函数。
- 不购买或升级套餐，不启付费日志，不新增安全域名。
- 保留既有认证和管理页面；新资源先上传，首页最后上传，不 prune。
- 普通 Next.js 模式保持游客目录同步；CloudBase 游客明确引导登录后同步。
- 真实账号验收，不复制令牌到其他网页来源。

## Task 1: 双构建与可信目录读取

**Files:**

- Create: `cloudbase/shared/catalog-service.mjs`
- Create: `cloudbase/tests/catalog-service.test.mjs`
- Modify: `cloudbase/shared/pg-user-handler.mjs`
- Modify: `cloudbase/functions/guoman-user/entry.mjs`
- Modify: `cloudbase/tests/pg-user-handler.test.mjs`
- Modify: `guoman-site/app/api/catalog/route.ts`
- Modify: `guoman-site/app/catalog.tsx`
- Modify: `guoman-site/app/tracker.tsx`
- Create: `guoman-site/lib/catalog-transport.ts`
- Create: `guoman-site/tests/catalog-transport.test.ts`
- Create: `guoman-site/scripts/build-cloudbase-static.mjs`
- Modify: `guoman-site/next.config.ts`、`package.json`、根 `.gitignore`

**Interfaces:**

- `createCatalogService({ loadSeed, fetchImpl, now })`（创建目录读取服务）
  产生异步目录读取函数，返回 `{ items, live }`。
- `createPgUserHandler`（可信用户函数入口）注入目录读取回调，
  识别 `getCatalog`（读取目录动作），且不创建 PG 管理客户端。
- `Catalog`（目录组件）接收当前账号就绪状态与既有登录入口，
  构建配置决定使用 HTTP 还是可信云函数传输。

- [ ] 写测试并确认未实现时失败：合并官方日历并保留三平台；
  非法上游、十秒超时、流式响应体超限回退快照；
  成功缓存十分钟，并发只回源一次，失败后可重试。
- [ ] 用注入网络读取器和时间实现服务，禁止任意 URL 抓取。
  保留现有字段与合并语义；快照同样过滤暂不支持的平台。
- [ ] 增加可信只读动作及测试：未登录、匿名、伪造身份拒绝；
  正式身份返回目录，管理客户端构造次数为零；非法参数拒绝。
- [ ] 普通 Next.js 路由改为调用共享服务，保留原缓存响应头与回退行为。
- [ ] 增加目录传输适配和有价值的边界测试。CloudBase 游客不发失败请求，
  点击同步打开原登录界面；登录状态变化自动同步，旧结果不污染新状态。
- [ ] 新增静态构建脚本：隔离源码副本排除动态 API，
  进程内构建标记选择静态导出与云函数传输，输出完整静态目录。
  只传入公开前端配置，禁止复制私密环境文件或修改原 API 文件。
- [ ] 运行 `npm test`、`npm run typecheck`、`npm run lint`，
  隔离目录运行普通生产构建与 `npm run build:cloudbase`。
- [ ] 核验静态首页、资源、404、回调页，且无受保护托管目录；
  生成用户函数部署包，验证新增共享模块随包复制。
- [ ] 6.1 sol 审查完整改动；修复并定向复审后中文提交及远端推送。

## Task 2: 可回滚部署与真实账号验收

**Files:**

- Modify: `docs/deployment.md`、`docs/verification.md`、`README.md`
- Local only: 旧云函数备份、部署状态、托管清单、构建快照和截图。

**Interfaces:**

- 消费 Task 1 的已审核用户函数包和静态产物。
- 产出可访问的新地址、实际验证记录和中文提交；不迁移用户数据。

- [ ] 保存用户函数状态和旧代码包，保存既有六个托管系统文件清单。
- [ ] 仅部署 `guoman-user`，回读确认 Active、原函数编号及配置保留。
- [ ] 用本地真实会话验证新目录动作；不修改原追番与观看进度。
- [ ] 发布静态产物到既有共享域名，使用 `--safe --verify`，不 prune。
- [ ] 检查首页及资源可访问、认证预检允许、六个系统文件保留。
- [ ] 浏览器验证游客浏览和同步登录引导，再使用真实邮箱验证码登录。
  需要验证码时向用户请求输入，等待期间继续其他独立检查。
- [ ] 验证原追番、推荐、筛选、目录同步与整页刷新后会话恢复。
  若上游只回退，记录实际状态并继续排查，不能宣称实时获取成功。
- [ ] 更新部署与验证文档，记录真实部署版本及未完成事项；提交并推送。
