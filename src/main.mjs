import { pathToFileURL } from "node:url";
import * as core from "./actions.mjs";
import { createClient, resolveOrigin } from "./gameye.mjs";
import { createDeploymentRecorder } from "./github.mjs";
import { ActionFailure, parseBoolean, parseDuration, parseEnv, parseLines, run } from "./run.mjs";
import { renderSummary } from "./summary.mjs";

export function readInputs(env = process.env) {
  const input = (name) => core.getInput(name, env);
  const showLogs = input("show-logs") || "on-failure";
  if (!["on-failure", "always", "never"].includes(showLogs)) {
    throw new ActionFailure(`show-logs must be on-failure, always or never (got "${showLogs}").`);
  }
  for (const name of ["api-token", "application", "tag"]) {
    if (!input(name)) throw new ActionFailure(`Input ${name} is required.`);
  }
  const environment = input("environment") || "sandbox";
  return {
    token: input("api-token"),
    environment,
    origin: resolveOrigin(
      environment,
      input("api-url"),
      parseBoolean(input("allow-custom-api-url") || "false", "allow-custom-api-url"),
    ),
    application: input("application"),
    tag: input("tag"),
    regions: parseRegions(input("region")),
    enableTag: parseBoolean(input("enable-tag") || "true", "enable-tag"),
    waitForTag: parseBoolean(input("wait-for-tag") || "true", "wait-for-tag"),
    waitTimeoutMs: parseDuration(input("wait-timeout") || "15m", "wait-timeout"),
    smokeTest: parseBoolean(input("smoke-test") || "false", "smoke-test"),
    smokeDurationMs: parseDuration(input("smoke-duration") || "60s", "smoke-duration"),
    startupTimeoutMs: parseDuration(input("startup-timeout") || "3m", "startup-timeout"),
    args: parseLines(input("smoke-args")),
    env: parseEnv(input("smoke-env")),
    showLogs,
    runId: env.GITHUB_RUN_ID ?? "",
    githubDeployment: input("github-deployment"),
    githubToken: input("github-token"),
  };
}

export function parseRegions(value) {
  return [...new Set(value.split(/[\n,]/).map((region) => region.trim()).filter(Boolean))];
}

async function main() {
  let report;
  let deployment;
  try {
    core.setSecret(core.getInput("api-token"));
    const inputs = readInputs();
    report = { application: inputs.application, tag: inputs.tag, environment: inputs.environment, regions: {} };
    // Masking short values like "1" or "true" would garble the whole log.
    Object.values(inputs.env).filter((value) => value.length >= 4).forEach(core.setSecret);
    if (inputs.smokeTest && (inputs.args.length || Object.keys(inputs.env).length)) {
      core.info("Note: a warm pool ignores smoke-args and smoke-env; the session then runs with the pool's settings.");
    }
    if (inputs.githubDeployment) {
      deployment = createDeploymentRecorder({
        core,
        token: inputs.githubToken,
        environment: inputs.githubDeployment,
        report,
      });
      await deployment.start();
    }
    const client = createClient({ origin: inputs.origin, token: inputs.token });
    await run(inputs, {
      client,
      core,
      report,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    });
    await finish(report, deployment);
  } catch (error) {
    core.error(error.message);
    process.exitCode = 1;
    if (report) await finish(report, deployment, error);
  }
}

async function finish(report, deployment, error) {
  try {
    core.appendSummary(renderSummary(report, error));
  } catch (summaryError) {
    core.warning(`Could not write the job summary: ${summaryError.message}`);
  }
  await deployment?.finish(error);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
