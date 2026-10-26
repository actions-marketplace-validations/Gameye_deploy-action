// Runs after the job's steps, including when the run was cancelled mid smoke test.
import * as core from "./actions.mjs";
import { createClient, resolveOrigin } from "./gameye.mjs";
import { parseBoolean, stopSession } from "./run.mjs";

const id = core.getState("session-id");
if (id) {
  try {
    const client = createClient({
      origin: resolveOrigin(
        core.getInput("environment") || "sandbox",
        core.getInput("api-url"),
        parseBoolean(core.getInput("allow-custom-api-url") || "false", "allow-custom-api-url"),
      ),
      token: core.getInput("api-token"),
    });
    // The same stop as the main step, with its retry while a new session is not visible yet.
    const failure = await stopSession(id, {
      client,
      core,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    });
    if (failure) core.warning(failure.message);
  } catch (error) {
    core.warning(`Could not stop smoke-test session ${id}: ${error.message}. Its TTL will end it.`);
  }
}
