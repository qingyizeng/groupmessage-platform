# 多账号群组消息平台

多账号群组消息平台的后端与操作控制台：把服务账号连到消息网关并维护状态，把群消息记成可靠的时间线，按定时序列发送消息，接入一个通过工具调用工作的自动应答 agent，操作员在网页控制台实时查看和管理。

- 后端：Node.js + TypeScript + PostgreSQL（Fastify、node-postgres、ws）
- 前端：React 18 + TypeScript + Vite（TanStack Query、antd）
- 设计文档：[docs/architecture.md](docs/architecture.md)（架构、数据模型、各流程的一致性设计、需求歧义与取舍）

## 快速开始

### 用 Docker（推荐）

```bash
docker compose up --build
```

启动 PostgreSQL、模拟网关、模拟 Agent 服务和后端（后端同时托管控制台）。打开 http://localhost:3000 ，用 `admin/admin`（全部权限）或 `viewer/viewer`（只读）登录。

- 应用镜像默认基于 `node:latest`（已在 Node 26 上验证），可用 `NODE_IMAGE` 换成其他 Node（≥ 22）镜像。
- 国内网络可指定 npm 源：`NPM_REGISTRY=https://registry.npmmirror.com docker compose build`。若 Docker Hub 不可达，可先从镜像站拉取再打本地标签，例如 `docker pull docker.m.daocloud.io/library/postgres:16-alpine && docker tag docker.m.daocloud.io/library/postgres:16-alpine postgres:16-alpine`。
- 模拟网关默认使用接近题目描述的真实时延（send 的 202 需要 1–2 秒等）；`MOCK_TIMINGS=fast` 切换为毫秒级。
- 宿主机端口可用 `SERVER_HOST_PORT` / `GATEWAY_HOST_PORT` / `AGENT_HOST_PORT` / `POSTGRES_HOST_PORT` 修改。

### 本地开发

需要 Node.js ≥ 22、pnpm 10、Docker（仅用于 PostgreSQL）。

```bash
pnpm install
cp .env.example .env
pnpm db:up           # PostgreSQL，宿主机端口 55432
pnpm migrate         # 数据库迁移（可重复执行）
pnpm dev:gateway     # 模拟网关       http://localhost:4001
pnpm dev:agent       # 模拟 Agent     http://localhost:4002
pnpm dev:server      # 后端           http://localhost:3000
pnpm dev:web         # 控制台开发服务器 http://localhost:5173（/api、/ws 代理到后端）
```

`pnpm build:web` 之后后端会直接托管控制台，前端路由刷新也能打开。

### 演示路径

1. 账号页：把几个账号"重连"为 online。
2. 群组页：建群（选群主和成员，第一个成员会被提升为管理员），可以看到建群任务的进度。
3. 群详情：以某个账号发消息，观察 `queued → accepted → sent`；打开 Agent 开关后，用模拟网关让外部用户发言：

   ```bash
   curl -X POST localhost:4001/_control/groups/<网关群 id>/external-message \
     -H 'content-type: application/json' -d '{"platformUserId":"pu_visitor","text":"几点开会？"}'
   ```

   agent 会读消息、回复并结束，右侧出现 agent run，点进去看每一步。
4. 序列页：新建序列（预填了题目中的示例），填写 vars / stepVars，预检后启动，运行页实时显示进度。
5. 故障演示：用模拟网关的 `/_control/faults` 注入 504、429、群不可写等（见下文），观察消息状态、账号状态和 `inconsistency` 通知。

## 需求完成情况

A、B、C 三组全部完成。每一项的主要实现位置和验证它的测试：

