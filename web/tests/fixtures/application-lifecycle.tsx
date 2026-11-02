import { render } from "solid-js/web";
import { App } from "../../frontend/App";
import { createInlineEditor } from "@folio/editor-runtime";
import { createIndexedDbDraftStore } from "../../frontend/storage/draft-indexeddb";
import { deriveDraftKeys, draftNonce, encryptDraft } from "../../frontend/storage/draft-crypto";
import { createDraftRepository } from "../../frontend/services/draft-repository";

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;
const observers = new Set<object>();
const observerDetails = new Map<object, string>();
function observe(owner: object, target: Node) {
  observers.add(owner);
  observerDetails.set(
    owner,
    new Error(`${target.nodeName} ${target instanceof Element ? target.id + " " + String(target.className) : ""}`)
      .stack ?? "",
  );
}
function disconnected(owner: object) {
  observers.delete(owner);
  observerDetails.delete(owner);
}
const NativeResizeObserver = window.ResizeObserver;
const NativeMutationObserver = window.MutationObserver;

function trackObservers() {
  window.ResizeObserver = class extends NativeResizeObserver {
    readonly #targets = new Set<Element>();
    override observe(target: Element, options?: ResizeObserverOptions) {
      super.observe(target, options);
      this.#targets.add(target);
      observe(this, target);
    }
    override unobserve(target: Element) {
      super.unobserve(target);
      this.#targets.delete(target);
      if (!this.#targets.size) disconnected(this);
    }
    override disconnect() {
      super.disconnect();
      this.#targets.clear();
      disconnected(this);
    }
  };
  window.MutationObserver = class extends NativeMutationObserver {
    override observe(target: Node, options?: MutationObserverInit) {
      super.observe(target, options);
      observe(this, target);
    }
    override disconnect() {
      super.disconnect();
      disconnected(this);
    }
  };
}

function counts() {
  return {
    toolbars: document.querySelectorAll(".folio-node-toolbar").length,
    dialogs: document.querySelectorAll(".folio-link-dialog, .folio-image-preview").length,
    menus: document.querySelectorAll(".folio-slash-menu").length,
    notices: document.querySelectorAll("#status-notices").length,
  };
}

function unmount() {
  dispose?.();
  dispose = undefined;
  host?.remove();
  host = undefined;
}

function mount(failAfterBootstrap = false) {
  unmount();
  host = document.createElement("div");
  host.id = "folio-root";
  document.body.append(host);
  dispose = render(() => <App />, host);
  if (failAfterBootstrap) host.querySelector("#search-dialog")?.remove();
}

async function editors() {
  const root = document.createElement("div");
  root.style.height = "300px";
  document.body.append(root);
  const options = {
    root,
    onChange() {},
    onLink() {},
    onFallback(message: string) {
      throw new Error(message);
    },
  };
  const first = createInlineEditor(options);
  await first.load("# Original\n\nBody.\n", "first.md");
  first.clear();
  const afterClear = counts();
  await first.load("# Reused\n", "first.md");
  first.destroy();
  first.destroy();
  const second = createInlineEditor(options);
  await second.load("# Fresh\n", "second.md");
  first.clear();
  first.setReadOnly(true);
  const freshSource = second.getSource();
  const editable = root.querySelector(".ProseMirror")?.getAttribute("contenteditable");
  second.destroy();
  let closed = false;
  const pending = createInlineEditor({
    ...options,
    transformUrl(url) {
      if (closed) throw new Error("A disposed editor requested its old host.");
      return url;
    },
  });
  const opening = pending.load("# Disposed while opening\n\n![Image](local.png)\n", "pending.md");
  closed = true;
  pending.destroy();
  await opening;
  const ResizeObserver = window.ResizeObserver;
  let created = 0;
  window.ResizeObserver = class extends ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      if (++created === 2) throw new Error("Injected observer failure");
      super(callback);
    }
  };
  let failure = "";
  try {
    createInlineEditor(options);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    window.ResizeObserver = ResizeObserver;
    root.remove();
  }
  return { afterClear, freshSource, editable, failure, afterDestroy: counts(), observers: observers.size };
}

async function draftStorage() {
  const nativeOpen = indexedDB.open;
  let opened = 0;
  let closed = 0;
  let versionChanges = 0;
  indexedDB.open = (name, version) => {
    const request =
      version === undefined ? nativeOpen.call(indexedDB, name) : nativeOpen.call(indexedDB, name, version);
    request.addEventListener("success", () => {
      opened++;
      const database = request.result;
      const close = database.close.bind(database);
      let disposed = false;
      database.close = () => {
        if (!disposed) {
          disposed = true;
          closed++;
        }
        close();
      };
    });
    return request;
  };
  const createStore = () =>
    createIndexedDbDraftStore({
      onBlocked() {
        throw new Error("The isolated recovery store was unexpectedly blocked.");
      },
      onVersionChange() {
        versionChanges++;
      },
    });
  try {
    const identity = { scope: "storage-fixture", secret: "01".repeat(32) };
    const snapshot = {
      keep: true,
      project: "notes",
      document: "01961e0b-9831-7000-8000-000000000001",
      path: "Stored.md",
      source: "# Durable after close\n",
      version: "initial",
      room: null,
      updates: "",
      unmerged: false,
      selection: null,
      tab: "storage-fixture",
    };
    const keys = await deriveDraftKeys(identity);
    const key = await keys.identify(`${snapshot.project}\0${snapshot.document}\0${snapshot.tab}`);
    const record = {
      ...(await encryptDraft(keys, snapshot, key)),
      key,
      document: await keys.identify(`${snapshot.project}\0${snapshot.document}`),
      owner: keys.owner,
      updated: Date.now(),
      generation: draftNonce(),
    };
    const store = createStore();
    const writing = store.put(record);
    const closing = store.close();
    await Promise.all([writing, closing]);
    let terminal = false;
    try {
      await store.put(record);
    } catch (cause) {
      terminal = cause instanceof Error && cause.message.includes("closed");
    }
    const repository = createDraftRepository(createStore());
    const recovered = await repository.owner(identity).forDocument(snapshot.project, snapshot.document);
    const upgraded = indexedDB.open("folio-private-drafts", 2);
    await new Promise<void>((resolve, reject) => {
      upgraded.onerror = () => reject(upgraded.error);
      upgraded.onblocked = () => reject(new Error("An owned recovery connection blocked its schema upgrade."));
      upgraded.onsuccess = () => {
        upgraded.result.close();
        resolve();
      };
    });
    await repository.close();
    return { source: recovered?.source, opened, closed, versionChanges, terminal };
  } finally {
    indexedDB.open = nativeOpen;
  }
}

const fixture = {
  mount,
  unmount,
  counts,
  editors,
  trackObservers,
  draftStorage,
  observers: () => observers.size,
  observerDetails: () => [...observerDetails.values()],
};

declare global {
  interface Window {
    applicationLifecycle: typeof fixture;
  }
}

window.applicationLifecycle = fixture;
