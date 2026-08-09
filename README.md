# cf-notify

Cloudflare Workers 统一通知服务。

| 阶段 | 状态 |
|------|------|
| Phase 1 绑定 + send + egress | ✅ |
| Phase 1.5 订阅 / 限流 / AES 加解密 / 模板映射 / 退订吊销 | ✅ |
| Phase 2 管理日志·重试·channel-apps·TG stub | ✅ |
| Reliable delivery：幂等事件、Dispatch/Delivery Queue、DLQ、Cron 补偿 | ✅ |
| cf-auth NotificationDirectory RPC 适配层 | ✅（生产使用 RPC 模式） |
| 企业微信：加密回调绑定、应用消息、固定 IP egress | ✅（已生产验证） |
| 用户入口迁移至 cf-auth + 管理端 OIDC/PKCE SSO | ✅ |
| 生产部署 | ✅ |
| xy-erp 接入 | 🟡 模板与测试通知已接入；自动成功通知和截止提醒仍关闭 |

用户身份 = **cf-auth** `sub`。公众号和企业微信出站均经 **固定 IP egress**。

## 测试

```bash
npm test
# 103 passed
```

## 主要 API

| 方法 | 路径 | 鉴权 |
|------|------|------|
| GET | `/api/health` | — |
| POST | `/api/v1/send` | Service `notifications.send` + `Idempotency-Key` |
| POST | `/api/v1/notifications` | Service `notifications.send` + `Idempotency-Key` |
| GET | `/api/v1/notifications/:eventId` | 同一 Service + `notifications.delivery.read` |
| GET | `/api/v1/users/:userId/notification-settings?eventType=` | Service `notifications.settings.read`，仅 RPC 模式 |
| GET/POST | `/wechat/callback` | 微信签名 |
| GET/POST | `/wecom/callback` | 企业微信签名 + AES 加密 |
| GET | `/api/channel-guides` | 公开，只读渠道引导 |
| GET | `/api/admin/auth/login` | OIDC Authorization Code + PKCE 启动 |
| GET | `/api/admin/auth/callback` | OIDC 回调 |
| GET/DELETE | `/api/admin/session` | HttpOnly 管理会话 |
| GET/PUT/DELETE | `/api/admin/channel-guides/:channel?` | cf-auth 平台管理员 SSO |
| POST/DELETE | `/api/admin/clients[/:clientId]` | cf-auth 平台管理员 SSO |
| GET | `/api/admin/logs` | cf-auth 平台管理员 SSO |
| GET | `/api/admin/runtime` | cf-auth 平台管理员 SSO，非敏感运行模式 |
| GET | `/api/admin/readiness` | cf-auth 平台管理员 SSO，依赖就绪状态 |
| POST | `/api/admin/retry` | cf-auth 平台管理员 SSO，先预览再显式确认 |
| POST | `/api/admin/deliveries/:deliveryId/retry` | cf-auth 平台管理员 SSO，安全单条重试 |
| POST | `/api/admin/channel-apps` | cf-auth 平台管理员 SSO |

## 界面

| 路径 | 说明 |
|------|------|
| `/` | 跳转至 cf-auth `/#notifications` 账户中心 |
| `/admin` | **运营控制台**（cf-auth 平台管理员 SSO） |

管理控制台适配桌面和移动端；用户侧界面由 cf-auth 账户中心统一提供。

## 本地

先执行 `npm install`，再运行 `npm run dev`；可选启动 `node egress/server.mjs`。
用户绑定和通知偏好统一在 cf-auth 管理。管理端需要在 cf-auth 注册公开 PKCE client
`cf-notify-admin`，redirect URI 为 `/api/admin/auth/callback`，并把平台管理员绑定到该 client
所属的 `cf-notify` service。

```bash
# .dev.vars 示例（不要提交真实值）
WECHAT_TOKEN=...
WECHAT_AES_KEY=                # 可选，安全模式 43 字符
WECHAT_APP_ID=
WECOM_CALLBACK_TOKEN=...
WECOM_ENCODING_AES_KEY=          # 企业微信 43 字符 EncodingAESKey
WECOM_CORP_ID=ww...
WECOM_ACCOUNT_NAME=企业名称
WECOM_QRCODE_URL=https://notify.example.com/channel-assets/wecom-join.jpg
WECOM_APP_URL=https://work.weixin.qq.com/...
EGRESS_BASE_URL=http://127.0.0.1:8789
EGRESS_SHARED_SECRET=...
WECHAT_SEND_MODE=custom_text
ADMIN_OAUTH_CLIENT_ID=cf-notify-admin
CF_AUTH_ACCOUNT_URL=https://cf-auth.example.com/#notifications
NOTIFICATION_DIRECTORY_MODE=rpc
```

`WECHAT_SEND_MODE=custom_text` 仅适用于公众号接口权限中已开通客服消息能力的账号，且用户必须在微信允许的互动窗口内。未认证账号若返回 `48001 api unauthorized`，不能主动发送客服消息，只能在用户发消息时被动回复；需要认证/升级账号或改用其他通知渠道。公众号开通模板能力后，可切回 `template` 并维护 `channel_apps` 模板映射。

