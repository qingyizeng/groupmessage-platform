# 多账号群组消息平台

后端 Node.js + TypeScript + PostgreSQL，前端 React 18 + TypeScript。设计文档见 [docs/architecture.md](docs/architecture.md)。

## 目录

| 目录 | 内容 |
|---|---|
| `apps/server` | 后端服务（Fastify + pg + ws） |
| `apps/mock-gateway` | 模拟消息网关（HTTP + SSE），带故障注入的 `/_control` 接口 |
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
pnpm dev:server            # 启动后端，http://localhost:3000
```

也可以用 `docker compose up --build` 一次启动 postgres、模拟网关和后端。

预置数据：用户 `admin/admin`（全部权限）、`viewer/viewer`（只读）；服务账号 `acc_01` … `acc_08`（初始 `idle`）。

> 如果 Docker 无法访问 Docker Hub，可以先从镜像站拉取再打本地标签，例如：
> `docker pull docker.m.daocloud.io/library/postgres:16-alpine && docker tag docker.m.daocloud.io/library/postgres:16-alpine postgres:16-alpine`

### 模拟网关

- 默认使用接近题目描述的时延（send 的 202 需要 1–2 秒等）。设 `MOCK_TIMINGS=fast` 可切换为毫秒级时延，便于开发。
- 故障注入：`POST /_control/faults`，例如让下一次 send 返回 504 但消息 1.5 秒后仍然落地：

  ```bash
  curl -X POST localhost:4001/_control/faults -H 'content-type: application/json' \
    -d '{"endpoint":"send","action":{"type":"timeout","effect":true,"landAfterMs":1500}}'
  ```

- 其他控制接口：`/_control/config`（事件重复推送、乱序窗口、时延）、`/_control/accounts/:id/terminal`（停用账号）、`/_control/groups/:id/external-message`（外部用户发言）、`/_control/events/disconnect-all`（断开事件流）、`GET /_control/state`（查看内部状态与调用记录）。完整列表见 `apps/mock-gateway/src/gateway.ts`。

## 测试

```bash
pnpm db:up
pnpm test           # 每个测试文件使用独立的临时数据库和进程内的模拟网关
```

设置 `ENABLE_TEST_HOOKS=true` 时，后端会暴露 `POST /api/_test/failpoints`（仅 admin），可以在演示时注入数据库写入失败等故障。

## 数据库迁移

- 迁移文件在 `apps/server/migrations/NNNN_*.sql`，由 `pnpm migrate` 按序执行；用 advisory lock 串行化，已执行的会跳过，可以重复、并发执行。
- 已执行的迁移文件被修改时，迁移会因校验和不一致而报错。
- 服务启动时比较数据库 schema 版本与代码需要的版本，数据库落后则拒绝启动（退出码 1）。
