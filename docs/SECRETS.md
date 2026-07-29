# 生产凭据管理

生产凭据不能共用同一个值，但必须由一个受控来源同步。cf-notify 以 cloudclone 的
`/etc/cf-notify-egress.env` 作为生产凭据清单；该文件必须保持 `root:root 600`，不得进入 Git。

| 配置 | 是否敏感 | 唯一来源 | 消费方 |
|------|----------|----------|--------|
| `WECHAT_APP_ID` | 否 | cloudclone 清单 | cloudclone、Worker `vars` |
| `WECHAT_APP_SECRET` | 是 | cloudclone 清单 | 仅固定出口 |
| `WECHAT_TOKEN` | 是 | cloudclone 清单 | Worker、微信公众平台服务器配置 |
| `WECHAT_AES_KEY` | 是 | cloudclone 清单 | Worker、微信公众平台；仅安全模式需要 |
| `WECOM_CORP_ID` | 否 | cloudclone 清单 | cloudclone、Worker `vars` |
| `WECOM_AGENT_ID` | 否 | cloudclone 清单 | 仅固定出口 |
| `WECOM_APP_SECRET` | 是 | cloudclone 清单 | 仅固定出口 |
| `EGRESS_SHARED_SECRET` | 是 | cloudclone 清单 | cloudclone、Worker |

严禁把 `WECHAT_APP_SECRET` 或 `WECOM_APP_SECRET` 放进 Wrangler vars、Worker secrets、
`.dev.vars`、D1、日志或聊天。AppID、CorpID 和 AgentID 可以提交，其他值只能通过受保护文件
或交互式终端传递。

## 检查与同步

```bash
# 只读：检查文件权限、公众号/企业微信凭据清单、ID 漂移、Worker binding、回调签名和出口鉴权
npm run prod:secrets:check

# 变更：从 cloudclone 读取 Worker 所需密钥，dry-run 后原子部署，再重启并检查出口
npm run prod:secrets:apply
```

同步脚本不会把 `WECHAT_APP_SECRET` 或 `WECOM_APP_SECRET` 上传到 Worker，只验证它们在
cloudclone 中存在且格式正确。临时密钥文件位于权限为 700 的 `/tmp` 目录，退出时逐个清理，
任何密钥都不会打印。

## 轮换顺序

1. 在微信公众平台轮换 AppSecret。
2. 通过 SSH 交互式编辑 cloudclone 的 `/etc/cf-notify-egress.env`，更新
   `WECHAT_APP_SECRET`；不要把值放在命令参数或聊天中。
3. 若更改服务器配置 Token，同时更新清单中的 `WECHAT_TOKEN` 和微信公众平台 Token。
4. 运行 `npm run prod:secrets:apply`。
5. 在微信公众平台保存服务器配置，再发送一条普通消息确认回调。
6. 从业务系统创建全新的测试通知，不重试旧 delivery。

企业微信应用 Secret 轮换时执行相同原则：先在企业微信管理后台轮换，再通过 SSH 交互式更新
cloudclone 的 `WECOM_APP_SECRET`，运行 `npm run prod:secrets:apply`，最后创建全新的企业微信
测试通知。`WECOM_AGENT_ID` 或 `WECOM_CORP_ID` 发生变化时也必须先更新清单，并通过只读检查
确认 Worker 与固定出口没有漂移。

生产回调使用明文模式时，`WECHAT_AES_KEY` 可以留空；启用兼容或安全模式前必须先写入微信
公众平台生成的 43 字符 EncodingAESKey，再执行同步。
