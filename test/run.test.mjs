import { test } from "node:test";
import assert from "node:assert/strict";
import { GameyeError } from "../src/gameye.mjs";
import { ActionFailure, parseDuration, parseEnv, run, sessionTtl } from "../src/run.mjs";

const baseInputs = {
  application: "my-game",
  tag: "v1.2.3",
  regions: ["europe"],
  enableTag: true,
  waitForTag: true,
  waitTimeoutMs: 60_000,
  smokeTest: false,
  smokeDurationMs: 30_000,
  startupTimeoutMs: 60_000,
  args: [],
  env: {},
  showLogs: "on-failure",
  runId: "42",
};

function harness({ tagExists = [true], sessions = [], client: overrides = {} } = {}) {
  let clock = 0;
  const calls = [];
  const state = {};
  const output = [];
  const outputs = {};
  const client = {
    async enableTag(...a) { calls.push(["enableTag", ...a]); },
    async tagExists(...a) { calls.push(["tagExists", ...a]); return tagExists.length > 1 ? tagExists.shift() : tagExists[0]; },
    async runSession(body) { calls.push(["runSession", body]); return { id: body.id, host: "1.2.3.4", ports: [{ type: "udp", container: 7777, host: 49000 }] }; },
    async describeSession(id) { calls.push(["describeSession", id]); return sessions.length > 1 ? sessions.shift() : sessions[0]; },
    async stopSession(id) { calls.push(["stopSession", id]); return "stopped"; },
    async logs(id) { calls.push(["logs", id]); return "booting\ncrashed: missing map"; },
    ...overrides,
  };
  const core = {
    info: (m) => output.push(m),
    warning: (m) => output.push(`warning: ${m}`),
    startGroup: (m) => output.push(`group: ${m}`),
    endGroup: () => {},
    saveState: (k, v) => { state[k] = v; },
    setOutput: (k, v) => { outputs[k] = v; },
  };
  const report = { application: "my-game", tag: "v1.2.3", environment: "sandbox", regions: {} };
  const deps = { client, core, report, sleep: async (ms) => { clock += ms; }, now: () => clock };
  return { deps, calls, state, output, outputs, report, names: () => calls.map((c) => c[0]) };
}

const running = (tag = "v1.2.3") => ({ status: "running", tag });

test("registers the tag and waits until it is pulled", async () => {
  const h = harness({ tagExists: [false, false, true] });
  const result = await run(baseInputs, h.deps);
  assert.deepEqual(result, {});
  assert.deepEqual(h.calls[0], ["enableTag", "my-game", "v1.2.3"]);
  assert.deepEqual(h.names(), ["enableTag", "tagExists", "tagExists", "tagExists"]);
});

test("fails with a pointer to registry access when the tag never arrives", async () => {
  const h = harness({ tagExists: [false] });
  await assert.rejects(run(baseInputs, h.deps), (e) => e instanceof ActionFailure && /not pulled in europe/.test(e.message));
});

test("requires a region for waiting or smoke testing", async () => {
  const h = harness();
  await assert.rejects(run({ ...baseInputs, regions: [] }, h.deps), /region is required/);
  assert.deepEqual(h.calls, []);
});

test("skips registration and waiting when disabled", async () => {
  const h = harness();
  await run({ ...baseInputs, enableTag: false, waitForTag: false, regions: [] }, h.deps);
  assert.deepEqual(h.calls, []);
});

test("smoke test passes when the session stays running, then stops it", async () => {
  const h = harness({ sessions: [null, { status: "created", tag: "v1.2.3" }, running()] });
  const result = await run({ ...baseInputs, smokeTest: true, args: ["--map=dust"], env: { KEY: "v" } }, h.deps);

  const [, body] = h.calls.find((c) => c[0] === "runSession");
  assert.equal(body.image, "my-game");
  assert.equal(body.version, "v1.2.3");
  assert.equal(body.location, "europe");
  assert.equal(body.restart, false);
  assert.deepEqual(body.args, ["--map=dust"]);
  assert.deepEqual(body.env, { KEY: "v" });
  assert.deepEqual(body.labels, { "gameye-action": "smoke-test", "github-run": "42" });

  assert.equal(result.sessionId, body.id);
  assert.equal(result.host, "1.2.3.4");
  assert.equal(h.names().at(-1), "stopSession");
  assert.ok(!h.names().includes("logs"), "no logs on success with on-failure");
  assert.equal(h.state["session-id"], "", "state cleared after a clean stop");
});

