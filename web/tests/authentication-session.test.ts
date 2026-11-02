import test from "node:test";
import assert from "node:assert/strict";
import { createAuthenticationSession } from "../frontend/state/authentication";

const alice = { username: "alice", role: "user", id: "alice-id", scope: "service-one" } as const;

test("credential changes cancel old account requests before accepting new credentials without changing draft ownership", () => {
  const session = createAuthenticationSession();
  session.initialize("users", alice);
  const previous = session.scope;
  const attempt = session.beginAuthentication();
  assert.equal(previous.signal.aborted, true);
  assert.equal(attempt.signal.aborted, true);
  assert.equal(session.user?.id, alice.id);
  assert.equal(session.scope.principal, previous.principal);
  session.authenticate(alice);
  assert.equal(session.scope.signal.aborted, false);
  assert.equal(session.scope.principal, previous.principal);
  assert.notEqual(session.scope.key, previous.key);
  assert.equal(session.isCurrent(previous), false);
});

test("stale authorization failures cannot expire renewed credentials and principals include service scope", () => {
  const session = createAuthenticationSession();
  session.initialize("users", alice);
  const previous = session.scope;
  assert.equal(session.expire(previous.generation), true);
  assert.equal(session.expire(), false);
  session.authenticate(alice);
  assert.equal(session.expire(previous.generation), false);
  assert.equal(session.expired, false);
  assert.equal(session.sameAccount({ ...alice, scope: "another-service" }), false);
  assert.equal(session.sameAccount({ ...alice, id: "another-account" }), false);
  assert.equal(session.sameAccount({ ...alice, username: "renamed" }), true);
});

test("reset and public access discard account ownership and never reuse request scopes", () => {
  const session = createAuthenticationSession();
  session.initialize("users", alice);
  const first = session.scope;
  session.reset();
  assert.equal(first.signal.aborted, true);
  assert.equal(session.user, null);
  assert.equal(session.scope.principal, null);
  session.initialize("public");
  assert.equal(session.mode, "public");
  session.initialize("users", alice);
  assert.notEqual(session.scope.key, first.key);
  assert.equal(Object.isFrozen(session.user), true);
});
