export class ApiError extends Error {
  authenticationGeneration?: number;
  constructor(
    message: string,
    public readonly status = 0,
    public readonly network = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isAbortError(error: unknown) {
  return error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
}
