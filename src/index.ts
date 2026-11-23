import menuData from "../data/menu.json";

/** KV 键前缀：每个菜单分类存一个键，如 menu:signature */
const MENU_KEY_PREFIX = "menu:";

export interface MenuItem {
  name: string;
  price: number;
  desc?: string;
  tag?: string;
  image?: string;
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

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/** 分类 ID 用作 KV 键名，仅允许安全字符，且不能与餐厅信息键冲突 */
function isValidCategoryId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(id) && id !== "restaurant";
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
    if (typeof cat?.id !== "string" || !isValidCategoryId(cat.id)) return null;
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
        image: typeof it.image === "string" && it.image ? it.image : undefined,
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

/* ------------------------------------------------------------------ *
 * 公开菜单页：极简现代风 · 移动优先
 * ------------------------------------------------------------------ */

/** 菜品图片块：有图则懒加载 + 占位符，无图则显示分类 emoji 占位 */
function renderImageBlock(image: string | undefined, emoji: string): string {
  if (image) {
    return `<div class="card-img">
        <div class="ph"><span>${emoji}</span></div>
        <img class="lazy-img" loading="lazy" src="${escapeAttr(image)}" alt=""
          onload="this.style.opacity='1';this.previousElementSibling.style.opacity='0'" />
      </div>`;
  }
  return `<div class="card-img ph-only"><span>${emoji}</span></div>`;
}

function renderItemCard(item: MenuItem, emoji: string): string {
  const tag = item.tag
    ? `<span class="tag">${escapeHtml(item.tag)}</span>`
    : "";
  const desc = item.desc
    ? `<p class="desc">${escapeHtml(item.desc)}</p>`
    : "";
  return `
      <article class="card">
        ${renderImageBlock(item.image, emoji)}
        <div class="card-body">
          <div class="card-top">
            <h4 class="name">${escapeHtml(item.name)}${tag}</h4>
            <span class="price">¥${item.price}</span>
          </div>
          ${desc}
        </div>
      </article>`;
}

function renderPage(menu: MenuData): string {
  const navItems = menu.categories
    .map(
      (cat, i) =>
        `<button class="nav-btn${i === 0 ? " active" : ""}" data-target="cat-${escapeAttr(
          cat.id
        )}">${cat.icon ? `<span class="nav-icon">${cat.icon}</span>` : ""}<span class="nav-name">${
          escapeHtml(cat.name)
        }</span></button>`
    )
    .join("");

  const sections = menu.categories
    .map((cat) => {
      const emoji = cat.icon || "🍽️";
      const cards = cat.items.map((it) => renderItemCard(it, emoji)).join("");
      return `
      <section class="cat-section" id="cat-${escapeAttr(cat.id)}">
        <h3 class="cat-title">${emoji ? `<span class="cat-icon">${emoji}</span>` : ""}<span>${escapeHtml(
          cat.name
        )}</span></h3>
        <div class="grid">${cards}</div>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(menu.restaurant.name)} · 菜单</title>
<meta name="description" content="${escapeHtml(menu.restaurant.tagline)}" />
<style>
  :root {
    --bg: #f7f8fa; --card: #ffffff; --text: #1f2329; --sub: #8a919e;
    --accent: #c73e3a; --accent-soft: rgba(199,62,58,.10);
    --border: #eef0f3; --shadow: 0 2px 10px rgba(20,25,40,.05);
    --ph: #eef0f3; --nav-bg: #ffffff;
  }
  html[data-theme="dark"] {
    --bg: #121212; --card: #1e1e1e; --text: #ececec; --sub: #9ca3af;
    --accent: #e0625a; --accent-soft: rgba(224,98,90,.16);
    --border: #2a2a2a; --shadow: 0 2px 12px rgba(0,0,0,.45);
    --ph: #2a2a2a; --nav-bg: #1a1a1a;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Roboto, system-ui, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.6;
    display: flex; flex-direction: column; min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  /* 顶部 Banner */
  .banner {
    flex: none; position: relative; overflow: hidden;
    background: linear-gradient(135deg, var(--accent) 0%, #a82f2c 100%);
    color: #fff; padding: 34px 20px 30px;
  }
  html[data-theme="dark"] .banner { background: linear-gradient(135deg, #2a1414 0%, #161616 100%); }
  .banner::after {
    content: ""; position: absolute; right: -40px; top: -40px; width: 180px; height: 180px;
    border-radius: 50%; background: rgba(255,255,255,.10);
  }
  .banner h1 { margin: 0; font-size: 30px; letter-spacing: 3px; position: relative; }
  .banner .tagline { margin: 6px 0 0; font-size: 14px; letter-spacing: 2px; opacity: .92; position: relative; }
  .banner .notice { margin: 10px 0 0; font-size: 12px; opacity: .8; position: relative; }
  .theme-toggle {
    position: absolute; right: 16px; top: 16px; width: 38px; height: 38px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,.35); background: rgba(255,255,255,.14); color: #fff;
    font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .theme-toggle:active { transform: scale(.94); }

  /* 布局：左侧分类导航 + 右侧菜品列表 */
  .layout { flex: 1; min-height: 0; display: flex; }
  .sidebar {
    flex: none; width: 96px; overflow-y: auto; padding: 14px 8px;
    background: var(--nav-bg); border-right: 1px solid var(--border);
  }
  .nav-btn {
    display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%;
    padding: 10px 4px; margin-bottom: 4px; border: none; border-radius: 10px;
    background: transparent; color: var(--sub); font-size: 12px; cursor: pointer;
    font-family: inherit; transition: background .2s, color .2s, transform .15s;
  }
  .nav-btn:active { transform: scale(.95); }
  .nav-btn.active { color: var(--accent); background: var(--accent-soft); font-weight: 600; }
  .nav-icon { font-size: 20px; }
  .nav-name { word-break: break-all; text-align: center; }

  .content { flex: 1; overflow-y: auto; position: relative; padding: 8px 16px 40px; scroll-behavior: smooth; }
  .cat-section { padding: 18px 0 6px; }
  .cat-title {
    margin: 0 0 14px; font-size: 17px; color: var(--text);
    display: flex; align-items: center; gap: 8px;
  }
  .cat-icon { font-size: 20px; }

  .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }

  .card {
    display: flex; gap: 14px; background: var(--card);
    border: 1px solid var(--border); border-radius: 12px; padding: 12px;
    box-shadow: var(--shadow);
    animation: rise .5s ease both;
    transition: transform .2s, box-shadow .2s;
  }
  .card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(20,25,40,.10); }
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

  .card-img { position: relative; width: 96px; height: 96px; flex: none; border-radius: 10px; overflow: hidden; background: var(--ph); }
  .card-img .ph {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 34px; opacity: 1; transition: opacity .4s;
  }
  .card-img.ph-only { display: flex; align-items: center; justify-content: center; font-size: 34px; }
  .lazy-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .5s; }

  .card-body { flex: 1; min-width: 0; }
  .card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .name { margin: 0; font-size: 15px; font-weight: 600; }
  .price { color: var(--accent); font-weight: 700; font-size: 16px; white-space: nowrap; }
  .desc { margin: 3px 0 0; font-size: 12px; color: var(--sub); }
  .tag {
    display: inline-block; margin-left: 7px; padding: 0 8px; font-size: 10px; font-weight: 600;
    color: #fff; background: var(--accent); border-radius: 999px; vertical-align: 2px;
  }

  .footer { flex: none; text-align: center; padding: 12px; font-size: 12px; color: var(--sub); border-top: 1px solid var(--border); background: var(--nav-bg); }

  /* 移动端：左侧导航折叠为顶部横向滚动条 */
  @media (max-width: 767px) {
    .layout { flex-direction: column; }
    .sidebar {
      width: auto; display: flex; overflow-x: auto; flex-wrap: nowrap;
      padding: 8px; border-right: none; border-bottom: 1px solid var(--border); gap: 6px;
    }
    .nav-btn { flex: none; width: auto; padding: 8px 12px; }
    .nav-name { white-space: nowrap; }
    .content { padding: 8px 12px 32px; }
    .banner h1 { font-size: 24px; }
  }
  @media (min-width: 700px) {
    .grid { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
  <header class="banner">
    <button class="theme-toggle" id="themeToggle" aria-label="切换深色模式">🌙</button>
    <h1>${escapeHtml(menu.restaurant.name)}</h1>
    <p class="tagline">${escapeHtml(menu.restaurant.tagline)}</p>
    ${menu.restaurant.notice ? `<p class="notice">${escapeHtml(menu.restaurant.notice)}</p>` : ""}
  </header>

  <div class="layout">
    <nav class="sidebar" id="sidebar">${navItems}</nav>
    <main class="content" id="content">${sections}</main>
  </div>

  <p class="footer">菜单数据由 Cloudflare KV 实时驱动 · <a href="/menu" style="color:var(--accent)">管理数据</a></p>

<script>
  // 深色模式：本地存储 + 跟随系统
  (function () {
    var saved = null;
    try { saved = localStorage.getItem("menu-theme"); } catch (e) {}
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = saved || (prefersDark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
    document.getElementById("themeToggle").textContent = theme === "dark" ? "☀️" : "🌙";
    document.getElementById("themeToggle").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      this.textContent = next === "dark" ? "☀️" : "🌙";
      try { localStorage.setItem("menu-theme", next); } catch (e) {}
    });
  })();

  // 分类导航：点击平滑滚动 + 滚动自动高亮（scroll-spy）
  (function () {
    var content = document.getElementById("content");
    var sidebar = document.getElementById("sidebar");
    var buttons = Array.prototype.slice.call(sidebar.querySelectorAll(".nav-btn"));
    var sections = buttons
      .map(function (b) { return document.getElementById(b.getAttribute("data-target")); })
      .filter(Boolean);

    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = document.getElementById(btn.getAttribute("data-target"));
        if (target) {
          content.scrollTo({ top: target.offsetTop - 8, behavior: "smooth" });
        }
      });
    });

    function setActive(id) {
      buttons.forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-target") === id);
      });
    }

    if ("IntersectionObserver" in window) {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) setActive(entry.target.id);
          });
        },
        { root: content, rootMargin: "-8px 0px -70% 0px", threshold: 0 }
      );
      sections.forEach(function (s) { observer.observe(s); });
    }
  })();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * 菜单数据管理页：拖拽上传 · 极简表单 · Toast · 分类ID可编辑
 * ------------------------------------------------------------------ */

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>菜单数据管理 · 云间小馆</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #ffffff; --text: #1f2329; --sub: #8a919e;
    --accent: #c73e3a; --border: #e5e7eb; --shadow: 0 2px 10px rgba(20,25,40,.05);
    --ph: #eef0f3;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 60px; font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.6;
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--sub); font-size: 13px; margin: 0 0 16px; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .topbar a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); padding: 18px 20px; margin-bottom: 16px; }
  .card h3 { margin: 0 0 14px; font-size: 15px; }
  .field { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .field label { width: 64px; font-size: 13px; color: var(--sub); flex-shrink: 0; }
  .req::after { content: " *"; color: var(--accent); }
  input[type=text], input[type=number], select {
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 14px;
    flex: 1; min-width: 0; font-family: inherit; background: #fff; color: var(--text);
  }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  button { border: none; border-radius: 8px; padding: 9px 16px; font-size: 14px; cursor: pointer; font-family: inherit; background: var(--accent); color: #fff; transition: transform .15s; }
  button:active { transform: scale(.95); }
  button.ghost { background: #eceff3; color: #555; }
  button.ghost:hover { background: #dde1e7; }
  button.danger { background: #fff; color: var(--accent); border: 1px solid var(--accent); }
  button.small { padding: 5px 11px; font-size: 13px; }

  /* 拖拽上传区 */
  .dropzone {
    border: 2px dashed var(--border); border-radius: 12px; padding: 26px 16px; text-align: center;
    color: var(--sub); font-size: 14px; cursor: pointer; transition: border-color .2s, background .2s;
    background: #fafbfc;
  }
  .dropzone.dragover { border-color: var(--accent); background: var(--accent-soft, rgba(199,62,58,.06)); }
  .dz-img { max-width: 100%; max-height: 200px; border-radius: 10px; display: none; }
  /* 文件输入：手机浏览器无法唤起 hidden 元素的 .click()，用离屏隐藏保证可选图 */
  #dzFile { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); opacity: 0; }
  .dz-ph { display: block; }

  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .cat-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .cat-head input[type=text] { flex: 1; }
  .id-in { width: 150px; flex: none !important; font-family: monospace; font-size: 12px; }
  .icon-in { width: 72px; flex: none !important; }
  .muted { color: var(--sub); font-size: 12px; }
  .item-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; background: #fafbfc; border: 1px solid var(--border); border-radius: 10px; padding: 10px; margin-bottom: 8px; }
  .item-row .thumb { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: var(--ph); flex: none; }
  .item-row .thumb.empty { display: flex; align-items: center; justify-content: center; font-size: 20px; }
  .item-row input[type=text] { flex: 1; min-width: 90px; }
  .item-row input[type=number] { width: 76px; flex: none; }
  .status { font-size: 14px; min-height: 22px; margin: 10px 0 0; }
  .status.ok { color: #1e8449; }
  .status.err { color: var(--accent); }

  /* Toast */
  #toast {
    position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%) translateY(20px);
    background: rgba(31,35,41,.94); color: #fff; padding: 11px 20px; border-radius: 10px;
    font-size: 14px; opacity: 0; pointer-events: none; transition: opacity .3s, transform .3s; z-index: 50;
    max-width: 90vw; text-align: center;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.err { background: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a href="/">← 返回菜单页</a>
  </div>
  <h1>菜单数据管理</h1>
  <p class="sub">拖入菜品图片、填写信息即可添加；保存后写入 Cloudflare KV，菜单页即时生效。</p>

  <div class="card">
    <h3>餐厅信息</h3>
    <div class="field"><label class="req">店名</label><input id="r-name" type="text" /></div>
    <div class="field"><label>标语</label><input id="r-tagline" type="text" /></div>
    <div class="field"><label>备注</label><input id="r-notice" type="text" /></div>
  </div>

  <div class="card">
    <h3>添加菜品</h3>
    <div class="dropzone" id="dropzone">
      <span class="dz-ph" id="dzPh">拖入菜品图片，或点击选择（选填）</span>
      <img class="dz-img" id="dzImg" alt="" />
    </div>
    <input type="file" id="dzFile" accept="image/*" />
    <div class="field" style="margin-top:12px"><label>图片链接</label><input id="i-image-url" type="text" placeholder="或粘贴图片 URL（选填，直接存为图片源）" /></div>
    <div style="height:12px"></div>
    <div class="field"><label class="req">菜名</label><input id="i-name" type="text" placeholder="如：秘制红烧肉" /></div>
    <div class="field"><label class="req">价格</label><input id="i-price" type="number" min="0" step="0.5" placeholder="如：58" /></div>
    <div class="field"><label>描述</label><input id="i-desc" type="text" placeholder="选填" /></div>
    <div class="field"><label>标签</label><input id="i-tag" type="text" placeholder="选填，如：招牌" /></div>
    <div class="field"><label>所属分类</label><select id="i-cat"></select></div>
    <button id="add-item">添加菜品</button>
    <p class="status" id="addStatus"></p>
  </div>

  <div id="cats"></div>

  <div class="card">
    <button id="add-cat">+ 添加分类</button>
    <span class="muted">　分类 ID 可手动修改（将作为 KV 键名）</span>
    <div style="height:12px"></div>
    <button id="save">保存到 KV</button>
    <div class="field token-row" style="margin-top:12px"><label>管理令牌</label><input id="token" type="text" placeholder="如未开启令牌校验可留空" /></div>
    <p class="status" id="status"></p>
  </div>
</div>

<div id="toast"></div>

<script>
var state = null;
var draftImage = null; // 当前拖入、待添加菜品的图片
var $ = function (id) { return document.getElementById(id); };

function esc(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

var toastTimer = null;
function toast(msg, isErr) {
  var el = $("toast");
  el.textContent = msg;
  el.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = isErr ? "err" : ""; }, 2200);
}

function setStatus(id, msg, ok) {
  var el = $(id);
  el.textContent = msg;
  el.className = "status " + (ok === true ? "ok" : ok === false ? "err" : "");
}

function newCategory() {
  return { id: "cat-" + Date.now().toString(36), name: "新分类", icon: "🍽️", items: [] };
}

/* 将图片压缩为 JPEG dataURL，控制写入 KV 的体积 */
function fileToDataURL(file, maxW, quality) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxW / img.width);
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* 拖拽上传 */
var dz = $("dropzone");
function showDraft(dataUrl) {
  draftImage = dataUrl;
  $("dzImg").src = dataUrl;
  $("dzImg").style.display = "block";
  $("dzPh").style.display = "none";
}
function resetDraft() {
  draftImage = null;
  $("dzImg").style.display = "none";
  $("dzImg").src = "";
  $("dzPh").style.display = "block";
}
dz.addEventListener("click", function () { $("dzFile").click(); });
dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("dragover"); });
dz.addEventListener("dragleave", function () { dz.classList.remove("dragover"); });
dz.addEventListener("drop", function (e) {
  e.preventDefault(); dz.classList.remove("dragover");
  var file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});
$("dzFile").addEventListener("change", function (e) {
  var file = e.target.files && e.target.files[0];
  if (file) handleFile(file);
  e.target.value = "";
});
function handleFile(file) {
  if (!file.type.startsWith("image/")) { toast("请选择图片文件", true); return; }
  fileToDataURL(file, 900, 0.82).then(showDraft).catch(function () { toast("图片处理失败", true); });
}

/* 渲染分类选择下拉 */
function renderCatSelect() {
  var sel = $("i-cat");
  sel.innerHTML = "";
  state.categories.forEach(function (c, i) {
    var opt = document.createElement("option");
    opt.value = i;
    opt.textContent = c.name + "（" + c.id + "）";
    sel.appendChild(opt);
  });
}

/* 渲染分类列表（分类 ID 可手动编辑） */
function renderCategories() {
  var box = $("cats");
  box.innerHTML = "";
  state.categories.forEach(function (cat, ci) {
    var card = document.createElement("div");
    card.className = "card";

    var head = document.createElement("div");
    head.className = "cat-head";
    head.innerHTML =
      '<input class="id-in" type="text" value="' + esc(cat.id) + '" title="分类 ID（KV 键名，手动可改）" />' +
      '<input class="c-name" type="text" value="' + esc(cat.name) + '" placeholder="分类名称" />' +
      '<input class="icon-in c-icon" type="text" value="' + esc(cat.icon || "") + '" placeholder="图标" />' +
      '<button class="danger small del-cat">删除分类</button>';
    head.querySelector(".id-in").addEventListener("input", function (e) { state.categories[ci].id = e.target.value; });
    head.querySelector(".c-name").addEventListener("input", function (e) { state.categories[ci].name = e.target.value; });
    head.querySelector(".c-icon").addEventListener("input", function (e) { state.categories[ci].icon = e.target.value; });
    head.querySelector(".del-cat").addEventListener("click", function () {
      if (confirm("删除分类「" + cat.name + "」及其全部菜品？")) {
        state.categories.splice(ci, 1);
        renderCategories(); renderCatSelect();
      }
    });
    card.appendChild(head);

    var itemsBox = document.createElement("div");
    cat.items.forEach(function (it, ii) {
      var row = document.createElement("div");
      row.className = "item-row";
      var thumb = it.image
        ? '<img class="thumb" src="' + esc(it.image) + '" alt="" />'
        : '<div class="thumb empty">' + esc(cat.icon || "🍽️") + '</div>';
      row.innerHTML =
        thumb +
        '<input class="i-name" type="text" value="' + esc(it.name) + '" placeholder="菜名" />' +
        '<input class="i-price" type="number" min="0" step="0.5" value="' + it.price + '" placeholder="价格" />' +
        '<input class="i-desc" type="text" value="' + esc(it.desc || "") + '" placeholder="描述" />' +
        '<input class="i-tag" type="text" value="' + esc(it.tag || "") + '" placeholder="标签" />' +
        '<button class="ghost small del-item">删除</button>';
      row.querySelector(".i-name").addEventListener("input", function (e) { state.categories[ci].items[ii].name = e.target.value; });
      row.querySelector(".i-price").addEventListener("input", function (e) { state.categories[ci].items[ii].price = Number(e.target.value) || 0; });
      row.querySelector(".i-desc").addEventListener("input", function (e) { state.categories[ci].items[ii].desc = e.target.value; });
      row.querySelector(".i-tag").addEventListener("input", function (e) { state.categories[ci].items[ii].tag = e.target.value; });
      row.querySelector(".del-item").addEventListener("click", function () {
        state.categories[ci].items.splice(ii, 1);
        renderCategories();
      });
      itemsBox.appendChild(row);
    });
    card.appendChild(itemsBox);

    var addItem = document.createElement("button");
    addItem.className = "ghost small add-item";
    addItem.textContent = "+ 添加菜品";
    addItem.addEventListener("click", function () {
      state.categories[ci].items.push({ name: "新菜品", price: 0, desc: "", tag: "", image: "" });
      renderCategories();
    });
    card.appendChild(addItem);

    box.appendChild(card);
  });
}

function renderRestaurant() {
  $("r-name").value = state.restaurant.name || "";
  $("r-tagline").value = state.restaurant.tagline || "";
  $("r-notice").value = state.restaurant.notice || "";
}

/* 添加菜品：读取表单，追加到所选分类顶部，Toast 反馈，连续录入 */
function addItem() {
  var name = $("i-name").value.trim();
  var price = Number($("i-price").value);
  if (!name) { setStatus("addStatus", "请填写菜名", false); return; }
  if (!Number.isFinite(price) || price < 0) { setStatus("addStatus", "请填写有效价格", false); return; }
  var ci = Number($("i-cat").value);
  if (isNaN(ci) || ci < 0 || ci >= state.categories.length) {
    setStatus("addStatus", "请选择所属分类（需先添加分类）", false); return;
  }
  state.categories[ci].items.unshift({
    name: name,
    price: price,
    desc: $("i-desc").value.trim(),
    tag: $("i-tag").value.trim(),
    image: draftImage || $("i-image-url").value.trim() || "",
  });
  $("i-name").value = ""; $("i-price").value = ""; $("i-desc").value = ""; $("i-tag").value = ""; $("i-image-url").value = "";
  resetDraft();
  renderCategories();
  setStatus("addStatus", "已添加「" + name + "」到「" + state.categories[ci].name + "」顶部", true);
  toast("已添加： " + name);
}

async function load() {
  setStatus("status", "正在加载菜单数据…");
  try {
    var res = await fetch("/api/menu", { cache: "no-store" });
    state = await res.json();
    if (!state.restaurant) state.restaurant = { name: "", tagline: "" };
    if (!Array.isArray(state.categories)) state.categories = [];
    renderRestaurant();
    renderCatSelect();
    renderCategories();
    setStatus("status", "已加载 " + state.categories.length + " 个分类，可开始编辑。");
  } catch (e) {
    setStatus("status", "加载失败：" + e.message, false);
  }
}

async function save() {
  setStatus("status", "正在保存…");
  // 校验分类 ID
  for (var i = 0; i < state.categories.length; i++) {
    var cid = state.categories[i].id;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cid) || cid === "restaurant") {
      setStatus("status", "分类「" + state.categories[i].name + "」的 ID 不合法（仅限字母/数字/-/_，且不能是 restaurant）", false);
      return;
    }
  }
  state.restaurant.name = $("r-name").value.trim() || state.restaurant.name;
  state.restaurant.tagline = $("r-tagline").value;
  state.restaurant.notice = $("r-notice").value;
  try {
    var headers = { "Content-Type": "application/json" };
    var token = $("token").value.trim();
    if (token) headers["X-Admin-Token"] = token;
    var res = await fetch("/api/menu", { method: "POST", headers: headers, body: JSON.stringify(state) });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || "HTTP " + res.status);
    }
    var data = await res.json();
    setStatus("status", "保存成功：已写入 " + data.saved + " 个分类键到 KV。", true);
    toast("保存成功，菜单已更新");
  } catch (e) {
    setStatus("status", "保存失败：" + e.message, false);
    toast("保存失败：" + e.message, true);
  }
}

$("add-item").addEventListener("click", addItem);
$("add-cat").addEventListener("click", function () {
  state.categories.push(newCategory());
  renderCategories(); renderCatSelect();
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
    if (url.pathname === "/") {
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
          return jsonResponse({ error: "菜单数据格式不合法（分类 ID 仅限字母/数字/-/_）" }, 400);
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
