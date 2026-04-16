import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';

import { registerTeamhoodTools } from './teamhood/tools.js';
import { registerZohoTools } from './zoho/tools.js';
import { createDashboardRouter } from './dashboard.js';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Dashboard routes at /
// ---------------------------------------------------------------------------

app.use(createDashboardRouter());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'node-quote-system',
    version: '1.0.0',
    teamhoodKey: !!process.env.TEAMHOOD_API_KEY,
    zohoKey: !!process.env.ZOHO_CLIENT_ID,
  });
});

// ---------------------------------------------------------------------------
// MCP: create per-session server with all tools
// ---------------------------------------------------------------------------

function createMcpSession() {
  const server = new McpServer(
    { name: 'node-quote-system', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  registerTeamhoodTools(server);
  registerZohoTools(server);
  return server;
}

// ---------------------------------------------------------------------------
// Legacy SSE transport (/sse + /message) — used by Claude Teams
// ---------------------------------------------------------------------------

const sseTransports = new Map();

app.get('/sse', async (req, res) => {
  console.log('[mcp] New SSE connection');
  const transport = new SSEServerTransport('/message', res);
  sseTransports.set(transport.sessionId, transport);
  const server = createMcpSession();
  res.on('close', () => {
    console.log(`[mcp] SSE session ${transport.sessionId} disconnected`);
    sseTransports.delete(transport.sessionId);
    server.close().catch(() => {});
  });
  await server.connect(transport);
  console.log(`[mcp] SSE session ${transport.sessionId} connected`);
});

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: 'Session not found. Connect to /sse first.' });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// ---------------------------------------------------------------------------
// Streamable HTTP transport (/mcp) — newer MCP protocol
// ---------------------------------------------------------------------------

const streamableTransports = new Map();

app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (req.method === 'POST' && !sessionId) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const server = createMcpSession();
    await server.connect(transport);
    transport.onclose = () => {
      if (transport.sessionId) streamableTransports.delete(transport.sessionId);
    };
    await transport.handleRequest(req, res);
    if (transport.sessionId) streamableTransports.set(transport.sessionId, transport);
    return;
  }

  if (sessionId && streamableTransports.has(sessionId)) {
    await streamableTransports.get(sessionId).handleRequest(req, res);
    return;
  }

  res.status(400).json({ error: 'Invalid or missing session' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[node-quote-system] Running on port ${PORT}`);
  console.log(`[node-quote-system] Dashboard:  http://localhost:${PORT}/`);
  console.log(`[node-quote-system] MCP SSE:    http://localhost:${PORT}/sse`);
  console.log(`[node-quote-system] MCP HTTP:   http://localhost:${PORT}/mcp`);
  console.log(`[node-quote-system] Health:     http://localhost:${PORT}/health`);
});
