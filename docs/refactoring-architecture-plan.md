# Pippit Bridge 重构技术方案与工作项

> 状态：本地实现与门禁完成，目标宿主已完成 discovery/tool-call 验证；mounted Widget 视觉验收受 macOS 锁屏阻塞，受保护发布等待明确授权（隔离分支 `feat/architecture-refactor-20260721`）
> 设计基线：`origin/main@e022f1117da8a7bef2b80a796fcd9c1a0a556fa9`
> 设计日期：2026-07-21
> 适用范围：`pippit-bridge` 全仓库，重点覆盖 Codex/MCP Widget、Tools、Facade、Local Runtime、安全文件存储与 Dev 热更新工程。

## 1. 结论

采用“基础设施先行、行为等价拆分、冷契约最后切换”的分阶段重构，不进行大爆炸改造。

- PR0–PR4 必须保持生产公开契约、持久化格式和路径不变。
- Widget v15 与 schema 单一真源分别作为独立冷契约阶段，不能合并发布。
- Dev Host、Worker Generation、Local Facade Daemon 必须拥有独立的构建闭包、artifact identity 和生命周期。
- 单用户、本地优先、单写者、私有用户文件和 fail-closed 语义保持不变；不引入数据库、分布式锁、多租户、OAuth 或跨机器协调。
- 正式与 Dev identity、profile、cache、runtime root、credentials、jobs、artifacts 和 task context 继续物理隔离。

当前行为基线：

- `npm run check`：37 个测试文件、302 个测试通过。
- MCP contract hash：`8331e1a3ebf06bc585ed5eb58933751f5d43873811d3971453f1744f77cabdca`。
- Plugin contract hash：`5eef1791a3f756abaed75a17f32b773be285f1d7306c834f1ea33681dd1d3d1f`。
- Dev gateway：16 个生产工具、1 个 Dev preview 工具、2 resources、2 templates。

## 2. 重构目标与非目标

### 2.1 目标

1. 建立“源码闭包 → 构建产物 → 审阅对象 → 实际激活对象”的单一身份链，消除 Dev 热更新假阳性。
2. 将大型源文件沿契约、适配、服务、状态机和基础设施边界拆分，而不是机械按行数切割。
3. 让 MCP JSON Schema、Facade runtime parser 和 OpenAPI 最终由同一契约真源投影。
4. 抽取共享安全文件机制，统一权限、锁、原子替换、耐久性和 stale-lock 恢复，同时保留各领域独立策略。
5. 将 Widget 浏览器状态机恢复为正常 TypeScript 源码，并继续产出 dependency-free 单 HTML。
6. 保持已有 public exports，在迁移期通过兼容门面避免调用方跟随内部文件移动。

### 2.2 非目标

- 不在结构重构中改变工具名、description、input/output schema、result semantics、确认/审批/付费/写操作边界。
- 不在结构重构中改变 Widget URI、MIME、CSP、tool binding 或 Skill。
- 不合并 MCP、OpenCode、BYOK、idempotency 的领域状态文件。
- 不把 OpenCode account store 与 Facade BYOK store 合成一种领域模型。
- 不引入 React/Vue 等浏览器框架。
- 不承诺未接线的 mounted iframe HMR。
- 不在本方案实施过程中执行 `npm publish`、production marketplace activation 或破坏性回滚。

## 3. 目标架构

```text
@pippit-bridge/contracts
  |-- MCP JSON Schema projection
  |-- Facade runtime parsing
  `-- OpenAPI projection

MCP Adapter                 HTTP Adapter
  |-- Tool registry           |-- route contracts
  |-- handlers                |-- auth / parsing
  |-- result encoding         `-- presenters
  `-----------+----------------------+
              v
      Application Services
        |-- generation / edit
        |-- job query / content
        `-- credential selection
              |
       SDK / domain ports
              |
  private-file primitives / stores

Typed Widget source
  -> deterministic browser bundle
  -> dependency-free single HTML asset
  -> frozen Widget resource contract

Immutable Dev Host
  -> hot-swappable Worker Generation
  -> separately managed Local Facade Daemon
```

依赖规则：

- Browser Widget 代码不得 import `node:*`。
- HTTP routes 不得直接访问 SDK、文件系统或具体 store。
- Application services 不得依赖 `FastifyRequest` / `FastifyReply`。
- MCP daemon entry 不得通过相对路径穿透到 `apps/openrouter-facade/src`。
- Dev Host 代码不得进入 Worker artifact；Worker 代码不得修改 Host discovery。
- 共享 private-file 层只统一机制，不拥有 BYOK、account、idempotency 等领域 schema。

