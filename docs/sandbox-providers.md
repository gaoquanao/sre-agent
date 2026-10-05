# 沙箱后端抽象与演进（Mac mini → Linux 沙箱）

> 平台的执行层（agent 发起的命令、浏览器）既可以留在宿主机，也可以委派给隔离沙箱。本文说明抽象层设计、已对接的两个后端（阿里 OpenSandbox、E2B 兼容服务，含阿里云 Agent Sandbox Flash 版）、以及"Agent Use Sandbox / Agent in Sandbox"两种产品形态的落点。实现状态：【已实现】= 代码 + fake SDK 全链路测试；【已对接未实测】= 对接真实后端需要账号/网络。

## 1. 抽象层（`src/sandbox/`）

```ts
interface SandboxProvider {
  id: 'local' | 'opensandbox' | 'e2b'
  availability(): {ok, detail}          // SDK/凭证/端点是否就绪，未就绪时给出指引
  get(sessionId): SandboxHandle         // 懒创建：每平台会话一个沙箱
  release(sessionId) / releaseAll()
  sweep(now): string[]                  // 空闲 TTL 回收
  summaries() / describe()
}

interface SandboxHandle {
  sandboxId, provider, createdAt, lastUsedAt
  exec(command, {cwd?, timeoutMs?})     // 在沙箱内执行命令
  readFile(path) / writeFile(path, content)
  cdpEndpoint()                         // browser 型沙箱的 DevTools 端点（可选）
  renew()                               // 续期（远端 TTL + 本地空闲时钟）
  close()                               // kill + 客户端清理
}
```

设计原则：

- **单一执行缝隙**：平台内所有"agent 发起的命令"都走 `sre_shell` → provider，上面的权限引擎、审批流、审计完全不知道命令跑在哪。切换后端 = 换一个环境变量。
- **懒创建 + 会话作用域**：一次巡检/一次告警分诊 = 一个沙箱；空闲超时自动回收（默认 30 分钟，可配）。复用阿里产品语义里的 on-demand create/release。
- **诚实降级**：SDK 未安装或凭证未配置时 `availability()` 给出中文指引，工具返回明确错误，平台不崩。
- **可测试**：两个远程后端都通过"最小 SDK 形状接口 + 可注入 factory"适配，真实 SDK 动态 import；测试用 fake SDK 驱动全部生命周期。

## 2. 后端矩阵

