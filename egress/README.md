# 微信 / 企业微信 egress（固定公网 IP）

将本服务部署在有 **固定公网 IP** 的机器上，并把该 IP 填入微信公众平台 IP 白名单。

## 环境变量

```bash
export WECHAT_APP_ID=wx...
export WECHAT_APP_SECRET=...
export WECOM_CORP_ID=ww...
export WECOM_APP_SECRET=...
export WECOM_AGENT_ID=1000002
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
- `POST /wechat/custom/send`
  Header: `X-Egress-Key: $EGRESS_SHARED_SECRET`
  Body: `{ openid, text }`
- `POST /wechat/template/send`
  Header: `X-Egress-Key: $EGRESS_SHARED_SECRET`
  Body: `{ openid, template_id, data, url? }`
- `POST /wecom/app/send`
  Header: `X-Egress-Key: $EGRESS_SHARED_SECRET`
  Body: `{ userId, msgType: "text"|"markdown"|"textcard", ... }`

## 安全

- 仅代理微信官方 API，不做通用 HTTP 代理。  
- 共享密钥使用常量时间比较；请求体限制 64 KiB，上游请求超时 10 秒。
- 密钥不要提交到 git，公网部署必须放在 HTTPS 反向代理之后。
- 企业微信接口只接受一个已绑定 UserID，拒绝部门、标签与 `@all` 广播。
- 文本类字段（`text.content` / `markdown.content`）按 **UTF-8 字节** 限制 2048，由出口统一截断。
- 公众号与企业微信 access_token 命中失效码（40001/40014/42001）时，出口清缓存并重试一次。
