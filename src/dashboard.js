import { Router } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as api from './teamhood/api.js';
import { zohoRequest } from './zoho/api.js';
import { parseCardTitle } from './utils/title-parser.js';
import { lookupClient } from './utils/client-lookup.js';
import { findSimilarQuotes } from './utils/quote-matcher.js';
import { approveCard } from './approve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXCLUDED_CLIENT_CODES = new Set(['BFT']);

// ---------------------------------------------------------------------------
// Quote reference DB loader (for financial dashboard)
// ---------------------------------------------------------------------------

function loadQuoteDb() {
  const dbPath = process.env.QUOTE_DB_PATH || join(__dirname, '../data/quote_reference_db.json');
  try { return JSON.parse(readFileSync(dbPath, 'utf-8')); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createDashboardRouter() {
  const router = Router();

  // --- API: List price-required cards with pricing ---
  router.get('/api/cards', async (_req, res) => {
    try {
      const cards = await api.listCards({
        parent_only: true,
        serverTag: 'Price Required',
        archived: false,
      });

      const filtered = cards.filter(card => {
        const parsed = parseCardTitle(card.title);
        return !(parsed.clientCode && EXCLUDED_CLIENT_CODES.has(parsed.clientCode));
      });

      const result = filtered
        .map(card => {
          const parsed = parseCardTitle(card.title);
          const client = lookupClient(parsed.clientCode);
          const pricing = findSimilarQuotes(card.title, parsed.scope, client?.customerName, 5);
          return {
            id: card.id,
            displayId: card.displayId,
            title: card.title,
            description: card.description || '',
            clientCode: parsed.clientCode,
            zohoCustomerName: client ? client.customerName : null,
            siteName: parsed.siteName,
            scope: parsed.scope,
            assignedUserName: card.assignedUserName,
            suggestedRate: pricing.suggestedRate,
            matchedKeywords: pricing.keywords,
            topMatch: pricing.similarQuotes[0] ? {
              estimateNumber: pricing.similarQuotes[0].estimateNumber,
              reference: pricing.similarQuotes[0].reference,
              total: pricing.similarQuotes[0].total,
              matchScore: pricing.similarQuotes[0].matchScore,
            } : null,
            similarQuotes: pricing.similarQuotes.map(sq => ({
              estimateNumber: sq.estimateNumber,
              client: sq.client,
              reference: sq.reference,
              total: sq.total,
              matchScore: sq.matchScore,
              isClientMatch: sq.isClientMatch,
              date: sq.date,
            })),
            siteVisit: (card.customFields || []).some(f => f.name === 'Site Visit' && f.value === 'true'),
            customFields: card.customFields,
            url: card.url,
            updatedAt: card.updatedAt,
          };
        })
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

      res.json({ success: true, quotes: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- API: Get attachments for a card (lazy-loaded) ---
  router.get('/api/cards/:cardId/attachments', async (req, res) => {
    try {
      const atts = await api.getCardAttachments(req.params.cardId);
      res.json({ success: true, attachments: atts.map(a => ({
        id: a.id, name: a.name, mimeType: a.mimeType || '', size: a.size || 0,
      })) });
    } catch (err) {
      res.json({ success: true, attachments: [] });
    }
  });

  // --- API: Proxy Teamhood attachment content (requires API key) ---
  router.get('/api/attachments/:id', async (req, res) => {
    try {
      const attUrl = `${process.env.TEAMHOOD_API_BASE_URL || 'https://api-node.teamhood.com'}/api/v1/attachments/${req.params.id}/content`;
      const attRes = await fetch(attUrl, {
        headers: { 'X-ApiKey': process.env.TEAMHOOD_API_KEY },
      });
      if (!attRes.ok) return res.status(attRes.status).send('Attachment not found');
      res.set('Content-Type', attRes.headers.get('content-type') || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=3600');
      const buffer = Buffer.from(await attRes.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      res.status(500).send('Error fetching attachment');
    }
  });

  // --- API: Approve a card → create Zoho estimate ---
  router.post('/api/cards/:cardId/approve', async (req, res) => {
    try {
      const { rate, quantity, lineItemName, lineItemDescription } = req.body;
      const result = await approveCard(req.params.cardId, {
        rate: parseFloat(rate) || 0,
        quantity: parseInt(quantity) || 1,
        lineItemName,
        lineItemDescription,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- API: Remove "Price Required" tag (mark as done without creating estimate) ---
  router.post('/api/cards/:cardId/done', async (req, res) => {
    try {
      const result = await api.removeTag(req.params.cardId, 'Price Required');
      res.json({ success: true, displayId: result?.displayId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- API: List live quotes (sent/accepted, not yet marked for invoice) ---
  router.get('/api/live-quotes', async (_req, res) => {
    try {
      const allEstimates = [];
      for (const status of ['sent', 'accepted']) {
        let page = 1;
        while (true) {
          const data = await zohoRequest('GET', `/estimates?per_page=200&page=${page}&status=${status}&sort_column=date&sort_order=D`);
          allEstimates.push(...(data.estimates || []));
          if (!data.page_context?.has_more_page) break;
          page++;
        }
      }

      const liveQuotes = [];
      for (let i = 0; i < allEstimates.length; i += 5) {
        const batch = allEstimates.slice(i, i + 5);
        const details = await Promise.all(batch.map(est =>
          zohoRequest('GET', `/estimates/${est.estimate_id}`)
        ));
        for (const detail of details) {
          const est = detail.estimate;
          if (!est) continue;
          const invoiceStatus = (est.custom_fields || []).find(f => f.api_name === 'cf_invoice_status')?.value || '-';
          if (invoiceStatus === 'C01 - Full Invoice') continue;
          liveQuotes.push({
            estimateId: est.estimate_id,
            estimateNumber: est.estimate_number,
            date: est.date,
            status: est.status,
            customer: est.customer_name,
            customerId: est.customer_id,
            project: est.project?.project_name || '',
            reference: est.reference_number || '',
            salesperson: est.salesperson_name || '',
            salespersonId: est.salesperson_id || '',
            invoiceStatus,
            total: est.total,
            subTotal: est.sub_total,
            lineItems: (est.line_items || []).map(li => ({
              name: li.name, description: li.description || '', quantity: li.quantity, rate: li.rate, total: li.item_total,
            })),
          });
        }
        if (i + 5 < allEstimates.length) await new Promise(r => setTimeout(r, 200));
      }

      res.json({ success: true, quotes: liveQuotes });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- API: Mark quote as ready for invoice ---
  router.post('/api/live-quotes/:estimateId/invoice-ready', async (req, res) => {
    try {
      const { estimateId } = req.params;
      const result = await zohoRequest('PUT', `/estimates/${estimateId}`, {
        custom_fields: [{ api_name: 'cf_invoice_status', value: 'C01 - Full Invoice' }],
      });
      if (result.code && result.code !== 0) {
        throw new Error(result.message || JSON.stringify(result));
      }
      res.json({
        success: true,
        estimateNumber: result.estimate?.estimate_number,
        message: 'Marked as ready for invoice',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- API: Update salesperson on an estimate ---
  router.post('/api/live-quotes/:estimateId/salesperson', async (req, res) => {
    try {
      const { estimateId } = req.params;
      const { salesperson_id } = req.body;
      if (!salesperson_id) throw new Error('salesperson_id is required');
      const result = await zohoRequest('PUT', `/estimates/${estimateId}`, {
        salesperson_id,
      });
      if (result.code && result.code !== 0) {
        throw new Error(result.message || JSON.stringify(result));
      }
      res.json({
        success: true,
        salesperson: result.estimate?.salesperson_name || '',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- API: Decline an estimate ---
  router.post('/api/live-quotes/:estimateId/decline', async (req, res) => {
    try {
      const { estimateId } = req.params;
      const result = await zohoRequest('POST', `/estimates/${estimateId}/status/declined`);
      if (result.code && result.code !== 0) {
        throw new Error(result.message || JSON.stringify(result));
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- API: Dashboard summary (invoices from Zoho + quotes from reference DB) ---
  router.get('/api/dashboard/summary', async (req, res) => {
    try {
      const { from_date, to_date, client, salesperson } = req.query;

      // --- Zoho Sales by Customer report (ex-VAT figures matching Zoho reports) ---
      const reportFrom = from_date || `${new Date().getFullYear()}-01-01`;
      const reportTo = to_date || new Date().toISOString().split('T')[0];
      let reportUrl = `/reports/salesbycustomer?per_page=200&from_date=${reportFrom}&to_date=${reportTo}`;
      const reportData = await zohoRequest('GET', reportUrl);
      let salesReport = reportData.sales || [];

      // --- Fetch invoice list for monthly/salesperson breakdowns + outstanding ---
      const allInvoices = [];
      let page = 1;
      while (true) {
        let url = `/invoices?per_page=200&page=${page}&sort_column=date&sort_order=D`;
        if (from_date) url += `&date_start=${from_date}`;
        if (to_date) url += `&date_end=${to_date}`;
        const data = await zohoRequest('GET', url);
        allInvoices.push(...(data.invoices || []));
        if (!data.page_context?.has_more_page) break;
        page++;
      }

      // Exclude void invoices
      let invoices = allInvoices.filter(inv => inv.status !== 'void');
      if (client) invoices = invoices.filter(inv => inv.customer_name === client);
      if (salesperson) invoices = invoices.filter(inv => inv.salesperson_name === salesperson);

      // Derive ex-VAT from invoice total: Ireland salespersons = 0% VAT, all others = 20%
      function exVat(inv) {
        const sp = (inv.salesperson_name || '').toLowerCase();
        if (sp.includes('ireland')) return inv.total || 0;
        return Math.round(((inv.total || 0) / 1.2) * 100) / 100;
      }
      function exVatBalance(inv) {
        const sp = (inv.salesperson_name || '').toLowerCase();
        if (sp.includes('ireland')) return inv.balance || 0;
        return Math.round(((inv.balance || 0) / 1.2) * 100) / 100;
      }

      // Revenue KPIs (all ex-VAT)
      if (client) salesReport = salesReport.filter(s => s.customer_name === client);
      const invoiceRevenue = salesperson
        ? invoices.reduce((s, inv) => s + exVat(inv), 0)
        : salesReport.reduce((s, e) => s + parseFloat(e.sales || 0), 0);
      const totalInvoices = invoices.length;
      const avgInvoiceValue = totalInvoices > 0 ? Math.round(invoiceRevenue / totalInvoices) : 0;
      const outstandingAmount = invoices
        .filter(inv => (inv.balance || 0) > 0)
        .reduce((s, inv) => s + exVatBalance(inv), 0);

      // Sales by customer (ex-VAT)
      let salesByCustomer;
      if (salesperson) {
        const byCustomer = {};
        for (const inv of invoices) {
          const name = inv.customer_name || 'Unknown';
          if (!byCustomer[name]) byCustomer[name] = { client: name, total: 0, count: 0 };
          byCustomer[name].total += exVat(inv);
          byCustomer[name].count++;
        }
        salesByCustomer = Object.values(byCustomer).sort((a, b) => b.total - a.total).slice(0, 20);
      } else {
        salesByCustomer = salesReport
          .map(s => ({ client: s.customer_name, total: parseFloat(s.sales || 0), count: parseInt(s.count || 0) }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 20);
      }

      // Sales by salesperson (ex-VAT)
      const bySalesperson = {};
      for (const inv of invoices) {
        const sp = inv.salesperson_name || 'Unassigned';
        if (!bySalesperson[sp]) bySalesperson[sp] = { salesperson: sp, total: 0, count: 0 };
        bySalesperson[sp].total += exVat(inv);
        bySalesperson[sp].count++;
      }
      const salesBySalesperson = Object.values(bySalesperson).sort((a, b) => b.total - a.total);

      // Monthly revenue (ex-VAT)
      const byMonth = {};
      for (const inv of invoices) {
        if (!inv.date) continue;
        const month = inv.date.substring(0, 7);
        if (!byMonth[month]) byMonth[month] = { month, total: 0, count: 0 };
        byMonth[month].total += exVat(inv);
        byMonth[month].count++;
      }
      const monthlySales = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));

      // --- Quote metrics from reference DB ---
      const db = loadQuoteDb();
      let quotes = db;
      if (from_date) quotes = quotes.filter(e => e.date >= from_date);
      if (to_date) quotes = quotes.filter(e => e.date <= to_date);
      if (client) quotes = quotes.filter(e => e.client === client);
      if (salesperson) quotes = quotes.filter(e => e.salesperson === salesperson);

      const totalQuotes = quotes.length;
      const qInvoiced = quotes.filter(e => e.status === 'invoiced' || e.status === 'partially_invoiced').length;
      const qSent = quotes.filter(e => e.status === 'sent').length;
      const qAccepted = quotes.filter(e => e.status === 'accepted').length;
      const conversionRate = (qSent + qAccepted + qInvoiced) > 0
        ? Math.round((qInvoiced / (qSent + qAccepted + qInvoiced)) * 100)
        : 0;
      const pipelineValue = quotes
        .filter(e => e.status === 'sent' || e.status === 'accepted')
        .reduce((s, e) => s + (e.total || 0), 0);

      // Quote pipeline by status
      const byStatus = {};
      for (const e of quotes) {
        const st = e.status || 'unknown';
        if (!byStatus[st]) byStatus[st] = { status: st, total: 0, count: 0 };
        byStatus[st].total += e.total || 0;
        byStatus[st].count++;
      }
      const pipeline = Object.values(byStatus);

      // Filter options (union of invoice + quote clients)
      const clients = [...new Set([
        ...allInvoices.map(inv => inv.customer_name),
        ...db.map(e => e.client),
      ].filter(Boolean))].sort();
      const salespersons = [...new Set([
        ...allInvoices.map(inv => inv.salesperson_name),
        ...db.map(e => e.salesperson),
      ].filter(Boolean))].sort();

      res.json({
        success: true,
        kpis: {
          invoiceRevenue,
          totalInvoices,
          avgInvoiceValue,
          outstandingAmount,
          totalQuotes,
          conversionRate,
          pipelineValue,
        },
        salesByCustomer,
        salesBySalesperson,
        monthlySales,
        pipeline,
        filterOptions: { clients, salespersons },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- UI Routes ---
  router.get('/', (_req, res) => res.send(pageShell('Home', 'home', '', landingPage())));
  router.get('/pricing', (_req, res) => res.send(pageShell('Pricing', 'pricing', '', pricingPage())));
  router.get('/live-quotes', (_req, res) => res.send(pageShell('Live Quotes', 'live-quotes', '', liveQuotesPage())));
  router.get('/dashboard', (_req, res) => res.send(pageShell('Dashboard', 'dashboard',
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>', dashboardPage())));

  return router;
}

// ---------------------------------------------------------------------------
// Shared page shell
// ---------------------------------------------------------------------------

function pageShell(title, activeNav, headExtra, bodyContent) {
  const navItems = [
    { key: 'home', label: 'Home', href: '/' },
    { key: 'pricing', label: 'Pricing', href: '/pricing' },
    { key: 'live-quotes', label: 'Live Quotes', href: '/live-quotes' },
    { key: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  ];
  const navHtml = navItems.map(n =>
    `<a href="${n.href}" class="nav-link${n.key === activeNav ? ' nav-active' : ''}">${n.label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Node Group \u2014 ${title}</title>
  <link rel="icon" type="image/png" href="/public/n-logo-orange.png">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root { --o:#FF6700; --od:#CC5200; --ol:#FFF0E6; --ob:#FFCAA8; --k:#1A1A1A; --w:#FFFFFF; --bg:#F7F6F2; --bg2:#F0EEE8; --sb:#D8D4C8; --s:#727272; --mu:#999990; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'DM Sans', 'Futura', 'Century Gothic', sans-serif; background: var(--bg); color: var(--k); line-height: 1.5; }
    a { color: var(--o); text-decoration: none; font-weight: 600; }
    a:hover { color: var(--od); }
    .site-header { background: var(--w); border-bottom: 1.5px solid var(--sb); padding: 0 24px; display: flex; align-items: center; height: 56px; gap: 20px; }
    .logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
    .logo:hover { color: var(--k); }
    .logo img { width: 32px; height: 32px; border-radius: 4px; }
    .logo-text { font-size: 15px; font-weight: 800; color: var(--k); letter-spacing: -0.02em; text-transform: uppercase; }
    .nav { display: flex; gap: 4px; margin-left: 24px; }
    .nav-link { padding: 8px 14px; border-radius: 3px; font-size: 13px; font-weight: 600; color: var(--mu); transition: all 0.15s; text-transform: uppercase; letter-spacing: 0.04em; }
    .nav-link:hover { color: var(--k); background: var(--bg2); text-decoration: none; }
    .nav-active { color: var(--o); background: var(--ol); }
    .page { padding: 24px; max-width: 1400px; margin: 0 auto; }
    h1 { font-size: 22px; font-weight: 800; color: var(--o); letter-spacing: -0.02em; text-transform: uppercase; }
    .subtitle { color: var(--s); margin-bottom: 20px; font-size: 14px; }
    .loading { text-align: center; padding: 60px; color: var(--mu); font-size: 14px; }
    .error { background: #fff0f0; border: 1.5px solid #cc3300; color: #cc3300; padding: 12px 16px; border-radius: 3px; margin-bottom: 16px; }
    @media (max-width: 600px) {
      .site-header { flex-wrap: wrap; height: auto; padding: 12px 16px; gap: 8px; }
      .nav { margin-left: 0; gap: 2px; }
      .nav-link { padding: 6px 10px; font-size: 11px; }
      .page { padding: 16px; }
    }
  </style>
  ${headExtra || ''}
</head>
<body>
  <header class="site-header">
    <a href="/" class="logo">
      <img src="/public/n-logo-orange.png" alt="N">
      <span class="logo-text">Node Group</span>
    </a>
    <nav class="nav">${navHtml}</nav>
  </header>
  <div class="page">
    ${bodyContent}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

function landingPage() {
  return `
    <div style="max-width:960px;margin:40px auto 0;">
      <h1 style="font-size:28px;margin-bottom:8px;">Node Group Portal</h1>
      <p class="subtitle">Scaffold design management tools</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-top:32px;">
        <a href="/pricing" style="text-decoration:none;">
          <div class="tile-card">
            <div class="tile-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--o)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
            </div>
            <div class="tile-title">Pricing</div>
            <div class="tile-desc">Review Teamhood cards tagged &ldquo;Price Required&rdquo; and approve Zoho estimates</div>
          </div>
        </a>
        <a href="/live-quotes" style="text-decoration:none;">
          <div class="tile-card">
            <div class="tile-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--o)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <div class="tile-title">Live Quotes</div>
            <div class="tile-desc">Sent and accepted quotes not yet marked for invoicing</div>
          </div>
        </a>
        <a href="/dashboard" style="text-decoration:none;">
          <div class="tile-card">
            <div class="tile-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--o)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
            </div>
            <div class="tile-title">Dashboard</div>
            <div class="tile-desc">Financial overview with sales charts, KPIs, and pipeline tracking</div>
          </div>
        </a>
      </div>
    </div>
    <style>
      .tile-card { background: var(--w); border: 1.5px solid var(--sb); border-radius: 6px; padding: 32px; transition: all 0.2s; }
      .tile-card:hover { border-color: var(--o); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(255,103,0,0.1); }
      .tile-icon { margin-bottom: 16px; }
      .tile-title { font-size: 18px; font-weight: 700; color: var(--k); margin-bottom: 8px; }
      .tile-desc { font-size: 13px; color: var(--s); line-height: 1.5; font-weight: 400; }
    </style>`;
}

// ---------------------------------------------------------------------------
// Pricing page (existing quote dashboard with tabs)
// ---------------------------------------------------------------------------

function pricingPage() {
  return `
  <style>
    .pricing-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1.5px solid var(--sb); }
    .btn-refresh { background: var(--o); color: var(--w); border: none; padding: 10px 20px; border-radius: 3px; cursor: pointer; font-size: 13px; font-weight: 700; font-family: inherit; transition: all 0.2s; }
    .btn-refresh:hover { background: var(--od); transform: translateY(-1px); }
    .btn-refresh:disabled { background: var(--sb); color: var(--mu); cursor: wait; }
    .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .stat { background: var(--w); border: 1.5px solid var(--sb); border-radius: 3px; padding: 14px 18px; min-width: 130px; }
    .stat-value { font-size: 26px; font-weight: 800; color: var(--o); }
    .stat-label { font-family: 'DM Mono', monospace; font-size: 9px; color: var(--mu); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.08em; }
    .filters { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
    .filters input, .filters select { background: var(--w); border: 1.5px solid var(--sb); color: var(--k); padding: 8px 12px; border-radius: 3px; font-size: 13px; font-family: inherit; }
    .filters input:focus, .filters select:focus { outline: none; border-color: var(--o); }
    .filters input { width: 250px; }
    table { width: 100%; border-collapse: collapse; background: var(--w); border: 1.5px solid var(--sb); }
    thead { background: var(--bg2); }
    th { text-align: left; padding: 10px 14px; font-family: 'DM Mono', monospace; font-size: 9px; font-weight: 500; color: var(--mu); text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1.5px solid var(--sb); }
    td { padding: 10px 14px; border-bottom: 1px solid var(--sb); font-size: 13px; vertical-align: top; }
    tr:hover { background: var(--ol); }
    .client-code { font-weight: 700; color: var(--o); font-family: 'DM Mono', monospace; font-size: 11px; }
    .scope { color: var(--s); max-width: 300px; }
    .rate { font-weight: 700; font-size: 15px; color: var(--k); }
    .rate-range { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--mu); }
    .match { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--mu); }
    .match-score { color: var(--o); font-weight: 700; }
    .assignee { color: var(--s); font-size: 12px; font-weight: 600; }
    .unmapped { color: #cc3300; font-size: 10px; font-weight: 600; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 2px; font-family: 'DM Mono', monospace; font-size: 9px; font-weight: 500; background: var(--ol); color: var(--od); margin: 1px; text-transform: uppercase; letter-spacing: 0.04em; }
    .kw-col { max-width: 120px; }
    .btn-approve { background: var(--o); color: var(--w); border: none; padding: 8px 16px; border-radius: 3px; cursor: pointer; font-size: 13px; font-weight: 700; font-family: inherit; transition: all 0.2s; }
    .btn-approve:hover { background: var(--od); transform: translateY(-1px); }
    .btn-approve:disabled { background: var(--sb); color: var(--mu); cursor: not-allowed; }
    .btn-approve.approved { background: var(--s); cursor: default; }
    .btn-done { background: var(--bg2); color: var(--s); border: 1.5px solid var(--sb); padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600; font-family: inherit; transition: all 0.2s; margin-top: 4px; display: block; width: 100%; }
    .btn-done:hover { background: var(--sb); color: var(--k); }
    .btn-done:disabled { background: var(--sb); color: var(--mu); cursor: not-allowed; }
    .hours-input { background: var(--w); border: 1.5px solid var(--sb); color: var(--k); padding: 4px 8px; border-radius: 3px; width: 60px; font-size: 14px; font-family: 'DM Mono', monospace; text-align: right; }
    .hours-input:focus { outline: none; border-color: var(--o); }
    .rate-value { font-weight: 700; color: var(--o); font-size: 13px; margin-left: 4px; font-family: 'DM Mono', monospace; }
    .success-msg { font-size: 11px; color: #2d8a3e; margin-top: 4px; font-weight: 600; }
    .error-msg { font-size: 11px; color: #cc3300; margin-top: 4px; font-weight: 600; }
    .expand-btn { cursor: pointer; color: var(--o); font-size: 12px; font-weight: 700; }
    .detail-row { display: none; }
    .detail-row.open { display: table-row; }
    .detail-cell { background: var(--bg2); padding: 16px !important; font-size: 12px; color: var(--s); }
    .load-time { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--mu); margin-left: 12px; }
    .mobile-cards { display: none; }
    .mobile-card { background: var(--w); border: 1.5px solid var(--sb); border-radius: 3px; padding: 14px; margin-bottom: 10px; }
    .mobile-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
    .mobile-card-id { color: var(--o); font-weight: 700; font-size: 13px; }
    .mobile-card-client { font-size: 12px; color: var(--mu); }
    .mobile-card-site { font-size: 14px; font-weight: 700; color: var(--k); margin-bottom: 4px; }
    .mobile-card-scope { font-size: 12px; color: var(--s); margin-bottom: 8px; }
    .mobile-card-pricing { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 8px; background: var(--bg2); border-radius: 3px; border: 1px solid var(--sb); }
    .mobile-card-suggested { text-align: left; }
    .mobile-card-suggested .rate { font-size: 16px; }
    .mobile-card-match { text-align: right; font-family: 'DM Mono', monospace; font-size: 10px; color: var(--mu); }
    .mobile-card-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .mobile-card-actions .hours-input { flex: 0 0 50px; }
    .mobile-card-actions .rate-value { flex: 0 0 60px; text-align: right; }
    .mobile-card-actions .btn-approve { flex: 1; }
    .hours-stepper { display: none; align-items: center; gap: 0; }
    .hours-stepper .hours-input { border-radius: 0; border-left: none; border-right: none; text-align: center; width: 50px; }
    .btn-step { background: var(--bg2); border: 1.5px solid var(--sb); color: var(--k); width: 32px; height: 32px; font-size: 18px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; font-family: inherit; transition: background 0.15s; }
    .btn-step:hover { background: var(--sb); }
    .btn-step:first-child { border-radius: 3px 0 0 3px; }
    .btn-step:last-child { border-radius: 0 3px 3px 0; }
    @media (max-width: 900px) { .hours-stepper { display: flex; } }
    .detail-desc { margin-bottom: 12px; }
    .detail-desc-text { white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word; font-size: 12px; color: var(--s); margin-top: 4px; padding: 8px; background: var(--w); border: 1px solid var(--sb); border-radius: 3px; max-height: 200px; overflow-y: auto; }
    .detail-atts { margin-bottom: 12px; }
    .detail-atts-grid { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .att-thumb img { max-width: 120px; max-height: 90px; border: 1px solid var(--sb); border-radius: 3px; object-fit: cover; display: block; }
    .att-file { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: var(--w); border: 1px solid var(--sb); border-radius: 3px; font-size: 11px; color: var(--s); text-decoration: none; }
    .att-icon { font-weight: 700; color: var(--o); }
    .mobile-card-detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--sb); font-size: 11px; color: var(--s); display: none; overflow: hidden; }
    .mobile-card-detail.open { display: block; }
    .mobile-card-detail .detail-desc-text { font-size: 11px; max-height: 150px; }
    .mobile-card-detail .att-thumb img { max-width: 80px; max-height: 60px; }
    .mobile-card-detail .att-file { font-size: 10px; padding: 4px 8px; }
    .mobile-card-detail .detail-atts-grid { gap: 6px; }
    .mobile-card-tags { margin: 6px 0; }
    .mobile-card-assignee { color: var(--s); font-size: 12px; font-weight: 600; }
    .mobile-card-expand { color: var(--o); font-size: 12px; font-weight: 700; cursor: pointer; display: inline-block; margin-top: 6px; }
    @media (max-width: 900px) {
      .page { padding: 12px; }
      h1 { font-size: 16px; }
      .stats { gap: 8px; }
      .stat { padding: 10px 14px; min-width: 80px; }
      .stat-value { font-size: 20px; }
      .filters input { width: 100%; }
      .filters { flex-direction: column; gap: 8px; }
      .filters select { width: 100%; }
      .desktop-table { display: none; }
      .mobile-cards { display: block; }
    }
  </style>

  <div class="pricing-header">
    <h1>Pricing</h1>
    <div>
      <span class="load-time" id="loadTime"></span>
      <button class="btn-refresh" id="refreshBtn" onclick="loadQuotes()">Refresh</button>
    </div>
  </div>

  <div class="stats" id="stats"></div>
  <div class="filters">
    <input type="text" id="search" placeholder="Search cards..." oninput="filterTable()">
    <select id="clientFilter" onchange="filterTable()"><option value="">All clients</option></select>
    <select id="assigneeFilter" onchange="filterTable()"><option value="">All assignees</option></select>
  </div>
  <div id="error"></div>
  <div id="content"><div class="loading">Loading quotes from Teamhood...</div></div>

  <script>
    let allQuotes = [];

    async function loadQuotes() {
      const btn = document.getElementById('refreshBtn');
      btn.disabled = true;
      btn.textContent = 'Loading...';
      document.getElementById('error').innerHTML = '';
      const start = Date.now();

      try {
        const res = await fetch('/api/cards');
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        allQuotes = data.quotes;
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        document.getElementById('loadTime').textContent = 'Loaded in ' + elapsed + 's';
        renderStats();
        populateFilters();
        renderTable();
      } catch (err) {
        document.getElementById('error').innerHTML = '<div class="error">' + err.message + '</div>';
        document.getElementById('content').innerHTML = '';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Refresh';
      }
    }

    function renderStats() {
      const total = allQuotes.length;
      const withPrice = allQuotes.filter(q => q.suggestedRate).length;
      const unmapped = allQuotes.filter(q => !q.zohoCustomerName).length;
      const clients = new Set(allQuotes.map(q => q.zohoCustomerName || q.clientCode)).size;
      const totalValue = allQuotes.reduce((sum, q) => sum + (q.suggestedRate?.median || 0), 0);

      document.getElementById('stats').innerHTML =
        '<div class="stat"><div class="stat-value">' + total + '</div><div class="stat-label">Cards to Quote</div></div>' +
        '<div class="stat"><div class="stat-value">' + withPrice + '</div><div class="stat-label">With Pricing</div></div>' +
        '<div class="stat"><div class="stat-value">' + clients + '</div><div class="stat-label">Clients</div></div>' +
        '<div class="stat"><div class="stat-value">&pound;' + totalValue.toLocaleString() + '</div><div class="stat-label">Est. Total Value</div></div>' +
        (unmapped > 0 ? '<div class="stat"><div class="stat-value" style="color:#f85149">' + unmapped + '</div><div class="stat-label">Unmapped Clients</div></div>' : '');
    }

    function populateFilters() {
      const clients = [...new Set(allQuotes.map(q => q.zohoCustomerName || q.clientCode).filter(Boolean))].sort();
      const assignees = [...new Set(allQuotes.map(q => q.assignedUserName).filter(Boolean))].sort();

      const cf = document.getElementById('clientFilter');
      const af = document.getElementById('assigneeFilter');
      cf.innerHTML = '<option value="">All clients</option>';
      af.innerHTML = '<option value="">All assignees</option>';
      clients.forEach(c => { const o = document.createElement('option'); o.value = c; o.text = c; cf.add(o); });
      assignees.forEach(a => { const o = document.createElement('option'); o.value = a; o.text = a; af.add(o); });
    }

    function getFilteredQuotes() {
      const search = document.getElementById('search').value.toLowerCase();
      const client = document.getElementById('clientFilter').value;
      const assignee = document.getElementById('assigneeFilter').value;
      let filtered = allQuotes.filter(q => {
        const text = (q.title + ' ' + q.scope + ' ' + q.displayId + ' ' + (q.zohoCustomerName || '') + ' ' + (q.siteName || '')).toLowerCase();
        const matchSearch = !search || text.includes(search);
        const matchClient = !client || (q.zohoCustomerName || q.clientCode) === client;
        const matchAssignee = !assignee || q.assignedUserName === assignee;
        return matchSearch && matchClient && matchAssignee;
      });
      if (client) {
        filtered.sort((a, b) => (a.siteName || '').localeCompare(b.siteName || ''));
      }
      return filtered;
    }

    function filterTable() { renderTable(getFilteredQuotes()); }

    function toggleDetail(id) {
      const row = document.querySelector('.detail-row[data-id="' + id + '"]');
      if (row) {
        row.classList.toggle('open');
        row.style.display = row.classList.contains('open') ? '' : 'none';
      }
    }

    async function approveQuote(id, btn) {
      const q = allQuotes.find(q => q.id === id);
      if (!q) return;
      const hoursInput = document.getElementById('hours-' + id) || document.getElementById('m-hours-' + id);
      const hours = parseFloat(hoursInput?.value) || 0;
      if (hours <= 0) { alert('Please enter hours before approving.'); return; }
      const rate = hours * 85;
      if (!q.zohoCustomerName) { alert('Cannot approve: client code "' + q.clientCode + '" is not mapped in client-identifiers.txt'); return; }
      if (!confirm('Create Zoho draft estimate for ' + q.displayId + ' (' + q.zohoCustomerName + ') at ' + hours + 'hrs = ' + String.fromCharCode(163) + rate + '?')) return;

      btn.disabled = true;
      btn.textContent = 'Creating...';
      const msgEl = document.createElement('div');
      btn.parentElement.appendChild(msgEl);

      try {
        const res = await fetch('/api/cards/' + id + '/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rate, quantity: 1 }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        btn.textContent = 'Approved';
        btn.classList.add('approved');
        msgEl.className = 'success-msg';
        msgEl.textContent = data.estimateNumber + ' created' + (data.tagRemoved ? ' (tag removed)' : '');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Approve';
        msgEl.className = 'error-msg';
        msgEl.textContent = err.message;
      }
    }

    function renderTable(quotes) {
      const list = quotes || allQuotes;

      function cardData(q) {
        const rate = q.suggestedRate;
        const rateDisplay = rate ? '&pound;' + (rate.weighted || rate.median) : '-';
        const rangeDisplay = rate ? '&pound;' + rate.min + ' - &pound;' + rate.max : '';
        const match = q.topMatch;
        const matchDisplay = match ? match.estimateNumber + ' &pound;' + match.total : '-';
        const matchScoreDisplay = match ? '<span class="match-score">' + match.matchScore + '</span>' : '';
        const svTag = q.siteVisit ? '<span class="tag" style="background:#e6f4ea;color:#2d8a3e;">Site Visit</span> ' : '';
        const kwDisplay = svTag + (q.matchedKeywords || []).map(k => '<span class="tag">' + k + '</span>').join(' ');
        const clientDisplay = q.zohoCustomerName
          ? '<span class="client-code">' + q.clientCode + '</span> ' + q.zohoCustomerName
          : '<span class="client-code">' + (q.clientCode || '?') + '</span> <span class="unmapped">unmapped</span>';
        const defaultRate = rate?.weighted || rate?.median || 0;
        const defaultHours = defaultRate > 0 ? (defaultRate / 85).toFixed(1) : '0';
        const hoursLine = rate?.hours ? '<span style="color:#d29922;font-size:12px;">' + rate.hours + ' hrs</span>' : '';
        return { rate, rateDisplay, rangeDisplay, match, matchDisplay, matchScoreDisplay, kwDisplay, clientDisplay, defaultRate, defaultHours, hoursLine };
      }

      function detailHtml(q) {
        let html = '';
        // Description
        if (q.description) {
          html += '<div class="detail-desc"><strong>Description:</strong><div class="detail-desc-text">' + q.description + '</div></div>';
        }
        // Attachments placeholder (lazy-loaded on expand)
        html += '<div class="detail-atts" id="atts-' + q.id + '"><strong>Attachments:</strong> <span style="color:var(--mu);font-size:11px;">Loading...</span></div>';
        // Custom fields
        html += '<strong>Custom Fields:</strong> ' + (q.customFields || []).filter(f => f.value).map(f => f.name + ': ' + f.value).join(' | ');
        if (q.suggestedRate?.hours) {
          html += '<br><strong>Estimated Hours:</strong> ' + q.suggestedRate.hours + 'hrs @ &pound;85/hr';
        }
        // Reference quotes
        if (q.similarQuotes && q.similarQuotes.length > 0) {
          html += '<br><br><strong>Reference Quotes:</strong>';
          for (const sq of q.similarQuotes) {
            const clientTag = sq.isClientMatch ? ' <span style="color:#58a6ff;">(same client)</span>' : '';
            html += '<div style="padding:4px 0;border-bottom:1px solid var(--sb);' + (sq.isClientMatch ? 'background:var(--ol);padding:4px;border-radius:4px;margin:2px 0;' : '') + '">' +
              '<strong>' + sq.estimateNumber + '</strong> ' + (sq.client || '') + clientTag +
              '<br>' + (sq.reference || '') +
              ' &mdash; <strong>&pound;' + sq.total + '</strong> <span class="match-score">' + sq.matchScore + '</span> <span style="color:var(--mu);">' + (sq.date || '') + '</span></div>';
          }
        }
        return html;
      }

      let tableHtml = '<div class="desktop-table"><table><thead><tr>' +
        '<th></th><th>Card</th><th>Client</th><th>Site</th><th>Scope</th><th>Assignee</th>' +
        '<th>Keywords</th><th>Suggested</th><th>Top Match</th><th>Hours</th><th>Value</th><th></th>' +
        '</tr></thead><tbody>';

      for (const q of list) {
        const d = cardData(q);
        tableHtml += '<tr class="quote-row" data-id="' + q.id + '">' +
          '<td><span class="expand-btn" data-toggle="' + q.id + '">+</span></td>' +
          '<td><a href="' + (q.url || '#') + '" target="_blank">' + (q.displayId || '') + '</a></td>' +
          '<td>' + d.clientDisplay + '</td>' +
          '<td>' + (q.siteName || '-') + '</td>' +
          '<td class="scope">' + (q.scope || '-') + '</td>' +
          '<td class="assignee">' + (q.assignedUserName || '-') + '</td>' +
          '<td class="kw-col">' + d.kwDisplay + '</td>' +
          '<td><span class="rate">' + d.rateDisplay + '</span><br>' + d.hoursLine + '<br><span class="rate-range">' + d.rangeDisplay + '</span></td>' +
          '<td class="match">' + d.matchDisplay + '<br>' + d.matchScoreDisplay + '</td>' +
          '<td><input type="number" class="hours-input" id="hours-' + q.id + '" value="' + d.defaultHours + '" min="0" step="0.5" style="width:60px"> <span class="rate-value" id="value-' + q.id + '">&pound;' + d.defaultRate + '</span></td>' +
          '<td></td>' +
          '<td><button class="btn-approve" data-approve="' + q.id + '">Approve</button><button class="btn-done" data-done="' + q.id + '">Done</button></td>' +
          '</tr>';
        tableHtml += '<tr class="detail-row" data-id="' + q.id + '" style="display:none"><td colspan="13" class="detail-cell">' + detailHtml(q) + '</td></tr>';
      }
      tableHtml += '</tbody></table></div>';

      let mobileHtml = '<div class="mobile-cards">';
      for (const q of list) {
        const d = cardData(q);
        mobileHtml += '<div class="mobile-card" data-id="' + q.id + '">' +
          '<div class="mobile-card-header">' +
            '<div><span class="mobile-card-id"><a href="' + (q.url || '#') + '" target="_blank">' + (q.displayId || '') + '</a></span> ' +
            '<span class="mobile-card-client">' + d.clientDisplay + '</span></div>' +
            '<span class="mobile-card-assignee">' + (q.assignedUserName || '') + '</span>' +
          '</div>' +
          '<div class="mobile-card-site">' + (q.siteName || '-') + '</div>' +
          '<div class="mobile-card-scope">' + (q.scope || '-') + '</div>' +
          '<div class="mobile-card-pricing">' +
            '<div class="mobile-card-suggested">' +
              '<span class="rate">' + d.rateDisplay + '</span><br>' + d.hoursLine +
              '<br><span class="rate-range">' + d.rangeDisplay + '</span>' +
            '</div>' +
            '<div class="mobile-card-match">Top: ' + d.matchDisplay + '<br>' + d.matchScoreDisplay + '</div>' +
          '</div>' +
          '<div class="mobile-card-tags">' + d.kwDisplay + '</div>' +
          '<div class="mobile-card-actions">' +
            '<div class="hours-stepper">' +
              '<button class="btn-step" data-step="-0.5" data-for="m-hours-' + q.id + '">-</button>' +
              '<input type="number" class="hours-input" id="m-hours-' + q.id + '" value="' + d.defaultHours + '" min="0" step="0.5">' +
              '<button class="btn-step" data-step="0.5" data-for="m-hours-' + q.id + '">+</button>' +
            '</div>' +
            '<span class="rate-value" id="m-value-' + q.id + '">&pound;' + d.defaultRate + '</span>' +
            '<button class="btn-approve" data-approve="' + q.id + '">Approve</button>' +
            '<button class="btn-done" data-done="' + q.id + '">Done</button>' +
          '</div>' +
          '<span class="mobile-card-expand" data-toggle="' + q.id + '">Show details</span>' +
          '<div class="mobile-card-detail" data-detail="' + q.id + '">' + detailHtml(q) + '</div>' +
        '</div>';
      }
      mobileHtml += '</div>';

      document.getElementById('content').innerHTML = tableHtml + mobileHtml;
    }

    async function markDone(id, btn) {
      if (!confirm('Remove "Price Required" tag from this card?')) return;
      btn.disabled = true;
      btn.textContent = 'Removing...';
      try {
        const res = await fetch('/api/cards/' + id + '/done', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        allQuotes = allQuotes.filter(q => q.id !== id);
        renderStats();
        renderTable(getFilteredQuotes());
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Done';
        alert('Error: ' + err.message);
      }
    }

    document.getElementById('content').addEventListener('click', function(e) {
      const stepBtn = e.target.closest('[data-step]');
      if (stepBtn) {
        const input = document.getElementById(stepBtn.dataset.for);
        if (input) {
          const cur = parseFloat(input.value) || 0;
          const step = parseFloat(stepBtn.dataset.step);
          const next = Math.max(0, cur + step);
          input.value = next.toFixed(1);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
      const approveBtn = e.target.closest('[data-approve]');
      if (approveBtn) { approveQuote(approveBtn.dataset.approve, approveBtn); return; }
      const doneBtn = e.target.closest('[data-done]');
      if (doneBtn) { markDone(doneBtn.dataset.done, doneBtn); return; }
      const toggleBtn = e.target.closest('[data-toggle]');
      if (toggleBtn) {
        const id = toggleBtn.dataset.toggle;
        toggleDetail(id);
        const mobileDetail = document.querySelector('.mobile-card-detail[data-detail="' + id + '"]');
        if (mobileDetail) {
          mobileDetail.classList.toggle('open');
          toggleBtn.textContent = mobileDetail.classList.contains('open') ? 'Hide details' : 'Show details';
        }
        return;
      }
    });

    document.getElementById('content').addEventListener('input', function(e) {
      if (e.target.classList.contains('hours-input')) {
        const id = e.target.id.replace('m-hours-', '').replace('hours-', '');
        const hours = parseFloat(e.target.value) || 0;
        const value = hours * 85;
        const valueEl = document.getElementById('value-' + id);
        const mValueEl = document.getElementById('m-value-' + id);
        const text = String.fromCharCode(163) + value.toFixed(0);
        if (valueEl) valueEl.textContent = text;
        if (mValueEl) mValueEl.textContent = text;
        const desktopInput = document.getElementById('hours-' + id);
        const mobileInput = document.getElementById('m-hours-' + id);
        if (e.target !== desktopInput && desktopInput) desktopInput.value = e.target.value;
        if (e.target !== mobileInput && mobileInput) mobileInput.value = e.target.value;
      }
    });

    loadQuotes();
  </script>`;
}

// ---------------------------------------------------------------------------
// Live Quotes page
// ---------------------------------------------------------------------------

function liveQuotesPage() {
  return `
  <style>
    .pricing-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1.5px solid var(--sb); }
    .btn-refresh { background: var(--o); color: var(--w); border: none; padding: 10px 20px; border-radius: 3px; cursor: pointer; font-size: 13px; font-weight: 700; font-family: inherit; transition: all 0.2s; }
    .btn-refresh:hover { background: var(--od); transform: translateY(-1px); }
    .btn-refresh:disabled { background: var(--sb); color: var(--mu); cursor: wait; }
    .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .stat { background: var(--w); border: 1.5px solid var(--sb); border-radius: 3px; padding: 14px 18px; min-width: 130px; }
    .stat-value { font-size: 26px; font-weight: 800; color: var(--o); }
    .stat-label { font-family: 'DM Mono', monospace; font-size: 9px; color: var(--mu); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.08em; }
    .filters { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
    .filters input, .filters select { background: var(--w); border: 1.5px solid var(--sb); color: var(--k); padding: 8px 12px; border-radius: 3px; font-size: 13px; font-family: inherit; }
    .filters input:focus, .filters select:focus { outline: none; border-color: var(--o); }
    .filters input { width: 250px; }
    table { width: 100%; border-collapse: collapse; background: var(--w); border: 1.5px solid var(--sb); }
    thead { background: var(--bg2); }
    th { text-align: left; padding: 10px 14px; font-family: 'DM Mono', monospace; font-size: 9px; font-weight: 500; color: var(--mu); text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1.5px solid var(--sb); }
    td { padding: 10px 14px; border-bottom: 1px solid var(--sb); font-size: 13px; vertical-align: top; }
    tr:hover { background: var(--ol); }
    .load-time { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--mu); margin-left: 12px; }
    .live-status { display: inline-block; padding: 2px 8px; border-radius: 2px; font-family: 'DM Mono', monospace; font-size: 9px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
    .live-status.sent { background: var(--ol); color: var(--o); }
    .live-status.accepted { background: #e6f4ea; color: #2d8a3e; }
    .btn-invoice { background: var(--k); color: var(--w); border: none; padding: 8px 16px; border-radius: 3px; cursor: pointer; font-size: 13px; font-weight: 700; font-family: inherit; transition: all 0.2s; }
    .btn-invoice:hover { background: var(--s); transform: translateY(-1px); }
    .btn-invoice:disabled { background: var(--sb); color: var(--mu); cursor: not-allowed; }
    .btn-invoice.done { background: var(--o); cursor: default; }
    .btn-decline { position: absolute; top: 4px; right: 4px; background: none; border: none; color: #cc3300; font-size: 16px; font-weight: 700; cursor: pointer; line-height: 1; padding: 2px 6px; border-radius: 3px; opacity: 0.5; transition: opacity 0.15s; }
    .btn-decline:hover { opacity: 1; background: #fff0f0; }
    .sp-select { background: var(--w); border: 1.5px solid var(--sb); color: var(--k); padding: 4px 6px; border-radius: 3px; font-size: 11px; font-family: inherit; cursor: pointer; max-width: 140px; }
    .sp-select:focus { outline: none; border-color: var(--o); }
    .expand-btn { cursor: pointer; color: var(--o); font-size: 12px; font-weight: 700; }
    .detail-row { display: none; }
    .detail-row.open { display: table-row; }
    .detail-cell { background: var(--bg2); padding: 16px !important; font-size: 12px; color: var(--s); }
    .detail-cell pre { white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word; max-width: 100%; font-family: 'DM Mono', monospace; font-size: 11px; margin: 8px 0; padding: 10px; background: var(--w); border: 1px solid var(--sb); border-radius: 3px; }
    .mobile-card-detail pre { white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word; max-width: calc(100vw - 60px); font-family: 'DM Mono', monospace; font-size: 10px; margin: 8px 0; padding: 8px; background: var(--w); border: 1px solid var(--sb); border-radius: 3px; }
    .li-header { font-weight: 700; color: var(--k); margin-bottom: 4px; }
    .li-meta { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--mu); margin-bottom: 8px; }
    .mobile-cards { display: none; }
    .mobile-card { background: var(--w); border: 1.5px solid var(--sb); border-radius: 3px; padding: 14px; margin-bottom: 10px; }
    .mobile-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
    .mobile-card-site { font-size: 14px; font-weight: 700; color: var(--k); margin-bottom: 4px; }
    .mobile-card-scope { font-size: 12px; color: var(--s); margin-bottom: 8px; }
    .mobile-card-detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--sb); font-size: 11px; color: var(--s); display: none; }
    .mobile-card-detail.open { display: block; }
    .mobile-card-expand { color: var(--o); font-size: 12px; font-weight: 700; cursor: pointer; display: inline-block; margin-top: 6px; }
    @media (max-width: 900px) {
      .page { padding: 12px; }
      h1 { font-size: 16px; }
      .stats { gap: 8px; }
      .stat { padding: 10px 14px; min-width: 80px; }
      .stat-value { font-size: 20px; }
      .filters input { width: 100%; }
      .filters { flex-direction: column; gap: 8px; }
      .filters select { width: 100%; }
      .desktop-table { display: none; }
      .mobile-cards { display: block; }
    }
  </style>

  <div class="pricing-header">
    <h1>Live Quotes</h1>
    <div>
      <span class="load-time" id="loadTime"></span>
      <button class="btn-refresh" id="refreshBtn" onclick="loadLiveQuotes()">Refresh</button>
    </div>
  </div>

  <div class="stats" id="liveStats"></div>
  <div class="filters">
    <input type="text" id="liveSearch" placeholder="Search quotes..." oninput="filterLiveTable()">
    <select id="liveSpFilter" onchange="filterLiveTable()">
      <option value="">All salespersons</option>
      <option value="Scaffold Design">Scaffold Design</option>
      <option value="Powered Design">Powered Design</option>
      <option value="Scaffold Design - Ireland">Scaffold Design - Ireland</option>
      <option value="Powered Design - Ireland">Powered Design - Ireland</option>
    </select>
    <select id="liveClientFilter" onchange="filterLiveTable()"><option value="">All clients</option></select>
  </div>
  <div id="liveError"></div>
  <div id="liveContent"><div class="loading">Loading live quotes from Zoho...</div></div>

  <script>
    let allLiveQuotes = [];
    const SALESPERSONS = [
      { id: '70776000004849675', name: 'Scaffold Design' },
      { id: '70776000004849677', name: 'Powered Design' },
      { id: '70776000004920001', name: 'Scaffold Design - Ireland' },
      { id: '70776000005368119', name: 'Powered Design - Ireland' },
    ];

    function spSelectHtml(estimateId, currentId) {
      let html = '<select class="sp-select" data-sp="' + estimateId + '">';
      for (const sp of SALESPERSONS) {
        html += '<option value="' + sp.id + '"' + (sp.id === currentId ? ' selected' : '') + '>' + sp.name + '</option>';
      }
      html += '</select>';
      return html;
    }

    async function changeSalesperson(estimateId, selectEl) {
      const spId = selectEl.value;
      selectEl.disabled = true;
      try {
        const res = await fetch('/api/live-quotes/' + estimateId + '/salesperson', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ salesperson_id: spId }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        const q = allLiveQuotes.find(q => q.estimateId === estimateId);
        if (q) { q.salesperson = data.salesperson; q.salespersonId = spId; }
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        selectEl.disabled = false;
      }
    }

    async function declineQuote(estimateId) {
      if (!confirm('Decline this quote? This will set the status to Declined on Zoho.')) return;
      try {
        const res = await fetch('/api/live-quotes/' + estimateId + '/decline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        allLiveQuotes = allLiveQuotes.filter(q => q.estimateId !== estimateId);
        renderLiveStats();
        renderLiveTable(getFilteredLiveQuotes());
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function loadLiveQuotes() {
      const btn = document.getElementById('refreshBtn');
      btn.disabled = true;
      btn.textContent = 'Loading...';
      document.getElementById('liveError').innerHTML = '';
      const start = Date.now();

      try {
        const res = await fetch('/api/live-quotes');
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        allLiveQuotes = data.quotes;
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        document.getElementById('loadTime').textContent = 'Loaded in ' + elapsed + 's';
        renderLiveStats();
        populateLiveFilters();
        renderLiveTable();
      } catch (err) {
        document.getElementById('liveError').innerHTML = '<div class="error">' + err.message + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Refresh';
      }
    }

    function renderLiveStats() {
      const total = allLiveQuotes.length;
      const sent = allLiveQuotes.filter(q => q.status === 'sent').length;
      const accepted = allLiveQuotes.filter(q => q.status === 'accepted').length;
      const subTotalValue = allLiveQuotes.reduce((sum, q) => sum + (q.subTotal || 0), 0);
      const clients = new Set(allLiveQuotes.map(q => q.customer)).size;

      document.getElementById('liveStats').innerHTML =
        '<div class="stat"><div class="stat-value">' + total + '</div><div class="stat-label">Live Quotes</div></div>' +
        '<div class="stat"><div class="stat-value">' + sent + '</div><div class="stat-label">Sent</div></div>' +
        '<div class="stat"><div class="stat-value">' + accepted + '</div><div class="stat-label">Accepted</div></div>' +
        '<div class="stat"><div class="stat-value">&pound;' + subTotalValue.toLocaleString() + '</div><div class="stat-label">Sub Total Value</div></div>' +
        '<div class="stat"><div class="stat-value">' + clients + '</div><div class="stat-label">Clients</div></div>';
    }

    function populateLiveFilters() {
      const clients = [...new Set(allLiveQuotes.map(q => q.customer).filter(Boolean))].sort();
      const cf = document.getElementById('liveClientFilter');
      cf.innerHTML = '<option value="">All clients</option>';
      clients.forEach(c => { const o = document.createElement('option'); o.value = c; o.text = c; cf.add(o); });
    }

    function getFilteredLiveQuotes() {
      const search = document.getElementById('liveSearch').value.toLowerCase();
      const sp = document.getElementById('liveSpFilter').value;
      const client = document.getElementById('liveClientFilter').value;
      let filtered = allLiveQuotes.filter(q => {
        const text = (q.estimateNumber + ' ' + q.customer + ' ' + q.project + ' ' + q.reference).toLowerCase();
        const matchSearch = !search || text.includes(search);
        const matchSp = !sp || q.salesperson === sp;
        const matchClient = !client || q.customer === client;
        return matchSearch && matchSp && matchClient;
      });
      filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return filtered;
    }

    function filterLiveTable() { renderLiveTable(getFilteredLiveQuotes()); }

    function detailHtml(q) {
      let html = '';
      for (const li of (q.lineItems || [])) {
        html += '<div class="li-header">' + (li.name || '') + '</div>';
        html += '<div class="li-meta">Qty: ' + li.quantity + ' &times; &pound;' + (li.rate || 0).toLocaleString() + ' = &pound;' + (li.total || 0).toLocaleString() + '</div>';
        if (li.description) html += '<pre>' + li.description + '</pre>';
      }
      if (!q.lineItems?.length) html = '<em>No line items</em>';
      return html;
    }

    function renderLiveTable(quotes) {
      const list = quotes || [...allLiveQuotes].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      let tableHtml = '<div class="desktop-table"><table><thead><tr>' +
        '<th></th><th>Quote</th><th>Date</th><th>Client</th><th>Project</th><th>Reference</th>' +
        '<th>Status</th><th>Salesperson</th><th>Sub Total</th><th>Total (inc. VAT)</th><th></th>' +
        '</tr></thead><tbody>';

      for (const q of list) {
        tableHtml += '<tr>' +
          '<td><span class="expand-btn" data-toggle="' + q.estimateId + '">+</span></td>' +
          '<td><strong>' + q.estimateNumber + '</strong></td>' +
          '<td>' + (q.date || '') + '</td>' +
          '<td>' + (q.customer || '') + '</td>' +
          '<td>' + (q.project || '') + '</td>' +
          '<td>' + (q.reference || '') + '</td>' +
          '<td><span class="live-status ' + q.status + '">' + q.status + '</span></td>' +
          '<td>' + spSelectHtml(q.estimateId, q.salespersonId) + '</td>' +
          '<td><strong>&pound;' + (q.subTotal || 0).toLocaleString() + '</strong></td>' +
          '<td style="color:var(--mu);">&pound;' + (q.total || 0).toLocaleString() + '</td>' +
          '<td style="position:relative;"><button class="btn-invoice" data-invoice="' + q.estimateId + '">Ready for Invoice</button><button class="btn-decline" data-decline="' + q.estimateId + '" title="Decline quote">&times;</button></td>' +
          '</tr>';
        tableHtml += '<tr class="detail-row" data-id="' + q.estimateId + '" style="display:none"><td colspan="11" class="detail-cell">' + detailHtml(q) + '</td></tr>';
      }
      tableHtml += '</tbody></table></div>';

      let mobileHtml = '<div class="mobile-cards">';
      for (const q of list) {
        mobileHtml += '<div class="mobile-card">' +
          '<div class="mobile-card-header">' +
            '<div><strong>' + q.estimateNumber + '</strong> <span class="live-status ' + q.status + '">' + q.status + '</span></div>' +
            '<strong>&pound;' + (q.subTotal || 0).toLocaleString() + '</strong>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--mu);">Total inc. VAT: &pound;' + (q.total || 0).toLocaleString() + ' &mdash; ' + (q.date || '') + '</div>' +
          '<div class="mobile-card-site">' + (q.customer || '') + '</div>' +
          '<div class="mobile-card-scope">' + (q.project || '') + (q.reference ? ' &mdash; ' + q.reference : '') + '</div>' +
          '<div style="margin-top:6px;">' + spSelectHtml(q.estimateId, q.salespersonId) + '</div>' +
          '<span class="mobile-card-expand" data-toggle="' + q.estimateId + '">Show details</span>' +
          '<div class="mobile-card-detail" data-detail="' + q.estimateId + '">' + detailHtml(q) + '</div>' +
          '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;"><button class="btn-invoice" data-invoice="' + q.estimateId + '" style="flex:1;">Ready for Invoice</button><button class="btn-decline" data-decline="' + q.estimateId + '" style="position:static;opacity:1;font-size:20px;" title="Decline quote">&times;</button></div>' +
        '</div>';
      }
      mobileHtml += '</div>';

      document.getElementById('liveContent').innerHTML = tableHtml + mobileHtml;
    }

    async function markInvoiceReady(estimateId, btn) {
      if (!confirm('Mark this quote as ready for invoice?')) return;
      btn.disabled = true;
      btn.textContent = 'Updating...';

      try {
        const res = await fetch('/api/live-quotes/' + estimateId + '/invoice-ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        btn.textContent = 'Done';
        btn.classList.add('done');
        setTimeout(() => {
          allLiveQuotes = allLiveQuotes.filter(q => q.estimateId !== estimateId);
          renderLiveStats();
          renderLiveTable(getFilteredLiveQuotes());
        }, 1000);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Ready for Invoice';
        alert('Error: ' + err.message);
      }
    }

    document.getElementById('liveContent').addEventListener('click', function(e) {
      const toggleBtn = e.target.closest('[data-toggle]');
      if (toggleBtn) {
        const id = toggleBtn.dataset.toggle;
        const row = document.querySelector('.detail-row[data-id="' + id + '"]');
        if (row) { row.classList.toggle('open'); row.style.display = row.classList.contains('open') ? '' : 'none'; }
        const mobileDetail = document.querySelector('.mobile-card-detail[data-detail="' + id + '"]');
        if (mobileDetail) {
          mobileDetail.classList.toggle('open');
          toggleBtn.textContent = mobileDetail.classList.contains('open') ? 'Hide details' : 'Show details';
        }
        return;
      }
      const declineBtn = e.target.closest('[data-decline]');
      if (declineBtn) { declineQuote(declineBtn.dataset.decline); return; }
      const invoiceBtn = e.target.closest('[data-invoice]');
      if (invoiceBtn) markInvoiceReady(invoiceBtn.dataset.invoice, invoiceBtn);
    });

    document.getElementById('liveContent').addEventListener('change', function(e) {
      const spSelect = e.target.closest('[data-sp]');
      if (spSelect) changeSalesperson(spSelect.dataset.sp, spSelect);
    });

    loadLiveQuotes();
  </script>`;
}

// ---------------------------------------------------------------------------
// Financial dashboard page
// ---------------------------------------------------------------------------

function dashboardPage() {
  return `
  <style>
    .dash-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .stats { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat { background: var(--w); border: 1.5px solid var(--sb); border-radius: 3px; padding: 14px 18px; min-width: 130px; }
    .stat-value { font-size: 26px; font-weight: 800; color: var(--o); }
    .stat-label { font-family: 'DM Mono', monospace; font-size: 9px; color: var(--mu); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.08em; }
    .filters { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
    .filters input, .filters select { background: var(--w); border: 1.5px solid var(--sb); color: var(--k); padding: 8px 12px; border-radius: 3px; font-size: 13px; font-family: inherit; }
    .filters input:focus, .filters select:focus { outline: none; border-color: var(--o); }
    .btn { background: var(--o); color: var(--w); border: none; padding: 8px 16px; border-radius: 3px; cursor: pointer; font-size: 13px; font-weight: 700; font-family: inherit; transition: all 0.2s; }
    .btn:hover { background: var(--od); transform: translateY(-1px); }
    .btn-secondary { background: var(--sb); color: var(--k); }
    .btn-secondary:hover { background: var(--s); color: var(--w); transform: translateY(-1px); }
    .chart-card { background: var(--w); border: 1.5px solid var(--sb); border-radius: 3px; padding: 20px; }
    .chart-card h3 { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--mu); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; background: var(--w); border: 1.5px solid var(--sb); }
    thead { background: var(--bg2); }
    th { text-align: left; padding: 10px 14px; font-family: 'DM Mono', monospace; font-size: 9px; font-weight: 500; color: var(--mu); text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1.5px solid var(--sb); }
    td { padding: 10px 14px; border-bottom: 1px solid var(--sb); font-size: 13px; }
    tr:hover { background: var(--ol); }
    .table-title { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--mu); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
    @media (max-width: 900px) {
      .charts-grid { grid-template-columns: 1fr; }
      .filters { flex-direction: column; gap: 8px; }
      .filters input, .filters select { width: 100%; }
      .stats { gap: 8px; }
      .stat { padding: 10px 14px; min-width: 80px; }
      .stat-value { font-size: 20px; }
    }
  </style>

  <div class="dash-header">
    <div>
      <h1>Dashboard</h1>
      <p class="subtitle">Financial overview from quote reference data</p>
    </div>
  </div>

  <div class="filters" id="dashFilters">
    <select id="dashPeriod" onchange="onPeriodChange(false)">
      <option value="this_month">This Month</option>
      <option value="last_month">Last Month</option>
      <option value="this_quarter">This Quarter</option>
      <option value="last_quarter">Last Quarter</option>
      <option value="this_year" selected>This Year</option>
      <option value="last_year">Last Year</option>
      <option value="custom">Custom</option>
    </select>
    <input type="date" id="dashFrom" title="From date" style="display:none">
    <input type="date" id="dashTo" title="To date" style="display:none">
    <select id="dashClient"><option value="">All clients</option></select>
    <select id="dashSp"><option value="">All salespersons</option></select>
    <button class="btn" id="dashApply" onclick="loadDashboard()">Apply</button>
    <button class="btn btn-secondary" onclick="resetDash()">Reset</button>
  </div>

  <div class="stats" id="dashKpis"><div class="loading" id="dashLoading">Loading from Zoho...</div></div>
  <div id="dashError"></div>

  <div class="charts-grid">
    <div class="chart-card">
      <h3>Sales by Customer (Top 15)</h3>
      <canvas id="chartCustomer"></canvas>
    </div>
    <div class="chart-card">
      <h3>Sales by Salesperson</h3>
      <canvas id="chartSalesperson"></canvas>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <h3>Monthly Revenue</h3>
      <canvas id="chartMonthly"></canvas>
    </div>
    <div class="chart-card">
      <h3>Quote Pipeline</h3>
      <canvas id="chartPipeline"></canvas>
    </div>
  </div>

  <div class="table-title">Sales by Customer</div>
  <div id="customerTable"></div>

  <script>
    Chart.defaults.color = '#727272';
    Chart.defaults.borderColor = '#E8E4DA';
    Chart.defaults.font.family = "'DM Sans', sans-serif";

    let charts = {};
    let dashData = null;

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const STATUS_COLORS = {
      draft: '#999990', sent: '#FF6700', accepted: '#2d8a3e',
      invoiced: '#d29922', declined: '#cc3300', expired: '#b45309'
    };
    const SP_COLORS = ['#FF6700', '#2d8a3e', '#d29922', '#0891b2', '#7c3aed', '#cc3300', '#999990', '#b45309'];

    function getPeriodDates(period) {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth(); // 0-based
      const pad = n => String(n).padStart(2, '0');
      const fmt = (yr, mo, dy) => yr + '-' + pad(mo) + '-' + pad(dy);
      const lastDay = (yr, mo) => new Date(yr, mo, 0).getDate();

      switch (period) {
        case 'this_month':
          return { from: fmt(y, m + 1, 1), to: fmt(y, m + 1, lastDay(y, m + 1)) };
        case 'last_month': {
          const ly = m === 0 ? y - 1 : y;
          const lm = m === 0 ? 12 : m;
          return { from: fmt(ly, lm, 1), to: fmt(ly, lm, lastDay(ly, lm)) };
        }
        case 'this_quarter': {
          const q = Math.floor(m / 3);
          const qs = q * 3 + 1;
          return { from: fmt(y, qs, 1), to: fmt(y, qs + 2, lastDay(y, qs + 2)) };
        }
        case 'last_quarter': {
          let q = Math.floor(m / 3) - 1;
          let qy = y;
          if (q < 0) { q = 3; qy = y - 1; }
          const qs = q * 3 + 1;
          return { from: fmt(qy, qs, 1), to: fmt(qy, qs + 2, lastDay(qy, qs + 2)) };
        }
        case 'this_year':
          return { from: fmt(y, 1, 1), to: fmt(y, m + 1, now.getDate()) };
        case 'last_year':
          return { from: fmt(y - 1, 1, 1), to: fmt(y - 1, 12, 31) };
        default:
          return { from: '', to: '' };
      }
    }

    function onPeriodChange(autoLoad) {
      const period = document.getElementById('dashPeriod').value;
      const fromEl = document.getElementById('dashFrom');
      const toEl = document.getElementById('dashTo');
      if (period === 'custom') {
        fromEl.style.display = '';
        toEl.style.display = '';
      } else {
        fromEl.style.display = 'none';
        toEl.style.display = 'none';
        const dates = getPeriodDates(period);
        fromEl.value = dates.from;
        toEl.value = dates.to;
      }
      if (autoLoad) loadDashboard();
    }

    async function loadDashboard() {
      const btn = document.getElementById('dashApply');
      btn.disabled = true;
      btn.textContent = 'Loading...';
      document.getElementById('dashError').innerHTML = '';
      document.getElementById('dashKpis').innerHTML = '<div class="loading">Loading from Zoho...</div>';

      try {
        const params = new URLSearchParams();
        const from = document.getElementById('dashFrom').value;
        const to = document.getElementById('dashTo').value;
        const client = document.getElementById('dashClient').value;
        const sp = document.getElementById('dashSp').value;
        if (from) params.set('from_date', from);
        if (to) params.set('to_date', to);
        if (client) params.set('client', client);
        if (sp) params.set('salesperson', sp);

        const res = await fetch('/api/dashboard/summary?' + params.toString());
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        dashData = data;

        renderKpis();
        renderCharts();
        renderCustomerTable();
        populateDashFilters();
      } catch (err) {
        document.getElementById('dashKpis').innerHTML = '';
        document.getElementById('dashError').innerHTML = '<div class="error">' + err.message + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Apply';
      }
    }

    function populateDashFilters() {
      if (!dashData?.filterOptions) return;
      const cf = document.getElementById('dashClient');
      const sf = document.getElementById('dashSp');
      if (cf.options.length <= 1) {
        dashData.filterOptions.clients.forEach(c => {
          const o = document.createElement('option'); o.value = c; o.text = c; cf.add(o);
        });
      }
      if (sf.options.length <= 1) {
        dashData.filterOptions.salespersons.forEach(s => {
          const o = document.createElement('option'); o.value = s; o.text = s; sf.add(o);
        });
      }
    }

    function resetDash() {
      document.getElementById('dashPeriod').value = 'this_year';
      document.getElementById('dashFrom').style.display = 'none';
      document.getElementById('dashTo').style.display = 'none';
      document.getElementById('dashClient').value = '';
      document.getElementById('dashSp').value = '';
      const dates = getPeriodDates('this_year');
      document.getElementById('dashFrom').value = dates.from;
      document.getElementById('dashTo').value = dates.to;
      loadDashboard();
    }

    function renderKpis() {
      const k = dashData.kpis;
      document.getElementById('dashKpis').innerHTML =
        '<div class="stat"><div class="stat-value">&pound;' + k.invoiceRevenue.toLocaleString() + '</div><div class="stat-label">Invoiced Revenue</div></div>' +
        '<div class="stat"><div class="stat-value">' + k.totalInvoices + '</div><div class="stat-label">Invoices</div></div>' +
        '<div class="stat"><div class="stat-value">&pound;' + k.avgInvoiceValue.toLocaleString() + '</div><div class="stat-label">Avg Invoice Value</div></div>' +
        '<div class="stat"><div class="stat-value" style="color:#d29922">&pound;' + k.outstandingAmount.toLocaleString() + '</div><div class="stat-label">Outstanding</div></div>' +
        '<div class="stat" style="border-left:3px solid var(--sb);"><div class="stat-value">' + k.totalQuotes + '</div><div class="stat-label">Quotes</div></div>' +
        '<div class="stat"><div class="stat-value" style="color:#2d8a3e">' + k.conversionRate + '%</div><div class="stat-label">Conversion Rate</div></div>' +
        '<div class="stat"><div class="stat-value" style="color:var(--o)">&pound;' + k.pipelineValue.toLocaleString() + '</div><div class="stat-label">Quote Pipeline</div></div>';
    }

    function destroyChart(key) {
      if (charts[key]) { charts[key].destroy(); delete charts[key]; }
    }

    function renderCharts() {
      // Sales by Customer - horizontal bar
      destroyChart('customer');
      const custData = dashData.salesByCustomer.slice(0, 15);
      charts.customer = new Chart(document.getElementById('chartCustomer'), {
        type: 'bar',
        data: {
          labels: custData.map(c => c.client.length > 25 ? c.client.substring(0, 25) + '...' : c.client),
          datasets: [{
            label: 'Total',
            data: custData.map(c => c.total),
            backgroundColor: '#FF6700',
            borderRadius: 3,
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { callback: v => '\\u00a3' + v.toLocaleString() }, grid: { color: '#E8E4DA' } },
            y: { grid: { display: false } }
          }
        }
      });

      // Sales by Salesperson - doughnut
      destroyChart('salesperson');
      const spData = dashData.salesBySalesperson;
      charts.salesperson = new Chart(document.getElementById('chartSalesperson'), {
        type: 'doughnut',
        data: {
          labels: spData.map(s => s.salesperson),
          datasets: [{
            data: spData.map(s => s.total),
            backgroundColor: SP_COLORS.slice(0, spData.length),
            borderColor: '#FFFFFF',
            borderWidth: 2,
          }]
        },
        options: {
          responsive: true,
          plugins: {
            legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true } },
            tooltip: { callbacks: { label: ctx => ctx.label + ': \\u00a3' + ctx.parsed.toLocaleString() } }
          }
        }
      });

      // Monthly Revenue - line with area fill + invoice count overlay
      destroyChart('monthly');
      const monthData = dashData.monthlySales;
      charts.monthly = new Chart(document.getElementById('chartMonthly'), {
        type: 'line',
        data: {
          labels: monthData.map(m => {
            const parts = m.month.split('-');
            return MONTH_NAMES[parseInt(parts[1], 10) - 1] + ' ' + parts[0].substring(2);
          }),
          datasets: [{
            label: 'Revenue',
            data: monthData.map(m => m.total),
            borderColor: '#FF6700',
            backgroundColor: 'rgba(255,103,0,0.08)',
            fill: true,
            tension: 0.3,
            pointBackgroundColor: '#FF6700',
          }, {
            label: 'Invoices',
            data: monthData.map(m => m.count),
            borderColor: '#2d8a3e',
            backgroundColor: 'transparent',
            borderDash: [4, 4],
            tension: 0.3,
            pointBackgroundColor: '#2d8a3e',
            yAxisID: 'y1',
          }]
        },
        options: {
          responsive: true,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            tooltip: {
              callbacks: {
                label: ctx => ctx.datasetIndex === 0
                  ? 'Revenue: \\u00a3' + ctx.parsed.y.toLocaleString()
                  : 'Invoices: ' + ctx.parsed.y
              }
            }
          },
          scales: {
            y: { ticks: { callback: v => '\\u00a3' + v.toLocaleString() }, grid: { color: '#E8E4DA' } },
            y1: { position: 'right', grid: { display: false }, ticks: { color: '#2d8a3e' } },
            x: { grid: { color: '#E8E4DA' } }
          }
        }
      });

      // Pipeline - bar by status
      destroyChart('pipeline');
      const pipeData = dashData.pipeline;
      const statusOrder = ['draft', 'sent', 'accepted', 'invoiced', 'declined', 'expired'];
      const orderedPipe = statusOrder.map(s => pipeData.find(p => p.status === s)).filter(Boolean);
      charts.pipeline = new Chart(document.getElementById('chartPipeline'), {
        type: 'bar',
        data: {
          labels: orderedPipe.map(p => p.status.charAt(0).toUpperCase() + p.status.slice(1)),
          datasets: [{
            label: 'Value',
            data: orderedPipe.map(p => p.total),
            backgroundColor: orderedPipe.map(p => STATUS_COLORS[p.status] || '#999990'),
            borderRadius: 3,
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            y: { ticks: { callback: v => '\\u00a3' + v.toLocaleString() }, grid: { color: '#E8E4DA' } },
            x: { grid: { display: false } }
          }
        }
      });
    }

    function renderCustomerTable() {
      const data = dashData.salesByCustomer;
      let html = '<table><thead><tr>' +
        '<th>Customer</th><th style="text-align:right">Quotes</th><th style="text-align:right">Total Value</th>' +
        '<th style="text-align:right">Avg Value</th></tr></thead><tbody>';
      for (const c of data) {
        const avg = c.count > 0 ? Math.round(c.total / c.count) : 0;
        html += '<tr><td><strong>' + c.client + '</strong></td>' +
          '<td style="text-align:right">' + c.count + '</td>' +
          '<td style="text-align:right;font-weight:700">&pound;' + c.total.toLocaleString() + '</td>' +
          '<td style="text-align:right">&pound;' + avg.toLocaleString() + '</td></tr>';
      }
      html += '</tbody></table>';
      document.getElementById('customerTable').innerHTML = html;
    }

    // Default: This Year
    const initDates = getPeriodDates('this_year');
    document.getElementById('dashFrom').value = initDates.from;
    document.getElementById('dashTo').value = initDates.to;

    loadDashboard();
  </script>`;
}
