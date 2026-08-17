// smoke.mjs — 轻量 DOM 桩 + 加载全部前端脚本，验证启动与事件接线不抛错。
// 重点：player.js 的 track/buffer/error 事件都带 state 对象；ui.js 必须按此解包。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 交付包布局：tools/ 与 app/ 平级，前端资源都在 app/ 下
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---------------- 极简 DOM 桩 ---------------- */
const docRoot = makeEl('#document');

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: '',
    _class: new Set(),
    className: '',
    dataset: {},
    _attrs: {},
    style: {},
    children: [],
    parentNode: null,
    _listeners: {},
    _text: '',
    _html: '',
    value: '',
    disabled: false,
    title: '',
    src: '',
    offsetWidth: 60, offsetLeft: 10, offsetTop: 0,
    clientHeight: 400, clientWidth: 600, scrollTop: 0, scrollLeft: 0,
    get classList() {
      const c = el._class;
      return {
        add: (...x) => x.forEach(v => c.add(v)),
        remove: (...x) => x.forEach(v => c.delete(v)),
        toggle: (v, f) => { const has = c.has(v); const on = f === undefined ? !has : !!f; on ? c.add(v) : c.delete(v); return on; },
        contains: (v) => c.has(v)
      };
    },
    set className(v) { el._class = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...el._class].join(' '); },
    setAttribute(k, v) { el._attrs[k] = String(v); if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    hasAttribute(k) { return k in el._attrs; },
    removeAttribute(k) { delete el._attrs[k]; },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener(t, fn) { (el._listeners[t] || (el._listeners[t] = [])).push(fn); },
    removeEventListener(t, fn) { const a = el._listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    dispatchEvent(ev) { ev.target = ev.target || el; (el._listeners[ev.type] || []).forEach(fn => fn(ev)); return true; },
    click() { el.dispatchEvent({ type: 'click', target: el, closest: (s) => closest(el, s) }); },
    focus() {}, select() {}, blur() {},
    scrollTo() {}, scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 0, right: 100, bottom: 0 }; },
    get textContent() { return el._text; },
    set textContent(v) { el._text = String(v); },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); /* 不解析子树，仅存字符串 */ },
  };
  return el;
}

/* 解析 index.html 构建真实结构树 */
const VOID = new Set(['meta','link','input','br','img','use','path','hr','source','area','base','col','embed','param','track','wbr']);
function parseHTML(src) {
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g;
  const stack = [docRoot];
  let m;
  while ((m = re.exec(src))) {
    if (!m[2]) continue; // 注释等无标签匹配
    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    const selfClose = m[4] === '/';
    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) { if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; } }
      continue;
    }
    const el = makeEl(tag);
    const ar = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g; let am;
    while ((am = ar.exec(attrs))) {
      const k = am[1], v = am[2] != null ? am[2] : '';
      if (k === 'id') el.id = v;
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    stack[stack.length - 1].appendChild(el);
    if (!VOID.has(tag) && !selfClose) stack.push(el);
  }
  return docRoot;
}
parseHTML(html);

