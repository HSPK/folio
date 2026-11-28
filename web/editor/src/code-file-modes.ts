import type { StreamParser } from "@codemirror/language";
import { csharp, dart, java, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { css, sCSS } from "@codemirror/legacy-modes/mode/css";
import { go } from "@codemirror/legacy-modes/mode/go";
import { json } from "@codemirror/legacy-modes/mode/javascript";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { python } from "@codemirror/legacy-modes/mode/python";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { html, xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

// Tag syntax is a useful fallback for Vue/Svelte without embedding component runtimes.
const modes: Record<string, StreamParser<unknown>> = {
  py: python,
  css,
  scss: sCSS,
  html,
  htm: html,
  vue: html,
  svelte: html,
  go,
  java,
  kt: kotlin,
  kts: kotlin,
  swift,
  cs: csharp,
  rb: ruby,
  r,
  sql: standardSQL,
  sh: shell,
  bash: shell,
  ps1: powerShell,
  lua,
  scala,
  dart,
  json,
  toml,
  xml,
  yaml,
  yml: yaml,
};

export function codeFileMode(ext: string) {
  return Object.hasOwn(modes, ext) ? modes[ext] : undefined;
}
