# @pippit-bridge/opencode-plugin

Pippit（小云雀）的 OpenCode custom-tool plugin，提供：

- `pippit_manage_access_keys`：通过一次性 localhost password form 配置、脱敏列出、切换和删除本地账号；
- `pippit_generate_video`：上传参考素材并提交异步视频任务；
- `pippit_get_video`：查询任务并安全下载结果；
- 共享的 Pippit 视频模型目录与异常恢复幂等账本。

这是单用户、local-first 的插件。账号库与幂等账本属于当前 OpenCode 用户，不做租户隔离或跨机器同步。

## 重要架构边界

这个包不是 LLM provider。Pippit 的公开 API 是异步媒体 API，不实现 OpenCode 的语言模型 contract。因此插件：

- 不返回 `auth` 或 `provider` hook；
- 不注册 `config.provider.pippit`；
- 不写入 `models: {}`；
- 不占用 OpenCode `/connect` auth slot；
- 不影响宿主默认模型的发现与选择。

## 安装

```bash
opencode plugin @pippit-bridge/opencode-plugin --global
```

或写入 OpenCode 配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@pippit-bridge/opencode-plugin"]
}
```

## 配置 Access Key

调用 `pippit_manage_access_keys`：

```json
{ "operation": "configure", "account_name": "工作账号" }
```

工具只返回高熵、短时、单次使用的 `http://127.0.0.1:<port>/enroll/<token>`。在浏览器打开链接，通过 password input 提交官网签发的 AK。AK 直接写入 `<OpenCode state>/pippit/access-keys.json`，不会进入聊天、普通工具参数、URL query 或日志。

loopback 服务只监听 `127.0.0.1`，校验 Host 与同源 Origin，拒绝 `Origin: null` 和跨域提交，限制 body 大小，并在 POST 开始时消费 token 以阻止重放。页面使用 `Cache-Control: no-store`、CSP、`Referrer-Policy: strict-origin` 与禁止嵌入响应头。

账号库父目录使用 `0700`，文件使用 `0600` 并原子替换。它与 OpenCode 本地 `auth.json` 处于相同的“同 UID 可读”威胁边界，不冒充系统 keychain。旧版 v1 auth-slot 状态会在下一次写入时迁移为不含 sentinel、pending marker 的 v2。

其他操作：

- `list`：只返回账号 ID、本地名称、脱敏 AK 与 active 状态；
- `switch`：选择新任务使用的账号；
- `delete`：删除本地 AK；这不等于在官网撤销 AK。

CI 或短期隔离环境可设置 `PIPPIT_ACCESS_KEY`。它覆盖新任务的 active 账号，但不会改写历史任务的账号绑定。

## 生成与异常恢复

插件在可能计费的提交前请求权限，并在写入 worktree 前单独请求下载权限。API origin 固定为 Pippit 官方 origin；远端参考素材执行公共网络与媒体签名检查，本地输入和输出均限制在当前 worktree。

`idempotency_key` 是可选的异常恢复键，不会转发到 Facade 或 Pippit API。未传时每次调用都是新提交；传入时使用 `<OpenCode state>/pippit/idempotency-v1.json` 做 HMAC 认证的跨重启恢复。参见 [持久化幂等设计](../../docs/idempotency.md)。

## 本地未发布包验证

直接验证 checkout 时，在仓库根目录构建后让 OpenCode 加载绝对 file URL：

```bash
npm run build -w @pippit-bridge/opencode-plugin
```

```json
{
  "plugin": [
    "file:///absolute/path/to/pippit-bridge/packages/opencode-plugin-pippit/dist/plugin.mjs"
  ]
}
```

也可以执行 `npm pack -w @pippit-bridge/opencode-plugin`，再在消费方的 OpenCode dependency 目录用 `npm install /absolute/path/to/pippit-bridge-opencode-plugin-0.1.2.tgz` 安装，并在配置中使用 `@pippit-bridge/opencode-plugin`。OpenCode 1.18.3 的 `opencode plugin <local-tgz>` 会错误地把 tgz 当目录读取 manifest，因此本地 tgz 不使用该 CLI 子命令。

发布包的运行入口是自包含 bundle；只有 OpenCode 宿主 API 保持 external，因此不依赖尚未发布的本仓库 core/MCP 构建。

当前修复在明确确认前不会发布到 npm。
