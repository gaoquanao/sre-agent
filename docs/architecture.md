# SRE Agent 架构说明

> 面向 SRE 巡检与告警处置的 Agent 平台。Web 端是唯一的功能载体，桌面端（Electron）只做套壳与后端进程托管；Pi 与 DeepSeek Harness 是**可插拔的 agent 内核**，两者都保留各自原生的插件扩展能力。

## 1. 目标与边界

**做**：巡检（定时 + 手动）、告警接入与自动分诊、对话式排障、技能（skills）自定义、MCP 自定义、模型/Provider 管理、权限控制与人工审批、知识库检索、全链路审计。

**不做**（v1 明确排除）：多租户与账号体系、集群化部署、工单/值班系统对接、主动变更类操作（所有变更类命令都必须人工审批，且无人值守场景直接拒绝）。

## 2. 内核可插拔模型

```
Web UI ──HTTP/WS──► 平台服务（Node/TS）
                        │
                        ├── KernelAdapter 接口 ──► Pi 适配器（进程内 SDK）
                        └──                     └► DeepSeek Harness 适配器（子进程 + 桥接插件）
```

`KernelAdapter`（`packages/server/src/kernels/types.ts`）只描述能力，不含任何内核私有细节：

| 方法 | 作用 |
| --- | --- |
| `start / stop / health` | 生命周期与健康上报（内核状态直接进 UI） |
| `openSession / closeSession` | 建立内核侧会话（平台会话 id 即内核会话 id） |
| `prompt / abort / setModel` | 驱动一轮对话、取消、切模型 |
| `syncSkills / syncMcpServers / syncProviders` | 把平台管理的配置下发到内核 |
| `listKernelSessions` | 读取内核侧落盘会话，用于恢复/审计 |

两个内核的能力差异如实暴露给 UI（`/api/kernels` 的 `capabilities`），不做虚假的统一：

| 能力 | Pi | DeepSeek Harness | Claude Code CLI | Codex CLI | Qoder CLI |
| --- | --- | --- | --- | --- | --- |
| 运行方式 | 进程内嵌入 | 子进程（`--profile sre-agent`） | 每轮 `claude -p` 进程 | 每轮 `codex exec --json` 进程 | 每轮 `qoder` 进程 |
| 原生审批服务 | 无（由平台补） | 有（`approval/request`），但 sdk profile 无应答者 → 必须自带应答插件 | 无（CLI 自身权限参数） | 无（CLI 自身 sandbox 参数） | 无 |
| **平台审批门** | ✅ 逐调用拦截 | ✅ 逐调用拦截 | ❌ 工具在 CLI 进程内执行 | ❌ 同左 | ❌ 同左 |
| 工具注册 | `extension.registerTool` | `ctx.tools.register` | ❌（CLI 自管） | ❌ | ❌ |
| 技能下发 | 平台目录 + `additionalSkillPaths` | 平台目录 + `customSkillDirs` | ❌（CLI 自管） | ❌ | ❌ |
| MCP 下发 | 写 `<agentDir>/mcp.json` | profile 补丁插入 `dsh-mcp-client` 行 | ❌（CLI 自管 mcp 配置） | ❌ | ❌ |
| 模型切换 | `session.setModel()`（运行期） | `agent/request` 瀑布 → 平台按会话下发 | 每轮 `--model` | 每轮 `-m` | ❌ |
| 取消一轮对话 | `session.abort()` | sdk 线协议不支持（如实提示） | kill 子进程（可行） | kill 子进程（可行） | kill 子进程（可行） |
| 会话续接 | 平台 JSONL | 平台 JSONL | `--resume <kernelSessionId>` | `exec resume <id>`（真实 CLI 验证） | 回放历史（最近 8 条） |
| token 级流式 | 原生 | 桥接插件转发 | ❌（消息级） | ❌（消息级） | ❌（整轮文本） |

### 2.1 Pi 集成要点（已实测）

- 隔离：`agentDir` 指向 `<platform-home>/kernels/pi`，`auth.json`/`models.json`/`mcp.json`/会话全部落在平台目录，**不碰用户 `~/.pi`**。
- 工具面：`excludeTools: ['bash','edit','write','powershell']` 关掉自带高危工具，命令执行统一走平台受审计的 `sre_shell`；`noTools:'builtin'` 会把扩展工具一起清空，**不能**用。
- 权限门：扩展 `pi.on('tool_call')` 返回 `{block:true, reason}`。实测**被拒的工具确实不会执行**，且嵌套（codemode）调用同样过门。
- 技能：`noSkills: true` + `additionalSkillPaths: [<platform>/skills]`，只吃平台目录。
- Provider：写 `models.json` 后必须让 `ModelRuntime` 重建（它只在构造时读一次）；**不要用 `registerProvider`** —— 它会把 pi 组合出的模型默认项（`input`/`cost`/`contextWindow`）替换掉，导致模型调用静默返回空消息。密钥用 `setRuntimeApiKey`，且每个新 runtime 都要补发（密钥是 runtime 作用域）。

