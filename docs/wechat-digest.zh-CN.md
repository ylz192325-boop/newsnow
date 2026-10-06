# 每天 9 点发送 NewsNow 微信早报

每天北京时间 09:00，由 GitHub Actions 临时启动 NewsNow，采集当前新闻列表，按来源汇总去重后，通过 PushPlus 发送到个人微信。默认包括澎湃新闻、华尔街见闻、财联社电报、IT之家，每个来源最多 5 条，并保留原文链接。当前版本提供标题及可用简介汇总，没有调用大模型，也不保证覆盖过去 24 小时的全部新闻。

工作流：`.github/workflows/wechat-digest.yml`。汇总脚本：`scripts/wechat-digest.mjs`。

## 配置接收账号

1. 打开 [PushPlus](https://www.pushplus.plus/)，使用自己的微信登录，关注其公众号。
2. 根据 [PushPlus 官方限制说明](https://www.pushplus.plus/doc/help/limit.html) 完成实名认证。该步骤由账号本人完成；未实名账号无法发送消息。
3. 在 PushPlus 获取 token，并确认账号开启发送和微信接收。不要把 token 发到聊天、写入代码或提交到仓库。
4. 在自己的 NewsNow Fork 打开 **Settings → Secrets and variables → Actions → New repository secret**，名称填 `PUSHPLUS_TOKEN`，值填自己的 token。

微信公众号可能只显示通知标题；点击通知可以查看完整早报。每日推送会使用 PushPlus 的微信消息机制，无需每天人工激活，但账号状态和平台限制仍会影响实际送达。参见 [激活消息说明](https://www.pushplus.plus/doc/help/activation.html) 和 [内容显示说明](https://www.pushplus.plus/doc/help/showmessage.html)。

## 安装和启用

1. Fork [newsnext/newsnow](https://github.com/newsnext/newsnow)，把本功能的文件和 `package.json` 修改提交到 Fork 的默认分支（通常为 `main`）。定时任务仅运行默认分支的工作流。
2. 在 Fork 的 **Actions** 页面启用工作流。Fork 的定时任务默认不会自动启用；如果提示禁用，打开 **Daily WeChat digest → Enable workflow**。
3. 打开 **Daily WeChat digest → Run workflow**。第一次保留 `dry_run` 勾选，下载本次运行的 `wechat-digest-preview` artifact，查看 `digest.html` 的内容和来源状态。
4. 再次运行，取消 `dry_run` 勾选。检查 **Send digest to PushPlus** 成功，并在个人微信中确认收到早报。
5. 之后每天北京时间 09:00 自动触发。cron 为 `0 1 * * *`，对应 UTC 01:00。安装、构建和抓取需要时间；GitHub 高峰可能延迟或漏掉排队任务，不能保证 09:00 准点送达。

公开仓库 60 天没有活动时 GitHub 会自动禁用定时工作流，届时需要重新启用。不要用自动提交制造虚假活动。若必须准点且长期无人维护，使用常驻服务器定时器更合适。参见 [GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

## 可选设置

在 **Settings → Secrets and variables → Actions → Variables** 配置：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `NEWSNOW_SOURCES` | `thepaper,wallstreetcn-news,cls-telegraph,ithome` | 逗号分隔的 NewsNow 来源 ID |
| `DIGEST_ITEMS_PER_SOURCE` | `5` | 每来源条数，范围 1–10 |

脚本还接受 `NEWSNOW_BASE_URL`，默认 `http://127.0.0.1:3000`。工作流固定使用临时本地服务，避免依赖公共站点的 Cloudflare 和缓存。若手动运行脚本，可指向已有 NewsNow 实例；接口可能返回缓存，早报会标注接口时间和缓存状态。

原站新闻源可能失败。部分失败会在早报中注明；所有来源都失败、数据过旧或没有可用新闻时，不发送空早报，工作流失败。采集时间不代表每篇文章的发布时间。

## 本地验证

需要 Node.js 24 和仓库声明的 pnpm 版本。先运行：

```sh
pnpm install --frozen-lockfile
pnpm test:digest
pnpm build
HOST=127.0.0.1 PORT=3000 ENABLE_CACHE=false INIT_TABLE=false node dist/output/server/index.mjs
```

在另一个终端查看预览，不需要 token：

```sh
pnpm digest:preview --output /tmp/newsnow-digest.html
```

真实发送前，通过自己的安全凭据方式设置 `PUSHPLUS_TOKEN` 环境变量，再运行 `pnpm digest`。不要把 token 明文放入命令行历史或 `.env` 文件。

## 故障处理

- **缺少 token**：新增 `PUSHPLUS_TOKEN` repository secret；变量名称必须完全一致。
- **PushPlus 拒绝请求**：日志只输出通用失败说明，不输出可能含凭据的响应。详细状态码在 PushPlus 后台查看：常见 `903` 是 token 错误、`905` 是未实名、`900` 是用户受限。参见 [状态码说明](https://www.pushplus.plus/doc/guide/code.html)。
- **请求已接受但微信没收到**：`code=200` 只表示 PushPlus 接受请求，不能证明微信送达。检查 PushPlus 的消息记录、账号状态和微信通知设置。自动查询送达状态还需要额外 OpenAPI 凭据和 IP 白名单，本实现不要求这些权限。
- **请求超时或返回不明确**：不自动重试发送，避免重复早报。先查 PushPlus 记录，确认未收到后再手动运行；手动重新运行可能重复发送。
- **来源失败**：查看早报的缺失来源及 Actions 的 API diagnostics。临时服务取消缓存，但原站仍可能限制访问。
- **Actions 全绿但未准时**：检查实际触发、构建和发送时刻。需要严格 09:00 时换用服务器。
