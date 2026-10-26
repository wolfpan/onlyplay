// 曲库：文件系统 + songs.json 索引，负责入藏、配对、移除
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';

const stripExt = (n) => String(n).replace(/\.[^.]+$/, '');
const sanitize = (n) =>
  String(n).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';

// 归一化比较基准：去扩展名、小写、去掉空白与常见分隔符，用于同名自动配对
export function normalizeBase(name) {
  return stripExt(String(name))
    .toLowerCase()
    .replace(/[\s\-–—_·．.,!！?？'’"“”()（）[\]【】&＆~～]+/g, '');
}

// 从文件名反解「艺术家 - 标题」，支持前导序号
export function guessFromFilename(name) {
  let base = stripExt(name).trim().replace(/^\s*\d{1,3}\s*[.．\-–—_、]\s*/, '');
  const parts = base.split(/\s*[-–—]\s*/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: base || stripExt(name) };
}

export class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.musicDir = path.join(dataDir, 'music');
    this.lyricsDir = path.join(dataDir, 'lyrics');
    this.coversDir = path.join(dataDir, 'covers');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.storePath = path.join(dataDir, 'songs.json');
    this.songs = [];
    this.pendingLyrics = [];
    this.nextId = 1;
    this.nextLrcId = 1;
  }

  async init() {
    for (const d of [this.dataDir, this.musicDir, this.lyricsDir, this.coversDir, this.tmpDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    // 清理上传残留
    for (const f of fs.readdirSync(this.tmpDir)) {
      try { fs.rmSync(path.join(this.tmpDir, f), { force: true }); } catch {}
    }
    if (fs.existsSync(this.storePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        this.songs = Array.isArray(data.songs) ? data.songs : [];
        this.pendingLyrics = Array.isArray(data.pendingLyrics) ? data.pendingLyrics : [];
        this.nextId = data.nextId || Math.max(0, ...this.songs.map((s) => s.id)) + 1;
        this.nextLrcId = data.nextLrcId || Math.max(0, ...this.pendingLyrics.map((l) => l.id)) + 1;
      } catch (e) {
        console.error('[library] songs.json 解析失败，已备份重建：', e.message);
        try { fs.copyFileSync(this.storePath, this.storePath + '.bak'); } catch {}
      }
    }
    this.save();
  }

  save() {
    const data = {
      nextId: this.nextId,
      nextLrcId: this.nextLrcId,
      songs: this.songs,
      pendingLyrics: this.pendingLyrics,
    };
    const tmp = this.storePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.storePath);
  }

  get(id) {
    return this.songs.find((s) => s.id === id);
  }
  musicPath(f) { return path.join(this.musicDir, f); }
  lyricsPath(f) { return path.join(this.lyricsDir, f); }
  coverPath(f) { return path.join(this.coversDir, f); }

  // 与歌词匹配的候选名：原始文件名、艺术家-标题、纯标题
  _candidates(originalName, song) {
    const c = [stripExt(originalName)];
    if (song) {
      if (song.artist && song.title) c.push(`${song.artist} - ${song.title}`);
      if (song.title) c.push(song.title);
    }
    return c.map(normalizeBase).filter(Boolean);
  }

  async addMp3(tmpPath, originalName) {
    const id = this.nextId++;
    const fileName = `${Date.now()}-${sanitize(stripExt(originalName))}.mp3`;
    const dest = this.musicPath(fileName);
    fs.renameSync(tmpPath, dest);

    const song = {
      id, file: fileName, originalName,
      title: '', artist: '', album: '', duration: 0,
      coverFile: null, lrc: null,
    };

    try {
      const mm = await parseFile(dest, { duration: true });
      song.title = mm.common.title || '';
      song.artist = mm.common.artist || mm.common.artists?.[0] || mm.common.albumartist || '';
      song.album = mm.common.album || '';
      song.duration = Math.round((mm.format.duration || 0) * 10) / 10;
      const pic = mm.common.picture?.[0];
      if (pic && pic.data) {
        const ext = /png/i.test(pic.format || '') ? '.png' : '.jpg';
        const coverName = `${id}${ext}`;
        fs.writeFileSync(this.coverPath(coverName), pic.data);
        song.coverFile = coverName;
      }
    } catch (e) {
      console.warn('[library] 元数据解析失败（回退文件名）:', originalName, e.message);
    }

    if (!song.title) {
      const guess = guessFromFilename(originalName);
      song.title = guess.title;
      if (!song.artist) song.artist = guess.artist;
    }

    // 尝试与待配对歌词自动配对
    const cands = this._candidates(originalName, song);
    const idx = this.pendingLyrics.findIndex((l) => cands.includes(normalizeBase(l.originalName)));
    if (idx >= 0) song.lrc = this.pendingLyrics.splice(idx, 1)[0].file;

    this.songs.push(song);
    this.save();
    return song;
  }

  async addLrc(tmpPath, originalName) {
    const fileName = `${Date.now()}-${sanitize(stripExt(originalName))}.lrc`;
    fs.renameSync(tmpPath, this.lyricsPath(fileName));

    const base = normalizeBase(originalName);
    const song = this.songs.find(
      (s) => !s.lrc && this._candidates(s.originalName, s).includes(base)
    );
    if (song) {
      song.lrc = fileName;
      this.save();
      return { paired: song.id, song };
    }
    const entry = { id: this.nextLrcId++, file: fileName, originalName };
    this.pendingLyrics.push(entry);
    this.save();
    return { paired: null, pendingId: entry.id };
  }

  pair(songId, lrcId) {
    const song = this.get(songId);
    const idx = this.pendingLyrics.findIndex((l) => l.id === lrcId);
    if (!song || idx < 0) return null;
    const pending = this.pendingLyrics.splice(idx, 1)[0];
    if (song.lrc) { try { fs.rmSync(this.lyricsPath(song.lrc), { force: true }); } catch {} }
    song.lrc = pending.file;
    this.save();
    return song;
  }

  removeSong(id) {
    const idx = this.songs.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    const s = this.songs.splice(idx, 1)[0];
    for (const [file, dir] of [
      [s.file, this.musicDir],
      [s.coverFile, this.coversDir],
      [s.lrc, this.lyricsDir],
    ]) {
      if (file) { try { fs.rmSync(path.join(dir, file), { force: true }); } catch {} }
    }
    this.save();
    return true;
  }

  removeSongs(ids) {
    const set = new Set(ids.map(Number).filter(Number.isFinite));
    let n = 0;
    for (const s of [...this.songs]) {
      if (set.has(s.id) && this.removeSong(s.id)) n++;
    }
    return n;
  }

  removePendingLyric(lrcId) {
    const idx = this.pendingLyrics.findIndex((l) => l.id === lrcId);
    if (idx < 0) return false;
    const l = this.pendingLyrics.splice(idx, 1)[0];
    try { fs.rmSync(this.lyricsPath(l.file), { force: true }); } catch {}
    this.save();
    return true;
  }

  // 落盘一张封面并挂到曲目上({id}.jpg/.png),已有旧封面则替换
  setCover(id, { data, ext }) {
    const s = this.get(id);
    if (!s) return null;
    const name = `${id}${ext}`;
    fs.writeFileSync(this.coverPath(name), data);
    if (s.coverFile && s.coverFile !== name) {
      try { fs.rmSync(this.coverPath(s.coverFile), { force: true }); } catch {}
    }
    s.coverFile = name;
    this.save();
    return s;
  }
}
