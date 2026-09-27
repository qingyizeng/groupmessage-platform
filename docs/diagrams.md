# 系统架构图

本文件汇总系统的架构图，从整体到细节排列。设计原因和取舍见 [architecture.md](architecture.md)。图使用 Mermaid，GitHub 可直接渲染。

| # | 图 | 回答的问题 |
|---|---|---|
| 1 | [部署与外部依赖](#1-部署与外部依赖) | 有哪些进程、怎么连接、端口是什么 |
| 2 | [后端组件](#2-后端组件) | 服务内部分哪些模块，后台 worker 有哪些，谁调用谁 |
| 3 | [跨模块联动（收口函数与挂接点）](#3-跨模块联动收口函数与挂接点) | 一个变化会在同一事务里引起哪些后果 |
| 4 | [多实例协调](#4-多实例协调) | 多个实例同时运行时怎么保证不重复、不冲突 |
| 5 | [网关事件接入](#5-网关事件接入) | 事件怎样可靠地进入系统 |
| 6 | [出站消息发送](#6-出站消息发送) | 一条消息从受理到发出的完整过程，504 如何处理 |
| 7 | [账号状态机](#7-账号状态机) | 账号状态与转移 |
| 8 | [Agent run](#8-agent-run) | 触发、执行循环、续跑、run 状态 |
| 9 | [定时序列](#9-定时序列) | 预检、排期、步骤状态 |
| 10 | [建群与退群任务](#10-建群与退群任务) | 可续跑的任务步骤 |
| 11 | [实时推送](#11-实时推送) | seq 分配、补发、心跳 |
| 12 | [数据模型](#12-数据模型) | 表与关系 |
| 13 | [前端架构](#13-前端架构) | 控制台的数据流 |
| 14 | [登录会话](#14-登录会话) | token 轮换与重用检测 |

---

## 1. 部署与外部依赖

`docker compose up` 启动的全部进程。后端可以水平扩展为多个实例，彼此只通过 PostgreSQL 协调。

```mermaid
flowchart LR
  subgraph Client["浏览器"]
    SPA["控制台 SPA<br/>React 18 + TanStack Query + antd"]
  end

  subgraph App["后端 apps/server（:3000，可多实例）"]
    HTTP["REST API /api/*<br/>静态托管控制台"]
    WS["WebSocket /ws"]
    WK["后台 worker"]
  end

  PG[("PostgreSQL 16<br/>唯一事实来源")]
  MEDIA[("本地目录 media/<br/>C1 下载的附件")]

  subgraph Ext["外部服务（开发与演示时为模拟实现）"]
    GW["消息网关<br/>mock-gateway :4001<br/>HTTP + SSE + /_control 故障注入"]
    AG["Agent 服务<br/>mock-agent :4002<br/>规则 agent + 剧本"]
    LLM["llm-agent :4003（可选）<br/>与 Agent 服务接口相同"]
  end
  CLAUDE["Claude API"]

  SPA -- "REST（Bearer access token）<br/>refresh token 走 HttpOnly cookie" --> HTTP
  SPA <-- "事件帧 {seq,type,payload}<br/>sinceSeq 补发 + 心跳" --> WS
  HTTP --> PG
  WS --> PG
  WK --> PG
  WK --> MEDIA
  WK -- "connect / send / join / kick …" --> GW
  WK -- "GET /events?since（SSE）" --> GW
  WK -- "POST /agent/turn<br/>POST /agent/audit" --> AG
  WK -. "改 AGENT_URL 即切换" .-> LLM
  LLM --> CLAUDE
```

---

## 2. 后端组件

一个服务进程分四层：入口与后台 worker 并列在最上层，都只调用领域层；领域层再经基础设施访问数据库与外部服务。领域层内跨模块的状态变更只经过收口函数（见第 3 节）。

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 900}}}%%
flowchart TB
  L1["<b>① 入口</b><br/>REST API（Fastify）：authGuard 认证与 viewer 只读 · 统一错误格式<br/>WsHub /ws：认证 · sinceSeq 补发 · 心跳"]
  L2["<b>② 后台 worker</b>（runtime.ts 启停，NOTIFY 唤醒 + 轮询兜底）<br/>EventIngestor（选主单例）· InboxProcessor ×4 · DeliveryService · TaskRunner<br/>JobRunner · AgentRunner · WsPublisher（选主单例）"]
  L3["<b>③ 领域层</b>（跨模块的状态变更只经收口函数，见第 3 节）<br/>accounts（transitions）· messages（outbound · inbound · delivery · 时间线）· groups<br/>agent（executor · protocol · tools）· sequences · jobs · auth · media · maintenance"]
  L4["<b>④ 基础设施</b><br/>outbox.emitWs · PgListener（LISTEN/NOTIFY）· advisory lock 选主<br/>GatewayClient（错误带结果语义）· SSE 解析 · AgentClient"]
  PG[("<b>PostgreSQL</b><br/>唯一事实来源")]
  EXT["<b>外部</b><br/>消息网关 · Agent 服务 · media/ 目录"]
  L1 -- "调用" --> L3
  L2 -- "调用" --> L3
  L3 --> L4
  L4 --> PG
  L4 --> EXT
```

各组件的职责与依赖：

| 组件 | 读写 | 调用 |
|---|---|---|
| REST API | 领域服务 | — |
| WsHub | `ws_outbox`（按 seq 读取） | 被 PgListener 唤醒 |
| EventIngestor | `gateway_events`、`kv.event_cursor` | SSE 解析、网关 `/events` |
| InboxProcessor | 业务表（经事件处理器） | 领域层：账号、消息、成员 |
| DeliveryService | `messages` | GatewayClient：send、by-client-id |
| TaskRunner | `scheduled_tasks` | 限流到期、网关 disconnect、序列步骤、媒体、维护 |
| JobRunner | `jobs`、`groups`、`group_members` | GatewayClient：建群、邀请、join、promote、leave、members |
| AgentRunner | `agent_*`、`messages` | AgentClient、GatewayClient：kick、members |
| WsPublisher | `ws_outbox`、`ws_seq_state` | NOTIFY `ws_publish` |

| worker | 领取方式 | 运行实例 | 唤醒 |
|---|---|---|---|
| EventIngestor | advisory lock 选主 | 全局一个 | 常驻 SSE，断线退避重连 |
| InboxProcessor | `FOR UPDATE SKIP LOCKED` | 每实例 4 个并发 | NOTIFY + 轮询 |
| DeliveryService | 按账号队头 `SKIP LOCKED`，未知状态用租约 | 每实例 | NOTIFY + 100ms |
| TaskRunner | `scheduled_tasks` 租约 | 每实例 | NOTIFY + 200ms |
| JobRunner | `jobs` 租约 + 心跳 | 每实例 | NOTIFY + 250ms |
| AgentRunner | `agent_runs` 租约 + 心跳 | 每实例 | NOTIFY + 250ms |
| WsPublisher | advisory lock 选主 | 全局一个 | NOTIFY + 200ms |
| WsHub 心跳 | 本实例的连接 | 每实例 | 每 15s |

定时任务的种类：`rate_limit_expiry`（限流到期）、`gateway_disconnect`（通知网关离线）、`sequence_step`（序列当前步到点）、`media_download` / `media_cleanup`（C1）、`maintenance`（清理过期的推送事件、网关事件、吊销记录）。

---

## 3. 跨模块联动（收口函数与挂接点）

状态变更只经过三个收口函数。它们在调用方的事务里完成全部后果，所以"从任何来源进入某个状态，后果都一样，而且要么全生效要么全不生效"。

```mermaid
flowchart LR
  subgraph A["账号状态"]
    direction LR
    A1["操作员 API<br/>网关同步错误<br/>网关 account_status 事件<br/>限流到期任务"] --> A2["transitions<br/>.applyTransition"]
    A2 --> A3["WS：account_status_changed"]
    A2 --> A4["进入 rate_limited：排期限流到期任务<br/>离开 rate_limited：取消该任务"]
    A2 -- "进入终态" --> A5["退出所有群<br/>排队消息 → cancelled / ACCOUNT_TERMINAL<br/>（逐条经 updateOutbound）<br/>取消网关 disconnect 任务<br/>WS：account_terminal"]
  end
```

```mermaid
flowchart LR
  subgraph B["出站消息状态"]
    direction LR
    B1["发送结果<br/>message_sent / message_failed<br/>by-client-id 核对<br/>账号终态、群不可写导致的取消"] --> B2["outbound<br/>.updateOutbound"]
    B2 --> B3["WS：message<br/>（带完整消息行）"]
    B2 --> B4["NOTIFY outbound_status<br/>唤醒等待确认的 agent"]
    B2 -- "sequenceOutboundHook" --> B5["序列步骤 accepted / sent / skipped / failed<br/>sent 或 skipped 时排期下一步"]
  end
```

```mermaid
flowchart LR
  subgraph C["群不可写"]
    direction LR
    C1["GROUP_WRITE_FORBIDDEN<br/>（同步错误或 message_failed）"] --> C2["groupRepo<br/>.markGroupUnreachable"]
    C2 --> C3["群 → unreachable<br/>WS：group_changed"]
    C2 --> C4["该群排队消息 → cancelled / GROUP_UNREACHABLE"]
    C2 -- "stopAgentForGroup" --> C5["running 的 run：当前步后 cancelled<br/>丢弃待处理触发"]
    C2 -- "stopSequencesForGroup" --> C6["running 的序列 → stopped"]
  end
```

另外两个挂接点：

| 触发 | 挂接点 | 后果 |
|---|---|---|
| 存入一条非自己的新消息 | `agentTriggerHook` | 群开启 agent 且可写时写入 `agent_triggers`，作为下一次 run 的触发消息 |
| `PATCH agentEnabled=false` | `agentSettingsHook` | 与群不可写相同：run 在当前步后 cancelled，丢弃待处理触发 |

---

## 4. 多实例协调

实例之间没有直接通信，互斥与唤醒全部借助 PostgreSQL。

```mermaid
flowchart TB
  subgraph I1["实例 A"]
    A1["EventIngestor ✔ 持有选主锁"]
    A2["WsPublisher ✔ 持有选主锁"]
    A3["其他 worker"]
    A4["WsHub（连接 A 上的浏览器）"]
  end
  subgraph I2["实例 B"]
    B1["EventIngestor（等待选主锁）"]
    B2["WsPublisher（等待选主锁）"]
    B3["其他 worker"]
    B4["WsHub（连接 B 上的浏览器）"]
  end
  PG[("PostgreSQL")]

  A1 & A2 -- "pg_try_advisory_lock<br/>连接断开即释放" --> PG
  B1 & B2 -. "每秒重试" .-> PG
  A3 & B3 -- "SKIP LOCKED / 租约领取<br/>唯一索引互斥" --> PG
  PG -- "NOTIFY ws_publish" --> A4 & B4
```

| 需要互斥的对象 | 机制 |
|---|---|
| 同一群同时只有一个 running 的 agent run | `agent_runs` 部分唯一索引 `(group_id) WHERE status='running'` |
| 同一群同时只有一个 running 的序列 | `sequence_runs` 部分唯一索引，并发启动的输家得到 409 |
| 同一群只有一个进行中的 leave-all | `jobs` 部分唯一索引 |
| 同一账号并发变更 | `SELECT … FOR UPDATE NOWAIT`，拿不到锁即 409 CAS_CONFLICT |
| 事件只存一份 | `gateway_events.event_id` 主键 |
| 一条事件、一条消息、一个任务只被一个 worker 处理 | `FOR UPDATE SKIP LOCKED`，或带到期时间的租约 |
| 重启后接手自己之前的工作 | 租约按 `INSTANCE_ID` 记录，同名实例启动后立即接手不在内存中的租约 |

---

## 5. 网关事件接入

事件先原样落库（去重），再由处理器逐条处理。续传点永远不越过尚未落库的事件；网关保留全部历史，所以停机、断流、数据库写入失败都不会丢事件。

```mermaid
sequenceDiagram
  autonumber
  participant GW as 网关 SSE
  participant ING as EventIngestor（选主）
  participant EV as gateway_events
  participant KV as kv.event_cursor
  participant INB as InboxProcessor
  participant BIZ as 业务表 + ws_outbox

  ING->>KV: 读取续传点 since
  ING->>GW: GET /events?since=since
  loop 每个事件帧
    GW-->>ING: id / event / data
    ING->>EV: INSERT … ON CONFLICT (event_id) DO NOTHING
    Note over ING,EV: 失败：留在内存重试并推 inconsistency<br/>续传点不前进，崩溃后从网关补拉
    ING-->>INB: NOTIFY gateway_events
  end
  ING->>KV: 续传点 = 2 秒前已落库的最大 id（且小于任何未落库 id）
  INB->>EV: 领取 pending（SKIP LOCKED）
  INB->>BIZ: 同一事务：处理器 + 标记 done
  alt 处理失败
    INB->>EV: 回滚到 savepoint，attempts+1，退避重试
    INB->>BIZ: 推 inconsistency（首次失败 / 停放时）
  end
```

各事件处理器都与到达顺序无关，所以可以并发处理、任意重放：

| 事件 | 处理 |
|---|---|
| `message` | 按 `(group_id, msg_id)` 去重；自己账号发的先存为隐藏行，等 `message_sent` 合并；非自己的在 agent 开启时写入触发表；带附件的安排下载 |
| `message_sent` / `message_failed` | `updateOutbound`，状态只前进 |
| `member_joined` / `member_left` | 以事件 id 判断新旧，较新的胜出；终态账号不会重新出现 |
| `account_status` | 进入终态；已是终态则忽略 |

---

## 6. 出站消息发送

### 6.1 时序

受理时先写 `queued`；发请求前先提交 `dispatching`；只有在"504 之后超过 2 秒仍查不到"时才重发，且最多一次。

```mermaid
sequenceDiagram
  autonumber
  participant SRC as 操作员 / agent / 序列
  participant DB as messages
  participant DEL as DeliveryService
  participant GW as 网关
  participant INB as InboxProcessor

  SRC->>DB: enqueueOutbound：phase=queued，生成 clientMsgId
  DEL->>DB: 领取账号队头，提交 dispatching（attempt+1，租约）
  DEL->>GW: POST /groups/:id/send
  alt 202 已受理
    GW-->>DEL: 202
    DEL->>DB: accepted
    GW-->>INB: message_sent（可能早于 202 到达）
    INB->>DB: sent（写入 msgId、网关 sentAt，合并回流的隐藏行）
  else 504 / 我方超时 / 连接中断 / 崩溃在请求途中
    DEL->>DB: unknown（confirm_after = 504 后 2 秒）
    loop 每 300ms，直到有结论
      DEL->>GW: GET by-client-id
      alt 查到
        DEL->>DB: sent
      else 404 且已过确认窗口
        alt 这是第一次发送
          DEL->>DB: resending（attempt=2）
          DEL->>GW: 用同一 clientMsgId 重发一次
        else 已经重发过
          DEL->>DB: failed / NETWORK_TIMEOUT
        end
      else 查询 503
        Note over DEL,DB: 保持 unknown，继续查
      end
    end
  else 429 RATE_LIMITED
    DEL->>DB: 回到 queued，账号 → rate_limited
    Note over DEL: 到期前该账号一次都不发，到期后按原顺序发出
  else 403 / 409 确定错误
    DEL->>DB: failed + failCode，按错误码处理后果（第 3 节）
  end
```

### 6.2 状态机

对外的 `deliveryStatus` 是内部阶段的投影：`dispatching` 显示为 `queued`，`resending` 显示为 `unknown`。

```mermaid
stateDiagram-v2
  [*] --> queued: 受理（clientMsgId 已生成）
  queued --> dispatching: 领取队头，提交后才发请求
  dispatching --> accepted: 202
  dispatching --> queued: 429 / 503 / 连接被拒（确定没发出）
  dispatching --> unknown: 504 / 我方超时 / 连接中断 / 崩溃恢复
  dispatching --> failed: 403 · 409 等确定错误
  queued --> cancelled: 账号终态 ACCOUNT_TERMINAL<br/>群不可写 GROUP_UNREACHABLE
  unknown --> sent: 查到 / message_sent
  unknown --> resending: 确认没发出 且 attempt=1
  unknown --> failed: 确认没发出 且 attempt=2（NETWORK_TIMEOUT）
  unknown --> cancelled: 确认没发出 且 账号终态 / 群不可写
  resending --> accepted: 202
  resending --> unknown: 再次结果未知
  accepted --> sent: message_sent
  accepted --> failed: message_failed
  sent --> [*]
  failed --> [*]
  cancelled --> [*]
```

---

## 7. 账号状态机

与 `packages/shared/src/accountTransitions.ts` 中的转移表一致（前端按钮的显隐也用这张表）。终态没有出边。

```mermaid
stateDiagram-v2
  idle --> online: 连接（调网关 connect）
  disconnected --> online: 重连（调网关 connect）
  rate_limited --> online: 限流到期 / 操作员
  online --> rate_limited: 429 RATE_LIMITED
  online --> disconnected: 标记离线（调网关 disconnect）
  rate_limited --> disconnected: 标记离线
  online --> idle: 释放账号（调网关 disconnect）
  disconnected --> idle: 释放账号

  idle --> suspended
  online --> suspended
  rate_limited --> suspended
  disconnected --> suspended
  idle --> session_expired
  online --> session_expired
  rate_limited --> session_expired
  disconnected --> session_expired

  suspended --> [*]
  session_expired --> [*]

  note right of suspended
    终态：ACCOUNT_SUSPENDED / SESSION_EXPIRED
    或网关 account_status 事件，或操作员标记。
    同一事务：退出所有群、取消排队消息、
    跳过序列步骤、推 account_terminal
  end note
```

---

## 8. Agent run

### 8.1 触发

```mermaid
flowchart LR
  M["非自己的新消息<br/>（agent 已开启、群可写）"] --> T["写入 agent_triggers<br/>主键 = 消息行 id<br/>（重复事件不会重复触发）"]
  T --> Q{"群里已有<br/>running 的 run？"}
  Q -- "有" --> W["留作待处理<br/>该 run 结束时立即建下一个"]
  Q -- "没有" --> R["创建 run，认领全部待处理触发<br/>（部分唯一索引保证每群一个，多实例也成立）"]
```

### 8.2 执行循环

一步 = 一次 `/agent/turn` 往返。每一步分两次落库：T1 记录响应与分类，T2 记录工具结果；工具的执行进度记在 `agent_tool_calls`，崩溃后按记录的阶段续跑，已生效的外部效果不会重复。

```mermaid
flowchart TB
  S(["领取 run（新建，或崩溃后用同一 runId 续跑：<br/>先完成未完成的工具调用，见下表）"]) --> C{"结束检查<br/>取消 · 连续 3 次协议错误<br/>12 步 · 60 秒（停机不计）"}
  C -- "继续" --> TURN["POST /agent/turn<br/>超时 = min(配置 10–15 秒, 剩余时间)"]
  TURN --> T1["T1 事务<br/>保存原始响应（2KB）、步数 +1<br/>写对话记录与工具调用记录"]
  T1 --> K{"响应分类"}
  K -- "合法工具调用" --> X["执行工具<br/>发消息、踢人前先审计（最多 3 次）"]
  X --> T2["T2 事务<br/>追加 tool_result，更新步骤"]
  T2 --> C
  K -- "协议错误" --> C
  K -- "finish / end_turn" --> E(["结束（见 8.3）<br/>同一事务：有待处理触发则立即建下一个 run"])
  C -- "取消 / 超限" --> E
  X -- "审计 3 次无结论" --> E
```

| 响应分类 | 对话记录中追加的内容 | 计入连续协议错误 |
|---|---|---|
| 合法工具调用 | assistant 的 tool_use 块，执行后追加 tool_result | 否（清零） |
| 未知工具 / 入参不合 schema | assistant 的 tool_use 块 + `is_error` 的 tool_result（`UNKNOWN_TOOL` / `INVALID_INPUT`） | 是 |
| 坏 JSON（含代码围栏、前后夹文字、形状不对）/ 重复 tool_use.id / 超时 | 一条 user 文本 `PROTOCOL_ERROR <code>: <一句话>` | 是 |
| `finish` / `end_turn` | —（run 结束，summary 取自 finish 入参或 end_turn 文本） | 否 |

崩溃发生在不同位置时的续跑方式：

| 中断位置 | 续跑时 |
|---|---|
| `/agent/turn` 请求途中 | 用同样的对话记录重新请求，不计步 |
| T1 之后、工具执行前 | 按 `agent_tool_calls.phase=pending` 执行 |
| 审计途中 | 继续审计；尝试次数已落库，总数不超过 3；已有结论不再审计 |
| 发消息已入队 | 不再审计、不新建消息，只等待该消息的状态 |
| 踢人已发出 | 先等 2 秒让网关收敛，再查成员列表；目标已不在即判为成功，否则再踢 |

### 8.3 run 状态

```mermaid
stateDiagram-v2
  [*] --> running
  running --> finished: final（finish / end_turn）
  running --> failed: budget_exhausted（12 步）<br/>wall_clock（60 秒，停机不计）<br/>protocol_errors（连续 3 次）
  running --> blocked: audit_blocked（审计 3 次无结论）
  running --> cancelled: cancelled（agent 被关闭 / 群不可写，当前步结束后）
  finished --> [*]
  failed --> [*]
  blocked --> [*]
  cancelled --> [*]
```

---

## 9. 定时序列

### 9.1 启动与排期

同一时刻只有"当前步"有排期（一个持久化定时任务）。下一步从上一步收到 `message_sent` 的时刻（或跳过的时刻）开始计时。

```mermaid
sequenceDiagram
  autonumber
  participant OP as 控制台
  participant API as POST /groups/:id/sequence-runs
  participant ENG as sequenceEngine
  participant TASK as scheduled_tasks
  participant DEL as 发送流程
  participant GW as 网关

  OP->>OP: 预检弹窗：resolveSequence（与后端同一份代码）
  OP->>API: sequenceId + vars + stepVars
  API->>ENG: resolveSequence
  alt 有占位符无法解析
    ENG-->>API: 422 UNRESOLVED_PLACEHOLDER {stepIndex, key}，不写任何记录
  else 已有 running 的序列
    ENG-->>API: 409 SEQUENCE_ALREADY_RUNNING（唯一索引）
  else
    ENG->>TASK: 创建 run 与全部步骤（取值已解析），第 1 步排在 now + delay
    ENG-->>API: 201 {runId}
  end
  loop 每一步
    TASK->>ENG: 到点
    alt 比计划晚超过 2 秒（停机期间错过）
      ENG->>TASK: 改排到 now + delaySeconds
    else 没有匹配角色的账号
      ENG->>ENG: skipped（记时间），下一步从此刻计时
    else
      ENG->>DEL: 以选中的账号入队（限流账号也算，随限流顺延）
      DEL->>GW: send
      GW-->>ENG: message_sent（经 updateOutbound 挂接点）
      ENG->>TASK: 本步 sent，下一步排在 now + delay；没有下一步则 finished
    end
  end
```

### 9.2 状态

```mermaid
stateDiagram-v2
  state "序列运行" as RUN {
    [*] --> running
    running --> finished: 最后一步 sent / skipped
    running --> failed: 某步发送失败
    running --> stopped: 群变为不可写
  }
  state "步骤" as STEP {
    [*] --> pending
    pending --> accepted: 202
    pending --> skipped: 无匹配账号 / 账号终态导致消息取消
    accepted --> sent: message_sent
    pending --> sent: message_sent 早于 202
    pending --> failed: 发送失败
    accepted --> failed: message_failed
  }
```

---

## 10. 建群与退群任务

任务每推进一步就把进度写进 `jobs.state`，由持租约的执行器驱动，崩溃后从断点继续。

```mermaid
flowchart TB
  subgraph CREATE["create_group"]
    direction LR
    C1["create<br/>保存 gatewayGroupId<br/>写群主成员行"] --> C2["invite<br/>等到可用时间"]
    C2 --> C3["各成员并行 join<br/>INVITE_NOT_READY：等待重试<br/>INVITE_EXPIRED：重新申请一次<br/>ALREADY_MEMBER：视为成功"]
    C3 --> C4["等 member_joined<br/>10 秒未到：JOIN_TIMEOUT"]
    C4 --> C5["promote 第一个成员<br/>NOT_MEMBER_YET 重试，总共 ≤ 2 次"]
  end
  subgraph LEAVE["leave_all"]
    direction LR
    L1["非群主逐个 leave<br/>失败记入 errors，其余继续"] --> L2{"非群主全部成功？"}
    L2 -- 是 --> L3["群主 leave<br/>群 → left，members=[]"]
    L2 -- 否 --> L4["群主不退，job failed"]
    L3 --> L5["与网关成员列表对账"]
    L4 --> L5
  end
  CREATE ~~~ LEAVE
```

---

## 11. 实时推送

业务事务只写事件；单一发布者在提交后按顺序分配 seq，所以 seq 连续、推送的状态一定已保存，断线后按 `sinceSeq` 补发不会漏也不会重。

```mermaid
sequenceDiagram
  autonumber
  participant TX as 业务事务
  participant OB as ws_outbox
  participant PUB as WsPublisher（选主）
  participant HUB as WsHub（每实例）
  participant C as 浏览器

  TX->>OB: INSERT（seq 为空）+ NOTIFY ws_outbox
  Note over TX,OB: 事务回滚则事件一起消失
  PUB->>OB: 只看得到已提交的行：按 id 顺序分配 last_seq+1…
  PUB-->>HUB: NOTIFY ws_publish
  HUB->>OB: 读取新 seq
  HUB-->>C: {seq, type, payload}（按 seq 去重）
  Note over C: 断线（网络切换、服务重启）
  C->>HUB: {type:auth, accessToken, sinceSeq}
  alt sinceSeq 仍在保留期内
    HUB-->>C: 补发 (sinceSeq, 当前]，期间的实时帧先缓冲再按 seq 去重
  else 早于保留期（默认 24 小时）
    HUB-->>C: resync_required，前端全量刷新
  end
  loop 每 15 秒
    HUB-->>C: 协议 ping + {type:ping}
    Note over HUB,C: 服务端断开不回 pong 的连接<br/>客户端约 40 秒收不到任何帧即重建
  end
```

---

## 12. 数据模型

按领域拆成四张图，只列关键字段。完整定义见 `apps/server/migrations/*.sql`。

### 12.1 账号、群与消息

```mermaid
erDiagram
  accounts ||--o{ group_members : "服务账号成员"
  accounts |o--o{ groups : "creator"
  accounts |o--o{ messages : "发送账号"
  groups ||--o{ group_members : "成员"
  groups ||--o{ messages : "时间线"
  groups |o--o{ jobs : "建群 / leave-all"

  accounts {
    text id PK
    text status
    text platform_user_id UK
    timestamptz rate_limited_until
  }
  groups {
    uuid id PK
    text gateway_group_id UK
    text status "active | unreachable | left"
    boolean agent_enabled
    boolean auto_kick_enabled
  }
  group_members {
    uuid group_id PK
    text platform_user_id PK
    text account_id FK "外部用户为空"
    text role "creator | admin | member"
    boolean present
    bigint state_event_id "较新事件胜出"
  }
  messages {
    bigint id PK
    uuid group_id FK
    text msg_id "与 group_id 唯一"
    text client_msg_id UK
    boolean is_own
    boolean echo_pending "回流待合并"
    timestamptz sort_ts "时间线排序"
    text phase "内部阶段"
    text delivery_status "生成列"
    text fail_code
    smallint attempt "最多 2"
    text media_status
    text local_file_path
  }
  jobs {
    uuid id PK
    text type "create_group | leave_all"
    text status
    jsonb state "断点"
    jsonb errors
  }
```

### 12.2 Agent

```mermaid
erDiagram
  groups ||--o{ agent_runs : ""
  agent_runs ||--o{ agent_run_messages : "对话记录"
  agent_runs ||--o{ agent_run_steps : "步骤"
  agent_runs ||--o{ agent_tool_calls : "工具执行记录"
  agent_runs |o--o{ agent_triggers : "认领"
  messages ||--o| agent_triggers : "触发消息"
  agent_tool_calls |o--o| messages : "outbound_message_id"
  agent_runs |o--o{ messages : "agent_run_id + idempotency_key 唯一"

  agent_runs {
    uuid id PK
    uuid group_id FK "running 时每群唯一"
    text status
    text end_reason
    int step_count
    int consecutive_protocol_errors
    int elapsed_ms "停机不计"
    boolean cancel_requested
  }
  agent_run_messages {
    uuid run_id PK
    int idx PK
    text role
    jsonb content
  }
  agent_run_steps {
    uuid run_id PK
    int seq PK
    text kind "tool_use | final | protocol_error"
    text tool_use_id "每 run 唯一"
    text error_code
    text audit_verdict
    text raw_response "截断到 2KB"
  }
  agent_tool_calls {
    uuid run_id PK
    text tool_use_id PK
    text phase "pending | executing | done"
    int audit_attempts
    text audit_verdict
  }
  agent_triggers {
    bigint message_id PK
    uuid run_id FK "未认领为空"
    boolean discarded
  }
```

### 12.3 定时序列

```mermaid
erDiagram
  sequences ||--o{ sequence_runs : ""
  groups ||--o{ sequence_runs : ""
  sequence_runs ||--o{ sequence_run_steps : ""
  sequence_run_steps |o--o| messages : "message_id"

  sequences {
    uuid id PK
    text name
    jsonb steps
  }
  sequence_runs {
    uuid id PK
    uuid group_id FK "running 时每群唯一"
    text status "running | finished | failed | stopped"
    int current_step_index
    jsonb vars
    jsonb step_vars
  }
  sequence_run_steps {
    bigint id PK
    uuid run_id FK
    int index
    text status "pending | accepted | sent | skipped | failed"
    timestamptz scheduled_at "只有当前步有值"
    timestamptz sent_at
    jsonb resolved_vars
    jsonb var_sources
  }
```

### 12.4 认证

```mermaid
erDiagram
  users ||--o{ sessions : "登录"
  sessions ||--o{ refresh_tokens : "轮换链"
  refresh_tokens |o--o| refresh_tokens : "replaced_by"

  users {
    uuid id PK
    text username UK
    text role "admin | viewer"
  }
  sessions {
    uuid id PK
    uuid user_id FK
    timestamptz revoked_at "吊销即全部 token 失效"
  }
  refresh_tokens {
    uuid id PK
    uuid session_id FK
    text token_hash UK "只存哈希"
    timestamptz used_at "重用即作废会话"
  }
  revoked_access_tokens {
    uuid jti PK
    timestamptz expires_at
  }
```

### 12.5 基础设施表

| 表 | 作用 | 关键约束 |
|---|---|---|
| `gateway_events` | 网关事件收件箱（原始帧按字节保存） | `event_id` 主键去重；`status` pending / done / failed |
| `kv` | 事件续传点等键值 | `key` 主键 |
| `scheduled_tasks` | 持久化定时任务 | `(kind, ref)` 唯一；`version` 检测执行中的重排；租约 |
| `ws_outbox` | 推送事件 | 业务事务写入；`seq` 发布时分配、唯一 |
| `ws_seq_state` | seq 计数器 | 单行 |
| `schema_migrations` | 已执行的迁移 | 版本号 + 校验和 |

---

## 13. 前端架构

```mermaid
flowchart TB
  subgraph PAGES["页面"]
    direction LR
    P1["登录"]
    P2["账号列表"]
    P3["群列表 · 群详情<br/>（时间线、成员、agent run、发消息）"]
    P4["Agent run 详情"]
    P5["序列 · 序列运行"]
  end

  subgraph STATE["状态"]
    direction LR
    AUTH["AuthProvider<br/>用户与角色（viewer 不渲染写操作）"]
    QC["TanStack Query 缓存"]
    TL["时间线状态<br/>按行 id 合并，(sentAt,id) 排序"]
  end

  subgraph NET["网络"]
    direction LR
    HC["HttpClient<br/>access token 只在内存<br/>401 → 单次 refresh（single flight）<br/>跨标签页 Web Locks + BroadcastChannel"]
    RC["RealtimeClient<br/>sinceSeq 补发 · seq 去重<br/>心跳超时重建 · online/visible 立即重连"]
  end

  SHARED["@gmp/shared<br/>DTO 类型 · 账号转移表 · resolveSequence"]
  API["/api/*"]
  WSE["/ws"]

  PAGES --> AUTH
  PAGES --> QC
  P3 --> TL
  QC --> HC --> API
  RC --> WSE
  RC -- "事件 → 失效对应查询" --> QC
  RC -- "message 事件" --> TL
  HC -- "新 token" --> RC
  P2 -. "按钮显隐" .-> SHARED
  P5 -. "预检" .-> SHARED
```

---

## 14. 登录会话

```mermaid
sequenceDiagram
  autonumber
  participant B as 浏览器
  participant API as /api/auth
  participant DB as sessions / refresh_tokens

  B->>API: POST /login
  API->>DB: 新会话 + refresh token（存哈希）
  API-->>B: {accessToken}（15 分钟）+ Set-Cookie rt（HttpOnly）
  Note over B: 请求遇到 401（access token 过期）
  B->>API: POST /refresh（cookie rt1）
  API->>DB: rt1 标记已用，签发 rt2
  API-->>B: 新 accessToken + Set-Cookie rt2
  alt 已用过的 rt1 再次出现（被盗或重放）
    B->>API: POST /refresh（cookie rt1）
    API->>DB: 吊销整个会话
    API-->>B: 401，该会话之前换出的 rt2 与所有 access token 立即失效
  end
  B->>API: POST /logout
  API->>DB: 吊销会话 + 记录 jti
  Note over API: 每个请求都校验会话与 jti，登出立即生效
```
