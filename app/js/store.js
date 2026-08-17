/* =============================================================
 * store.js — 本地持久化（localStorage）
 * 收藏、最近播放、设置、搜索历史。没有账号，没有服务器。
 * ============================================================= */
(function (global) {
  'use strict';

  var NS = 'musichub.v1.';
  var MAX_RECENT = 200;
  var MAX_HISTORY = 12;

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(NS + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  var defaults = {
    quality: 999,
    volume: 0.8,
    repeat: 'off',        // off | all | one
    shuffle: false,
    crossMatch: true,
    customSearchUrl: '',
    customUrlUrl: '',
    lastPlatform: 'all'
  };

  var Store = {
    /* ---- 设置 ---- */
    settings: function () {
      var s = read('settings', {});
      var out = {};
      for (var k in defaults) {
        out[k] = Object.prototype.hasOwnProperty.call(s, k) ? s[k] : defaults[k];
      }
      return out;
    },
    saveSettings: function (patch) {
      var s = this.settings();
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
      }
      write('settings', s);
      return s;
    },

    /* ---- 收藏 ---- */
    favorites: function () { return read('favorites', []); },
    isFavorite: function (uid) {
      return this.favorites().some(function (t) { return t.uid === uid; });
    },
    toggleFavorite: function (track) {
      var list = this.favorites();
      var i = -1;
      for (var n = 0; n < list.length; n++) {
        if (list[n].uid === track.uid) { i = n; break; }
      }
      if (i >= 0) { list.splice(i, 1); write('favorites', list); return false; }
      list.unshift(this.slim(track));
      write('favorites', list);
      return true;
    },
    removeFavorite: function (uid) {
      var list = this.favorites().filter(function (t) { return t.uid !== uid; });
      write('favorites', list);
    },

    /* ---- 最近播放 ---- */
    recent: function () { return read('recent', []); },
    pushRecent: function (track) {
      var list = this.recent().filter(function (t) { return t.uid !== track.uid; });
      var item = this.slim(track);
      item.playedAt = Date.now();
      list.unshift(item);
      if (list.length > MAX_RECENT) list.length = MAX_RECENT;
      write('recent', list);
    },
    clearRecent: function () { write('recent', []); },

    /* ---- 搜索历史 ---- */
    history: function () { return read('history', []); },
    pushHistory: function (kw) {
      kw = (kw || '').trim();
      if (!kw) return;
      var list = this.history().filter(function (x) { return x !== kw; });
      list.unshift(kw);
      if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
      write('history', list);
    },
    clearHistory: function () { write('history', []); },

    /* 只留播放必需的字段，避免 raw 把 localStorage 撑爆 */
    slim: function (t) {
      return {
        uid: t.uid, platform: t.platform, id: t.id,
        name: t.name, artist: t.artist, album: t.album,
        duration: t.duration, picId: t.picId,
        lyricId: t.lyricId, urlId: t.urlId
      };
    },

    /* 估算占用，设置页展示用 */
    usage: function () {
      var bytes = 0;
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(NS) === 0) bytes += (localStorage.getItem(k) || '').length * 2;
        }
      } catch (e) {}
      return bytes;
    },

    clearAll: function () {
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(NS) === 0) keys.push(k);
        }
        keys.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
    }
  };

  global.Store = Store;
})(window);
