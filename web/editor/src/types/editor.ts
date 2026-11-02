import type { Editor } from "@milkdown/core";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import type { Root } from "mdast";
import type { JSONRecord } from "@milkdown/transformer";

export interface TextSelectionRange {
  from: number;
  to: number;
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface CursorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Heading {
  id: string;
  text: string;
  level: number;
  from: number;
}

export interface SourcePosition {
  source: number;
  position: number;
}

export interface ChangedRange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export interface SourceChanges {
  ranges: ChangedRange[];
  beforeLength: number;
  afterLength: number;
}

export interface PlainBody {
  hasMetadata: false;
  prefix: string;
  body: string;
  bodyStart: number;
}

export interface MetadataBody {
  hasMetadata: true;
  prefix: string;
  body: string;
  bodyStart: number;
  opening: string;
  raw: string;
  suffix: string;
  lineEnding: string;
  metadataStart: number;
  metadataEnd: number;
}

export type FrontMatterParts = PlainBody | MetadataBody;
export type NoticeKind = "" | "error" | "warning" | "success";
export type MarkdownUrl = (url: string, documentPath?: string) => string | null;
export type GetPosition = () => number | undefined;

export interface NodeActivity {
  active_fn: () => boolean;
  editable_fn: () => boolean;
}

export interface Destroyable {
  destroy(): void;
}

export interface ScrollbarHandle extends Destroyable {
  update(): void;
}

export interface DeferredScrollbars extends Destroyable {
  attach(options: { host: HTMLElement; viewport: HTMLElement }): Destroyable;
}

export interface OutlineExtractor {
  extract(source: string, changes?: SourceChanges | null): Heading[];
  clear(): void;
}

export interface WikiDocument {
  path: string;
  name?: string;
  title?: string | null;
}

export interface InlineEditorOptions {
  root: HTMLElement;
  onChange: (source: string) => void;
  onFallback: (message: string) => void;
  onLink: (url: string) => void;
  onReady?: () => void;
  onOutline?: (items: Heading[]) => void;
  onSelection?: (position: CursorPosition) => void;
  onHeadingSelection?: (id: string | null) => void;
  onTitle?: (title: string | null) => void;
  onTag?: (tag: string) => void;
  onNotice?: (message: string, kind?: NoticeKind, source?: string) => void;
  onImageUpload?: (image: File) => Promise<string>;
  canCreateLink?: (path: string) => boolean;
  onCreateLink?: (path: string) => void | Promise<unknown>;
  styleNonce?: string;
  trackSelection?: () => boolean;
  trackOutline?: () => boolean;
  wikiDocuments?: () => WikiDocument[];
  transformUrl?: MarkdownUrl;
  outlineExtractor?: OutlineExtractor;
}

export interface TagEditor {
  render(values: string[]): void;
  setReadOnly(value: boolean): void;
}

export interface MetadataEditor {
  details: HTMLDetailsElement;
  advanced: HTMLDetailsElement;
  textarea: HTMLTextAreaElement;
  tags: TagEditor;
  fields: Map<string, HTMLInputElement>;
  navigation?: TextSelectionRange | null;
}

export interface BodySerializer {
  reset(document: ProseNode, source: string, tree?: Root): void;
  serialize(document: ProseNode): string;
}

export interface EditorSession {
  ticket: number;
  path: string;
  parts: FrontMatterParts;
  originalBody: string;
  bodySource: string;
  bodyAst: Root;
  bodyAstSource: string;
  ready: boolean;
  editor: Editor | null;
  view: EditorView | null;
  outlineSignature: string;
  scrollbars: Destroyable[];
  metadata?: MetadataEditor;
  refreshMetadata?: () => void;
  initialDoc?: ProseNode;
  bodySerializer?: BodySerializer;
  mapDocument?: ProseNode;
  mapSource?: string;
  map?: SourcePosition[];
}

export interface ReadyEditorSession extends EditorSession {
  ready: true;
  editor: Editor;
  view: EditorView;
  initialDoc: ProseNode;
  bodySerializer: BodySerializer;
}

export interface SourceEditorOptions {
  textarea: HTMLTextAreaElement;
  nonce?: string;
  threshold?: number;
  onNotice?: (message: string) => void;
}

export interface Appearance {
  theme: "system" | "light" | "dark";
  latinFont: string;
  cjkFont: string;
}

export type ProseNodeJSON = {
  type: string;
  attrs?: JSONRecord;
  content?: ProseNodeJSON[];
  text?: string;
  marks?: { type: string; attrs?: JSONRecord }[];
};

export interface CachedBody {
  tree: Root;
  model: string;
  documentJSON: ProseNodeJSON;
  serialized: string;
  serializedTree: Root;
}
