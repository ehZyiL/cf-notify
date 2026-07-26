# wechat-egress（固定公网 IP）

将本服务部署在有 **固定公网 IP** 的机器上，并把该 IP 填入微信公众平台 IP 白名单。

## 环境变量

```bash
export WECHAT_APP_ID=wx...
export WECHAT_APP_SECRET=...
export EGRESS_SHARED_SECRET=long-random-shared-with-cf-notify
export PORT=8789
```

## 运行

```bash
node server.mjs
# 建议前面加 Caddy/nginx 做 HTTPS：https://egress.example.com
```

## 接口

- `GET /health`
- `POST /wechat/template/send`  
  Header: `X-Egress-Key: $EGRESS_SHARED_SECRET`  
  Body: `{ openid, template_id, data, url? }`

## 安全

- 仅代理微信官方 API，不做通用 HTTP 代理。  
- 共享密钥使用常量时间比较；请求体限制 64 KiB，上游请求超时 10 秒。
- 密钥不要提交到 git，公网部署必须放在 HTTPS 反向代理之后。
