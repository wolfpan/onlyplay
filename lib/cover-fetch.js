// 封面自动补全:iTunes Search + 网易云(非官方)两路检索,进程内限速队列。
// 原则:宁缺毋滥 —— 检索结果必须对得上曲目元数据才采用,对不上就留白。
// 实测备注(2026-10):iTunes 的 CN 商店在部分网络下恒为空,需按 CN→TW→JP 链式尝试;
// 网易云 search 不再返回 picUrl,图片须经 song/detail 取,且 album/{id} 详情端点已被登录墙挡住。
import fs from 'node:fs';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[\s\-–—_·．.,!！?？'’"“”()（）[\]【】&＆~～]+/g, '');

const hasCJK = (s) => /[\u3400-\u9fff\uf900-\ufaff]/.test(String(s || ''));

const TIMEOUT = 8000;
const CONCURRENCY = 2;
const DELAY = 1500; // 每首之间的间隔,礼貌限速

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, headers = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'ONLY-PLAY/1.0', ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------- iTunes Search API(官方、免密钥) ---------- */
const ITUNES_COUNTRIES = ['CN', 'TW', 'JP'];
const itunesArt = (u) => String(u || '').replace(/\/\d+x\d+bb\.jpg$/, '/600x600bb.jpg');

async function itunesFind(term, song, strict) {
  for (const country of ITUNES_COUNTRIES) {
    const url =
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
      `&media=music&entity=song&limit=5&country=${country}`;
    let d;
    try {
      d = await getJSON(url);
    } catch { continue; } // 单一 storefront 失败不影响后续
    for (const x of d.results || []) {
      const r = {
        kind: 'song',
        artist: x.artistName || '',
        title: x.trackName || '',
        url: itunesArt(x.artworkUrl100 || x.artworkUrl60 || ''),
      };
      if (!acceptable(r, song, strict) || !r.url) continue;
      return r;
    }
  }
  return null;
}

/* ---------- 网易云(非官方接口,失效时自动跳过) ---------- */
const neteasePic = (u) =>
  String(u || '').replace(/^http:/, 'https:').replace(/(\?.*)?$/, '?param=600y600');

async function neteaseFind(term, song, strict) {
  const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(term)}&type=1&limit=5`;
  const d = await getJSON(url, { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' });
  for (const x of d?.result?.songs || []) {
    const r = {
      kind: 'song',
      artist: (x.artists || []).map((a) => a.name).join('/'),
      title: x.name || '',
      id: x.id,
    };
    if (!acceptable(r, song, strict) || !r.id) continue;
    try {
      const pic = await neteaseSongPic(r.id);
      if (pic) return { ...r, url: pic };
    } catch { continue; } // 单首详情失败,试下一个候选
  }
  return null;
}

async function neteaseSongPic(songId) {
  const d = await getJSON(
    `https://music.163.com/api/song/detail/?id=${songId}&ids=[${songId}]`,
    { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' }
  );
  return neteasePic(d?.songs?.[0]?.album?.picUrl || '');
}

/* ---------- 匹配 ---------- */
// strict:用于「仅按标题」的兜底检索,此时必须连艺术家也对上
function acceptable(r, song, strict) {
  const t = norm(song.title);
  if (!t || norm(r.title) !== t) return false;
  const a = norm(song.artist);
  if (a && r.artist) {
    const ra = norm(r.artist);
    if (ra !== a && hasCJK(a) && !hasCJK(r.artist)) {
      // 海外商店常见罗马字艺人名(如 Jay Chou);标题已精确命中,放行
    } else if (ra !== a) {
      return false;
    }
  } else if (a && strict && !r.artist) {
    return false;
  }
  return true;
}

// 检索计划:按置信度从高到低
function queries(song) {
  const q = [];
  if (song.artist && song.title) q.push({ p: 'itunes', term: `${song.artist} ${song.title}` });
  if (song.title) q.push({ p: 'itunes', term: song.title, strict: true });
  if (song.artist && song.title) q.push({ p: 'netease', term: `${song.artist} ${song.title}` });
  if (song.title) q.push({ p: 'netease', term: song.title, strict: true });
  return q;
}

async function downloadImage(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      ...(url.includes('music.126.net') ? { Referer: 'https://music.163.com/' } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/')) throw new Error(`content-type: ${ct}`);
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length < 1024) throw new Error('图片过小');
  if (data.length > 8 * 1024 * 1024) throw new Error('图片过大');
  return { data, ext: ct.includes('png') ? '.png' : '.jpg' };
}

// 单首抓取:按检索计划逐路尝试,命中即落盘;全不中记 coverMiss(手动按钮可重试)
export async function fetchCoverFor(lib, id) {
  const s = lib.get(id);
  if (!s || s.coverFile) return false;
  for (const q of queries(s)) {
    try {
      const found =
        q.p === 'itunes' ? await itunesFind(q.term, s, q.strict) : await neteaseFind(q.term, s, q.strict);
      if (!found?.url) continue;
      s.coverMiss = false;
      lib.setCover(id, await downloadImage(found.url));
      return true;
    } catch {} // 检索或下载失败(网络/接口变更),换下一路
  }
  s.coverMiss = true;
  lib.save();
  return false;
}

export function createCoverQueue(lib) {
  const queue = [];
  const queued = new Set();
  const stat = { running: false, run: 0, done: 0, total: 0, ok: 0, fail: 0, lastRun: null };
  let active = 0;

  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (id == null) return;
      queued.delete(id);
      let ok = false;
      try { ok = await fetchCoverFor(lib, id); } catch {}
      if (ok) stat.ok++; else stat.fail++;
      stat.done++;
      await sleep(DELAY);
    }
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      active++;
      worker().finally(() => { active--; pump(); });
    }
    if (!queue.length && !active && stat.running) {
      stat.running = false;
      stat.lastRun = { ok: stat.ok, fail: stat.fail };
    }
  }

  function push(ids) {
    const wasIdle = !stat.running && !queue.length;
    let added = 0;
    for (const id of ids) {
      const s = lib.get(Number(id));
      if (!s || s.coverFile || queued.has(s.id)) continue;
      queued.add(s.id);
      queue.push(s.id);
      added++;
    }
    if (added) {
      if (wasIdle) {
        stat.running = true;
        stat.run++;
        stat.done = 0; stat.total = 0; stat.ok = 0; stat.fail = 0;
      }
      stat.total += added;
      pump();
    }
    return added;
  }

  return {
    push,
    status: () => ({ ...stat, missing: lib.songs.filter((s) => !s.coverFile).length }),
  };
}
