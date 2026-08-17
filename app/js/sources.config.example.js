/* ============================================================
 * sources.config.example.js —— MusicHub 自定义音源「完整示例」
 * ------------------------------------------------------------
 * 这是一份可直接照抄的示例。把它复制为 sources.config.js 并填入你自己的
 * 接口地址即可。所有上游域名都必须由你自行提供，本仓库不内置任何音源。
 *
 * 适配「类 MetingAPI / 类 GDstudio」风格的公共接口时，通常只需几行：
 *   - searchUrl: GET .../search?name={name}&count={n}   -> 返回曲目数组
 *   - urlUrl   : GET .../url?id={id}                     -> 返回 { url, br, size }
 * ============================================================ */
(function () {
  if (typeof Sources === 'undefined') {
    console.warn('[sources.config.example] Sources 尚未加载');
    return;
  }

  /* ---------------------------------------------------------
   * 示例 A：对接一个「类 MetingAPI」风格的 HTTP 接口
   * 把 BASE 换成你自己的服务地址，取消注释即可启用。
   * ------------------------------------------------------- */
  // var BASE = 'https://your-meting-api.example.com';
  // Sources.registerProvider({
  //   id: 'my-meting',
  //   label: '我的 Meting 源',
  //   tier: Sources.TIER.HIGH,
  //   weight: 90,
  //   caps: { search: 1, url: 1, lyric: 1, pic: 1 },
  //   search: function (kw, page, limit) {
  //     var u = BASE + '/?type=search&source=netease&name=' + encodeURIComponent(kw) +
  //             '&count=' + (limit || 30) + '&pages=' + (page || 1);
  //     return fetch(u).then(function (r) { return r.json(); }).then(function (list) {
  //       return (list || []).map(function (x) {
  //         return {
  //           platform: 'my-meting', id: x.id, name: x.name, artist: x.artist,
  //           album: x.album, duration: x.duration || 0, pic: x.pic || '', source: 'my-meting'
  //         };
  //       });
  //     });
  //   },
  //   url: function (track, br) {
  //     var u = BASE + '/?type=url&id=' + encodeURIComponent(track.id) + '&br=' + (br || 999);
  //     return fetch(u).then(function (r) { return r.json(); }).then(function (j) {
  //       return { url: j.url, br: Number(j.br) || 0, size: Number(j.size) || 0 };
  //     });
  //   },
  //   lyric: function (track) {
  //     var u = BASE + '/?type=lyric&id=' + encodeURIComponent(track.id);
  //     return fetch(u).then(function (r) { return r.json(); })
  //       .then(function (j) { return { lyric: j.lyric || '', tlyric: j.tlyric || '' }; });
  //   },
  //   pic: function (track) {
  //     return track.pic || (BASE + '/?type=pic&id=' + encodeURIComponent(track.id));
  //   }
  // });

  /* ---------------------------------------------------------
   * 示例 B：无损优先 + 跨源匹配
   * 声明 caps.lossless = 1 后，开启「跨源取无损」时会优先用它匹配。
   * ------------------------------------------------------- */
  // var LOSSLESS_BASE = 'https://your-lossless-api.example.com';
  // Sources.registerProvider({
  //   id: 'my-lossless',
  //   label: '我的无损源',
  //   tier: Sources.TIER.LOSSLESS,
  //   weight: 100,
  //   caps: { search: 1, url: 1, lyric: 1, lossless: 1 },
  //   search: function (kw) { /* 同上 */ return Promise.resolve([]); },
  //   url: function (track, br) {
  //     return fetch(LOSSLESS_BASE + '/url?id=' + encodeURIComponent(track.id) + '&br=' + (br || 999))
  //       .then(function (r) { return r.json(); })
  //       .then(function (j) { return { url: j.url, br: Number(j.br) || 0, size: Number(j.size) || 0 }; });
  //   },
  //   lyric: function (track) {
  //     return fetch(LOSSLESS_BASE + '/lyric?id=' + encodeURIComponent(track.id))
  //       .then(function (r) { return r.json(); })
  //       .then(function (j) { return { lyric: j.lyric || '', tlyric: j.tlyric || '' }; });
  //   }
  // });

})();
