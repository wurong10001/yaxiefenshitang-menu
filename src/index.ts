import menuData from "../data/menu.json";

/** KV 键前缀：每个菜单分类存一个键，如 menu:signature */
const MENU_KEY_PREFIX = "menu:";

export interface MenuItem {
  name: string;
  price: number;
  desc?: string;
  tag?: string;
}

export interface MenuCategory {
  id: string;
  name: string;
  icon?: string;
  items: MenuItem[];
}

export interface MenuData {
  restaurant: { name: string; tagline: string; notice?: string };
  categories: MenuCategory[];
}

export interface Env {
  MENU_KV: KVNamespace;
  MENU_ADMIN_TOKEN?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 从 KV 读取完整菜单。
 * 餐厅信息存于 menu:restaurant，分类存于 menu:<分类id>。
 * KV 为空（首次部署未同步 / 本地开发）时回退到打包内置的默认菜单。
 */
async function loadMenu(env: Env): Promise<MenuData> {
  if (!env.MENU_KV) {
    return menuData;
  }
  const { keys } = await env.MENU_KV.list({ prefix: MENU_KEY_PREFIX });
  if (keys.length === 0) {
    return menuData;
  }

  // 餐厅信息（店名 / 标语 / 备注）
  let restaurant: MenuData["restaurant"] = menuData.restaurant;
  try {
    const r = await env.MENU_KV.get<MenuData["restaurant"]>(
      `${MENU_KEY_PREFIX}restaurant`,
      "json"
    );
    if (r && typeof r.name === "string") {
      restaurant = r;
    }
  } catch {
    // 餐厅信息键缺失或损坏时使用默认值
  }

  // 分类键（排除餐厅信息键）
  const catKeys = keys
    .map((k) => k.name)
    .filter((name) => name !== `${MENU_KEY_PREFIX}restaurant`)
    .sort();
  const categories: MenuCategory[] = [];
  for (const name of catKeys) {
    try {
      const parsed = await env.MENU_KV.get<MenuCategory>(name, "json");
      if (parsed && Array.isArray(parsed.items)) {
        categories.push(parsed);
      }
    } catch {
      // 单个键读取失败时跳过，不影响整体渲染
    }
  }
  return categories.length > 0 ? { restaurant, categories } : menuData;
}

/** 将完整菜单写入 KV：写入餐厅信息与各分类，并清理已删除的键 */
async function saveMenu(env: Env, menu: MenuData): Promise<void> {
  if (!env.MENU_KV) {
    throw new Error("MENU_KV 未绑定");
  }
  const restaurantKey = `${MENU_KEY_PREFIX}restaurant`;
  await env.MENU_KV.put(restaurantKey, JSON.stringify(menu.restaurant));

  const entries = menu.categories.map((cat) => ({
    key: `${MENU_KEY_PREFIX}${cat.id}`,
    value: JSON.stringify(cat),
  }));
  for (const { key, value } of entries) {
    await env.MENU_KV.put(key, value);
  }
  const { keys } = await env.MENU_KV.list({ prefix: MENU_KEY_PREFIX });
  const keep = new Set([restaurantKey, ...entries.map((e) => e.key)]);
  for (const { name } of keys) {
    if (!keep.has(name)) {
      await env.MENU_KV.delete(name);
    }
  }
}

/** 校验并规范化外部提交的菜单数据，防止脏数据写入 KV */
function normalizeMenu(raw: unknown): MenuData | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Partial<MenuData>;
  if (typeof input.restaurant?.name !== "string" || !input.restaurant.name) return null;
  if (!Array.isArray(input.categories)) return null;

  const categories: MenuCategory[] = [];
  for (const cat of input.categories) {
    if (typeof cat?.id !== "string" || !cat.id) return null;
    if (typeof cat.name !== "string" || !cat.name) return null;
    if (!Array.isArray(cat.items)) return null;
    const items: MenuItem[] = [];
    for (const it of cat.items) {
      if (typeof it?.name !== "string" || !it.name) return null;
      const price = Number(it.price);
      if (!Number.isFinite(price) || price < 0) return null;
      items.push({
        name: it.name,
        price,
        desc: typeof it.desc === "string" ? it.desc : undefined,
        tag: typeof it.tag === "string" ? it.tag : undefined,
      });
    }
    categories.push({
      id: cat.id,
      name: cat.name,
      icon: typeof cat.icon === "string" ? cat.icon : undefined,
      items,
    });
  }
  return {
    restaurant: {
      name: input.restaurant.name,
      tagline: typeof input.restaurant.tagline === "string" ? input.restaurant.tagline : "",
      notice:
        typeof input.restaurant.notice === "string"
          ? input.restaurant.notice
          : undefined,
    },
    categories,
  };
}

