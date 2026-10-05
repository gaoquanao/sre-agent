# SRE Agent

面向 SRE 巡检与告警处置的 Agent 平台：**Web 端为主，Electron 套壳桌面端**，**Pi / DeepSeek Harness / Claude Code / Codex / Qoder 可插拔内核**，支持技能自定义、MCP 自定义、模型切换、权限控制与人工审批、定时巡检、知识库检索，全链路审计。

设计细节与实测结论见 [`docs/architecture.md`](docs/architecture.md)；computer use / browser use 接入见 [`docs/computer-browser-use.md`](docs/computer-browser-use.md)；沙箱后端抽象见 [`docs/sandbox-providers.md`](docs/sandbox-providers.md)；记忆/工作流/智能体见 [`docs/memory-workflow-agents.md`](docs/memory-workflow-agents.md)。

## 快速开始

```bash
npm install                 # 已配置腾讯镜像；首次会下载 Electron 二进制
npm run build               # protocol → server → web

# 启动（Web 与 API 同源）
node packages/server/dist/index.js
# 输出：SRE_AGENT_READY http://127.0.0.1:8787 kernel=pi home=<repo>/.sre-agent
```

浏览器打开 http://127.0.0.1:8787 即用（REST + WebSocket 同源）。

桌面端：

```bash
npm run desktop             # Electron 套壳，自动拉起后端并等待 ready 行
```

### 第一次跑通（没有厂商 API key 也行）

平台自带 mock LLM 通道，用于离线演示与测试：

```bash
# 1) 启动 OpenAI 兼容的 mock 端点（会调用平台工具，并走真实审批流程）
node --experimental-strip-types packages/server/test/mock-openai-standalone.ts 19100

# 2) 启动平台
SRE_AGENT_HOME=/tmp/sre-demo SRE_AGENT_PORT=8790 node packages/server/dist/index.js

# 3) 在「模型」页添加 Provider：baseUrl=http://127.0.0.1:19100/v1，api=openai-completions，key 任意，
#    模型 id 填 mock-model，并设为默认；然后在「对话」页发一句话
```

`dsh` 内核用同样的 mock 更省事：`SRE_AGENT_KERNEL=dsh SRE_AGENT_MOCK_LLM=1 node packages/server/dist/index.js`。

### 接真实模型

在「模型」页添加 Provider（DeepSeek / OpenAI 兼容 / Anthropic 兼容 / 自建网关），或在启动前用环境变量注入密钥：

```bash
DEEPSEEK_API_KEY=sk-... node packages/server/dist/index.js
```

密钥也可以只填环境变量名（`apiKeyEnv`），平台只把变量名下发到内核，不落库原文。

## 运行测试

```bash
npm test        # 51 个用例：能力单测 + 5 个内核端到端 + CLI/凭证/沙箱/记忆/工作流/智能体（无需任何 API key）
```

