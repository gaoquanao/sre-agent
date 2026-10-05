# Computer Use / Browser Use 接入设计与部署形态演进

> 回答两个问题：① computer use 和 browser use 怎么接入平台；② "本机真实 CLI 跑在 Mac mini" 的形态如何演进为 "Linux 沙箱中的 managed agent"。实现层面已落地的部分标注【已实现】。

## 1. 接入总设计：平台工具层，而不是内核特性

Computer use 和 browser use 不做成任何一个内核的特性，而是做成**平台工具**（`tools.ts` 注册，与 `kb_search`/`sre_shell` 同层）。理由：

1. **内核无关**：pi（进程内）、dsh（桥接插件）、claude-code（MCP 桥）都能用同一套工具，切换内核能力不缩水。
2. **同一权限门**：browser/computer 工具天然经过平台权限引擎（风险分级、预设、规则、审批、审计）。桌面控制类操作（`computer_click/type/key`）标注 `destructiveHint` → `workspace-write` 预设下必须人工审批，`read-only` 预设下直接拒绝——安全语义与其它工具完全一致。
3. **实现可替换**：驱动是接口（`ComputerDriver` / `BrowserDriver`），换实现不动上层。Mac mini 上是 macOS 驱动 + 本机 Chrome；Linux 沙箱里换成 xdotool 驱动 + 无头 Chromium，工具面不变。

### 1.1 Browser use【已实现，真实 Chrome 冒烟通过】

- **驱动**：`PlaywrightBrowserDriver`（`browser.ts`）——`playwright-core`（可选依赖，不下载浏览器）驱动**本机 Chrome**（`channel: 'chrome'`，无头）。Linux 沙箱时同一代码指向镜像内的 Chromium。
- **工具**（每会话独立标签页，互不干扰）：
  - `browser_navigate(url)` → 返回标题/可见文本节选/链接列表（medium risk）
  - `browser_snapshot()` / `browser_screenshot()`（只读；截图以 **image block 原生回给模型**）
  - `browser_click(selector)` / `browser_fill(selector, text)`（medium）
  - `browser_close()`
- **可观测降级**：playwright-core 或 Chrome 缺失时，工具返回明确的"未就绪 + 安装指引"，而不是让平台崩。
- **测试**：本机真实 Chrome 全链路冒烟（本地 HTTP 站点导航/截图 PNG 魔数/填表/求值/点击）。

### 1.2 Computer use【已实现；权限依赖宿主授权】

- **驱动**：`MacComputerDriver`（`computer.ts`）——零外部依赖：截图 `screencapture`；鼠标/滚轮用 **osascript JXA + CoreGraphics**（`CGEventCreateMouseEvent`/`CGEventPost`）；键盘用 System Events（`keystroke`/`key code`，unicode 安全）。
- **工具**：`computer_screenshot` / `computer_frontmost`（只读）+ `computer_click` / `computer_type` / `computer_key`（高危，默认审批）。
- **作用域即宿主**：驱动控制的是**运行平台进程的那台机器**（也就是 Mac mini）。这是有意的：巡检 agent 与被控桌面在同一台堡垒机上，审计闭环。
- **权限事实**：macOS 要求给平台进程（及其父终端/App）授予 **屏幕录制 + 辅助功能** 权限。驱动 `probe()` 先探测，缺权限时工具返回明确的中文指引（系统设置→隐私与安全性），绝不静默失败。部署 Mac mini 时把授权写进装机清单。
- **Linux 驱动**：`UnsupportedComputerDriver` 占位（明确报错）。沙箱形态落地时按同一接口实现 xdotool 版本。

### 1.3 截图怎么回到模型（各内核差异）【已实现】

| 内核 | 路径 | 效果 |
| --- | --- | --- |
| pi | 平台工具执行 → `ToolCallResult.images` → pi `ImageContent` | 模型直接看到截图 |
| claude-code | 平台工具经 **MCP 桥** → MCP `image` content block | 模型直接看到截图 |
| dsh | dsh 的 `ImageBlock` 需要 attachment service 引用，裸 base64 不可行 → 平台把截图落盘到 `<home>/artifacts/` 并在文本里给出路径 | 降级：模型知道路径，操作员可查 |
| codex / qoder | 暂不接平台工具（见 1.4） | — |

### 1.4 MCP 桥：CLI 内核接入平台工具【已实现，全链路测试通过】

`mcp-stdio.ts` 是平台的 **MCP stdio server**（换行分隔 JSON-RPC，`initialize`/`tools/list`/`tools/call`）。关键语义：

