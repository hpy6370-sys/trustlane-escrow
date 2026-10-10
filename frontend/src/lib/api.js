import { API_URL } from "../config";

const TOKEN_KEY = "trustlane.jwt";

export const session = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (t) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** fetch wrapper: JSON in/out, bearer token, 8 s timeout, uniform errors. */
export async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "content-type": "application/json" };
  const token = session.get();
  if (token && (auth || method !== "GET")) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new ApiError(0, "NETWORK", err.name === "TimeoutError" ? "API timed out" : "API unreachable");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) session.clear();
    throw new ApiError(res.status, data.error?.code || "ERROR", data.error?.message || res.statusText);
  }
  return data;
}

const qs = (o) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== null)).toString();

export const Api = {
  health: () => api("/api/health"),
  stats: (days = 30) => api(`/api/stats?days=${days}`),
  escrows: (q = {}) => api(`/api/escrows?${qs(q)}`),
  escrow: (id) => api(`/api/escrows/${id}`),
  events: (q = {}) => api(`/api/events?${qs(q)}`),
  eventNames: () => api("/api/events/names"),
  user: (a) => api(`/api/users/${a}`),
  updateProfile: (body) => api("/api/users/me", { method: "PUT", body }),
  createDocument: (body) => api("/api/documents", { method: "POST", body }),
  disputes: (q = {}) => api(`/api/disputes?${qs(q)}`),
  assigned: () => api("/api/disputes/assigned", { auth: true }),
  adminOverview: () => api("/api/admin/overview", { auth: true }),
  arbiters: () => api("/api/admin/arbiters", { auth: true }),
  me: () => api("/api/auth/me", { auth: true }),
  nonce: (address) => api(`/api/auth/nonce?address=${address}`),
  verify: (address, signature) => api("/api/auth/verify", { method: "POST", body: { address, signature } }),
};
