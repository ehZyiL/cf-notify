# cf-notify

Cloudflare Workers 统一通知服务（Phase 1：微信公众号绑定 + 经固定 IP 网关发送）。

- 用户身份：`user_id` = **cf-auth** JWT `sub`
- 绑定：短码 → 用户发给公众号 → 回调写入 openid  
- 发送：`POST /api/v1/send`（service key）；微信出站 → **egress 固定 IP**
- 备选发码登录：数据预留，`WECHAT_CODE_LOGIN_ENABLED=false`
- **未接入 xy-erp**（本阶段仅自测）

## 文档

- [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md) — 完整方案  
- [egress/README.md](./egress/README.md) — 固定 IP 出站网关  

## 测试

```bash
cd /home/ehzyil/Projects/Learn/cf-notify
npm test
# 18 tests, all pass
```

| Seam | 覆盖 |
|------|------|
| S0 crypto | 密钥哈希、JWT、微信签名 SHA1 |
| S1 service client | 创建/鉴权/错误密钥 |
| S2/S3 bindings | 码生命周期、openid 冲突 |
| S4 wechat callback | 验签、XML、绑码成功 |
| S5 send | not_bound / sent / failed |
| S6 HTTP | health、绑定 API、回调、send |

## 本地开发

```bash
# 1) 创建 D1 / KV，填 wrangler.toml
npx wrangler d1 create cf-notify
npx wrangler kv namespace create KV

# 2) .dev.vars
cat > .dev.vars <<'EOF'
CF_AUTH_JWT_SECRET=same-as-cf-auth-jwt-secret
WECHAT_TOKEN=your-mp-token
EGRESS_BASE_URL=http://127.0.0.1:8789
EGRESS_SHARED_SECRET=shared-secret
ADMIN_BOOTSTRAP_KEY=dev-admin-key
ALLOW_TEST_TOKEN=true
BIND_CODE_TTL_SEC=300
WECHAT_CODE_LOGIN_ENABLED=false
EOF

# 3) 迁移 + 启动
npx wrangler d1 migrations apply cf-notify --local
npx wrangler dev

# 4) 另开终端跑 egress（真发微信时需要）
export WECHAT_APP_ID=... WECHAT_APP_SECRET=... EGRESS_SHARED_SECRET=shared-secret
node egress/server.mjs
```

打开 `http://127.0.0.1:8787/`（端口以 wrangler 为准）使用简易测试页：

1. **生成测试 Token**（`ALLOW_TEST_TOKEN=true`）  
2. **生成绑定码** → 模拟公众号发码（单元测试已覆盖回调）  
3. 创建 client：  
   `curl -X POST localhost:8787/api/admin/clients -H 'X-Admin-Bootstrap-Key: dev-admin-key' -H 'Content-Type: application/json' -d '{"serviceId":"test","name":"test"}'`  
4. **POST /api/v1/send** 测发送（需 egress 或会得到 `failed` + EGRESS 错误）

## 主要 API

| 方法 | 路径 | 鉴权 |
|------|------|------|
| GET | `/api/health` | 无 |
| POST | `/api/bindings/code` | 用户 JWT |
| GET | `/api/bindings/status?code=` | 用户 JWT |
| GET | `/api/bindings` | 用户 JWT |
| DELETE | `/api/bindings/:id` | 用户 JWT |
| POST | `/api/v1/send` | Service `Bearer clientId:secret` |
| GET/POST | `/wechat/callback` | 微信签名 |
| POST | `/api/admin/clients` | `X-Admin-Bootstrap-Key` |

## 状态

- [x] 方案  
- [x] Phase 1 核心代码 + 单测（无 xy-erp）  
- [ ] 部署 + 真机公众号联调  
- [ ] xy-erp 接入  
- [ ] 备选发码登录  

## 原则

1. 业务不存 openid  
2. Workers 不填微信 IP 白名单（只填 egress）  
3. 发码登录不替代 cf-auth 主登录  
