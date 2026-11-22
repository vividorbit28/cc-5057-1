// Node 侧套件加载：读取 kits/ 目录下的套件文件并注册（浏览器端由 ui/main.js 经 fetch 注册）
import { readFileSync } from 'node:fs';
import { registerKitData } from './kit.js';

export function loadBuiltinKits() {
  const idx = JSON.parse(readFileSync(new URL('../kits/index.json', import.meta.url), 'utf8'));
  return idx.kits.map((f) =>
    registerKitData(JSON.parse(readFileSync(new URL(`../kits/${f}`, import.meta.url), 'utf8'))));
}
