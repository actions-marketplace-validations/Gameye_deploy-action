import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, GameyeError, isTransient, resolveOrigin } from "../src/gameye.mjs";

function fakeFetch(responses) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, ...init });
    const { status = 200, json, text } = responses.shift();
    return new Response(json !== undefined ? JSON.stringify(json) : text ?? null, { status });
  };
  return { fetch, requests };
}

const origin = "https://api.example.test";

test("sends the bearer token and JSON body, and refuses redirects", async () => {
  const f = fakeFetch([{ status: 204 }]);
  await createClient({ origin, token: "secret", fetch: f.fetch }).enableTag("my game", "v1");
  const [r] = f.requests;
  assert.equal(r.url, `${origin}/application/my%20game/tags`);
  assert.equal(r.method, "POST");
  assert.equal(r.headers.Authorization, "Bearer secret");
  assert.equal(r.redirect, "error");
  assert.deepEqual(JSON.parse(r.body), { tag: "v1" });
});

test("errors carry only the API's details text, never the token", async () => {
  const f = fakeFetch([{ status: 403, json: { details: "missing scope", secretish: "nope" } }]);
  const client = createClient({ origin, token: "secret", fetch: f.fetch });
  await assert.rejects(client.enableTag("a", "b"), (e) => {
    assert.ok(e instanceof GameyeError);
    assert.equal(e.status, 403);
    assert.match(e.message, /missing scope/);
    assert.doesNotMatch(e.message, /nope|secret/);
    return true;
  });
});

test("tagExists reads the exists flag", async () => {
  const f = fakeFetch([{ json: { exists: false } }, { json: { exists: true } }]);
  const client = createClient({ origin, token: "t", fetch: f.fetch });
  assert.equal(await client.tagExists("europe", "app", "v1"), false);
  assert.equal(await client.tagExists("europe", "app", "v1"), true);
  assert.equal(f.requests[0].url, `${origin}/tag/europe/app/v1`);
});

test("describe returns null for an unknown session, stop tolerates gone sessions", async () => {
  const f = fakeFetch([{ status: 404, json: {} }, { status: 409, json: {} }, { status: 204 }]);
  const client = createClient({ origin, token: "t", fetch: f.fetch });
  assert.equal(await client.describeSession("s"), null);
  assert.equal(await client.stopSession("s"), "already-stopped");
  assert.equal(await client.stopSession("s"), "stopped");
});

test("logs are fetched without following", async () => {
  const f = fakeFetch([{ text: "line1\nline2" }]);
  const client = createClient({ origin, token: "t", fetch: f.fetch });
  assert.equal(await client.logs("s 1"), "line1\nline2");
  assert.equal(f.requests[0].url, `${origin}/logs?id=s%201&follow=false`);
});

test("resolves environments and rejects non-https overrides", () => {
  assert.equal(resolveOrigin("sandbox", ""), "https://api.sandbox-gameye.gameye.net");
  assert.equal(resolveOrigin("production", ""), "https://api.production-gameye.gameye.net");
  assert.equal(resolveOrigin("sandbox", "https://api.staging.gameye.net/x"), "https://api.staging.gameye.net");
  assert.equal(resolveOrigin("sandbox", "https://API.Sandbox-Gameye.Gameye.Net./"), "https://api.sandbox-gameye.gameye.net.");
  assert.throws(() => resolveOrigin("sandbox", "http://api.sandbox-gameye.gameye.net"), /https/);
  assert.throws(() => resolveOrigin("staging", ""), /Unknown environment/);
});

test("a request that gets no response is a transient GameyeError", async () => {
  const fetch = async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); };
  const client = createClient({ origin, token: "t", fetch });
  await assert.rejects(client.tagExists("r", "a", "v"), (e) => {
    assert.ok(e instanceof GameyeError);
    assert.ok(isTransient(e));
    assert.match(e.message, /could not reach .*ECONNRESET/);
    return true;
  });
});

test("an api-url outside *.gameye.net needs allow-custom-api-url, since the token is sent there", () => {
  for (const url of ["https://api.example.test", "https://gameye.net.example.test", "https://evilgameye.net"]) {
    assert.throws(() => resolveOrigin("sandbox", url), /must be a \*\.gameye\.net host.*allow-custom-api-url/);
  }
  assert.equal(resolveOrigin("sandbox", "https://api.example.test/x", true), "https://api.example.test");
  assert.throws(() => resolveOrigin("sandbox", "http://api.example.test", true), /https/);
});
