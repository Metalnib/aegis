# Aegis Helm chart

Single-replica deployment of the Aegis autonomous code-review agent.

## Install

```bash
helm install aegis ./helm/aegis \
  --set-file config=./aegis.config.js \
  --set-string secrets.anthropicApiKey=$ANTHROPIC_API_KEY \
  --set-string secrets.githubToken=$GITHUB_TOKEN \
  --set-string secrets.githubWebhookSecret=$GITHUB_WEBHOOK_SECRET \
  --set-string secrets.slackBotToken=$SLACK_BOT_TOKEN \
  --set-string secrets.slackAppToken=$SLACK_APP_TOKEN \
  --set-string secrets.metricsToken=$(openssl rand -hex 32)
```

## Notes

- **Single replica is mandatory.** SQLite is single-writer; the chart uses
  `strategy: Recreate` so a rolling restart can never run two pods at once.
- **State persistence.** Two PVCs: `<release>-state` (10Gi default) for
  SQLite/MCP state, and `<release>-workspace` (50Gi default) for cloned
  repos. Pre-create them with a different storage class via
  `--set persistence.state.storageClass=...` if needed.
- **Secrets.** Each key in `.Values.secrets` becomes an env var named in
  SCREAMING_SNAKE_CASE. So `secrets.anthropicApiKey` becomes
  `ANTHROPIC_API_KEY`. Reference these from your `aegis.config.js`.

  > Secret keys must be camelCase. The chart uses Sprig's `snakecase` to
  > derive the env var name, which mangles ALL_CAPS or SCREAMING_SNAKE
  > inputs (e.g. `GITHUB_TOKEN` becomes `g_i_t_h_u_b__t_o_k_e_n`). Stick
  > to `anthropicApiKey`, `githubWebhookSecret`, etc.
- **Ingress is intentionally omitted.** Wire up your own ingress, gateway,
  or a `LoadBalancer` service via `service.type=LoadBalancer`.
- **Webhook URLs.** Once a Service or Ingress is in place, configure your
  GitHub/GitLab webhooks to POST to `https://<host>/webhooks/<adapter-id>`.
