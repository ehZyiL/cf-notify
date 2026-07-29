# cf-notify 产品优化方案

> 更新日期：2026-07-29  
> 产品阶段：阶段 A、B 完成；阶段 C 代码就绪，等待 staging pilot 与 3 个工作日观察  
> 目标：让业务用户可控地收到可行动、可追踪的企业微信通知，同时不向业务系统暴露渠道标识。

## 1. 产品定位

cf-notify 是内部通知编排与投递基础设施，不是面向终端用户的独立通知 App，也暂不定位为通用通知 SaaS。

| 产品面 | 责任 |
|---|---|
| cf-auth | 用户身份、渠道绑定、业务授权、通知偏好、免打扰和加密目标目录 |
| 业务系统（当前为 xy-erp） | 产生业务事件、维护消息内容模板、展示业务侧发送状态 |
| cf-notify | 事件受理、幂等、路由、异步投递、供应商适配和运营诊断 |
| 固定 IP egress | 保存供应商 Secret、缓存 access token、访问微信和企业微信 API |

当前应优先验证企业微信这一条真实业务链路。微信公众号仅在账号能力和互动窗口满足时作为补充渠道；Telegram 在适配器完成前不得对用户发布。

## 2. 当前基线

- cf-notify 已实现 D1 事件、Dispatch/Delivery Queue、DLQ、幂等键和发送前目标重解析。
- 生产使用 `NOTIFICATION_DIRECTORY_MODE=rpc`，服务 API Key、绑定和偏好由 cf-auth 管理。
- 线上公开渠道引导当前仅开放企业微信。
- xy-erp 已通过 Service Binding 接入 cf-notify，通知总开关已打开；测试通知会保存
  `cfNotifyEventId`、同步供应商终态，并展示 readiness、最近通知和修复入口。
- xy-erp 的自动成功通知和截止提醒仍关闭，尚未进入全量业务运行。
- cf-notify 自动化测试、类型检查、启动检查和部署 dry-run 均通过。

## 3. 核心问题

### P0：阻塞业务通知启用

1. **渠道状态没有单一来源**  
   页面可能展示代码支持但生产不可用的渠道；“绑定成功”也不能证明实际可投递。

2. **测试通知没有终态反馈（阶段 B 已实现）**  
   xy-erp 已不再把 `202 Accepted` 当作送达成功，并继续展示 `completed`、`skipped`、
   `failed`、DLQ 耗尽和 provider unknown；生产仍需迁移和真机终态验收。

3. **运营后台与生产模式不一致**  
   RPC 模式仍可创建本地凭证；非 template 模式仍突出展示公众号字段映射；未实现渠道仍可被配置为公开入口。

4. **人工重试缺乏风险控制**  
   永久错误不应重复发送；`unknown` 重试可能制造重复通知；批量操作必须先预览和显式确认。

5. **健康检查只证明 Worker 存活**  
   现有公开健康接口不能反映 D1、KV、cf-auth、Queue 和固定出口是否可用。

### P1：阻塞规模化运营

- 缺少按服务、渠道、错误码和时间范围聚合的成功率、延迟与积压指标。
- 缺少事件级投递时间线、精细筛选、管理操作审计和角色分级。
- notification events、deliveries 和 legacy logs 尚未建立明确保留期限。
- Queue 补偿逻辑存在，但当前生产未配置 cf-notify Cron Trigger。
- 本地同步兼容路径与生产异步 RPC 路径存在契约差异。

### P2：体验和增长

- 最终状态同步、通知历史和安全业务深链已在 xy-erp 实现；业务深链仍待阶段 C pilot 验证。
- 在企业微信闭环验证前，不应优先投入 Telegram；后续按实际未覆盖场景评估站内通知或邮件兜底。

## 4. 优化路线

### 阶段 A：状态一致与误操作防护

