# ONLY PLAY · 只有声音的美术馆

> 一座局域网里的音乐美术馆:上传 MP3 与 LRC 即入藏,打开即播、歌词同步,白天 / 夜间双展厅。

ONLY PLAY 是一个**单用户、零配置**的局域网音乐播放器。它把自己想象成一座美术馆——歌曲是展品,封面是画框,歌词是展签,而你是唯一的观众。

- 🖼 **展厅** —— 沉浸式播放页,逐行高亮的同步歌词,点击任意一行即可跳转
- 📚 **曲库** —— 所有藏品的目录,点选即播
- 🎨 **入藏** —— 拖入 `.mp3` / `.lrc`,同名自动配对
- 🌗 **白天 / 夜间** —— 双主题展厅,跟随系统、记忆选择

## 功能特性

- **网页拖放入藏**:MP3 与 LRC 一次拖入,按文件名自动配对;未匹配的歌词进入「待配对」列表,可手动指派给任意曲目
- **元数据自动读取**:标题、艺术家、专辑、时长、内嵌封面自动解析([music-metadata](https://github.com/borewit/music-metadata));缺失时从「艺术家 - 标题.mp3」文件名反解,无封面则以曲目首字作为展品
- **同步歌词**:支持标准 LRC,逐行高亮、点击跳转
- **流式播放**:音频接口支持 HTTP Range,进度条可随意拖动
- **状态记忆**:记住上次播放的曲目与主题;歌曲播完自动下一首
- **快捷键**:`空格` 播放 / 暂停,`←` / `→` 快退 / 快进 5 秒
- **纯文件存储**:所有数据落在 `data/` 目录,备份即拷贝,无数据库依赖

## 快速开始

要求 Node.js ≥ 18。

```bash
git clone git@github.com:wolfpan/onlyplay.git
cd onlyplay
npm install
npm start
```

打开 <http://localhost:3000>,点击「入馆」即开始播放(受浏览器自动播放策略限制,需要这一次点击)。

局域网 / VPN 内其他设备访问 `http://<本机IP>:3000`。

### 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |

Windows PowerShell 自定义端口:

```powershell
$env:PORT=8080; npm start
```

## 使用指南

**入藏**:进入「入藏」页,把 `.mp3` 与 `.lrc` 拖入(或点击选择),同名文件自动配对。单文件上限 200MB,一次最多 100 个。未被匹配的歌词会留在「待配对歌词」列表中,手动指派给任意曲目即可。

**展厅**:右上角圆形图标切换白天 / 夜间展厅,选择会被记忆。点击任意歌词行可跳转到该句。

**曲库**:点击曲目即播放;「移除」需二次点击确认。

**备份**:所有数据存于 `data/`(`songs.json` 索引 + `music/` 音频 + `lyrics/` 歌词 + `covers/` 封面),备份即拷贝整个目录。

## 项目结构

```
onlyplay/
├── server.js          # Express 服务:上传、音频流、歌词、曲库 API
├── lib/
│   ├── library.js     # 曲库:文件系统 + songs.json 索引,入藏 / 配对 / 移除
│   └── lrc.js         # LRC 歌词解析
├── public/            # 前端(原生 HTML / CSS / JS,无构建步骤)
│   ├── index.html
│   ├── app.js
│   └── style.css
└── data/              # 运行时生成,不入库
    ├── songs.json     # 曲目索引
    ├── music/         # 音频文件
    ├── lyrics/        # LRC 歌词
    └── covers/        # 提取的封面
```

## 技术栈

- 后端:Node.js(ESM)+ Express + Multer + music-metadata
- 前端:原生 HTML / CSS / JavaScript,零依赖、零构建

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/songs` | 曲库全量(曲目 + 待配对歌词) |
| POST | `/api/upload` | 上传 MP3 / LRC(multipart,字段 `files`) |
| GET | `/audio/:id` | 音频流(支持 Range) |
| GET | `/api/cover/:id` | 曲目封面 |
| GET | `/api/lyrics/:id` | 解析后的歌词行 |
| POST | `/api/songs/:id/pair` | 手动配对歌词,body:`{ "lrcId": number }` |
| DELETE | `/api/songs/:id` | 移除曲目 |
| DELETE | `/api/lyrics/:lrcId` | 移除待配对歌词 |

## 安全提示

ONLY PLAY 按单用户设计,**没有任何鉴权**:任何能访问该端口的人都可以上传、删除你的曲库。请仅在局域网 / VPN 内使用,不要将端口暴露到公网。

## License

尚未指定开源许可证,使用前请与作者联系。
