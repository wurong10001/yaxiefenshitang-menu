import menuData from "../data/menu.json";

/** KV 键前缀：每个菜单分类存一个键，如 menu:signature */
const MENU_KEY_PREFIX = "menu:";
/** 购物车规则配置的 KV 键 */
const CONFIG_KEY = `${MENU_KEY_PREFIX}config`;
/** 默认分类归类映射（KV 未配置 config 时的兜底：按分类名/id 关键词推断） */
function inferGroups(categories: MenuCategory[]): Record<string, FoodGroup> {
  const map: Record<string, FoodGroup> = {};
  for (const cat of categories) {
    const s = (cat.id + " " + cat.name).toLowerCase();
    map[cat.id] = /drink|beverage|饮料|饮品/.test(s)
      ? "饮料"
      : /staple|主食|饭|面|粉/.test(s)
      ? "主食"
      : "小吃";
  }
  return map;
}

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

/** 规格配置：口味单选 + 份量单选（份量决定价格） */
export interface SpecConfig {
  flavors: string[];
  portions: Array<{ name: string; price: number }>;
}

/** 加料配置：可加到某道主食上，单独归类、单独加价，并生成备注模板 */
export interface AddonConfig {
  name: string;          // 加料显示名，如 煎蛋
  price: number;         // 加价
  group: FoodGroup;      // 加料归类，如 小吃
  noteTemplate: string;  // 备注模板，{addon} 与 {base} 分别替换为加料名与主菜名
}

/** 全部购物车相关的可配置规则，存于 KV 键 menu:config */
export interface MenuConfig {
  /** 分类 ID → 归类维度。菜品归类直接由其所在分类决定 */
  categoryGroups: Record<string, FoodGroup>;
  specs: Record<string, SpecConfig>;            // 菜名（精确）→ 规格
  addonsFor: Record<string, AddonConfig[]>;    // 主菜名（精确）→ 可加料列表
}

export interface MenuData {
  restaurant: { name: string; tagline: string; notice?: string };
  categories: MenuCategory[];
  config?: MenuConfig;
}

/** 购物车导出时的归类维度 */
type FoodGroup = "主食" | "小吃" | "饮料";

/** 购物车单条记录：key 对应 cartCatalog 中的稳定键 */
interface CartEntry {
  key: string;
  name: string;
  price: number;
  group: FoodGroup;
  qty: number;
}

/** 购物车完整状态，整体序列化进 localStorage */
interface CartState {
  entries: CartEntry[];
  note: string;
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

  // 购物车规则配置（原始读取，下面结合分类做兜底）
  let rawConfig: MenuConfig | null = null;
  try {
    const c = await env.MENU_KV.get<MenuConfig>(CONFIG_KEY, "json");
    if (c && c.categoryGroups && typeof c.categoryGroups === "object") {
      rawConfig = {
        categoryGroups: c.categoryGroups,
        specs: c.specs && typeof c.specs === "object" ? c.specs : {},
        addonsFor: c.addonsFor && typeof c.addonsFor === "object" ? c.addonsFor : {},
      };
    }
  } catch {
    // 配置键缺失或损坏时走兜底
  }

  // 分类键（排除餐厅信息键与配置键）
  const catKeys = keys
    .map((k) => k.name)
    .filter((name) => name !== `${MENU_KEY_PREFIX}restaurant` && name !== CONFIG_KEY)
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
  if (categories.length === 0) return menuData;
  const config: MenuConfig = rawConfig || {
    categoryGroups: inferGroups(categories),
    specs: {},
    addonsFor: {},
  };
  return { restaurant, categories, config };
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
  // 写入购物车规则配置
  if (menu.config) {
    await env.MENU_KV.put(CONFIG_KEY, JSON.stringify(menu.config));
  }
  const { keys } = await env.MENU_KV.list({ prefix: MENU_KEY_PREFIX });
  const keep = new Set([restaurantKey, CONFIG_KEY, ...entries.map((e) => e.key)]);
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
    config: normalizeConfig(input.config),
  };
}

