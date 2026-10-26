// LRC 歌词解析：支持多时间标签、offset 元数据、增强格式清理
export function parseLRC(text) {
  let offset = 0;
  const om = text.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im);
  if (om) offset = parseInt(om[1], 10);

  const timeTag = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const lines = [];

  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(timeTag)];
    if (!tags.length) continue;
    const content = raw
      .replace(timeTag, '')
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '') // 逐字时间标签
      .trim();
    if (!content) continue;
    for (const t of tags) {
      const frac = parseInt((t[3] || '0').padEnd(3, '0').slice(0, 3));
      const time = parseInt(t[1]) * 60 + parseInt(t[2]) + frac / 1000 - offset / 1000;
      lines.push({ time: Math.max(0, time), text: content });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}