## 4. Dev 构建与热更新重构

### 4.1 三平面模型

#### Immutable Dev Host

负责并冻结：

- MCP initialize；
- tools/resources/templates discovery；
- 生产 contract 与 Dev preview overlay 的显式组合；
- manifest、`.mcp.json`、Skills；
- Widget 静态 resource read；
- stable worker IPC client 与 supervisor。

Dev Host artifact 变化时返回 `DEV_HOST_REBOOTSTRAP_REQUIRED`，不得写成 worker activation success。

#### Worker Generation

负责：

- `tools/call`；
- 由 frozen templates 定义的动态 artifact resource read；
- MCP handler、client、Tool runtime 和动态 Widget media 行为。

慢调用固定在 N；激活后新调用进入 N+1；任何调用不得 replay。

#### Local Facade Daemon

Facade daemon 使用独立 artifact hash 和 ready proof。第一阶段只要 daemon artifact 变化，就拒绝伪热激活并要求显式 daemon restart。后续实现：

```text
停止接收新的写调用
  -> drain in-flight
  -> 关闭旧 daemon
  -> 启动候选 daemon
  -> 验证 proof / health / artifact hash
  -> 激活对应 Worker
```

### 4.2 Candidate Manifest

从 esbuild metafile、TypeScript project inputs 和显式冷输入生成 canonical manifest：

```ts
interface CandidateManifest {
  sourceGraphHash: string
  workerArtifactHash: string
  daemonArtifactHash: string
  workerContractHash: string
  hostContractHash: string
  buildRecipeHash: string
  testEvidenceHash: string
  migrationEpoch: number
  storageSchemaEpoch: number
}
```

`semantic-review.json` 必须绑定完整 `subjectHash`：

```text
subjectHash = sha256(canonical({
  baseImplementationHash,
  candidateManifest,
  activationClass
}))
```

不得再只使用 `packages/mcp-server-pippit/src` 的目录 hash。

### 4.3 Desired / Observed 状态

- `desiredGeneration`：controller 已完成 staging 并提交给 gateway。
- `observedGeneration`：gateway 已验证 artifact、contract、review、health 并实际激活。

只有 gateway 可以写入 observed active。Controller 不得提前把 status 标成 active。

### 4.4 Dev contract

- `ProductionWorkerContract`：生产工具与动态能力契约。
- `DevOverlayContract`：Dev-only preview 工具。
- `EffectiveDevHostContract`：两者显式组合后的真实 Codex discovery。

Preview 工具必须直接进入 frozen effective contract；测试不得通过过滤额外工具规避比较。

## 5. MCP Tools 模块化

```text
packages/mcp-server-pippit/src/tools/
  contract.ts
  registry.ts
  context.ts
  runtime.ts
  errors.ts
  results.ts
  facade-mappers.ts
  submission-coordinator.ts
  handlers/
    image.ts
    video.ts
    video-edit.ts
    models.ts
    access-keys.ts
  download/
    path-policy.ts
    writer.ts
```

核心抽象：

```ts
interface ToolSpec<I, O> {
  readonly name: PippitToolName
  readonly capability: "runtime" | "management"
  readonly effects: "read" | "local-write" | "paid-write" | "destructive"
  readonly input: RuntimeContract<I>
  readonly output: RuntimeContract<O>
  execute(context: ToolContext, input: I): Promise<O>
  encode(output: O): PippitMcpCallToolResult
}
```

- `tools.ts` 保留为兼容 re-export。
- Tool dispatch 改为 registry lookup。
- `effects` 是内部激活/回滚语义，不替代公开 annotations。
- 幂等 submission coordinator 与安全 download writer 保持独立安全状态机。

## 6. Facade 模块化

```text
apps/openrouter-facade/src/
  app.ts
  bootstrap/context.ts
  http/
    route-contract.ts
    error-handler.ts
    hooks/
      release-epoch.ts
      lifecycle.ts
    routes/
      system.ts
      models.ts
      byok.ts
      images.ts
      videos.ts
      video-edits.ts
      video-content.ts
  services/
    image-generation.ts
    video-generation.ts
    video-edit.ts
    job-query.ts
    content-proxy.ts
  presenters/
    job-response.ts
    model-response.ts
  openapi/
    generate.ts
    components.ts
```

核心路由契约：

```ts
interface HttpRouteContract<P, Q, B, R> {
  method: HttpMethod
  url: string
  operationId: string
  auth: "none" | "runtime" | "management"
  params?: RuntimeContract<P>
  query?: RuntimeContract<Q>
  body?: RuntimeContract<B>
  responses: Readonly<Record<number, RuntimeContract<R>>>
  cacheControl?: "no-store"
  exposeInOpenApi: boolean
}
```

