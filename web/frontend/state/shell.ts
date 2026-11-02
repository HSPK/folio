import { createStore } from "solid-js/store";

export type DocumentView = "rich" | "editor" | "split" | "preview";

interface ShellState {
  title: string;
  view: DocumentView;
  modified: boolean;
  hasDocument: boolean;
  sidebarOpen: boolean;
  compact: boolean;
  statistics: string;
  statisticsDetail: string;
}

export const viewLabels: Record<DocumentView, string> = {
  rich: "Live",
  editor: "Source",
  split: "Compare",
  preview: "Read",
};

const [shell, setShell] = createStore<ShellState>({
  title: "Select a note",
  view: "rich",
  modified: false,
  hasDocument: false,
  sidebarOpen: true,
  compact: false,
  statistics: "",
  statisticsDetail: "",
});

export { shell };

/** Validate views at the DOM/controller boundary. */
export function isDocumentView(value: unknown): value is DocumentView {
  return typeof value === "string" && Object.hasOwn(viewLabels, value);
}

/** Publish chrome metadata without placing document bodies or editor instances in the store. */
export function updateShell(patch: Partial<ShellState>) {
  setShell(patch);
}
