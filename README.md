# Gameye Deploy Action

[![Discord](https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/QvJ3KH5max)

This action puts a freshly pushed game server image live on [Gameye](https://gameye.com) from GitHub Actions. It can also prove the build boots before anyone plays it.

1. **Register the tag** with your Gameye application.
2. **Wait** until Gameye has pulled the tag in one or more regions.
3. **Smoke test** (optional): start a session on the new tag, check that it reaches `running` and stays there for `smoke-duration`, then stop it. If the server crashes or never comes up, the job fails and prints the server's logs.

The action uses only the public Gameye Session API, and it has no dependencies.

## Usage

```yaml
- uses: gameye/deploy-action@v0
  with:
    api-token: ${{ secrets.GAMEYE_API_TOKEN }}
    application: my-game-server
    tag: ${{ steps.image.outputs.tag }}  # the tag you just pushed
    region: europe
    smoke-test: true
```

[`examples/deploy.yml`](examples/deploy.yml) is a complete workflow: build, push to GHCR, register and smoke-test.

Gameye must be able to pull the image. For a private GHCR package, follow the [GHCR guide](https://gameye.com/docs/getting-started/ghcr/), or the tag will never become available and the wait step times out.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-token` | required | Gameye API token. Keep it in a secret. |
| `application` | required | Gameye application name (not the image reference). |
| `tag` | required | Image tag to register. |
| `region` | | Region to wait for and smoke-test in. List several, comma- or newline-separated, to wait for all of them; the smoke test runs in the first. Required for `wait-for-tag` and `smoke-test`. |
| `environment` | `sandbox` | `sandbox` (self-serve) or `production` (enterprise). |
| `api-url` | | Overrides the API origin. It must use https. |
| `enable-tag` | `true` | Register the tag with the application. |
| `wait-for-tag` | `true` | Wait until the tag is pulled in every listed region. |
| `wait-timeout` | `15m` | How long to wait for the tag. |
| `smoke-test` | `false` | Start a session on the tag, check it stays up, then stop it. |
| `smoke-duration` | `60s` | How long the session must stay `running` to pass. |
| `startup-timeout` | `3m` | How long the session may take to reach `running`. |
| `smoke-args` | | Program arguments for the session, one per line. |
| `smoke-env` | | Environment variables for the session, one `KEY=VALUE` per line. The values are masked in the log. |
| `show-logs` | `on-failure` | When to print the session's logs: `on-failure`, `always` or `never`. |
| `github-deployment` | | Record the run as a GitHub Deployment to this environment, for example `gameye-sandbox`. Needs `permissions: deployments: write`. |
| `github-token` | `${{ github.token }}` | Token for the GitHub Deployment. |

## Outputs

`session-id`, `host` and `ports` (JSON) from the smoke-test session.

## On the run page

Every run writes a job summary: the regions and how long each took to pull the tag, the smoke-test result with the session's host and ports, and the error and the server's last 50 log lines when it fails. With `github-deployment` set, the repository's Deployments list also shows each run, linked to its log, marked in progress, successful or failed.

## API token scopes

Give the token only what the steps you use need:

| Step | Scopes |
|---|---|
| Register the tag | `application:write`, `regions:read` |
| Wait for the tag | `regions:read` |
| Smoke test | `session:start`, `session:read`, `session:stop`, plus `logs:read` for logs |

## Good to know

- **Warm pools.** If the application has a warm pool in the smoke-test region, Gameye hands out an already running container and ignores the requested tag, `smoke-args` and `smoke-env`. If that container runs a different tag, the action fails with a message rather than passing a test of the wrong build. If it runs the same tag, the test passes, but without your arguments and environment. Smoke-test in a region without a warm pool.
- **Cleanup.** The action stops the session when the test ends, and again in a post step if the job was cancelled. If the token lacks `session:stop`, the job fails so you notice. Stopping is best effort, though: if the runner itself dies, nothing can call stop. The guaranteed backstop is the session's TTL: the startup and smoke durations plus five minutes.
- **Cost and quota.** A smoke test is a real session and counts like one.
- **Logs.** Logs come from your own server. Don't print secrets from it if your repository's Actions logs are public. The action turns off workflow commands while it prints them, so server output can't issue commands such as `::add-mask::`.
- **Retries.** While waiting for the tag or watching the session, the action retries timeouts and server errors. It fails straight away on authentication and permission errors.

## Development

```sh
npm test
```

## About Gameye

[Gameye](https://gameye.com/?utm_source=github&utm_medium=readme&utm_campaign=deploy-action) is a managed hosting platform for multiplayer game servers. You bring a container image, and Gameye starts a dedicated server for each match through one API.

- Guide: [gameye.com/docs/guides/using-gameye/github-actions](https://gameye.com/docs/guides/using-gameye/github-actions/?utm_source=github&utm_medium=readme&utm_campaign=deploy-action)
- Gameye docs: [gameye.com/docs](https://gameye.com/docs/?utm_source=github&utm_medium=readme&utm_campaign=deploy-action)
- Try it free: [trial.gameye.com](https://trial.gameye.com/?utm_source=github&utm_medium=readme&utm_campaign=deploy-action)
