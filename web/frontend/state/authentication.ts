import {
  accountIdentity,
  type AccountScope,
  type AuthenticationMode,
  type UserIdentity,
} from "../models/authentication";

export function createAuthenticationSession() {
  let mode: AuthenticationMode = null;
  let user: UserIdentity | null = null;
  let expired = false;
  let generation = 0;
  let controller = new AbortController();
  let scope: AccountScope = Object.freeze({
    key: Symbol("account-scope"),
    principal: null,
    generation,
    signal: controller.signal,
  });
  const listeners = new Set<() => void>();

  function advance(blocked = false) {
    const previous = controller;
    controller = new AbortController();
    generation++;
    if (blocked) controller.abort();
    scope = Object.freeze({
      key: Symbol("account-scope"),
      principal: mode === "users" ? accountIdentity(user) : null,
      generation,
      signal: controller.signal,
    });
    previous.abort();
    for (const listener of listeners) listener();
    return scope;
  }

  return {
    get mode() {
      return mode;
    },
    get user() {
      return user;
    },
    get generation() {
      return generation;
    },
    get expired() {
      return expired;
    },
    get scope() {
      return scope;
    },
    isCurrent(candidate: AccountScope) {
      return candidate.key === scope.key && !candidate.signal.aborted;
    },
    sameAccount(next: UserIdentity) {
      return accountIdentity(user) === accountIdentity(next);
    },
    initialize(nextMode: AuthenticationMode, nextUser: UserIdentity | null = null) {
      mode = nextMode;
      user = nextUser ? Object.freeze({ ...nextUser }) : null;
      expired = false;
      advance(mode === "users" && !user);
    },
    beginAuthentication() {
      return advance(true);
    },
    authenticate(next: UserIdentity) {
      mode = "users";
      user = Object.freeze({ ...next });
      expired = false;
      advance();
    },
    expire(expectedGeneration = generation) {
      if (mode !== "users" || expired || expectedGeneration !== generation) return false;
      expired = true;
      advance(true);
      return true;
    },
    reset() {
      mode = null;
      user = null;
      expired = false;
      advance();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const authenticationSession = createAuthenticationSession();
