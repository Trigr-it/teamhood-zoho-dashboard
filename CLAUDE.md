# Node Quote System

Combined Teamhood + Zoho MCP server with quote approval dashboard.
Replaces the separate `teamhood-mcp` and `Zoho-Plug` projects.

## Architecture

Single Express app serving:
- **`/`** — Quote approval dashboard (web UI)
- **`/sse` + `/message`** — MCP SSE endpoint (Claude connections)
- **`/mcp`** — MCP streamable HTTP endpoint
- **`/health`** — Health check
- **`/api/cards`** — Dashboard API (Teamhood cards with pricing)
- **`/api/cards/:id/approve`** — Creates Zoho draft estimate

## Project Structure

```
node-quote-system/
├── src/
│   ├── index.js              # Entry point: Express + MCP (SSE + streamable HTTP)
│   ├── dashboard.js          # Dashboard HTML + API routes (Express Router)
│   ├── approve.js            # Approve workflow: Teamhood card → Zoho estimate
│   ├── teamhood/
│   │   ├── api.js            # Teamhood API client (caching, pagination, ID resolution)
│   │   └── tools.js          # 19 Teamhood MCP tools (McpServer.tool() API)
│   ├── zoho/
│   │   ├── auth.js           # OAuth2 refresh token + org ID management (EU region)
│   │   ├── api.js            # zohoRequest() helper with 429 retry
│   │   └── tools.js          # 36 Zoho MCP tools
│   └── utils/
│       ├── title-parser.js   # Parse [CODE### - Site Name] from card titles
│       ├── client-lookup.js  # Read client-identifiers.txt → code-to-customer map
│       ├── quote-matcher.js  # Text similarity matching against quote reference DB
│       ├── id-resolver.js    # UUID ↔ display ID resolution with cache
│       └── html-strip.js     # HTML → plain text
├── data/
│   └── quote_reference_db.json   # 637 past quotes for pricing intelligence
├── scripts/
│   ├── sync-quotes.js        # Incremental sync from Zoho (not yet converted to ESM)
│   └── discover-ids.js       # Find Teamhood workspace/board UUIDs
├── client-identifiers.txt    # Client code → Zoho customer name mapping (70+ entries)
├── package.json              # ESM, MCP SDK 1.29.0, Express, zod
├── railway.json              # Railway deployment config
└── .env                      # Combined Teamhood + Zoho credentials
```

## Teamhood API Rules

### Base URL (Multi-Tenant)
```
https://api-YOURTENANT.teamhood.com
```
Current tenant: `node` → `https://api-node.teamhood.com`

### Authentication
Header: `X-ApiKey: YOUR_API_KEY`

### Key Patterns
- All endpoints under `/api/v1/`
- Items: `GET /api/v1/items?workspaceId=X&boardId=Y` (query params, not path)
- Server-side filters: `tags=Price Required`, `completed=false`, `archived=false`
- Response envelope: `{ "items": [...] }`, `{ "workspaces": [...] }` etc — unwrap by finding the array
- Field naming: `title` (not `name`), `id` for UUIDs
- Pagination: API ignores `page`/`pageSize`, returns all at once with `nextPageUrl`
- **PUT requires `{ data: { ... } }` envelope** — fields go inside `data`, not flat. Tags are string arrays.

### Endpoint Reference
- `GET /api/v1/workspaces` — list workspaces
- `GET /api/v1/workspaces/{id}/boards` — list boards in workspace
- `GET /api/v1/boards/{id}/rows` — list rows
- `GET /api/v1/boards/{id}/statuses` — list statuses
- `GET /api/v1/items` — list items (requires workspaceId + boardId params)
- `GET /api/v1/items/{id}` — single item
- `POST /api/v1/items` — create item
- `PUT /api/v1/items/{id}` — update item (currently returns 500)
- `GET /api/v1/items/{id}/attachments` — item attachments
- `GET /api/v1/users` — list users (returns 403 with current key)
- No `GET /api/v1/boards/{id}` endpoint — use workspace boards list
- No `GET /api/v1/items/{id}/children` — filter by parentId instead

## Zoho API Rules

### Authentication
OAuth2 refresh token flow (EU region: `zoho.eu`)
- Token URL: `https://accounts.zoho.eu/oauth/v2/token`
- API base: `https://www.zohoapis.eu/invoice/v3`
- Auto-refresh with 60s buffer before expiry

### Key IDs
- Default tax: `70776000000030063` (Standard Rate VAT 20%)
- Salesperson UK: `70776000004849675` (Scaffold Design)
- Salesperson IE: `70776000004920001` (Scaffold Design - Ireland)
- PO Number custom field: `cf_po_number`

## Dashboard & Approve Workflow

