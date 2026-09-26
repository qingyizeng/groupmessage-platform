# 多账号群组消息平台

后端 Node.js + TypeScript + PostgreSQL，前端 React 18 + TypeScript。设计文档见 [docs/architecture.md](docs/architecture.md)。

## 目录

| 目录 | 内容 |
|---|---|
| `apps/server` | 后端服务（Fastify + pg + ws） |
| `apps/mock-gateway` | 模拟消息网关（HTTP + SSE），带故障注入的 `/_control` 接口 |
| `apps/mock-agent` | 模拟 Agent 服务：默认是一个规则 agent，也可以按剧本逐轮返回任意响应 |
| `apps/web` | 控制台前端（Vite + React 18 + TanStack Query + antd） |
| `e2e` | Playwright 端到端测试 |
| `packages/shared` | 前后端共享的类型、账号状态转移表、错误码、WS 事件类型 |
| `docs/` | 架构设计 |

## 本地运行

需要 Node.js ≥ 22、pnpm 10、Docker。

```bash
pnpm install
cp .env.example .env
pnpm db:up                 # 启动 PostgreSQL（宿主机端口 55432）
pnpm migrate               # 执行数据库迁移（可重复执行）
pnpm dev:gateway           # 启动模拟网关，http://localhost:4001
pnpm dev:agent             # 启动模拟 Agent 服务，http://localhost:4002
pnpm dev:web               # 启动控制台开发服务器，http://localhost:5173（/api 与 /ws 代理到后端）
pnpm dev:server            # 启动后端，http://localhost:3000
```

### 用 Docker 运行

```bash
docker compose up --build        # postgres + 模拟网关 + 模拟 Agent + 后端（含控制台），访问 http://localhost:3000
```

- 应用镜像默认基于 `node:latest`（已在 Node 26 上验证），可用 `NODE_IMAGE` 改成其他 Node 镜像（≥ 22）。
- 国内网络可指定 npm 源：`NPM_REGISTRY=https://registry.npmmirror.com docker compose build`。
- 宿主机端口可通过 `SERVER_HOST_PORT` / `GATEWAY_HOST_PORT` / `AGENT_HOST_PORT` / `POSTGRES_HOST_PORT` 修改；模拟网关默认真实时延，`MOCK_TIMINGS=fast` 切换为快速模式。
- 另起一套互不干扰的环境并跑端到端测试：

  ```bash
  export POSTGRES_HOST_PORT=55433 SERVER_HOST_PORT=3100 GATEWAY_HOST_PORT=4101 AGENT_HOST_PORT=4102
  docker compose -p gmp-e2e up -d --build
  E2E_EXTERNAL=1 E2E_BASE_URL=http://localhost:3100 E2E_GATEWAY_URL=http://localhost:4101 pnpm test:e2e
  docker compose -p gmp-e2e down -v
  ```

后端在 `apps/web/dist` 存在时会直接托管控制台（`pnpm build:web` 之后访问 http://localhost:3000 即可），前端路由刷新也能正常打开。

预置数据：用户 `admin/admin`（全部权限）、`viewer/viewer`（只读）；服务账号 `acc_01` … `acc_08`（初始 `idle`）。

> 如果 Docker 无法访问 Docker Hub，可以先从镜像站拉取再打本地标签，例如：
> `docker pull docker.m.daocloud.io/library/postgres:16-alpine && docker tag docker.m.daocloud.io/library/postgres:16-alpine postgres:16-alpine`

### 模拟网关

- 默认使用接近题目描述的时延（send 的 202 需要 1–2 秒等）。设 `MOCK_TIMINGS=fast` 可切换为毫秒级时延，便于开发。
- 模拟网关的状态只在内存中，重启后之前建的群都会消失；它的事件 id 以启动时间为基数，重启后仍然单调递增，所以后端不会把新事件误当成已处理过的旧事件。
- 故障注入：`POST /_control/faults`，例如让下一次 send 返回 504 但消息 1.5 秒后仍然落地：

  ```bash
  curl -X POST localhost:4001/_control/faults -H 'content-type: application/json' \
    -d '{"endpoint":"send","action":{"type":"timeout","effect":true,"landAfterMs":1500}}'
  ```

- 其他控制接口：`/_control/config`（事件重复推送、乱序窗口、时延）、`/_control/accounts/:id/terminal`（停用账号）、`/_control/groups/:id/external-message`（外部用户发言）、`/_control/events/disconnect-all`（断开事件流）、`GET /_control/state`（查看内部状态与调用记录）。完整列表见 `apps/mock-gateway/src/gateway.ts`。

### 模拟 Agent 服务

- 默认行为：先 `get_recent_messages`，再用 `send_message` 回复"收到：<最后一条触发消息>"并 `finish`；触发消息含"广告"/"spam"且群开启了自动踢人时改为 `kick_user`。
- 剧本：`POST /_control/scripts {"groupId": "...", "turns": [...]}` 为该群的下一次 run 排好每一轮的响应，例如：

  ```bash
  curl -X POST localhost:4002/_control/scripts -H 'content-type: application/json' -d '{
    "groupId": "<群 id>",
    "turns": [ {"raw": "not json"}, {"toolUse": {"name": "do_magic", "input": {}}}, {"endTurn": "bye"} ]
  }'
  ```

  每一轮可以是 `raw`（原样返回的响应体，可配 `status`）、`toolUse`、`endTurn`、`delayMs`、`hang`。
- 审计：`POST /_control/audits {"groupId"?: "...", "steps": [{"verdict": "fail"}, {"status": 500}, {"hang": true}]}`，未排剧本时一律 `pass`。

## 测试

```bash
pnpm db:up
pnpm test           # 每个测试文件使用独立的临时数据库和进程内的模拟网关
```

端到端测试会自己起一套隔离环境（数据库 `gmp_e2e`，端口 3100 / 4101 / 4102），使用本机安装的 Google Chrome（无需下载浏览器；其他浏览器可设 `E2E_CHANNEL`）：

```bash
pnpm db:up
pnpm test:e2e
```

设置 `ENABLE_TEST_HOOKS=true` 时，后端会暴露 `POST /api/_test/failpoints`（仅 admin），可以在演示时注入数据库写入失败等故障。

## 数据库迁移

- 迁移文件在 `apps/server/migrations/NNNN_*.sql`，由 `pnpm migrate` 按序执行；用 advisory lock 串行化，已执行的会跳过，可以重复、并发执行。
- 已执行的迁移文件被修改时，迁移会因校验和不一致而报错。
- 服务启动时比较数据库 schema 版本与代码需要的版本，数据库落后则拒绝启动（退出码 1）。
