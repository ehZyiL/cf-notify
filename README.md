# cf-notify

Cloudflare Workers 统一通知服务。

| 阶段 | 状态 |
|------|------|
| Phase 1 绑定 + send + egress | ✅ |
| Phase 1.5 订阅 / 限流 / AES 加解密 / 模板映射 / 退订吊销 | ✅ |
| Phase 2 管理日志·重试·channel-apps·TG stub·发码登录骨架 | ✅（登录默认关） |
| Reliable delivery：幂等事件、Dispatch/Delivery Queue、DLQ、Cron 补偿 | ✅ |
| cf-auth NotificationDirectory RPC 适配层 | ✅（默认兼容模式，待 auth 端上线后切换） |
| 真机部署 / xy-erp 接入 | ⬜ |

用户身份 = **cf-auth** `sub`。微信出站经 **固定 IP egress**。

## 测试

```bash
npm test
# 51 passed
```

## 主要 API

| 方法 | 路径 | 鉴权 |
|------|------|------|
| GET | `/api/health` | — |
| POST | `/api/bindings/code` | 用户 JWT |
| GET | `/api/bindings/status?code=` | 用户 JWT |
| GET/DELETE | `/api/bindings` `.../:id` | 用户 JWT |
| GET/POST/DELETE | `/api/subscriptions` | 用户 JWT |
| POST | `/api/v1/send` | Service `notifications.send` + `Idempotency-Key` |
| POST | `/api/v1/notifications` | Service `notifications.send` + `Idempotency-Key` |
| GET | `/api/v1/notifications/:eventId` | 同一 Service + `notifications.delivery.read` |
| GET | `/api/v1/users/:userId/notification-settings?eventType=` | Service `notifications.settings.read`，仅 RPC 模式 |
| GET | `/api/logs` | 用户 JWT |
| GET/POST | `/wechat/callback` | 微信签名 |
| POST | `/api/admin/clients` | Bootstrap Key |
| DELETE | `/api/admin/clients/:clientId` | Bootstrap Key |
| GET | `/api/admin/logs` | Bootstrap Key |
| POST | `/api/admin/retry` | Bootstrap Key |
| POST | `/api/admin/channel-apps` | Bootstrap Key |
| POST | `/api/session/wechat/challenge` | 仅 `WECHAT_CODE_LOGIN_ENABLED` |

## 界面

| 路径 | 说明 |
|------|------|
| `/` | **用户通知中心**（绑定微信、订阅、投递记录） |
| `/admin` | **运营控制台**（凭证、模板映射、日志、重试） |

设计：Indigo 品牌色、侧栏控制台 + 门户双栏，适配桌面/移动。

## 本地

先执行 `npm install`，再运行 `npm run dev`；可选启动 `node egress/server.mjs`。
用户页支持 `ALLOW_TEST_TOKEN=true` 生成测试 JWT；管理端使用 `ADMIN_BOOTSTRAP_KEY`。

```bash
# .dev.vars 示例
CF_AUTH_JWT_SECRET=...          # 仅 HS256 本地兼容/测试 Token
WECHAT_TOKEN=...
WECHAT_AES_KEY=                # 可选，安全模式 43 字符
WECHAT_APP_ID=
EGRESS_BASE_URL=http://127.0.0.1:8789
EGRESS_SHARED_SECRET=...
WECHAT_SEND_MODE=custom_text
ADMIN_BOOTSTRAP_KEY=dev-admin
ALLOW_TEST_TOKEN=true
WECHAT_CODE_LOGIN_ENABLED=false
NOTIFICATION_DIRECTORY_MODE=local # cf-auth RPC 上线且完成数据迁移后改为 rpc
```

`WECHAT_SEND_MODE=custom_text` 仅适用于公众号接口权限中已开通客服消息能力的账号，且用户必须在微信允许的互动窗口内。未认证账号若返回 `48001 api unauthorized`，不能主动发送客服消息，只能在用户发消息时被动回复；需要认证/升级账号或改用其他通知渠道。公众号开通模板能力后，可切回 `template` 并维护 `channel_apps` 模板映射。

