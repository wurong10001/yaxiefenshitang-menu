# 云间小馆 · 饭店菜单（Cloudflare Workers + KV）

由 **Cloudflare Workers + Cloudflare KV** 驱动的饭店菜单站点，配套 **GitHub Actions 部署工作流**：推送 Git 仓库即自动部署 Worker 并同步菜单数据到 KV。

## 页面与接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | **公开菜单页**（服务端渲染，数据来自 KV） |
| `/menu` | GET | **菜单数据管理页**：增删改分类/菜品、编辑店名，保存即写入 KV |
| `/api/menu` | GET | 读取菜单 JSON |
| `/api/menu` | POST | 保存菜单到 KV（可选 `X-Admin-Token` 校验） |
| `/health` | GET | 健康检查 |

## 架构与 KV 设计

```
data/menu.json          ← 菜单数据（唯一数据源）
   │
   ├─ 管理页 /menu ──► POST /api/menu ─► KV（menu:restaurant + menu:<分类id>）
   │                                        ▲
   └─ 打包内置 src/index.ts（Worker）──────┘
        读取 KV，缺失时回退内置数据，SSR 渲染公开菜单页 /
```

KV 键格式（命名空间 `yaxiefenshitang-menu`，ID `921e0e9a45db4c20a7ca1dd149579a68`）：

- `menu:restaurant` → 餐厅信息（店名、标语、备注）
- `menu:<分类id>` → 分类 JSON（如 `menu:signature`）

Worker 按前缀列出全部键聚合渲染；KV 为空（首次部署未同步、本地开发）时回退到打包的内置菜单，保证开箱可用。保存菜单时会写入全部键并自动清理已删除的键，保持 KV 与管理页一致。

## 目录结构

```
├── data/menu.json              # 饭店菜单数据（6 分类 22 道菜，可自由编辑）
├── src/index.ts                # Workers：公开页 / 管理页 / API / KV 读写
├── scripts/sync-kv.mjs         # CLI 同步脚本（批量写入 + 清理失效键 + dry-run）
├── wrangler.toml               # Workers 配置与 KV 绑定（含命名空间 ID）
├── package.json
├── .github/workflows/deploy.yml # Git 推送触发的部署工作流
└── tsconfig.json
```

## Git 仓库部署方案

### 1. 初始化并推送仓库

```bash
git init -b main
git add .
git commit -m "init: 云间小馆菜单 (Workers + KV)"
git remote add origin <你的仓库地址>
git push -u origin main
```

### 2. 配置 GitHub 仓库密钥

**Settings → Variables and secrets：**

| 类型 | 名称 | 说明 |
|------|------|------|
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，需权限：Account → Workers Scripts（Edit）+ KV（Edit） |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| Variable | `KV_NAMESPACE_ID` | （可选）KV 命名空间 ID，默认 `921e0e9a45db4c20a7ca1dd149579a68` |
| Variable | `WORKER_URL` | （可选）部署后的访问地址，用于健康检查 |

> KV 命名空间 ID 已直接写入 `wrangler.toml`，通常无需再配置 `KV_NAMESPACE_ID`。

### 3. 推送即部署

任何对 `main` 分支的 push（或在 Actions 页面手动触发 **Deploy to Cloudflare**）都会执行：

1. `npm ci` 安装依赖 → `tsc` 类型检查
2. `wrangler deploy` 发布 Worker
3. `scripts/sync-kv.mjs` 将 `data/menu.json` 写入 KV（含餐厅信息键，并清理失效键）
4. 健康检查

部署完成后访问：
- 公开菜单：`https://<worker>.<subdomain>.workers.dev/`
- 管理后台：`https://<worker>.<subdomain>.workers.dev/menu`

## 管理菜单数据

打开 `/menu` 管理页即可可视化操作：编辑店名/标语/备注、添加/删除分类、添加/删除菜品（菜名、价格、描述、标签），点击「保存到 KV」即时生效，公开菜单页随之更新。

可选的写保护：在 Cloudflare 环境变量中设置 `MENU_ADMIN_TOKEN`（通过 `wrangler.toml` 的 `[vars]` 或 Dashboard → Settings → Variables 配置），之后 `POST /api/menu` 必须携带匹配的 `X-Admin-Token` 头，否则返回 401。

也可在命令行单独同步数据而不部署：

```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx KV_NAMESPACE_ID=921e0e9a45db4c20a7ca1dd149579a68 npm run kv:sync
```

预演（不实际写入）：

```bash
KV_SYNC_DRY_RUN=1 CLOUDFLARE_API_TOKEN=x CLOUDFLARE_ACCOUNT_ID=x KV_NAMESPACE_ID=921e0e9a45db4c20a7ca1dd149579a68 npm run kv:sync
```

## 本地开发

```bash
npm install
npm run dev        # wrangler dev 本地运行（KV 为空时自动使用内置菜单数据）
npm run typecheck  # 类型检查
```

> 注意：`wrangler dev` 需要 workerd 二进制，仅支持 Linux / macOS / Windows 桌面/服务器环境；Termux 等 Android 环境无法本地运行，但 CI（ubuntu-latest）部署不受影响。

## 验证记录

- `tsc --noEmit` 类型检查通过
- esbuild 打包通过
- 冒烟测试 18 项全部通过：公开页、管理页、KV 读写与失效键清理、店名持久化、令牌校验（未带/错误/正确）、非法数据 400、404/405、HTML 注入转义
- KV 同步脚本 dry-run 通过（7 个键：1 餐厅信息 + 6 分类）
