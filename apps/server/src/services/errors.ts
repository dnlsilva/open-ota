export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = "Authentication required") {
    return new ApiError(401, "unauthorized", message);
  }
  static forbidden(message = "You do not have access to this resource") {
    return new ApiError(403, "forbidden", message);
  }
  static notFound(code: string, message: string) {
    return new ApiError(404, code, message);
  }
  static conflict(code: string, message: string) {
    return new ApiError(409, code, message);
  }
  static quotaExceeded(message: string, details?: unknown) {
    return new ApiError(402, "quota_exceeded", message, details);
  }
  static tooManyRequests(message = "Slow down") {
    return new ApiError(429, "rate_limited", message);
  }
}
