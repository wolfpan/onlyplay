/* ONLY PLAY · 前端逻辑 */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /* ---------- 元素 ---------- */
  const audio = $('#audio');
  const themeBtn = $('#themeBtn');
  const lyricsBox = $('#lyrics');
  const lyricsInner = $('#lyrics-inner');
  const songList = $('#song-list');
  const pendingList = $('#pending-list');
  const pendingSection = $('#pending-section');
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const uploadProgress = $('#upload-progress');
  const progress = $('#progress');
  const progressFill = $('#progress-fill');
  const progressDot = $('#progress-dot');
  const tCur = $('#t-cur');
  const tTotal = $('#t-total');
  const playBtn = $('#playBtn');
  const toastEl = $('#toast');
  const viewLib = $('#view-library');
  const albWrap = $('#alb-wrap');
  const modeSongs = $('#mode-songs');
  const modeAlbums = $('#mode-albums');
  const editBtn = $('#editBtn');
  const libToolbar = $('#lib-toolbar');
  const selAll = $('#sel-all');
  const selCount = $('#sel-count');
  const batchDel = $('#batch-del');
  const coverBtn = $('#coverBtn');
  const coverPicker = $('#cover-picker');
  const playlistDrawer = $('#playlist-drawer');
  const plList = $('#pl-list');
  const plCount = $('#pl-count');
  const cpSong = $('#cp-song');
  const cpBody = $('#cp-body');
  const cpUploadBtn = $('#cp-upload-btn');
  const cpFile = $('#cp-file');

  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>';

  /* ---------- 状态 ---------- */
  let songs = [];
  let pending = [];
  let currentId = null;
  let lines = [];
  let curLine = -1;
  let seeking = false;
  let editing = false;
  let queue = null; // 专辑播放队列:null = 全部曲目顺序播放
  let libMode = 'songs'; // 曲库视图:songs | albums
  let openAlbumKey = null; // 专辑页当前打开的专辑名
  let pickerSongId = null; // 封面选择弹窗针对的曲目
  let playlistOpen = false; // 播放列表抽屉
  let currentView = 'player'; // 当前视图,随 op-state 持久化
  let pendingSeek = null; // 启动恢复时待跳转的进度(metadata 就绪后应用)
  const selected = new Set();
  let armTimer;

  /* ---------- 主题 ---------- */
  function setTheme(t, save = true) {
    document.documentElement.dataset.theme = t;
    themeBtn.dataset.mode = t;
    if (save) localStorage.setItem('op-theme', t);
  }
  themeBtn.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  setTheme(
    localStorage.getItem('op-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    false
  );

  /* ---------- 工具 ---------- */
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const x = Math.floor(s % 60);
    return `${m}:${String(x).padStart(2, '0')}`;
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const idxOf = (id) => songs.findIndex((s) => s.id === id);
  const currentSong = () => songs[idxOf(currentId)];

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  /* ---------- 数据 ---------- */
  // 按专辑名分组,保持入藏顺序;无专辑信息的曲目归入「未命名专辑」
  function buildAlbums() {
    const map = new Map();
    for (const s of songs) {
      const name = (s.album || '').trim() || '未命名专辑';
      let a = map.get(name);
      if (!a) { a = { name, artist: '', tracks: [] }; map.set(name, a); }
      a.tracks.push(s);
      if (!a.artist && s.artist) a.artist = s.artist;
    }
    return [...map.values()];
  }

  function albumByKey(name) {
    return buildAlbums().find((a) => a.name === name) || null;
  }

  function enterQueue(album) {
    queue = album.tracks.map((t) => t.id);
    if (!queue.length) return;
    if (playlistOpen) renderPlaylist(); // 队列变了,抽屉若开着必须同步
    // 已在该专辑内则不打断当前曲目,否则从第一首开始
    if (!queue.includes(currentId)) playById(queue[0]);
  }

  function applyData(d) {
    if (d.songs) songs = d.songs;
    if (d.pendingLyrics) pending = d.pendingLyrics;
    if (currentId != null && idxOf(currentId) < 0) clearPlayer();
    if (queue) {
      queue = queue.filter((id) => idxOf(id) >= 0);
      if (!queue.length) queue = null;
    }
    if (openAlbumKey && !albumByKey(openAlbumKey)) openAlbumKey = null;
    if (editing) for (const id of [...selected]) if (idxOf(id) < 0) selected.delete(id);
    renderLibrary();
    renderAlbums();
    if (playlistOpen) renderPlaylist();
    renderPending();
    renderLabel();
    renderNowBar();
    saveState();
  }

  async function refresh() {
    try {
      const r = await fetch('/api/songs');
      applyData(await r.json());
    } catch {
      toast('无法连接服务');
    }
  }

  /* ---------- 视图 ---------- */
  // 持久化界面与播放状态(曲目 id 另存于 op-last),刷新后原样恢复
  function saveState() {
    try {
      localStorage.setItem('op-state', JSON.stringify({
        view: currentView,
        album: openAlbumKey,
        libMode,
        position: currentId != null ? Math.floor(audio.currentTime || 0) : 0,
        playing: currentId != null && !audio.paused,
      }));
    } catch {}
  }

  function show(v) {
    currentView = v;
    $$('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + v));
    $$('.navlink').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    saveState();
  }
  $$('.navlink').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  // 自动播放策略:被拦截时挂一次性手势监听,用户任意点击/按键后续播
  let resumeArmed = false;
  function tryResume() {
    audio.play().catch(() => {
      if (resumeArmed) return;
      resumeArmed = true;
      const go = () => {
        window.removeEventListener('pointerdown', go);
        window.removeEventListener('keydown', go);
        resumeArmed = false;
        if (currentId != null) audio.play().catch(() => {});
      };
      window.addEventListener('pointerdown', go);
      window.addEventListener('keydown', go);
    });
  }

  /* ---------- 播放 ---------- */
  function playById(id) {
    const i = idxOf(id);
    if (i < 0) return;
    currentId = id;
    localStorage.setItem('op-last', String(id));
    const s = songs[i];
    audio.src = `/audio/${s.id}`;
    audio.play().catch(() => {});
    renderLabel();
    renderNowBar();
    renderLibrary();
    if (openAlbumKey) renderAlbums(); // 专辑详情页内的当前播放高亮
    if (playlistOpen) renderPlaylist(); // 播放列表内的当前高亮
    loadLyrics(s.id);
    updateMediaSession();
  }

  // 当前生效的播放顺序:专辑队列,否则全部曲目
  function playOrder() {
    return queue && queue.includes(currentId) ? queue : songs.map((s) => s.id);
  }

  // 上下曲在播放队列内循环:专辑播放时只在专辑内切换
  function step(d) {
    const order = playOrder();
    if (!order.length) return;
    let i = order.indexOf(currentId);
    i = i < 0 ? 0 : (i + d + order.length) % order.length;
    playById(order[i]);
  }

  function togglePlay() {
    if (!songs.length) return;
    if (currentId == null) { playById(songs[0].id); return; }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  function clearPlayer() {
    currentId = null;
    localStorage.removeItem('op-last');
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    lines = [];
    curLine = -1;
    lyricsInner.innerHTML = '';
    tTotal.textContent = '0:00';
    updateProgress();
    renderLabel();
    renderNowBar();
  }

  /* ---------- 展签与播放条 ---------- */
  function renderLabel() {
    const s = currentSong();
    const i = s ? idxOf(currentId) : -1;
    $('#p-no').textContent = s ? pad2(i + 1) : '—';
    $('#p-title').textContent = s ? s.title : '静候入藏';
    $('#p-artist').textContent = s ? (s.artist || '未知艺术家') : '曲库尚无藏品';
    $('#p-meta').innerHTML = s
      ? [
          s.album ? `<span class="linkish" data-alb="${esc(s.album)}" title="查看专辑">${esc(s.album)}</span>` : '',
          s.duration ? fmt(s.duration) : '',
        ].filter(Boolean).join(' · ')
      : '';
    const cover = $('#p-cover');
    if (s && s.hasCover) {
      $('#p-cover-img').src = coverURL(s);
      cover.dataset.mode = 'img';
    } else {
      $('#p-cover-letter').textContent = [...(s ? s.title : '乐')][0] || '乐';
      cover.dataset.mode = 'letter';
    }
    document.title = s ? `ONLY PLAY · ${s.title}` : 'ONLY PLAY · 只有声音的美术馆';
  }

  function renderNowBar() {
    const s = currentSong();
    const i = s ? idxOf(currentId) : -1;
    $('#pb-no').textContent = s ? `No.${pad2(i + 1)}` : '';
    $('#pb-title').textContent = s ? s.title : '静候入藏';
    $('#pb-artist').textContent = s ? (s.artist || '未知艺术家') : '曲库尚无藏品';
  }

  /* ---------- 歌词 ---------- */
  function placeholderHTML(s) {
    return (
      `<div class="line placeholder"><span>${esc(s ? s.title : 'ONLY PLAY')}</span></div>` +
      `<div class="line placeholder sub"><span>${esc(s ? (s.artist || '未知艺术家') : '曲库尚无藏品 · 请先入藏')}</span></div>` +
      (s ? `<div class="line placeholder sub2"><span>本曲暂无歌词</span></div>` : '')
    );
  }

  async function loadLyrics(id) {
    lines = [];
    curLine = -1;
    const s = currentSong();
    if (!id || !s) { lyricsInner.innerHTML = placeholderHTML(null); return; }
    try {
      const r = await fetch(`/api/lyrics/${id}`);
      const d = await r.json();
      if (currentId !== id) return; // 期间已切歌
      lines = d.lines || [];
      lyricsBox.scrollTop = 0;
      if (!lines.length) { lyricsInner.innerHTML = placeholderHTML(s); return; }
      lyricsInner.innerHTML = lines
        .map((l, i) => `<div class="line" data-i="${i}"><span>${esc(l.text) || '·'}</span></div>`)
        .join('');
    } catch {
      lyricsInner.innerHTML = placeholderHTML(s);
    }
  }

  lyricsInner.addEventListener('click', (e) => {
    const el = e.target.closest('.line');
    if (!el || el.dataset.i == null || el.classList.contains('placeholder')) return;
    const l = lines[Number(el.dataset.i)];
    if (l) audio.currentTime = l.time;
  });

  function lineIndexAt(t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function updateLine() {
    if (!lines.length) return;
    const i = lineIndexAt(audio.currentTime + 0.02);
    if (i === curLine) return;
    curLine = i;
    const kids = lyricsInner.children;
    for (const el of kids) el.classList.remove('current');
    const el = kids[i];
    if (el) {
      el.classList.add('current');
      lyricsBox.scrollTo({
        top: el.offsetTop - lyricsBox.clientHeight / 2 + el.offsetHeight / 2,
        behavior: 'smooth',
      });
    }
  }

  /* ---------- 进度 ---------- */
  function updateProgress() {
    const d = audio.duration || 0;
    const c = audio.currentTime || 0;
    const r = d ? c / d : 0;
    const pct = (r * 100).toFixed(3) + '%';
    progressFill.style.width = pct;
    progressDot.style.left = pct;
    tCur.textContent = fmt(c);
  }

  function seekTo(e) {
    if (!audio.duration) return;
    const rect = progress.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    updateProgress();
  }
  progress.addEventListener('pointerdown', (e) => {
    seeking = true;
    progress.classList.add('drag');
    progress.setPointerCapture(e.pointerId);
    seekTo(e);
  });
  progress.addEventListener('pointermove', (e) => { if (seeking) seekTo(e); });
  progress.addEventListener('pointerup', () => { seeking = false; progress.classList.remove('drag'); });
  progress.addEventListener('pointercancel', () => { seeking = false; progress.classList.remove('drag'); });

  /* ---------- 渲染驱动 ----------
     以 timeupdate 为主（后台标签页也会触发），rAF 仅在前台做进度条平滑 */
  let lastPosSave = 0;
  function tick() {
    if (!seeking) updateProgress();
    updateLine();
    const now = Date.now();
    if (now - lastPosSave > 5000) { lastPosSave = now; saveState(); } // 播放进度节流落盘
  }
  audio.addEventListener('timeupdate', tick);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('beforeunload', saveState);
  (function loop() {
    if (!document.hidden && !audio.paused && !seeking) {
      updateProgress();
      updateLine();
    }
    requestAnimationFrame(loop);
  })();

  /* ---------- 播放事件 ---------- */
  audio.addEventListener('loadedmetadata', () => {
    tTotal.textContent = fmt(audio.duration);
    if (pendingSeek != null) {
      // 恢复上次进度;曲目若已换新,避免 Seek 到末尾
      audio.currentTime = Math.min(pendingSeek, Math.max(0, (audio.duration || 0) - 1));
      pendingSeek = null;
    }
    updateProgress();
  });
  audio.addEventListener('play', () => { playBtn.innerHTML = ICON_PAUSE; saveState(); });
  audio.addEventListener('pause', () => { playBtn.innerHTML = ICON_PLAY; saveState(); });
  audio.addEventListener('ended', () => step(1));
  audio.addEventListener('error', () => {
    if (currentId != null) toast('该文件无法播放');
  });

  playBtn.addEventListener('click', togglePlay);
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));

  /* ---------- 播放列表抽屉 ---------- */
  function renderPlaylist() {
    const order = playOrder();
    plCount.textContent = `${order.length} 首${queue && queue.includes(currentId) ? ' · 专辑内循环' : ''}`;
    plList.innerHTML = order
      .map((id, i) => {
        const s = songs.find((x) => x.id === id);
        if (!s) return '';
        const now = id === currentId;
        return `
        <div class="pl-row${now ? ' now' : ''}" data-id="${id}">
          <div class="pl-no">${now ? '<span class="dot"></span>' : ''}No.${pad2(i + 1)}</div>
          <div class="pl-main">
            <div class="pl-title">${esc(s.title)}</div>
            <div class="pl-sub">${esc(s.artist || '未知艺术家')}</div>
          </div>
          <div class="pl-dur">${s.duration ? fmt(s.duration) : '—'}</div>
        </div>`;
      })
      .join('');
    plList.querySelector('.pl-row.now')?.scrollIntoView({ block: 'nearest' });
  }

  function openPlaylist() {
    playlistOpen = true;
    playlistDrawer.hidden = false;
    renderPlaylist();
  }

  function closePlaylist() {
    playlistOpen = false;
    playlistDrawer.hidden = true;
  }

  $('#playlistBtn').addEventListener('click', () => (playlistOpen ? closePlaylist() : openPlaylist()));
  $('#pl-close').addEventListener('click', closePlaylist);
  playlistDrawer.addEventListener('click', (e) => { if (e.target === playlistDrawer) closePlaylist(); });
  plList.addEventListener('click', (e) => {
    const row = e.target.closest('.pl-row');
    if (row) playById(Number(row.dataset.id)); // 抽屉保持展开,便于连续选曲
  });

  /* ---------- 键盘 ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (!coverPicker.hidden) {
      if (e.key === 'Escape') closeCoverPicker();
      return;
    }
    if (playlistOpen && e.key === 'Escape') { closePlaylist(); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Escape') setEditing(false);
    else if (e.key === 'ArrowRight') audio.currentTime = Math.min((audio.currentTime || 0) + 5, audio.duration || 0);
    else if (e.key === 'ArrowLeft') audio.currentTime = Math.max((audio.currentTime || 0) - 5, 0);
  });

  /* ---------- 曲库 ---------- */
  // 封面地址带版本号:换封面后 URL 变化,穿透浏览器缓存(服务端 max-age 7 天)
  const coverURL = (s) => `/api/cover/${s.id}?v=${s.coverV || 0}`;

  const coverHTML = (s, letter) =>
    s?.hasCover ? `<img src="${coverURL(s)}" alt="" loading="lazy">` : `<span class="letter">${esc(letter)}</span>`;

  const songRowHTML = (s, no, { bare = false, selectable = false } = {}) => `
    <div class="row${bare ? ' bare' : ''}${s.id === currentId ? ' now' : ''}${selectable && selected.has(s.id) ? ' sel' : ''}" data-id="${s.id}">
      ${selectable ? '<div class="r-check"><span class="cbox"></span></div>' : ''}
      ${bare ? '' : `<div class="r-cover">${coverHTML(s, [...s.title][0] || '乐')}</div>`}
      <div class="r-no">${s.id === currentId ? '<span class="dot"></span>' : ''}No.${pad2(no)}</div>
      <div class="r-main">
        <div class="r-title">${esc(s.title)}</div>
        <div class="r-sub">${esc(s.artist || '未知艺术家')}</div>
      </div>
      <div class="r-lrc${s.hasLyrics ? '' : ' none'}">${s.hasLyrics ? '有词' : '无词'}</div>
      <div class="r-dur">${s.duration ? fmt(s.duration) : '—'}</div>
    </div>`;

  function renderLibrary() {
    if (!songs.length) {
      if (editing) setEditing(false);
      editBtn.hidden = true;
      songList.innerHTML = '<div class="empty">曲库暂无藏品 · 请前往「入藏」</div>';
      return;
    }
    if (libMode === 'albums') {
      editBtn.hidden = true;
      renderLibByAlbum();
      return;
    }
    editBtn.hidden = editing;
    songList.innerHTML = songs.map((s, i) => songRowHTML(s, i + 1, { selectable: true })).join('');
  }

  // 曲库「专辑列表」:按专辑分组,组头可整张播放
  function renderLibByAlbum() {
    songList.innerHTML = buildAlbums()
      .map((a) => {
        const cov = a.tracks.find((t) => t.hasCover);
        return `
        <div class="alg-group" data-key="${esc(a.name)}">
          <div class="alg-head">
            <div class="alg-cover">${coverHTML(cov, [...a.name][0] || '乐')}</div>
            <div class="alg-info">
              <div class="alg-name">${esc(a.name)}</div>
              <div class="alg-sub">${esc(a.artist || '未知艺术家')} · ${a.tracks.length} 首</div>
            </div>
            <button class="tb-btn alg-play">播 放</button>
          </div>
          ${a.tracks.map((t, ti) => songRowHTML(t, ti + 1, { bare: true })).join('')}
        </div>`;
      })
      .join('');
  }

  function setLibMode(m) {
    if (libMode === m) return;
    libMode = m;
    modeSongs.classList.toggle('on', m === 'songs');
    modeAlbums.classList.toggle('on', m === 'albums');
    if (m === 'albums' && editing) setEditing(false);
    renderLibrary();
    saveState();
  }
  modeSongs.addEventListener('click', () => setLibMode('songs'));
  modeAlbums.addEventListener('click', () => setLibMode('albums'));

  /* 编辑模式:全选 / 多选 / 批量移除(二次确认) */
  function setEditing(on) {
    if (editing === on) return;
    editing = on;
    if (!on) selected.clear();
    disarmBatch();
    viewLib.classList.toggle('editing', on);
    libToolbar.hidden = !on;
    updateSelUI();
    updateCoverBtn(lastCoverSt); // 补封面按钮随编辑模式显隐
    renderLibrary();
  }

  function updateSelUI() {
    disarmBatch();
    selAll.classList.toggle('on', !!songs.length && selected.size === songs.length);
    selAll.classList.toggle('part', selected.size > 0 && selected.size < songs.length);
    selCount.textContent = `已选 ${selected.size} / ${songs.length} 首`;
  }

  function toggleSel(id) {
    if (!selected.delete(id)) selected.add(id);
    updateSelUI();
    renderLibrary();
  }

  function toggleAll() {
    if (selected.size === songs.length) selected.clear();
    else for (const s of songs) selected.add(s.id);
    updateSelUI();
    renderLibrary();
  }

  function disarmBatch() {
    batchDel.classList.remove('arm');
    batchDel.textContent = '移 除';
    clearTimeout(armTimer);
  }

  async function removeSelected() {
    if (!selected.size) { toast('请先选择要移除的曲目'); return; }
    if (!batchDel.classList.contains('arm')) {
      batchDel.classList.add('arm');
      batchDel.textContent = `确认移除 ${selected.size} 首`;
      clearTimeout(armTimer);
      armTimer = setTimeout(disarmBatch, 3200);
      return;
    }
    const ids = [...selected];
    const n = ids.length;
    disarmBatch();
    try {
      const r = await fetch('/api/songs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      applyData(await r.json());
      toast(`已移除 ${n} 首`);
    } catch { toast('移除失败'); }
  }

  editBtn.addEventListener('click', () => { if (songs.length) setEditing(true); });
  $('#edit-done').addEventListener('click', () => setEditing(false));
  selAll.addEventListener('click', toggleAll);
  batchDel.addEventListener('click', removeSelected);

  songList.addEventListener('click', (e) => {
    if (libMode === 'albums') {
      const playBtn = e.target.closest('.alg-play');
      const g = playBtn && playBtn.closest('.alg-group');
      if (g) {
        const a = albumByKey(g.dataset.key);
        if (a) enterQueue(a);
        return;
      }
    }
    const row = e.target.closest('.row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (editing) { toggleSel(id); return; }
    // 入口二:曲库行首的小封面,点击管理封面而非播放
    if (libMode === 'songs' && e.target.closest('.r-cover')) { openCoverPicker(id); return; }
    if (libMode === 'albums') {
      const g = row.closest('.alg-group');
      const a = g && albumByKey(g.dataset.key);
      queue = a ? a.tracks.map((t) => t.id) : null;
    } else {
      queue = null;
    }
    playById(id);
    show('player');
  });

  /* ---------- 专辑 ---------- */
  // 专辑页:网格 → 点击进入专辑详情并从第一首播放;上一首/下一首只在专辑内循环
  function renderAlbums() {
    const albums = buildAlbums();
    if (!albums.length) {
      albWrap.innerHTML = '<div class="empty">曲库暂无藏品 · 请前往「入藏」</div>';
      return;
    }
    const a = openAlbumKey ? albumByKey(openAlbumKey) : null;
    if (!a) {
      openAlbumKey = null;
      albWrap.innerHTML =
        '<div class="lib-head"><h2 class="view-title">专&nbsp;辑</h2>' +
        `<span class="alb-count">${albums.length} 张专辑</span></div>` +
        '<div class="alb-grid">' +
        albums
          .map((x) => {
            const cov = x.tracks.find((t) => t.hasCover);
            return `
            <div class="alb-card" data-key="${esc(x.name)}">
              <div class="alb-cover">${coverHTML(cov, [...x.name][0] || '乐')}</div>
              <div class="alb-name">${esc(x.name)}</div>
              <div class="alb-sub">${esc(x.artist || '未知艺术家')} · ${x.tracks.length} 首</div>
            </div>`;
          })
          .join('') +
        '</div>';
      return;
    }
    const dur = a.tracks.reduce((t, s) => t + (s.duration || 0), 0);
    const cov = a.tracks.find((t) => t.hasCover);
    albWrap.innerHTML =
      '<div class="lib-head"><h2 class="view-title">专&nbsp;辑</h2><button class="tb-btn" id="alb-back">返&nbsp;回</button></div>' +
      `<div class="alb-head">
        <div class="alb-bigcover">${coverHTML(cov, [...a.name][0] || '乐')}</div>
        <div class="alb-headinfo">
          <div class="alb-name">${esc(a.name)}</div>
          <div class="alb-sub">${esc(a.artist || '未知艺术家')} · ${a.tracks.length} 首 · ${fmt(dur)}</div>
          <button class="tb-btn" id="alb-playall">播&nbsp;放&nbsp;专&nbsp;辑</button>
        </div>
      </div>` +
      '<div class="alb-tracks">' +
      a.tracks.map((t, ti) => songRowHTML(t, ti + 1, { bare: true })).join('') +
      '</div>';
  }

  albWrap.addEventListener('click', (e) => {
    if (e.target.closest('#alb-back')) { openAlbumKey = null; renderAlbums(); saveState(); return; }
    if (e.target.closest('#alb-playall')) {
      const a = openAlbumKey && albumByKey(openAlbumKey);
      if (a) enterQueue(a);
      return;
    }
    const card = e.target.closest('.alb-card');
    if (card) {
      const a = albumByKey(card.dataset.key);
      if (!a) return;
      openAlbumKey = a.name;
      renderAlbums();
      saveState();
      enterQueue(a); // 点击专辑即进入专辑播放
      return;
    }
    const row = e.target.closest('.row');
    if (!row || !openAlbumKey) return;
    const a = albumByKey(openAlbumKey);
    if (a && a.tracks.some((t) => t.id === Number(row.dataset.id))) {
      queue = a.tracks.map((t) => t.id);
      playById(Number(row.dataset.id));
    }
  });

  // 展签上的专辑名可点击,跳到专辑页并把上下曲限定在该专辑
  $('#p-meta').addEventListener('click', (e) => {
    const el = e.target.closest('.linkish');
    if (!el) return;
    const a = albumByKey(el.dataset.alb);
    if (!a) return;
    queue = a.tracks.map((t) => t.id);
    if (playlistOpen) renderPlaylist();
    openAlbumKey = a.name;
    renderAlbums();
    show('albums');
  });

  /* ---------- 封面自动补全 ---------- */
  let seenRun = -1;
  let lastCoverSt = null; // 最近一次补全状态,供编辑模式切换时恢复按钮可见性

  function updateCoverBtn(st) {
    if (!st) return;
    lastCoverSt = st;
    if (st.running) {
      coverBtn.hidden = !editing; // 补封面只存在于编辑工具栏
      coverBtn.disabled = true;
      coverBtn.textContent = `补封面 ${st.done}/${st.total}`;
    } else {
      coverBtn.hidden = !editing;
      coverBtn.disabled = !st.missing;
      coverBtn.textContent = '补 封 面';
      // seenRun 只在空闲分支更新:从 -1 起步,页面加载中若撞上正在收尾的旧任务不误报
      if (seenRun >= 0 && seenRun !== st.run && st.lastRun) {
        refresh();
        toast(`封面补全完成:${st.lastRun.ok} 张成功${st.lastRun.fail ? `,${st.lastRun.fail} 张未匹配` : ''}`);
      }
      seenRun = st.run;
    }
  }

  async function pollCover() {
    try {
      const st = await (await fetch('/api/covers/status')).json();
      if (st.running) refresh(); // 补全进行中,顺带刷新列表让新封面逐步出现
      updateCoverBtn(st);
    } catch {}
  }
  setInterval(pollCover, 2500);
  pollCover();

  coverBtn.addEventListener('click', async () => {
    try {
      const st = await (
        await fetch('/api/covers/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).json();
      if (!st.added) { toast(st.running ? '补全任务进行中' : '所有曲目都已有封面'); return; }
      toast(`开始补全 ${st.added} 首封面`);
      updateCoverBtn(st);
    } catch { toast('操作失败'); }
  });

  /* ---------- 封面选择(三源候选 + 自行上传) ---------- */
  const PROVIDER_NAMES = { qq: 'QQ 音乐', itunes: 'iTunes', netease: '网易云' };

  function openCoverPicker(id) {
    const s = songs.find((x) => x.id === id);
    if (!s) return;
    pickerSongId = id;
    cpSong.innerHTML =
      `<span class="cp-song-title">${esc(s.title)}</span>` +
      `<span class="cp-song-sub">${esc(s.artist || '未知艺术家')}${s.album ? ' · ' + esc(s.album) : ''}</span>`;
    cpBody.innerHTML = '<div class="cp-loading">正在搜索候选封面 …</div>';
    coverPicker.hidden = false;
    loadCoverCandidates(id);
  }

  function closeCoverPicker() {
    coverPicker.hidden = true;
    pickerSongId = null;
  }

  async function loadCoverCandidates(id) {
    try {
      const r = await fetch(`/api/covers/search/${id}`);
      const d = await r.json();
      if (pickerSongId !== id) return; // 期间已关闭或换曲
      if (!r.ok) throw new Error(d.error || '搜索失败');
      renderCandidates(id, d.groups || []);
    } catch {
      if (pickerSongId === id) cpBody.innerHTML = '<div class="cp-empty">候选获取失败,请重试或直接上传图片</div>';
    }
  }

  function renderCandidates(id, groups) {
    const cur = songs.find((x) => x.id === id);
    const curHTML = cur?.hasCover
      ? `<div class="cp-group"><div class="cp-src">当前封面</div>` +
        `<div class="cp-strip"><span class="cp-cand cur" title="正在使用"><img src="${coverURL(cur)}" alt=""></span></div></div>`
      : '';
    if (!groups.length) {
      cpBody.innerHTML = curHTML + '<div class="cp-empty">各来源都没有搜到候选,可直接上传图片</div>';
      return;
    }
    cpBody.innerHTML =
      curHTML +
      groups
        .map((g) => {
          const soft = g.items.some((c) => c.matched) ? '' : '<span class="cp-soft">· 未精确匹配</span>';
          return `
        <div class="cp-group">
          <div class="cp-src">${PROVIDER_NAMES[g.provider] || esc(g.provider)}${soft}</div>
          <div class="cp-strip">
            ${g.items
              .map(
                (c) => `
            <button class="cp-cand${c.matched ? '' : ' soft'}" data-url="${esc(c.url)}"
              title="${esc([c.artist, c.title].filter(Boolean).join(' - '))}">
              <img src="${esc(c.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">
            </button>`
              )
              .join('')}
          </div>
        </div>`;
        })
        .join('');
  }

  async function applyCoverByUrl(id, url) {
    try {
      const r = await fetch(`/api/songs/${id}/cover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const d = await r.json();
      if (!r.ok) { toast(d.error || '封面应用失败'); return; }
      applyData(d);
      closeCoverPicker();
      toast('封面已更新');
    } catch { toast('封面应用失败'); }
  }

  cpBody.addEventListener('click', (e) => {
    const cand = e.target.closest('.cp-cand[data-url]');
    if (cand && pickerSongId != null) applyCoverByUrl(pickerSongId, cand.dataset.url);
  });

  $('#cp-close').addEventListener('click', closeCoverPicker);
  coverPicker.addEventListener('click', (e) => { if (e.target === coverPicker) closeCoverPicker(); });

  cpUploadBtn.addEventListener('click', () => cpFile.click());
  cpFile.addEventListener('change', async () => {
    const file = cpFile.files[0];
    cpFile.value = '';
    const id = pickerSongId;
    if (!file || id == null) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`/api/songs/${id}/cover`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) { toast(d.error || '封面上传失败'); return; }
      applyData(d);
      closeCoverPicker();
      toast('封面已更新');
    } catch { toast('封面上传失败'); }
  });

  // 入口一:展厅展签大封面
  $('#p-cover').addEventListener('click', () => {
    if (currentId != null) openCoverPicker(currentId);
  });

  /* ---------- 待配对歌词 ---------- */
  function renderPending() {
    pendingSection.hidden = !pending.length;
    if (!pending.length) return;
    pendingList.innerHTML = pending
      .map(
        (p) => `
        <div class="pd-row" data-id="${p.id}">
          <span class="pd-name">${esc(p.originalName)}</span>
          <select class="pd-select">
            <option value="">选择曲目…</option>
            ${songs.map((s, i) => `<option value="${s.id}">No.${pad2(i + 1)} ${esc(s.title)} — ${esc(s.artist || '未知艺术家')}</option>`).join('')}
          </select>
          <button class="pd-pair">配对</button>
          <button class="pd-del">丢弃</button>
        </div>`
      )
      .join('');
  }

  pendingList.addEventListener('click', async (e) => {
    const row = e.target.closest('.pd-row');
    if (!row) return;
    const lrcId = Number(row.dataset.id);
    if (e.target.classList.contains('pd-del')) {
      try {
        const r = await fetch('/api/lyrics/' + lrcId, { method: 'DELETE' });
        const d = await r.json();
        pending = d.pendingLyrics || [];
        renderPending();
      } catch { toast('操作失败'); }
      return;
    }
    if (e.target.classList.contains('pd-pair')) {
      const songId = Number($('.pd-select', row).value);
      if (!songId) { toast('请先选择要配对的曲目'); return; }
      try {
        const r = await fetch(`/api/songs/${songId}/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lrcId }),
        });
        const d = await r.json();
        if (!r.ok) { toast(d.error || '配对失败'); return; }
        applyData(d);
        toast('已配对');
        if (songId === currentId) loadLyrics(currentId);
      } catch { toast('配对失败'); }
    }
  });

  /* ---------- 上传 ---------- */
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('over'); })
  );
  dropzone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

  function renderUploadResults(results) {
    uploadProgress.innerHTML = results
      .map((r) => {
        if (!r.ok) return `<div class="up-row err">${esc(r.file)} — 失败：${esc(r.error)}</div>`;
        if (r.kind === 'mp3')
          return `<div class="up-row ok">${esc(r.file)} — 已入藏「${esc(r.title || r.file)}」${r.paired ? '，歌词已自动配对' : ''}</div>`;
        return `<div class="up-row ok">${esc(r.file)} — ${r.paired != null ? '已自动配对' : '未找到同名曲目，待手动配对'}</div>`;
      })
      .join('');
  }

  function handleFiles(fileList) {
    const files = [...fileList].filter((f) => /\.(mp3|lrc)$/i.test(f.name));
    if (!files.length) { toast('请选择 MP3 或 LRC 文件'); return; }
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';
    uploadProgress.innerHTML = '<div class="up-row">正在入藏 …</div>';
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      uploadProgress.innerHTML =
        `<div class="up-row">正在入藏 … ${p}%<div class="up-bar"><i style="width:${p}%"></i></div></div>`;
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const d = xhr.response;
        renderUploadResults(d.results || []);
        applyData(d);
        const touched = (d.results || []).some((r) => r.songId === currentId);
        if (touched) loadLyrics(currentId);
      } else {
        uploadProgress.innerHTML = `<div class="up-row err">${esc(xhr.response?.error || '上传失败，请重试')}</div>`;
      }
    };
    xhr.onerror = () => { uploadProgress.innerHTML = '<div class="up-row err">网络中断，上传失败</div>'; };
    xhr.send(fd);
  }

  /* ---------- 系统媒体控制 ---------- */
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const s = currentSong();
    if (!s) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.title,
        artist: s.artist || '未知艺术家',
        album: s.album || 'ONLY PLAY',
        artwork: s.hasCover ? [{ src: coverURL(s), sizes: '512x512' }] : [],
      });
    } catch {}
  }
  if ('mediaSession' in navigator) {
    const h = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
    h('play', () => audio.play());
    h('pause', () => audio.pause());
    h('previoustrack', () => step(-1));
    h('nexttrack', () => step(1));
  }

  /* ---------- 启动:恢复上次界面与播放状态 ----------
     曲目 id 在 op-last,界面/进度/播放中标记在 op-state;
     首次使用(无记录)进入「专辑」页。 */
  (async function init() {
    // 先读状态再拉数据:applyData 会触发 saveState,顺序反了会把默认视图写进存储
    let st = null;
    try { st = JSON.parse(localStorage.getItem('op-state') || 'null'); } catch {}
    const first = !st;
    await refresh();
    const last = Number(localStorage.getItem('op-last')) || null;
    const s = songs.find((x) => x.id === last);
    if (s) {
      currentId = s.id;
      audio.src = `/audio/${s.id}`;
      if (st && st.position > 0) pendingSeek = st.position;
      loadLyrics(s.id);
      if (st && st.playing) tryResume();
    } else {
      loadLyrics(null);
    }
    if (!songs.length) { show('upload'); return; }
    renderLabel();
    renderNowBar();
    if (st && st.libMode === 'albums') setLibMode('albums');
    if (st && st.album) { openAlbumKey = st.album; renderAlbums(); }
    show(first ? 'albums' : (st.view || 'player'));
  })();
})();
