import {
  decodedDraft,
  decodedDraftIdentity,
  type DraftIdentity,
  type DraftKeys,
  type DraftSnapshot,
  type DraftStore,
  type LocalDraft,
} from "../models/drafts";
import { decryptDraft, deriveDraftKeys, draftNonce, encryptDraft } from "../storage/draft-crypto";

export function createDraftWriteQueue() {
  let tail = Promise.resolve();
  return {
    run(operation: () => Promise<void>) {
      const work = tail.then(operation);
      // Callers retain the actual result; only completion is shared across repository lifetimes.
      tail = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
    barrier() {
      return tail;
    },
  };
}

export function createDraftRepository(store: DraftStore, writes = createDraftWriteQueue()) {
  let accepting = true;
  let closing: Promise<void> | null = null;
  const keys = new Map<string, Promise<DraftKeys>>();
  const pending = new Set<Promise<unknown>>();

  function track<T>(operation: () => Promise<T>): Promise<T> {
    if (!accepting) return Promise.reject(new Error("The recovery repository is closed."));
    const work = operation();
    pending.add(work);
    work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  function ordered(operation: () => Promise<void>) {
    return track(() => {
      return writes.run(operation);
    });
  }
  function identityKeys(identity: DraftIdentity) {
    const signature = `${identity.scope}:${identity.secret}`;
    let derived = keys.get(signature);
    if (!derived) {
      derived = deriveDraftKeys(identity);
      keys.set(signature, derived);
      derived.catch(() => {
        if (keys.get(signature) === derived) keys.delete(signature);
      });
    }
    return derived;
  }

  return {
    owner(value: DraftIdentity) {
      if (!accepting) throw new Error("The recovery repository is closed.");
      const identity = decodedDraftIdentity(value);
      const material = identityKeys(identity);
      // Observe early derivation failures even when a write must wait behind another operation.
      const ready = material.then(
        (keys) => ({ keys }),
        (cause) => ({ cause }),
      );
      const getKeys = async () => {
        const result = await ready;
        if ("cause" in result) throw result.cause;
        return result.keys;
      };
      return {
        persist(value: DraftSnapshot, retire: { readonly key: string; readonly generation: string } | null = null) {
          const snapshot = decodedDraft(value);
          const previous = retire ? Object.freeze({ ...retire }) : null;
          return ordered(async () => {
            const keys = await getKeys();
            const key = await keys.identify(`${snapshot.project}\0${snapshot.document}\0${snapshot.tab}`);
            if (!snapshot.keep) await store.remove(key, keys.owner);
            else {
              const document = await keys.identify(`${snapshot.project}\0${snapshot.document}`);
              const encrypted = await encryptDraft(keys, snapshot, key);
              await store.put({
                ...encrypted,
                key,
                document,
                owner: keys.owner,
                updated: Date.now(),
                generation: draftNonce(),
              });
            }
            if (previous) await store.remove(previous.key, keys.owner, previous.generation);
          });
        },
        discard(value: DraftSnapshot) {
          const snapshot = decodedDraft(value);
          return ordered(async () => {
            const keys = await getKeys();
            const key = await keys.identify(`${snapshot.project}\0${snapshot.document}\0${snapshot.tab}`);
            await store.remove(key, keys.owner);
          });
        },
        remove(key: string, generation: string | null = null) {
          return ordered(async () => store.remove(key, (await getKeys()).owner, generation));
        },
        list() {
          const before = writes.barrier();
          return track(async () => {
            await before;
            const keys = await getKeys();
            const records = await store.byOwner(keys.owner);
            records.sort((a, b) => b.updated - a.updated);
            return Promise.all(records.map((record) => decryptDraft(keys, record)));
          });
        },
        forDocument(project: string | null, id: string): Promise<LocalDraft | null> {
          const before = writes.barrier();
          return track(async () => {
            await before;
            const keys = await getKeys();
            const records = await store.byDocument(await keys.identify(`${project}\0${id}`));
            records.sort((a, b) => b.updated - a.updated);
            for (const record of records) {
              if (record.owner !== keys.owner) continue;
              const draft = await decryptDraft(keys, record);
              if (draft.project === project && draft.document === id) return draft;
            }
            return null;
          });
        },
      };
    },
    close() {
      if (closing) return closing;
      accepting = false;
      closing = (async () => {
        const settled = await Promise.allSettled([...pending]);
        keys.clear();
        await store.close();
        const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Accepted recovery operations could not finish.",
          );
      })();
      return closing;
    },
  };
}

export type DraftRepository = ReturnType<typeof createDraftRepository>;
export type DraftOwner = ReturnType<DraftRepository["owner"]>;