### 2.2 DeepSeek Harness 集成要点（已实测）

- 隔离：`DSH_HOME` 指向平台目录；`DSH_PERMISSION_MODE=workspace-write`（保持审批策略为 `ask`，不能设 `danger-full-access`，那会让策略变 `never` 而绕过平台）。
- 线协议：`dsh --profile sre-agent` 的 stdio 行式 JSON-RPC，只有 `initialize` / `session/prompt` / `shutdown` + `session.event` 等通知；一次 prompt 立即返回入队凭据，内容靠通知流。
- profile：平台生成 `profiles/sre-agent/{package.json, cordis.patch.yml}`，把桥接插件装进 profile 的 `node_modules`（**复制而非符号链接**：dsh 的解析层只对真正位于 profile 内的插件生效；直连仓库路径会解析到第二份内核包，而 `dsh-tools` 的调度句柄是模块级 Symbol，重复实例会让**每次工具派发**失败于 `Cannot read properties of undefined (reading 'prepare')`）。
- 审批：桥接插件在 `tools/pre-execute` 里回调平台 `/internal/tool-verdict`，平台完成策略判定 + 人工审批后返回 `allow/deny`。该瀑布**支持长时间等待**（实测 25s 在环通过），插件自带超时并观察 `exec.signal`，**失败一律拒绝**（fail-closed）。
- 版本地狱：`@deepseek-ai/dsh` 家族在 npm 上同时存在 `0.0.1-rc.x` 与 `0.2.0-rc.2` 两代同名包，mix 安装会被提升出**重复实例**。根 `package.json` 的 `overrides` 把相关包全部钉到 `0.2.0-rc.2`，并需一次干净安装（删 `node_modules` + `package-lock.json`）才会真正去重。

### 2.3 CLI 内核（Claude Code / Codex / Qoder）

三个外部 agent CLI 由同一个 `CliKernelAdapter`（`kernels/cli.ts`）驱动，每个 CLI 一个 profile：`buildTurn`（把 prompt、权限预设、模型、续接参数翻译成命令行）+ `parseLine`（把 CLI 的输出格式翻译成平台事件）。要点：

- **权限语义的差异是结构性的，不隐瞒**：CLI 内核的工具在自己进程内执行，平台逐调用审批门（`platformApprovalGate: false`）不适用。平台的约束手段是：把权限预设映射为 CLI 自身的参数（claude：`--permission-mode plan/default/bypassPermissions`；codex：`--sandbox read-only/workspace-write/danger-full-access`）、凭证托管（撤销凭证即断其能力）、以及 kill 子进程取消当前轮。UI 在内核卡片上对这三者显示醒目警告。
- **会话续接**：claude 支持原生 `--resume <session_id>`；codex 支持 `exec resume <id> --json`（其 resume 子命令不带 `--sandbox`——续接沿用原会话的沙箱策略，这一点经本机真实 CLI 0.160.0 的 help 验证）；qoder 无已知续接手段，采用"回放模式"（把最近 8 条对话历史拼进下一轮 prompt，且不包含本轮消息避免重复）。
- **解析器防御性设计**：claude 的 stream-json 与 codex 的 JSONL 按 2026-10 的公开文档形态解析（未知行忽略、字段缺失容忍、`result` 与 assistant 块的重复文本去重）；qoder 的 headless 协议无公开文档，v1 以"整轮 stdout 即回答"兜底，profile 标注 experimental，npm 包名默认 `qodercli`（可用 `SRE_AGENT_QODER_PKG` 覆盖）。接真实 CLI 后如有出入，只需改对应 profile 的 `parseLine`。
- **凭证注入**：spawn 时把凭证托管中该内核的密钥注入环境（claude：`CLAUDE_CODE_OAUTH_TOKEN`；codex：`OPENAI_API_KEY`；qoder：`QODER_API_KEY`/`QODER_OAUTH_TOKEN`/自定义 env），并把平台安装的 CLI 目录前置到 PATH。

