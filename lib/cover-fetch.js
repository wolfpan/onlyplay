// 封面自动补全:QQ 音乐 + iTunes + 网易云 三路检索,进程内限速队列。
// 原则:宁缺毋滥 —— 检索结果必须对得上曲目元数据才采用,对不上就留白。
// 实测备注(2026-10):
// - QQ 专有曲库(大量剧集 OST)只应认 QQ 官方专辑图,故 QQ 为默认首选;
//   网易上的同名同歌手条目可能是用户上传的仿冒版,封面会张冠李戴;
// - iTunes 搜索对大陆服务器 IP 一律 403(开发机正常),故多路自适应排序,最近成功者优先;
// - iTunes 的 CN 商店在部分网络下恒为空,需按 CN→TW→JP 链式尝试;
// - 网易云 search/get/web 会被 405 反爬,须用 cloudsearch/pc(POST);其结果直接带 al.picUrl。
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

/* ---------- QQ 音乐(半官方接口,官方专辑图) ---------- */
async function qqFind(term, song, strict) {
  const payload = {
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { search_type: 0, query: term, page_num: 1, num_per_page: 10 },
    },
  };
  const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg?format=json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://y.qq.com/',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  for (const x of d?.req?.data?.body?.song?.list || []) {
    const albumMid = x.album?.mid || x.albummid || '';
    const c = {
      kind: 'song',
      artist: (x.singer || []).map((sg) => sg.name).join('/'),
      title: x.name || x.songname || '',
      // 专辑无图时该 URL 直接 404,不会拿到灰色占位图
      url: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : '',
    };
    if (!acceptable(c, song, strict) || !c.url) continue;
    return c;
  }
  return null;
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

const neteaseHeaders = () => ({
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://music.163.com/',
  'Content-Type': 'application/x-www-form-urlencoded',
});

async function neteaseFind(term, song, strict) {
  // search/get/web 已被 405 反爬,cloudsearch/pc 仍可用且结果自带 al.picUrl
  const r = await fetch('https://music.163.com/api/cloudsearch/pc', {
    method: 'POST',
    headers: neteaseHeaders(),
    body: `s=${encodeURIComponent(term)}&type=1&limit=10`,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const items = (d?.result?.songs || []).map((x) => {
    const al = x.al || x.album || {};
    const artists = x.ar || x.artists || [];
    return {
      kind: 'song',
      artist: artists.map((a) => a.name).join('/'),
      title: x.name || '',
      id: x.id,
      url: neteasePic(al.picUrl || ''),
    };
  });
  // 优先用自带图的结果;都没有时再对命中的候选补一次歌曲详情
  for (const c of items) {
    if (!acceptable(c, song, strict) || !c.url) continue;
    return c;
  }
  for (const c of items) {
    if (!acceptable(c, song, strict) || !c.id) continue;
    try {
      const pic = await neteaseSongPic(c.id);
      if (pic) return { ...c, url: pic };
    } catch { continue; }
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

// 各 provider 的检索词计划:按置信度从高到低
function providerQueries(song) {
  const q = [];
  if (song.artist && song.title) q.push({ term: `${song.artist} ${song.title}`, strict: false });
  if (song.title) q.push({ term: song.title, strict: true });
  return q;
}

// 三路自适应排序:哪路最近命中就先走哪路;QQ 默认首选(官方专辑图、专有曲库唯一正确来源)
let providerOrder = ['qq', 'itunes', 'netease'];
const promoteProvider = (p) => {
  if (providerOrder[0] !== p) providerOrder = [p, ...providerOrder.filter((x) => x !== p)];
};

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

// 单首抓取:按自适应顺序逐路、逐检索词尝试,命中即落盘;全不中记 coverMiss(手动按钮可重试)
export async function fetchCoverFor(lib, id) {
  const s = lib.get(id);
  if (!s || s.coverFile) return false;
  for (const p of providerOrder) {
    for (const q of providerQueries(s)) {
      try {
        const found =
          p === 'qq' ? await qqFind(q.term, s, q.strict)
          : p === 'itunes' ? await itunesFind(q.term, s, q.strict)
          : await neteaseFind(q.term, s, q.strict);
        if (!found?.url) continue;
        s.coverMiss = false;
        lib.setCover(id, await downloadImage(found.url));
        promoteProvider(p);
        return true;
      } catch {} // 检索或下载失败(网络/接口变更),换下一路
    }
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
