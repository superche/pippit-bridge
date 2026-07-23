# Codex Plugin 开发热更新与正式发布工程

> 状态：Implemented locally; isolated Desktop acceptance passed; external release gated
>
> 审阅日期：2026-07-21
>
> 需求基线：原工作区未跟踪文档 `docs/codex-plugin-dev-release-engineering.md`（964 行）已完整审阅；本文件是进入任务 worktree 的实现版。

## 决策

Plugin 分成两个物理平面：

1. Codex cache 中不可变的稳定 gateway、manifest、`.mcp.json`、Skills 和固定 Widget binding。Skills 由 Codex host 独立扫描，不归 MCP gateway 管理。
2. worktree 构建的 worker generation。candidate 经过 build、tests、MCP/Plugin contract hash、人工 semantic review、behavior/property/idempotency tests 和 health 后才能激活。

同任务只允许发现契约和业务语义兼容的实现变化。tool/schema/description/result semantics、resource URI/MIME/CSP/binding、Skill、manifest、`.mcp.json`、审批/确认/付费/写操作边界都属于 cold contract，必须 immutable release + new task。

禁止依赖 `list_changed`、`forceReloadSkills`、`config/mcpServer/reload`、直接修改 cache 或 symlink 穿透。

## 当前实现

- `scripts/plugin-version.mjs`：以 MCP package version 为机械真源，校验 package、manifest、server/widget marker、consumer dependency 和 lockfile。
- `scripts/plugin-contract.mjs`：从真实 launcher 做 initialize、tools/resources/templates list 和逐 URI read；采集进程移除宿主 `PIPPIT_*` 配置并注入隔离 runtime/output root 与固定非密钥 enrollment 配置，避免开发账号、CI 环境和平台默认值改变 golden；采集结束通过 stdin EOF 等待 launcher 正常 shutdown 后才删除 runtime root，避免 macOS/Windows 清理竞态；合并 manifest、`.mcp.json`、Skill digest 和人工 result semantics，使用 format-v1 canonical JSON 和 SHA-256，CI 失败注解记录异常或每个漂移文件的 expected/actual digest。
- `src/dev-supervisor.ts`：按 contract hash 分 pool；每次 call/read pin generation；N drain 后关闭；cold/未审语义 candidate 拒绝；迁移 epoch 或 storage backward compatibility 不满足时 post-write rollback 返回 `DEV_POST_ACTIVATION_UNSAFE_ROLLBACK`。
- `src/dev-stdio.ts`、`src/dev-gateway.ts`、`src/dev-worker-process.ts`：稳定 Codex-facing stdio 只 initialize 一次并冻结 discovery；长期 child MCP worker 承载 generation 实现。`tools/call` 与动态 `resources/read` pin active generation，candidate 激活不关闭 gateway，不产生 EOF/reinitialize/shutdown。
- `scripts/codex-dev.mjs`：在独立数据根准备可由 Codex `marketplace add` 的 `pippit-bridge-dev` catalog、dev-only gateway bundle、0600 pointer/frozen contract/status，以及强制传给所有 dev worker 的独立 `PIPPIT_BRIDGE_HOME` runtime root；校验 owner/realpath，watch 后串行 staging build/test/contract，要求与 source hash 绑定的人工 `hot-compatible` review，再原子写 active generation。它不修改全局 Codex cache，也不读取 release 账号、job 或 artifact state。
- `src/dev-widget.ts`：固定 dev shell URI/MIME、loopback asset/SSE HMR primitives、capability/Host/Origin 校验，以及旧/新 tool payload 和 confirmation fixture 等价检查。primitives 已本地验证，但尚未接入已安装 plugin 的 `outputTemplate`/gateway 生命周期；当前不能把它表述为已挂载 Codex iframe HMR。
- `release-epoch.ts`：MCP client 自动发送内部 release epoch；Facade 在 route handler 和任何副作用前 fence 显式 stale epoch 为 `PLUGIN_TASK_STALE`。首个无 epoch 历史版本保持兼容一个迁移周期。
- `plugin-contract.yml`：Node 22/24、macOS/Linux gate；contract 预构建显式按 `core -> sdk -> mcp-server -> discovery` 执行（local Facade daemon bundle 对 SDK 有传递依赖），matrix 禁用 fail-fast，避免 clean checkout 被本地 workspace `dist` 掩盖或首个失败取消其余平台证据；Windows 只跑 version/contract/lint/typecheck/build 并明确 `/bin/sh` launcher 不支持 native Windows，不把全量 Windows runtime suite 混入该边界门禁。
- `plugin-release.yml`：手动、受 environment 保护的两阶段流程。clean install/check/pack/direct-extract offline smoke 后 publish；从 registry 重下验证；只有显式选择 activation 才把整个 marketplace source block 换成 exact direct npm 并创建 PR。