端到端用例会真实启动 Pi 会话与 `dsh` 子进程、真实触发工具调用与人工审批，并对"审批前工具不得执行""无人值守必须拒绝范围外工具"等安全断言做校验。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 对话排障 | 流式输出、思考过程折叠、工具调用卡片（参数/结果可展开）、停止、按会话切换模型 |
| 审批 | 风险分级 + 待审批推送（顶栏徽标 + 通知）、允许一次 / 本次会话允许 / 拒绝（可填理由），全量审计 |
| 巡检 | Runbook（确定性检查 http/shell/tcp + agent 分析）、立即执行、执行历史与报告、定时任务（cron + 时区） |
| 告警 | Webhook 接入、按 fingerprint 去重、自动分诊（可指定 runbook 或只读工具范围） |
| 技能 | 平台侧编写 Markdown 技能，自动镜像到当前内核的技能目录 |
| MCP | stdio / http 两种传输，Pi 写 `mcp.json`，dsh 写 profile 补丁并重启内核 |
| 模型 | Provider 与模型清单管理，运行期切换（Pi 即时生效，dsh 经桥接插件按会话下发） |
| 权限 | 三档预设 + 显式规则（工具 glob / 风险 / 来源）+ 审计日志 |
| 知识库 | 文档入库、分块、FTS5 检索（中文与子串友好），作为 `kb_search` 工具暴露给 agent |
| 内核 | 5 个内核动态卡片：能力矩阵（含平台审批门可用性警告）、健康状态、启停、切换、平台日志实时流 |
| CLI 工具 | agent CLI 探测/版本/一键安装（装进平台自有前缀，不动全局 npm） |
| 凭证托管 | API key / OAuth token / 自定义 env，AES-256-GCM 加密落盘、只出脱敏值、从本机已登录 CLI 一键导入、按内核注入 |
| 子任务与提问 | `sre_delegate`（子会话拆分，深度 1）与 `ask_user`（意图不明时向操作者提结构化问题并阻塞等答案），对内核无关 |
| Browser use | 无头 Chrome（playwright-core，可选依赖）：导航/快照/截图（图片直回模型）/点击/填表，每会话独立标签页 |
| Computer use | macOS 桌面控制（screencapture + CoreGraphics，零外部依赖）：截图/前置应用（只读）+ 点击/输入/按键（高危默认审批）；需授予屏幕录制+辅助功能权限 |
| CLI 内核接平台工具 | MCP stdio 桥：claude-code 经 `--mcp-config` 获得全部 18 个平台工具，且**经过同一个权限门与审批流** |
| 记忆 | 平台级记忆（fact/episode/preference）：工具读写 + **轮次前自动召回注入**（内核无关，有界 3 条/700 字符），按重要度/时间衰减/热度排序，2000 条上限自动淘汰 |
| 工作流 | **零 LLM 的确定性流程**：check/command/approval/notify + when 条件与失败中止；已知问题直接跑流程，不必对话；approval 步骤阻塞等人工 |
| 智能体 | AgentSpec + 触发器（cron / 告警匹配 / 手动）的 reactor 模型：无人值守受限工具范围、并发跳过、失败升级；supervisor 型 agent 自动收到近期 worker 运行摘要（Main Agent oversight） |
| 沙箱执行层 | `SRE_AGENT_SANDBOX=local\|opensandbox\|e2b`：agent 命令可在宿主机或隔离沙箱（阿里 OpenSandbox / E2B 兼容服务，含阿里云 Agent Sandbox Flash 版）中按会话执行，浏览器工具连沙箱 CDP；空闲自动回收 |

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `SRE_AGENT_HOME` | `<cwd>/.sre-agent` | 平台数据目录（数据库、内核 home、技能、工作区） |
| `SRE_AGENT_HOST` / `SRE_AGENT_PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `SRE_AGENT_KERNEL` | `pi` | 默认内核（`pi` \| `dsh`） |
| `SRE_AGENT_WORKSPACE` | `<home>/workspace` | agent 工作目录（也是 dsh 的 `cwd`） |
| `SRE_AGENT_PERMISSION_PRESET` | `workspace-write` | `read-only` \| `workspace-write` \| `full-access` |
| `SRE_AGENT_WEB_DIST` | 自动探测 `packages/web/dist` | 静态站点目录 |
| `SRE_AGENT_INTERNAL_TOKEN` | 由 home 派生 | dsh 桥接插件回调平台的令牌 |
| `SRE_AGENT_MOCK_LLM` | 关 | 打开后 dsh 使用内置确定性 mock 适配器 |
| `SRE_AGENT_DEBUG` | 关 | 打开内核事件轨迹与子进程 stderr 日志 |

## 目录

```
packages/
  protocol/           领域模型与线协议（唯一契约）
  server/             平台服务 + 内核适配器 + HTTP/WS
  dsh-bridge-plugin/  DeepSeek Harness 原生插件（工具注入/审批门/事件回传/模型覆盖）
  web/                React + Vite + Ant Design 前端
  desktop/            Electron 套壳与打包配置
docs/architecture.md  架构设计、内核集成实测结论、已知限制
```

## 安全默认值

- 默认预设 `workspace-write`：只读工具放行，其余**一律询问**；`read-only` 模式下非只读工具直接拒绝。
- 无人值守（定时巡检、告警分诊）**从不询问**：只允许 runbook 声明的工具，其余拒绝。
- 所有裁决 fail-closed：审批超时、被取消、平台不可达、内核异常，都视为拒绝。
- 平台只写自己的目录：Pi 的 `agentDir` 与 dsh 的 `DSH_HOME` 都在 `SRE_AGENT_HOME` 下，不碰 `~/.pi` 与 `~/.dsh`。