同一个 route contract 最终驱动 Fastify 注册、输入解析、auth、cache policy 和 OpenAPI。

`local-facade-daemon-entry.mjs` 改为按 workspace package 名导入 Facade，并声明显式构建依赖。构建顺序调整为：

```text
core -> sdk -> openrouter-facade -> mcp-server
```

release artifact 必须验证没有遗留私有 workspace runtime external。

## 7. 安全文件存储原语

```text
packages/core/src/private-file/
  errors.ts
  directory-policy.ts
  bounded-read.ts
  lock.ts
  atomic-replace.ts
  transaction.ts
```

统一的机制：

- `O_NOFOLLOW | O_EXCL`；
- 目录 0700、文件 0600、owner、regular file、`nlink === 1`；
- lock payload 包含 version、PID、instance id、nonce；
- 仅在确认 PID 已死亡且 `dev/ino` 二次匹配时删除 stale lock；
- release 前验证 lock 仍属于当前 owner，不能误删后来者的 lock；
- temporary file fsync → rename → directory fsync；
- rename 后 directory fsync 失败返回 `DURABILITY_UNCERTAIN`；
- secret buffer 在使用后清零；
- 支持 transaction lock 与 lifetime lock 两种策略。

迁移顺序：

1. OpenCode account store，优先解决进程崩溃后的永久 stale lock。
2. BYOK store，保留 AES-256-GCM、AAD、key rotation 与 lifetime lock。
3. idempotency、Widget lineage 和 Local Runtime state 逐个迁移。

不得同时修改领域文件格式、加密 envelope、storage path 或 migration epoch。

## 8. Local Runtime 与 Reference Loader

### 8.1 Local Runtime

```text
packages/mcp-server-pippit/src/local-runtime/
  paths.ts
  private-files.ts
  bootstrap-lock.ts
  secrets.ts
  ready-proof.ts
  daemon.ts
  runtime.ts
```

原 `local-runtime.ts` 保留兼容 re-export。结构拆分不改变 runtime version、schema version、ready proof 或路径。

### 8.2 Reference Loader

```text
packages/core/src/reference-loader/
  contracts.ts
  errors.ts
  url-policy.ts
  ip-policy.ts
  dns-policy.ts
  pinned-transport.ts
  redirect-fetcher.ts
  bounded-body.ts
  media-sniff.ts
  metadata.ts
  deadline.ts
  loader.ts
```

必须保持执行顺序：

```text
parse URL
  -> scheme / userinfo policy
  -> DNS 与私网地址分类
  -> 将已验证 IP 固定到真实 socket
  -> 每次 redirect 重新执行完整检查
  -> status 与流式大小限制
  -> magic bytes 检测
  -> declared MIME / kind / filename 一致性检查
```

## 9. Widget 模块化与 v15 冷切换

```text
packages/mcp-server-pippit/src/widget/
  contract.ts
  result-parser.ts
  state.ts
  controller.ts
  host/
    mcp-app-bridge.ts
    openai-compat.ts
  media/
    preview-loader.ts
    filmstrip.ts
  editor/
    draft.ts
    trim.ts
    roi.ts
    submit.ts
  view/
    dom.ts
    render.ts
    events.ts
  entry.ts
  template.html
  styles.css
```

### 9.1 状态机边界

- `WidgetState + Event + Effect` reducer 不访问 DOM、Timer、Promise 或 Blob URL。
- Controller 执行 tool call、poll、preview renewal、Widget state persistence 和 display mode。
- Renderer 只执行 `state -> DOM`，不得解析 MCP result 或调用工具。
- 每个异步结果携带 `jobId + generationEpoch / previewGeneration`，统一拒绝过期响应。
- PreviewLoader 独占 AbortSignal、Blob URL 和清理责任。
- 浏览器代码只消费服务端投影后的 `structuredContent` 和 `_meta["pippit/media"]`，不能处理私有 `unsigned_urls`。

### 9.2 构建

```text
typed browser-safe modules + markup/styles/script fragments
  -> deterministic template assembly
  -> assets/generated/pippit-video-job-v15.html
  -> canonical asset injected into the bundled launcher
```

构建要求：

- 输出 deterministic，使用 LF；
- 无时间戳、绝对路径、source-map URL；
- 无外部 `script`、`link`、`import`；
- 无新增 CSP domain；
- 最终仍为 dependency-free 单 HTML；
- 生成资产进入 npm artifact 和 Dev generation manifest。

### 9.3 冷切换