| 项目 | 验收标准 | 状态 |
|---|---|---|
| 渠道能力模型 | API 同时给出 implemented、bindable、sendable、available、mode 和 reason | 本轮实现 |
| 公开引导过滤 | 只有完整配置且可投递的渠道进入公开 guides | 本轮实现 |
| 未实现渠道保护 | Telegram 等未实现渠道不能被保存为 enabled | 本轮实现 |
| 运行模式感知 | RPC 模式隐藏本地凭证；非 template 模式隐藏公众号字段映射 | 本轮实现 |
| 依赖就绪检查 | 管理端分别显示 D1、KV、cf-auth、Queue 和 egress 状态 | 本轮实现 |
| 安全人工重试 | 日志中仅对 DLQ 耗尽或 unknown 提供单条操作；unknown 必须确认重复风险；入队失败恢复原终态 | 本轮实现 |

### 阶段 B：测试通知闭环

| 项目 | 验收标准 | 状态 |
|---|---|---|
| Event ID 持久化 | 测试 Outbox 接受 `202` 时保存有效 `cfNotifyEventId`；缺失 ID 进入提交重试 | 本轮实现 |
| 终态同步 | Cron 和单条 API 通过 Service Binding 轮询 `GET /api/v1/notifications/:eventId`，带锁和退避 | 本轮实现 |
| 状态语义 | 区分业务 Outbox、cf-notify 受理、投递中、供应商已接受、未绑定/关闭、永久失败、DLQ 和 unknown | 本轮实现 |
| 修复入口 | 绑定或偏好问题提供无凭据 HTTPS 的 cf-auth 通知设置链接 | 本轮实现 |
| Readiness | 只有供应商终态成功显示“通知已就绪”，并说明不等于用户已阅读 | 本轮实现 |
| 权限隔离 | `notifications.read` 查询历史；`notifications.manage` 可同步自己的测试通知；其他 owner 返回 404 | 本轮实现 |

阶段 B 截止时本地验收已完成：xy-erp Worker 140 项、浏览器 12 项、Python 9 项测试通过；
Wrangler 4.115.0 类型生成、启动分析及 production/staging dry-run 通过。尚未执行生产部署。
进入阶段 C 前仍需：应用 xy-erp `0010_notification_delivery_status.sql`、确认服务 API Key
同时具备 `notifications.send` 与 `notifications.delivery.read`，并完成一次真实企业微信终态验证。

### 阶段 C：受控开启业务事件

| 项目 | 验收标准 | 状态 |
|---|---|---|
| 用户灰度 | 成功通知与提醒分别使用 `off/allowlist/all`；默认 allowlist 空名单，`all` 必须显式配置 | 本轮实现 |
| 成功事件保护 | 仅 ERP 回查确认、非手工运行且 owner 命中 cohort 时创建成功事件 | 本轮实现 |
| 安全业务深链 | 固定 HTTPS app URL；Token 加密、限时、owner 绑定，不在 URL 暴露账号、日期或 event key | 本轮实现 |
| 基础设施兜底 | xy-erp 拒绝非 HTTPS/带凭据 URL；cf-notify 可靠入口同样拒绝带凭据链接 | 本轮实现 |
| 行动结果 | 记录提醒打开时间；只由 Cron 的 ERP 真值核验写入截止前完成时间 | 本轮实现 |
| readiness 基线 | staging 应用迁移后先保持两个业务开关关闭、空 allowlist，完成每位用户真实测试终态 | 待外部执行 |
| 真实 pilot | readiness 通过后小范围开启成功通知并连续观察至少 3 个工作日 | 待外部执行 |
| 提醒放量 | pilot 门槛通过后再为同一 cohort 开启截止提醒，验证深链和按时完成率 | 待外部执行 |

生产/staging 配置当前仍保持两个业务事件开关关闭，rollout mode 为 allowlist 且名单为空。
缺失 rollout mode 也按空 allowlist 处理，只有显式 `all` 才会全量命中。阶段 C 当前本地验收为
xy-erp Worker 161 项、浏览器 12 项、Python 9 项和 cf-notify 103 项测试通过；Wrangler
4.115.0 类型生成、启动分析及 production/staging dry-run 通过。
2026-07-29 只读远端审计确认 staging 所需 secret 名称均存在；staging D1 待应用
`0007`-`0011`，且 `run_logs` / `notification_outbox` 均为 0 行；production D1 仅待应用
`0010`/`0011`。本轮未应用迁移或部署。
进入真实 pilot 需要操作者提供测试用户 ID、确认 API Key 同时具备 send/read scope、应用
staging 全部待处理迁移并授权部署。迁移后先部署两个业务开关关闭、空 allowlist 的 readiness
基线并完成真实测试通知；未通过 readiness 和后续 3 个工作日观察前，不进入阶段 D。