| 需求 | 实现 | 验证 |
|---|---|---|
| A0 迁移可重复、schema 落后拒绝启动、错误格式、viewer 只读 | `apps/server/src/db/migrate.ts`、`http/errors.ts`、`http/authGuard.ts` | `test/migrate.test.ts`、`test/auth.test.ts` |
| A1 账号状态机、CAS、终态后果、限流到期 | `domain/accounts/transitions.ts`（唯一的状态变更入口） | `test/accounts.test.ts`、`test/delivery.test.ts` |
| A2 出站状态机、504 核对与最多一次重发、限流排队、错误处理、事件去重与补拉、写库失败不丢事件 | `domain/messages/delivery.ts`、`outbound.ts`、`inbound.ts`、`events/ingest.ts`、`events/inboxProcessor.ts` | `test/delivery.test.ts`、`test/events.test.ts`、`test/crash.test.ts`（真实进程 `kill -9`） |
| A3 / B2 建群、leave-all | `domain/jobs/createGroupJob.ts`、`leaveAllJob.ts`（可断点续跑的任务） | `test/groups.test.ts` |
| A4 游标分页、WS 推送 | `domain/messages/messageService.ts`、`realtime/*` | `test/timeline.test.ts`、`test/ws.test.ts` |
| A5 Agent 接入（触发、循环与上限、协议错误、审计、幂等、恢复、取消） | `domain/agent/*` | `test/agent.test.ts`、`test/agentRecovery.test.ts`、`test/agentCrash.test.ts`（真实进程 `kill -9`）、`test/protocol.test.ts` |
| A6 前端页面 1–3 | `apps/web/src/pages/*` | `e2e/tests/console.spec.ts` |
| B1 定时序列 + 页面 5 | `packages/shared/src/sequences.ts`（前后端共用的变量解析）、`domain/sequences/sequenceEngine.ts`、`SequencesPage.tsx` | `test/sequences.test.ts`、`packages/shared/src/sequences.test.ts`、`e2e/tests/sequences.spec.ts` |
| B3 refresh 轮换与重用检测、登出、前端自动续期 | `domain/auth/authService.ts`、`apps/web/src/api/http.ts` | `test/auth.test.ts`、`apps/web/src/api/http.test.ts` |
| B4 断线补齐、agent 步骤详情（页面 4） | `realtime/wsHub.ts`、`apps/web/src/realtime/ws.ts`、`AgentRunPage.tsx` | `test/ws.test.ts`、`apps/web/src/realtime/ws.test.ts`、e2e |
| C1 媒体下载与定期清理 | `domain/media/mediaService.ts` | `test/media.test.ts` |
| C2 接入真实 LLM | `apps/llm-agent`（Claude，接口与 2.2 相同） | `apps/llm-agent/test`、`test/llmAgent.test.ts`（平台 ↔ 适配器全链路） |
| C3 Playwright 端到端 | `e2e/` | 登录 → 建群 → 发消息 → agent run 步骤；序列预检与运行 |

典型场景 S1–S8 均有对应的自动化测试：S1–S4 在 `delivery.test.ts`，S5、S6 在 `agent.test.ts`，S7、S8 在 `sequences.test.ts`。

## 架构要点

详见 [docs/architecture.md](docs/architecture.md)，这里只列最关键的几条：

- **PostgreSQL 是唯一事实来源，先写库再调外部。** 进程内没有必须保留的状态；所有后台工作（事件处理、发送、定时任务、建群任务、agent run）都从数据库领取，用 `SKIP LOCKED` 或租约协调，重启后接着做，多实例部署也成立。
- **收口函数。** 账号状态、出站消息状态、群不可达各有唯一的变更入口，后果（取消排队消息、跳过序列步骤、停止 agent、推送事件）在同一事务里完成，"从任何来源进入终态结果都一样、要么全生效要么全不生效"由结构保证。
- **事件收件箱。** 原始事件按 `eventId` 主键落库（去重），续传点永远不越过未落库的事件（网关保留全部历史即是持久日志）；处理器与到达顺序无关，失败的事件带退避重试并推 `inconsistency`，不阻塞其他事件。
- **出站消息只在"确认没发出"后重发，且最多一次。** 504、我方超时和进程在请求途中崩溃都视为结果未知，等网关 2 秒收敛窗口后按 `clientMsgId` 核对。
- **Agent run 每一步两次落库**（响应分类、工具结果）加工具执行记录，崩溃后用同一个 runId 续跑：已入队的消息只观察不重发，踢人前先核对成员列表，审计结论不会重复获取。
- **WS 事件走事务性 outbox，seq 由单一发布者在提交后分配**，所以推送的状态一定已保存，seq 连续不跳号，断线后按 `sinceSeq` 补发。