/** 规范化购物车配置：只接受结构合法的字段，避免脏数据写入 KV */
function normalizeConfig(raw: unknown): MenuConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Partial<MenuConfig>;
  const categoryGroups: Record<string, FoodGroup> = {};
  if (c.categoryGroups && typeof c.categoryGroups === "object") {
    for (const [id, g] of Object.entries(c.categoryGroups)) {
      if (g === "主食" || g === "小吃" || g === "饮料") categoryGroups[id] = g;
    }
  }
  const specs: Record<string, SpecConfig> = {};
  if (c.specs && typeof c.specs === "object") {
    for (const [name, s] of Object.entries(c.specs)) {
      if (
        s && Array.isArray(s.flavors) && s.flavors.every((f) => typeof f === "string") &&
        Array.isArray(s.portions) &&
        s.portions.every(
          (p) => p && typeof p.name === "string" && Number.isFinite(Number(p.price))
        )
      ) {
        specs[name] = {
          flavors: s.flavors,
          portions: s.portions.map((p) => ({ name: p.name, price: Number(p.price) })),
        };
      }
    }
  }
  const addonsFor: Record<string, AddonConfig[]> = {};
  if (c.addonsFor && typeof c.addonsFor === "object") {
    for (const [name, list] of Object.entries(c.addonsFor)) {
      if (!Array.isArray(list)) continue;
      addonsFor[name] = list
        .filter(
          (a): a is AddonConfig =>
            !!a && typeof a.name === "string" &&
            (a.group === "主食" || a.group === "小吃" || a.group === "饮料") &&
            Number.isFinite(Number(a.price)) &&
            typeof a.noteTemplate === "string"
        )
        .map((a) => ({
          name: a.name,
          price: Number(a.price),
          group: a.group,
          noteTemplate: a.noteTemplate,
        }));
    }
  }
  return { categoryGroups, specs, addonsFor };
}

/* ------------------------------------------------------------------ *
 * 公开菜单页：极简现代风 · 移动优先
 * ------------------------------------------------------------------ */

/** 菜品归类：直接取 KV 配置中其所在分类的映射，未配置则归"小吃" */
function classifyFood(categoryId: string, config: MenuConfig): FoodGroup {
  return config.categoryGroups[categoryId] || "小吃";
}

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

