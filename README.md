# 🎵 MusicHub

> 纯前端、零服务器的音乐客户端**框架**。**本仓库不内置任何音源**——所有音频来源都由你通过自定义配置自行接入。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL_3.0-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web--only-lightgrey.svg)](#)
[![Zero Backend](https://img.shields.io/badge/backend-none-brightgreen.svg)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

---

## ✨ 特性

- **纯前端 / 无服务器**：整站只有 HTML + CSS + 原生 JS，不依赖任何自有后端，可直接托管到任意静态空间（GitHub Pages / EdgeOne / Vercel / Nginx…）。
- **零内置音源**：仓库默认**不含**任何音乐平台的接口。搜不到歌、播不了歌不是 bug——你需要在 `sources.config.js` 里注册自己的音源（见下文）。
- **可插拔音源**：一条音源 = 一个 JS 对象（`Sources.registerProvider({ ... })`）。声明搜索 / 播放 / 歌词 / 封面 / 歌单 / 排行榜能力即可。
- **Apple 液态玻璃 UI**：浅色系、单强调色、系统字体栈、Spring 缓动动画，不跟随专辑封面色。
- **完整播放器**：倍速（0.5×–2×）、定时关闭、全局快捷键、歌单导入、收藏/历史、沉浸式歌词页（切歌 + 暂停）。
- **无损优先引擎**：繁简归一匹配 + 加权并发竞速，声明 `lossless` 能力的音源会被优先尝试。
- **开箱即用**：内置零依赖静态服务器（`tools/serve.mjs` / `serve.py`），双击启动器即可本地运行，绕开 `file://` 的 CORS 限制。

## 📁 目录结构

```
MusicHub/
├── app/                      # 纯前端主程序（无构建步骤）
│   ├── index.html
│   ├── css/app.css
│   └── js/
│       ├── store.js         # localStorage 持久化（设置/收藏/历史）
│       ├── sources.js       # 音源适配层（引擎 + 注册表，默认仅 'custom'）
│       ├── sources.config.js        # ★ 你的音源配置（默认空，开箱即「无音源」）
│       ├── sources.config.example.js# 完整示例，照抄即用
│       ├── player.js        # 播放内核（双 audio 接力 / 倍速 / 定时）
│       └── ui.js            # 界面与交互
├── tools/                   # 零依赖静态服务器 + 冒烟测试
│   ├── serve.mjs
│   ├── serve.py
│   └── smoke-test.mjs
├── docs/                    # 文档
│   ├── architecture.md      # 架构设计
│   └── custom-source.md     # 自定义音源指南
├── .github/                 # Issue / PR 模板
├── LICENSE
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── SECURITY.md
```

## 🚀 快速开始

### 方式一：本地一键运行（推荐）

```bash
# 需要 Node.js 或 Python 其一
node tools/serve.mjs          # 自动选空闲端口并打开浏览器
# 或
python tools/serve.py
```

> 为什么必须起本地服务？因为纯前端调用跨域音源会被 `file://` 协议拦截。
> 该服务器零依赖、不联网、不对外暴露，仅用于本地绕过 CORS。

### 方式二：直接部署到静态托管

把 `app/` 整个目录上传到任意静态空间即可（GitHub Pages / EdgeOne Pages / Vercel / Nginx…）。
`app/` 是一个完整站点，`index.html` 是入口，无需任何构建。

## 🔌 配置你的音源（最重要的一步）

仓库**默认没有任何音源**。两种方式接入：

### 方式 A：设置面板里填模板（最省事）

打开应用 → 「设置」→「自定义音源」，填入两个 URL 模板：

- 搜索：`https://你的接口/search?kw={keyword}&src={platform}`
- 播放：`https://你的接口/url?id={id}&br={br}`

占位符：`{keyword}` `{page}` `{limit}`（搜索）、`{id}` `{name}` `{artist}` `{br}`（播放）。

### 方式 B：在 `sources.config.js` 里注册完整音源

```js
Sources.registerProvider({
  id: 'my-source',
  label: '我的音源',
  tier: Sources.TIER.HIGH,        // LOSSLESS(0) / HIGH(1) / PREVIEW(2)
  weight: 90,                     // 竞速权重，越大越优先
  caps: { search: 1, url: 1, lyric: 1, pic: 1 },
  search: function (kw, page, limit) { /* -> Promise<track[]> */ },
  url:    function (track, br)    { /* -> Promise<{url, br, size}> */ },
  lyric:  function (track)        { /* -> Promise<{lyric, tlyric}> */ },
  pic:    function (track, size)  { /* -> string | null */ }
});
```

更完整的示例见 [`app/js/sources.config.example.js`](app/js/sources.config.example.js)，以及文档 [`docs/custom-source.md`](docs/custom-source.md)。

## 🧱 架构简述

四层、零框架：

1. **音源适配层 (`sources.js`)** — `PROVIDERS` 注册表 + 匹配/竞速/缓存引擎。对外暴露 `Sources.search / resolveUrl / lyric / picUrl / playlist / toplist / registerProvider / configure`。
2. **播放内核 (`player.js`)** — 事件驱动的 `Player` 状态机，双 `<audio>` 元素接力实现无缝切歌，支持倍速、定时关闭。
3. **UI 层 (`ui.js`)** — Apple 液态玻璃风格，搜索双平台分开、歌词页沉浸、底部播放条固定浅蓝。
4. **持久化 (`store.js`)** — `localStorage` 命名空间隔离（设置 / 收藏 / 历史）。

详细设计见 [`docs/architecture.md`](docs/architecture.md)。

## 📜 许可证

[GPL-3.0](LICENSE) © MusicHub Contributors

## ⚠️ 免责声明

本项目是一个**技术框架与示例**，本身不提供、不托管、不缓存任何受版权保护的音频内容。
所有音源均由使用者自行配置，**使用者须自行确保其接入的接口与用途符合所在国家/地区的法律法规**。
本项目不对使用者的任何违规行为负责。

## 🤝 Contributing

欢迎 Issue / PR！详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