## 身份与隔离

正式 identity 保持：

```text
Git source/ref:  superche/pippit-bridge@main
marketplace:     pippit-bridge
plugin:          pippit-video
npm:             @pippit-bridge/mcp-server
```

开发 identity 为 `pippit-video@pippit-bridge-dev`，配置、cache、数据根和任务集合必须与 release profile 物理隔离。仅改 marketplace name 不构成隔离；未经目标 Codex host 实测，dev/release 不得同时 enabled。

## Dev Hot Gate

```bash
npm run codex:dev:bootstrap
npm run codex:dev:profile:setup
npm run codex:dev
npm run codex:dev:app
npm run codex:dev:profile:status
npm run codex:dev:status
npm run check:dev-gateway
npm run codex:dev:full-gate
```

首次接入先执行一次 `codex:dev:profile:setup`，再在独立终端启动 `codex:dev` watcher。
profile setup 在稳定 Dev root 完成 bootstrap，并对 Dev plugin 执行一次冷刷新：卸载
`pippit-video@pippit-bridge-dev`、清空该 identity 在 Dev profile 下的全部版本化 cache、
移除并重加本地 marketplace，最后重新安装 plugin。脚本会比较新 cache 与 gateway bundle
（忽略安装期 `node_modules` 和 `*.tsbuildinfo`）的 SHA-256；不一致时拒绝继续。setup 要求
Dev App 已停止，避免已连接的 host 继续持有旧 manifest、Skill 或 Widget。
完成冷刷新后，本地 marketplace 与
`pippit-video@pippit-bridge-dev` 安装到持久化的独立 Codex profile。默认 `CODEX_HOME` 为
`~/.codex-profiles/dev`；macOS Desktop 的独立浏览器数据目录为
`~/Library/Application Support/Codex Dev`。脚本拒绝复用生产 `~/.codex`、生产 ChatGPT
浏览器数据目录或已安装 `pippit-video@pippit-bridge` 的 profile。路径可分别通过
`PIPPIT_CODEX_DEV_PROFILE_HOME` 和 `PIPPIT_CODEX_DEV_BROWSER_DATA_DIR` 覆盖。

macOS 使用 `npm run codex:dev:app` 执行默认冷启动：先准备新 gateway，停止且只停止使用
Dev browser-data 的 ChatGPT 主进程，执行上述冷刷新，再启动独立 Dev App。这样每次端到端
调试都从当前 cache snapshot 和新 Codex session 开始。只需在已经完成冷刷新的 profile 上
补启动 App 时，可使用 `npm run codex:dev:app:launch`；它不会修改 cache。
启动参数只包含 Dev `CODEX_HOME`、Dev browser-data 和受支持的 Node 路径，不附加 worktree
路径，避免 Electron 把目录错误解析为应用入口。脚本会把当前且符合仓库 `engines` 的 Node 作为
`PIPPIT_NODE_PATH` 传入 Dev App；不支持的 Node（例如 `22.19.0`）会在 bootstrap 前直接失败，
避免冷刷后的 plugin 又落到 GUI App 的旧 Node 环境。
登录和主题由该 profile 自身持久化：首次在 Dev App 内登录并选择主题即可；脚本不读取、复制或提交
`auth.json`、Cookie、浏览器数据等凭据。`codex:dev:profile:status` 只报告登录状态、Dev plugin
identity/version、cache/gateway 哈希、隔离路径与正在运行的 Dev PID。

每次 candidate 必须有 `.pippit-dev/semantic-review.json`：

```json
{
  "classification": "hot-compatible",
  "migrationEpoch": 1,
  "sourceHash": "the exact status candidateSourceHash",
  "storageBackwardCompatible": true
}
```