xy-erp 已新增 `worker/scripts/notification-pilot-report.mjs`，将 pilot 观察口径固化为固定
staging 目标的只读报告：先检查实际 active deployment 是否为单一 version 100% 流量，核对
runtime、assets、D1/KV、Service Bindings、secret 名称、固定普通变量、阶段开关和精确
allowlist；再检查 `0007`-`0011` 结构与 cohort 准备度。新增 `readiness` 阶段要求两个业务
开关关闭、两个 allowlist 为空，并确认每位用户最新一条测试通知已到达 completed；通过后
success/reminder 才要求至少 3 个完整公司工作日、
至少 3 条阶段事件、成功通知创建覆盖率 100%、全部样本 `completed`、skip/失败/unknown/
ID 复用指标为 0，以及 accepted 到首个成功渠道 P95 不超过 300 秒。提醒阶段同时汇总打开率
和截止前完成率，但不把转化率当作自动放量门槛。API Key 当前 scope、真机收件、用户重复
反馈和提醒误报/漏报仍需人工确认；工具不会应用迁移、部署或自动宣布阶段 C 完成。
2026-07-29 已用假 UUID 对真实 staging 做端到端只读预检，工具同时报告 active v7 的阶段 C
配置漂移与 `0007`-`0011` 缺失；schema 阻断后未查询 pilot 数据，也未执行远端写入。
三阶段部署 dry-run、授权边界、观察与回滚命令见 xy-erp
`worker/NOTIFICATION_PILOT_RUNBOOK.md`。

### 阶段 D：运营与治理

- 建立 24 小时受理量、供应商提交率、跳过率、失败率、unknown 比例和 P95 延迟。
- 日志按 event 聚合并显示投递时间线、attempts、错误分类和下一步操作。
- 增加配置变更审计、操作者、RBAC 和回滚。
- 定义明细数据保留与清理策略。
- 使用统一平台调度器触发 cf-notify reconcile，避免为每个 Worker 单独消耗 Cron 配额。
- 发布唯一推荐的 OpenAPI 契约，逐步淘汰同步兼容路径。

## 5. 产品状态模型

### 渠道状态

```text
unavailable  适配器未实现
disabled     技术能力存在，但未向用户开放
degraded     已尝试开放，但回调或出口配置不完整
ready        可绑定且已配置投递链路
```

### 投递状态

```text
accepted -> dispatching -> sent
                       ├-> skipped
                       ├-> failed
                       └-> unknown
```

`sent` 仅表示供应商接受或网关成功返回，不等同于用户已阅读。`unknown` 表示供应商结果不确定，人工重试可能重复发送。

## 6. 上线门槛与指标

业务自动通知启用前必须满足：

- 不再向用户展示不可绑定或不可投递的渠道。
- 测试通知能够展示最终投递状态，而非只显示 `202 Accepted`。
- 永久错误没有“直接重试”操作；unknown 有明确重复风险提示。
- 管理端可以识别 D1、KV、cf-auth、Queue 或 egress 的降级。
- 调用方始终使用稳定 Idempotency-Key。
- 已建立真实用户小流量观测和回滚开关。

首批指标：

- 通知设置打开 → 生成绑定码 → 绑定成功 → 测试送达漏斗；
- accepted 到 sent 的 P50/P95 时间；
- `not_bound`、`not_subscribed`、永久错误、DLQ 和 unknown 比例；
- 人工重试次数与可能重复发送次数；
- 截止提醒后的按时完成率；
- 用户关闭通知和解绑渠道比例。

## 7. 验证命令

```bash
npm test
npm run check:types
npm run check:startup
npx wrangler deploy --dry-run
```

涉及 cf-auth 或 xy-erp 的后续阶段，还需分别运行各自通知专项测试并完成一次真实企业微信测试投递。