- **经过同一个权限门**：每次 `tools/call` 先打 `/internal/tool-verdict`（策略 + 人工审批阻塞），再 `/internal/tools/execute`。CLI 内核的平台工具调用与内嵌内核同策略、同审计。
- **会话上下文**：适配器每轮生成 MCP 配置文件（`<home>/cache/mcp/<sessionId>.json`），把 `SRE_AGENT_SESSION_ID` 注入桥的环境，工具执行归属于正确的平台会话（审计、审批、工具范围全对齐）。
- **claude-code**：profile 在每轮命令行追加 `--mcp-config <file> --strict-mcp-config --allowedTools mcp__sre-platform`（三个 flag 均经真实 claude 2.1.195 核实）。于是 claude-code 获得全部 18 个平台工具——包括 `sre_delegate`、`ask_user`、browser/computer use。
- codex：MCP 配置在 `config.toml`，为不污染用户 `CODEX_HOME`，v1 不自动写（设计上把它并入沙箱初始化：初始化脚本设 `CODEX_HOME` 到平台目录再写入配置）。

## 2. 部署形态：Mac mini（现在）

```
Mac mini（运维内网）
├── SRE Agent 平台（node，SRE_AGENT_HOME=/var/lib/sre-agent）
│   ├── 内核：pi（进程内）/ dsh / claude-code / codex（本机真实 CLI，climan 预装）
│   ├── browser use：无头 Chrome（本机）
│   ├── computer use：macOS 驱动 → 本机桌面（授权屏幕录制+辅助功能）
│   └── Web UI + WS：运维浏览器接入（或经 Electron 套壳）
└── 凭证托管：AES-GCM 落盘；OAuth 由「从本机导入」收编已登录 CLI
```

要点：真实 CLI 全部在这台机器上运行（登录态、网络位置、桌面控制都真实）；操作者从任意机器的浏览器接入。装机清单：Chrome、Node ≥ 22.19、（可选）`npm i -g` 或平台内安装各 CLI、系统授权两处、`SRE_AGENT_SECRET` 设置。

## 3. 演进：Linux 沙箱中的 managed agent（后续）

目标形态：整体软件抽象为 **managed agent**——控制面按需在 Linux 沙箱（容器/微 VM）里实例化一个完整平台，初始化完成后 Web 客户端直连该实例。当前架构为这条路径预留的接缝与还差的东西：

**已经就绪的（不用改）**
- 一切状态都在 `SRE_AGENT_HOME`：SQLite、内核 home、技能、会话 JSONL、凭证库 → **home 目录即沙箱镜像层/卷**，实例可复制、可重建。
- 内核全是子进程/桥接模式（除 pi 进程内，但 pi 本身跨平台）→ 无 macOS 绑定。
- browser use 的 Playwright 路径在 Linux 无头环境原样工作。
- Web 客户端与平台是纯 HTTP/WS 同源接入 → 客户端连沙箱实例只是换个地址。
- CLI 预装走平台自有前缀（`<home>/tools`）→ 沙箱镜像构建或首次初始化时批量安装即可。

**需要补的接缝（按优先级）**
1. **Linux computer 驱动**：实现 `ComputerDriver` 的 xdotool/wmctrl 版（X11）；无显示器的沙箱用 Xvfb 或走"纯 browser use"姿态。接口已定，纯增量。
2. **沙箱初始化（bootstrap）**：一条命令完成"新实例起步"——设 `SRE_AGENT_HOME`、启动平台、`POST /api/clis/:name/install` 预装 CLI、从控制面**恢复凭证**（需要给 vault 加 export/import 端点，v1 只有本机导入；密钥派生依赖 `SRE_AGENT_SECRET`，控制面下发即可解密）、写入内核 MCP 配置（codex 的 `CODEX_HOME` 也在此步落位）。
3. **控制面（未来模块）**：创建/销毁沙箱、把 Web 客户端路由到实例、实例心跳与回收。平台实例本身不需要知道控制面存在（`SRE_AGENT_READY` 行已是就绪契约，控制面监听它即可）。
4. **多租户与网络**：每实例独立 `SRE_AGENT_INTERNAL_TOKEN`（已是 per-home 派生）+ `SRE_AGENT_SECRET`；沙箱网络策略限制出网范围（browser use 的 `openWorldHint` 工具在策略上留给预设/规则收紧）。
5. **pi 进程内模式的取舍**：沙箱形态下 pi 也可改为 `--mode json` 子进程驱动（协议已支持），让平台镜像完全统一为"子进程内核"。非必须，视镜像精简需求。

**迁移语义**：现有 Mac mini 实例 → 沙箱实例 = 打包 `SRE_AGENT_HOME`（含密文凭证）+ 提供 `SRE_AGENT_SECRET`；会话 JSONL、知识库、runbook 全部随迁。
