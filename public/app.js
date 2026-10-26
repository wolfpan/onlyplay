/* ONLY PLAY · 前端逻辑 */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /* ---------- 元素 ---------- */
  const audio = $('#audio');
  const curtain = $('#curtain');
  const enterBtn = $('#enterBtn');
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
  const editBtn = $('#editBtn');
  const libToolbar = $('#lib-toolbar');
  const selAll = $('#sel-all');
  const selCount = $('#sel-count');
  const batchDel = $('#batch-del');
  const coverBtn = $('#coverBtn');

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
  function applyData(d) {
    if (d.songs) songs = d.songs;
    if (d.pendingLyrics) pending = d.pendingLyrics;
    if (currentId != null && idxOf(currentId) < 0) clearPlayer();
    if (editing) for (const id of [...selected]) if (idxOf(id) < 0) selected.delete(id);
    renderLibrary();
    renderPending();
    renderLabel();
    renderNowBar();
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
  function show(v) {
    $$('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + v));
    $$('.navlink').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  }
  $$('.navlink').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  show('player');

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
    loadLyrics(s.id);
    updateMediaSession();
  }

  function step(d) {
    if (!songs.length) return;
    let i = idxOf(currentId);
    i = i < 0 ? 0 : (i + d + songs.length) % songs.length;
    playById(songs[i].id);
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
    $('#p-meta').textContent = s ? [s.album, s.duration ? fmt(s.duration) : ''].filter(Boolean).join(' · ') : '';
    const cover = $('#p-cover');
    if (s && s.hasCover) {
      $('#p-cover-img').src = `/api/cover/${s.id}`;
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
  function tick() {
    if (!seeking) updateProgress();
    updateLine();
  }
  audio.addEventListener('timeupdate', tick);
  document.addEventListener('visibilitychange', tick);
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
    updateProgress();
  });
  audio.addEventListener('play', () => { playBtn.innerHTML = ICON_PAUSE; });
  audio.addEventListener('pause', () => { playBtn.innerHTML = ICON_PLAY; });
  audio.addEventListener('ended', () => step(1));
  audio.addEventListener('error', () => {
    if (currentId != null) toast('该文件无法播放');
  });

  playBtn.addEventListener('click', togglePlay);
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));

  /* ---------- 入口幕布 ---------- */
  enterBtn.addEventListener('click', () => {
    curtain.classList.add('hidden');
    setTimeout(() => curtain.remove(), 1000);
    if (!songs.length) { show('upload'); return; }
    if (currentId == null) { playById(songs[0].id); return; }
    audio.play().catch(() => {});
  });

  /* ---------- 键盘 ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (document.contains(curtain)) {
      if (e.key === 'Enter') enterBtn.click();
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Escape') setEditing(false);
    else if (e.key === 'ArrowRight') audio.currentTime = Math.min((audio.currentTime || 0) + 5, audio.duration || 0);
    else if (e.key === 'ArrowLeft') audio.currentTime = Math.max((audio.currentTime || 0) - 5, 0);
  });

  /* ---------- 曲库 ---------- */
  function renderLibrary() {
    if (!songs.length) {
      if (editing) setEditing(false);
      editBtn.hidden = true;
      coverBtn.hidden = true;
      songList.innerHTML = '<div class="empty">曲库暂无藏品 · 请前往「入藏」</div>';
      return;
    }
    editBtn.hidden = editing;
    coverBtn.hidden = editing;
    songList.innerHTML = songs
      .map((s, i) => {
        const now = s.id === currentId;
        return `
        <div class="row${now ? ' now' : ''}${selected.has(s.id) ? ' sel' : ''}" data-id="${s.id}">
          <div class="r-check"><span class="cbox"></span></div>
          <div class="r-cover">${s.hasCover
            ? `<img src="/api/cover/${s.id}" alt="" loading="lazy">`
            : `<span class="letter">${esc([...s.title][0] || '乐')}</span>`}</div>
          <div class="r-no">${now ? '<span class="dot"></span>' : ''}No.${pad2(i + 1)}</div>
          <div class="r-main">
            <div class="r-title">${esc(s.title)}</div>
            <div class="r-sub">${esc(s.artist || '未知艺术家')}</div>
          </div>
          <div class="r-lrc${s.hasLyrics ? '' : ' none'}">${s.hasLyrics ? '有词' : '无词'}</div>
          <div class="r-dur">${s.duration ? fmt(s.duration) : '—'}</div>
        </div>`;
      })
      .join('');
  }

  /* 编辑模式:全选 / 多选 / 批量移除(二次确认) */
  function setEditing(on) {
    if (editing === on) return;
    editing = on;
    if (!on) selected.clear();
    disarmBatch();
    viewLib.classList.toggle('editing', on);
    libToolbar.hidden = !on;
    updateSelUI();
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
    const row = e.target.closest('.row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (editing) { toggleSel(id); return; }
    playById(id);
    show('player');
  });

  /* ---------- 封面自动补全 ---------- */
  let seenRun = -1;

  function updateCoverBtn(st) {
    if (st.running) {
      coverBtn.hidden = editing;
      coverBtn.disabled = true;
      coverBtn.textContent = `补封面 ${st.done}/${st.total}`;
    } else {
      coverBtn.hidden = !songs.length || editing;
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
        artwork: s.hasCover ? [{ src: `/api/cover/${s.id}`, sizes: '512x512' }] : [],
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

  /* ---------- 启动 ---------- */
  (async function init() {
    await refresh();
    const last = Number(localStorage.getItem('op-last')) || null;
    const s = songs.find((x) => x.id === last) || songs[0];
    if (s) {
      currentId = s.id;
      audio.src = `/audio/${s.id}`;
      loadLyrics(s.id);
    } else {
      loadLyrics(null);
    }
    renderLabel();
    renderNowBar();
  })();
})();
