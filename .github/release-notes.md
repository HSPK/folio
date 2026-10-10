# Folio 0.1.0 — Write freely. Keep your files.

**English** · [简体中文介绍](https://github.com/HSPK/folio/blob/main/README.zh-CN.md)

Folio is an open-source, local-first Markdown workspace for writing, research
and personal knowledge. Edit a formatted page, switch to source whenever you
need it, and keep your notes as ordinary files.

![Folio Live editor](https://raw.githubusercontent.com/HSPK/folio/main/docs/assets/live-light.png)

## Inside the first release

- **Write your way:** Live, Source, Compare and Read; tables, task lists, math and image paste.
- **Connect your notes:** full-text search, YAML tags, wiki links, backlinks, templates and favorites.
- **Work together deliberately:** projects, page permissions, public links and real-time collaboration.
- **Keep a recovery path:** version history, a recycle bin and local drafts.
- **Bring your own workflow:** Git diffs, staging and commits, with optional scheduled commit-and-push.

A Rust service opens the editor in your existing browser. Windows/macOS have
native launchers; Linux uses a CLI. All three platforms have x64 and ARM64 builds.

## Install

Linux / macOS:

```sh
curl -fsSL https://github.com/HSPK/folio/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/HSPK/folio/releases/latest/download/install.ps1 | iex
```

The installers select x64 or ARM64, verify SHA-256, and install for the current
user without administrator privileges. Linux installs the CLI to `~/.local/bin`,
macOS installs `~/Applications/Folio.app`, and Windows installs to
`%LOCALAPPDATA%\Programs\Folio` with a Start Menu shortcut and user PATH entry.

Linux: `folio --serve /path/to/markdown`. Windows/macOS: open Folio and choose a
Markdown folder. On the first browser visit, create a local administrator.

macOS builds are ad-hoc signed, not notarized; macOS may require approval in
Privacy & Security. Save unsaved text and stop the previous application before
upgrading. Old browser sessions must be reopened after the namespace change.

Folio is early-stage software: back up important notes. The service is local by
default; public links need explicit permissions and a reachable server.
Folio does not configure cloud hosting, TLS or cross-device connectivity.
Accounts, history and indexes are stored separately from the Markdown files.

[Website](https://hspk.github.io/folio/) ·
[Install and usage](https://github.com/HSPK/folio#install) ·
[Feedback](https://github.com/HSPK/folio/issues/new/choose) ·
[Press kit](https://github.com/HSPK/folio/blob/main/docs/press-kit.md)

MIT licensed. Dependencies retain their own notices. Assets are available for
manual installation; `SHA256SUMS` covers all six platform archives and installers.

## 中文简介

**自由书写，文件仍属于你。**

Folio 是开源、本地优先的 Markdown 工作台：直接编辑排版后的页面，随时查看源码，
笔记保留为普通文件。支持全文搜索、双链、历史、按需协作和可选的 Git 同步。
Windows、macOS、Linux 均提供 x64 / ARM64 版本。

上方一行命令可安装。Windows/macOS 打开 Folio 后选目录，Linux 使用
`folio --serve /path/to/markdown`，首次浏览器访问创建本机管理员。
当前应用界面为英文；文档和主页提供中英文版本。

0.1.0 仍处于早期阶段，重要笔记请备份。macOS 发布包尚未公证，分享不等同于自动配置公网服务。
欢迎[试用反馈](https://github.com/HSPK/folio/issues/new/choose)，
或阅读[中文产品介绍](https://github.com/HSPK/folio/blob/main/README.zh-CN.md)。
