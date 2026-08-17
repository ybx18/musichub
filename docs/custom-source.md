# 自定义音源指南

本仓库**默认没有任何音源**。本文说明如何接入你自己的音频来源。

## 两条路径

### 路径 A：设置面板模板（无需写代码）

打开应用 → 右上「设置」→「自定义音源」，填入：

| 字段 | 模板占位符 | 示例 |
|---|---|---|
| 搜索地址 | `{keyword}` `{page}` `{limit}` | `https://api.example.com/s?kw={keyword}&p={page}` |
| 播放地址 | `{id}` `{name}` `{artist}` `{br}` | `https://api.example.com/u?id={id}&br={br}` |

填入后，搜索/播放即走你的接口。这是最省事的方式，适合「类 MetingAPI」风格的现成服务。

### 路径 B：注册完整音源（代码）

编辑 `app/js/sources.config.js`（已被 `index.html` 加载），用 `Sources.registerProvider` 注册：

```js
Sources.registerProvider({
  id: 'my-source',
  label: '我的音源',
  tier: Sources.TIER.HIGH,        // 0=无损 1=高码率 2=试听
  weight: 90,                     // 竞速权重
  caps: { search: 1, url: 1, lyric: 1, pic: 1 },
  search: function (kw, page, limit) {
    return fetch('https://api.example.com/s?kw=' + encodeURIComponent(kw))
      .then(r => r.json())
      .then(j => (j.list || []).map(x => ({
        platform: 'my-source', id: x.id, name: x.name,
        artist: x.artist, album: x.album, duration: x.duration || 0,
        pic: x.pic || '', source: 'my-source'
      })));
  },
  url: function (track, br) {
    return fetch('https://api.example.com/u?id=' + encodeURIComponent(track.id) + '&br=' + (br || 999))
      .then(r => r.json())
      .then(j => ({ url: j.url, br: Number(j.br) || 0, size: Number(j.size) || 0 }));
  },
  lyric: function (track) {
    return fetch('https://api.example.com/l?id=' + encodeURIComponent(track.id))
      .then(r => r.json())
      .then(j => ({ lyric: j.lyric || '', tlyric: j.tlyric || '' }));
  },
  pic: function (track) {
    return track.pic || ('https://api.example.com/p?id=' + encodeURIComponent(track.id));
  }
});
```

完整可复制版本见 [`../app/js/sources.config.example.js`](../app/js/sources.config.example.js)。

## track 对象字段

`search` 返回的每条曲目建议包含：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 该音源内的唯一 id（传给 `url`） |
| `name` | ✅ | 歌名 |
| `artist` | ✅ | 歌手 |
| `album` | | 专辑 |
| `duration` | | 时长（秒） |
| `pic` | | 封面 URL |
| `platform` / `source` | | 用于匹配与展示，建议填你的 `id` |

## 无损与跨源

- 若你的音源能提供无损，声明 `caps.lossless = 1` 并开启「设置 → 跨源取无损」。
- 引擎会用 `scoreMatchV2`（含繁简归一）在同源里找同一首歌，拿到更高码率。
- 跨源匹配依赖该音源同时具备 `search` 能力（用于检索同源曲目）。

## 注意事项

- 你的接口需允许跨域（CORS）或被前端直接可达；否则浏览器会拦截。
- 请只接入你有权使用的接口，并遵守所在国家/地区的法律法规（见仓库 [免责声明](../README.md#免责声明)）。
- 私人音源配置文件建议命名为 `sources.config.local.js` 并加入 `.gitignore`，避免误提交。
