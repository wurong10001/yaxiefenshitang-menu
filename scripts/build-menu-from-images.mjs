// 按新版菜单表格生成 payload.json（图片取自 jpg/crops）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = "jpg/crops";
const img = (name) =>
  "data:image/jpeg;base64," + readFileSync(join(dir, name + ".jpg")).toString("base64");

const menu = {
  restaurant: {
    name: "鸭血粉丝汤",
    tagline: "鸭血粉丝汤 · 独味锁骨 · 各种炸串",
    notice: "口味可选：孜然味 / 辣椒味 / 梅子味 / 椒盐味 / 胡椒味 / 番茄味",
  },
  categories: [
    {
      id: "yaxue",
      name: "鸭血粉丝汤",
      icon: "🍜",
      items: [
        { name: "素粉丝/面", price: 5 },
        { name: "鸭血粉丝/面", price: 10, tag: "招牌" },
        { name: "鸭杂粉丝/面", price: 18 },
        { name: "煎蛋/卤蛋", price: 2 },
        { name: "香干", price: 2, desc: "加料" },
        { name: "鸭头", price: 6, desc: "加料" },
        { name: "鸭腿", price: 8, desc: "加料" },
        { name: "鸭胗", price: 5, desc: "加料" },
        { name: "鸭心", price: 2, desc: "3个" },
        { name: "鸭肝", price: 3, desc: "每份" },
        { name: "鸭肠", price: 5, desc: "每份" },
        { name: "鸭血", price: 3, desc: "每份" },
      ],
    },
    {
      id: "chao",
      name: "炒饭 / 面系列",
      icon: "🍚",
      items: [
        { name: "蛋炒饭/面", price: 7 },
        { name: "鸭肠炒饭/面", price: 13 },
        { name: "鸭肝炒饭/面", price: 13 },
        { name: "鸭心炒饭/面", price: 13 },
        { name: "鸭胗炒饭/面", price: 13 },
        { name: "鸭腿炒饭/面", price: 18 },
        { name: "鸭杂炒饭/面", price: 18 },
        { name: "鸭肉炒饭/面", price: 18 },
      ],
    },
    {
      id: "suogu",
      name: "独味锁骨",
      icon: "🍗",
      items: [
        {
          name: "鸡排 / 鸡架 / 鸡柳 / 小酥肉",
          price: 10,
          desc: "小份 · 口味可选（孜然/辣椒/梅子/椒盐/胡椒/番茄）",
          image: img("chicken_strip"),
        },
        {
          name: "鸡排 / 鸡架 / 鸡柳 / 小酥肉",
          price: 15,
          desc: "中份",
          image: img("chicken_nugget"),
        },
        {
          name: "鸡排 / 鸡架 / 鸡柳 / 小酥肉",
          price: 20,
          desc: "大份",
          image: img("chicken_wing"),
        },
        { name: "鸡腿", price: 6, desc: "每个", image: img("fried_chicken_leg") },
        { name: "全鸡", price: 20, desc: "每个" },
      ],
    },
    {
      id: "zhachuan",
      name: "各种炸串",
      icon: "🍢",
      items: [
        { name: "鸡块/鸡柳（托盘装）", price: 10, image: img("chicken_nugget") },
        { name: "白色棒（椰蓉）", price: 4, image: img("bun") },
        { name: "黄色棒 / 芝士棒", price: 5, image: img("corn") },
        { name: "大鸡排串 / 丸子串（多色）", price: 3, image: img("mixed_skewer") },
        { name: "香肠串", price: 5, image: img("ham_sausage") },
        { name: "大鸡腿", price: 6, image: img("fried_chicken_leg") },
        { name: "星星鸡块 / 爱心鸡排串", price: 3, image: img("star") },
        { name: "骨肉相连", price: 3, image: img("grilled_sausage") },
        { name: "大翅中", price: 5, image: img("chicken_wing") },
        { name: "年糕串", price: 2, image: img("rice_cake") },
      ],
    },
  ],
};

writeFileSync("payload.json", JSON.stringify(menu));
const size = readFileSync("payload.json").length;
console.log(
  "payload.json 生成，大小",
  (size / 1024).toFixed(1),
  "KB，分类",
  menu.categories.length,
  "菜品",
  menu.categories.reduce((n, c) => n + c.items.length, 0),
  "图片",
  menu.categories.reduce((n, c) => n + c.items.filter((i) => i.image).length, 0)
);