### Card Title Format
```
[PRO183 - One North Quay] Full perimeter access scaffold
 ^^^       ^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 client    site name       scope description
 code
```

### Approve Flow
1. Dashboard loads cards via `GET /api/cards` (Teamhood `tags=Price Required`, `archived=false`)
2. Each card matched against 637-quote reference DB using text similarity
3. Same-client quotes prioritised (2x weight), scored by description similarity
4. Suggested rate = score-weighted average, rounded to half-hours (£42.50 increments, £85/hr)
5. User adjusts hours, clicks Approve
6. `POST /api/cards/:id/approve`:
   - Parse title → client code → lookup in `client-identifiers.txt`
   - Search Zoho contacts by customer name → `customer_id`
   - Find or create Zoho project by site name
   - Detect scaffold vs hoist template (hoist = "hoist" in title + "Hoist Spec/Scope" in description)
   - Build line item description from template, populated with card data, fallback to reference quote
   - Set salesperson (UK or IE based on client code)
   - Set PO Number from Teamhood "Client Contact" custom field
   - Create draft estimate on Zoho

### Templates
**Scaffold** — Title, Grid Lines, 3D Model, System, Load Class, Cladding, Ties, Length/Width/Height, Ancillaries
**Hoist** — Title, Grid Lines, Max Height, 3D Model, Machine Type, Payload, Tie Type, Landings, Landing Type, Foundation, Ancillaries

### Quote Matching
- Text similarity (Jaccard-like word overlap) not just keywords
- Scoring weights: description-to-description (50%), reference-to-scope (30%), description-to-scope (20%)
- Same-client quotes searched first, 2x weight in rate calculation
- Fill from other clients if not enough same-client matches

## Business Rules (MUST FOLLOW)

1. **BFT cards always excluded** from dashboard and quote workflow
2. **Completed cards included** — design done ≠ pricing done
3. **Archived cards excluded**
4. **Always use `assignedUserId`** — never `ownerId` (owner = creator, not assignee)
5. **Irish client codes**: LAO, MSL, GCS, AIN, 3SC, BHL, GAB, GRP → IE salesperson, no VAT
6. **Rates in half-hour increments** — all pricing based on hours × £85/hr
7. **Teamhood PUT needs `{ data: {} }` envelope** — approve flow auto-removes "Price Required" tag
8. **Line item name**: "- Design & Analysis (UK)", "- Design & Analysis (IE)", or "- Design & Analysis (Hoist)"

## Environment Variables

```
# Teamhood
TEAMHOOD_API_KEY=
TEAMHOOD_API_BASE_URL=https://api-node.teamhood.com
TEAMHOOD_WORKSPACE_ID=
TEAMHOOD_BOARD_ID=
TEAMHOOD_USER_MAP={}    # JSON: UUID → first name (8 designers)

# Zoho (EU)
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_TOKEN_URL=https://accounts.zoho.eu/oauth/v2/token
ZOHO_API_BASE=https://www.zohoapis.eu/invoice/v3

# Server
PORT=3000
```

## Running Locally

```bash
cd /mnt/e/Development/node-quote-system
PORT=3457 node --env-file=.env src/index.js
# Dashboard: http://localhost:3457
```

## Deployment

- **GitHub**: https://github.com/Trigr-it/teamhood-zoho-dashboard (auto-deploys on push)
- **Railway**: eoelatjy.up.railway.app
- **Custom domain**: https://zoho.nodegroup.co.uk
- **DNS**: CNAME on Netlify (zoho → eoelatjy.up.railway.app)
- **Auth**: HTTP Basic Auth on dashboard (DASH_PASSWORD env var). MCP endpoints unauthenticated.
- **Env vars on Railway**: TEAMHOOD_* (5), ZOHO_* (5), PORT, DASH_PASSWORD

## Live Quotes Tab

Second tab showing sent/accepted Zoho estimates not yet marked for invoicing.
- "Ready for Invoice" button sets `cf_invoice_status` to `C01 - Full Invoice`
- Quote removed from view after marking
- Sorted by most recent first
- Shows sub total (main) and total inc. VAT (secondary)

## Styling

Matches Node Group website (nodegroup.co.uk):
- Light mode, warm off-white background (#F7F6F2)
- Orange accent (#FF6700)
- DM Sans body font, DM Mono for technical labels
- N moniker logo (public/n-logo-orange.png)
- 3px border-radius, 1.5px borders in warm grey (#D8D4C8)

## Team

8 designers on the Teamhood board:
- Noam, Derek, Darren, Rory, Lorcan, Fereshteh, Mariana, Klea

Node Group is a scaffolding design company. Cards represent scaffold/hoist design projects for various scaffolding contractor clients.
