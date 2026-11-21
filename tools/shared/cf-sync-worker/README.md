# Cloudflare Worker + D1 云同步服务

为 `MyList`、`MyMind` 等个人静态网页工具提供低延迟、强一致的云端同步后端（基于 Cloudflare Workers + D1 轻量 SQLite），免费额度即可满足个人长期使用（Worker 10 万次/天，D1 500 万读 + 10 万写/天）。

同时已预留 `push_subscriptions` 与 `reminder_logs` 表，以及每份同步文档的 `timezone` 字段，后续可直接在此 Worker 上加 Cron Trigger 实现 iOS 定时提醒推送。

---

## 方式一：Cloudflare 网页控制台部署（零命令行，推荐）

1. **创建 D1 数据库**
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 左侧 **Storage & Databases → D1 SQL Database** → **Create**。
   - 名称填 `roland-tools-sync` → 创建完成（无需手动建表，`worker.js` 会在首次请求时自动初始化）。

2. **创建 Worker**
   - 左侧 **Compute (Workers) → Workers & Pages → Create → Start with Hello World!**。
   - 命名（如 `roland-tools-sync`）→ **Deploy** → 点击 **Edit code**。
   - 用本目录下的 [`worker.js`](./worker.js) 全文替换默认代码 → **Deploy**。

3. **绑定 D1 与访问密钥**
   - 进入该 Worker 的 **Settings → Bindings → Add** → 选择 **D1 database**：
     - Variable name: `DB`（必须为大写 `DB`）
     - D1 database: 选择刚创建的 `roland-tools-sync`
   - 在 **Settings → Variables and Secrets → Add**：
     - Type 选 **Secret**
     - Variable name: `SYNC_TOKEN`
     - Value: 填一串你自定义的强随机密钥（如用终端 `openssl rand -base64 32` 生成）
   - （可选）添加普通变量 `ALLOWED_ORIGIN`，设为你的站点域名（如 `https://rolandzhou.xyz`）以收紧 CORS。

4. **在网页端连接**
   - 复制 Worker 地址（如 `https://roland-tools-sync.<你的子域>.workers.dev`）。
   - 打开 **MyList** 或 **MyMind** → 点击云同步图标 → 填入 Worker 地址和 `SYNC_TOKEN` → 点击 **测试并连接**。
   - 手机等其他设备可直接用「复制配对链接」一键关联。

---

## 方式二：Wrangler CLI 部署

```bash
cd tools/shared/cf-sync-worker

# 1. 创建 D1 数据库（把输出的 database_id 填入 wrangler.toml）
npx wrangler d1 create roland-tools-sync

# 2. 初始化表结构（可选，Worker 冷启动也会自动建表）
npx wrangler d1 execute roland-tools-sync --remote --file=./schema.sql

# 3. 设置访问密钥
npx wrangler secret put SYNC_TOKEN

# 4. 部署 Worker
npx wrangler deploy
```

---

## API 概览

所有 `/api/*` 请求需携带 `Authorization: Bearer <SYNC_TOKEN>`：

- `GET /api/health`：验证密钥与 D1 连通性，返回已同步的应用摘要。
- `GET /api/sync/:appId`：拉取应用数据（支持 `If-None-Match` 条件请求返回 `304 Not Modified`）。
- `PUT /api/sync/:appId`：基于 `expectedVersion` 的原子乐观锁写入；若远端版本已变化则返回 `409 Conflict`，客户端自动拉取并执行字段级合并后重试。