- v15 在未注册状态下与 v14 做行为对照。
- 正式切换时 URI 升到 `pippit-video-job-v15.html`。
- v14 加入 legacy URI。
- 更新 tool metadata、resource list、smoke、正式版本和 contract golden。
- 仅验收新的 Widget instance；不得声称 mounted iframe HMR。

状态模型应保留 `failed`、`cancelled`、`expired` 的差异；是否重新展示状态文案属于独立产品变更，不混入结构等价迁移。

## 10. 契约单一真源

新增正式发布的 `@pippit-bridge/contracts`：

```text
packages/contracts/src/
  contract.ts
  primitives/
    identifiers.ts
    http-url.ts
    text.ts
  media/
    references.ts
  generation/
    image.ts
    video.ts
    video-edit.ts
    job.ts
  byok/
    api.ts
  surfaces/
    facade.ts
    mcp.ts
```

采用 Zod 4 作为 runtime parsing 与结构真源：

```ts
interface RuntimeContract<T> {
  readonly schema: z.ZodType<T>
  parse(value: unknown): T
  toJsonSchema(): JsonSchema
}
```

同一契约投影到：

- MCP input/output JSON Schema；
- Facade request/response parser；
- OpenAPI components；
- TypeScript DTO。

不同 surface 不得被错误合并：

- MCP 顶层 `byok_id` / `thread_id` / `idempotency_key`；
- Facade `provider.options.pippit`；
- 仅 HTTP(S) 的引用 URL；
- 允许特定 base64 data URL 的图片输入。

UUID 收紧、default、description 或生成 JSON Schema 的任何差异都属于冷契约变更。

## 11. 分阶段工作项 Checklist

### PR0：行为基线与 Characterization

- [x] 从最新 `origin/main` 创建隔离 worktree 和 feature branch。
- [x] 记录 baseline commit、Node/npm 版本和当前 contract hashes。
- [x] 为 MCP tools 建立完整接受/拒绝输入语料。
- [x] 为 OpenAPI 建立完整 canonical golden，而非只检查少数字段。
- [x] 为 Widget 建立 pending/in_progress/completed/failed/cancelled/expired/dev-preview 场景。
- [x] 为 Widget bridge 建立 standard protocol、legacy fallback、timeout、teardown 场景。
- [x] 为 FilePippitAccountStore 增加进程崩溃和 stale lock characterization。
- [x] 为 BYOK 增加 tamper、wrong key、AAD、key rotation 和 durability fault injection。
- [x] 为 reference loader 增加 redirect 每跳重查、DNS pinning、IPv4/IPv6/mapped 地址测试。
- [x] 确认 `npm run check`、plugin contract、release artifact、dev gateway 全绿。

### PR1：Dev 三平面与产物身份链

- [x] 拆分 `build:dev-host`、`build:worker-generation`、`build:facade-daemon`、`build:plugin-release`。
- [x] 为三个 entry 生成 esbuild metafile 和 canonical source closure。
- [x] 引入 `CandidateManifest`、`subjectHash` 与 review decision hash。
- [x] 将 semantic review 从 `sourceHash` 迁移到完整 `subjectHash`。
- [x] 引入 `desiredGeneration` / `observedGeneration`。
- [x] 只允许 gateway 写 observed active。
- [x] 将 Dev preview 定义为 `DevOverlayContract`。
- [x] 生成并冻结真实 `EffectiveDevHostContract`。
- [x] 冻结 static Widget resource reads；dynamic artifact reads 继续 pin Worker generation。
- [x] 删除 smoke test 中过滤 preview 工具的逻辑。
- [x] Gateway artifact 变化时返回 `DEV_HOST_REBOOTSTRAP_REQUIRED`。
- [x] Daemon artifact 变化时先返回显式 restart-required，禁止伪热更新。
- [x] 验证 gateway 源码变化不会报告 worker activated。
- [x] 验证 Core/SDK/Facade/daemon entry 变化会改变 closure/artifact hash。
- [x] 验证 N 的 review 不能授权 N+1。
- [x] 验证 staging artifact 被篡改或源码在构建期间变化时保留 N。
- [x] 验证慢调用固定 N，新调用进入 N+1，且不 replay。
- [x] 验证新 gateway 进程可从完整审阅绑定的 `phase=active` 状态恢复同一 Worker generation；任一 generation、implementation、subject 或 observed identity 不一致均 fail closed。

### PR2：纯模块移动与兼容门面