### 2.4 CLI 预装与凭证托管

- **CLI 管理**（`climan.ts`）：探测 5 个 agent CLI（pi/dsh/claude/codex/qoder：是否安装、版本、来源）；"安装"把 npm 包装进平台自有前缀 `<home>/tools`（不污染全局 npm），内核子进程的 PATH 会前置该目录的 `.bin`。接口：`GET /api/clis`、`POST /api/clis/:name/install`。
- **凭证托管**（`vault.ts`）：所有密钥/OAuth token 以 **AES-256-GCM** 加密落盘在平台目录（密钥 = scrypt(`SRE_AGENT_SECRET` + home)，盐存 settings；不设 secret 时回退 home 派生密钥并告警）。接口只返回**脱敏值**（`OAuth claud…3456`），原文只在 `envFor()` 注入内核时短暂解密。支持三种形态：OAuth token（含 refresh）、API key、自定义 env 集。**本机导入**：一键读取已登录 CLI 的凭证文件（`~/.claude/.credentials.json`、`~/.codex/auth.json`）收进托管，之后平台副本为准。注意：token 刷新（refresh token 换新）v1 未实现——过期后需重新导入或手填。

### 2.5 子任务拆分（sre_delegate）与意图确认（ask_user）

两者都是**平台级工具**（`tools.ts`），因此对全部 5 个内核一致生效（CLI 内核在 prompt 指引下同样可以调用平台工具——前提是把平台工具经各自 MCP 暴露给它们，v1 未做，见"已知限制"）：

- **`sre_delegate`**：把一个自包含子目标交给新建的子会话执行（独立上下文、受限工具集、审批仍路由给操作者），阻塞等待其结论后作为工具结果返回给父会话。深度上限 1 层（子会话再委派直接拒绝）；无人值守来源拒绝；子会话在 UI 上带「子任务」标记（`SessionInfo.parentSessionId`）。
- **`ask_user`**：意图有歧义且选错代价高时（动哪个环境、追哪个根因、是否执行危险操作），agent 用它向操作者提结构化问题（问题 + 2-4 个选项 + 自定义回答），复用审批通道阻塞等待；操作者的回答原文回到模型。无人值守来源直接拒绝（没人可问，agent 必须自行决策并记录理由）。dsh 内核另有原生 subagent 能力（`subagent.started/finished` 通知已在 UI 透出），与平台级委派互补。

## 3. 权限模型（单一裁决点）

两个内核共用同一个裁决函数 `evaluateToolCall`（`kernels/verdict.ts`），因此**换内核不改变安全语义**：

```
工具调用 → 风险分级（annotations 优先，名称启发式兜底）
        → 运行范围 allowlist（巡检/告警会话）→ 显式规则（按优先级）→ 权限预设
        → allow / deny / ask
ask → 创建待审批记录（含参数、风险、来源）→ 推送到 UI → 人工裁决
     → allowed-once / allowed-session 才放行；超时、拒绝、取消、平台不可达一律 deny
```

- **预设**：`read-only`（只读放行，其余拒绝）、`workspace-write`（低危放行，其余询问，默认）、`full-access`（全放行）。
- **无人值守**（`schedule` / `alert` 来源）**永不出询问**：不在 runbook `allowedTools` 内的工具直接拒绝，避免无人应答时挂死。
- **审计**：`approval.request` / `approval.decide` / `tool.shell` 等均落库，`/api/audit` 可查，谁在什么上下文批准了什么一目了然。

## 4. 平台服务

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 会话 | `sessions.ts` | 平台会话是真相源；内核会话 id 与之对齐，便于恢复与审计 |
| 平台工具 | `tools.ts` | `kb_search` / `sre_http_probe` / `sre_shell` / `sre_runbook_run` / `sre_incident_note`，两个内核共用同一实现 |
| 知识库 | `knowledge.ts` | `node:sqlite` + FTS5（trigram，中英文与子串命中）；可选向量检索（配置 embedder 后混排） |
| 巡检 | `runbooks.ts` | 先跑确定性检查（http/shell/tcp），再把结果交给 agent 分析；产出结构化 `RunRecord` 与 Markdown 报告 |
| 定时 | `scheduler.ts` | `croner` 进程内调度；上次未跑完则跳过本次，避免堆积 |
| 告警 | `alerts.ts` | webhook 归一化 + 按 fingerprint 去重 + 自动分诊（可指定 runbook，否则用只读工具范围开一个会话） |
| 权限 | `permission.ts` | 策略引擎 + 审批服务（含超时清理、关停时取消所有挂起审批） |
| 存储 | `db.ts` / `store.ts` | 单文件 SQLite，零原生依赖 |