test("smoke test fails, prints logs and still stops when the server exits", async () => {
  const h = harness({ sessions: [running(), { status: "exited", tag: "v1.2.3" }] });
  await assert.rejects(run({ ...baseInputs, smokeTest: true }, h.deps), /went to status "exited"/);
  assert.deepEqual(h.names().slice(-2), ["logs", "stopSession"]);
  assert.ok(h.output.some((m) => m.includes("crashed: missing map")));
});

test("smoke test fails when a warm pool serves a different tag", async () => {
  const h = harness({ sessions: [running("v1.0.0")] });
  await assert.rejects(run({ ...baseInputs, smokeTest: true }, h.deps), /warm pool/);
  assert.equal(h.names().at(-1), "stopSession");
});

test("smoke test fails when the session never reaches running", async () => {
  const h = harness({ sessions: [{ status: "created", tag: "v1.2.3" }] });
  await assert.rejects(run({ ...baseInputs, smokeTest: true }, h.deps), /did not reach running/);
  assert.equal(h.names().at(-1), "stopSession");
});

test("smoke test fails when the session never appears", async () => {
  const h = harness({ sessions: [null] });
  await assert.rejects(run({ ...baseInputs, smokeTest: true, startupTimeoutMs: 600_000 }, h.deps), /disappeared/);
});

test("a short unreachable blip does not fail the smoke test", async () => {
  const h = harness({ sessions: [running(), { status: "server_unreachable", tag: "v1.2.3" }, running()] });
  await run({ ...baseInputs, smokeTest: true }, h.deps);
});

test("the session id is saved before the session starts, for the post step", async () => {
  let savedBeforeRun;
  const h = harness({ sessions: [running()] });
  h.deps.client.runSession = async (body) => {
    savedBeforeRun = h.state["session-id"];
    return { id: body.id, host: "h", ports: [] };
  };
  await run({ ...baseInputs, smokeTest: true }, h.deps);
  assert.ok(savedBeforeRun);
});

test("a failed stop is a warning, not a failure, and keeps the state for the post step", async () => {
  const h = harness({ sessions: [running()], client: { stopSession: async () => { throw new Error("timeout"); } } });
  await run({ ...baseInputs, smokeTest: true }, h.deps);
  assert.ok(h.output.some((m) => m.startsWith("warning: Could not stop")));
  assert.ok(h.state["session-id"]);
});

test("API errors get an actionable hint", async () => {
  const h = harness({ client: { enableTag: async () => { throw new GameyeError("enable-tag", 403, ""); } } });
  await assert.rejects(run(baseInputs, h.deps), /missing a scope/);
});

test("parses durations, env lines and TTLs", () => {
  assert.equal(parseDuration("90s", "x"), 90_000);
  assert.equal(parseDuration("1h30m", "x"), 5_400_000);
  assert.throws(() => parseDuration("soon", "x"), ActionFailure);
  assert.throws(() => parseDuration("", "x"), ActionFailure);
  assert.deepEqual(parseEnv("A=1\n B=x=y \n"), { A: "1", B: "x=y" });
  assert.throws(() => parseEnv("novalue"), ActionFailure);
  assert.throws(() => parseEnv("EMPTY="), ActionFailure);
  assert.equal(sessionTtl(180_000, 60_000), "9m");
});

const err = (status) => new GameyeError("op", status, "");

test("the tag wait keeps polling through 404s and server errors", async () => {
  let n = 0;
  const h = harness({ client: { tagExists: async () => { n++; if (n === 1) throw err(404); if (n === 2) throw err(503); if (n === 3) throw err(0); return true; } } });
  await run(baseInputs, h.deps);
  assert.equal(n, 4);
});

test("the tag wait fails fast on an auth error", async () => {
  let n = 0;
  const h = harness({ client: { tagExists: async () => { n++; throw err(401); } } });
  await assert.rejects(run(baseInputs, h.deps), /token was rejected/);
  assert.equal(n, 1);
});

test("a server error while watching the session is retried", async () => {
  let n = 0;
  const h = harness({ client: { describeSession: async () => { n++; if (n === 2) throw err(502); return running(); } } });
  await run({ ...baseInputs, smokeTest: true }, h.deps);
  assert.ok(n > 2);
});

test("outputs are set as soon as the session starts, even if the test then fails", async () => {
  const h = harness({ sessions: [{ status: "dead", tag: "v1.2.3" }] });
  await assert.rejects(run({ ...baseInputs, smokeTest: true }, h.deps));
  assert.ok(h.outputs["session-id"]);
  assert.equal(h.outputs.host, "1.2.3.4");
  assert.equal(h.outputs.ports, JSON.stringify([{ type: "udp", container: 7777, host: 49000 }]));
});