- [x] 拆分 `tools.ts`，保留原 public exports 和 schema/parser 行为。
- [x] 拆分 `app.ts` 的纯 helper、presenter 与无状态 service。
- [x] 拆分 `reference-loader.ts`，保持安全检查执行顺序。
- [x] 拆分 `local-runtime.ts`，保持 runtime/version/path/proof 不变。
- [x] 拆分 `stdio.ts` 的工具定义、media runtime 和 server composition。
- [x] 为所有原入口保留小型 compatibility barrel/re-export。
- [x] 增加 forbidden-import / architecture boundary 检查。
- [x] 确认 MCP/Plugin contract hash 与基线完全一致。
- [x] 确认 OpenAPI canonical golden 完全一致。
- [x] 确认旧 public exports 和类型签名不变。

### PR3：共享 Private File 原语

- [x] 实现 private directory policy。
- [x] 实现 bounded no-follow read。
- [x] 实现 owned lock payload、PID/instance/nonce 和 inode-safe release。
- [x] 实现死 owner stale-lock 安全恢复。
- [x] 实现 atomic replace 与 directory fsync。
- [x] 实现 `DURABILITY_UNCERTAIN`。
- [x] 支持 transaction lock 和 lifetime lock。
- [x] 首先迁移 OpenCode account store。
- [x] 验证进程崩溃后 account store 可安全恢复写入。
- [x] 拆分并迁移 BYOK repository/codec，但不改变 encryption envelope。
- [x] 验证临时文件和最终文件均不包含明文 AK。
- [x] 迁移 idempotency store。
- [x] 迁移 Widget lineage 和 Local Runtime state 的通用文件机制。
- [x] 验证 symlink/hardlink、owner、mode、nlink、inode replacement 攻击均 fail closed。
- [x] 确认 storage schema、path 和 migration epoch 不变。

### PR4：Facade Routes / Services / Build Graph

- [x] 将 `app.ts` 收敛为 composition root。
- [x] 拆分 system/models/BYOK/images/videos/edits/content routes。
- [x] 拆分 generation/edit/query/content services。
- [x] 确保 services 不依赖 Fastify types。
- [x] 引入 presenters，集中 job/model HTTP projection。
- [x] 引入 route contract，但暂时保持现有 runtime schemas 与 OpenAPI 输出。
- [x] 将 daemon entry 改为 workspace package import。
- [x] 声明显式 Facade 构建依赖。
- [x] 调整 clean build DAG 为 core → sdk → facade → mcp。
- [x] 使用 esbuild metafile 验证发布 artifact 无私有 runtime external。
- [x] 验证所有 route、auth、status、cache policy 和旧 OpenAPI 一致。
- [x] 确认 MCP/Plugin contract hash 与基线完全一致。

### PR5：模块化 Widget v15

- [x] 抽取浏览器安全的 contract/result parser。
- [x] 实现 `WidgetState + Event + Effect` reducer。
- [x] 实现 controller 和统一 epoch fencing。
- [x] 实现标准 MCP App bridge。
- [x] 实现 `window.openai` compatibility adapter。
- [x] 实现 PreviewLoader、Blob URL lease、abort 和 teardown。
- [x] 迁移 polling、latest resolution、preview renewal 和 fallback。
- [x] 迁移 draft、trim、ROI、annotation 和 submit。
- [x] 实现纯 renderer 和 DOM event adapter。
- [x] 建立 deterministic single-HTML build。
- [x] 验证浏览器 bundle 无 Node import、external import、绝对路径或额外 CSP 域。
- [x] v15 未注册状态下与 v14 做状态场景行为对照。
- [x] 用 DOM/协议测试替换大部分 `toContain()`/源码切片断言。
- [x] 验证两次 clean build 的 Widget HTML SHA 完全一致。
- [x] 将 URI 升级为 v15，并把 v14 加入 legacy URI。
- [x] 使用正式版本同步命令更新所有机械版本标记。
- [x] 有意重生成并审阅 plugin contract golden。
- [x] 在刷新后的隔离 Dev profile 中执行新 Codex task，并验证真实 MCP tool call。
- [ ] 在已解锁的 Codex Desktop 中完成新 Widget instance 的 mounted iframe 视觉/交互验收。
- [x] 明确记录不支持 mounted iframe HMR。

### PR6：Contracts 与 OpenAPI 单一真源

