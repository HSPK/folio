# Folio press kit / 宣传素材包

[English README](../README.md) · [中文 README](../README.zh-CN.md)

## Facts / 产品事实

| Item | Detail |
| --- | --- |
| Name / 名称 | Folio |
| Tagline / 英文口号 | Write freely. Keep your files. |
| 中文口号 | 自由书写，文件仍属于你。 |
| Category / 定位 | Local-first Markdown workspace / 本地优先的 Markdown 工作台 |
| Website / 主页 | https://hspk.github.io/folio/ |
| 中文主页 | https://hspk.github.io/folio/zh.html |
| Source / 仓库 | https://github.com/HSPK/folio |
| Download / 下载 | https://github.com/HSPK/folio/releases |
| Current launch / 首发 | 0.1.0 |
| Platforms / 平台 | Windows, macOS, Linux; x64 and ARM64 |
| License / 许可证 | MIT; dependencies retain their own licenses |

## Short descriptions / 简短介绍

**English, one line**

Folio is an open-source, local-first Markdown workspace with Live editing,
plain-file storage, search, collaboration and optional Git sync.

**中文一句话**

Folio 是开源、本地优先的 Markdown 工作台，支持实时编辑、文件存储、搜索、
协作和可选的 Git 同步。

**English, a short paragraph**

Write directly in a formatted page, switch to Markdown source whenever you need
it, and keep your notes as ordinary files. Folio pairs a Rust service with your
existing browser instead of bundling a browser engine. It brings projects,
search, wiki links, history and opt-in collaboration to Windows, macOS and Linux.

**中文短介绍**

在排版后的页面里直接写作，随时切换 Markdown 原文，笔记仍保存为普通文件。
Folio 用 Rust 服务和你已有的浏览器组成工作台，不打包浏览器内核。
Windows、macOS 和 Linux 上均可使用项目、搜索、双链、历史与按需开启的协作。

## Visual assets / 图片素材

- [Brand banner, SVG](assets/banner.svg) — editable 1280 × 640 brand artwork.
- [Social preview, PNG](assets/social-preview.png) — 1280 × 640, suitable for link cards and repository social preview.
- [Live editor](assets/live-light.png) — actual application screenshot, light theme.
- [Source + preview](assets/compare-dark.png) — actual application screenshot, dark theme.
- [App icon, SVG](../Shared/Resources/FolioIcon.svg) — use for attribution or app listings.

Screenshots use synthetic demonstration notes and a local `demo` account, not
personal data. The current interface is English; the documentation and website
are bilingual. Do not describe these assets as a Chinese-localized app.

截图使用独立示例笔记和本地 `demo` 账号，不含真实用户资料。
目前应用界面为英文，中英文支持指文档和产品主页，不要宣传为中文界面。

Regenerate images with `npm --prefix web run capture:product` after building the
CLI, or set `FOLIO_CAPTURE_EXE` to a specific release executable.

## Ready-to-adapt launch copy / 可改写的发布文案

### X / Mastodon / Bluesky

> Meet Folio: a local-first Markdown workspace. Live editing, plain files,
> search, wiki links, collaboration and optional Git sync.
>
> Windows / macOS / Linux. MIT licensed.
>
> https://github.com/HSPK/folio
>
> #Markdown #LocalFirst #OpenSource

### 中文社区短帖

> 做了一个 Markdown 工作台：Folio。
>
> 不导入专有笔记库，打开文件夹就能写；支持 Live / Source / Compare / Read、
> 全文搜索、双链、历史与按需协作，也能接 Git。
>
> Windows / macOS / Linux，x64 / ARM64，MIT 开源。仍处于早期阶段，欢迎试用和反馈。
>
> https://github.com/HSPK/folio
>
> #Markdown #开源 #本地优先

### Show HN / Reddit / technical communities

**Suggested title**

> Show HN: Folio — a local-first Markdown workspace using your existing browser

**Suggested body**

> I built Folio for people who want formatted Markdown editing without moving
> their notes into a proprietary notebook.
>
> Notes stay as files. A Rust service opens the workspace in your existing
> browser; Windows/macOS have native launchers, and Linux uses a CLI.
> It supports Live, Source, Compare and Read views, search, wiki links, history,
> projects and opt-in collaboration. Git commit-and-push is optional.
>
> The first release is 0.1.0, available for x64 and ARM64 across all three
> platforms. It is MIT licensed and early-stage: important notes should be
> backed up. macOS builds are ad-hoc signed, not notarized.
>
> Source and install instructions: https://github.com/HSPK/folio
>
> I would especially appreciate feedback on the editing workflow and how well
> it fits an existing Markdown folder.

### 中文长帖开场

**建议标题：** Folio：文件仍属于你的本地 Markdown 工作台

> 我希望写 Markdown 时既能专注内容，又不用迁移到专有笔记库，所以做了 Folio。
>
> 它把 Rust 本地服务和现有浏览器结合起来，提供实时排版编辑、源码和预览对照、
> 全文搜索、双链、历史、项目与按需协作。Markdown 和附件仍保存在文件夹中，
> 可以继续用自己的 Git 与备份工具。
>
> 0.1.0 已发布，支持 Windows、macOS、Linux 的 x64 / ARM64，使用 MIT 许可证。
> 目前仍是早期项目，重要内容请备份；macOS 版本尚未公证。
>
> 仓库与一行安装命令：https://github.com/HSPK/folio
>
> 欢迎带着真实工作流反馈，也欢迎贡献小修复、文档和可复现的问题。

## Distribution checklist / 发布渠道清单

1. **GitHub:** keep the description, relevant topics, bilingual README and release introduction consistent. Use `social-preview.png` in repository **Settings → General → Social preview**; upload it there manually.
2. **Launch post:** choose one relevant community, read its self-promotion rules, include a screenshot and mention that 0.1.0 is early-stage. Engage with feedback rather than repeating the same post everywhere.
3. **Directories:** submit to an appropriate Markdown/local-first directory only after checking its contribution criteria; do not claim acceptance or affiliation.
4. **Follow-up:** publish a short release note when a reported issue is actually fixed. Link the issue and show the changed workflow.

GitHub topics: `markdown`, `markdown-editor`, `notes`, `note-taking`,
`local-first`, `knowledge-management`, `personal-knowledge-management`,
`self-hosted`, `collaborative-editing`, `git`, `rust`, `cross-platform`,
`windows`, `macos`, `linux`, `open-source`.

中文渠道可选择 V2EX、掘金、少数派等适合的社区；英文渠道可选择 Show HN、
Reddit 的相关社区或个人社交账号。以上是可供作者使用的文案和渠道，不表示已经代发。

## Claims to avoid / 不要夸大

- No invented users, download counts, benchmarks, endorsements or competitor superiority.
- No claim of end-to-end encrypted collaboration, a hosted cloud, built-in cross-device sync or notarized macOS builds.
- No “all data is Markdown” claim: notes are files, but accounts, history, indexing and collaboration use separate storage.
- No promise of exact-source preservation after Live edits; Source is available for precise syntax control.
- No promise of a Chinese application interface, unlimited library size or production maturity.
