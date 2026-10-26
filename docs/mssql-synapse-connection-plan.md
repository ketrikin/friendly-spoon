# Connecting Claude to the Azure Synapse SQL Database

## Goal

Let Claude (via an MCP server) query the Azure Synapse serverless SQL pool at
`synw-ukso-im-prod-01-ondemand.sql.azuresynapse.net`.

## Findings from network diagnosis

- The host resolves publicly (DNS is fine) to `51.143.209.224`, aliased to
  several `azuresynapse.net` / `database.windows.net` names — it's an Azure
  Synapse Analytics **serverless SQL pool** endpoint (TDS protocol, port
  1433), not a generic on-prem MSSQL box. Same wire protocol as SQL Server,
  so standard MSSQL drivers/MCP servers are compatible in principle.
- The Claude Code cloud session this plan was drafted in runs behind a
  **strict outbound allowlist** egress proxy: only HTTPS (443) is permitted,
  and only to a small set of pre-approved domains (`api.github.com` works;
  `example.com`, `learn.microsoft.com`, `management.azure.com` all returned
  explicit 403 policy denials). Raw TCP on any other port — including 1433 —
  is blocked entirely, even to public IPs unrelated to this database. This is
  documented platform behavior ("Not supported through the proxy": non-443
  HTTPS ports, raw-TCP databases).
- Consequence: no MCP server running in that session can reach the database
  directly, and no HTTPS bridge hosted on arbitrary custom infrastructure
  (e.g. an Azure App Service) is reachable from it either, unless that
  bridge's domain is explicitly added to the environment's egress allowlist.

## Recommended architecture

Two pieces:

### 1. Bridge — Microsoft's SQL MCP Server (Data API builder)

Deploy Data API builder (v1.7+/2.0, which includes SQL MCP Server support) on
Azure compute that's already inside the VNet/VPN boundary with access to the
Synapse endpoint:

- Database type: `mssql`.
- Connection string: SQL auth (username/password from the existing Synapse
  connection string), supplied via environment variable or Key Vault
  reference — never hardcoded into the DAB config file.
- Enable MCP's streamable-HTTP transport (not stdio) in `dab-config.json`'s
  `runtime.mcp` section, since the bridge needs to be reachable over the
  network rather than run as a local subprocess.
- Put the bridge behind auth (App Service Easy Auth, a bearer token, or
  Entra ID) — once exposed it must not be an open proxy onto the database.
- Exact current CLI/config syntax should be checked against
  <https://learn.microsoft.com/en-us/sql/mcp/> directly (this session's
  egress policy blocked fetching that page to verify the latest syntax).

### 2. Client — Claude Code MCP configuration

Once the bridge is deployed and reachable at some HTTPS URL, register it as
a remote HTTP MCP server, e.g. in `.mcp.json`:

```json
{
  "mcpServers": {
    "synapse-sql": {
      "type": "http",
      "url": "https://<your-bridge-host>/mcp",
      "headers": {
        "Authorization": "Bearer ${SYNAPSE_MCP_TOKEN}"
      }
    }
  }
}
```

Store `SYNAPSE_MCP_TOKEN` as an environment variable in whatever session
config is used, not pasted into chat.

## Prerequisite — pick one

- **(a)** Widen this Claude Code environment's egress allowlist (in
  environment settings, outside chat) to include the bridge's domain, so
  this same session/environment can reach it.
- **(b)** Do the work from a Claude Code session with a less restrictive
  network policy — e.g. local Claude Code on a machine that already has VPN
  access, or a different remote environment with a custom/open allowlist.

## Implementation

The bridge config, Dockerfile, deployment steps, and the client-side MCP
wiring template now live in `infra/mssql-mcp-bridge/`. None of it has been
run or tested from this session — see that folder's README for the exact
caveats and the steps still needed (filling in the real table/view,
verifying the base image's entrypoint, deploying inside the VNet, and
enabling auth on the hosting resource).

## Open items for whoever picks this up

- Verify DAB's exact MCP-over-HTTP config syntax against the docs above.
- Decide the bridge's exposure/auth model (Easy Auth vs. bearer token vs.
  Entra ID).
- Confirm which Azure compute resource hosts the bridge and whether it
  already has an HTTPS listener/App Service slot, or one needs provisioning.
- Prefer a Key Vault reference over a raw env var for the SQL credential if
  the hosting compute supports it.