- [x] 创建可正式发布的 `@pippit-bridge/contracts` workspace package。
- [x] 实现 `RuntimeContract<T>` 和 Zod → JSON Schema projection。
- [x] 迁移共享 primitive、media、generation、BYOK contracts。
- [x] 保留 MCP 与 Facade 的独立 surface mapping。
- [x] 让 MCP definitions 与 runtime parse 使用同一 contract。
- [x] 让 Facade routes 使用同一 runtime contract。
- [x] 从 route contracts 自动生成 OpenAPI path/security/request/response。
- [x] 保留完整 OpenAPI golden，并人工审阅 diff。
- [x] 验证每个注册 HTTP route 恰好对应一个 route contract。
- [x] 验证所有 `operationId` 唯一。
- [x] 对全部 MCP schema 与 runtime parser 运行同一接受/拒绝语料。
- [x] 显式归一化默认值，不依赖宿主自动应用 schema default。
- [x] 将 UUID 收紧等行为变化单独列出，不伪装成纯重构。
- [ ] 按依赖顺序发布 contracts 与消费包；不得留下不可公开访问的 runtime dependency。
- [x] 有意更新 contract golden、版本和新任务兼容边界。

### 最终收口

- [x] `widget.ts` 收敛为不超过约 100 行的兼容门面。
- [x] `tools.ts` 收敛为不超过约 100 行的兼容门面。
- [x] `app.ts` 收敛为不超过约 150 行的 composition root。
- [x] `local-runtime.ts` 收敛为不超过约 100 行的兼容门面。
- [x] 普通生产模块原则上控制在 400–500 行内；generated/golden/fixture 不计。
- [x] 无新增循环依赖和禁止方向 import。
- [x] 所有 secret、URL userinfo、Access Key、上游 body 和底层 cause 均不会泄露到用户错误或日志。
- [x] `npm run check:public-lockfile` 通过。
- [x] `npm run check:plugin-version` 通过。
- [x] `npm run check:plugin-contract` 通过。
- [x] `npm run check` 通过。
- [x] `npm run check:release-artifact` 通过。
- [x] `npm run check:dev-gateway` 通过。
- [x] clean install/build/test/pack 通过。
- [x] direct-extract offline launcher smoke 通过。
- [x] 使用隔离 Dev profile 中的真实 BYOK 账号完成一次最小图片生成、轮询、落盘和 `resources/read` 冒烟。
- [x] 记录 exact commands、测试数、contract hashes、tarball 内容和真实 launcher evidence。
- [x] 分离记录本地验证、目标 Codex host evidence 和仍未证明的实现细节。
- [x] 未经用户明确授权，不执行 npm publish、production marketplace activation、push 或 destructive rollback。

### 11.1 当前实施证据与未完成边界

- 最终证据命令：`npm ci`；`npm run check:public-lockfile`；`npm run check:plugin-version`；
  `npm run generate:plugin-contract`；`npm run check:plugin-contract`；`npm run check`；
  `npm run check:release-artifact`；`npm run check:dev-gateway`；`npm run codex:dev:full-gate`；
  `npm run codex:dev:profile:setup`；`npm run codex:dev:app`；`npm run codex:dev:status`；
  `CODEX_HOME=/Users/bytedance/.codex-profiles/dev codex -a never exec --json -s read-only -C <worktree> <preview-prompt>`；
  `shasum -a 256 packages/mcp-server-pippit/assets/generated/pippit-video-job-v15.html`；
  `npm view @pippit-bridge/contracts@0.1.0 version --json --registry=https://registry.npmjs.org`。
- 隔离实现基线：`origin/main@e022f1117da8a7bef2b80a796fcd9c1a0a556fa9`；分支
  `feat/architecture-refactor-20260721`。
- 工具链：Node `24.18.0`、npm `11.16.0`；`npm ci` 新增 `218` 个 packages、审计 `226` 个
  packages，`0` vulnerabilities。
- PR0 基线：`37` 个测试文件、`302` 个测试；MCP hash
  `8331e1a3ebf06bc585ed5eb58933751f5d43873811d3971453f1744f77cabdca`；Plugin hash
  `5eef1791a3f756abaed75a17f32b773be285f1d7306c834f1ea33681dd1d3d1f`。
- Widget v15 / plugin `0.2.17` 的 PR5 冷切换 golden：MCP hash
  `6549117432a14670ec4c168b49b14721d959600a557b922063c9c9784d33a10c`；Plugin hash
  `e8d132d036a64a1e2e8992b693c362906895e114b123d8d0c1468119f64a2ab2`。相对 PR0，显式冷差异为
  plugin/version、v14 → v15 resource URI、两份生成 Widget read 内容及 resources 集合 hash；tool names、templates
  和 result semantics 未改变。
- PR6 单一契约真源后的最终 golden：MCP hash
  `484bbf303fa466fe5f1e00c88cb62edf5eab6443c67b318a11830fd06ec26ed7`；Plugin contract hash
  `bf81d8a8b770a9f74c446769d4d5d59b3e7005b7958c82b97069d0053bd2479c`。相对 PR5，只有 v15
  `reads[1].sha256` 与 5 个 Widget 工具 schema 的聚合 hash 变化；工具名、resource URI、templates 与 result
  semantics 均未改变。schema 差异来自共享 runtime contract 对既有 UUID/min/max 接受边界的显式投影，已作为冷变更审阅，未用 golden 掩盖回归。
