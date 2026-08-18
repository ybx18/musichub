/* =============================================================
 * ui.js — 界面层
 * 对齐 player.js 事件/API：status / cover(state) / time(state)
 *   / buffer / volume / mode / speed / sleep / quality / lyric
 *   / track / queue / error。
 * 功能：搜索分平台、沉浸式歌词全屏（切歌+暂停+进度）、
 *       倍速、定时关闭、下载、歌单导入、音源自检。
 * ============================================================= */
(function (global) {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var PLATFORM_NAME = { netease: '网易云音乐', tencent: 'QQ 音乐' };
  var PLATFORM_TINT = { netease: 'var(--tint-netease)', tencent: 'var(--tint-tencent)' };
  var BLANK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

  /* ---------- 应用状态 ---------- */
  var app = {
    view: 'search',
    platform: 'all',
    keyword: '',
    results: { netease: [], tencent: [] },
    status: { netease: 'idle', tencent: 'idle' },
    errors: { netease: '', tencent: '' },
    via: { netease: '', tencent: '' },
    searchToken: 0,
    history: []
  };

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function fmtBytes(b) {
    if (!b) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function icon(id, cls) {
    return '<svg class="' + (cls || '') + '"><use href="#' + id + '"></use></svg>';
  }

  // 把 player 的 quality 对象渲染成可读标签，例如「无损 FLAC · 经 JOOX」
  function qualityText(q, viaLabel) {
    if (!q) return '';
    var t = q.label || '标准';
    if (viaLabel) t += ' · 经 ' + viaLabel;
    return t;
  }

  /* ---------- 轻提示 ---------- */
  var toastHost = $('#toastHost');
  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' toast--error' : '');
    el.textContent = msg;
    toastHost.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 280);
    }, kind === 'error' ? 3400 : 2200);
  }

  /* =============================================================
   * 分段控件
   * ============================================================= */
  var seg = $('#platformSeg');
  var segKnob = $('#segKnob');

  function moveKnob(animate) {
    var active = $('.segmented__item.is-active', seg);
    if (!active) return;
    if (!animate) segKnob.style.transition = 'none';
    segKnob.style.width = active.offsetWidth + 'px';
    segKnob.style.transform = 'translateX(' + (active.offsetLeft - 3) + 'px)';
    if (!animate) {
      void segKnob.offsetWidth;
      segKnob.style.transition = '';
    }
  }

  function setPlatform(p, skipSearch) {
    if (app.platform === p && skipSearch) return;
    app.platform = p;
    $$('.segmented__item', seg).forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.platform === p);
      b.setAttribute('aria-selected', b.dataset.platform === p ? 'true' : 'false');
    });
    moveKnob(true);
    Store.saveSettings({ lastPlatform: p });
    if (skipSearch) return;
    if (app.view !== 'search') { switchView('search'); return; }
    if (app.keyword) runSearch(app.keyword);
    else render();
  }

  seg.addEventListener('click', function (e) {
    var btn = e.target.closest('.segmented__item');
    if (btn) setPlatform(btn.dataset.platform);
  });

  /* =============================================================
   * 搜索
   * ============================================================= */
  var searchField = $('#searchField');
  var searchInput = $('#searchInput');
  var searchClear = $('#searchClear');
  var searchTimer = null;

  searchInput.addEventListener('input', function () {
    searchField.classList.toggle('has-value', !!searchInput.value);
    clearTimeout(searchTimer);
    var v = searchInput.value.trim();
    if (!v) {
      app.keyword = '';
      app.results = { netease: [], tencent: [] };
      app.status = { netease: 'idle', tencent: 'idle' };
      updateSegCounts();
      if (app.view === 'search') render();
      return;
    }
    searchTimer = setTimeout(function () { runSearch(v); }, 360);
  });

  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      var v = searchInput.value.trim();
      if (v) runSearch(v);
    } else if (e.key === 'Escape') {
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
    }
  });

  searchClear.addEventListener('click', function () {
    searchInput.value = '';
    searchField.classList.remove('has-value');
    searchInput.dispatchEvent(new Event('input'));
    searchInput.focus();
  });

  function platformsToQuery() {
    return app.platform === 'all' ? ['netease', 'tencent'] : [app.platform];
  }

  function runSearch(keyword) {
    app.keyword = keyword;
    if (app.view !== 'search') switchView('search', true);
    Store.pushHistory(keyword);
    app.history = Store.history();

    var token = ++app.searchToken;
    var targets = platformsToQuery();

    targets.forEach(function (p) {
      app.status[p] = 'loading';
      app.errors[p] = '';
      app.results[p] = [];
    });
    ['netease', 'tencent'].forEach(function (p) {
      if (targets.indexOf(p) < 0) { app.results[p] = []; app.status[p] = 'idle'; }
    });
    updateSegCounts();
    render();

    targets.forEach(function (p) {
      Sources.search(p, keyword, 1, 30).then(function (list) {
        if (token !== app.searchToken) return;
        app.results[p] = list || [];
        app.status[p] = (list && list.length) ? 'ok' : 'empty';
        updateSegCounts();
        render();
      }).catch(function (err) {
        if (token !== app.searchToken) return;
        app.status[p] = 'error';
        app.errors[p] = err && err.message ? err.message : '搜索失败';
        updateSegCounts();
        render();
      });
    });
  }

  function updateSegCounts() {
    ['netease', 'tencent'].forEach(function (p) {
      var el = $('[data-seg-count="' + p + '"]');
      if (!el) return;
      var n = app.results[p].length;
      el.textContent = (app.status[p] === 'ok' && n) ? String(n) : '';
    });
  }

  /* =============================================================
   * 视图路由
   * ============================================================= */
  var histStack = [], histPos = -1;

  function switchView(view, noPush) {
    app.view = view;
    $$('.nav-item').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === view);
    });
    if (!noPush) {
      histStack = histStack.slice(0, histPos + 1);
      histStack.push(view);
      histPos = histStack.length - 1;
      updateNavButtons();
    }
    content.scrollTop = 0;
    render();
  }

  function updateNavButtons() {
    $('#navBack').disabled = histPos <= 0;
    $('#navForward').disabled = histPos >= histStack.length - 1;
  }

  $('#navBack').addEventListener('click', function () {
    if (histPos > 0) { histPos--; switchView(histStack[histPos], true); updateNavButtons(); }
  });
  $('#navForward').addEventListener('click', function () {
    if (histPos < histStack.length - 1) { histPos++; switchView(histStack[histPos], true); updateNavButtons(); }
  });

  $$('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.dataset.view); });
  });

  /* =============================================================
   * 渲染
   * ============================================================= */
  var content = $('#content');
  var toolbar = $('#toolbar');

  content.addEventListener('scroll', function () {
    toolbar.classList.toggle('is-scrolled', content.scrollTop > 4);
  }, { passive: true });

  function render() {
    switch (app.view) {
      case 'search':    renderSearch(); break;
      case 'favorites': renderList('我喜欢', Store.favorites(), '还没有收藏。在任意歌曲上点心形图标即可加入。'); break;
      case 'recent':    renderList('最近播放', Store.recent(), '这里会按时间倒序记录你听过的歌。'); break;
      case 'queue':     renderQueue(); break;
      case 'settings':  renderSettings(); break;
    }
    updateNavCounts();
  }

  function updateNavCounts() {
    $('[data-count="favorites"]').textContent = Store.favorites().length || '';
    $('[data-count="recent"]').textContent = Store.recent().length || '';
    $('[data-count="queue"]').textContent = Player.state.queue.length || '';
  }

  /* ---------- 搜索页 ---------- */
  function renderSearch() {
    if (!app.keyword) { renderSearchIdle(); return; }

    var html = '';
    var targets = platformsToQuery();

    html += '<div class="page-head"><h1>' + esc(app.keyword) + '</h1>' +
            '<span class="page-head__sub">' +
            (app.platform === 'all' ? '搜索全部平台 · 同曲合并' : '仅搜索 ' + PLATFORM_NAME[app.platform]) +
            '</span></div>';

    if (targets.length > 1) {
      html += renderMergedSection(targets);
    } else {
      targets.forEach(function (p) {
        html += renderPlatformSection(p, false);
      });
    }

    content.innerHTML = html;
    bindTrackRows();
  }

  /* ---------- 多平台合并（双音源） ---------- */
  // 归一楼名/歌手用于比对：去空白、转小写、去常见标点，保留中文与字母数字
  function normKey(s) {
    return (s || '').toString().toLowerCase().replace(/\s+/g, '').replace(/[‘’'""`~!@#$%^&*()_\-+=\[\]{}|\\:;"'<>,.?/]/g, '');
  }

  // 把多个平台的搜索结果合并：歌名+歌手相同者合并为一首，标记 isDual
  function mergeResults(lists) {
    var map = {};
    var order = [];
    lists.forEach(function (list) {
      (list || []).forEach(function (t) {
        if (!t || !t.name) return;
        var key = normKey(t.name) + '\u0001' + normKey(t.artist);
        if (!map[key]) {
          map[key] = { name: t.name, artist: t.artist, album: t.album, duration: t.duration, sources: {}, uids: {} };
          order.push(key);
        }
        var m = map[key];
        m.sources[t.platform] = t;
        m.uids[t.platform] = t.uid;
        // 优先采用 netease 的专辑/时长信息（通常更完整）
        if (t.platform === 'netease') {
          if (t.album) m.album = t.album;
          if (t.duration) m.duration = t.duration;
        }
      });
    });
    return order.map(function (k) {
      var m = map[k];
      var plats = Object.keys(m.sources);
      var prim = m.sources['netease'] || m.sources['tencent'] || m.sources[plats[0]];
      var isDual = plats.length > 1;
      return {
        uid: 'merged:' + k,
        name: m.name,
        artist: m.artist,
        album: m.album,
        duration: m.duration,
        platform: prim.platform,
        id: prim.id,
        picId: prim.picId || '',
        pic: prim.pic || '',
        lyricId: prim.lyricId || prim.id,
        urlId: prim.urlId || prim.id,
        source: prim.source || prim.platform,
        isDual: isDual,
        sources: m.sources,
        uids: m.uids,
        raw: prim
      };
    });
  }

  // 合并视图（仅「全部」模式）：分组按平台状态显示，结果区为合并后的统一列表
  function renderMergedSection(targets) {
    var st = {};
    targets.forEach(function (p) { st[p] = app.status[p]; });
    var anyLoading = targets.some(function (p) { return st[p] === 'loading'; });
    var anyOk = targets.some(function (p) { return st[p] === 'ok' && (app.results[p] || []).length; });
    var anyError = targets.some(function (p) { return st[p] === 'error'; });

    var merged = mergeResults(targets.map(function (p) { return app.results[p] || []; }));
    var total = merged.length;

    var out = '';
    out += '<div class="section-bar">' +
           '<i class="section-bar__tint" style="background:linear-gradient(90deg,#e8413c,#1ba85a)"></i>' +
           '<h2>合并结果</h2>' +
           '<span class="section-bar__meta">' +
           (anyLoading && !anyOk ? '搜索中' :
            anyError && !anyOk ? '部分源不可用' :
            total ? total + ' 首（双音源已合并）' : '没有找到匹配的结果') +
           '</span></div>';

    if (anyLoading && !anyOk) {
      out += '<div class="track-list">';
      for (var i = 0; i < 6; i++) {
        out += '<div class="skeleton-row"><div></div>' +
               '<div style="display:flex;align-items:center;gap:10px"><div class="sk sk--cover"></div>' +
               '<div style="flex:1"><div class="sk" style="width:46%"></div>' +
               '<div class="sk" style="width:26%;margin-top:6px;height:8px"></div></div></div>' +
               '<div class="sk" style="width:60%"></div><div class="sk" style="width:70%"></div>' +
               '<div class="sk" style="width:60%"></div><div></div></div>';
      }
      out += '</div>';
      return out;
    }

    if (!total) {
      out += '<div class="state">' + icon('i-inbox') +
             '<div class="state__title">没有找到匹配的结果</div>' +
             '<div class="state__desc">换个关键词，或者试试只写歌名。' +
             (anyError ? '<br>部分音源暂时不可用，可在「设置」里做连通性检测。' : '') +
             '</div></div>';
      return out;
    }

    out += renderTrackTable(merged, { showAlbum: true, merged: true });
    return out;
  }

  function renderPlatformSection(p, showHeader) {
    var st = app.status[p];
    var list = app.results[p];
    var out = '';

    if (showHeader) {
      out += '<div class="section-bar">' +
             '<i class="section-bar__tint" style="background:' + PLATFORM_TINT[p] + '"></i>' +
             '<h2>' + PLATFORM_NAME[p] + '</h2>' +
             '<span class="section-bar__meta">' +
             (st === 'ok' ? list.length + ' 首' :
              st === 'loading' ? '搜索中' :
              st === 'error' ? '不可用' : '') +
             '</span></div>';
    }

    if (st === 'loading') {
      out += '<div class="track-list">';
      for (var i = 0; i < 6; i++) {
        out += '<div class="skeleton-row">' +
               '<div></div>' +
               '<div style="display:flex;align-items:center;gap:10px">' +
               '<div class="sk sk--cover"></div>' +
               '<div style="flex:1"><div class="sk" style="width:46%"></div>' +
               '<div class="sk" style="width:26%;margin-top:6px;height:8px"></div></div></div>' +
               '<div class="sk" style="width:60%"></div>' +
               '<div class="sk" style="width:70%"></div>' +
               '<div class="sk" style="width:60%"></div><div></div></div>';
      }
      out += '</div>';
      return out;
    }

    if (st === 'error') {
      out += '<div class="state">' + icon('i-warn') +
             '<div class="state__title">' + PLATFORM_NAME[p] + '暂时搜不了</div>' +
             '<div class="state__desc">' + esc(app.errors[p]) +
             '<br>公共音源会不定期波动，可以到「设置」里做一次连通性检测，或者换另一个平台试试。</div></div>';
      return out;
    }

    if (st === 'empty') {
      out += '<div class="state">' + icon('i-inbox') +
             '<div class="state__title">没有找到匹配的结果</div>' +
             '<div class="state__desc">换个关键词，或者试试只写歌名。</div></div>';
      return out;
    }

    if (st === 'ok') out += renderTrackTable(list, { showAlbum: true });
    return out;
  }

  function renderSearchIdle() {
    var hist = Store.history();
    var html = '<div class="page-head"><h1>搜索</h1>' +
               '<span class="page-head__sub">网易云音乐 · QQ 音乐</span></div>';

    /* 推荐歌单（QQ 官方榜单） */
    html += '<div class="section-bar"><i class="section-bar__tint" style="background:linear-gradient(90deg,#4f95ff,#2d7ff9)"></i>' +
            '<h2>推荐歌单</h2>' +
            '<span class="section-bar__meta">热门榜单 · 点击播放</span></div>' +
            '<div class="rec-grid" id="recGrid">' +
            '<div class="skeleton-row"><div></div><div></div><div></div></div>' +
            '</div>';

    if (hist.length) {
      html += '<div class="section-bar"><h2>最近搜索</h2>' +
              '<span class="section-bar__meta"><button class="btn" data-act="clear-history">清除</button></span></div>' +
              '<div style="display:flex;flex-wrap:wrap;gap:7px;padding:4px 0 8px">';
      hist.forEach(function (k) {
        html += '<button class="btn" data-act="use-history" data-kw="' + esc(k) + '">' + esc(k) + '</button>';
      });
      html += '</div>';
    }

    html += '<div class="state">' + icon('i-search') +
            '<div class="state__title">搜点什么来听</div>' +
            '<div class="state__desc">上面的分段控件可以切换搜索范围：' +
            '「全部」会同时搜两个平台并分组显示，也可以单独只搜网易云或 QQ 音乐。</div></div>';

    content.innerHTML = html;
    loadRecGrid();

    $$('[data-act="use-history"]').forEach(function (b) {
      b.addEventListener('click', function () {
        searchInput.value = b.dataset.kw;
        searchField.classList.add('has-value');
        runSearch(b.dataset.kw);
      });
    });
    var ch = $('[data-act="clear-history"]');
    if (ch) ch.addEventListener('click', function () { Store.clearHistory(); render(); });
  }

  /* 首页推荐歌单：加载 QQ 官方热门榜单，卡片显示封面/名称/歌曲数 */
  var REC_BOARDS = [
    { id: 26,  name: 'QQ热歌榜' },
    { id: 4,   name: 'QQ飙升榜' },
    { id: 27,  name: 'QQ新歌榜' },
    { id: 5,   name: 'QQ内地榜' }
  ];
  var recLoading = false;

  function loadRecGrid() {
    if (recLoading) return;
    recLoading = true;
    var grid = $('#recGrid');
    if (!grid) return;
    var done = 0;
    REC_BOARDS.forEach(function (b) {
      Sources.toplist('tencent', b.id).then(function (list) {
        done++;
        if (!list || !list.length) return;
        var t0 = list[0];
        var cover = t0 && Sources.picUrl(t0, 300);
        var card = document.createElement('button');
        card.className = 'rec-card';
        card.innerHTML =
          '<span class="rec-card__cover"' + (cover ? ' style="background-image:url(' + cover.replace(/"/g, '&quot;') + ')"' : '') + '>' +
            '<span class="rec-card__play">' + icon('i-play') + '</span>' +
          '</span>' +
          '<span class="rec-card__name">' + esc(b.name) + '</span>' +
          '<span class="rec-card__meta">' + list.length + ' 首</span>';
        card.addEventListener('click', function () { openToplist(b.id, b.name, list); });
        grid.appendChild(card);
      }).catch(function () { done++; }).then(function () {
        if (done >= REC_BOARDS.length) {
          var sk = grid.querySelector('.skeleton-row');
          if (sk) sk.remove();
          recLoading = false;
        }
      });
    });
  }

  /* 打开榜单：渲染成歌单列表并可直接播放 */
  function openToplist(topid, name, list) {
    if (!list || !list.length) return;
    app.view = 'search';
    app.keyword = name;
    app.platform = 'all';
    content.innerHTML = '<div class="page-head"><h1>' + esc(name) + '</h1>' +
      '<span class="page-head__sub">QQ 官方榜单 · ' + list.length + ' 首</span></div>' +
      renderTrackTable(list, { showAlbum: true });
    bindTrackRows();
    Player.setQueue(list.slice(), 0, true);
    toast('正在播放：' + name);
  }

  /* ---------- 曲目表格 ---------- */
  function renderTrackTable(list, opt) {
    opt = opt || {};
    var cur = Player.state.track;
    var favs = Store.favorites();
    var favSet = {};
    favs.forEach(function (f) { favSet[f.uid] = 1; });

    var out = '<div class="track-list">' +
      '<div class="track-head">' +
      '<div class="track-head__num">#</div>' +
      '<div>标题</div>' +
      '<div class="track-head__artist">歌手</div>' +
      '<div class="track-head__album">专辑</div>' +
      '<div class="track-head__dur">时长</div>' +
      '<div></div>' +
      '</div>';

    list.forEach(function (t, i) {
      var isCur = cur && cur.uid === t.uid;
      var isFav = !!favSet[t.uid];
      out += '<div class="track-row' + (isCur ? ' is-playing' : '') + '" data-uid="' + esc(t.uid) + '" data-index="' + i + '">' +
        '<div class="track-row__num">' +
          '<span class="track-row__num-text">' + (i + 1) + '</span>' +
          '<button class="track-row__play" data-act="play" title="播放">' +
            (isCur && Player.state.playing
              ? '<span class="eq-bars"><i></i><i></i><i></i></span>'
              : '<svg><use href="#i-play"></use></svg>') +
          '</button>' +
        '</div>' +
        '<div class="track-row__main">' +
          '<img class="track-cover" loading="lazy" alt="" src="' + BLANK + '" data-pic="' + esc(t.uid) + '">' +
          '<div class="track-row__text">' +
            '<div class="track-row__name">' +
              (t.isDual
                ? '<span class="badge badge--dual" title="同时支持网易云与 QQ 音乐两个音源">双音源</span>'
                : (t.platform === 'netease'
                  ? '<span class="badge badge--netease">网易云</span>'
                  : (t.platform === 'tencent'
                    ? '<span class="badge badge--tencent">QQ</span>'
                    : '<span class="badge badge--' + esc(t.platform) + '">' + esc(PLATFORM_NAME[t.platform] || t.platform) + '</span>'))) +
              esc(t.name) +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="track-row__artist">' + esc(t.artist) + '</div>' +
        '<div class="track-row__album">' + esc(t.album || '—') + '</div>' +
        '<div class="track-row__dur">' + (t.duration ? fmtTime(t.duration) : '—') + '</div>' +
        '<div class="track-row__actions">' +
          '<button class="row-btn' + (isFav ? ' is-on' : '') + '" data-act="fav" title="' + (isFav ? '取消喜欢' : '喜欢') + '">' +
            '<svg><use href="#i-heart"></use></svg></button>' +
        '</div>' +
      '</div>';
    });

    out += '</div>';
    return out;
  }

  /* 列表行事件（委托） */
  function bindTrackRows() {
    lazyCovers();
  }

  content.addEventListener('click', function (e) {
    var row = e.target.closest('.track-row');
    if (!row) return;
    var uid = row.dataset.uid;
    var track = findTrack(uid);
    if (!track) return;

    var actBtn = e.target.closest('[data-act]');
    var act = actBtn ? actBtn.dataset.act : null;

    if (act === 'fav') {
      var added = Store.toggleFavorite(track);
      actBtn.classList.toggle('is-on', added);
      actBtn.title = added ? '取消喜欢' : '喜欢';
      updateNavCounts();
      if (app.view === 'favorites') render();
      toast(added ? '已加入「我喜欢」' : '已移出「我喜欢」');
      syncNpFav();
      return;
    }

    if (act === 'remove-queue') {
      Player.removeFromQueue(uid);
      render();
      return;
    }

    playFromCurrentView(track);
  });

  content.addEventListener('dblclick', function (e) {
    var row = e.target.closest('.track-row');
    if (!row) return;
    var t = findTrack(row.dataset.uid);
    if (t) playFromCurrentView(t);
  });

  function currentViewList() {
    if (app.view === 'favorites') return Store.favorites();
    if (app.view === 'recent') return Store.recent();
    if (app.view === 'queue') return Player.state.queue;
    if (app.view === 'search' && app.platform === 'all') {
      return mergeResults(platformsToQuery().map(function (p) { return app.results[p] || []; }));
    }
    var out = [];
    platformsToQuery().forEach(function (p) { out = out.concat(app.results[p]); });
    return out;
  }

  function findTrack(uid) {
    var all = currentViewList();
    for (var i = 0; i < all.length; i++) if (all[i].uid === uid) return all[i];
    return null;
  }

  function playFromCurrentView(track) {
    var cur = Player.state.track;
    if (cur && cur.uid === track.uid) { Player.toggle(); return; }
    var list = currentViewList();
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].uid === track.uid) { idx = i; break; }
    Player.setQueue(list, idx, true);
  }

  /* ---------- 通用列表页 ---------- */
  function renderList(title, list, emptyDesc) {
    var html = '<div class="page-head"><h1>' + esc(title) + '</h1>' +
               '<span class="page-head__sub">' + list.length + ' 首</span></div>';
    if (!list.length) {
      html += '<div class="state">' + icon('i-inbox') +
              '<div class="state__title">这里还是空的</div>' +
              '<div class="state__desc">' + esc(emptyDesc) + '</div></div>';
    } else {
      if (app.view === 'recent') {
        html += '<div style="padding:2px 0 8px"><button class="btn" id="clearRecent">清空记录</button></div>';
      }
      html += renderTrackTable(list, { showAlbum: true });
    }
    content.innerHTML = html;
    var cr = $('#clearRecent');
    if (cr) cr.addEventListener('click', function () { Store.clearRecent(); render(); toast('已清空最近播放'); });
    bindTrackRows();
  }

  function renderQueue() {
    var list = Player.state.queue;
    var html = '<div class="page-head"><h1>播放队列</h1>' +
               '<span class="page-head__sub">' + list.length + ' 首</span></div>';
    if (!list.length) {
      html += '<div class="state">' + icon('i-list') +
              '<div class="state__title">队列是空的</div>' +
              '<div class="state__desc">播放任意一首歌，当前列表会自动成为队列。</div></div>';
    } else {
      html += renderTrackTable(list, { showAlbum: true });
    }
    content.innerHTML = html;
    bindTrackRows();
  }

  /* ---------- 封面懒加载 ---------- */
  var picCache = {};
  var picObserver = null;

  function lazyCovers() {
    var imgs = $$('img[data-pic]');
    if (!imgs.length) return;

    if (!picObserver && 'IntersectionObserver' in window) {
      picObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          picObserver.unobserve(en.target);
          loadCover(en.target);
        });
      }, { root: content, rootMargin: '160px' });
    }

    imgs.forEach(function (img) {
      var uid = img.dataset.pic;
      if (picCache[uid]) { img.src = picCache[uid]; return; }
      if (picObserver) picObserver.observe(img);
      else loadCover(img);
    });
  }

  function loadCover(img) {
    var uid = img.dataset.pic;
    if (!uid) return;
    if (picCache[uid]) { img.src = picCache[uid]; return; }
    var t = findTrack(uid);
    if (!t) return;
    var u = Sources.picUrl(t, 100);
    if (!u) return;
    picCache[uid] = u;
    img.src = u;
  }

  /* =============================================================
   * 设置页
   * ============================================================= */
  function renderSettings() {
    var s = Store.settings();
    var html = '<div class="page-head"><h1>设置</h1></div><div class="settings">';

    /* 音质 */
    html += '<div class="card">' +
      '<div class="card__head"><div class="card__title">播放</div>' +
      '<div class="card__desc">会优先无损 / Hi-Res，拿不到时自动向下降级。' +
      'QQ 音乐本身拿不到直链，会用歌名与歌手去其它公开音源找同一首歌，可能匹配到不同版本。</div></div>' +
      '<div class="row"><div><div class="row__label">首选音质</div>' +
      '<div class="row__hint">无损与 Hi-Res 依赖公共音源的可用性，不保证每首都有</div></div>' +
      '<div class="row__control"><select class="field" id="setQuality">' +
        opt(999, 'Hi-Res（最高）', s.quality) +
        opt(740, '无损 FLAC', s.quality) +
        opt(320, '320 Kbps', s.quality) +
        opt(192, '192 Kbps', s.quality) +
        opt(128, '128 Kbps（最省流量）', s.quality) +
      '</select></div></div>' +
      '<div class="row"><div><div class="row__label">跨源匹配兜底</div>' +
      '<div class="row__hint">QQ 音乐无直链时跨源查找同一首歌</div></div>' +
      '<div class="row__control"><div class="switch' + (s.crossMatch ? ' is-on' : '') + '" id="setCrossMatch" role="switch"></div></div></div>' +
    '</div>';

    /* 音源自检 */
    html += '<div class="card">' +
      '<div class="card__head"><div class="card__title">音源状态</div>' +
      '<div class="card__desc">本应用没有自己的服务器，全部依赖公开音源。' +
      '这些站点会波动，搜不到东西时先来这里看一眼。</div></div>' +
      '<div class="probe" id="probeList">' +
        '<div class="probe__item"><span class="probe__dot probe__dot--pending"></span>' +
        '<span class="probe__name">点下面的按钮开始检测</span></div>' +
      '</div>' +
      '<div class="row"><div class="row__control" style="margin-left:0">' +
      '<button class="btn btn--accent" id="runProbe">开始检测</button></div></div>' +
    '</div>';

    /* 自定义音源 */
    html += '<div class="card">' +
      '<div class="card__head"><div class="card__title">自定义音源</div>' +
      '<div class="card__desc">和落雪的自定义源同理：填一个自己的接口地址，会优先于内置音源使用。' +
      '占位符 <code>{keyword}</code>、<code>{id}</code>、<code>{br}</code>、<code>{platform}</code> 会被自动替换。' +
      '接口需要返回 JSON 且带 CORS 响应头。</div></div>' +
      '<div class="row" style="display:block">' +
      '<div class="row__label" style="margin-bottom:6px">搜索接口</div>' +
      '<input class="field" id="setCustomSearch" placeholder="https://example.com/search?kw={keyword}&src={platform}" value="' + esc(s.customSearchUrl) + '"></div>' +
      '<div class="row" style="display:block">' +
      '<div class="row__label" style="margin-bottom:6px">直链接口</div>' +
      '<input class="field" id="setCustomUrl" placeholder="https://example.com/url?id={id}&br={br}" value="' + esc(s.customUrlUrl) + '"></div>' +
      '<div class="row"><div class="row__control" style="margin-left:0;display:flex;gap:8px">' +
      '<button class="btn btn--accent" id="saveCustom">保存</button>' +
      '<button class="btn" id="clearCustom">清除</button></div></div>' +
    '</div>';

    /* 访问密码 */
    html += '<div class="card">' +
      '<div class="card__head"><div class="card__title">访问密码</div>' +
      '<div class="card__desc">默认开启，每次打开页面需输入密码才能进入，防止他人随意使用。' +
      '未设置时默认密码为 musichub，可在此修改；「关闭密码」可完全关闭此功能。</div></div>' +
      '<div class="row" style="display:block">' +
      '<div class="row__label" style="margin-bottom:6px">进入密码</div>' +
      '<input class="field" id="setGatePass" type="password" placeholder="留空 = 恢复默认 musichub" value="' + esc(s.gatePass || '') + '"></div>' +
      '<div class="row"><div class="row__control" style="margin-left:0;display:flex;gap:8px">' +
      '<button class="btn btn--accent" id="saveGatePass">保存密码</button>' +
      '<button class="btn" id="clearGatePass">关闭密码</button></div></div>' +
    '</div>';

    /* 数据 */
    html += '<div class="card">' +
      '<div class="card__head"><div class="card__title">本地数据</div>' +
      '<div class="card__desc">收藏、历史和设置都存在这台设备的浏览器里，' +
      '不上传、不同步。占用 ' + fmtBytes(Store.usage()) + '。</div></div>' +
      '<div class="row"><div class="row__control" style="margin-left:0;display:flex;gap:8px">' +
      '<button class="btn" id="exportData">导出备份</button>' +
      '<button class="btn" id="clearData">清空全部数据</button></div></div>' +
    '</div>';

    html += '<div class="card"><div class="card__head">' +
      '<div class="card__title">关于</div>' +
      '<div class="card__desc">纯前端实现，没有任何后端服务。' +
      '打开的这个页面就是全部程序，双击 HTML 文件即可运行，也可以放到任意静态托管上。' +
      '仅供个人学习与技术研究，请支持正版音乐。</div></div>' +
      '<div class="row"><div class="row__label">开源项目</div>' +
      '<div class="row__control" style="margin-left:auto;text-align:right">' +
      '<a href="https://github.com/ybx18/musichub" target="_blank" rel="noopener" style="color:var(--accent,#2d7ff9);text-decoration:none;font-size:13px;font-weight:600">github.com/ybx18/musichub ↗</a>' +
      '</div></div>' +
      '<div class="row"><div class="row__label">开源协议</div>' +
      '<div class="row__control" style="margin-left:auto;font-size:13px;color:var(--fg-tertiary,#999)">GPL-3.0 License</div></div>' +
      '<div class="row"><div class="row__label">作者</div>' +
      '<div class="row__control" style="margin-left:auto;font-size:13px;font-weight:600">长路与星河</div></div>' +
    '</div>';

    html += '</div>';
    content.innerHTML = html;
    bindSettings();
  }

  function opt(v, label, cur) {
    return '<option value="' + v + '"' + (Number(cur) === v ? ' selected' : '') + '>' + label + '</option>';
  }

  function bindSettings() {
    $('#setQuality').addEventListener('change', function () {
      var q = Number(this.value);
      Store.saveSettings({ quality: q });
      Player.setQuality(q);
      toast('首选音质已设为 ' + (q >= 740 ? '无损' : q >= 320 ? '320K' : q + 'K'));
    });

    var cm = $('#setCrossMatch');
    cm.addEventListener('click', function () {
      var on = !cm.classList.contains('is-on');
      cm.classList.toggle('is-on', on);
      Store.saveSettings({ crossMatch: on });
      Sources.configure({ crossMatch: on });
    });

    $('#runProbe').addEventListener('click', function () {
      var btn = this;
      var box = $('#probeList');
      btn.disabled = true;
      btn.textContent = '检测中…';
      box.innerHTML = '<div class="probe__item"><span class="spinner" style="width:13px;height:13px"></span>' +
                      '<span class="probe__name">正在依次连接各音源…</span></div>';
      Sources.diagnose().then(function (rows) {
        box.innerHTML = rows.map(function (r) {
          return '<div class="probe__item">' +
            '<span class="probe__dot probe__dot--' + (r.ok ? 'ok' : 'bad') + '"></span>' +
            '<span class="probe__name">' + esc(r.label) + '</span>' +
            '<span class="probe__tag">' + esc(r.id) + '</span>' +
            '<span class="probe__detail">' + esc(r.detail || '') + '</span>' +
            '<span class="probe__ms">' + (r.ok ? r.ms + ' ms' : '×') + '</span>' +
            '</div>';
        }).join('');
        btn.disabled = false;
        btn.textContent = '重新检测';
      });
    });

    var gpInput = $('#setGatePass');
    $('#saveGatePass').addEventListener('click', function () {
      var v = gpInput.value.trim();
      if (v && v.length < 4) { toast('密码至少 4 位'); return; }
      Store.saveSettings({ gatePass: v, gateEnabled: true });
      if (v) sessionStorage.setItem('musichub_gate_ok', '1'); // 本次会话已通过，立即生效
      toast(v ? '访问密码已设置' : '访问密码已恢复默认');
    });
    $('#clearGatePass').addEventListener('click', function () {
      gpInput.value = '';
      Store.saveSettings({ gatePass: '', gateEnabled: false });
      toast('访问密码已关闭');
    });

    $('#saveCustom').addEventListener('click', function () {
      var se = $('#setCustomSearch').value.trim();
      var ue = $('#setCustomUrl').value.trim();
      Store.saveSettings({ customSearchUrl: se, customUrlUrl: ue });
      applyCustomSource();
      toast(se || ue ? '自定义音源已启用' : '已清除自定义音源');
    });

    $('#clearCustom').addEventListener('click', function () {
      $('#setCustomSearch').value = '';
      $('#setCustomUrl').value = '';
      Store.saveSettings({ customSearchUrl: '', customUrlUrl: '' });
      applyCustomSource();
      toast('已清除自定义音源');
    });

    $('#exportData').addEventListener('click', function () {
      var data = {
        exportedAt: new Date().toISOString(),
        favorites: Store.favorites(),
        recent: Store.recent(),
        settings: Store.settings()
      };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'music-hub-backup.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('已导出备份');
    });

    $('#clearData').addEventListener('click', function () {
      if (!confirm('会清空收藏、最近播放和全部设置，且无法恢复。确定继续吗？')) return;
      Store.clearAll();
      toast('本地数据已清空');
      applySettings();
      render();
    });
  }

  function applyCustomSource() {
    var s = Store.settings();
    if (s.customSearchUrl || s.customUrlUrl) {
      Sources.configure({
        customSource: { searchUrl: s.customSearchUrl, urlUrl: s.customUrlUrl }
      });
    } else {
      Sources.configure({ customSource: null });
    }
  }

  /* =============================================================
   * 滑块
   * ============================================================= */
  function makeSlider(el, opts) {
    var dragging = false;

    function ratioFromEvent(e) {
      var r = el.getBoundingClientRect();
      if (!r.width) return 0;
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    }

    el.addEventListener('pointerdown', function (e) {
      if (opts.disabled && opts.disabled()) return;
      dragging = true;
      el.classList.add('is-dragging');
      el.setPointerCapture(e.pointerId);
      opts.onDrag(ratioFromEvent(e));
      e.preventDefault();
    });

    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      opts.onDrag(ratioFromEvent(e));
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('is-dragging');
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      opts.onCommit(ratioFromEvent(e));
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    return { isDragging: function () { return dragging; } };
  }

  /* 进度条（底部播放条） */
  var seekBar = $('#seekBar'), seekFill = $('#seekFill'),
      seekKnob = $('#seekKnob'), seekBuffer = $('#seekBuffer');
  var timeNow = $('#timeNow'), timeTotal = $('#timeTotal');

  function paintSeek(ratio) {
    var pct = (ratio * 100).toFixed(3) + '%';
    seekFill.style.width = pct;
    seekKnob.style.left = pct;
  }

  var seekSlider = makeSlider(seekBar, {
    disabled: function () { return !Player.state.track; },
    onDrag: function (r) {
      paintSeek(r);
      var d = Player.state.duration || 0;
      timeNow.textContent = fmtTime(r * d);
    },
    onCommit: function (r) { Player.seekRatio(r); }
  });

  /* 进度条（歌词页） */
  var lyricSeek = $('#lyricSeek'), lyricSeekFill = $('#lyricSeekFill'),
      lyricSeekKnob = $('#lyricSeekKnob'), lyricSeekBuffer = $('#lyricSeekBuffer');
  var lyricTimeNow = $('#lyricTimeNow'), lyricTimeTotal = $('#lyricTimeTotal');

  function paintLyricSeek(ratio) {
    var pct = (ratio * 100).toFixed(3) + '%';
    lyricSeekFill.style.width = pct;
    lyricSeekKnob.style.left = pct;
  }

  var lyricSeekSlider = makeSlider(lyricSeek, {
    disabled: function () { return !Player.state.track; },
    onDrag: function (r) {
      paintLyricSeek(r);
      var d = Player.state.duration || 0;
      lyricTimeNow.textContent = fmtTime(r * d);
    },
    onCommit: function (r) { Player.seekRatio(r); }
  });

  /* 音量条 */
  var volBar = $('#volBar'), volFill = $('#volFill'), volKnob = $('#volKnob');
  function paintVol(v) {
    var pct = (v * 100).toFixed(2) + '%';
    volFill.style.width = pct;
    volKnob.style.left = pct;
  }
  makeSlider(volBar, {
    onDrag: function (r) { Player.setVolume(r); },
    onCommit: function (r) { Player.setVolume(r); Store.saveSettings({ volume: r }); }
  });

  /* =============================================================
   * 播放条按钮
   * ============================================================= */
  var npCover = $('#npCover'), npName = $('#npName'), npArtist = $('#npArtist'), npFav = $('#npFav');
  var btnPlay = $('#btnPlay'), btnPrev = $('#btnPrev'), btnNext = $('#btnNext');
  var btnShuffle = $('#btnShuffle'), btnRepeat = $('#btnRepeat');
  var btnMute = $('#btnMute'), qualityChip = $('#qualityChip'),
      btnLyric = $('#btnLyric'), btnSpeed = $('#btnSpeed'),
      speedLabel = $('#speedLabel'), btnSleep = $('#btnSleep'),
      btnDownload = $('#btnDownload');

  btnPlay.addEventListener('click', function () { Player.toggle(); });
  btnPrev.addEventListener('click', function () { Player.prev(); });
  btnNext.addEventListener('click', function () { Player.next(true); });
  btnMute.addEventListener('click', function () { Player.toggleMute(); });

  btnShuffle.addEventListener('click', function () {
    Player.toggleShuffle();
    Store.saveSettings({ shuffle: Player.state.shuffle });
    toast(Player.state.shuffle ? '随机播放已开启' : '随机播放已关闭');
  });

  btnRepeat.addEventListener('click', function () {
    Player.cycleRepeat();
    Store.saveSettings({ repeat: Player.state.repeat });
    toast({ off: '不循环', all: '列表循环', one: '单曲循环' }[Player.state.repeat]);
  });

  npFav.addEventListener('click', function () {
    var t = Player.state.track;
    if (!t) return;
    var added = Store.toggleFavorite(t);
    syncNpFav();
    updateNavCounts();
    if (app.view === 'favorites') render();
    else refreshRowFav(t.uid, added);
    toast(added ? '已加入「我喜欢」' : '已移出「我喜欢」');
  });

  btnSpeed.addEventListener('click', function () {
    Player.cycleSpeed();
  });

  btnSleep.addEventListener('click', function () {
    openSleepModal();
  });

  btnDownload.addEventListener('click', function () {
    var t = Player.state.track;
    if (!t) { toast('还没有正在播放的歌曲', 'error'); return; }
    toast('开始下载：' + t.name);
    Player.download(t).then(function (r) {
      toast('已下载：' + (r && r.name ? r.name : t.name));
    }).catch(function (e) {
      toast('下载失败：' + ((e && e.message) || '未知错误'), 'error');
    });
  });

  qualityChip.addEventListener('click', function (e) {
    e.stopPropagation();
    openQualityMenu();
  });

  function openQualityMenu() {
    var menu = $('#qualityMenu');
    if (!menu) return;
    var cur = Number(Store.settings().quality);
    Array.prototype.forEach.call(menu.querySelectorAll('.quality-menu__item'), function (b) {
      b.classList.toggle('is-active', Number(b.dataset.q) === cur);
    });
    menu.hidden = !menu.hidden;
  }

  // 点击空白处 / 选中某项后关闭音质菜单
  document.addEventListener('click', function (e) {
    var menu = $('#qualityMenu');
    if (!menu || menu.hidden) return;
    if (e.target.closest('#qualityChip')) return;
    var item = e.target.closest('.quality-menu__item');
    if (item) {
      var q = Number(item.dataset.q);
      Store.saveSettings({ quality: q });
      Player.setQuality(q);
      toast('首选音质：' + (q >= 740 ? '无损' : q + 'K'));
    }
    menu.hidden = true;
  });

  function syncNpFav() {
    var t = Player.state.track;
    var on = t && Store.isFavorite(t.uid);
    npFav.classList.toggle('is-on', !!on);
    npFav.title = on ? '取消喜欢' : '喜欢';
    var lf = $('#lyricFav');
    if (lf) { lf.classList.toggle('is-on', !!on); lf.title = on ? '取消喜欢' : '喜欢'; }
  }

  function refreshRowFav(uid, on) {
    var row = content.querySelector('.track-row[data-uid="' + CSS.escape(uid) + '"]');
    if (!row) return;
    var b = row.querySelector('[data-act="fav"]');
    if (b) b.classList.toggle('is-on', on);
  }

  function syncQualityChip() {
    var q = Player.state.quality;
    var via = Player.state.viaLabel;
    if (q && q.label) {
      qualityChip.textContent = qualityText(q, via);
      qualityChip.classList.toggle('is-lossless', !!q.lossless);
      qualityChip.classList.remove('is-pending');
      qualityChip.title = '实际音质（点击切换首选档位）';
    } else if (Player.state.loading) {
      qualityChip.textContent = '获取中…';
      qualityChip.classList.add('is-pending');
      qualityChip.classList.remove('is-lossless');
      qualityChip.title = '正在解析音源';
    } else {
      qualityChip.textContent = '—';
      qualityChip.classList.remove('is-lossless', 'is-pending');
      qualityChip.title = '首选音质（点击切换）';
    }
    var lq = $('#lyricQuality');
    if (lq) {
      if (q && q.label) {
        lq.textContent = qualityText(q, via);
        lq.classList.toggle('is-lossless', !!q.lossless);
      } else { lq.textContent = '—'; lq.classList.remove('is-lossless'); }
    }
  }

  /* =============================================================
   * 歌单导入弹窗
   * ============================================================= */
  var importModal = $('#importModal');
  var importInput = $('#importInput');
  var importErr = $('#importErr');

  function openImportModal() {
    importErr.textContent = '';
    importInput.value = '';
    importModal.classList.add('is-open');
    importModal.setAttribute('aria-hidden', 'false');
    setTimeout(function () { importInput.focus(); }, 60);
  }
  function closeImportModal() {
    importModal.classList.remove('is-open');
    importModal.setAttribute('aria-hidden', 'true');
  }
  $('#btnImport').addEventListener('click', openImportModal);
  $('#importClose').addEventListener('click', closeImportModal);
  $('#importCancel').addEventListener('click', closeImportModal);
  $('#importScrim').addEventListener('click', closeImportModal);

  $('#importOk').addEventListener('click', function () {
    var raw = importInput.value.trim();
    if (!raw) { importErr.textContent = '请输入歌单链接或 ID'; return; }
    var parsed = Sources.parsePlaylistInput(raw);
    if (!parsed) { importErr.textContent = '无法识别该链接，请粘贴网易云/QQ 歌单链接或纯数字 ID'; return; }
    this.disabled = true;
    this.textContent = '导入中…';
    Sources.playlist(parsed.server, parsed.id).then(function (list) {
      if (!list || !list.length) throw new Error('该歌单没有歌曲或暂不可用');
      Player.setQueue(list, 0, true);
      closeImportModal();
      toast('已导入 ' + list.length + ' 首并开始播放');
    }).catch(function (e) {
      importErr.textContent = (e && e.message) || '导入失败';
    }).then(function () {
      var b = $('#importOk'); b.disabled = false; b.textContent = '导入并播放';
    });
  });

  /* =============================================================
   * 定时关闭弹窗
   * ============================================================= */
  var sleepModal = $('#sleepModal');
  function openSleepModal() {
    // 标记当前激活项
    $$('.menu__item', sleepModal).forEach(function (b) {
      var cur = Player.state.sleep;
      var active = (b.dataset.min === 'off' && !cur) ||
                   (cur && String(b.dataset.min) === (cur.mode === 'end' ? 'end' : String(Math.round((cur.at - Date.now()) / 60000))));
      b.classList.toggle('is-active', !!active);
    });
    sleepModal.classList.add('is-open');
    sleepModal.setAttribute('aria-hidden', 'false');
  }
  function closeSleepModal() {
    sleepModal.classList.remove('is-open');
    sleepModal.setAttribute('aria-hidden', 'true');
  }
  $('#sleepScrim').addEventListener('click', closeSleepModal);

  $('#sleepMenu').addEventListener('click', function (e) {
    var item = e.target.closest('.menu__item');
    if (!item) return;
    var m = item.dataset.min;
    if (m === 'off') {
      Player.cancelSleep();
      toast('已关闭定时');
    } else if (m === 'end') {
      Player.sleepIn('end');
      toast('将在当前歌曲播完后停止');
    } else {
      Player.sleepIn(Number(m));
      toast('将在 ' + m + ' 分钟后停止播放');
    }
    closeSleepModal();
  });

  /* =============================================================
   * 订阅播放器状态
   * ============================================================= */
  Player.on('track', function () {
    var t = Player.state.track;
    if (!t) {
      npName.innerHTML = '<span class="np__empty">未在播放</span>';
      npArtist.textContent = '';
      npCover.src = BLANK;
      btnPlay.disabled = btnPrev.disabled = btnNext.disabled = true;
      return;
    }
    npName.textContent = t.name;
    npArtist.textContent = t.artist + (t.album ? ' — ' + t.album : '');
    npCover.src = BLANK;
    btnPlay.disabled = false;
    btnPrev.disabled = btnNext.disabled = Player.state.queue.length < 1;
    timeTotal.textContent = t.duration ? fmtTime(t.duration) : '0:00';
    lyricTimeTotal.textContent = t.duration ? fmtTime(t.duration) : '0:00';
    syncNpFav();
    syncQualityChip();
    $('#lyricName').textContent = t.name;
    $('#lyricArtist').textContent = t.artist;
    $('#lyricName2').textContent = t.name;
    $('#lyricArtist2').textContent = t.artist;
    markPlayingRow();
  });

  Player.on('cover', function (s) {
    if (s && s.cover) {
      npCover.src = s.cover;
      $('#lyricCover').src = s.cover;
      var bg = $('#lyricBg');
      bg.style.backgroundImage = 'url("' + s.cover + '")';
      bg.classList.add('is-ready');
    }
  });

  Player.on('status', function (s) {
    btnPlay.disabled = s.loading || !s.track;
    if (s.loading) {
      btnPlay.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span>';
    } else {
      btnPlay.innerHTML = s.playing
        ? '<svg><use href="#i-pause"></use></svg>'
        : '<svg><use href="#i-play"></use></svg>';
      btnPlay.title = s.playing ? '暂停' : '播放';
    }
    btnPrev.disabled = btnNext.disabled = !s.queue || s.queue.length < 1;
    // 同步歌词页传输按钮
    $('#lyricPlay').innerHTML = s.loading
      ? '<span class="spinner" style="width:16px;height:16px"></span>'
      : (s.playing ? '<svg><use href="#i-pause"></use></svg>' : '<svg><use href="#i-play"></use></svg>');
    markPlayingRow();
  });

  Player.on('time', function (s) {
    if (seekSlider.isDragging()) return;
    var d = s.duration || 0;
    paintSeek(d ? s.currentTime / d : 0);
    timeNow.textContent = fmtTime(s.currentTime);
    if (!lyricSeekSlider.isDragging()) {
      paintLyricSeek(d ? s.currentTime / d : 0);
      lyricTimeNow.textContent = fmtTime(s.currentTime);
    }
  });

  Player.on('buffer', function (s) {
    var b = (s && s.buffered) || Player.state.buffered || 0;
    var d = (s && s.duration) || Player.state.duration || 0;
    if (d) {
      seekBuffer.style.width = ((b / d) * 100).toFixed(2) + '%';
      lyricSeekBuffer.style.width = ((b / d) * 100).toFixed(2) + '%';
    }
  });

  Player.on('volume', function (s) {
    paintVol(s.muted ? 0 : s.volume);
    btnMute.innerHTML = (s.muted || s.volume === 0)
      ? '<svg><use href="#i-mute"></use></svg>'
      : '<svg><use href="#i-volume"></use></svg>';
  });

  Player.on('mode', function (s) {
    btnShuffle.classList.toggle('is-on', s.shuffle);
    btnRepeat.classList.toggle('is-on', s.repeat !== 'off');
    btnRepeat.innerHTML = s.repeat === 'one'
      ? '<svg><use href="#i-repeat-one"></use></svg>'
      : '<svg><use href="#i-repeat"></use></svg>';
    $('#lyricShuffle').classList.toggle('is-on', s.shuffle);
  });

  Player.on('speed', function (s) {
    var v = s.speed || 1;
    speedLabel.textContent = (Math.abs(v - 1) < 0.001) ? '1.0×' : (v.toFixed(2) + '×');
  });

  Player.on('sleep', function (s) {
    var on = !!s.sleep;
    btnSleep.classList.toggle('is-on', on);
    if (on) {
      btnSleep.title = s.sleep.mode === 'end'
        ? '定时：播完当前'
        : '定时：剩 ' + Math.ceil(s.sleep.remain / 60) + ' 分';
    } else {
      btnSleep.title = '定时关闭';
    }
  });

  Player.on('quality', function () {
    syncQualityChip();
  });

  Player.on('error', function (s) {
    if (s && s.error) toast(s.error, 'error');
  });

  Player.on('queue', function () {
    updateNavCounts();
    if (app.view === 'queue') render();
  });

  Player.on('lyric', function (s) { renderLyric(s.lyric); });

  function markPlayingRow() {
    var cur = Player.state.track;
    $$('.track-row', content).forEach(function (row) {
      var on = cur && row.dataset.uid === cur.uid;
      row.classList.toggle('is-playing', !!on);
      var btn = row.querySelector('.track-row__play');
      if (!btn) return;
      if (on && Player.state.playing) {
        btn.innerHTML = '<span class="eq-bars"><i></i><i></i><i></i></span>';
      } else {
        btn.innerHTML = '<svg><use href="#i-play"></use></svg>';
      }
    });
  }

  /* =============================================================
   * 歌词面板（沉浸式全屏）
   * ============================================================= */
  var lyricSheet = $('#lyricSheet');
  var lyricScroll = $('#lyricScroll');
  var lyricLines = [];
  var lyricIndex = -1;

  function openLyric() {
    lyricSheet.classList.add('is-open');
    lyricSheet.setAttribute('aria-hidden', 'false');
    setTimeout(function () { scrollLyricTo(lyricIndex, false); }, 80);
  }
  function closeLyric() {
    lyricSheet.classList.remove('is-open');
    lyricSheet.setAttribute('aria-hidden', 'true');
  }

  btnLyric.addEventListener('click', function () {
    if (lyricSheet.classList.contains('is-open')) closeLyric();
    else openLyric();
  });
  $('#lyricClose').addEventListener('click', closeLyric);
  npCover.addEventListener('click', function () {
    if (Player.state.track) openLyric();
  });

  // 歌词页自己的传输控制
  $('#lyricPlay').addEventListener('click', function () { Player.toggle(); });
  $('#lyricPrev').addEventListener('click', function () { Player.prev(); });
  $('#lyricNext').addEventListener('click', function () { Player.next(true); });
  $('#lyricShuffle').addEventListener('click', function () { Player.toggleShuffle(); });
  $('#lyricFav').addEventListener('click', function () {
    var t = Player.state.track;
    if (!t) return;
    var added = Store.toggleFavorite(t);
    syncNpFav();
    if (app.view === 'favorites') render();
    toast(added ? '已加入「我喜欢」' : '已移出「我喜欢」');
  });

  function renderLyric(l) {
    lyricLines = (l && l.lines) || [];
    lyricIndex = -1;
    $('#lyricName').textContent = Player.state.track ? Player.state.track.name : '';

    if (!lyricLines.length) {
      lyricScroll.innerHTML = '<div class="state" style="padding:40px 0">' +
        '<div class="state__title">暂无歌词</div>' +
        '<div class="state__desc">这首歌在当前音源没有找到歌词文件。</div></div>';
      return;
    }
    lyricScroll.innerHTML = lyricLines.map(function (line, i) {
      return '<div class="lyric-line" data-i="' + i + '">' + esc(line.text) +
        (line.tr ? '<span class="lyric-line__sub">' + esc(line.tr) + '</span>' : '') +
        '</div>';
    }).join('');
  }

  lyricScroll.addEventListener('click', function (e) {
    var el = e.target.closest('.lyric-line');
    if (!el) return;
    var i = Number(el.dataset.i);
    if (lyricLines[i]) Player.seek(lyricLines[i].t / 1000);
  });

  function scrollLyricTo(i, smooth) {
    if (i < 0) return;
    var el = lyricScroll.querySelector('.lyric-line[data-i="' + i + '"]');
    if (!el) return;
    var target = el.offsetTop - lyricScroll.clientHeight / 2 + el.offsetHeight / 2;
    lyricScroll.scrollTo({ top: target, behavior: smooth === false ? 'auto' : 'smooth' });
  }

  Player.on('time', function (s) {
    if (!lyricLines.length || !lyricSheet.classList.contains('is-open')) return;
    var sec = s.currentTime; // 歌词时间戳 t 单位为秒，统一用秒比较
    var i = -1;
    for (var n = 0; n < lyricLines.length; n++) {
      if (lyricLines[n].t <= sec + 0.22) i = n; else break;
    }
    if (i === lyricIndex) return;
    var prevEl = lyricScroll.querySelector('.lyric-line.is-current');
    if (prevEl) prevEl.classList.remove('is-current');
    lyricIndex = i;
    var el = lyricScroll.querySelector('.lyric-line[data-i="' + i + '"]');
    if (el) { el.classList.add('is-current'); scrollLyricTo(i, true); }
  });

  /* =============================================================
   * 键盘快捷键
   * ============================================================= */
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault(); switchView('search'); searchInput.focus(); searchInput.select(); return;
    }
    if (e.key === 'Escape') {
      if (importModal.classList.contains('is-open')) { closeImportModal(); return; }
      if (sleepModal.classList.contains('is-open')) { closeSleepModal(); return; }
      if (lyricSheet.classList.contains('is-open')) { closeLyric(); return; }
    }
    if (typing) return;

    switch (e.key) {
      case ' ':        e.preventDefault(); Player.toggle(); break;
      case 'ArrowRight': if (e.shiftKey) Player.next(true); else Player.seekBy(5); break;
      case 'ArrowLeft':  if (e.shiftKey) Player.prev(); else Player.seekBy(-5); break;
      case 'ArrowUp':    e.preventDefault(); Player.setVolume(Player.state.volume + 0.05); break;
      case 'ArrowDown':  e.preventDefault(); Player.setVolume(Player.state.volume - 0.05); break;
      case 'm': case 'M': Player.toggleMute(); break;
      case 'l': case 'L': btnLyric.click(); break;
      case 's': case 'S': Player.cycleSpeed(); break;
    }
  });

  /* =============================================================
   * 启动
   * ============================================================= */
  function applySettings() {
    var s = Store.settings();
    Player.setVolume(s.volume);
    Player.setQuality(s.quality);
    Player.setRepeat(s.repeat);
    Player.setShuffle(s.shuffle);
    Sources.configure({ quality: s.quality, crossMatch: s.crossMatch });
    applyCustomSource();
    paintVol(s.volume);
    syncQualityChip();
    return s;
  }

  function boot() {
    Player.init(document.getElementById('audio'), document.getElementById('audioB'));
    var s = applySettings();
    setPlatform(s.lastPlatform || 'all', true);
    moveKnob(false);
    histStack = ['search']; histPos = 0;
    updateNavButtons();
    render();
    searchInput.focus();

    /* 进入密码门：默认开启，密码未设置时用默认 musichub；
       用户清除密码（gateEnabled=false）后彻底关闭 */
    var st = Store.settings();
    var pass = (st.gateEnabled !== false) ? (st.gatePass || 'musichub') : '';
    if (pass && !sessionStorage.getItem('musichub_gate_ok')) {
      var gate = document.getElementById('gate');
      var input = document.getElementById('gateInput');
      var err = document.getElementById('gateErr');
      gate.hidden = false;
      input.focus();
      var tryEnter = function () {
        if (input.value === pass) {
          sessionStorage.setItem('musichub_gate_ok', '1');
          gate.hidden = true;
        } else {
          err.textContent = '密码错误，请重试';
          input.value = '';
          input.focus();
        }
      };
      document.getElementById('gateBtn').addEventListener('click', tryEnter);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') tryEnter();
      });
    }
  }

  window.addEventListener('resize', function () { moveKnob(false); });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { moveKnob(false); });
  }

  boot();
})(window);
