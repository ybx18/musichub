# 架构设计

MusicHub 是一个**纯前端、零服务器**的音乐客户端框架。核心原则：界面与播放逻辑内置，音频来源外置（由使用者配置）。

## 分层

```
┌─────────────────────────────────────────────┐
│  UI 层 (ui.js)   搜索 / 歌词页 / 播放条 / 设置  │  Apple 液态玻璃
├─────────────────────────────────────────────┤
│  播放内核 (player.js)  状态机 / 双audio接力 / 倍速 / 定时 │
├─────────────────────────────────────────────┤
│  音源适配层 (sources.js)  PROVIDERS 注册表 + 引擎      │
│    ├─ search / resolveUrl / lyric / picUrl          │
│    ├─ 繁简归一 scoreMatchV2 + raceWeighted 竞速        │
│    └─ 缓存（内存 + localStorage）                     │
├─────────────────────────────────────────────┤
│  持久化 (store.js)  localStorage 命名空间隔离          │
└─────────────────────────────────────────────┘
        ▲
        │  Sources.registerProvider({...})  ← 使用者在这里注入音源
        │
   sources.config.js （默认空）
```

## 音源注册表（PROVIDERS）

本仓库 `PROVIDERS` **默认仅含一个 `custom` 占位适配器**，它不指向任何具体服务，
完全由用户在「设置 → 自定义音源」里填模板驱动。

任何可用音源都是一个对象：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识 |
| `label` | 显示名 |
| `tier` | `Sources.TIER.LOSSLESS(0)` / `HIGH(1)` / `PREVIEW(2)` |
| `weight` | 竞速权重（数字，越大越优先） |
| `caps` | 能力开关：`search` `url` `lyric` `pic` `playlist` `toplist` `lossless` |
| `search(kw,page,limit)` | → `Promise<track[]>` |
| `url(track,br)` | → `Promise<{url,br,size}>` |
| `lyric(track)` | → `Promise<{lyric,tlyric}>` |
| `pic(track,size)` | → `string \| null` |
| `playlist(server,id)` | → `Promise<track[]>` |
| `toplist(id)` | → `Promise<track[]>` |

`searchPlan` / 歌词计划 / 封面计划 / `playlist` / `toplist` **全部基于注册表动态推导**，
不再写死到任何平台。因此「无内置音源」时这些能力自然退化为空。

## 匹配与竞速引擎

- **`scoreMatchV2`**：歌名/歌手相似度评分，内置繁→简归一（否则 JOOX 繁体歌名匹配归零）。
- **`raceWeighted(tasks, {grace, timeout})`**：并发竞速 + 宽限窗口。无损档先到直接用；
  低档先到则等一个宽限期（`graceMs`），给无损留机会；硬超时（`timeout`）后取已到的最佳结果。
- **跨源取声**：开启 `crossMatch` 后，对声明 `lossless` 能力的最优音源做 `crossMatch` 匹配，
  用同源曲目拿更高码率。

## 播放内核

- `Player` 是事件驱动状态机，事件：`track / status / time / buffer / mode / volume / speed / sleep / queue / error / download / lyric / cover / ready / quality`。
- 双 `<audio>` 元素（A/B）接力：新 URL 先在备用元素 `load` 到可播，再 swap 并同步 `currentTime`，实现无缝切歌。
- 倍速通过 `audio.playbackRate`；定时关闭用定时器在达到设定时长后 `pause()`。

## 安全边界

- 无自有服务器、无账号体系、无遥测上报。
- 所有跨域请求走第三方公开接口；纯前端不持有任何平台 Cookie。
- 本地数据（设置/收藏/历史）仅存于浏览器 `localStorage`，命名空间隔离（`musichub.v1.*`）。
- 内置静态服务器仅监听本机回环地址，且做了目录穿越防护。

详见 [../SECURITY.md](../SECURITY.md)。