- Dev artifact identity 最近一次本地 build：Host artifact
  `d01fc957cb8bb723f03f383395caa6fe4bfeff530500b59b4caef153ae4a6a0a` / source graph
  `3d9052e7d06b7250603c62032c4954b61d264175e74de06e481a003da23d3580`；Daemon artifact
  `6aa574529ac4435b5678eb45954e673b0a2862e98ba0e3e939e9a35d0907726b` / source graph
  `18600cab835c01d96a3e27e28690ea397dbcaa6c084d26c59615d269c95b1aa9`；Worker artifact
  `7d3537960cee29acd00e59c5ce28e8453fc1ee0390006e890bd8d3c009f6d534` / source graph
  `05b12f996e1e2dd4850468e94d730bbad3e5b7a81253b4a2d09b515bc2ab1cc9`。Worker source graph 显式
  绑定 canonical Widget asset 与全部 typed Widget source。
- Dev gateway 本地 smoke：`16` 个 production tools、`1` 个 Dev overlay tool、`2` resources、
  `2` templates。该证据不是目标 Codex host 验收。
- 最终全量 gate：`52` 个测试文件、`361` 个测试；lint、所有 workspace typecheck/build、architecture
  boundary 全部通过。Widget v15 canonical HTML asset 为 `114844` bytes，SHA-256
  `9a5dae913ef49c263d45ed695082114d5ace36df57f6d8507d22e639ab53ad72`；真实 launcher 的 frozen
  `resources/read` SHA-256 为 `481ab6afdc317ae20189d1ecf939e50a98880524efcfbec46841a957b051bf4a`。
  Widget 生成器相同内容不再写盘，连续构建保持
  `mtimeNs` 不变，Dev watcher 不再被自己的生成产物无限触发。
- `npm run codex:dev:full-gate`：MCP `21` 个测试文件、`145` 个测试，contract 与 Dev gateway
  再次通过；OpenAPI canonical golden SHA-256 为
  `54f2b9d749e1db3205b76142e2d30b68d2be5d87382f55e6facccb5697d0e6a5`，Skill 文件 SHA-256 为
  `30f5f63fa6d3261c924dc5e9fb4ec2dfddd9b7b732a21b72c7f1c8d914785224`。
- `npm pack`：`pippit-bridge-mcp-server-0.2.17.tgz`，`249` files，package size
  `859.7 kB`，unpacked `4.5 MB`，shasum `4a7840c32d2e267e9fff58ca7b4ad7b4e6d8236e`；
  direct-extract offline launcher smoke 与 clean-installed `pippit-mcp` bin smoke 均返回
  `server_version=0.2.17`、`tool_count=16`、`widget_resource=true`、`account_count=0`。
- 发布依赖 tarball：contracts `0.1.0` 为 `53` files / `18.2 kB` / shasum
  `2f6f50e1c17901698c260161440e9935a7911146`；core `0.1.1` 为 `97` files / `52.5 kB` /
  shasum `e1b84a11d9da53e81f30be39ef2079f3563a8991`。受保护 workflow 已固定
  contracts → core → MCP 的 pack/publish/re-download/extracted diff/install/import/launcher 顺序，并显式运行
  `check:dev-gateway`。
- 最终 artifact/launcher gate 固定使用受支持的 Node `24.18.0`；系统 Node `22.19.0` 会按 launcher
  contract 明确拒绝，不属于 EOF 或 shutdown 回归。
- 冷契约边界：BYOK path/selection id 现由共享 contract 强制标准 UUID；Widget URI 从 v14 升至 v15；
  OpenAPI request body 从同一 runtime contract 投影。上述差异均独立更新版本/golden，不属于 PR1–PR4
  的行为等价阶段。
- Private-file 攻击矩阵：真实 descriptor/stat 路径覆盖 symlink、hardlink/`nlink`、0644 mode、
  期望 UID 与真实文件 UID 不匹配，以及 release/remove 时 inode replacement；全部 fail closed。
