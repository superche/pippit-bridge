# OpenCode plugin 的 Pippit AK 录入

## 结论

`@pippit-bridge/opencode-plugin` 是 custom-tool plugin，不是 LLM provider。它不注册 `config.provider.pippit`、`auth.provider` 或空模型目录，也不借用 OpenCode `/connect` credential slot。

Pippit AK 通过一次性 localhost password form 直接进入插件私有账号库：

```text
agent
  -> pippit_manage_access_keys({ operation: "configure", account_name })
  <- http://127.0.0.1:<ephemeral>/enroll/<one-time-token>

browser password form
  -> same-origin POST to loopback plugin server
  -> PippitAccountManager.addAccount(account_name, access_key)
  -> <OpenCode state>/pippit/access-keys.json
```

raw AK 不经过聊天、普通工具参数、OpenCode provider auth store、argv、项目配置或日志。

## 安全约束

- 只监听 IP literal `127.0.0.1` 与随机端口；不监听 `0.0.0.0`。
- token 使用 32 字节随机数的 base64url 编码，短 TTL、单次使用，并限制并发 session 数。
- Host 必须等于实际 loopback origin；POST 的 Origin 必须是同源，`Origin: null` 与外域被拒绝且不消费 token。
- POST 在读取 body 和持久化前先消费 token，避免并发重放。
- 只接受 `application/x-www-form-urlencoded`，字段只能有一个 `access_key`，并限制 Content-Length 与实际读取字节数。
- HTML、响应和错误不回显 token 或 AK；服务端不记录 request body。
- 页面使用 password input、`Cache-Control: no-store`、CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff` 与 `Referrer-Policy: strict-origin`。
- AK 只做稳定格式下限校验：trim 后 1–4096 个可见 ASCII 字符，不硬编码前缀和长度。

`strict-origin` 是有意选择：它让浏览器从 loopback GET 页面提交表单时保留同源 Origin；不能改成会令表单提交出现 `Origin: null` 的策略，也不能为兼容而接受 null origin。

## 私有账号库

账号库路径为 `<OpenCode state>/pippit/access-keys.json`：

- 目录 `0700`，文件 `0600`；
- 同进程 mutex、跨实例 lock、临时文件 fsync 与原子 rename；
- list 只公开账号 ID、名称、脱敏 AK 和 active 状态；
- switch 影响新任务，已绑定的 `run_id + thread_id` 仍使用原账号；
- delete 删除本地 AK，但不替代官网撤销；
- v1 中 `pending_configuration`、`last_seen_auth_marker` 和 auth sentinel 链路只用于兼容读取，并在下一次写入时迁移掉。

账号库是单用户本机明文存储，与 OpenCode 自己的本地 credential 文件处于相同的同 UID 威胁边界。它不是多租户 secret manager，也不做跨机器同步。

## 验收

1. OpenCode 1.18.3 加载插件后的 resolved config 不出现 `provider.pippit` 或等价空 LLM provider。
2. 宿主已配置默认模型时，`session.prompt` 不显式传 model 仍可完成，不出现 `ProviderNoProvidersError`。
3. 三个 custom tools 仍可发现。
4. configure 结果只有 loopback URL 与过期时间，没有 raw AK。
5. 过期、重放、Origin、body-size、容量与 secret 不回显测试保持通过。
