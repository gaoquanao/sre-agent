# Memory / Workflow / Defined Agents

> 三个子系统的设计：平台级记忆（含自动召回）、**零 LLM 的确定性工作流**、以及 Main Agent 编排下的持续运行智能体。实现状态：【已实现】= 代码 + 端到端测试通过。

## 1. Memory：归属平台，不属于内核

记忆放在平台层，因此一个 Pi 会话学到的事实，dsh、codex 会话和无人值守 agent 运行都能用。

**数据模型**：`fact`（稳定事实）/ `episode`（一次事件及其结论）/ `preference`（操作者偏好）。字段含 `subject`（服务名/global）、`tags`、`importance`(1-5)、来源（agent/operator/system）、来源会话、访问统计。

**两条桥接路径**【已实现】：

1. **工具**：`memory_search` / `memory_save`，对全部内核可用（经平台工具注册表 / MCP 桥）。**无人值守也允许写入**——一次什么都没记住的运行是浪费的运行。
2. **自动召回**：在 `SessionService.prompt()` 里做提示词转换（内核无关）：对当轮文本做全文检索，命中则前置一个有界块（最多 3 条 / 700 字符），格式：
   ```
   <memory>
   以下是平台记忆库中与该请求相关的已知信息（可能过时，必要时用 memory_search 核对）：
   - [fact] api-gateway: upstream timeout 阈值是 3s，历史上调大导致过雪崩
   </memory>
   ```
   测试断言的是**模型真的收到了这个块**（检查 mock provider 的请求体），不是"函数被调用了"。

**相关性排序**：FTS5 trigram（中文与子串友好）+ bm25 经 sigmoid 归一，再叠加重要度、kind 权重（preference 略高）、时间衰减（半衰期 30 天）与访问热度。召回时记录访问，UI 可见"哪些记忆被用过"。

**容量**：上限 2000 条，超出按"低重要度 + 久未访问"淘汰最弱项（写入时触发）。

## 2. Workflow：固定处理路径不经过大模型

设计判断：**已知问题的已知处置流程，不该依赖模型的判断力或可用性**。所以工作流是纯确定性解释器，全程零 LLM 调用【已实现】。

**步骤类型**：`check`（http/shell/tcp，复用 runbook 检查器）、`command`（操作者编写的处置命令）、`approval`（**唯一需要人的地方**：阻塞在平台审批通道）、`notify`（webhook）。

**控制流**：`when` 条件让步骤按前置步骤结果跳过（`{stepId, field: ok|status|exitCode, equals}`）；`stopOnFailure`（command）/ `stopOnDeny`（approval，默认 true）/ `critical`（check）决定何时中止。每个步骤产出一行结果（状态/详情/输出/耗时），汇总成 Markdown 报告。

**安全边界**：工作流命令**在宿主机执行**（配置即信任、全程审计），与 agent 自主发起的命令（可进沙箱）区分开。这与 runbook 检查留在平台侧是同一条原则。

**触发**：手动、cron（经智能体）、告警（经智能体）、以及 **agent 调用 `workflow_run` 工具**（模型识别到"这有固定流程"时主动执行，而不是手工重演步骤）。

预置示例：`disk-pressure-cleanup`（查水位 → 审批 → 清理 → 通知），展示了"审批把关 + when 条件 + 失败中止"的组合。

## 3. Defined Agents：Main Agent 编排下的持续运行

**运行模型是 reactor，不是每个 agent 一个进程**【已实现】。每个智能体是一份 `AgentSpec` + 触发器，触发时启动一次**受限的无人值守运行**：

```
触发器（cron / 告警匹配 / 手动）
   → AgentRun 记录开始
   → 执行体（三选一）：
       workflowId  → 零 LLM 执行固定流程
       runbookId   → 确定性检查 + agent 分析
       否则        → 开一个 origin=schedule 会话，工具范围 = agent.allowedTools，prompt 注入角色 + 要求
   → 结束后写状态/summary，非 ok 则按 escalation.notifyUrls 升级
```

平台常驻、成本低，agent 按"它盯着的东西"唤醒——这正是"持续运行"的正确实现方式（也天然对应沙箱的按需创建/回收与 hibernation）。

**三个关键约束**：

- **工具范围硬约束**：无人值守运行的 `allowedTools` 之外一律拒绝（复用权限引擎的 runbook 作用域），且**永不产生待审批**（没人可答）。测试覆盖：agent 调用范围外的 `sre_shell` 被拒且无待审批。
- **并发保护**：同一 agent 上一次运行未结束则跳过本次触发（记 `warn`），避免堆积。
- **Main Agent oversight 走摘要，不走轮询**：worker 的每次运行都落 `AgentRun`（状态/summary/sessionId），`supervisor` 类型的 agent 在 prompt 里自动收到**近期 worker 运行摘要**（`digest()`：最近 5 条，含名称/触发/时长/结论），并可调用 `agent_status` 看细节、`workflow_run` 编排处置、`memory_save` 沉淀结论。测试断言 supervisor 的 prompt 里真的带了摘要与编排要求。

**典型三类 agent**（预置示例 + 可自建）：

| 类型 | 触发 | 执行体 | 例子 |
| --- | --- | --- | --- |
| 监控 agent | cron | workflow 或 runbook | `disk-watchdog`（每 30 分钟查水位，超阈值走处置流程） |
| 告警 agent | 告警匹配器（severity/namePattern/source） | 任意 | 匹配 `critical` + `HighCPU*` → 走自愈流程 |
| 故障自愈 agent | 告警 + 审批 | workflow（含 approval 步骤） | 处置动作前阻塞等人工批准 |
| 主管 agent | cron | 自由会话（带摘要） | `incident-supervisor`（每小时看全局，编排补位） |

**告警分派顺序**：告警进来先匹配已定义智能体（更具体的"谁负责"），没有匹配才回落到 runbook 设置或通用只读分诊。

## 4. 与其它子系统的接口

- **权限/审批**：工作流的 approval 步骤与 agent 的运行都走同一个审批通道与审计；无人值守一律 deny-off-allowlist。
- **沙箱**：agent 的会话如果配置了沙箱后端，其命令在隔离环境中执行；工作流命令按设计留在宿主。
- **知识库 vs 记忆**：知识库是"文档"（runbook、复盘，人工维护、按需检索）；记忆是"运行中学到的东西"（自动召回、有衰减与淘汰）。两者都在 agent 的工具集里，界限清晰。
