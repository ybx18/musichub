/* =============================================================
 * player.js  v2 — 播放内核
 * -------------------------------------------------------------
 *  · 双 audio 元素：换源 / 换音质时后台预载，就绪后再交接，
 *    听感上不断音。
 *  · 真实音质上报：播放条显示「无损 FLAC · 经 JOOX」这类信息。
 *  · 倍速、定时关闭、下载、MediaSession、逐行歌词（含翻译）。
 * ============================================================= */
(function (global) {
  'use strict';

  /* ==========================================================
   * 事件总线
   * ========================================================== */
  var handlers = Object.create(null);

  function on(evt, fn) {
    (handlers[evt] || (handlers[evt] = [])).push(fn);
    return function () { off(evt, fn); };
  }
  function off(evt, fn) {
    var a = handlers[evt];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  function emit(evt, payload) {
    var a = handlers[evt];
    if (!a) return;
    for (var i = 0; i < a.length; i++) {
      try { a[i](payload); } catch (e) { console.warn('[player]', evt, e); }
    }
  }

  /* ==========================================================
   * 状态
   * ========================================================== */
  var state = {
    track: null,
    queue: [],
    index: -1,
    playing: false,
    loading: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 0.8,
    muted: false,
    repeat: 'off',       // off | all | one
    shuffle: false,
    speed: 1,
    quality: null,       // { label, kbps, format, lossless, ... }
    via: '',             // 实际出声的音源 id
    viaLabel: '',
    matched: null,       // 跨源匹配到的曲目信息
    lyric: { lines: [], tlines: [], raw: '', traw: '', via: '' },
    lyricIndex: -1,
    cover: '',
    error: '',
    sleep: null          // { mode:'time'|'end', at:ms, remain:s }
  };

  /* ==========================================================
   * 双 audio
   * ========================================================== */
  var A = null, B = null, cur = null, idle = null;
  var shuffleBag = [];
  var loadToken = 0;

  function bindAudio(el) {
    el.preload = 'auto';
    el.addEventListener('timeupdate', function () {
      if (el !== cur) return;
      state.currentTime = el.currentTime || 0;
      if (el.duration && isFinite(el.duration)) state.duration = el.duration;
      updateLyricIndex();
      emit('time', state);
    });
    el.addEventListener('progress', function () {
      if (el !== cur) return;
      try {
        if (el.buffered.length) {
          state.buffered = el.buffered.end(el.buffered.length - 1);
          emit('buffer', state);
        }
      } catch (e) {}
    });
    el.addEventListener('play', function () {
      if (el !== cur) return;
      state.playing = true; emit('status', state);
    });
    el.addEventListener('pause', function () {
      if (el !== cur) return;
      state.playing = false; emit('status', state);
    });
    el.addEventListener('ended', function () {
      if (el !== cur) return;
      handleEnded();
    });
    el.addEventListener('loadedmetadata', function () {
      if (el !== cur) return;
      if (el.duration && isFinite(el.duration)) {
        state.duration = el.duration;
        emit('time', state);
      }
    });
    el.addEventListener('error', function () {
      if (el !== cur) return;
      var code = el.error && el.error.code;
      // 2=网络 3=解码 4=不支持 —— 直链多半过期了，换源重试
      if (code === 2 || code === 3 || code === 4) {
        retryOtherSource();
      }
    });
    el.addEventListener('waiting', function () {
      if (el !== cur) return;
      state.loading = true; emit('status', state);
    });
    el.addEventListener('canplay', function () {
      if (el !== cur) return;
      state.loading = false; emit('status', state);
    });
  }

  function initAudio(a, b) {
    A = a; B = b;
    bindAudio(A); bindAudio(B);
    cur = A; idle = B;
    applyVolume();
  }

  function applyVolume() {
    var v = state.muted ? 0 : state.volume;
    if (A) { A.volume = v; A.playbackRate = state.speed; }
    if (B) { B.volume = v; B.playbackRate = state.speed; }
  }

  function swap() {
    var t = cur; cur = idle; idle = t;
  }

  /**
   * 无缝交接：把新地址塞进闲置元素，就绪后对齐进度再切换。
   * 失败则回退到直接换源。
   */
  function handover(url, atTime, shouldPlay) {
    return new Promise(function (resolve, reject) {
      var el = idle;
      var done = false;
      var timer = setTimeout(function () { fail(new Error('handover timeout')); }, 12000);

      function cleanup() {
        clearTimeout(timer);
        el.removeEventListener('canplay', ready);
        el.removeEventListener('error', fail);
      }
      function fail(e) {
        if (done) return;
        done = true; cleanup(); reject(e);
      }
      function ready() {
        if (done) return;
        done = true; cleanup();
        try { if (atTime > 0.3) el.currentTime = Math.min(atTime, (el.duration || atTime) - 0.2); } catch (e) {}
        el.playbackRate = state.speed;
        el.volume = state.muted ? 0 : state.volume;

        var old = cur;
        swap();
        if (shouldPlay) {
          var p = el.play();
          if (p && p.then) p.catch(function () {});
        }
        // 老元素静音停掉，释放连接
        try {
          old.pause();
          old.removeAttribute('src');
          old.load();
        } catch (e) {}
        resolve();
      }

      el.addEventListener('canplay', ready);
      el.addEventListener('error', fail);
      el.src = url;
      el.load();
    });
  }

  /* ==========================================================
   * LRC 解析
   * ========================================================== */
  var TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  function parseLRC(text) {
    var out = [];
    if (!text) return out;
    var rows = String(text).replace(/\r/g, '').split('\n');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row.trim()) continue;
      TIME_RE.lastIndex = 0;
      var stamps = [], m;
      while ((m = TIME_RE.exec(row)) !== null) {
        var ms = m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) : 0;
        stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + ms / 1000);
      }
      if (!stamps.length) continue;
      var txt = row.replace(TIME_RE, '').trim();
      if (!txt) continue;
      if (/^(作词|作曲|编曲|制作人|出品|录音|混音|监制|吉他|贝斯|鼓|和声|母带|发行|词|曲)\s*[:：]/.test(txt) && stamps[0] < 1) {
        // 制作信息也保留，只是标记一下，UI 可弱化
        for (var s0 = 0; s0 < stamps.length; s0++) out.push({ t: stamps[s0], text: txt, meta: true });
        continue;
      }
      for (var s = 0; s < stamps.length; s++) out.push({ t: stamps[s], text: txt, meta: false });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  /** 把翻译按时间戳贴到主歌词上 */
  function mergeTranslation(lines, tlines) {
    if (!tlines || !tlines.length) return lines;
    var map = Object.create(null);
    for (var i = 0; i < tlines.length; i++) {
      map[tlines[i].t.toFixed(2)] = tlines[i].text;
    }
    for (var j = 0; j < lines.length; j++) {
      var key = lines[j].t.toFixed(2);
      if (map[key]) { lines[j].tr = map[key]; continue; }
      // 时间戳可能有毫秒级偏差，找最近的
      var best = null, bd = 0.35;
      for (var k = 0; k < tlines.length; k++) {
        var d = Math.abs(tlines[k].t - lines[j].t);
        if (d < bd) { bd = d; best = tlines[k]; }
      }
      if (best) lines[j].tr = best.text;
    }
    return lines;
  }

  function updateLyricIndex() {
    var lines = state.lyric.lines;
    if (!lines.length) {
      if (state.lyricIndex !== -1) { state.lyricIndex = -1; emit('lyricIndex', state); }
      return;
    }
    var t = state.currentTime + 0.25;   // 稍微提前，观感更跟手
    var lo = 0, hi = lines.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx !== state.lyricIndex) {
      state.lyricIndex = idx;
      emit('lyricIndex', state);
    }
  }

  /* ==========================================================
   * 加载曲目
   * ========================================================== */

  function load(trackObj, autoplay) {
    if (!trackObj) return Promise.resolve();
    var token = ++loadToken;

    state.track = trackObj;
    state.currentTime = 0;
    state.duration = trackObj.duration || 0;
    state.buffered = 0;
    state.quality = null;
    state.via = ''; state.viaLabel = ''; state.matched = null;
    state.lyric = { lines: [], tlines: [], raw: '', traw: '', via: '' };
    state.lyricIndex = -1;
    state.error = '';
    state.loading = true;
    state.cover = '';
    emit('track', state);
    emit('status', state);

    /* 封面先给出来，别让界面空着 */
    try {
      var pic = Sources.picUrl(trackObj, 500);
      if (pic) { state.cover = pic; emit('cover', state); }
    } catch (e) {}

    /* 歌词与直链并行 */
    Sources.lyricCross(trackObj).then(function (r) {
      if (token !== loadToken) return;
      var lines = parseLRC(r.lyric);
      var tlines = parseLRC(r.tlyric);
      state.lyric = {
        lines: mergeTranslation(lines, tlines),
        tlines: tlines,
        raw: r.lyric || '',
        traw: r.tlyric || '',
        via: r.via || ''
      };
      state.lyricIndex = -1;
      updateLyricIndex();
      emit('lyric', state);
    }).catch(function () {});

    return Sources.resolveUrl(trackObj).then(function (r) {
      if (token !== loadToken) return;

      state.quality = r.quality;
      state.via = r.via;
      state.viaLabel = r.viaLabel;
      state.matched = r.matched;
      if (r.duration && !state.duration) state.duration = r.duration;
      emit('quality', state);

      cur.src = r.url;
      cur.playbackRate = state.speed;
      cur.volume = state.muted ? 0 : state.volume;
      cur.load();

      if (autoplay !== false) {
        var p = cur.play();
        if (p && p.then) {
          p.catch(function (err) {
            // 浏览器自动播放策略拦截，等用户点一下
            if (err && err.name === 'NotAllowedError') {
              state.playing = false;
              state.error = '浏览器拦截了自动播放，点一下播放键即可';
              emit('status', state);
              emit('error', state);
            }
          });
        }
      }
      state.loading = false;
      emit('status', state);
      updateMediaSession();
      try { Store.pushRecent(trackObj); } catch (e) {}
    }).catch(function (err) {
      if (token !== loadToken) return;
      state.loading = false;
      state.playing = false;
      state.error = (err && err.message) || '所有音源都拿不到这首歌';
      emit('status', state);
      emit('error', state);
    });
  }

  /** 直链失效时换一条源重试，尽量保住播放进度 */
  var retrying = false;
  function retryOtherSource() {
    if (retrying || !state.track) return;
    retrying = true;
    var at = state.currentTime;
    var wasPlaying = state.playing;
    state.loading = true;
    emit('status', state);

    Sources.resolveUrl(state.track, { force: true }).then(function (r) {
      state.quality = r.quality;
      state.via = r.via;
      state.viaLabel = r.viaLabel;
      state.matched = r.matched;
      emit('quality', state);
      return handover(r.url, at, wasPlaying);
    }).then(function () {
      state.loading = false;
      retrying = false;
      emit('status', state);
    }).catch(function () {
      retrying = false;
      state.loading = false;
      state.error = '这首歌暂时放不出来，已跳过';
      emit('status', state);
      emit('error', state);
      setTimeout(function () { next(true); }, 600);
    });
  }

  /* ==========================================================
   * 队列
   * ========================================================== */

  function setQueue(list, startIndex, autoplay) {
    state.queue = (list || []).slice();
    shuffleBag = [];
    emit('queue', state);
    if (startIndex != null && startIndex >= 0 && startIndex < state.queue.length) {
      return playAt(startIndex, autoplay);
    }
    return Promise.resolve();
  }

  function addToQueue(trackObj, playNext) {
    if (!trackObj) return;
    var exist = -1;
    for (var i = 0; i < state.queue.length; i++) {
      if (state.queue[i].uid === trackObj.uid) { exist = i; break; }
    }
    if (exist >= 0) {
      if (playNext && exist !== state.index) {
        var t = state.queue.splice(exist, 1)[0];
        var to = state.index + 1;
        if (exist < state.index) state.index--;
        state.queue.splice(to, 0, t);
      }
    } else {
      if (playNext && state.index >= 0) state.queue.splice(state.index + 1, 0, trackObj);
      else state.queue.push(trackObj);
    }
    emit('queue', state);
  }

  function removeFromQueue(uid) {
    var i = -1;
    for (var n = 0; n < state.queue.length; n++) {
      if (state.queue[n].uid === uid) { i = n; break; }
    }
    if (i < 0) return;
    state.queue.splice(i, 1);
    if (i < state.index) state.index--;
    else if (i === state.index) {
      state.index = Math.min(state.index, state.queue.length - 1);
      if (state.queue.length) playAt(state.index, state.playing);
      else stop();
    }
    emit('queue', state);
  }

  function clearQueue() {
    state.queue = [];
    state.index = -1;
    shuffleBag = [];
    stop();
    emit('queue', state);
  }

  function playAt(i, autoplay) {
    if (i < 0 || i >= state.queue.length) return Promise.resolve();
    state.index = i;
    emit('queue', state);
    return load(state.queue[i], autoplay !== false);
  }

  function play(trackObj) {
    if (!trackObj) {
      if (state.track) return resume();
      if (state.queue.length) return playAt(0, true);
      return Promise.resolve();
    }
    var at = -1;
    for (var i = 0; i < state.queue.length; i++) {
      if (state.queue[i].uid === trackObj.uid) { at = i; break; }
    }
    if (at < 0) {
      state.queue.push(trackObj);
      at = state.queue.length - 1;
      emit('queue', state);
    }
    return playAt(at, true);
  }

  function nextShuffleIndex() {
    if (!state.queue.length) return -1;
    if (!shuffleBag.length) {
      for (var i = 0; i < state.queue.length; i++) {
        if (i !== state.index) shuffleBag.push(i);
      }
      // Fisher-Yates
      for (var j = shuffleBag.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1));
        var t = shuffleBag[j]; shuffleBag[j] = shuffleBag[k]; shuffleBag[k] = t;
      }
    }
    return shuffleBag.length ? shuffleBag.shift() : state.index;
  }

  function next(auto) {
    if (!state.queue.length) return Promise.resolve();
    if (state.shuffle) return playAt(nextShuffleIndex(), true);

    var i = state.index + 1;
    if (i >= state.queue.length) {
      if (state.repeat === 'all' || !auto) i = 0;
      else { stop(); return Promise.resolve(); }
    }
    return playAt(i, true);
  }

  function prev() {
    if (!state.queue.length) return Promise.resolve();
    // 播了 3 秒以上，先回到本曲开头（和主流播放器一致）
    if (state.currentTime > 3) { seek(0); return Promise.resolve(); }
    if (state.shuffle) return playAt(nextShuffleIndex(), true);
    var i = state.index - 1;
    if (i < 0) i = state.queue.length - 1;
    return playAt(i, true);
  }

  function handleEnded() {
    if (state.sleep && state.sleep.mode === 'end') {
      cancelSleep();
      pause();
      emit('sleepFired', state);
      return;
    }
    if (state.repeat === 'one') { seek(0); cur.play(); return; }
    next(true);
  }

  /* ==========================================================
   * 传输控制
   * ========================================================== */

  function resume() {
    if (!state.track) return Promise.resolve();
    if (!cur.src) return load(state.track, true);
    var p = cur.play();
    return (p && p.then) ? p.catch(function () {}) : Promise.resolve();
  }
  function pause() { try { cur.pause(); } catch (e) {} }
  function toggle() { return state.playing ? (pause(), Promise.resolve()) : resume(); }

  function stop() {
    try { cur.pause(); cur.removeAttribute('src'); cur.load(); } catch (e) {}
    state.playing = false;
    state.currentTime = 0;
    emit('status', state);
  }

  function seek(t) {
    if (!cur || !state.duration) return;
    var v = Math.max(0, Math.min(t, state.duration - 0.15));
    try { cur.currentTime = v; } catch (e) {}
    state.currentTime = v;
    updateLyricIndex();
    emit('time', state);
  }
  function seekRatio(r) { seek(r * state.duration); }
  function seekBy(delta) { seek(state.currentTime + delta); }

  function setVolume(v) {
    state.volume = Math.max(0, Math.min(1, v));
    if (state.volume > 0) state.muted = false;
    applyVolume();
    emit('volume', state);
    try { Store.saveSettings({ volume: state.volume }); } catch (e) {}
  }
  function toggleMute() {
    state.muted = !state.muted;
    applyVolume();
    emit('volume', state);
  }

  function setRepeat(m) {
    state.repeat = m || 'off';
    emit('mode', state);
    try { Store.saveSettings({ repeat: state.repeat }); } catch (e) {}
  }
  function cycleRepeat() {
    setRepeat(state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off');
  }
  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    shuffleBag = [];
    emit('mode', state);
    try { Store.saveSettings({ shuffle: state.shuffle }); } catch (e) {}
  }
  function setShuffle(v) {
    state.shuffle = !!v;
    shuffleBag = [];
    emit('mode', state);
    try { Store.saveSettings({ shuffle: state.shuffle }); } catch (e) {}
  }

  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  function setSpeed(s) {
    state.speed = Math.max(0.25, Math.min(4, Number(s) || 1));
    applyVolume();
    emit('speed', state);
  }
  function cycleSpeed() {
    var i = SPEEDS.indexOf(state.speed);
    setSpeed(SPEEDS[(i + 1) % SPEEDS.length] || 1);
  }

  /* ==========================================================
   * 定时关闭
   * ========================================================== */
  var sleepTimer = null, sleepTick = null;

  function sleepIn(minutes) {
    cancelSleep();
    if (minutes === 'end') {
      state.sleep = { mode: 'end', at: 0, remain: 0 };
      emit('sleep', state);
      return;
    }
    var ms = Number(minutes) * 60000;
    if (!(ms > 0)) return;
    var at = Date.now() + ms;
    state.sleep = { mode: 'time', at: at, remain: Math.round(ms / 1000) };
    sleepTimer = setTimeout(function () {
      fadeOutAndPause(4000);
      cancelSleep();
      emit('sleepFired', state);
    }, ms);
    sleepTick = setInterval(function () {
      if (!state.sleep) return;
      state.sleep.remain = Math.max(0, Math.round((state.sleep.at - Date.now()) / 1000));
      emit('sleep', state);
    }, 1000);
    emit('sleep', state);
  }

  function cancelSleep() {
    if (sleepTimer) clearTimeout(sleepTimer);
    if (sleepTick) clearInterval(sleepTick);
    sleepTimer = sleepTick = null;
    state.sleep = null;
    emit('sleep', state);
  }

  /** 淡出后暂停，别把人吓醒 */
  function fadeOutAndPause(ms) {
    var v0 = state.volume, steps = 24, i = 0;
    var iv = setInterval(function () {
      i++;
      var v = v0 * (1 - i / steps);
      try { cur.volume = Math.max(0, v); } catch (e) {}
      if (i >= steps) {
        clearInterval(iv);
        pause();
        try { cur.volume = state.muted ? 0 : v0; } catch (e) {}
      }
    }, Math.max(30, ms / steps));
  }

  /* ==========================================================
   * 手动换源（设置里点「换一条源」）
   * ========================================================== */
  function switchSource(providerId) {
    if (!state.track) return Promise.reject(new Error('没有正在播放的曲目'));
    var at = state.currentTime, wasPlaying = state.playing;
    state.loading = true; emit('status', state);

    var P = Sources.PROVIDERS[providerId];
    if (!P || !P.caps.url) return Promise.reject(new Error('该音源不支持直链'));

    return Promise.resolve(P.url(state.track, Sources.settings.quality))
      .then(function (r) {
        if (!r || !r.url) throw new Error('该源没有这首歌');
        var q = Sources.inferQuality(r.url, r.size, state.duration, r.br);
        state.quality = q;
        state.via = providerId;
        state.viaLabel = P.label;
        emit('quality', state);
        return handover(r.url, at, wasPlaying);
      })
      .then(function () { state.loading = false; emit('status', state); })
      .catch(function (e) {
        state.loading = false; emit('status', state);
        throw e;
      });
  }

  /** 切音质：同源重取，保住进度 */
  function setQuality(br) {
    Sources.configure({ quality: br });
    try { Store.saveSettings({ quality: br }); } catch (e) {}
    if (!state.track) return Promise.resolve();
    var at = state.currentTime, wasPlaying = state.playing;
    state.loading = true; emit('status', state);
    return Sources.resolveUrl(state.track, { br: br, force: true })
      .then(function (r) {
        state.quality = r.quality;
        state.via = r.via;
        state.viaLabel = r.viaLabel;
        state.matched = r.matched;
        emit('quality', state);
        return handover(r.url, at, wasPlaying);
      })
      .then(function () { state.loading = false; emit('status', state); })
      .catch(function () { state.loading = false; emit('status', state); });
  }

  /* ==========================================================
   * 下载
   * ========================================================== */
  function download(trackObj) {
    var t = trackObj || state.track;
    if (!t) return Promise.reject(new Error('没有可下载的曲目'));
    emit('download', { track: t, phase: 'start', progress: 0 });
    return Sources.download(t, function (p, got, total) {
      emit('download', { track: t, phase: 'progress', progress: p, got: got, total: total });
    }).then(function (r) {
      emit('download', { track: t, phase: 'done', result: r });
      return r;
    }).catch(function (e) {
      emit('download', { track: t, phase: 'error', error: (e && e.message) || '下载失败' });
      throw e;
    });
  }

  /* ==========================================================
   * MediaSession（系统媒体控制 / 耳机线控）
   * ========================================================== */
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var t = state.track;
    if (!t) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.name,
        artist: t.artist,
        album: t.album || '',
        artwork: state.cover ? [
          { src: state.cover, sizes: '300x300', type: 'image/jpeg' },
          { src: state.cover, sizes: '500x500', type: 'image/jpeg' }
        ] : []
      });
      navigator.mediaSession.setActionHandler('play', function () { resume(); });
      navigator.mediaSession.setActionHandler('pause', function () { pause(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { prev(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { next(false); });
      navigator.mediaSession.setActionHandler('seekbackward', function () { seekBy(-10); });
      navigator.mediaSession.setActionHandler('seekforward', function () { seekBy(10); });
      navigator.mediaSession.setActionHandler('seekto', function (d) {
        if (d && d.seekTime != null) seek(d.seekTime);
      });
    } catch (e) {}
  }

  /* ==========================================================
   * 初始化
   * ========================================================== */
  function init(audioA, audioB) {
    initAudio(audioA, audioB);
    try {
      var s = Store.settings();
      state.volume = s.volume != null ? s.volume : 0.8;
      state.repeat = s.repeat || 'off';
      state.shuffle = !!s.shuffle;
      applyVolume();
      Sources.configure({
        quality: s.quality || 999,
        crossMatch: s.crossMatch !== false,
        customSearch: s.customSearchUrl || '',
        customUrl: s.customUrlUrl || ''
      });
    } catch (e) {}
    emit('ready', state);
  }

  /* ==========================================================
   * 导出
   * ========================================================== */
  global.Player = {
    init: init,
    state: state,
    on: on, off: off, emit: emit,

    load: load,
    play: play,
    playAt: playAt,
    resume: resume,
    pause: pause,
    toggle: toggle,
    stop: stop,
    next: next,
    prev: prev,

    seek: seek,
    seekRatio: seekRatio,
    seekBy: seekBy,

    setVolume: setVolume,
    toggleMute: toggleMute,
    setRepeat: setRepeat,
    cycleRepeat: cycleRepeat,
    toggleShuffle: toggleShuffle,
    setShuffle: setShuffle,

    SPEEDS: SPEEDS,
    setSpeed: setSpeed,
    cycleSpeed: cycleSpeed,

    sleepIn: sleepIn,
    cancelSleep: cancelSleep,

    setQueue: setQueue,
    addToQueue: addToQueue,
    removeFromQueue: removeFromQueue,
    clearQueue: clearQueue,

    switchSource: switchSource,
    setQuality: setQuality,
    retry: retryOtherSource,
    download: download,

    parseLRC: parseLRC
  };

})(window);
