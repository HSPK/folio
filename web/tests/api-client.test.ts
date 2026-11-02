import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient, type ApiClientOptions } from "../frontend/api/client";
import { decodedDocument } from "../frontend/api/contracts";
import { ApiError } from "../frontend/api/error";

const document = {
  id: "01961e0b-9831-7000-8000-000000000001",
  path: "Note.md",
  content: "# Note\n",
  html: null,
  version: "version-1",
};

function client(fetch_fn: NonNullable<ApiClientOptions["fetch_fn"]>, owner = new AbortController()) {
  const resources: unknown[] = [];
  const authentication: ApiError[] = [];
  const api = createApiClient({
    signal: owner.signal,
    fetch_fn,
    context: (path) => ({ path, authenticationGeneration: 7, resourceProject: "project" }),
    onAuthenticationFailure: (error) => authentication.push(error),
    onResources: (payload) => resources.push(payload),
  });
  return { ...api, owner, resources, authentication };
}

test("API responses are decoded before they can update application resource state", async () => {
  const valid = client(async () =>
    Response.json(document, {
      headers: {
        "x-folio-document-permissions": JSON.stringify({ writable: true, collaborative: false, owner: true }),
      },
    }),
  );
  const result = await valid.request("/api/document", { decode: decodedDocument });
  assert.equal(result.content, document.content);
  assert.equal(result.permissions?.owner, true);
  assert.equal(valid.resources.length, 1);
  const invalid = client(async () => Response.json({ ...document, id: "Not a resource identity" }));
  await assert.rejects(() => invalid.request("/api/document", { decode: decodedDocument }), /incomplete document/);
  assert.equal(invalid.resources.length, 0);
});

test("disposed clients reject normal work but can finish keepalive delivery without touching new UI state", async () => {
  const owner = new AbortController();
  let requests = 0;
  const api = client(async () => {
    requests++;
    owner.abort();
    return Response.json(document);
  }, owner);
  await assert.rejects(() => api.request("/api/document", { decode: decodedDocument }), { name: "AbortError" });
  await assert.rejects(() => api.request("/api/document"), { name: "AbortError" });
  await api.request("/api/collaboration/presence", { method: "POST", keepalive: true });
  assert.equal(requests, 2);
  assert.equal(api.resources.length, 0);
});

test("HTTP authentication errors retain the request epoch without turning login failures into global expiration", async () => {
  const api = client(async () => Response.json({ error: "Authentication expired" }, { status: 401 }));
  await assert.rejects(
    () => api.request("/api/document"),
    (error) => error instanceof ApiError && error.authenticationGeneration === 7 && error.status === 401,
  );
  await assert.rejects(() => api.request("/api/auth/login"), /Authentication expired/);
  assert.equal(api.authentication.length, 1);
});

test("malformed permission headers and request deadlines fail explicitly without accepting a payload", async () => {
  const malformed = client(async () =>
    Response.json(document, {
      headers: {
        "x-folio-document-permissions": JSON.stringify({ writable: false, collaborative: true, owner: false }),
      },
    }),
  );
  await assert.rejects(() => malformed.request("/api/document"), /Invalid document permissions/);
  assert.equal(malformed.resources.length, 0);
  const timeout = client(() => new Promise<Response>(() => {}));
  await assert.rejects(
    () => timeout.request("/api/document", { timeoutMs: 5 }),
    (error) => error instanceof ApiError && error.status === 408,
  );
});