## 5. 接口

- **REST**：`/api/*`（会话、审批、技能、MCP、Provider、权限、知识库、巡检、定时、告警、审计、内核、日志）。
- **WS** `/ws`：`kernel_event`（归一化事件：增量、工具调用/结果、状态）、`approval_requested/resolved`、`session_updated`、`run_updated`、`alert_received`、`log` 等。
- **Internal**（仅回环 + Bearer token，供 dsh 桥接插件回调）：`/internal/kernel-tools`（下发 dsh 方言的工具定义）、`/internal/tool-verdict`（审批裁决）、`/internal/tools/execute`（工具执行）、`/internal/events`（增量回传）、`/internal/model-override`（按会话切模型）。
- **就绪契约**：进程启动完成后在 stdout 打印 `SRE_AGENT_READY <url> kernel=<id> home=<dir>`，桌面端以此行为准（带 30s 超时与失败提示）。

## 6. 部署形态（沙箱演进见 docs/sandbox-providers.md）

- **Web 优先**：`packages/web/dist` 存在时后端直接托管静态站点，浏览器访问 `http://127.0.0.1:8787` 即用。
- **Electron 套壳**（`packages/desktop`）：`SRE_AGENT_HOME` 指向 `userData`，负责启停后端子进程、崩溃自动重启（退避 + 次数上限）、优雅退出（SIGTERM → 超时 SIGKILL，三重保险防孤儿进程）、单实例锁、外链走系统浏览器。主进程是 ESM 但**不能有顶层 `await`**（Electron 只在主模块求值完成后发 `ready`，顶层 await 会死锁）。

## 7. 已验证事实（可复现）

```
npm test                    # 51 个用例全绿：单测 + 5 个内核的端到端链路（含审批门）+ 记忆/工作流/智能体/沙箱
npm run build               # protocol → server → web 全量构建
node packages/server/dist/index.js   # 打印 SRE_AGENT_READY 后对外服务
```

端到端覆盖（均使用本机 mock LLM，无需任何 API key）：

- **Pi**：真实 HTTP + WS + 会话；prompt → 模型产出工具调用 → **审批前工具未执行**（断言）→ 人工批准 → 真实执行 `sre_shell` → 结果回灌模型 → 最终结论；WS 上收到 `tool_call` / `assistant_delta`（≥2 段增量）/ `tool_result`；审计含 `approval.request` / `approval.decide` / `tool.shell`。
- **Pi（无人值守）**：`schedule` 来源会话调用范围外工具 → 立即拒绝并给出范围原因，**不产生待审批**。
- **Pi（后注册 Provider）**：内核启动后再经 API 添加 Provider → 新会话立即可用；无 Provider 时给出明确提示而非静默空转。
- **DeepSeek Harness**：生成 profile → 装载桥接插件 → 子进程启动 → prompt → 模型产出工具调用 → **插件回调平台** → 平台挂起等待人工审批 → 批准后在平台侧真实执行 → 结果回灌 → 最终结论；会话 JSONL 可被平台直读。
- **DeepSeek Harness（无人值守）**：范围外工具被平台拒绝，且**不产生待审批**。
- **ask_user**：mock 模型调用 `ask_user` → 审批通道出现结构化问题（含选项）→ 操作者以 `answer` 应答 → 工具结果把答案原文回灌模型 → 模型按答案收尾；无人值守来源下 `ask_user` 立即被拒且无待审批。
- **sre_delegate**：父会话委派 → 子会话创建并带 `parentSessionId` → 子会话再次委派被深度上限拒绝 → 子会话产出结论 → 结论作为父会话的工具结果回灌。
- **CLI 内核（fixture 假 CLI）**：claude-code 走真实 spawn + stream-json 解析 + 第二轮 `--resume <kernelSessionId>` + result 去重；codex 走 JSONL 解析 + 无 resume flag 时回放对话历史 + sandbox 参数映射；qoder 纯文本输出兜底；`platformApprovalGate: false` 如实进 API。
- **凭证托管**：AES-GCM 加密落盘（密文不含明文）、列表只出脱敏值、换 `SRE_AGENT_SECRET` 后解密 fail-closed（返回不可解密而非报错崩溃）、按内核映射注入 env。
- **Browser use（真实 Chrome）**：playwright-core 驱动本机 Chrome，对本地 HTTP 站点完成 导航→快照（标题/文本/链接）→截图（PNG 魔数校验）→填表→求值→点击 全链路；playwright-core/Chrome 缺失时工具返回明确的未就绪指引而非崩溃。
- **Computer use（macOS 驱动）**：JXA/CoreGraphics 命令构造经 mock 精确断言（坐标点击/双击/右键/keystroke/key code/滚轮）；`screencapture` 截图文件往返校验；缺辅助功能权限时 `probe()` 给出明确中文指引（本会话沙箱无授权即为真实失败样例）。
- **MCP 桥（CLI 内核 → 平台工具）**：真实 stdio JSON-RPC —— `initialize`/`tools/list`（18 个平台工具）→ `kb_search` 即时执行；`sre_shell` 调用被平台审批门**阻塞**，批准后在平台侧真实执行并把结果回给 CLI。