test("a stop without the session:stop scope fails the job", async () => {
  const h = harness({ sessions: [running()], client: { stopSession: async () => { throw err(403); } } });
  await assert.rejects(run({ ...baseInputs, smokeTest: true }, h.deps), /session:stop/);
  assert.ok(h.state["session-id"], "state kept for the post step");
});

test("a stop that finds no session retries, then keeps the state for the post step", async () => {
  let n = 0;
  const h = harness({ sessions: [running()], client: { stopSession: async () => { n++; return "not-found"; } } });
  await run({ ...baseInputs, smokeTest: true }, h.deps);
  assert.ok(n > 1);
  assert.ok(h.state["session-id"]);
  assert.ok(h.output.some((m) => m.startsWith("warning: Session") && m.includes("not found")));
});

test("a stop that finds no session at first succeeds on retry", async () => {
  const outcomes = ["not-found", "stopped"];
  const h = harness({ sessions: [running()], client: { stopSession: async () => outcomes.shift() } });
  await run({ ...baseInputs, smokeTest: true }, h.deps);
  assert.equal(h.state["session-id"], "");
});

test("server logs cannot issue workflow commands", async () => {
  const h = harness({ sessions: [{ status: "exited", tag: "v1.2.3" }], client: { logs: async () => "::add-mask::x\nboom" } });
  await assert.rejects(run({ ...baseInputs, smokeTest: true }, h.deps));
  const i = h.output.findIndex((m) => m.startsWith("::stop-commands::"));
  assert.ok(i >= 0);
  const token = h.output[i].slice("::stop-commands::".length);
  assert.ok(h.output[i + 1].includes("::add-mask::x"));
  assert.equal(h.output[i + 2], `::${token}::`);
});

test("waits for every listed region and smoke-tests in the first", async () => {
  const pulled = { europe: [false, true], "us-east": [false, false, true] };
  const h = harness({
    sessions: [running()],
    client: { tagExists: async (region) => (pulled[region].length > 1 ? pulled[region].shift() : pulled[region][0]) },
  });
  await run({ ...baseInputs, regions: ["europe", "us-east"], smokeTest: true }, h.deps);
  assert.equal(h.report.regions.europe.available, true);
  assert.equal(h.report.regions["us-east"].available, true);
  assert.ok(h.report.regions["us-east"].waitedMs > h.report.regions.europe.waitedMs);
  const [, body] = h.calls.find((c) => c[0] === "runSession");
  assert.equal(body.location, "europe");
  assert.equal(h.report.smoke.region, "europe");
  assert.equal(h.report.smoke.passed, true);
});

test("a region that never gets the tag is named in the failure", async () => {
  const h = harness({ client: { tagExists: async (region) => region === "europe" } });
  await assert.rejects(run({ ...baseInputs, regions: ["europe", "asia"] }, h.deps), /not pulled in asia within/);
  assert.deepEqual(h.report.regions.asia, { available: false });
});

test("a failed smoke test records the last log lines for the summary", async () => {
  const h = harness({ sessions: [{ status: "exited", tag: "v1.2.3" }] });
  await assert.rejects(run({ ...baseInputs, smokeTest: true }, h.deps));
  assert.equal(h.report.smoke.passed, false);
  assert.deepEqual(h.report.smoke.logTail, ["booting", "crashed: missing map"]);
});

test("the smoke-duration must be one uninterrupted stretch of running", async () => {
  // 30s smoke at 5s polls: running for 20s, unreachable once, then running again.
  // Without the reset the clock would keep counting from the first running.
  const blip = { status: "server_unreachable", tag: "v1.2.3" };
  const h = harness({ sessions: [running(), running(), running(), running(), running(), blip, running()] });
  await run({ ...baseInputs, smokeTest: true }, h.deps);
  const describes = h.names().filter((n) => n === "describeSession").length;
  // 5 running + 1 blip, then 7 more polls (0s..30s) of a fresh running stretch.
  assert.equal(describes, 13);
  assert.ok(h.output.some((m) => /left running \(status "server_unreachable"\)/.test(m)));
});

test("a session that keeps dropping out of running fails with a clear message", async () => {
  const flap = { status: "server_unreachable", tag: "v1.2.3" };
  const sessions = [];
  for (let i = 0; i < 200; i++) sessions.push(i % 3 === 2 ? flap : running());
  const h = harness({ sessions });
  await assert.rejects(run({ ...baseInputs, smokeTest: true }, h.deps), /did not stay running for the smoke-duration in one stretch/);
});