## 模拟服务

### 模拟网关（`apps/mock-gateway`）

按题目 2.1 完整实现（包括时序），状态只在内存中；事件 id 以启动时间为基数，重启后仍单调递增。控制接口：

| 接口 | 作用 |
|---|---|
| `POST /_control/faults` | 注入故障，如 `{"endpoint":"send","action":{"type":"timeout","effect":true,"landAfterMs":1500}}`。动作：`error`、`timeout`（可带效果）、`delay`、`hang`、`fail_after_accept`、`never_join`、`already_member`、`rate_limit` |
| `POST /_control/config` | 事件重复推送、乱序窗口、时延 |
| `POST /_control/accounts/:id/terminal` | 停用账号（可选是否推 `account_status`） |
| `POST /_control/groups/:id/external-message` | 外部用户发言（可带媒体文件） |
| `POST /_control/groups/:id/writable` | 让群不可写 |
| `POST /_control/events/disconnect-all` | 断开事件流 |
| `GET /_control/state` | 内部状态与调用记录 |

### 模拟 Agent（`apps/mock-agent`）

- 默认是一个规则 agent：先读消息，再回复"收到：…"并结束；触发消息含"广告"/"spam"且群开启自动踢人时改为踢人。
- `POST /_control/scripts {"groupId":"…","turns":[…]}` 为该群的下一次 run 逐轮排好响应：`raw`（原样返回，可配 `status`，用来模拟坏 JSON、代码围栏）、`toolUse`、`endTurn`、`delayMs`、`hang`。
- `POST /_control/audits {"groupId"?:"…","steps":[{"verdict":"fail"},{"status":500},{"hang":true}]}` 排审计结果；未排时一律 `pass`。

## 接入真实 LLM（C2）

`apps/llm-agent` 是一个独立服务，对外接口与模拟 Agent 完全相同（`POST /agent/turn`、`POST /agent/audit`），内部调用 Claude：

- 默认模型 `claude-opus-5`（`LLM_MODEL` 可改），推理强度默认 `low`（`LLM_EFFORT`），因为平台给每轮 10–15 秒。
- `tool_choice: auto` + `disable_parallel_tool_use`，并把响应规范化为恰好一个块。
- 平台每轮只回传一个 tool_use 块，适配器按 tool_use id 缓存完整的 assistant 内容，下一轮把 thinking 块原样放回。
- 审计用结构化输出（JSON Schema）得到 `{verdict, reason}`；拿不到明确结论时返回 503，由平台重试。
- 开启了服务端拒答回退（`fallbacks: "default"`），被安全分类器拒绝时由服务端换模型重跑。

凭证从环境读取（`ANTHROPIC_API_KEY`，或 `ant auth login` 的配置）：

```bash
ANTHROPIC_API_KEY=… pnpm dev:llm-agent                       # http://localhost:4003
AGENT_URL=http://localhost:4003 pnpm dev:server              # 后端只改 AGENT_URL 即可切换
# 或者用 Docker：
ANTHROPIC_API_KEY=… SERVER_AGENT_URL=http://llm-agent:4003 docker compose --profile llm up
```

自动化测试用桩替代 Claude 客户端，不会产生 API 费用。

## 测试

```bash
pnpm db:up
pnpm test        # 单元 + 集成测试；每个测试文件使用独立的临时数据库和进程内模拟服务
pnpm test:e2e    # Playwright 端到端测试：自动起一套隔离环境（数据库 gmp_e2e，端口 3100/4101/4102）
```

