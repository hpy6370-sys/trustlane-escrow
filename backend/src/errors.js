/** Error with an HTTP status and a stable machine-readable code. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, "BAD_REQUEST", message, details);
const unauthorized = (message = "Authentication required") => new AppError(401, "UNAUTHORIZED", message);
const forbidden = (message = "Insufficient role") => new AppError(403, "FORBIDDEN", message);
const notFound = (message = "Not found") => new AppError(404, "NOT_FOUND", message);

function notFoundHandler(req, _res, next) {
  next(notFound(`No route for ${req.method} ${req.path}`));
}

/** Single place that turns any thrown error into a JSON response. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let code = err.code;
  let message = err.message;

  if (err.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Request body is not valid JSON";
  } else if (err.type === "entity.too.large") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
  } else if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    status = 401;
    code = "INVALID_TOKEN";
    message = err.name === "TokenExpiredError" ? "Session expired, sign in again" : "Invalid session token";
  } else if (typeof code === "string" && code.startsWith("SQLITE_")) {
    status = code === "SQLITE_CONSTRAINT_UNIQUE" ? 409 : 500;
    code = status === 409 ? "CONFLICT" : "DATABASE_ERROR";
    message = status === 409 ? "Resource already exists" : "Database error";
  }

  if (!(err instanceof AppError) && status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    message = "Internal server error"; // never leak internals
    code = code === "DATABASE_ERROR" ? code : "INTERNAL";
  }

  res.status(status).json({ error: { code: code || "ERROR", message, ...(err.details ? { details: err.details } : {}) } });
}

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, notFoundHandler, errorHandler };
