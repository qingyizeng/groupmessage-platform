# 多账号群组消息平台

后端 Node.js + TypeScript + PostgreSQL，前端 React 18 + TypeScript。设计文档见 [docs/architecture.md](docs/architecture.md)。

## 目录

| 目录 | 内容 |
|---|---|
| `apps/server` | 后端服务（Fastify + pg） |
| `packages/shared` | 前后端共享的类型、账号状态转移表、错误码 |
| `docs/` | 架构设计 |

## 本地运行

需要 Node.js ≥ 22、pnpm 10、Docker。

```bash
pnpm install
cp .env.example .env
pnpm db:up          # 启动 PostgreSQL（宿主机端口 55432）
pnpm migrate        # 执行数据库迁移（可重复执行）
pnpm dev:server     # 启动后端，默认 http://localhost:3000
```

预置用户：`admin/admin`（全部权限）、`viewer/viewer`（只读）。

> 如果 Docker 无法访问 Docker Hub，可以先从镜像站拉取再打本地标签，例如：
> `docker pull docker.m.daocloud.io/library/postgres:16-alpine && docker tag docker.m.daocloud.io/library/postgres:16-alpine postgres:16-alpine`

## 测试

```bash
pnpm db:up
pnpm test           # 每个测试文件使用独立的临时数据库
```

## 数据库迁移

- 迁移文件在 `apps/server/migrations/NNNN_*.sql`，由 `pnpm migrate` 按序执行；用 advisory lock 串行化，已执行的会跳过，可以重复、并发执行。
- 已执行的迁移文件被修改时，迁移会因校验和不一致而报错。
- 服务启动时比较数据库 schema 版本与代码需要的版本，数据库落后则拒绝启动（退出码 1）。