人工确认（真实浏览器，非 jsdom）：完整平台 + 真实后端下，UI 呈现 10 个功能页、内核健康（`Pi (in-process)（就绪）`）、实时连接、告警/审批徽标、会话列表与元信息、工具卡片（成功状态、参数、结果可折叠）、审计流。截图见交付说明。

## 8. 已知限制与下一步

1. **审批中的工具调用在刷新后不可见**：待审批记录只在「审批」页与徽标上体现；对话流的工具卡片要等执行后才有记录。建议把 pending 工具调用也写入会话消息。
2. **工具参数在历史记录里不展示**：`ChatMessage` 未持久化 `args`，刷新后卡片显示「（无参数）」，实时视图正常。
3. **dsh 无法取消进行中的一轮对话**：sdk 线协议没有 per-turn cancel，UI 会明确提示，只能等结束或重启内核。
4. **dsh 的 MCP / Provider 变更需要重启内核**（profile 是启动期装配的）；Pi 侧即时生效。
5. **知识库向量检索为可选路径**：未配置 embedder 时纯 BM25，已实现接口与相似度计算但未接真实 embedding 服务。
6. **桌面端未做端到端打包**：`server-process` 逻辑有 9 个场景的 Node 级冒烟，但 dmg/nsis 未实际出包（打包时需把 server/web 以 `extraResources` 一起带上）。
7. **本机无任何 Provider 凭证**，因此真实厂商模型的调用未经验证；上述链路全部通过本机 OpenAI 兼容 mock 完成（协议面一致，差异只在真实模型的输出质量）。
8. **CLI 内核：参数面已对真实 CLI 验证，输出解析器未对真实模型输出验证**。本机装有 claude 2.1.195 与 codex 0.160.0，已核实两者的 flag 面与 profile 一致（claude：`--permission-mode` 的 plan/default/bypassPermissions choices、`--output-format stream-json`、`--resume`；codex：`exec --json`、`--sandbox read-only/workspace-write/danger-full-access`、`exec resume <id> --json`）。但无凭证跑不了真实模型轮次，stream-json/JSONL 的**字段级解析**仍按公开文档实现、仅对 fixture CLI 做过全链路测试；首次接真实 CLI 时如字段有出入，只需微调对应 profile 的 `parseLine`。qoder 的 headless 协议与 npm 包名（`qodercli`）均为社区信息，未经官方确认。
9. **CLI 内核接平台工具**：已通过 MCP stdio 桥实现（claude-code 经 `--mcp-config`，且工具调用经过平台权限门）；codex 的 `config.toml` 自动写入留待沙箱初始化一并做（避免污染用户 `CODEX_HOME`）。
10. **OAuth token 不自动刷新**：托管保存 refresh token 但未实现刷新流（各家端点与客户端凭证不同）；过期后重新导入或手填。
11. **平台自动拆分是"单层委派"**：`sre_delegate` 不做任务图/并行编排（v1 深度 1、串行）；更复杂的自动拆分建议由模型的技能指引（把"独立子目标各委派一次"写进技能）而非平台硬编码。

## 9. 目录

```
packages/
  protocol/           领域模型与线协议（唯一契约；含 JSON Schema 翻译器）
  server/             平台服务（内核适配器、权限、知识库、巡检、定时、告警、HTTP/WS）
  dsh-bridge-plugin/  DeepSeek Harness 原生插件（工具注入 / 审批门 / 事件回传 / 模型覆盖）
  web/                React + Vite + Ant Design 前端（10 个功能页）
  desktop/            Electron 套壳（后端进程托管 + 打包配置）
```
