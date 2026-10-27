import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Library } from './lib/library.js';
import { parseLRC } from './lib/lrc.js';
import { createCoverQueue, searchCoverCandidates, downloadImage } from './lib/cover-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const lib = new Library(path.join(__dirname, 'data'));
await lib.init();
const coverQueue = createCoverQueue(lib);

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: lib.tmpDir, limits: { fileSize: 200 * 1024 * 1024 } });

const pubSong = (s, i) => ({
  id: s.id,
  no: i + 1,
  title: s.title,
  artist: s.artist,
  album: s.album,
  duration: s.duration,
  hasCover: !!s.coverFile,
  hasLyrics: !!s.lrc,
});

const pubAll = () => ({
  songs: lib.songs.map(pubSong),
  pendingLyrics: lib.pendingLyrics,
});

// 兼容旧版 busboy 以 latin1 解码 UTF-8 文件名的情况
function fixName(name) {
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    return fixed.includes('\uFFFD') || fixed.includes('?') ? name : fixed;
  } catch {
    return name;
  }
}

app.get('/api/songs', (req, res) => res.json(pubAll()));

app.post('/api/upload', upload.array('files', 100), async (req, res) => {
  const results = [];
  for (const f of req.files || []) {
    const name = fixName(f.originalname);
    const ext = path.extname(name).toLowerCase();
    try {
      if (ext === '.mp3') {
        const song = await lib.addMp3(f.path, name);
        // 无内嵌封面 → 后台自动联网补全,不拖慢上传响应
        if (!song.coverFile) coverQueue.push([song.id]);
        results.push({ file: name, kind: 'mp3', ok: true, title: song.title, paired: !!song.lrc, songId: song.id });
      } else if (ext === '.lrc' || ext === '.txt') {
        const r = await lib.addLrc(f.path, name);
        results.push({ file: name, kind: 'lrc', ok: true, paired: r.paired, songId: r.paired || null });
      } else {
        fs.rmSync(f.path, { force: true });
        results.push({ file: name, ok: false, error: '仅支持 MP3 / LRC 文件' });
      }
    } catch (err) {
      try { fs.rmSync(f.path, { force: true }); } catch {}
      results.push({ file: name, ok: false, error: err.message || '处理失败' });
    }
  }
  res.json({ results, ...pubAll() });
});

// 音频流：sendFile 原生支持 Range，可拖动进度
app.get('/audio/:id', (req, res) => {
  const s = lib.get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: '曲目不存在' });
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(lib.musicPath(s.file));
});

app.get('/api/cover/:id', (req, res) => {
  const s = lib.get(Number(req.params.id));
  if (!s || !s.coverFile) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(lib.coverPath(s.coverFile));
});

app.get('/api/lyrics/:id', (req, res) => {
  const s = lib.get(Number(req.params.id));
  if (!s || !s.lrc) return res.json({ lines: [] });
  let text = '';
  try {
    text = fs.readFileSync(lib.lyricsPath(s.lrc), 'utf8');
  } catch {
    return res.json({ lines: [] });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ lines: parseLRC(text) });
});

app.post('/api/songs/:id/pair', (req, res) => {
  const { lrcId } = req.body || {};
  const song = lib.pair(Number(req.params.id), Number(lrcId));
  if (!song) return res.status(404).json({ error: '未找到对应曲目或歌词' });
  res.json({ ok: true, ...pubAll() });
});

app.delete('/api/songs/:id', (req, res) => {
  lib.removeSong(Number(req.params.id));
  res.json({ ok: true, ...pubAll() });
});

// 批量移除,body: { "ids": [number] }
app.delete('/api/songs', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: '缺少 ids 数组' });
  const removed = lib.removeSongs(ids);
  res.json({ ok: true, removed, ...pubAll() });
});

app.delete('/api/lyrics/:lrcId', (req, res) => {
  lib.removePendingLyric(Number(req.params.lrcId));
  res.json({ ok: true, pendingLyrics: lib.pendingLyrics });
});

// 封面自动补全:body { ids? } 省略即全部缺封面的曲目(含此前未匹配到的,可重试)
app.post('/api/covers/fetch', (req, res) => {
  const { ids } = req.body || {};
  const target = Array.isArray(ids) && ids.length
    ? ids.map(Number).filter((n) => lib.get(n))
    : lib.songs.filter((s) => !s.coverFile).map((s) => s.id);
  const added = coverQueue.push(target);
  res.json({ ok: true, added, ...coverQueue.status() });
});

app.get('/api/covers/status', (req, res) => res.json(coverQueue.status()));

// 手动选封面:聚合三源候选,不落库,由用户挑选
app.get('/api/covers/search/:id', async (req, res) => {
  const s = lib.get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: '曲目不存在' });
  try {
    res.json({ id: s.id, groups: await searchCoverCandidates(s) });
  } catch (err) {
    console.error('[covers/search]', err);
    res.status(500).json({ error: '候选搜索失败' });
  }
});

// 应用封面:multipart 图片文件字段 `file`,或 JSON { url }(三源候选地址)
app.post('/api/songs/:id/cover', upload.single('file'), async (req, res, next) => {
  const s = lib.get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: '曲目不存在' });
  try {
    if (req.file) {
      if (!/^image\//i.test(req.file.mimetype || '')) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(400).json({ error: '仅支持图片文件' });
      }
      const data = fs.readFileSync(req.file.path);
      fs.rmSync(req.file.path, { force: true });
      const ext = /png/i.test(req.file.mimetype) ? '.png' : '.jpg';
      lib.setCover(s.id, { data, ext });
    } else if (req.body?.url) {
      if (!/^https?:\/\//i.test(req.body.url)) {
        return res.status(400).json({ error: '仅支持 http(s) 图片地址' });
      }
      try {
        lib.setCover(s.id, await downloadImage(req.body.url));
      } catch (e) {
        return res.status(400).json({ error: `封面下载失败（${e.message}）` });
      }
    } else {
      return res.status(400).json({ error: '缺少图片文件或 url' });
    }
    res.json({ ok: true, ...pubAll() });
  } catch (err) {
    next(err);
  }
});

// 统一错误出口
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '单个文件超过 200MB 上限' });
  }
  console.error('[server]', err);
  res.status(500).json({ error: err.message || '服务器错误' });
});

app.listen(PORT, HOST, () => {
  console.log(`ONLY PLAY 已开馆 → http://localhost:${PORT}`);
});