cf-notify 不接收用户 JWT。用户绑定和通知偏好使用 cf-auth 自身的同源 HttpOnly session；供应商回调通过 `CF_AUTH` Service Binding 消费绑定挑战。`CF_AUTH_ISSUER`、Service Binding、Queue 和 D1/KV binding 在 `wrangler.toml` 中声明。

管理端使用标准 OIDC Authorization Code + PKCE。浏览器只持有 15 分钟 HttpOnly opaque session Cookie，access token 保存在 cf-notify KV；每个后台请求通过 `CF_AUTH.verifyAdminAccessToken()` 实时确认 token、用户、service binding 和 `platformRole=admin`。旧 Bootstrap Key 鉴权已移除。

当前生产使用 `NOTIFICATION_DIRECTORY_MODE=rpc`：业务 API Key 由 `CF_AUTH.verifyServiceApiKey()` 验证，通知受理查询有效设置，Dispatch 和 Delivery 各自调用 `resolveNotificationTargets()`。公众号和企业微信绑定都调用 `consumeBindingChallenge()`；公众号取消关注调用 `updateBindingStatus()`。RPC 故障不会降级读取本地权威数据。

RPC 返回的 openid / 企业微信 UserID 只存在于当前 Worker 调用内存，不写入 cf-notify D1、Queue 或响应。企业微信 MVP 只允许绑定单个成员并向该成员发送自建应用消息，不接受部门、标签、多个成员或 `@all` 广播。

企业微信回调侧配置 `WECOM_CALLBACK_TOKEN`、`WECOM_ENCODING_AES_KEY`、`WECOM_CORP_ID`、`WECOM_PROVIDER_ACCOUNT_ID` 和可选的 `WECOM_APP_URL`。固定 IP egress 单独配置 `WECOM_CORP_ID`、`WECOM_APP_SECRET`、`WECOM_AGENT_ID`；AppSecret 不进入 Worker、浏览器、D1 或 Queue。消息有不含用户名/密码的 HTTPS 详情地址时发送 `textcard`，否则发送 `text`；可靠事件入口会拒绝 HTTP 或带凭据链接。

渠道引导由 `/api/channel-guides` 公开只读提供，同时返回渠道的 implemented、bindable、sendable、available、mode 和 reason。只有回调、固定出口与适配器均就绪的渠道才进入公开 guides；未实现的 Telegram 不能被运营端发布。管理端只把 `imageUrl`、`actionUrl` 等非敏感元数据写入 KV，优先级为 KV 动态配置 > Worker vars > 内置文案；二维码二进制仍托管在静态资源或外部 CDN，不写入 KV。

可靠投递使用四个 Queue。首次部署前创建并应用新增迁移：

- `cf-notify-dispatch`、`cf-notify-delivery`：主派发与投递队列
- `cf-notify-dispatch-dlq`、`cf-notify-delivery-dlq`：重试耗尽后的死信队列；消费者负责把最终状态写回 D1

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

生产中的 `/api/v1/send` 在 Queue binding 存在时也进入相同异步链路并返回 `202`。未配置 Queue 的本地同步兼容路径仅保留公众号/Telegram 旧行为；企业微信必须使用可靠 Queue API。

当前 Cloudflare 账号的 5 个 Cron Trigger 配额已用满，因此生产配置不新增 Cron。若首次 Queue 入队失败，接口返回带 `eventId` 和 `Retry-After` 的 `503`；调用方使用相同 `Idempotency-Key` 重试会重新入队，不会重复创建事件。`scheduled()` 补偿逻辑仍保留，释放 Cron 配额后可重新启用。

本轮投递链路优化（公众号 + 企业微信，放弃群机器人）：

- 字节级截断：微信/企业微信的 `text.content` / `markdown.content` 是 **字节** 限制（2048 B），不是字符数。中文 UTF-8 每字 3 字节，旧的 `.slice(0, 2000)` 会产出最多 6000 字节被供应商截断或拒绝。新增 `src/channels/text-bytes.mjs` 的 `sliceByBytes`，统一在 Worker 端与 egress 出口按字节裁剪且不切断多字节字符。
- 企业微信无链接消息升级为 **markdown**：有 `url` 仍走 textcard 卡片（带跳转按钮），无 `url` 从纯文本升级为 `markdown`（标题加粗、正文引用/颜色），体验显著优于纯文本；限制同为 2048 字节。
- 公众号 access_token 失效自动重试：egress 原来对 40001/40014/42001 直接抛错，现对齐企业微信出口——清缓存、强制刷新 token、重发一次原 payload；这几码在 `wechatErrorStatus` 也改为 503 临时可重试语义。公众号客户端抽取为独立 `egress/wechat-client.mjs`，与企业微信客户端结构对齐。

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
- [docs/PRODUCT_OPTIMIZATION.md](./docs/PRODUCT_OPTIMIZATION.md)
- [docs/SECRETS.md](./docs/SECRETS.md)
- [egress/README.md](./egress/README.md)

## 原则

1. 业务不存 openid  
2. 微信 IP 白名单只填 egress  
3. 用户身份、绑定和通知偏好由 cf-auth 统一管理
