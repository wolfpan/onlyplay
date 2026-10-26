// 封面自动补全:iTunes + 网易云 两路检索,进程内限速队列。
// 原则:宁缺毋滥 —— 检索结果必须对得上曲目元数据才采用,对不上就留白。
// 实测备注(2026-10):
// - QQ 专有曲库(剧集 OST)只有 QQ 有官方专辑图,但 musicu.fcg 桌面搜索接口在大陆服务器上
//   会先返回「缓存污染」数据(不同关键词拿到同一份结果,导致张冠李戴)、随后 403/2001 风控,
//   老端点 client_search_cp 直接 500,故默认不启用;确需时设 COVER_PROVIDERS=qq,itunes,netease,
//   且代码内置熔断:不同关键词拿到同一响应体即停用该源;
// - iTunes 搜索对大陆服务器 IP 一律 403(开发机正常),CN 商店恒空,按 CN→TW→JP 链式尝试;
// - 网易云 search/get/web 会被 405 反爬,须用 cloudsearch/pc(POST);其结果直接带 al.picUrl。
import crypto from 'node:crypto';
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

/* ---------- provider 熔断与缓存污染检测(每次批量运行开始时重置) ---------- */
const guard = { run: -1, disabled: new Set(), fails: new Map(), last: new Map() };
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function noteResponse(p, term, text) {
  if (guard.run < 0) return;
  const last = guard.last.get(p);
  // 同一响应体出现在不同关键词上 = 上游缓存污染,本轮停用,绝不落库
  if (last && last.term !== term && text.length > 256 && last.md5 === md5(text)) {
    guard.disabled.add(p);
    console.warn(`[cover] ${p} 对不同关键词返回了相同响应体,疑似缓存污染,本轮停用`);
    return;
  }
  guard.last.set(p, { term, md5: md5(text) });
}

function noteFail(p, why) {
  if (guard.run < 0) return;
  const n = (guard.fails.get(p) || 0) + 1;
  guard.fails.set(p, n);
  if (n >= 2) {
    guard.disabled.add(p);
    console.warn(`[cover] ${p} 连续 ${n} 次异常(${why}),本轮停用`);
  }
}

const noteOk = (p) => { if (guard.run >= 0) guard.fails.set(p, 0); };

/* ---------- QQ 音乐(半官方接口,官方专辑图;默认不启用,见文件头备注) ---------- */
async function qqFind(term, song, strict) {
  if (guard.disabled.has('qq')) return null;
  try {
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
    const t = await r.text();
    const d = JSON.parse(t);
    if (d?.req?.code !== 0) throw new Error(`req.code ${d?.req?.code}`);
    noteOk('qq');
    noteResponse('qq', term, t);
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
  } catch (e) {
    noteFail('qq', e.message);
  }
  return null;
}

/* ---------- iTunes Search API(官方、免密钥) ---------- */
const ITUNES_COUNTRIES = ['CN', 'TW', 'JP'];
const itunesArt = (u) => String(u || '').replace(/\/\d+x\d+bb\.jpg$/, '/600x600bb.jpg');

async function itunesFind(term, song, strict) {
  if (guard.disabled.has('itunes')) return null;
  let reached = false;
  for (const country of ITUNES_COUNTRIES) {
    const url =
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
      `&media=music&entity=song&limit=5&country=${country}`;
    let d;
    try {
      d = await getJSON(url);
      reached = true;
    } catch { continue; } // 单一 storefront 失败不影响后续
    for (const x of d.results || []) {
      const r = {
        kind: 'song',
        artist: x.artistName || '',
        title: x.trackName || '',
        url: itunesArt(x.artworkUrl100 || x.artworkUrl60 || ''),
      };
      if (!acceptable(r, song, strict) || !r.url) continue;
      noteOk('itunes');
      return r;
    }
  }
  if (!reached) noteFail('itunes', '全部 storefront 不可达');
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
  if (guard.disabled.has('netease')) return null;
  try {
    // search/get/web 已被 405 反爬,cloudsearch/pc 仍可用且结果自带 al.picUrl
    const r = await fetch('https://music.163.com/api/cloudsearch/pc', {
      method: 'POST',
      headers: neteaseHeaders(),
      body: `s=${encodeURIComponent(term)}&type=1&limit=10`,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const t = await r.text();
    noteOk('netease');
    noteResponse('netease', term, t);
    const d = JSON.parse(t);
    const items = (d?.result?.songs || []).map((x) => {
      const al = x.al || x.album || {};
      const artists = x.ar || x.artists || [];
      return {
        kind: 'song',
        artist: artists.map((a) => a.name).join('/'),
        title: x.name || '',
        id: x.id,
        // fee:1=VIP / 4=购买 / 8=官方低音质免费;0 几乎都是用户上传的仿冒条目
        // (元数据伪装成原唱,封面张冠李戴),直接排除
        fee: x.fee,
        url: neteasePic(al.picUrl || ''),
      };
    });
    const officialFee = (f) => f == null || f === 1 || f === 4 || f === 8;
    // 优先用自带图的结果;都没有时再对命中的候选补一次歌曲详情
    for (const c of items) {
      if (!officialFee(c.fee)) continue;
      if (!acceptable(c, song, strict) || !c.url) continue;
      return c;
    }
    for (const c of items) {
      if (!officialFee(c.fee)) continue;
      if (!acceptable(c, song, strict) || !c.id) continue;
      try {
        const pic = await neteaseSongPic(c.id);
        if (pic) return { ...c, url: pic };
      } catch { continue; }
    }
  } catch (e) {
    noteFail('netease', e.message);
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

// 多路自适应排序:哪路最近命中就先走哪路(大陆服务器上 iTunes 常 403,省去无效请求)。
// 默认不含 QQ —— 其接口在大陆服务器上有缓存污染/风控问题,需 COVER_PROVIDERS 显式启用。
const KNOWN_PROVIDERS = ['qq', 'itunes', 'netease'];
const envProviders = (process.env.COVER_PROVIDERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
let providerOrder = envProviders.length && envProviders.every((p) => KNOWN_PROVIDERS.includes(p))
  ? envProviders
  : ['itunes', 'netease'];
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
    if (guard.disabled.has(p)) continue;
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
        guard.run = stat.run;      // 新一轮:重置熔断与污染检测
        guard.disabled.clear();
        guard.fails.clear();
        guard.last.clear();
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
