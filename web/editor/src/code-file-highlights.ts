import { DocInput } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { PartialParse, Tree, ChangedRange } from "@lezer/common";
import type { codeFileParser } from "./code-syntax.ts";

const paint = StateEffect.define<DecorationSet>();
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    return tr.effects.find((effect) => effect.is(paint))?.value ?? set.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Parse up to the viewport in short slices, retaining unchanged Lezer fragments between edits. */
export function parsedHighlights(parser: NonNullable<ReturnType<typeof codeFileParser>>) {
  return [
    marks,
    ViewPlugin.define((view) => {
      let tree: Tree | undefined,
        parse: PartialParse | undefined,
        target = 0,
        parsed = -1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        timer ??= setTimeout(work, 0);
      };
      function work() {
        timer = undefined;
        const { doc } = view.state;
        const ranges = view.visibleRanges;
        const end = ranges.at(-1)?.to ?? 0;
        if (parsed < end) {
          if (!parse) {
            target = Math.min(doc.length, end + 1024);
            parse = parser.start(new DocInput(doc), target);
          }
          const until = performance.now() + 5;
          do {
            const result = parse.advance();
            if (result) {
              tree = result;
              parser.remember(tree, target < doc.length);
              parsed = target;
              parse = undefined;
              break;
            }
          } while (performance.now() < until);
          if (parsed < end) return schedule();
        }
        const builder = new RangeSetBuilder<Decoration>();
        if (tree)
          for (const { from, to } of ranges) {
            parser.tokens(tree, from, to, (a, b, cls) => builder.add(a, b, Decoration.mark({ class: cls })));
          }
        view.dispatch({ effects: paint.of(builder.finish()) });
      }
      schedule();
      return {
        update(update: ViewUpdate) {
          if (update.docChanged) {
            const ranges: ChangedRange[] = [];
            update.changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
            parser.changed(ranges);
            tree = parse = undefined;
            parsed = -1;
          }
          if (update.docChanged || update.viewportChanged) schedule();
        },
        destroy() {
          clearTimeout(timer);
        },
      };
    }),
  ];
}