function renderItem(item: MenuItem): string {
  const tag = item.tag
    ? `<span class="tag">${escapeHtml(item.tag)}</span>`
    : "";
  const desc = item.desc
    ? `<p class="desc">${escapeHtml(item.desc)}</p>`
    : "";
  return `
      <div class="item">
        <div class="item-head">
          <h4>${escapeHtml(item.name)}${tag}</h4>
          <span class="price">¥${item.price}</span>
        </div>
        ${desc}
      </div>`;
}

function renderPage(menu: MenuData): string {
  const categories = menu.categories
    .map((cat) => {
      const items = cat.items.map(renderItem).join("");
      const icon = cat.icon ? `<span class="cat-icon">${cat.icon}</span>` : "";
      return `
      <section class="category">
        <h3>${icon}<span>${escapeHtml(cat.name)}</span></h3>
        ${items}
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(menu.restaurant.name)} · 菜单</title>
<meta name="description" content="${escapeHtml(menu.restaurant.tagline)}" />
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 16px 48px;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    background: #faf6f0; color: #2b2b2b;
    line-height: 1.6;
  }
  .hero { text-align: center; padding: 40px 16px 28px; }
  .hero h1 { margin: 0 0 6px; font-size: 34px; letter-spacing: 4px; }
  .hero .tagline { margin: 0; color: #8a6d3b; letter-spacing: 2px; }
  .hero .notice { margin: 10px 0 0; font-size: 13px; color: #999; }
  .topbar { text-align: center; margin-bottom: 18px; }
  .topbar a { color: #c0392b; text-decoration: none; font-size: 13px; }
  .menu {
    max-width: 720px; margin: 0 auto;
    background: #fff; border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,.06);
    padding: 20px 24px;
  }
  .category { border-bottom: 1px dashed #e5dccf; padding: 16px 0; }
  .category:last-child { border-bottom: none; }
  .category h3 {
    margin: 0 0 10px; font-size: 19px; color: #7a4a1d;
    display: flex; align-items: center; gap: 8px;
  }
  .cat-icon { font-size: 20px; }
  .item { padding: 7px 0; }
  .item-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .item-head h4 { margin: 0; font-size: 16px; font-weight: 600; }
  .price { color: #c0392b; font-weight: 700; white-space: nowrap; }
  .desc { margin: 2px 0 0; font-size: 13px; color: #888; }
  .tag {
    display: inline-block; margin-left: 8px; padding: 0 8px;
    font-size: 11px; font-weight: 600; color: #fff;
    background: #c0392b; border-radius: 999px; vertical-align: 1px;
  }
  .footer { text-align: center; margin-top: 24px; font-size: 12px; color: #aaa; }
</style>
</head>
<body>
  <header class="hero">
    <h1>${escapeHtml(menu.restaurant.name)}</h1>
    <p class="tagline">${escapeHtml(menu.restaurant.tagline)}</p>
    ${menu.restaurant.notice ? `<p class="notice">${escapeHtml(menu.restaurant.notice)}</p>` : ""}
  </header>
  <div class="topbar"><a href="/menu">⚙ 管理菜单数据</a></div>
  <main class="menu">${categories}</main>
  <p class="footer">菜单数据由 Cloudflare KV 实时驱动 · 更新菜品后重新部署即生效</p>
</body>
</html>`;
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>菜单数据管理 · 云间小馆</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 60px;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    background: #f4f5f7; color: #2b2b2b; line-height: 1.6;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin: 0 0 16px; }
  .topbar { text-align: right; margin-bottom: 14px; }
  .topbar a { color: #c0392b; text-decoration: none; font-size: 13px; }
  .card {
    background: #fff; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,.05);
    padding: 18px 20px; margin-bottom: 16px;
  }
  .card h3 { margin: 0 0 12px; font-size: 16px; color: #7a4a1d; }
  .field { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  .field label { width: 72px; font-size: 13px; color: #666; flex-shrink: 0; }
  input[type=text], input[type=number] {
    border: 1px solid #d5d8dd; border-radius: 6px; padding: 6px 9px; font-size: 14px;
    min-width: 0; flex: 1; font-family: inherit;
  }
  input:focus { outline: 2px solid #e8b27e; border-color: transparent; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row input[type=text] { flex: 1; }
  .item-row {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    background: #faf8f4; border-radius: 8px; padding: 8px; margin-bottom: 8px;
  }
  .item-row input[type=text] { flex: 1; min-width: 90px; }
  .item-row input[type=number] { width: 80px; flex: none; }
  button {
    border: none; border-radius: 6px; padding: 7px 14px; font-size: 14px;
    cursor: pointer; font-family: inherit; background: #7a4a1d; color: #fff;
  }
  button:hover { background: #66401a; }
  button.ghost { background: #eceff3; color: #555; }
  button.ghost:hover { background: #dde1e7; }
  button.danger { background: #c0392b; }
  button.danger:hover { background: #a93226; }
  button.small { padding: 4px 10px; font-size: 13px; }
  .cat-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .cat-head input[type=text] { flex: 1; }
  .cat-head .icon-in { width: 80px; flex: none; }
  .status { font-size: 14px; min-height: 20px; margin: 8px 0; }
  .status.ok { color: #1e8449; }
  .status.err { color: #c0392b; }
  .muted { color: #999; font-size: 12px; }
  .token-row { margin-top: 4px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar"><a href="/">← 返回菜单页</a></div>
  <h1>菜单数据管理</h1>
  <p class="sub">编辑分类与菜品，保存后写入 Cloudflare KV，菜单页即时生效。</p>

  <div class="card">
    <h3>餐厅信息</h3>
    <div class="field"><label>店名</label><input id="r-name" type="text" /></div>
    <div class="field"><label>标语</label><input id="r-tagline" type="text" /></div>
    <div class="field"><label>备注</label><input id="r-notice" type="text" /></div>
  </div>

  <div id="cats"></div>

  <div class="card">
    <button id="add-cat">+ 添加分类</button>
    <span class="muted">　分类 ID 将自动生成，用于 KV 键名</span>
  </div>

  <div class="card">
    <button id="save">保存到 KV</button>
    <div class="token-row">
      <div class="field"><label>管理令牌</label><input id="token" type="text" placeholder="如未开启令牌校验可留空" /></div>
    </div>
    <p class="status" id="status"></p>
  </div>
</div>

<script>
let state = null;
const $ = (id) => document.getElementById(id);

function setStatus(msg, ok) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + (ok === true ? "ok" : ok === false ? "err" : "");
}

function newCategory(name) {
  return {
    id: "cat-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name || "新分类",
    icon: "",
    items: [],
  };
}

function newItem() {
  return { name: "新菜品", price: 0, desc: "", tag: "" };
}

function renderRestaurant() {
  $("r-name").value = state.restaurant.name || "";
  $("r-tagline").value = state.restaurant.tagline || "";
  $("r-notice").value = state.restaurant.notice || "";
}

function renderCategories() {
  const box = $("cats");
  box.innerHTML = "";
  state.categories.forEach((cat, ci) => {
    const card = document.createElement("div");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "cat-head";
    head.innerHTML =
      '<input class="c-name" type="text" value="' + escapeAttr(cat.name) + '" placeholder="分类名称" />' +
      '<input class="c-icon icon-in" type="text" value="' + escapeAttr(cat.icon || "") + '" placeholder="图标" />' +
      '<span class="muted">ID: ' + escapeAttr(cat.id) + '</span>' +
      '<button class="danger small del-cat">删除分类</button>';
    head.querySelector(".c-name").addEventListener("input", (e) => (state.categories[ci].name = e.target.value));
    head.querySelector(".c-icon").addEventListener("input", (e) => (state.categories[ci].icon = e.target.value));
    head.querySelector(".del-cat").addEventListener("click", () => {
      if (confirm("删除分类「" + cat.name + "」及其全部菜品？")) {
        state.categories.splice(ci, 1);
        renderCategories();
      }
    });
    card.appendChild(head);

    const itemsBox = document.createElement("div");
    itemsBox.className = "items";
    cat.items.forEach((it, ii) => {
      const row = document.createElement("div");
      row.className = "item-row";
      row.innerHTML =
        '<input class="i-name" type="text" value="' + escapeAttr(it.name) + '" placeholder="菜名" />' +
        '<input class="i-price" type="number" min="0" step="0.5" value="' + it.price + '" placeholder="价格" />' +
        '<input class="i-desc" type="text" value="' + escapeAttr(it.desc || "") + '" placeholder="描述" />' +
        '<input class="i-tag" type="text" value="' + escapeAttr(it.tag || "") + '" placeholder="标签" />' +
        '<button class="ghost small del-item">删除</button>';
      row.querySelector(".i-name").addEventListener("input", (e) => (state.categories[ci].items[ii].name = e.target.value));
      row.querySelector(".i-price").addEventListener("input", (e) => (state.categories[ci].items[ii].price = Number(e.target.value) || 0));
      row.querySelector(".i-desc").addEventListener("input", (e) => (state.categories[ci].items[ii].desc = e.target.value));
      row.querySelector(".i-tag").addEventListener("input", (e) => (state.categories[ci].items[ii].tag = e.target.value));
      row.querySelector(".del-item").addEventListener("click", () => {
        state.categories[ci].items.splice(ii, 1);
        renderCategories();
      });
      itemsBox.appendChild(row);
    });
    card.appendChild(itemsBox);

    const addItem = document.createElement("button");
    addItem.className = "ghost small add-item";
    addItem.textContent = "+ 添加菜品";
    addItem.addEventListener("click", () => {
      state.categories[ci].items.push(newItem());
      renderCategories();
    });
    card.appendChild(addItem);

    box.appendChild(card);
  });
}

function escapeAttr(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function load() {
  setStatus("正在加载菜单数据…");
  try {
    const res = await fetch("/api/menu", { cache: "no-store" });
    state = await res.json();
    if (!state.restaurant) state.restaurant = { name: "", tagline: "" };
    if (!Array.isArray(state.categories)) state.categories = [];
    renderRestaurant();
    renderCategories();
    setStatus("已加载 " + state.categories.length + " 个分类，可开始编辑。");
  } catch (e) {
    setStatus("加载失败：" + e.message, false);
  }
}

async function save() {
  setStatus("正在保存…");
  try {
    state.restaurant.name = $("r-name").value;
    state.restaurant.tagline = $("r-tagline").value;
    state.restaurant.notice = $("r-notice").value;
    const headers = { "Content-Type": "application/json" };
    const token = $("token").value.trim();
    if (token) headers["X-Admin-Token"] = token;
    const res = await fetch("/api/menu", { method: "POST", headers, body: JSON.stringify(state) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "HTTP " + res.status);
    }
    const data = await res.json();
    setStatus("保存成功：已写入 " + data.saved + " 个分类键到 KV。", true);
  } catch (e) {
    setStatus("保存失败：" + e.message, false);
  }
}

$("add-cat").addEventListener("click", () => {
  state.categories.push(newCategory());
  renderCategories();
});
$("save").addEventListener("click", save);
load();
</script>
</body>
</html>`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, source: "cloudflare-workers" });
    }

    // 公开菜单页
    if (url.pathname === "/" ) {
      const menu = await loadMenu(env);
      return new Response(renderPage(menu), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "s-max-age=60",
        },
      });
    }

    // 菜单数据管理页
    if (url.pathname === "/menu" && method === "GET") {
      return new Response(renderAdminPage(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/menu") {
      if (method === "GET") {
        return jsonResponse(await loadMenu(env));
      }
      if (method === "POST") {
        // 可选的管理令牌校验：设置 MENU_ADMIN_TOKEN 后必须携带匹配的 X-Admin-Token
        if (env.MENU_ADMIN_TOKEN) {
          const token = request.headers.get("X-Admin-Token");
          if (token !== env.MENU_ADMIN_TOKEN) {
            return jsonResponse({ error: "无效或缺失的管理令牌" }, 401);
          }
        }
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return jsonResponse({ error: "请求体不是合法 JSON" }, 400);
        }
        const menu = normalizeMenu(raw);
        if (!menu) {
          return jsonResponse({ error: "菜单数据格式不合法" }, 400);
        }
        try {
          await saveMenu(env, menu);
        } catch (e) {
          return jsonResponse({ error: "写入 KV 失败：" + String(e) }, 500);
        }
        return jsonResponse({ ok: true, saved: menu.categories.length });
      }
      return jsonResponse({ error: "不支持的方法" }, 405);
    }

    return new Response("404 · 页面不存在，访问 / 查看菜单、/menu 管理数据", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
