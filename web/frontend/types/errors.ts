export interface RuntimeError extends Error {
  status: number;
  network: boolean;
  authenticationGeneration?: number;
}

/** Preserve native error identity while providing checked request metadata. */
export function errorContext(value: unknown): RuntimeError {
  const error = value instanceof Error ? value : new Error(String(value), { cause: value });
  const status: unknown = Reflect.get(error, "status");
  const network: unknown = Reflect.get(error, "network");
  return Object.assign(error, {
    status: typeof status === "number" ? status : 0,
    network: typeof network === "boolean" ? network : false,
  });
}
