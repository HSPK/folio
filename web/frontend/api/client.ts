import { isRecord } from "../types/guards";
import { validatedDocumentPermissions } from "./contracts";
import { ApiError, isAbortError } from "./error";

export interface ApiOptions {
  timeoutMs?: number;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  keepalive?: boolean;
}
export type Decoder<T> = (payload: unknown) => T;
export type DecodedApiOptions<T> = ApiOptions & { decode: Decoder<T> };
type RequestOptions = ApiOptions & { decode?: Decoder<unknown> };

export interface RequestContext {
  path: string;
  authenticationGeneration: number;
  resourceProject: string;
}

export interface ApiClientOptions {
  signal: AbortSignal;
  context: (path: string, headers: Record<string, string>) => RequestContext;
  onAuthenticationFailure: (error: ApiError) => void;
  onResources: (payload: unknown, project: string) => void;
  fetch_fn?: (path: string, options: RequestInit) => Promise<Response>;
}

/** Transport owns cancellation and protocol errors; application policy is explicitly injected. */
export function createApiClient({
  signal: owner,
  context,
  onAuthenticationFailure,
  onResources,
  fetch_fn = fetch,
}: ApiClientOptions) {
  async function send(
    path: string,
    { method = "GET", body, signal, keepalive = false, decode }: RequestOptions,
  ): Promise<unknown> {
    if (!keepalive) owner.throwIfAborted();
    signal = keepalive ? signal : signal ? AbortSignal.any([signal, owner]) : owner;
    const authEndpoint = path.startsWith("/api/auth/");
    const headers: Record<string, string> = { Accept: "application/json" };
    const binary = body instanceof Blob;
    if (body !== undefined) headers["Content-Type"] = binary ? body.type : "application/json";
    const request = context(path, headers);
    const encoded = body === undefined ? undefined : binary ? body : JSON.stringify(body);
    let response: Response;
    try {
      response = await fetch_fn(request.path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal,
        keepalive,
        ...(encoded !== undefined ? { body: encoded } : {}),
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new ApiError("The local Folio service could not be reached.", 0, true);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new ApiError(`The service returned an unreadable response (HTTP ${response.status}).`, response.status);
    }
    if (signal?.aborted) throw new DOMException("The request was canceled.", "AbortError");
    if (!response.ok) {
      const error = new ApiError(
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `The request failed (HTTP ${response.status}).`,
        response.status,
      );
      error.authenticationGeneration = request.authenticationGeneration;
      if (!authEndpoint && !owner.aborted) onAuthenticationFailure(error);
      throw error;
    }
    if (owner.aborted) return decode ? decode(payload) : payload;
    const permissions = response.headers.get("x-folio-document-permissions");
    if (permissions) {
      try {
        if (!isRecord(payload)) throw new ApiError("A document response must be an object.");
        const value: unknown = JSON.parse(permissions);
        payload = { ...payload, permissions: validatedDocumentPermissions(value) };
      } catch (error) {
        throw new ApiError(
          `Invalid document permissions: ${error instanceof Error ? error.message : String(error)}`,
          response.status,
        );
      }
    }
    const result = decode ? decode(payload) : payload;
    onResources(payload, request.resourceProject);
    return result;
  }

  function request<T>(path: string, options: DecodedApiOptions<T>): Promise<T>;
  function request(path: string, options?: ApiOptions): Promise<unknown>;
  async function request(path: string, { timeoutMs = 0, ...options }: RequestOptions = {}): Promise<unknown> {
    if (!timeoutMs) return send(path, options);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ApiError("The local Folio request timed out.", 408));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([send(path, { ...options, signal: controller.signal }), deadline]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  return Object.freeze({ request });
}
