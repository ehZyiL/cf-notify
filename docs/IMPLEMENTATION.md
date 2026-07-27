# cf-notify 实现方案

> 独立通知微服务：微信公众号（优先）+ 可扩展 TG；用户绑定以 **cf-auth `user_id`** 为中心；出站微信 API 经 **固定公网 IP 网关**。  
> 备选「公众号发码登录」只做预留，默认关闭。

相关文档：

- cf-auth 侧预留：`../cf-auth/docs/wechat-notify-and-alt-login.md`
- 绑定码思路参考：[订阅号发码登录](https://segmentfault.com/a/1190000047203211)

---

## 1. 目标与非目标

### 1.1 目标（Phase 1）

| 能力 | 说明 |
|------|------|
| 微信公众号绑定 | 用户已登录业务后，网页申请短码 → 向公众号发送 → 回调绑定 openid |
| 服务端发送 | 业务（xy-erp Cron/API）用 service key 调用 `POST /api/v1/send` |
| 模板消息出站 | Worker **不**直连微信；经固定 IP 网关代理 |
| 投递日志 | 成功/失败可查 |
| 多通道骨架 | `channel` 枚举预留 `telegram` 等，P1 只实现 `wechat_oa` |

### 1.2 非目标（P1 不做）

- 用公众号发码替代 cf-auth 主登录（仅预留开关与数据字段）
- 企业微信 / TG 完整实现（接口与表结构预留）
- 复杂订阅中心 UI（可先默认「绑定即接收业务事件」）
- 把 AppSecret 放进浏览器或 xy-erp 前端

### 1.3 成功标准

1. 用户在 xy-erp（或 notify 简易页）完成公众号绑定，库中有 `verified` 记录。  
2. xy-erp 用 service key 调 `/api/v1/send`，用户收到模板消息。  
3. 微信后台 IP 白名单仅含出站网关；回调 URL 为 notify 自定义域。  
4. 未绑定用户发送返回明确错误，不拖垮调用方。

---

## 2. 总体架构

```
                    ┌─────────────┐
   浏览器/用户 ─────►│  cf-auth    │  身份 JWT (sub=user_id)
                    └──────┬──────┘
                           │ user_id
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   ┌──────────┐     ┌────────────┐    ┌─────────────┐
   │  xy-erp  │────►│ cf-notify  │◄───│ 微信服务器   │
   │  等业务   │send │  Workers   │入站 │ 消息回调     │
   └──────────┘     └─────┬──────┘    └─────────────┘
                          │ 出站（模板消息）
                          ▼
                   ┌──────────────┐
                   │ 出站网关      │  固定公网 IP
                   │ wechat-egress│  白名单填微信后台
                   └──────┬───────┘
                          ▼
                   api.weixin.qq.com
```

| 组件 | 运行位置 | 职责 |
|------|----------|------|
| **cf-notify** | Cloudflare Workers + D1 + KV + Queues | D1 原子绑定挑战、回调验签、异步发送、状态机、service scope 鉴权 |
| **wechat-egress** | 固定公网 IP 主机（Docker/Node/Go 任选） | `access_token` 缓存、模板/客服消息代理 |
| **cf-auth** | 已有 | 用户身份与 RS256 JWT；cf-notify 通过 Service Binding 获取 JWKS |
| **业务 Worker** | 已有 xy-erp 等 | 触发通知；设置页引导绑定 |

---

## 3. 仓库与目录（建议）

```
cf-notify/
├── docs/
│   └── IMPLEMENTATION.md          # 本文
├── migrations/
│   ├── 0001_init.sql
│   ├── 0002_reliable_delivery.sql
│   ├── 0003_binding_challenges.sql
│   └── 0004_client_scopes.sql
├── public/                        # 可选：简易「绑定状态」页
├── src/
│   ├── index.mjs                  # Worker 入口
│   ├── app.mjs                    # 路由
│   ├── config.mjs
│   ├── http.mjs
│   ├── auth-user.mjs              # 校验用户 JWT（调 cf-auth 或本地验签）
│   ├── auth-service.mjs           # service key 校验
│   ├── bindings.mjs               # 绑定码 + CRUD
│   ├── send.mjs                   # 发送编排
│   ├── channels/
│   │   ├── wechat-callback.mjs    # 入站
│   │   ├── wechat-send.mjs        # 出站 → egress
│   │   └── telegram-send.mjs      # stub
│   ├── rate-limit.mjs
│   └── storage.mjs
├── egress/                        # 固定 IP 网关（可同仓子目录）
│   ├── README.md
│   ├── package.json / go.mod
│   └── server.mjs
├── wrangler.toml
├── package.json
└── README.md
```

---

## 4. 数据模型

### 4.1 D1 migrations

```sql
-- 业务调用方（xy-erp 等）
CREATE TABLE IF NOT EXISTS notify_clients (
  client_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,              -- 对应 cf-auth 的 service id，如 xy-erp
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 通道绑定
CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                 -- cf-auth sub
  channel TEXT NOT NULL,                 -- wechat_oa | telegram | ...
  external_id TEXT NOT NULL,             -- openid / chat_id
  status TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN ('pending', 'verified', 'revoked')),
  meta_json TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_bindings_user ON channel_bindings(user_id);
CREATE INDEX IF NOT EXISTS idx_bindings_user_ch ON channel_bindings(user_id, channel);

-- 事件订阅（P1 可简化：绑定即全开，此表 P1.5）
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service_id TEXT NOT NULL,              -- xy-erp | *
  event_type TEXT NOT NULL,             -- worklog.failed | *
  channels_json TEXT NOT NULL DEFAULT '["wechat_oa"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, service_id, event_type)
);

-- 投递日志
CREATE TABLE IF NOT EXISTS notification_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  service_id TEXT,
  client_id TEXT,
  event_type TEXT,
  channel TEXT,
  status TEXT NOT NULL,                 -- queued | sent | failed | skipped
  provider_msg_id TEXT,
  error TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_user_time ON notification_logs(user_id, created_at DESC);

-- 公众号/通道应用配置（非 secret 的 meta；secret 走 env）
CREATE TABLE IF NOT EXISTS channel_apps (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,                -- wechat_oa
  name TEXT NOT NULL,
  app_id TEXT,                          -- 可放非敏感；secret 仅 env/egress
  template_map_json TEXT,               -- event_type → template_id + field map
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 4.2 KV

| Key | 值 | TTL |
|-----|-----|-----|
| `rl:*` | 限流计数 | 窗口+ε |
| `cf-auth:jwks:v1` | cf-auth 公钥集合缓存 | 300s |

绑定挑战存 D1 `binding_challenges`，数据库只保存短码 SHA-256。消费使用带 `consumed_at IS NULL AND expires_at > ?` 的条件更新，避免并发重复消费。

### 4.3 短码 `purpose`（预留登录）

| purpose | 说明 | P1 |
|---------|------|-----|
| `wechat_bind` | 通知绑定 | ✅ 实现 |
| `wechat_login` | 备选发码登录 | ⬜ 只占位，开关默认关 |

---

## 5. HTTP API

### 5.1 用户侧（需用户 JWT）

用户 JWT：与 xy-erp 相同——**cf-auth 签发的 access/session**，或业务会话内由 xy-erp BFF 代发绑定请求（推荐 BFF，避免把 notify CORS 搞复杂）。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/bindings/code` | Body: `{ channel: "wechat_oa" }` → `{ code, expireIn, qrcodeUrl? }` |
| `GET` | `/api/bindings/status?code=` | `{ status: pending\|verified\|expired }` |
| `GET` | `/api/bindings` | 当前用户绑定列表 |
| `DELETE` | `/api/bindings/:id` | 解绑 |

**鉴权：** `Authorization: Bearer <cf-auth JWT>`  
验签：生产使用 `CF_AUTH` Service Binding 拉取 RS256 JWKS，并校验 `exp`、`iss`、可选 `aud` 和 `sub`。HS256 只保留给本地兼容测试。创建订阅时必须确认 JWT `services` 包含目标业务。

### 5.2 业务侧（Service Key）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/send` | 发送通知 |
| `POST` | `/api/v1/send/batch` | P2 |

**鉴权：** `Authorization: Bearer <clientId>:<clientSecret>`；也可将 client ID 放在 `X-Notify-Client-Id`，Bearer 中只放 secret。
（secret 仅哈希存 D1，与 cf-auth client 类似。）

**Body：**

```json
{
  "user_id": "cf-auth-sub-uuid",
  "service_id": "xy-erp",
  "event": "worklog.failed",
  "title": "日志提交失败",
  "body": "计划 xxx 执行失败：...",
  "url": "https://xy-erp.../",
  "channels": ["wechat_oa"],
  "data": { "orderNo": "SO-001", "result": "failed" }
}
```

收件目标和供应商模板由 cf-notify 的绑定、订阅及 `channel_apps` 配置解析；请求中的 `openid`、`chat_id`、`template`、`template_id` 等字段会被拒绝。

**响应：**

```json
{
  "ok": true,
  "results": [
    { "channel": "wechat_oa", "status": "sent", "logId": "..." }
  ]
}
```

未绑定：`status: "skipped", error: "not_bound"`，HTTP 仍 200（便于 Cron 批量），或可选 `strict: true` → 404/422。

### 5.3 微信入站

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/wechat/callback` | 微信 URL 验证（echostr） |
| `POST` | `/wechat/callback` | 消息/事件 XML 或安全模式 |

环境变量：`WECHAT_TOKEN`、`WECHAT_AES_KEY`、`WECHAT_APP_ID`（解密用）。

### 5.4 运维

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` / `/api/health` | 健康检查 |
| `GET` | `/api/admin/logs` | P2，平台超管或 notify admin |

---

## 6. 绑定流程（P1 详设）

对齐文章「challenge → 发码 → 回调」：

```
1. 用户已登录 xy-erp
2. xy-erp 前端或 BFF:
   POST {NOTIFY}/api/bindings/code
   Authorization: 用户身份（或 xy-erp 用 service key + 确认 session 后代调）
3. notify 生成 8 位数字/字母 code（约 40 bit，排除易混字符），D1 只保存哈希和 300s 过期时间
4. UI 展示公众号二维码 + 「请发送：{code}」
5. 轮询 GET .../status?code= 每 2s，最多 5min
6. 用户发送文本
7. 回调：
   - 验签
   - 若 Content 匹配 code
   - 条件 UPDATE 原子消费挑战 → userId
   - UPSERT channel_bindings
   - 若 openid 已绑其他 user → 回复失败文案，不覆盖（或策略：强制换绑需解绑）
   - 被动回复「绑定成功」
8. 轮询 status=verified
```

**限流：** 每用户 1 分钟最多 3 次申请码；每 openid 1 分钟最多 10 次错误码。

---

## 7. 发送流程（P1 详设）

```
xy-erp scheduler 失败
  → POST notify /api/v1/notifications + Idempotency-Key

notify:
  1. 验 service client、scope、有效期和 serviceId 一致性
  2. D1 幂等写 notification_events，投递 Dispatch Queue
  3. consumer 重新解析订阅/绑定，幂等创建 notification_deliveries
  4. Delivery Queue consumer 再次检查订阅/绑定并取得模板
  5. POST {EGRESS_BASE}/wechat/template/send
  6. 更新 delivery/event 状态；429、网络错误和 5xx 按消息重试，耗尽后进入 DLQ
```

### 7.1 出站网关 `egress/` 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | |
| `POST` | `/wechat/template/send` | 代理模板消息 |
| `POST` | `/wechat/custom/send` | 可选客服消息 |

**鉴权：** 共享密钥 `EGRESS_SHARED_SECRET`（notify 与网关双方配置）。  
**微信凭证：** `WECHAT_APP_ID` / `WECHAT_APP_SECRET` **仅存网关**（或网关 + CF secret 二选一，推荐仅网关）。

网关职责：

1. 缓存 `access_token`（内存/文件/redis，过期前刷新）。  
2. 调用 `https://api.weixin.qq.com/cgi-bin/message/template/send`。  
3. 统一错误码返回给 notify。  
4. **禁止** 开放任意 URL 代理（SSRF）；只允许微信 API host。

部署：Docker 或 systemd，监听 `127.0.0.1` + Caddy/nginx TLS（`egress.example.com`），防火墙只开 443。

---

## 8. 环境变量清单

### 8.1 cf-notify（Workers）

| 变量 | 说明 |
|------|------|
| `CF_AUTH` | 指向 `cf-auth` 的 Service Binding，用于 RS256 JWKS |
| `CF_AUTH_ISSUER` | 必须匹配 JWT `iss` |
| `CF_AUTH_JWT_SECRET` | 仅 HS256 本地兼容/测试 Token |
| `WECHAT_TOKEN` | 公众号服务器 Token |
| `WECHAT_AES_KEY` | 安全模式 |
| `WECHAT_APP_ID` | 回调/配置 |
| `WECHAT_QRCODE_URL` | 关注二维码图片或跳转（展示用） |
| `EGRESS_BASE_URL` | `https://egress.xxx` |
| `EGRESS_SHARED_SECRET` | 调网关 |
| `WECHAT_CODE_LOGIN_ENABLED` | 默认 `false`（备选登录） |
| `BIND_CODE_TTL_SEC` | 默认 300 |
| `SUBSCRIPTIONS_DEFAULT_OPEN` | 生产默认 `false` |
| `ENFORCE_USER_SERVICE_MEMBERSHIP` | 生产默认 `true` |
| `NOTIFICATION_DIRECTORY_MODE` | `local` 保持 Phase 1；cf-auth RPC 和数据迁移完成后切换为 `rpc` |
| `WECHAT_PROVIDER_ACCOUNT_ID` | RPC 模式的公众号发送主体 ID；未设时回退 `WECHAT_APP_ID` |
| `WECHAT_CALLBACK_MAX_SKEW_SEC` | 回调时间窗，默认 300 |
| `EGRESS_TIMEOUT_MS` | egress 超时，默认 10000 |

D1 / KV 绑定：`DB`、`KV`。

### 8.2 egress

| 变量 | 说明 |
|------|------|
| `WECHAT_APP_ID` | |
| `WECHAT_APP_SECRET` | |
| `EGRESS_SHARED_SECRET` | |
| `PORT` | |

### 8.3 xy-erp

| 变量 | 说明 |
|------|------|
| `NOTIFY_URL` | `https://notify.xxx` |
| `NOTIFY_CLIENT_ID` | |
| `NOTIFY_CLIENT_SECRET` | |

---

## 9. 与 cf-auth / xy-erp 的衔接

### 9.1 cf-auth

- **P1 不改登录**；用户体系不变。  
- 文档已预留发码登录：`cf-auth/docs/wechat-notify-and-alt-login.md`。  
- P2：`WECHAT_CODE_LOGIN_ENABLED` + internal `verify-code` API。
- 当前 `cf-auth` 尚未实现 `NotificationDirectory` RPC，生产继续使用 `NOTIFICATION_DIRECTORY_MODE=local`。cf-notify 已完成 RPC 客户端与业务接口，待 auth 端上线并迁移权威数据后切换。
- `rpc` 模式需要 `verifyServiceApiKey`、`getEffectiveNotificationSettings`、`resolveNotificationTargets`、`consumeBindingChallenge` 和 `updateBindingStatus`。RPC 不可用时请求失败，不回退本地 binding/subscription。
- Dispatch 和实际 Delivery 前分别解析一次目标；地址只存在于当前 Worker 调用内存，D1 与 Queue 仅保存 event/delivery/binding ID。
- 本批次尚未实现 auth 事件目录返回的 payload schema 校验和 `deferUntil` 延迟调度；切换 `rpc` 前必须补齐这两项及对应契约测试。

### 9.2 xy-erp

| 点 | 行为 |
|----|------|
| 设置页 | 「绑定微信通知」→ 调 bindings/code + 轮询 status |
| 任务失败 / 提醒 | `send({ user_id: owner_user_id, event, body })` |
| 测试发送 | 当前登录用户 user_id + event=`test` |

不在 xy-erp 存 openid。

---

## 10. 安全

| 项 | 措施 |
|----|------|
| 回调 | 微信 signature / 安全模式；Token 防伪造 |
| 绑定码 | 高熵、短 TTL、一次性、限速 |
| openid 唯一 | `UNIQUE(channel, external_id)` |
| Service key | 哈希存储、可轮换 |
| 出站网关 | 密钥 + 路径白名单 + 仅微信 host |
| 日志 | 不落用户消息全文可配置脱敏 |
| 管理 | 解绑、吊销、审计 P2 |

---

## 11. 配置优先级（若做管理端）

与 cf-auth 一致：

```
管理端 KV 覆盖 > env/secrets > 代码默认
```

**密钥永不进管理端明文**（AppSecret、EGRESS_SECRET 等）。

---

## 12. 分期交付

### Phase 1 — MVP（建议 1～2 周节奏）

1. 初始化 wrangler + D1 迁移 + 健康检查  
2. Service client 创建脚本 / admin 种子  
3. 绑定码 + status + 回调（明文模式可先通，再上安全模式）  
4. egress 最小模板发送 + 微信 IP 白名单  
5. `/api/v1/send` + xy-erp 一处调用（失败通知或测试按钮）  
6. README 部署说明  

### Phase 1.5

- 安全模式加解密  
- 订阅表 + 用户开关  
- 投递失败重试（Queue 或定时扫 logs）  

### Phase 2

- `purpose=wechat_login` 备选发码登录（默认关）  
- Telegram 通道  
- 管理端绑定/日志查询  

### Phase 3

- 多公众号 `channel_apps`  
- 模板可视化映射  
- 与 cf-auth 账号中心统一入口  

---

## 13. 测试计划

| 类型 | 内容 |
|------|------|
| 单元 | 码生成/校验、签名验算、模板字段映射 |
| 集成 | mock 微信回调 XML → 绑定成功 |
| 契约 | mock egress 200/4xx → logs 状态 |
| 手工 | 真机关注发码；真机收模板；错误 openid/过期码 |

---

## 14. 部署清单（上线日）

1. 注册/确认公众号，开通模板消息。  
2. 部署 **egress** 到固定 IP，HTTPS，填微信 IP 白名单。  
3. 部署 **cf-notify**，绑定自定义域 `notify.xxx`。  
4. 公众号服务器 URL → `https://notify.xxx/wechat/callback`。  
5. 创建 notify client 给 xy-erp，配置 secrets。  
6. 走通绑定 + 测试发送。  
7. xy-erp 生产事件接入。  

---

## 15. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 订阅号模板能力受限 | 确认账号类型；不够则客服消息（48h）或升级服务号 |
| 出站网关单点 | 健康检查 + 备用机；发送失败入 logs 可重试 |
| 用户取消关注 | 收 unsubscribe 事件 → binding revoked |
| 码被爆破 | 长度+TTL+限速+失败锁定 |
| Workers 调 egress 超时 | Delivery Queue 指数退避；耗尽后 DLQ 标记 unknown/failed |

---

## 16. 开放决策（实现前确认）

| # | 问题 | 建议默认 |
|---|------|----------|
| 1 | openid 已绑其他账号时？ | 拒绝覆盖，提示先解绑 |
| 2 | 订阅是否必须已绑业务？ | 是，校验 JWT `services` |
| 3 | 未订阅是否默认全开？ | 生产关闭；本地可显式开启兼容模式 |
| 4 | 模板字段从哪来？ | `channel_apps.template_map_json` + send.data |
| 5 | 发码登录自动注册？ | **否**，仅已有用户 |

---

## 17. 部署前执行顺序

```
1. 创建 D1、KV、Dispatch/Delivery Queue 和两个 DLQ，替换 wrangler 中实际资源 ID
2. 确认同账号已部署名为 `cf-auth` 的 Worker，并保持 `CF_AUTH_ISSUER` 一致
3. 应用 0001-0004 D1 migrations
4. 通过 Worker Secrets 配置微信、egress、admin 与本地兼容密钥
5. 运行 tests、types check、startup check 和 deploy dry-run
6. 部署固定 IP egress，再部署 cf-notify
7. 真机完成关注、绑定、模板发送、429/5xx/DLQ 故障演练
```

---

## 18. 可靠投递实现（2026-07-27）

当前实现已经从请求内同步发送升级为以下链路：

```text
POST /api/v1/notifications
  -> D1 notification_events（service_id + Idempotency-Key 唯一）
  -> cf-notify-dispatch
  -> D1 notification_deliveries（event + channel + target_key 唯一）
  -> cf-notify-delivery
  -> channel adapter -> provider/egress
```

- HTTP 成功受理返回 `202 Accepted`；幂等重放返回相同 `eventId`。
- Queue body 仅包含 `eventId` 或 `deliveryId`，不包含 `openid` 或业务 payload。
- Dispatch 和 Delivery 都按消息单独 `ack()` / `retry()`，并分别配置 DLQ。
- 实际投递前重新检查订阅和 verified binding；解绑、换绑或退订会跳过旧消息。
- `scheduled()` 可补偿 D1 已写入但 Queue 发送失败或长时间未处理的记录；当前账号 Cron 配额已满，生产未创建新 Trigger。入口入队失败会返回可重试的 `503`，同一幂等键重试会重新入队。
- `GET /api/v1/notifications/:eventId` 只允许同一 service 查询，并隐藏真实目标和错误全文。
- 外部供应商仍只能做到至少一次；网络超时导致结果未知时，DLQ 最终状态记为 `unknown`。
- 绑定挑战只保存 D1 哈希并原子消费；微信 AES 回调校验签名、时间窗和重放收据。
- service credential 支持发送/查询 scope、到期和撤销；用户 JWT 支持 cf-auth RS256/JWKS。

`/api/v1/send` 保留兼容：部署环境有 Queue binding 时进入可靠异步链路；无 Queue binding 的本地旧测试环境继续同步发送。

本地 PostgreSQL 不作为默认存储。Worker 无法直接访问局域网 PostgreSQL；备选方案必须使用 Hyperdrive + 可达 TLS 数据库，或通过 Tunnel + Access 暴露受限存储 API，严禁公网开放 `5432`。仅为微信 IP 白名单时继续使用固定 IP egress，无需更换 D1。

**文档版本：** 2026-07-27
**状态：** Phase 1/2 基础能力与可靠投递已实现，待真实 Cloudflare/微信环境验收
