const { ethers } = require("ethers");
const { badRequest } = require("./errors");

/** Returns the lower-cased address or throws 400. */
function requireAddress(value, field) {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw badRequest(`${field} must be a valid Ethereum address`);
  }
  return value.toLowerCase();
}

function optionalAddress(value, field) {
  return value === undefined || value === "" ? undefined : requireAddress(value, field);
}

function intParam(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${field} is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} must be an integer in [${min}, ${max}]`);
  return n;
}

function oneOf(value, field, allowed) {
  if (value === undefined || value === "") return undefined;
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(", ")}`);
  return value;
}

/** Optional string with max length; trims; returns null when empty. */
function text(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  const t = value.trim();
  if (t.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return t || null;
}

function paging(query) {
  const page = intParam(query.page, "page", { min: 1, max: 10_000, fallback: 1 });
  const pageSize = intParam(query.pageSize, "pageSize", { min: 1, max: 100, fallback: 20 });
  return { page, pageSize, offset: (page - 1) * pageSize };
}

module.exports = { requireAddress, optionalAddress, intParam, oneOf, text, paging };
