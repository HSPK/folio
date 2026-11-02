import {
  createApiClient,
  type ApiClientOptions,
  type ApiOptions,
  type DecodedApiOptions,
  type Decoder,
} from "../../api/client";

let client: ReturnType<typeof createApiClient> | undefined;

/** Keep existing controller call sites on the client constructed by the composition root. */
export function configureApiClient(options: ApiClientOptions) {
  if (client) throw new Error("The application API client is already configured.");
  const instance = createApiClient(options);
  client = instance;
  return () => {
    if (client === instance) client = undefined;
  };
}

export function api<T>(path: string, options: DecodedApiOptions<T>): Promise<T>;
export function api(path: string, options?: ApiOptions): Promise<unknown>;
export function api(path: string, options?: ApiOptions & { decode?: Decoder<unknown> }): Promise<unknown> {
  if (!client) return Promise.reject(new DOMException("The application API is no longer active.", "AbortError"));
  return client.request(path, options);
}
