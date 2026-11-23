// 从 jpg/crops 裁剪图生成完整菜单 payload，写入 payload.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = "jpg/crops";
const img = (name) =>
  "data:image/jpeg;base64," + readFileSync(join(dir, name + ".jpg")).toString("base64");

const menu = {
  restaurant: {
    name: "鸭血粉丝汤",
    tagline: "鸭血粉丝汤 · 独味锁骨 · 各种炸串",
    notice: "炒饭炒面同价；锁骨分小/中/大份；炸串现炸现卖",
  },
  categories: [
    {
      id: "signature",
      name: "鸭血粉丝汤",
      icon: "🍜",
      items: [
        { name: "素粉丝面", price: 5, desc: "清汤粉丝，素食可选" },
        { name: "鸭血粉丝面", price: 10, desc: "招牌鸭血粉丝，汤鲜味美", tag: "招牌" },
        { name: "荤杂粉丝面", price: 18, desc: "鸭血+卤味双拼，分量十足" },
        { name: "素蛋/卤蛋", price: 2, desc: "单加卤蛋" },
      ],
    },
    {
      id: "chao",
      name: "炒饭 / 炒面",
      icon: "🍚",
      items: [
        { name: "蛋炒饭/面", price: 7 },
        { name: "鸭肠炒饭/面", price: 13 },
        { name: "鸭肝炒饭/面", price: 13 },
        { name: "鸭心炒饭/面", price: 13 },
        { name: "鸭珍炒饭/面", price: 13 },
        { name: "鸭腱炒饭/面", price: 18 },
        { name: "鸭杂炒饭/面", price: 18 },
        { name: "鸭肉炒饭/面", price: 18 },
      ],
    },
    {
      id: "jialiao",
      name: "粉丝汤加料",
      icon: "🥢",
      items: [
        { name: "香干", price: 2 },
        { name: "鸭头", price: 6 },
        { name: "鸭腚", price: 8 },
        { name: "鸭脖", price: 5 },
        { name: "卤牛肉", price: 3 },
        { name: "卤鸡", price: 3 },
        { name: "卤肝", price: 3 },
        { name: "卤肺", price: 5 },
        { name: "卤肠", price: 3 },
      ],
    },
    {
      id: "suogu",
      name: "独味锁骨",
      icon: "🍗",
      items: [
        { name: "锁骨小份（鸡排/鸡架/鸡胗）", price: 10, image: img("chicken_nugget"), desc: "三选一" },
        { name: "锁骨中份", price: 15, image: img("chicken_strip") },
        { name: "锁骨大份", price: 20, image: img("chicken_wing") },
        { name: "鸡腿", price: 6, image: img("fried_chicken_leg"), desc: "单个" },
        { name: "全翅", price: 20, image: img("chicken_wing"), desc: "单个" },
      ],
    },
    {
      id: "zha",
      name: "各种炸串",
      icon: "🍢",
      items: [
        { name: "混合拼盘（油条+麻花+双色球）", price: 3, image: img("mixed_skewer"), tag: "招牌" },
        { name: "烤馒头串", price: 4, image: img("bun_skewer") },
        { name: "玉米串", price: 5, image: img("corn") },
        { name: "馒头串（白/玉米）", price: 4, image: img("bun") },
        { name: "鸡块", price: 10, image: img("chicken_nugget") },
        { name: "鸡柳", price: 10, image: img("chicken_strip") },
        { name: "鸡翅", price: 10, image: img("chicken_wing") },
        { name: "芝麻串", price: 3, image: img("sesame") },
        { name: "黄金球", price: 5, image: img("green_ball") },
        { name: "双色球", price: 3, image: img("dual_ball") },
        { name: "脆皮肠", price: 3, image: img("crispy_sausage") },
        { name: "火腿肠", price: 5, image: img("ham_sausage") },
        { name: "炸鸡腿", price: 6, image: img("fried_chicken_leg") },
        { name: "手抓饼", price: 3, image: img("pancake") },
        { name: "星星串", price: 3, image: img("star") },
        { name: "烤肠", price: 3, image: img("grilled_sausage") },
        { name: "虾串", price: 2, image: img("shrimp") },
      ],
    },
  ],
};

writeFileSync("payload.json", JSON.stringify(menu));
const size = readFileSync("payload.json").length;
console.log("payload.json 生成，大小", (size / 1024).toFixed(1), "KB，菜品数",
  menu.categories.reduce((n, c) => n + c.items.length, 0));