该文件是本机审阅凭据且被 gitignore。hash 相同只证明声明未变，不能替代语义审阅。watcher 同时监听实现目录和该审阅文件；保存与当前 `candidateSourceHash` 匹配的审阅后会自动重新 staging。

默认开发热路径不会在启动后重复构建和运行整个 MCP suite：bootstrap 完成 build、contract 和 worker health 后直接进入 watch。为避免 macOS `EMFILE` 和不同宿主 watcher 语义，dev loop 使用 500ms metadata snapshot，只覆盖 `src/skills/contracts/assets/.codex-plugin`、launcher/package host 文件和 semantic review，不扫描 `dist/test/node_modules`。源码变化时只同步执行 Vitest related tests，并强制加入 gateway/supervisor/Widget HMR 核心用例；`dist`、`node_modules` 和 `.tsbuildinfo` 不会触发新 candidate。`npm run codex:dev:status` 会记录 `candidateTestMode`、`candidateChangedFiles` 和 `candidateDurationMs`。

全量 MCP 测试仍是 release/CI gate。需要在一次开发切换前同步执行严格模式时，可以设置 `PIPPIT_CODEX_DEV_FULL_TESTS=1` 后运行 `npm run codex:dev`；也可随时执行 `npm run codex:dev:full-gate`。related tests 只缩短 hot loop，不降低 production release gate。

硬验收：

- 慢调用固定在 N；激活后新调用走 N+1；不得 replay。
- build/test/contract/health 失败保留 pre-activation LKG。
- worker crash 不退出稳定 gateway；返回明确可重试性，幂等 ledger 决定是否允许重试。
- gateway protocol、IPC version、pointer/generation realpath、owner/mode、capability 任一不匹配均 fail closed，但已启动 gateway transport 不退出。
- A/B contract hash gateway 并存时 worker pool 隔离。
- N+1 写状态后只有 migration epoch 未变且 storage 双向兼容才能 rollback，否则 fail closed。
- Widget 只有纯呈现或严格行为兼容 UI 才具备 hot 的语义资格；当前 runtime 尚未接入 dev shell，因此 Widget 源码变化仍走 cold rebuild，并且只验收新实例，不承诺已挂载实例 HMR。

本地自动验收 `npm run check:dev-gateway` 从空临时 dev root 完成 build/contract、bootstrap generation、冻结 discovery、生成私有 `.mcp.json`，再按真实 `/bin/sh -> dev-plugin-entry.sh -> stable gateway -> child generation` 路径验证 initialize、16 tools、2 resources、2 templates 和逐 URI read。candidate 在 status 指针切换前还会独立启动、initialize/list 并与 frozen contract 比较；失败不会覆盖 active generation。

## Release Gate

实时审计（2026-07-20）：`origin/main@9cdc8ae` 声明 `0.2.16`，npm 官方 registry 只有 `0.2.13`。本 worktree 已把 canonical catalog 的整个 source block 迁移为官方 registry exact direct npm `0.2.13`，先恢复真实可安装基线；`0.2.16` 保持待发布 candidate。不得在 publish 和 registry re-download 验证前把 marketplace 激活到 `0.2.16`。外部 publish/push/activation 均需用户另行明确授权。

本地 gate：

```bash
npm ci
npm run check:public-lockfile
npm run check:plugin-version
npm run check:plugin-contract
npm run check
npm run check:release-artifact
npm run check:dev-gateway
```

发布使用 Node `^22.22.2 || ^24.15.0 || >=26` 和 npm `12.0.1`。direct npm artifact 不自带 Node。当前 `.mcp.json` 使用 `/bin/sh`; 支持矩阵为 macOS/Linux，Windows native 明确不支持。launcher 可使用 `PIPPIT_NODE_PATH` 或兼容 Node 搜索路径，但不得写成 direct npm 自带 Node。

workflow 顺序不可反转：

```text
clean build/test/pack
  -> direct-extract offline real-launcher smoke
  -> npm publish authorization gate
  -> registry metadata + re-download + install/launcher verification
  -> marketplace activation authorization gate
  -> exact direct npm source PR
```

首次 activation 必须替换整个 source block：

