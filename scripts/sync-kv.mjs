#!/usr/bin/env node
/**
 * 将 data/menu.json 同步到 Cloudflare KV。
 *
 * 键格式：menu:<category-id>  →  分类 JSON（与 Workers 读取逻辑一致）
 * 行为：
 *   1. 批量写入全部分类键（PUT /bulk，单批最多 1000 个键）
 *   2. 清理已不在菜单中的旧分类键，保证 KV 与数据文件一致
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   必填，Cloudflare API Token（需有 KV 读写权限）
 *   CLOUDFLARE_ACCOUNT_ID  必填，账户 ID
 *   KV_NAMESPACE_ID        必填，KV 命名空间 ID
 *   KV_SYNC_DRY_RUN        可选，设为 1 时只打印计划、不实际写入
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MENU_KEY_PREFIX = "menu:";
const MAX_BATCH = 1000;
const BASE = "https://api.cloudflare.com/client/v4";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const namespaceId = process.env.KV_NAMESPACE_ID;
const dryRun = process.env.KV_SYNC_DRY_RUN === "1";

if (!token || !accountId || !namespaceId) {
  console.error(
    "[sync-kv] 缺少环境变量：CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / KV_NAMESPACE_ID"
  );
  process.exit(1);
}

const menu = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "menu.json"), "utf8")
);

// 键设计：menu:restaurant 存餐厅信息，menu:<分类id> 存分类
const RESTAURANT_KEY = `${MENU_KEY_PREFIX}restaurant`;

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function checkAuth() {
  const res = await fetch(`${BASE}/user/tokens/verify`, { headers });
  const data = await res.json();
  if (!data.success) {
    console.error(
      `[sync-kv] API Token 校验失败：${JSON.stringify(data.errors || data)}`
    );
    process.exit(1);
  }
}

async function bulkPut(entries) {
  for (let i = 0; i < entries.length; i += MAX_BATCH) {
    const batch = entries.slice(i, i + MAX_BATCH);
    const res = await fetch(
      `${BASE}/accounts/${accountId}/kv/namespaces/${namespaceId}/bulk`,
      { method: "PUT", headers, body: JSON.stringify(batch) }
    );
    const data = await res.json();
    if (!data.success) {
      console.error(`[sync-kv] 批量写入失败（第 ${i / MAX_BATCH + 1} 批）：`);
      console.error(JSON.stringify(data.errors || data, null, 2));
      process.exit(1);
    }
    console.log(`[sync-kv] 已写入 ${batch.length} 个键（${batch[0].key} …）`);
  }
}

async function listKeys(prefix) {
  const keys = [];
  let cursor = null;
  do {
    const url =
      `${BASE}/accounts/${accountId}/kv/namespaces/${namespaceId}/keys?prefix=${encodeURIComponent(prefix)}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (!data.success) {
      console.error(`[sync-kv] 列出键失败：${JSON.stringify(data.errors || data)}`);
      process.exit(1);
    }
    keys.push(...(data.result || []));
    cursor = data.result_info?.cursors?.after ?? null;
  } while (cursor);
  return keys;
}

async function deleteKey(key) {
  const res = await fetch(
    `${BASE}/accounts/${accountId}/kv/namespaces/${namespaceId}/keys/${encodeURIComponent(key)}`,
    { method: "DELETE", headers }
  );
  const data = await res.json();
  if (!data.success) {
    console.warn(`[sync-kv] 删除键 ${key} 失败：${JSON.stringify(data.errors || data)}`);
  }
}

async function main() {
  if (!dryRun) {
    await checkAuth();
  }

  const entries = [
    { key: RESTAURANT_KEY, value: JSON.stringify(menu.restaurant) },
    ...menu.categories.map((cat) => ({
      key: `${MENU_KEY_PREFIX}${cat.id}`,
      value: JSON.stringify(cat),
    })),
  ];

  const dishCount = menu.categories.reduce((n, c) => n + c.items.length, 0);
  console.log(
    `[sync-kv] ${dryRun ? "[DRY-RUN] " : ""}菜单「${menu.restaurant.name}」` +
      `共 ${menu.categories.length} 个分类、${dishCount} 道菜，` +
      `将写入 ${entries.length} 个键（含餐厅信息键）`
  );

  if (dryRun) {
    console.log("[sync-kv] 待写入键：", entries.map((e) => e.key).join(", "));
    return;
  }

  await bulkPut(entries);

  // 清理失效键：KV 中 menu:* 但数据文件里已不存在的分类
  const existing = await listKeys(MENU_KEY_PREFIX);
  const keep = new Set(entries.map((e) => e.key));
  const stale = existing.map((k) => k.name).filter((k) => !keep.has(k));
  for (const key of stale) {
    await deleteKey(key);
    console.log(`[sync-kv] 已清理失效键 ${key}`);
  }

  console.log(
    `[sync-kv] 同步完成：写入 ${entries.length} 个键，清理 ${stale.length} 个键`
  );
}

main().catch((err) => {
  console.error("[sync-kv] 异常：", err);
  process.exit(1);
});
