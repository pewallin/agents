// What the view shows of an error: the message, and the code and data an agent sent with it.
/** An error's message, with the JSON-RPC code and data an agent sent with it. */
export function errorDetail(reason: unknown): { message: string; data?: string } {
  if (reason && typeof reason === "object") {
    const { message, code, data } = reason as { message?: unknown; code?: unknown; data?: unknown };
    const text = typeof message === "string" && message ? message : String(reason);
    const withCode = typeof code === "number" ? `${text} (${code})` : text;
    if (data === undefined || data === null) return { message: withCode };
    return { message: withCode, data: typeof data === "string" ? data : JSON.stringify(data, null, 2) };
  }
  return { message: String(reason) };
}