function renderItemCard(
  item: MenuItem,
  emoji: string,
  key: string,
  hasSpec: boolean,
  hasAddons: boolean
): string {
  const tag = item.tag
    ? `<span class="tag">${escapeHtml(item.tag)}</span>`
    : "";
  const desc = item.desc
    ? `<p class="desc">${escapeHtml(item.desc)}</p>`
    : "";
  // 带规格或加料的菜：卡片上显示选择按钮与已选总份数，详细选择在弹窗内完成
  const needDialog = hasSpec || hasAddons;
  const dialogLabel = hasSpec && hasAddons ? "选规格/加料 ›" : hasSpec ? "选规格 ›" : "选加料 ›";
  const ctrlInner = needDialog
    ? `<span class="qty-num">0</span>
            <button class="add-btn add-particle" type="button">${dialogLabel}</button>`
    : `<button class="qty-minus" type="button" aria-label="减少">−</button>
            <span class="qty-num">0</span>
            <button class="qty-plus add-particle" type="button" aria-label="增加">+</button>
            <button class="add-btn add-particle" type="button">加入购物车</button>`;
  return `
      <article class="card">
        ${renderImageBlock(item.image, emoji)}
        <div class="card-body">
          <div class="card-top">
            <h4 class="name">${escapeHtml(item.name)}${tag}</h4>
            <span class="price">¥${item.price}</span>
          </div>
          ${desc}
          <div class="cart-ctrl${needDialog ? " spec-mode" : ""}" data-ctrl-key="${escapeAttr(key)}">
            ${ctrlInner}
          </div>
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

  // 购物车商品目录：归类、名称、价格、规格、加料全部来自 KV 配置，服务端一次算好内联给客户端。
  // key 用「分类id__索引」保证稳定。
  const config: MenuConfig = menu.config || {
    categoryGroups: inferGroups(menu.categories),
    specs: {},
    addonsFor: {},
  };
  const cartCatalog: Array<{
    key: string;
    name: string;
    price: number;
    group: FoodGroup;
    spec: SpecConfig | null;
    addons: AddonConfig[];
  }> = [];
  const sections = menu.categories
    .map((cat) => {
      const emoji = cat.icon || "🍽️";
      const cards = cat.items
        .map((it, idx) => {
          const key = `${cat.id}__${idx}`;
          const spec = config.specs[it.name.trim()] || null;
          const addons = config.addonsFor[it.name.trim()] || [];
          cartCatalog.push({
            key,
            name: it.name,
            price: it.price,
            group: classifyFood(cat.id, config),
            spec,
            addons,
          });
          return renderItemCard(it, emoji, key, !!spec, addons.length > 0);
        })
        .join("");
      return `
      <section class="cat-section" id="cat-${escapeAttr(cat.id)}">
        <h3 class="cat-title">${emoji ? `<span class="cat-icon">${emoji}</span>` : ""}<span>${escapeHtml(
          cat.name
        )}</span></h3>
        <div class="grid">${cards}</div>
      </section>`;
    })
    .join("");

  // 内联为 JS 字面量，转义尖括号与 & 防止 </script> 截断及 XSS
  const catalogJson = JSON.stringify(cartCatalog)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

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

  /* 购物车：卡片内数量控件 */
  .cart-ctrl { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .cart-ctrl .qty-minus, .cart-ctrl .qty-plus {
    width: 26px; height: 26px; flex: none; border: 1px solid var(--border); border-radius: 8px;
    background: transparent; color: var(--text); font-size: 16px; line-height: 1;
    cursor: pointer; display: none; align-items: center; justify-content: center;
    font-family: inherit; transition: transform .15s, background .2s;
  }
  .cart-ctrl .qty-plus { border-radius: 50%; background: var(--accent); color: #fff; border-color: var(--accent); }
  .cart-ctrl .qty-num { min-width: 18px; text-align: center; font-size: 13px; display: none; }
  .cart-ctrl .add-btn {
    flex: 1; padding: 7px 10px; border: 1px solid var(--accent); border-radius: 8px;
    background: var(--accent-soft); color: var(--accent); font-size: 13px;
    cursor: pointer; font-family: inherit; transition: transform .15s;
  }
  .cart-ctrl.has-qty .qty-minus, .cart-ctrl.has-qty .qty-plus, .cart-ctrl.has-qty .qty-num { display: inline-flex; }
  .cart-ctrl.has-qty .add-btn { display: none; }
  .cart-ctrl button:active { transform: scale(.9); }
  /* 规格菜品：数量数字常显（显示已选总份数） */
  .cart-ctrl.spec-mode .qty-num { display: inline-flex; }
  .cart-ctrl.spec-mode .qty-num:not(:empty) { color: var(--accent); font-weight: 600; }
  .cart-ctrl.spec-mode .add-btn { flex: 1; }

  /* 底部悬浮购物车按钮 */
  .cart-fab {
    position: fixed; right: 16px; bottom: 18px; z-index: 40;
    display: flex; align-items: center; gap: 8px;
    padding: 11px 16px; border: none; border-radius: 999px;
    background: var(--accent); color: #fff; font-size: 14px; font-weight: 600;
    box-shadow: 0 6px 18px rgba(0,0,0,.22); cursor: pointer; font-family: inherit;
    transition: transform .2s;
  }
  .cart-fab .badge {
    background: #fff; color: var(--accent); border-radius: 999px;
    padding: 0 7px; font-size: 12px; min-width: 20px; text-align: center;
  }
  .cart-fab[hidden] { display: none; }
  .cart-fab.bump { animation: fab-bump .35s ease; }
  @keyframes fab-bump { 0% { transform: scale(1); } 40% { transform: scale(1.18); } 100% { transform: scale(1); } }
  @media (max-width: 767px) {
    .cart-fab { right: 50%; transform: translateX(50%); bottom: 14px; }
    .cart-fab.bump { animation: fab-bump-m .35s ease; }
    @keyframes fab-bump-m { 0% { transform: translateX(50%) scale(1); } 40% { transform: translateX(50%) scale(1.18); } 100% { transform: translateX(50%) scale(1); } }
  }

  /* 飞向购物车的粒子圆 */
  .fly-dot {
    position: fixed; left: 0; top: 0; z-index: 70; width: 16px; height: 16px; border-radius: 50%;
    background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft), 0 3px 8px rgba(0,0,0,.25);
    pointer-events: none; display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 10px; will-change: transform;
  }

  /* 导出模态框 */
  .modal-mask {
    position: fixed; inset: 0; background: rgba(0,0,0,.46); z-index: 60;
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .modal-mask[hidden] { display: none; }
  .modal {
    width: 100%; max-width: 460px; max-height: 86vh; overflow-y: auto;
    background: var(--card); color: var(--text); border: 1px solid var(--border);
    border-radius: 14px; padding: 18px; box-shadow: var(--shadow);
  }
  .modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .modal-head h3 { margin: 0; font-size: 17px; }
  .modal-close { border: none; background: transparent; color: var(--sub); font-size: 18px; cursor: pointer; }
  .export-text, .note-input {
    width: 100%; box-sizing: border-box; border: 1px solid var(--border);
    border-radius: 10px; padding: 10px; font-size: 13px; font-family: inherit;
    background: var(--bg); color: var(--text); resize: vertical; line-height: 1.7;
  }
  .export-text { min-height: 140px; }
  .note-input { min-height: 56px; }
  .note-label { display: block; margin-top: 14px; font-size: 13px; color: var(--sub); }
  .modal-actions { display: flex; gap: 10px; margin-top: 16px; }
  .btn-ghost, .btn-primary {
    flex: 1; padding: 10px; border-radius: 10px; font-size: 14px;
    cursor: pointer; font-family: inherit; transition: transform .15s;
  }
  .btn-ghost { background: var(--bg); color: var(--sub); border: 1px solid var(--border); }
  .btn-primary { background: var(--accent); color: #fff; border: none; }
  .btn-ghost:active, .btn-primary:active { transform: scale(.96); }
  .toast {
    position: fixed; left: 50%; bottom: 86px; transform: translateX(-50%);
    background: rgba(31,35,41,.94); color: #fff; padding: 10px 18px; border-radius: 10px;
    font-size: 13px; z-index: 80; opacity: 0; pointer-events: none; transition: opacity .3s;
    white-space: nowrap;
  }
  .toast.show { opacity: 1; }

  /* 规格选择弹窗 */
  .spec-group { margin-top: 14px; }
  .spec-group .spec-label { display: block; font-size: 13px; color: var(--sub); margin-bottom: 8px; }
  .spec-options { display: flex; flex-wrap: wrap; gap: 8px; }
  .spec-opt {
    padding: 7px 14px; border: 1px solid var(--border); border-radius: 999px;
    background: var(--bg); color: var(--text); font-size: 13px; cursor: pointer;
    font-family: inherit; transition: background .2s, color .2s, border-color .2s;
  }
  .spec-opt.selected { background: var(--accent); color: #fff; border-color: var(--accent); }
  .spec-opt:active { transform: scale(.95); }
  .spec-price-line { margin-top: 16px; font-size: 14px; color: var(--sub); }
  .spec-price-line b { color: var(--accent); font-size: 18px; }
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

  <button class="cart-fab" id="cartFab" hidden aria-label="查看购物车">
    <span>🛒 购物车</span>
    <span class="badge" id="cartCount">0</span>
    <span id="cartTotal">¥0</span>
  </button>

  <div class="modal-mask" id="cartModal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-label="购物车">
      <div class="modal-head">
        <h3>我的订单</h3>
        <button class="modal-close" id="modalClose" aria-label="关闭">✕</button>
      </div>
      <textarea id="exportText" class="export-text" readonly aria-label="订单文本"></textarea>
      <label class="note-label" for="cartNote">备注</label>
      <textarea id="cartNote" class="note-input" placeholder="如：不要辣、少放盐"></textarea>
      <div class="modal-actions">
        <button class="btn-ghost" id="clearCart">清空</button>
        <button class="btn-primary" id="copyOrder">一键复制</button>
      </div>
    </div>
  </div>
  <div id="cartToast" class="toast"></div>

  <div class="modal-mask" id="specModal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-label="选择规格">
      <div class="modal-head">
        <h3 id="specTitle">选择规格</h3>
        <button class="modal-close" id="specClose" aria-label="关闭">✕</button>
      </div>
      <div class="spec-group">
        <span class="spec-label">口味</span>
        <div class="spec-options" id="specFlavors"></div>
      </div>
      <div class="spec-group" id="specAddonsWrap" hidden>
        <span class="spec-label">加料（可多选，单独计价）</span>
        <div class="spec-options" id="specAddons"></div>
      </div>
      <div class="spec-group" id="specPortionsWrap">
        <span class="spec-label">份量</span>
        <div class="spec-options" id="specPortions"></div>
      </div>
      <div class="spec-price-line">价格：<b id="specPrice">¥0</b></div>
      <div class="spec-group" id="specCurrentWrap" hidden>
        <span class="spec-label">已加入</span>
        <div id="specCurrent"></div>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" id="specCancel">取消</button>
        <button class="btn-primary" id="specConfirm">加入购物车</button>
      </div>
    </div>
  </div>

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

  // 购物车：点菜入车 · 本地持久化 · 自动归类导出 · 一键复制 · 飞入动画
  (function () {
    var CART_KEY = "menu-cart";
    var catalog = ${catalogJson};
    var catalogMap = {};
    catalog.forEach(function (c) { catalogMap[c.key] = c; });

    var fab = document.getElementById("cartFab");
    var modal = document.getElementById("cartModal");
    var exportText = document.getElementById("exportText");
    var noteInput = document.getElementById("cartNote");
    var toastEl = document.getElementById("cartToast");

    function loadCart() {
      var raw = null;
      try { raw = localStorage.getItem(CART_KEY); } catch (e) {}
      if (!raw) return { entries: [], note: "" };
      try {
        var s = JSON.parse(raw);
        if (!s || !Array.isArray(s.entries)) return { entries: [], note: "" };
        s.entries = s.entries.filter(function (e) {
          return e && typeof e.key === "string" && typeof e.name === "string"
            && isFinite(e.price) && e.price >= 0
            && isFinite(e.qty) && e.qty > 0
            && (e.group === "主食" || e.group === "小吃" || e.group === "饮料");
        }).map(function (e) {
          e.qty = Math.min(Math.floor(e.qty), 99);
          return e;
        });
        s.note = typeof s.note === "string" ? s.note : "";
        return s;
      } catch (e) { return { entries: [], note: "" }; }
    }

    var cart = loadCart();

    function saveCart() {
      try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {}
    }

    // 购物车条目 key：无规格=基础 key；有规格=基础 key + "|口味|份量"，二者视为不同条目。
    // 用第一个 "|" 之前的部分取回基础目录信息，做覆盖与下架清理。
    function baseKeyOf(entry) {
      var i = entry.key.indexOf("|");
      return i === -1 ? entry.key : entry.key.slice(0, i);
    }

    // 用服务端目录覆盖购物车中的名称/归类，并剔除已下架菜品。
    // 加料条目与规格条目的名称/价格/归类由其自身配置决定，不受主菜覆盖。
    function reconcile() {
      cart.entries = cart.entries.filter(function (e) { return !!catalogMap[baseKeyOf(e)]; });
      cart.entries.forEach(function (e) {
        if (e.key.indexOf("|A|") !== -1) return;       // 加料条目原样保留
        var c = catalogMap[baseKeyOf(e)];
        e.name = c.name; e.group = c.group;
        if (!e.flavor || !e.portion) e.price = c.price;
      });
    }

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      clearTimeout(toast._t);
      toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 1800);
    }

    function entryLabel(e) {
      // 规格菜品：鸡块/鸡柳（托盘装）[孜然·中份]×2；普通菜品：蛋炒饭×2
      var spec = [e.flavor, e.portion].filter(Boolean);
      var suffix = spec.length ? "[" + spec.join("·") + "]" : "";
      return e.name + suffix + "×" + e.qty;
    }

    function buildExportText() {
      var groups = { "主食": [], "小吃": [], "饮料": [] };
      var autoNotes = [];
      cart.entries.forEach(function (e) {
        groups[e.group].push(entryLabel(e));
        if (e.autoNote) autoNotes.push(e.autoNote);
      });
      var lines = ["主食", "小吃", "饮料"].map(function (g) {
        return g + "：（" + groups[g].join("、") + "）";
      });
      // 备注：手填备注 + 由加料模板自动生成的备注
      var notes = [];
      if (cart.note) notes.push(cart.note);
      if (autoNotes.length) notes.push(autoNotes.join("；"));
      lines.push("备注：（" + notes.join("；") + "）");
      return lines.join("\\n");
    }

    function syncUI() {
      var totalQty = 0, totalPrice = 0;
      cart.entries.forEach(function (e) { totalQty += e.qty; totalPrice += e.qty * e.price; });
      document.getElementById("cartCount").textContent = totalQty;
      document.getElementById("cartTotal").textContent = "¥" + totalPrice;
      fab.hidden = totalQty === 0;

      var ctrls = document.querySelectorAll("[data-ctrl-key]");
      for (var i = 0; i < ctrls.length; i++) {
        var ctrl = ctrls[i];
        var key = ctrl.getAttribute("data-ctrl-key");
        var isSpec = ctrl.classList.contains("spec-mode");
        var qty = 0;
        for (var j = 0; j < cart.entries.length; j++) {
          var e = cart.entries[j];
          // 规格卡片汇总该菜品所有规格条目的数量；普通卡片只匹配精确 key
          var match = isSpec ? e.key.indexOf(key + "|") === 0 : e.key === key;
          if (match) qty += e.qty;
        }
        var numEl = ctrl.querySelector(".qty-num");
        if (numEl) numEl.textContent = qty ? (isSpec ? qty + "份" : qty) : "";
        ctrl.classList.toggle("has-qty", qty > 0);
      }
      if (!modal.hidden) exportText.value = buildExportText();
    }

    // opts: { flavor, portion, price, addonName, group, autoNote }
    // 加料作为独立条目入车（带自己的 group 与 autoNote），key 用 |A| 区分加料条目。
    function changeQty(item, delta, opts) {
      opts = opts || {};
      var key = item.key;
      if (opts.addonName) {
        key += "|A|" + opts.addonName;
      } else {
        var spec = [opts.flavor, opts.portion].filter(Boolean);
        if (spec.length) key += "|" + spec.join("|");
      }
      var found = null, idx = -1;
      for (var i = 0; i < cart.entries.length; i++) {
        if (cart.entries[i].key === key) { found = cart.entries[i]; idx = i; break; }
      }
      if (found) {
        found.qty += delta;
        if (found.qty <= 0) cart.entries.splice(idx, 1);
        else if (found.qty > 99) found.qty = 99;
      } else if (delta > 0) {
        cart.entries.push({
          key: key,
          name: opts.addonName || item.name,
          price: opts.price != null ? opts.price : item.price,
          group: opts.group || item.group,
          qty: Math.min(delta, 99),
          flavor: opts.flavor || "", portion: opts.portion || "",
          autoNote: opts.autoNote || ""
        });
      }
      saveCart();
      syncUI();
    }

    // 飞入动画：从按钮生成一个圆，受重力 + 对购物车的吸引力，到达后消失并让购物车跳动
    function flyToCart(x, y) {
      var fr = fab.getBoundingClientRect();
      if (!fr.width) return;
      var tx = fr.left + fr.width / 2, ty = fr.top + fr.height / 2;
      var dot = document.createElement("div");
      dot.className = "fly-dot";
      document.body.appendChild(dot);

      var vx = (Math.random() - 0.5) * 2;
      var vy = -8;                 // 初始向上弹出
      var k = 0.02, damp = 0.9, gravity = 0.15;
      var frames = 0;

      function step() {
        vx += (tx - x) * k;
        vy += (ty - y) * k + gravity;   // 重力 + 对购物车的吸引力（弹簧式）
        vx *= damp; vy *= damp;
        x += vx; y += vy;
        dot.style.transform = "translate(" + (x - 8) + "px," + (y - 8) + "px)";
        frames++;
        var dist = Math.sqrt((tx - x) * (tx - x) + (ty - y) * (ty - y));
        if (dist < 16 || frames > 100) {
          if (dot.parentNode) dot.parentNode.removeChild(dot);
          fab.classList.remove("bump");
          void fab.offsetWidth;            // 重置动画
          fab.classList.add("bump");
          return;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    // 事件委托：卡片按钮
    document.getElementById("content").addEventListener("click", function (ev) {
      var btn = ev.target.closest("button");
      if (!btn) return;
      var ctrl = btn.closest("[data-ctrl-key]");
      if (!ctrl) return;
      var item = catalogMap[ctrl.getAttribute("data-ctrl-key")];
      if (!item) return;
      if (item.spec || (item.addons && item.addons.length)) {
        // 带规格或加料：打开选择弹窗，在弹窗内选口味/份量/加料
        openSpec(item);
        return;
      }
      if (btn.classList.contains("qty-minus")) {
        changeQty(item, -1);
      } else if (btn.classList.contains("add-btn") || btn.classList.contains("qty-plus")) {
        var r = btn.getBoundingClientRect();
        var sx = r.left + r.width / 2, sy = r.top + r.height / 2;
        changeQty(item, 1);
        flyToCart(sx, sy);
      }
    });

    // 规格/加料选择弹窗：口味 + 份量 + 加料（多选，独立入车并生成备注）
    var specModal = document.getElementById("specModal");
    var specFlavors = document.getElementById("specFlavors");
    var specPortionsWrap = document.getElementById("specPortionsWrap");
    var specPortions = document.getElementById("specPortions");
    var specAddonsWrap = document.getElementById("specAddonsWrap");
    var specAddons = document.getElementById("specAddons");
    var specPrice = document.getElementById("specPrice");
    var specCurrentWrap = document.getElementById("specCurrentWrap");
    var specCurrent = document.getElementById("specCurrent");
    var specItem = null;
    var selFlavor = "", selPortion = "";
    var selAddons = [];   // 选中的加料名数组

    function updateSpecPrice() {
      var p = 0;
      if (specItem.spec) {
        (specItem.spec.portions || []).forEach(function (x) {
          if (x.name === selPortion) p = x.price;
        });
      } else {
        p = specItem.price;
      }
      selAddons.forEach(function (n) {
        var a = (specItem.addons || []).filter(function (x) { return x.name === n; })[0];
        if (a) p += a.price;
      });
      specPrice.textContent = "¥" + p;
    }
    function entryDisplay(e) {
      if (e.key.indexOf("|A|") !== -1) return e.name + "（加料）";
      return [e.flavor, e.portion].filter(Boolean).join("·");
    }
    function renderSpecCurrent() {
      var list = cart.entries.filter(function (e) {
        return e.key.indexOf(specItem.key + "|") === 0;
      });
      if (!list.length) { specCurrentWrap.hidden = true; return; }
      specCurrentWrap.hidden = false;
      specCurrent.innerHTML = "";
      list.forEach(function (e) {
        var row = document.createElement("div");
        row.className = "cart-ctrl has-qty";
        row.style.maxWidth = "260px";
        var minus = document.createElement("button");
        minus.className = "qty-minus spec-curr-minus";
        minus.type = "button"; minus.textContent = "−";
        var num = document.createElement("span");
        num.className = "qty-num"; num.textContent = e.qty;
        var plus = document.createElement("button");
        plus.className = "qty-plus spec-curr-plus";
        plus.type = "button"; plus.textContent = "+";
        var label = document.createElement("span");
        label.style.cssText = "flex:1;font-size:13px";
        label.textContent = entryDisplay(e) + "  ¥" + e.price;
        minus.setAttribute("data-k", e.key);
        plus.setAttribute("data-k", e.key);
        row.appendChild(label); row.appendChild(minus); row.appendChild(num); row.appendChild(plus);
        specCurrent.appendChild(row);
      });
    }
    function renderSpecOptions() {
      // 口味
      specFlavors.innerHTML = "";
      if (specItem.spec) {
        (specItem.spec.flavors || []).forEach(function (f) {
          var b = document.createElement("button");
          b.type = "button"; b.className = "spec-opt" + (f === selFlavor ? " selected" : "");
          b.textContent = f;
          b.addEventListener("click", function () { selFlavor = f; renderSpecOptions(); });
          specFlavors.appendChild(b);
        });
      }
      // 份量
      specPortionsWrap.hidden = !specItem.spec;
      specPortions.innerHTML = "";
      if (specItem.spec) {
        (specItem.spec.portions || []).forEach(function (p) {
          var b = document.createElement("button");
          b.type = "button"; b.className = "spec-opt" + (p.name === selPortion ? " selected" : "");
          b.textContent = p.name + " ¥" + p.price;
          b.addEventListener("click", function () { selPortion = p.name; renderSpecOptions(); updateSpecPrice(); });
          specPortions.appendChild(b);
        });
      }
      // 加料（多选）
      specAddonsWrap.hidden = !(specItem.addons && specItem.addons.length);
      specAddons.innerHTML = "";
      (specItem.addons || []).forEach(function (a) {
        var on = selAddons.indexOf(a.name) !== -1;
        var b = document.createElement("button");
        b.type = "button"; b.className = "spec-opt" + (on ? " selected" : "");
        b.textContent = a.name + " +¥" + a.price;
        b.addEventListener("click", function () {
          var i = selAddons.indexOf(a.name);
          if (i === -1) selAddons.push(a.name); else selAddons.splice(i, 1);
          renderSpecOptions(); updateSpecPrice();
        });
        specAddons.appendChild(b);
      });
    }
    function openSpec(item) {
      specItem = item;
      selFlavor = item.spec ? (item.spec.flavors[0] || "") : "";
      selPortion = item.spec ? ((item.spec.portions[0] || {}).name || "") : "";
      selAddons = [];
      document.getElementById("specTitle").textContent = item.name;
      document.getElementById("specConfirm").textContent =
        item.spec ? "加入购物车" : "加入购物车";
      renderSpecOptions();
      updateSpecPrice();
      renderSpecCurrent();
      specModal.hidden = false;
    }
    function currentPortionPrice() {
      var p = specItem.price;
      if (specItem.spec) {
        (specItem.spec.portions || []).forEach(function (x) { if (x.name === selPortion) p = x.price; });
      }
      return p;
    }
    function addSpec() {
      if (specItem.spec && (!selFlavor || !selPortion)) { toast("请选择口味和份量"); return; }
      // 主菜入车
      changeQty(specItem, 1, {
        flavor: selFlavor, portion: selPortion, price: currentPortionPrice()
      });
      // 加料分别作为独立条目入车，按模板生成备注
      selAddons.forEach(function (n) {
        var a = (specItem.addons || []).filter(function (x) { return x.name === n; })[0];
        if (!a) return;
        var note = (a.noteTemplate || "")
          .replace(/\{addon\}/g, a.name)
          .replace(/\{base\}/g, specItem.name);
        changeQty(specItem, 1, {
          addonName: a.name, price: a.price, group: a.group, autoNote: note
        });
      });
      renderSpecCurrent();
      var r = document.getElementById("specConfirm").getBoundingClientRect();
      flyToCart(r.left + r.width / 2, r.top + r.height / 2);
      toast("已加入购物车");
    }
    document.getElementById("specConfirm").addEventListener("click", addSpec);
    document.getElementById("specCancel").addEventListener("click", function () { specModal.hidden = true; });
    document.getElementById("specClose").addEventListener("click", function () { specModal.hidden = true; });
    specModal.addEventListener("click", function (ev) { if (ev.target === this) this.hidden = true; });
    // 已加入条目的增减
    specCurrent.addEventListener("click", function (ev) {
      var b = ev.target.closest("button");
      if (!b) return;
      var key = b.getAttribute("data-k");
      var e = null;
      for (var i = 0; i < cart.entries.length; i++) { if (cart.entries[i].key === key) { e = cart.entries[i]; break; } }
      if (!e) return;
      var isAddon = e.key.indexOf("|A|") !== -1;
      var opts;
      if (isAddon) {
        opts = { addonName: e.name.replace(/（加料）$/, ""), price: e.price, group: e.group, autoNote: e.autoNote };
      } else {
        opts = { flavor: e.flavor, portion: e.portion, price: e.price };
      }
      changeQty(specItem, b.classList.contains("spec-curr-plus") ? 1 : -1, opts);
      renderSpecCurrent();
    });

    // 悬浮按钮 / 模态框
    fab.addEventListener("click", function () {
      exportText.value = buildExportText();
      noteInput.value = cart.note;
      modal.hidden = false;
    });
    document.getElementById("modalClose").addEventListener("click", function () { modal.hidden = true; });
    modal.addEventListener("click", function (ev) { if (ev.target === this) this.hidden = true; });

    // 备注实时持久化并刷新导出文本
    noteInput.addEventListener("input", function () {
      cart.note = this.value; saveCart();
      exportText.value = buildExportText();
    });

    // 清空
    document.getElementById("clearCart").addEventListener("click", function () {
      if (!window.confirm("确定清空购物车？")) return;
      cart.entries = []; saveCart(); syncUI();
      toast("购物车已清空");
    });

    // 一键复制（clipboard + execCommand 降级）
    function copyText(text) {
      function fallback() {
        exportText.value = text;
        exportText.focus(); exportText.select();
        try { exportText.setSelectionRange(0, exportText.value.length); } catch (e) {}
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) {}
        toast(ok ? "已复制订单，可直接粘贴发送" : "复制失败，请长按文本框手动复制");
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () {
          toast("已复制订单，可直接粘贴发送");
        }).catch(fallback);
      } else {
        fallback();
      }
    }
    document.getElementById("copyOrder").addEventListener("click", function () {
      copyText(buildExportText());
    });

    reconcile(); saveCart(); syncUI();
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

  /* 图片预览弹窗 */
  .thumb, .dz-img { cursor: zoom-in; }
  .preview-mask {
    position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 100;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .preview-mask[hidden] { display: none; }
  .preview-box { position: relative; max-width: 92vw; max-height: 88vh; }
  .preview-box img { max-width: 92vw; max-height: 88vh; border-radius: 12px; box-shadow: 0 8px 40px rgba(0,0,0,.5); display: block; }
  .preview-close {
    position: absolute; top: -14px; right: -14px; width: 36px; height: 36px; border-radius: 50%;
    background: #fff; color: #1f2329; border: none; font-size: 20px; line-height: 1;
    cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center;
  }
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

  <div class="preview-mask" id="previewMask" hidden>
    <div class="preview-box">
      <button class="preview-close" id="previewClose" aria-label="关闭预览">✕</button>
      <img id="previewImg" alt="" />
    </div>
  </div>

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
/* 图片点击预览 */
function openPreview(src) {
  if (!src) return;
  $("previewImg").src = src;
  $("previewMask").hidden = false;
}
$("previewClose").addEventListener("click", function () { $("previewMask").hidden = true; });
$("previewMask").addEventListener("click", function (ev) { if (ev.target === this) this.hidden = true; });
document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") $("previewMask").hidden = true; });

dz.addEventListener("click", function (e) {
  // 点击已上传的缩略图时预览大图，不触发文件选择
  if (e.target === $("dzImg")) { openPreview($("dzImg").src); return; }
  $("dzFile").click();
});
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
        ? '<img class="thumb preview-thumb" src="' + esc(it.image) + '" alt="" title="点击预览" />'
        : '<div class="thumb empty">' + esc(cat.icon || "🍽️") + '</div>';
      row.innerHTML =
        thumb +
        '<input class="i-name" type="text" value="' + esc(it.name) + '" placeholder="菜名" />' +
        '<input class="i-price" type="number" min="0" step="0.5" value="' + it.price + '" placeholder="价格" />' +
        '<input class="i-desc" type="text" value="' + esc(it.desc || "") + '" placeholder="描述" />' +
        '<input class="i-tag" type="text" value="' + esc(it.tag || "") + '" placeholder="标签" />' +
        '<button class="ghost small del-item">删除</button>';
      var pt = row.querySelector(".preview-thumb");
      if (pt) pt.addEventListener("click", function () { openPreview(state.categories[ci].items[ii].image); });
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
