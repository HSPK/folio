# Folio 0.1.0

A local-first Markdown workspace with Live, Source and Read views, projects,
collaboration, history and optional Git sync. Notes stay as ordinary files.

The application, Rust crates, editor package, native wrappers and icons now use
the Folio name throughout.

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

See the README for version-pinned installation, custom installation directories
and migration from the previous application name. Assets are also available for
manual installation; `SHA256SUMS` covers all six platform archives and installers.
