# cf-notify

Cloudflare Workers 统一通知服务。

| 阶段 | 状态 |
|------|------|
| Phase 1 绑定 + send + egress | ✅ |
| Phase 1.5 订阅 / 限流 / AES 加解密 / 模板映射 / 退订吊销 | ✅ |
| Phase 2 管理日志·重试·channel-apps·TG stub·发码登录骨架 | ✅（登录默认关） |
| 真机部署 / xy-erp 接入 | ⬜ |

用户身份 = **cf-auth** `sub`。微信出站经 **固定 IP egress**。

## 测试

```bash
npm test
# 27 passed
```

## 主要 API

| 方法 | 路径 | 鉴权 |
|------|------|------|
| GET | `/api/health` | — |
| POST | `/api/bindings/code` | 用户 JWT |
| GET | `/api/bindings/status?code=` | 用户 JWT |
| GET/DELETE | `/api/bindings` `.../:id` | 用户 JWT |
| GET/POST/DELETE | `/api/subscriptions` | 用户 JWT |
| POST | `/api/v1/send` | Service `Bearer id:secret` |
| GET | `/api/logs` | 用户 JWT |
| GET/POST | `/wechat/callback` | 微信签名 |
| POST | `/api/admin/clients` | Bootstrap Key |
| GET | `/api/admin/logs` | Bootstrap Key |
| POST | `/api/admin/retry` | Bootstrap Key |
| POST | `/api/admin/channel-apps` | Bootstrap Key |
| POST | `/api/session/wechat/challenge` | 仅 `WECHAT_CODE_LOGIN_ENABLED` |

## 本地

见下方 env；`npx wrangler dev` + 可选 `node egress/server.mjs`。  
自测页：`public/index.html`（`ALLOW_TEST_TOKEN=true`）。

```bash
# .dev.vars 示例
CF_AUTH_JWT_SECRET=...
WECHAT_TOKEN=...
WECHAT_AES_KEY=                # 可选，安全模式 43 字符
WECHAT_APP_ID=
EGRESS_BASE_URL=http://127.0.0.1:8789
EGRESS_SHARED_SECRET=...
ADMIN_BOOTSTRAP_KEY=dev-admin
ALLOW_TEST_TOKEN=true
WECHAT_CODE_LOGIN_ENABLED=false
```

## 文档

- [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md)
- [egress/README.md](./egress/README.md)
- 备选登录预留：[../cf-auth/docs/wechat-notify-and-alt-login.md](../cf-auth/docs/wechat-notify-and-alt-login.md)

## 原则

1. 业务不存 openid  
2. 微信 IP 白名单只填 egress  
3. 发码登录不替代 cf-auth  
