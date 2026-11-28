# @folio/editor

Independent browser editor package used by Folio, published within this workspace
as `@folio/editor`. All handwritten implementation, build, model tests, and
browser benchmarks are strict TypeScript. Package exports point to the checked
implementation rather than separately maintained API declarations.

## Public API

```js
import {
  applyAppearance,
  attachScrollbars,
  createInlineEditor,
  createSourceEditor,
  extractOutline,
} from "@folio/editor";
```

- `createInlineEditor` provides the Milkdown Live Markdown editor.
- `createSourceEditor` provides the large-document CodeMirror Source adapter.
- `mountCodeSource(host, { path, content, readOnly, onChange, onSave })` mounts a standalone file editor
  synchronously. It returns `getValue()`, `focus()`, and `destroy()`. Source text uses LF line breaks
  like the Markdown textarea. Edits call `onChange()` without serializing the document; read it with
  `getValue()` when saving. Ctrl/Cmd+S calls `onSave()` only for a writable file. Highlighting loads
  separately from the existing `code-syntax.mjs` asset; unknown extensions remain plain text.
- `extractOutline` returns Unicode heading labels, levels, offsets, and stable IDs.
- `applyAppearance` applies local theme and font settings without rebuilding an editor.
- `attachScrollbars` provides the shared overlay scrollbar adapter.
- `createSharedText` provides a Yjs Markdown CRDT with local-only undo and relative cursor positions.

Collaborative hosts can call `getSelection`, `cursorRect`, `setReadOnly`, and
`replaceSource` on the Live adapter. The Source adapter exposes `getSelection`,
`cursorRect`, `setReadOnly`, and `viewportRect` for both textarea and virtual editing.
Transport, authenticated presence and disk persistence remain host responsibilities.

Use the Source adapter's `applyEdit(text)` for an undoable user-requested replacement,
including recovered drafts. It records one edit in native or virtual Source history.
Use `reset(text)` when opening a different document; assigning `value` remains a
projection update rather than an undoable user action.
`mirrorLive` carries Live body history groups into that same document's Markdown
history. At collaboration handoff, `adoptSoloHistory` accepts a matching pristine
room seed; subsequent peer changes rebase the solo history, never enter it.

The Live adapter's `clear()` unloads the current document while retaining reusable
tools. Call the idempotent, terminal `destroy()` when removing its host: it releases
the editor session, global listeners, observers, timers, and floating UI, including
resources created before initialization fails. Loading after destruction is an
error; create a new adapter to mount again. Late initialization cannot reactivate
a destroyed instance or call its host's URL resolver.

Live heading IDs come from the shared `assignHeadingIds` helper through node
decorations. The commonmark `syncHeadingIdPlugin` is intentionally excluded:
rewriting every heading would duplicate this work and emit redundant document
updates. Live anchors, outline navigation, and Rust Read-mode anchors must agree.

Live initialization skips a second semantic parse only when serialization exactly
matches the original Markdown body. Any difference, including whitespace, still
uses the existing round-trip fingerprint comparison; no source is rewritten on load.
If a paragraph, heading, list or table cannot round-trip (for example, nested
emphasis that cannot be represented with flat marks), Live can show that block
as literal Markdown. The whole replacement document must pass the same proof.
Edit a preserved block in Source; other blocks remain editable in Live. When
block boundaries cannot be matched or the proof still fails, the host falls
back to Source without retaining the rejected ProseMirror view.

`createInlineEditor` accepts an optional `transformUrl(url, documentPath)` callback.
Hosts can use it to scope rendered attachment and note links to a project without
changing the Markdown stored on disk. Local targets are normalized, encoded
project-relative URL paths; Folio resolves them to resource UUID URLs. Hosts may
call `refreshLinks()` after asynchronous identity resolution. Changes to projected
link attributes are ignored by the editor's DOM observer, not serialized as edits
to Markdown link destinations. Image upload, clipboard handling and
project permissions remain host responsibilities; Live selection reads the
current DOM caret so native navigation immediately followed by paste stays exact.

`captureImageInsertion` reserves a local, mapped paste location in either editor.
Live displays the files as canvas widgets, outside the Markdown document. The
host uploads the original files, then calls the bookmark's `insert` with durable
relative URLs, or `cancel`. Editing continues during upload; replacing the target
invalidates the bookmark instead of overwriting newer text. Shared hosts can
connect `watchRemoteImageEdits` to `beforeRemote` while the upload is pending.

The Live adapter accepts `wikiDocuments()` for `[[...]]` completion, `onTag(tag)`
for tag navigation, and `onNotice(message)` to route metadata warnings to the
host's status area. Both editors expose `selectAtPoint(x, y)` for image drops.
`readMetadataTags`, `updateMetadataTags`, and `normalizeTags` provide the same
tag semantics to hosts; unrelated YAML and body spelling is preserved.

Wiki links use `[[target|alias]]` and remain wiki syntax when serialized.
`mergeSharedUpdates` supports durable host-side storage of unacknowledged
Yjs updates; transport, encryption and authenticated storage remain host concerns.

The additional exports `./helpers`, `./markdown`, `./math`, `./roundtrip`, and
`./source` are available for focused tests and integrations.

## Live formula editing

Inline `$...$` and display `$$...$$` formulas are regular editable ProseMirror
text content. Click the rendered formula or focus it with the keyboard to reveal
its TeX source. Typing, selection, Undo/Redo, history, dirty tracking, and saving
use the same document transactions as surrounding text; KaTeX updates after
every edit with `trust: false`.

## Development

Host UI styling can set `--control-radius`, `--control-hover-background`,
`--control-selected-background`, `--control-focus-background`, and
`--control-focus-ring`. Metadata, tag, formula, and completion controls share
these variables, with standalone defaults when the host does not supply them.
Keyboard buttons use rounded surface feedback; text fields use a full inset
focus ring rather than a bottom highlight bar.

```bash
npm install
npm run check:types
npm run build
npm test
npm run benchmark:math-cache
npm run benchmark:math
npm run benchmark:math-edit
npm run benchmark:source-prepare
```

Use Node.js 22.12 or later. Build and test scripts use `tsx`; `tsc` checks the
implementation, fixtures, and both Node and browser benchmark code. The host
application imports the same source types.

The build writes self-contained JavaScript (`.mjs`), CSS, and third-party notices
to `dist/`. These are browser assets, not handwritten source. Folio copies them
into `web/public/` during its aggregate build; keep their generated filenames and
resource URLs stable.