| | `local`（默认） | `opensandbox` | `e2b` |
| --- | --- | --- | --- |
| 后端 | 宿主本机（Mac mini 形态） | [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)（阿里开源，Apache 2.0）Docker/K8s/**Firecracker microVM（~80ms 启动、pause/resume）** | E2B 兼容服务；**阿里云 Agent Sandbox Flash 版**（`E2B_API_KEY` / `E2B_API_URL=https://api.<region>.sandbox.aliyuncs.com` / `E2B_DOMAIN=<region>.sandbox.aliyuncs.com`，SDK 原生消费这三个 env） |
| SDK | 无（child_process/fs） | `@alibaba-group/opensandbox`（官方 TS SDK）【已对接未实测】 | `e2b`（官方 TS SDK）【已对接未实测】 |
| exec | `sh -lc` 本机 | `commands.run` → `Execution{logs.stdout[].text, exitCode}` | `commands.run` → `CommandResult{exitCode, stdout, stderr}` |
| 文件 | fs | `files.read_file` / `files.write_files` | `files.read` / `files.write` |
| 浏览器 | 本机 Chrome 无头 | `getEndpointUrl(9222)` → CDP | `getHost(9222)` → CDP（browser 型镜像） |
| 生命周期 | — | `kill`+`close`、`renew(seconds)`、`pause/resume` | `kill`、`setTimeout(ms)`、`pause`（Flash 版需 allowlist） |
| 状态 | — | 【已实现+fake 测试】 | 【已实现+fake 测试】 |

OpenSandbox 侧值得一提的能力（SDK 类型里确认）：Credential Vault（密钥经代理注入、不进沙箱文件系统）、网络出入策略（`NetworkPolicy`）、snapshot/pause-resume（Firecracker 运行时）——与平台的凭证托管/审批体系互补，接真实后端时可在模板层利用。

阿里 Flash 版边界（以官方文档为准，已纳入设计取舍）：**不支持** snapshots/Volume API/自定义域名/代理隧道 → 平台对"沙箱状态持久化"不做依赖，工作产物用文件写回或外部存储（OSS/NAS）；Sandbox Logs 可能为空 → 平台自身的审计/会话 JSONL 是唯一事实源（本来就是）。

## 3. 平台接线（Agent Use Sandbox 模式）【已实现】

- **路由**：`SRE_AGENT_SANDBOX=local|opensandbox|e2b`（默认 local），`SRE_AGENT_SANDBOX_TEMPLATE`（e2b 模板 / OpenSandbox 镜像，如 Chrome 镜像）、`SRE_AGENT_SANDBOX_TTL_MS`、`SRE_AGENT_SANDBOX_CDP_PORT`（默认 9222）；OpenSandbox 远端另有 `SRE_AGENT_OS_DOMAIN/API_KEY/PROTOCOL`。
- **`sre_shell`**：provider 非 local 时命令在会话沙箱内执行；结果与审计都标注去向（`on sandbox <id>`、`sandbox: opensandbox:<id>`）。**审批门不变**——只是"命令在哪跑"变了，"能不能跑"仍由权限引擎决定。
- **browser use**：provider 非 local 时浏览器工具连沙箱内 browser 型镜像的 CDP 端点（共享一个 "browser" 沙箱）；local 时驱动本机 Chrome。截图等能力不变。
- **computer use**：仍是宿主驱动（macOS）。desktop 型沙箱的 GUI 控制需要 VNC/RFB 通道，列为下一步（见 §5）。
- **状态**：`GET /api/sandbox` → provider、availability、活跃句柄列表。
- **巡检的确定性检查**（runbook checks）留在平台侧执行——它们是操作员配置的可信代码，恰恰不该进不可信沙箱；进沙箱的是 agent 自主发起的命令。这个边界是安全模型的一部分。

## 4. 演进：Agent in Sandbox（managed agent，后续）

同一套原语反过来用：控制面在沙箱后端上创建一个"平台镜像"沙箱（镜像内含 platform + CLI + Chromium），启动后平台进程打出 `SRE_AGENT_READY`（就绪契约已存在），控制面据此把 Web 客户端路由到该实例。要点：

- **镜像 = 平台镜像层**：`SRE_AGENT_HOME` 全状态在卷上；bootstrap 流程 = 预装 CLI（`POST /api/clis/:name/install`）+ 控制面恢复凭证（vault 需补 export/import 端点，`SRE_AGENT_SECRET` 随实例下发）+ 写内核 MCP 配置。
- **hibernate/checkpoint 的映射**：Flash 版 `pause()` / OpenSandbox Firecracker `pause/resume` 直接对应"agent 等人审批/等模型响应时挂起沙箱"——平台的审批阻塞期恰好是挂起点；这是远期成本优化，v1 用 TTL 回收。
- **computer use in desktop sandbox**：desktop 型沙箱提供 GUI 环境，接入方式 = ComputerDriver 的第三个实现（VNC/SDK 输入注入），接口不变。
- **控制面**：创建/销毁实例、路由、心跳。平台实例本身不知道控制面存在，保持可独立运行（Mac mini 形态不受影响）。

## 5. 下一步（按优先级）

1. 接真实后端做一轮实测（需要 OpenSandbox 部署或 Flash 版账号）：SDK 字段级 drift、CDP 端点连通性、冷启动延迟。
2. vault 的 export/import 端点（沙箱 bootstrap 的凭证恢复）。
3. computer use 的 desktop-沙箱驱动（VNC/RFB）。
4. 沙箱规格纳入 runbook spec（每个巡检可声明镜像/资源，而不是全局一个 template）。
