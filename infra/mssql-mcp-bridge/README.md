# Synapse SQL MCP Bridge

This folder is the bridge referenced in
`docs/mssql-synapse-connection-plan.md`: Microsoft's SQL MCP Server (built
on Data API builder / "DAB") deployed inside the network boundary that can
already reach `synw-ukso-im-prod-01-ondemand.sql.azuresynapse.net`, exposing
an HTTPS MCP endpoint that a Claude Code session can call remotely.

**None of this has been run or tested from the authoring session** — that
session's egress policy blocks both the direct database connection and
arbitrary outbound HTTPS, so this is built to spec from Microsoft's docs/
schema references, not verified end to end. Treat the exact config keys as
a strong starting point, and confirm them against the current schema before
relying on it:
<https://learn.microsoft.com/en-us/azure/data-api-builder/configuration/runtime>
and <https://learn.microsoft.com/en-us/sql/mcp/>.

## Files

- `dab-config.json` — DAB runtime config. Enables the MCP endpoint at `/mcp`,
  disables REST/GraphQL (not needed here), and defines one placeholder
  entity you must replace with your real table/view.
- `Dockerfile` — packages the official `data-api-builder` image with this
  config baked in.
- `mcp-client-config.example.json` — the client-side MCP server entry to add
  to a Claude Code session's `.mcp.json` once the bridge is deployed.

## 0. Verify the Dockerfile's ENTRYPOINT

The `ENTRYPOINT` in `Dockerfile` assumes the base `data-api-builder` image's
binary/DLL path and CLI flag names — I could not verify these against the
image itself from the authoring session (no registry/image access there).
Run `docker run --rm --entrypoint sh mcr.microsoft.com/azure-databases/data-api-builder:latest -c 'pwd && ls'`
first to confirm the actual working directory and entrypoint binary name,
and adjust the `ENTRYPOINT` line to match — the image may already default
to picking up `dab-config.json` from its working directory without an
explicit entrypoint override at all.

## 1. Fill in the entity

Edit `dab-config.json` and replace `__REPLACE_WITH_ENTITY_NAME__` and
`__REPLACE_WITH_SCHEMA.TABLE_OR_VIEW__` with the actual table/view you want
exposed (e.g. `"dbo.Orders"`). Add more entries under `entities` for each
table/view you want queryable. Each entity's `mcp.dml-tools.enabled: true`
is what turns it into a callable MCP tool (read-only here via
`"actions": ["read"]` — widen only if you actually need writes).

## 2. Local sanity check (wherever you have `dab` + network access)

```bash
dotnet tool install -g Microsoft.DataApiBuilder   # if not already installed
export SYNAPSE_CONNECTION_STRING='<your connection string>'
dab start --config ./dab-config.json
curl -s http://localhost:5000/mcp -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Run this from a machine/VPN that can actually reach the Synapse endpoint —
confirms config + connectivity before deploying.

## 3. Deploy inside the VNet

Using the Azure compute you already have inside the VNet/VPN boundary
(Container App, App Service, or VM):

```bash
az acr build --registry <your-acr> --image synapse-mcp-bridge:latest .
```

Deploy that image to your Container App/App Service, with:

- `SYNAPSE_CONNECTION_STRING` set via a Key Vault reference, not a plain
  app setting.
- The resource placed in (or VNet-integrated with) the subnet that already
  has a route to the Synapse endpoint.
- **Authentication enabled on the hosting resource** (App Service
  Authentication / Easy Auth with Entra ID, or the Container Apps
  equivalent) — `dab-config.json` is set to `"provider": "AppService"`,
  which trusts the identity headers the platform injects once Easy Auth is
  turned on. Without enabling it there, the `/mcp` endpoint is unauthenticated.

## 4. Wire up the Claude Code client

Once deployed, note its HTTPS URL (e.g. `https://synapse-mcp-bridge.azurewebsites.net/mcp`).
Copy `mcp-client-config.example.json` into a `.mcp.json` for the Claude Code
session that will use it (not this one — see the network caveat below),
filling in the real URL and an auth token/header matching whatever the
hosting resource's auth layer expects.

## Network caveat

This only works from a Claude Code session whose egress policy either (a)
has no outbound allowlist restriction, or (b) explicitly allows the
bridge's hostname. The session this was authored in has neither — see
`docs/mssql-synapse-connection-plan.md` for the diagnosis.