- 端到端测试使用本机安装的 Google Chrome（无需下载浏览器；其他浏览器可设 `E2E_CHANNEL`）。
- 对运行中的 Docker 环境跑端到端测试：

  ```bash
  export POSTGRES_HOST_PORT=55433 SERVER_HOST_PORT=3100 GATEWAY_HOST_PORT=4101 AGENT_HOST_PORT=4102
  docker compose -p gmp-e2e up -d --build
  E2E_EXTERNAL=1 E2E_BASE_URL=http://localhost:3100 E2E_GATEWAY_URL=http://localhost:4101 pnpm test:e2e
  docker compose -p gmp-e2e down -v
  ```

- `test/crash.test.ts` 和 `test/agentCrash.test.ts` 把后端作为子进程启动，在发送和 agent run 进行中随机 `kill -9` 多次，校验数据库与网关的一致性。
- 设置 `ENABLE_TEST_HOOKS=true` 时，后端暴露 `POST /api/_test/failpoints`（仅 admin），可在演示时注入数据库写入失败等故障。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `DATABASE_URL` / `GATEWAY_URL` / `AGENT_URL` | 3000 / — / localhost:4001 / localhost:4002 | 题目约定 |
| `JWT_SECRET` | 开发用默认值 | 生产环境务必设置 |
| `INSTANCE_ID` | `hostname:port` | 多实例部署时每个实例须不同（用于租约） |
| `GATEWAY_SEND_TIMEOUT_MS` | 8000 | 我方 send 请求超时（超时视为结果未知） |
| `JOIN_TIMEOUT_MS` | 10000 | 等待 `member_joined` 的时长 |
| `AGENT_TURN_TIMEOUT_MS` / `AGENT_RUN_WALL_MS` / `AGENT_MAX_STEPS` | 12000 / 60000 / 12 | agent 每轮超时、总时长、步数上限 |
| `AGENT_AUDIT_TIMEOUT_MS` / `AGENT_SEND_WAIT_MS` | 5000 / 5000 | 单次审计超时、send_message 等待确认的时长 |
| `MEDIA_DIR` / `MEDIA_RETENTION_DAYS` / `MEDIA_CLEANUP_INTERVAL_MS` | `<repo>/media` / 30 / 1 小时 | 媒体文件目录、保留天数、清理间隔 |
| `WS_PING_MS` / `WS_RETENTION_HOURS` | 15000 / 24 | WS 心跳间隔；推送事件可补发的保留时长（更早的断点会要求前端全量刷新） |
| `MAINTENANCE_INTERVAL_MS` | 10 分钟 | 定期清理：过期的 WS 事件、已处理超过 7 天且位于续传点之前的网关事件、过期的 token 吊销记录 |
| `COOKIE_SECURE` | false | HTTPS 部署时设为 true |

## 数据库迁移

- 迁移文件在 `apps/server/migrations/NNNN_*.sql`，`pnpm migrate` 按序执行；advisory lock 串行化，已执行的跳过，可重复、并发执行；已执行的文件被改动会因校验和不一致而报错。
- 服务启动时比较数据库 schema 版本与代码需要的版本，数据库落后则拒绝启动（退出码 1）。Docker 中后端启动前会自动迁移。

## 已知限制

- 网关的建群没有幂等键：若在"网关已建群、我方尚未保存"的瞬间崩溃，续跑会再建一个群，旧的成为孤儿群（已尽量缩小窗口：建群成功后本地保存会单独重试）。
- 504 后确认未发出再重发时，若重发请求本身很慢，状态会在 `unknown` 停留超过 5 秒——在确认未发出之前不能重发，这一约束优先。
- 模拟网关状态只在内存中；重启模拟网关后需要重新连接账号、重新建群。
- agent run 的 60 秒从执行器领取 run 时开始计时（创建后立即被唤醒领取，通常只差几十毫秒）；这样重启后的停机时间才能准确地不计入。
- 媒体清理对"仍被运行中的 agent run 用到"的判断是按群：群里有运行中的 run 时本轮不删该群的文件，run 结束后的下一轮再删。
- LLM 适配器的 thinking 块缓存在进程内存中；适配器重启后，正在进行的 run 下一轮不带之前的 thinking 块。
- 题目中没有写明、由我自行决定的行为，逐条列在 [docs/architecture.md §11](docs/architecture.md)。