function matchCompound(el, c) {
  const idm = c.match(/#([\w-]+)/); if (idm && el.id !== idm[1]) return false;
  const tagm = c.match(/^([a-zA-Z]+)/); if (tagm && el.tagName !== tagm[1].toUpperCase()) return false;
  const classes = [...c.matchAll(/\.([\w-]+)/g)].map(x => x[1]);
  for (const cl of classes) if (!el._class.has(cl)) return false;
  const attrs = [...c.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
  for (const a of attrs) { const v = el.getAttribute(a[1]); if (v == null) return false; if (a[2] != null && v !== a[2]) return false; }
  return true;
}
function walk(el, out) { for (const c of el.children) { out.push(c); walk(c, out); } return out; }
function matchesChain(el, parts) {
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let pi = parts.length - 2, anc = el.parentNode;
  while (pi >= 0 && anc && anc !== docRoot) { if (matchCompound(anc, parts[pi])) pi--; anc = anc.parentNode; }
  return pi < 0;
}
function queryAll(root, sel) {
  const parts = sel.trim().split(/\s+/);
  const all = walk(root, []);
  return all.filter(e => matchesChain(e, parts));
}
function closest(el, sel) {
  const parts = sel.trim().split(/\s+/);
  let cur = el;
  while (cur && cur !== docRoot) { if (matchesChain(cur, parts)) return cur; cur = cur.parentNode; }
  return null;
}

const document = {
  getElementById: (id) => queryAll(docRoot, '#' + id)[0] || null,
  querySelector: (sel) => queryAll(docRoot, sel)[0] || null,
  querySelectorAll: (sel) => queryAll(docRoot, sel),
  createElement: (t) => makeEl(t),
  addEventListener: (t, fn) => { (docRoot._listeners[t] || (docRoot._listeners[t] = [])).push(fn); },
  body: docRoot,
  fonts: { ready: Promise.resolve() }
};
// 让元素方法能用全局 document
makeEl; // noop

/* ---------------- 全局桩 ---------------- */
const localStore = new Map();
globalThis.window = globalThis;
globalThis.document = document;
globalThis.CSS = { escape: (s) => String(s) };
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.confirm = () => true;
globalThis.localStorage = {
  getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => localStore.set(k, String(v)),
  removeItem: (k) => localStore.delete(k),
  get length() { return localStore.size; },
  key: (i) => [...localStore.keys()][i] || null
};
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.fetch = () => Promise.reject(new Error('no-net-in-sandbox'));
globalThis.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ---------------- 加载脚本 ---------------- */
const files = ['js/store.js', 'js/sources.js', 'js/player.js', 'js/ui.js'];
const errors = [];
for (const f of files) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try {
    // 直接 eval 在模块作用域；用 Function 包装，避免顶层 return 限制
    (0, eval)(code);
  } catch (e) {
    errors.push('LOAD ' + f + ': ' + (e && e.stack || e));
  }
}

/* ---------------- 触发交互路径 ---------------- */
function step(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { errors.push('STEP ' + name + ': ' + (e && e.stack || e)); console.log('  ✗ ' + name + ' -> ' + (e && e.message)); }
}

console.log('Smoke test:');
step('boot 已执行（无启动异常）', () => { if (!globalThis.Player) throw new Error('Player 未定义'); if (!globalThis.Store) throw new Error('Store 未定义'); });

const Player = globalThis.Player;
const Sources = globalThis.Sources;

step('切换平台到 tencent', () => { document.querySelector('#platformSeg').dispatchEvent({ type: 'click', target: document.querySelector('[data-platform="tencent"]'), closest: (s) => closest(document.querySelector('[data-platform="tencent"]'), s) }); });

step('setShuffle → mode 事件', () => Player.setShuffle(true));
step('setVolume → volume 事件', () => Player.setVolume(0.4));
step('cycleSpeed → speed 事件', () => Player.cycleSpeed());
step('cycleRepeat → mode 事件', () => Player.cycleRepeat());
step('sleepIn(15) → sleep 事件', () => Player.sleepIn(15));
step('cancelSleep → sleep 事件', () => Player.cancelSleep());

step('setQueue → 触发 track/status/cover/lyric/error 处理', () => {
  const tr = { uid: 't1', platform: 'tencent', id: '1', name: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269000, lyricId: '1', urlId: '1', picId: '1' };
  Player.setQueue([tr], 0, false);
});

step('toggle 播放', () => Player.toggle());
step('next/prev 切歌', () => { Player.next(true); Player.prev(); });
step('openLyric 打开沉浸式歌词', () => document.querySelector('#btnLyric').click());
step('lyric 页切歌/暂停按钮', () => {
  document.querySelector('#lyricPrev').click();
  document.querySelector('#lyricNext').click();
  document.querySelector('#lyricPlay').click();
  document.querySelector('#lyricShuffle').click();
});
step('openImportModal 打开导入弹窗', () => document.querySelector('#btnImport').click());
step('openSleepModal 打开定时弹窗', () => document.querySelector('#btnSleep').click());
step('qualityChip 点击切换首选音质', () => document.querySelector('#qualityChip').click());

// 给异步的 resolveUrl/lyric 一个微任务窗口
await new Promise(r => setTimeout(r, 50));

step('下载按钮（无音源会走 catch 路径）', () => {
  try { Player.download({ uid: 'x', platform: 'tencent', id: '1', name: 'x', artist: 'y' }); } catch (e) {}
});

console.log('\n结果：' + (errors.length ? ('发现 ' + errors.length + ' 个问题') : '全部通过'));
errors.forEach(e => console.log('\n--- ' + e));
process.exit(errors.length ? 1 : 0);
