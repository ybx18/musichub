/* ============================================================
 * sources.config.js —— MusicHub 自定义音源配置（默认空，开箱即「无音源」）
 * ------------------------------------------------------------
 * 本仓库不内置任何音源。所有可用音源都必须在这里（或「设置 → 自定义音源」）
 * 自行提供。本文件已被 index.html 在 sources.js 之后加载。
 *
 * 最简方式：直接在「设置」面板的「自定义音源」里填 URL 模板，无需改代码。
 * 进阶方式：在下面用 Sources.registerProvider({ ... }) 注册完整音源。
 *
 * provider 字段说明：
 *   id      唯一标识（字符串）
 *   label   显示名
 *   tier    Sources.TIER.LOSSLESS(0) / HIGH(1) / PREVIEW(2)
 *   weight  竞速权重（数字，越大越优先）
 *   caps    能力开关 { search, url, lyric, pic, playlist, toplist, lossless }
 *   search  function(keyword, page, limit) -> Promise<track[]>
 *   url     function(track, br) -> Promise<{ url, br, size }>
 *   lyric?  function(track) -> Promise<{ lyric, tlyric }>
 *   pic?    function(track, size) -> string | null
 *   playlist? function(server, id) -> Promise<track[]>
 *   toplist?  function(id) -> Promise<track[]>
 *
 * 更完整的示例见 sources.config.example.js
 * ============================================================ */
(function () {
  if (typeof Sources === 'undefined') {
    console.warn('[sources.config] Sources 尚未加载，请确认 index.html 中 sources.config.js 位于 sources.js 之后');
    return;
  }

  // 默认不注册任何音源（仓库定位：纯前端、零内置源）。
  // 取消下面的注释并填入你自己的接口即可启用一条音源。
  //
  // Sources.registerProvider({
  //   id: 'my-source',
  //   label: '我的音源',
  //   tier: Sources.TIER.HIGH,
  //   weight: 80,
  //   caps: { search: 1, url: 1, lyric: 1 },
  //   search: function (kw, page, limit) {
  //     var u = 'https://your-api.example.com/search?kw=' + encodeURIComponent(kw) + '&p=' + (page || 1);
  //     return fetch(u).then(function (r) { return r.json(); }).then(function (j) {
  //       return (j.list || []).map(function (x) {
  //         return { platform: 'my-source', id: x.id, name: x.name,
  //                  artist: x.artist, album: x.album, duration: x.duration, source: 'my-source' };
  //       });
  //     });
  //   },
  //   url: function (track, br) {
  //     return fetch('https://your-api.example.com/url?id=' + encodeURIComponent(track.id))
  //       .then(function (r) { return r.json(); })
  //       .then(function (j) { return { url: j.url, br: j.br || 0, size: j.size || 0 }; });
  //   },
  //   lyric: function (track) {
  //     return fetch('https://your-api.example.com/lyric?id=' + encodeURIComponent(track.id))
  //       .then(function (r) { return r.json(); })
  //       .then(function (j) { return { lyric: j.lyric || '', tlyric: j.tlyric || '' }; });
  //   }
  // });

})();
