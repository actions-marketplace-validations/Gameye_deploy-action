import { randomUUID } from "node:crypto";
import { GameyeError, isTransient } from "./gameye.mjs";

const TAG_POLL_MS = 10_000;
const SESSION_POLL_MS = 5_000;
// The session may not be visible to describe until the next state snapshot.
const UNKNOWN_SESSION_GRACE_MS = 60_000;
const UNREACHABLE_GRACE_MS = 60_000;
// A stop can return 404 while the new session is not yet visible; retry for this long.
const STOP_RETRY_MS = 60_000;
// The longest a smoke test may take beyond startup and smoke durations, for API hiccups.
const WATCH_SLACK_MS = 120_000;
const LOG_TAIL_LINES = 50;
const FAILED_STATUSES = new Set(["exited", "dead", "restarting", "draining", "shuttingdown"]);

export class ActionFailure extends Error {}

export function parseDuration(value, name) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!value || !match) throw new ActionFailure(`${name} must look like 90s, 15m or 1h30m (got "${value}").`);
  const [, h = 0, m = 0, s = 0] = match;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

export function parseBoolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ActionFailure(`${name} must be true or false (got "${value}").`);
}

export function parseLines(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function parseEnv(value) {
  const env = {};
  for (const line of parseLines(value)) {
    const separator = line.indexOf("=");
    if (separator <= 0 || separator === line.length - 1) {
      throw new ActionFailure("smoke-env lines must be KEY=VALUE with a non-empty value.");
    }
    env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
}

// The session's TTL is a safety net in case the stop call never happens.
export function sessionTtl(startupMs, smokeMs) {
  const minutes = Math.ceil((startupMs + smokeMs) / 60_000) + 5;
  return `${minutes}m`;
}

function explain(error, inputs) {
  if (!(error instanceof GameyeError)) return error;
  const hints = {
    401: "The API token was rejected. Check the secret and the environment.",
    402: "Your Gameye quota is exhausted.",
    403: "The API token is missing a scope this step needs (see the README for the scopes).",
    404: `Application "${inputs.application}", region "${inputs.regions.join(", ")}" or tag "${inputs.tag}" was not found for this token's organization.`,
    420: "Gameye could not start a session in this region: no server there has the tag yet, or the region is full. Check the tag is available there, then try again.",
  };
  const hint = hints[error.status];
  return new ActionFailure(hint ? `${error.message}. ${hint}` : error.message);
}

export async function run(inputs, deps) {
  try {
    return await steps(inputs, deps);
  } catch (error) {
    throw explain(error, inputs);
  }
}

async function steps(inputs, deps) {
  const { application, tag, regions } = inputs;
  const { client, core, report } = deps;
  if ((inputs.waitForTag || inputs.smokeTest) && regions.length === 0) {
    throw new ActionFailure("region is required for wait-for-tag and smoke-test.");
  }

  if (inputs.enableTag) {
    await client.enableTag(application, tag);
    report.registered = true;
    core.info(`Registered tag ${tag} on application ${application}.`);
  }

  if (inputs.waitForTag) {
    await waitForTag(inputs, deps);
  }

  if (inputs.smokeTest) {
    return smokeTest(inputs, deps);
  }
  return {};
}

async function waitForTag({ application, tag, regions, waitTimeoutMs }, { client, core, sleep, now, report }) {
  core.info(`Waiting for ${application}:${tag} to be pulled in ${regions.join(", ")}...`);
  const startedAt = now();
  const deadline = startedAt + waitTimeoutMs;
  const pending = new Set(regions);
  for (const region of regions) report.regions[region] = { available: false };
  for (;;) {
    for (const region of [...pending]) {
      try {
        if (await client.tagExists(region, application, tag)) {
          pending.delete(region);
          report.regions[region] = { available: true, waitedMs: now() - startedAt };
          core.info(`Tag ${tag} is available in ${region}.`);
        }
      } catch (error) {
        // A 404 can mean Gameye does not know the tag yet, right after it was enabled.
        if (!isTransient(error) && error.status !== 404) throw error;
        core.info(`Still waiting for ${region} (${error.message}).`);
      }
    }
    if (pending.size === 0) return;
    if (now() >= deadline) {
      throw new ActionFailure(
        `Tag ${tag} was not pulled in ${[...pending].join(", ")} within the wait-timeout. ` +
          "Check that the image was pushed with this tag and that Gameye can pull it " +
          "(registry access for Gameye, or your organization's registry token).",
      );
    }
    await sleep(TAG_POLL_MS);
  }
}

async function smokeTest(inputs, { client, core, sleep, now, report }) {
  const { application, tag } = inputs;
  const region = inputs.regions[0];
  const id = randomUUID();
  // Saved before the session exists, so the post step can clean up after a cancel.
  core.saveState("session-id", id);

  const started = await client.runSession({
    id,
    location: region,
    image: application,
    version: tag,
    restart: false,
    ttl: sessionTtl(inputs.startupTimeoutMs, inputs.smokeDurationMs),
    labels: { "gameye-action": "smoke-test", ...(inputs.runId ? { "github-run": inputs.runId } : {}) },
    ...(inputs.args.length ? { args: inputs.args } : {}),
    ...(Object.keys(inputs.env).length ? { env: inputs.env } : {}),
  });
  const result = { sessionId: id, host: started.host, ports: started.ports ?? [] };
  // Set now, so later `if: failure()` steps can use them too.
  core.setOutput("session-id", result.sessionId);
  core.setOutput("host", result.host);
  core.setOutput("ports", JSON.stringify(result.ports));
  core.info(`Started smoke-test session ${id} on ${started.host}.`);
  report.smoke = { region, ...result, passed: false };

  let failure;
  try {
    await watchSession(id, inputs, { client, core, sleep, now });
    core.info(`Session stayed running for the smoke-duration. Smoke test passed.`);
  } catch (error) {
    failure = error;
  }

  report.smoke.passed = !failure;
  if (inputs.showLogs === "always" || (failure && inputs.showLogs === "on-failure")) {
    const lines = await printLogs(id, { client, core });
    if (failure) report.smoke.logTail = lines?.slice(-LOG_TAIL_LINES);
  }

  const stopFailure = await stopSession(id, { client, core, sleep, now });
  if (failure) throw failure;
  if (stopFailure) throw stopFailure;
  return result;
}

// Returns an ActionFailure when the session may still be running because of the token, else nothing.
export async function stopSession(id, { client, core, sleep, now }) {
  const deadline = now() + STOP_RETRY_MS;
  for (;;) {
    let outcome;
    try {
      outcome = await client.stopSession(id);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        return new ActionFailure(
          `Could not stop session ${id}: ${error.message}. It keeps running until its TTL; ` +
            "give the token the session:stop scope.",
        );
      }
      if (!isTransient(error) || now() >= deadline) {
        core.warning(`Could not stop session ${id}: ${error.message}. Its TTL will end it.`);
        return undefined;
      }
    }
    if (outcome === "stopped" || outcome === "already-stopped") {
      core.saveState("session-id", "");
      core.info(`Stopped session ${id}.`);
      return undefined;
    }
    if (outcome === "not-found" && now() >= deadline) {
      // Keep the saved id so the post step tries once more.
      core.warning(`Session ${id} was not found when stopping it. If it is running, its TTL will end it.`);
      return undefined;
    }
    await sleep(SESSION_POLL_MS);
  }
}

async function watchSession(id, { tag, startupTimeoutMs, smokeDurationMs }, { client, core, sleep, now }) {
  const startedAt = now();
  const deadline = startedAt + startupTimeoutMs + smokeDurationMs + WATCH_SLACK_MS;
  let runningSince;
  let everRunning = false;
  let unreachableSince;

  for (;;) {
    let session;
    let known = true;
    try {
      session = await client.describeSession(id);
    } catch (error) {
      if (!isTransient(error)) throw error;
      core.info(`Could not check the session (${error.message}); retrying.`);
      known = false;
    }
    const t = now();

    if (!known) {
      // Fall through to the timeouts below.
    } else if (!session) {
      if (t - startedAt > UNKNOWN_SESSION_GRACE_MS) {
        throw new ActionFailure(`Session ${id} disappeared. The server probably exited straight away.`);
      }
    } else {
      // A warm pool hands out an already running container and ignores the requested version.
      if (session.tag && session.tag !== tag) {
        throw new ActionFailure(
          `The session runs tag ${session.tag}, not ${tag}. A warm pool in this region probably served it; ` +
            "smoke-test in a region without a warm pool for this application.",
        );
      }
      if (FAILED_STATUSES.has(session.status)) {
        throw new ActionFailure(`Session ${id} went to status "${session.status}". The server did not stay up.`);
      }
      if (session.status === "server_unreachable") {
        unreachableSince ??= t;
        if (t - unreachableSince > UNREACHABLE_GRACE_MS) {
          throw new ActionFailure(`Session ${id} stayed unreachable. This is likely a Gameye node issue, not your build.`);
        }
      } else {
        unreachableSince = undefined;
      }
      if (session.status === "running") {
        if (runningSince === undefined) core.info(`Session ${id} is running.`);
        runningSince ??= t;
        everRunning = true;
        if (t - runningSince >= smokeDurationMs) return;
      } else {
        // The smoke-duration must be one uninterrupted stretch of running.
        if (runningSince !== undefined) core.info(`Session ${id} left running (status "${session.status}").`);
        runningSince = undefined;
      }
    }

    if (!everRunning && t - startedAt > startupTimeoutMs) {
      throw new ActionFailure(`Session ${id} did not reach running within the startup-timeout.`);
    }
    if (t > deadline) {
      throw new ActionFailure(
        everRunning
          ? `Session ${id} did not stay running for the smoke-duration in one stretch.`
          : `Could not confirm session ${id} stayed running; the Gameye API kept failing.`,
      );
    }
    await sleep(SESSION_POLL_MS);
  }
}

async function printLogs(id, { client, core }) {
  try {
    const text = await client.logs(id);
    const lines = text.split("\n").slice(-200);
    core.startGroup(`Session ${id} logs (last ${lines.length} lines)`);
    // The server's output must not be read as workflow commands such as ::add-mask::.
    const token = randomUUID();
    core.info(`::stop-commands::${token}`);
    core.info(lines.join("\n"));
    core.info(`::${token}::`);
    core.endGroup();
    return lines;
  } catch (error) {
    core.warning(`Could not fetch logs for session ${id}: ${error.message}`);
    return undefined;
  }
}
