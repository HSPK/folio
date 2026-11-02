import { decodedEncryptedDraft, type DraftStore, type EncryptedDraft } from "../models/drafts";

interface DraftStorageOptions {
  factory?: IDBFactory;
  onBlocked: () => void;
  onVersionChange: () => void;
}

export function createIndexedDbDraftStore({
  factory: suppliedFactory,
  onBlocked,
  onVersionChange,
}: DraftStorageOptions): DraftStore {
  let connection: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  let closing: Promise<void> | null = null;
  let stopped = false;
  const pending = new Set<Promise<unknown>>();

  function open() {
    const factory = suppliedFactory ?? globalThis.indexedDB;
    if (!factory) return Promise.reject(new Error("This browser cannot open local recovery storage."));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("folio-private-drafts", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("drafts", { keyPath: "key" });
        store.createIndex("document", "document");
        store.createIndex("owner", "owner");
      };
      request.onsuccess = () => {
        const database = request.result;
        connection = database;
        database.onversionchange = () => {
          database.close();
          if (connection === database) {
            connection = null;
            opening = null;
          }
          onVersionChange();
        };
        resolve(database);
      };
      request.onerror = () => {
        opening = null;
        reject(request.error ?? new Error("Local recovery storage could not open."));
      };
      request.onblocked = onBlocked;
    });
    return opening;
  }

  function transact<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, accept: (read: () => T) => void) => void,
  ): Promise<T> {
    if (stopped) return Promise.reject(new Error("Local recovery storage is closed."));
    const work = (async () => {
      const database = await open();
      return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction("drafts", mode);
        let result: { value: T } | null = null;
        let failure: unknown;
        transaction.oncomplete = () => {
          if (!result) reject(new Error("The recovery transaction returned no result."));
          else resolve(result.value);
        };
        transaction.onabort = () =>
          reject(failure ?? transaction.error ?? new Error("Recovery storage was interrupted."));
        transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Recovery storage failed."));
        const accept = (read: () => T) => {
          try {
            result = { value: read() };
          } catch (cause) {
            failure = cause;
            transaction.abort();
          }
        };
        try {
          operation(transaction.objectStore("drafts"), accept);
        } catch (cause) {
          failure = cause;
          transaction.abort();
        }
      });
    })();
    pending.add(work);
    work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }

  function readAll(index: string, key: string) {
    return transact("readonly", (store, accept: (read: () => EncryptedDraft[]) => void) => {
      const request = store.index(index).getAll(key);
      request.onsuccess = () =>
        accept(() => {
          const rows: unknown = request.result;
          if (!Array.isArray(rows)) throw new Error("Recovery storage returned an invalid record list.");
          return rows.map(decodedEncryptedDraft);
        });
    });
  }

  return {
    byOwner: (owner) => readAll("owner", owner),
    byDocument: (document) => readAll("document", document),
    put(record) {
      return transact<void>("readwrite", (store, accept) => {
        const request = store.put(record);
        request.onsuccess = () => accept(() => undefined);
      });
    },
    remove(key, owner, generation = null) {
      return transact<void>("readwrite", (store, accept) => {
        const request = store.get(key);
        request.onsuccess = () =>
          accept(() => {
            const value: unknown = request.result;
            if (value === undefined) return;
            const row = decodedEncryptedDraft(value);
            if (row.owner !== owner) throw new Error("This recovery copy belongs to a different account.");
            if (!generation || row.generation === generation) store.delete(key);
          });
      });
    },
    close() {
      if (closing) return closing;
      stopped = true;
      closing = (async () => {
        const settled = await Promise.allSettled([...pending]);
        connection?.close();
        connection = null;
        opening = null;
        const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Recovery storage did not finish cleanly.",
          );
      })();
      return closing;
    },
  };
}
