// A small client for the Gameye Session API (api/openapi/client.yaml in core).

export const ENVIRONMENTS = {
  sandbox: "https://api.sandbox-gameye.gameye.net",
  production: "https://api.production-gameye.gameye.net",
};

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOG_BYTES = 256 * 1024;

export class GameyeError extends Error {
  constructor(operation, status, details) {
    super(`${operation} failed${status ? ` with HTTP ${status}` : ""}${details ? `: ${details}` : ""}`);
    this.operation = operation;
    // 0 means the request never got a response.
    this.status = status;
  }
}

// Worth retrying while polling: no response, rate limiting or a server error.
export function isTransient(error) {
  return error instanceof GameyeError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

// The API token goes to whatever api-url names, so only Gameye hosts are allowed unless the
// workflow opts in.
function isGameyeHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "gameye.net" || host.endsWith(".gameye.net");
}

export function resolveOrigin(environment, apiUrl, allowCustomApiUrl = false) {
  if (apiUrl) {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:") throw new Error("api-url must use https.");
    if (!allowCustomApiUrl && !isGameyeHost(url.hostname)) {
      throw new Error(
        `api-url must be a *.gameye.net host (got ${url.hostname}), because the API token is sent to it. ` +
          "Set allow-custom-api-url: true to use another host.",
      );
    }
    return url.origin;
  }
  const origin = ENVIRONMENTS[environment];
  if (!origin) {
    throw new Error(`Unknown environment "${environment}". Use sandbox or production.`);
  }
  return origin;
}

// Gameye error bodies carry a human-readable `details`; never echo anything else.
async function errorDetails(response) {
  try {
    const body = await response.json();
    return typeof body?.details === "string" ? body.details.slice(0, 300).replace(/\.+$/, "") : "";
  } catch {
    return "";
  }
}

export function createClient({ origin, token, fetch = globalThis.fetch }) {
  async function request(operation, method, path, { body, expect }) {
    let response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/plain",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new GameyeError(operation, 0, `could not reach ${origin} (${error.cause?.code ?? error.message})`);
    }
    if (!expect.includes(response.status)) {
      throw new GameyeError(operation, response.status, await errorDetails(response));
    }
    return response;
  }

  const app = (name) => encodeURIComponent(name);

  return {
    async enableTag(application, tag) {
      await request("enable-tag", "POST", `/application/${app(application)}/tags`, {
        body: { tag },
        expect: [204],
      });
    },

    async tagExists(region, application, tag) {
      const path = `/tag/${encodeURIComponent(region)}/${app(application)}/${encodeURIComponent(tag)}`;
      const response = await request("tag-exists", "GET", path, { expect: [200] });
      const body = await response.json();
      return body.exists === true;
    },

    async runSession(body) {
      const response = await request("session-run", "POST", "/session", { body, expect: [201] });
      return response.json();
    },

    // Returns null while the session is not (yet) known to Gameye.
    async describeSession(id) {
      const response = await request("describe-session", "GET", `/session/${encodeURIComponent(id)}`, {
        expect: [200, 404],
      });
      return response.status === 404 ? null : response.json();
    },

    // "stopped" (204), "already-stopped" (409), or "not-found" (404: gone, or not visible yet).
    async stopSession(id) {
      const response = await request("session-stop", "DELETE", `/session/${encodeURIComponent(id)}`, {
        expect: [204, 404, 409],
      });
      return { 204: "stopped", 409: "already-stopped", 404: "not-found" }[response.status];
    },

    async logs(id) {
      const response = await request("stream-logs", "GET", `/logs?id=${encodeURIComponent(id)}&follow=false`, {
        expect: [200],
      });
      const text = await response.text();
      return text.length > MAX_LOG_BYTES ? text.slice(-MAX_LOG_BYTES) : text;
    },
  };
}