```json
{
  "source": "npm",
  "package": "@pippit-bridge/mcp-server",
  "version": "X.Y.Z",
  "registry": "https://registry.npmjs.org"
}
```

## Host compatibility gate

目标 Codex Desktop/CLI 版本分别验证：

1. N-1 installed cache 执行 `marketplace upgrade` 后是否变为 N。
2. 未变化时仅使用该版本证明过的幂等 `plugin add` fallback；不 remove、不 toggle。
3. clean install 只有一个 N artifact，manifest/serverInfo/Skill/tool/resource digest 同 registry tarball。
4. initialize、tools/list、resources/list、templates/list、逐 URI read；固定 prompt eval 仅作统计信号。
5. 多任务、in-flight read/side effect、worker crash、post-write crash、rollback。
6. 旧任务在 N/N-1 window 内兼容，或在副作用前稳定 `PLUGIN_TASK_STALE`。

Codex 启动时自动检查 Git marketplace 属于当前实现，不是公开 SLA。稳定的立即更新方式是显式 `codex plugin marketplace upgrade pippit-bridge` 后新建任务。

## Rollback

只选择已发布、已验证的不可变版本：

1. 确认旧 artifact 与当前 storage migration epoch 双向兼容。
2. 新 Git commit 将 canonical exact version 指回上一健康版本；不覆盖 npm、不 force-push。
3. upgrade marketplace，检查 cache version/digest，新建任务。
4. 复跑 initialize/list/read、Skill digest、固定 prompt eval、账号/job/artifact 保留验证。

禁止只回退 runtime pin 而保留新版 manifest/Skill/resource。若新版有不可逆 migration，停止自动回滚并人工恢复兼容 generation。

## LLM、resources、Skills 副作用

| Surface | 风险 | 决策 |
| --- | --- | --- |
| handler compatible fix | 结果可改变，但选择/构参不变 | 可 hot，仍需语义审阅 |
| tool/schema/description/result meaning | 旧模型上下文与新实现冲突，可能重复付费/写入 | cold + new task |
| resource URI/MIME/CSP/binding | 宿主不保证 relist/cache refresh | cold + new task |
| Widget pure presentation | 已挂载 iframe 可能缓存，dev shell 尚未接线 | 当前 cold rebuild + 新实例；接线并完成 host proof 后才可 hot |
| Widget mapping/default/validation/confirmation | 改变用户或写操作边界 | cold + new task |
| Skill metadata/body | 旧指令无法从任务上下文删除 | immutable release + new task |
| dynamic resource data | 下一次 read 得到新数据 | 格式/单位/含义稳定时允许 |

## 当前未解除的外部门禁

- npm `0.2.16` 未发布；canonical marketplace 暂时精确指向已发布的 `0.2.13`，不能安全推进到 candidate。
- PR #8 的 feature branch 已推送；未执行 npm publish 或 production marketplace activation。
- 隔离 Codex Desktop profile、backend generation 热切换和图片 Widget 修复已完成人工验收；cache upgrade、固定 prompt eval、N-1 upgrade 和 iframe/CSP 已挂载 HMR 仍需目标宿主证据，在取得证据前不作 SLA 声明。
- dev gateway、worker IPC 与 Widget dev primitives 被 release artifact gate 排除，不进入生产 npm tarball。

## 2026-07-21 本地验证证据

- `npm ci`：217 packages，0 vulnerabilities。
- `npm run check:plugin-version`：`plugin-version 0.2.16 ok`。
- `npm run check:plugin-contract`：MCP hash `b43098cce982d1e137c77db60b044a7253356c0e23e3c7392184acc221b22ad2`；Plugin hash `42f1f71efa764da6221ff3f567608299e86d648570d5ff84c75d93a570a1c597`。
- `npm test`：36 files、294 tests passed，包含 generation pin/drain、worker crash、cold discovery、post-write rollback、release epoch 和 loopback Widget server。
- `npm run check:dev-gateway`：真实 dev bundle 16 tools、2 resources、2 templates，版本 `0.2.16`。
- `npm run check:release-artifact`：production tarball 74 files、654.3 kB；direct-extract launcher smoke 通过；不含 `src`、`dist/dev-*`、watcher、dev origin 或 debug token。
- `npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check`：通过。