生产用户 JWT 使用 `CF_AUTH` Service Binding 获取 cf-auth RS256 JWKS，不共享私钥或 HMAC secret。`CF_AUTH_ISSUER`、Service Binding、Queue 和 D1/KV binding 在 `wrangler.toml` 中声明。

生产配置默认 `SUBSCRIPTIONS_DEFAULT_OPEN=false`：用户必须先为对应 service/event 建立订阅，业务才能投递。用户创建订阅时还会校验 cf-auth JWT 中的 `services`。

当前生产使用 `NOTIFICATION_DIRECTORY_MODE=rpc`：业务 API Key 由 `CF_AUTH.verifyServiceApiKey()` 验证，通知受理查询有效设置，Dispatch 和 Delivery 各自调用 `resolveNotificationTargets()`，微信绑定/取消关注分别调用 `consumeBindingChallenge()` / `updateBindingStatus()`。RPC 故障不会降级读取本地权威数据。

切换前必须先在 cf-auth 部署对应命名 RPC、迁移绑定/偏好/事件目录，并完成契约测试。RPC 返回的明文地址只存在于当前调用内存，不写入 cf-notify D1、Queue 或响应。`CF_AUTH` 的命名 entrypoint 配置应与 cf-auth 最终导出名称一起变更，不能提前修改已上线 binding。

可靠投递使用四个 Queue。首次部署前创建并应用新增迁移：

```bash
npx wrangler queues create cf-notify-dispatch
npx wrangler queues create cf-notify-delivery
npx wrangler queues create cf-notify-dispatch-dlq
npx wrangler queues create cf-notify-delivery-dlq
npx wrangler d1 migrations apply cf-notify --remote
```

业务提交示例：

```http
POST /api/v1/notifications
Authorization: Bearer <clientId>:<clientSecret> # local 模式
Idempotency-Key: xy-erp:order:20260727-001:approved
Content-Type: application/json

{"userId":"usr_123","type":"order.approved","data":{"orderNo":"SO-001"}}
```

`rpc` 模式改用 `Authorization: Bearer cfk_...`，且请求体中的 `serviceId` 不参与授权判断。业务 API 同时支持 `/api/v1/...` 和 `/v1/...` 路径。

生产中的 `/api/v1/send` 在 Queue binding 存在时也进入相同异步链路并返回 `202`；未配置 Queue 的本地兼容模式仍执行原同步发送。

当前 Cloudflare 账号的 5 个 Cron Trigger 配额已用满，因此生产配置不新增 Cron。若首次 Queue 入队失败，接口返回带 `eventId` 和 `Retry-After` 的 `503`；调用方使用相同 `Idempotency-Key` 重试会重新入队，不会重复创建事件。`scheduled()` 补偿逻辑仍保留，释放 Cron 配额后可重新启用。

本地验证命令：

```bash
npm test
npm run check:types
npm run check:startup
npx wrangler deploy --dry-run
```

## 本地 PostgreSQL 备选

Cloudflare Worker 不能直接访问家庭/局域网地址。需要 PostgreSQL 时，应通过 Hyperdrive 接入可达且启用 TLS 的数据库，优先配合 Workers VPC；不可用时再考虑 Tunnel + Access 后面的窄接口。不要把本地 `5432` 暴露到公网。

本项目默认仍使用 D1。若只是微信等渠道要求固定来源 IP，只部署 `egress/` 固定 IP 网关即可，无需迁移数据库。本地 PostgreSQL 仅作为 D1 用量或历史容量确实成为瓶颈后的备选。

## 文档

- [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md)
- [egress/README.md](./egress/README.md)
- 备选登录预留：[../cf-auth/docs/wechat-notify-and-alt-login.md](../cf-auth/docs/wechat-notify-and-alt-login.md)

## 原则

1. 业务不存 openid  
2. 微信 IP 白名单只填 egress  
3. 发码登录不替代 cf-auth  