- 真实 AK 冒烟：隔离 Dev runtime 只读取脱敏 active label `ak-****C-i8`，模型发现返回
  `pippit/seedream-5.0` 与 `pippit/seedream-5.0-pro`。随后仅提交一次
  `pippit/seedream-5.0` / `n=1` 图片任务 `pimg_873c54a2594a44e9afb402949312b9ef`，轮询同一 job 至完成；
  生成 `1` 个 `2048 × 2048` `image/jpeg`、`122811` bytes，文件 SHA-256
  `7d7cc6a630bbb70d4f566372f63f242c885dedf0e54b6ab159b19c8895c910bb`，artifact URI
  `pippit-image://artifact/3270f662a02c9de6d1dfbccd11106c77e390e177a9e8c4250d7814aa5a31e05f.jpg`，
  `usage.is_byok=true`、`usage.cost=null`；本地只读解码与视觉检查确认结果为白底居中红色圆形且无文字。
  未打印或复制 raw AK、上游 URL、Facade key 或绝对路径。
- 该真实调用发现并修复了 gateway restart recovery 缺口：原实现只在 `phase=desired` 启动 Worker，导致新的
  gateway 进程面对已持久化的 `phase=active` 时生产工具返回 `DEV_SUPERVISOR_UNAVAILABLE`，而 Host overlay preview
  不会暴露此问题。现在仅当 active/desired/observed generation、base/active implementation hash、subject/review、
  staging artifact 与 frozen contract 全部一致时恢复；修复后的全新 stdio gateway 成功返回同一脱敏 active 账号。
- 目标 Codex host 局部证据：`npm run codex:dev:profile:setup` 刷新后，独立 Dev profile 已安装并启用
  `pippit-video@pippit-bridge-dev@0.2.17`；最终 bundle 的新 Codex CLI task
  `019f85c9-1ac4-7890-8162-40a45cfbf421` 成功发现并调用
  `pippit_dev_preview_error_widget`，返回 `pippit_dev_preview=error`。CLI 不渲染 iframe；macOS 当前处于锁屏，
  因而尚未完成 Desktop 新 task 的 mounted Widget v15 视觉/交互验收，不能声称目标宿主完成或 mounted iframe HMR。
  调用后 Dev status 为 `phase=active`，`desiredGeneration=observedGeneration=activeGeneration`
  `bootstrap-7d3537960cee`，并报告 `activeImplementationHash=7d3537960cee29acd00e59c5ce28e8453fc1ee0390006e890bd8d3c009f6d534`。
- Active-recovery 修复完成冷 Host 刷新与 Codex Dev 重启后，新 Codex CLI task
  `019f87b0-6c6a-7203-bd8f-f0a093a32e04` 在新的 gateway 进程中成功调用 `pippit_list_access_keys`，
  返回 `ak-****C-i8 active=true`；这证明目标宿主不再只支持 Host overlay，而能从持久化 active generation
  恢复真实生产工具调用。该任务只读、未产生额外生成或计费。
- 发布边界：2026-07-22 只读查询显示 `@pippit-bridge/contracts@0.1.0`、
  `@pippit-bridge/core@0.1.1`、`@pippit-bridge/sdk@0.1.1`、
  `@pippit-bridge/mcp-server@0.2.17` 均未占用。未经授权不得 publish，因此 contracts/core/MCP 的
  官方 registry 依赖顺序尚未实际闭环；SDK 不属于 MCP runtime dependency graph，若单独发布需独立 release gate。
- 明确未执行：mounted iframe HMR 声明、npm publish、production marketplace activation、push、PR
  或 destructive rollback。

## 12. 回滚策略

- PR0–PR4 不修改持久化 schema；回滚仅需回退代码 artifact，不做数据迁移。
- Store 迁移按单一实现逐个切换，每个 store 保留旧实现的 characterization fixtures，不能一次切换全部 store。
- Widget v15 保留 v14 legacy resource reader；回滚 catalog/version 时不得混用新版 manifest、Skill 或 Widget binding。
- Contracts 冷发布按依赖顺序发布；任一 consumer gate 失败都不得激活 production marketplace。
- Daemon 协调切换未完成前，artifact 变化必须 fail closed，不能通过继续复用旧 daemon 假装成功。
- 任何不可逆 storage migration 必须提升 migration/storage epoch，并禁止自动 rollback。

## 13. 每阶段统一完成定义

一个阶段只有同时满足以下条件才可勾选完成：

1. 代码边界与本阶段目标一致，没有把下一阶段的行为变化顺带带入。
2. 本阶段 checklist 全部完成或明确记录外部 blocker。
3. 相关单测、集成测试、contract、build 和 artifact gate 全绿。
4. dirty diff 已审阅，不包含用户无关文件、凭据、缓存或生成垃圾。
5. 对 contract、storage、Widget URI、Dev Host identity 的任何变化都已按 cold/hot 规则分类。
6. 文档 checklist 与实际验证证据同步更新。
7. 没有把“实现存在”描述成“目标宿主已验收”。
