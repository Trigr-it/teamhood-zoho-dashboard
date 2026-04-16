import { z } from 'zod';
import { zohoRequest, buildQueryString, ok, err } from './api.js';

const DEFAULT_TAX_ID = '70776000000030063'; // Standard Rate VAT

export function registerZohoTools(server) {

// ── Invoices ─────────────────────────────────────────────────────────────────

server.tool('create_invoice', 'Create a new invoice in Zoho Invoice', {
  customer_id: z.string().describe('Zoho customer/contact ID'),
  line_items: z.array(z.object({
    item_id: z.string().optional(), name: z.string().optional(),
    description: z.string().optional(), rate: z.number().optional(),
    quantity: z.number().optional().default(1), tax_id: z.string().optional(),
  })).describe('Invoice line items'),
  invoice_number: z.string().optional(),
  date: z.string().optional().describe('Invoice date YYYY-MM-DD'),
  due_date: z.string().optional().describe('Due date YYYY-MM-DD'),
  payment_terms: z.number().optional(),
  discount: z.number().optional(),
  notes: z.string().optional(), terms: z.string().optional(),
  reference_number: z.string().optional(),
  salesperson_id: z.string().optional(), project_id: z.string().optional(),
}, async (args) => {
  try {
    args.line_items = args.line_items.map(item => ({ tax_id: DEFAULT_TAX_ID, ...item }));
    return ok(await zohoRequest('POST', '/invoices', args));
  } catch (e) { return err(e.message); }
});

server.tool('get_invoice', 'Get a single invoice by ID',
  { invoice_id: z.string().describe('Invoice ID') },
  async ({ invoice_id }) => {
    try { return ok(await zohoRequest('GET', `/invoices/${invoice_id}`)); }
    catch (e) { return err(e.message); }
  });

server.tool('list_invoices', 'List invoices with optional filters', {
  page: z.number().optional().default(1), per_page: z.number().optional().default(25),
  status: z.enum(['draft','sent','overdue','paid','void','unpaid','partially_paid']).optional(),
  customer_id: z.string().optional(),
  date_start: z.string().optional(), date_end: z.string().optional(),
  search_text: z.string().optional(),
}, async (args) => {
  try { return ok(await zohoRequest('GET', `/invoices${buildQueryString(args)}`)); }
  catch (e) { return err(e.message); }
});

server.tool('update_invoice', 'Update an existing invoice', {
  invoice_id: z.string().describe('Invoice ID to update'),
  customer_id: z.string().optional(),
  line_items: z.array(z.object({
    item_id: z.string().optional(), line_item_id: z.string().optional(),
    name: z.string().optional(), description: z.string().optional(),
    rate: z.number().optional(), quantity: z.number().optional(), tax_id: z.string().optional(),
  })).optional(),
  date: z.string().optional(), due_date: z.string().optional(),
  discount: z.number().optional(), notes: z.string().optional(), terms: z.string().optional(),
  reference_number: z.string().optional(),
  salesperson_id: z.string().optional(), project_id: z.string().optional(),
}, async ({ invoice_id, ...body }) => {
  try { return ok(await zohoRequest('PUT', `/invoices/${invoice_id}`, body)); }
  catch (e) { return err(e.message); }
});

// ── Estimates ────────────────────────────────────────────────────────────────

server.tool('create_estimate', 'Create a new estimate/quote in Zoho Invoice', {
  customer_id: z.string().describe('Zoho customer/contact ID'),
  line_items: z.array(z.object({
    item_id: z.string().optional(), name: z.string().optional(),
    description: z.string().optional(), rate: z.number().optional(),
    quantity: z.number().optional().default(1), tax_id: z.string().optional(),
  })).describe('Estimate line items'),
  estimate_number: z.string().optional(),
  date: z.string().optional().describe('Estimate date YYYY-MM-DD'),
  expiry_date: z.string().optional().describe('Expiry date YYYY-MM-DD'),
  discount: z.number().optional(), notes: z.string().optional(), terms: z.string().optional(),
  reference_number: z.string().optional(),
  salesperson_id: z.string().optional(), project_id: z.string().optional(),
}, async (args) => {
  try {
    args.line_items = args.line_items.map(item => ({ tax_id: DEFAULT_TAX_ID, ...item }));
    return ok(await zohoRequest('POST', '/estimates', args));
  } catch (e) { return err(e.message); }
});

server.tool('get_estimate', 'Get a single estimate by ID',
  { estimate_id: z.string().describe('Estimate ID') },
  async ({ estimate_id }) => {
    try { return ok(await zohoRequest('GET', `/estimates/${estimate_id}`)); }
    catch (e) { return err(e.message); }
  });

server.tool('list_estimates', 'List estimates with optional filters', {
  page: z.number().optional().default(1), per_page: z.number().optional().default(25),
  status: z.enum(['draft','sent','invoiced','accepted','declined','expired']).optional(),
  customer_id: z.string().optional(),
  date_start: z.string().optional(), date_end: z.string().optional(),
  search_text: z.string().optional(),
}, async (args) => {
  try { return ok(await zohoRequest('GET', `/estimates${buildQueryString(args)}`)); }
  catch (e) { return err(e.message); }
});

server.tool('update_estimate', 'Update an existing estimate', {
  estimate_id: z.string().describe('Estimate ID to update'),
  customer_id: z.string().optional(),
  line_items: z.array(z.object({
    item_id: z.string().optional(), line_item_id: z.string().optional(),
    name: z.string().optional(), description: z.string().optional(),
    rate: z.number().optional(), quantity: z.number().optional(), tax_id: z.string().optional(),
  })).optional(),
  date: z.string().optional(), expiry_date: z.string().optional(),
  discount: z.number().optional(), notes: z.string().optional(), terms: z.string().optional(),
  reference_number: z.string().optional(),
  salesperson_id: z.string().optional(), project_id: z.string().optional(),
}, async ({ estimate_id, ...body }) => {
  try { return ok(await zohoRequest('PUT', `/estimates/${estimate_id}`, body)); }
  catch (e) { return err(e.message); }
});

// ── Contacts ─────────────────────────────────────────────────────────────────

server.tool('create_contact', 'Create a new contact/customer in Zoho Invoice', {
  contact_name: z.string().describe('Contact display name'),
  company_name: z.string().optional(), email: z.string().optional(),
  phone: z.string().optional(), website: z.string().optional(),
  billing_address: z.object({ address: z.string().optional(), city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(), country: z.string().optional() }).optional(),
  shipping_address: z.object({ address: z.string().optional(), city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(), country: z.string().optional() }).optional(),
  contact_type: z.enum(['customer','vendor']).optional().default('customer'),
  payment_terms: z.number().optional(), currency_id: z.string().optional(), notes: z.string().optional(),
}, async (args) => {
  try { return ok(await zohoRequest('POST', '/contacts', args)); }
  catch (e) { return err(e.message); }
});

server.tool('get_contact', 'Get a single contact by ID',
  { contact_id: z.string().describe('Contact ID') },
  async ({ contact_id }) => {
    try { return ok(await zohoRequest('GET', `/contacts/${contact_id}`)); }
    catch (e) { return err(e.message); }
  });

server.tool('list_contacts', 'List contacts with optional filters', {
  page: z.number().optional().default(1), per_page: z.number().optional().default(25),
  contact_name: z.string().optional(), company_name: z.string().optional(),
  email: z.string().optional(), phone: z.string().optional(),
  status: z.enum(['active','inactive']).optional(), search_text: z.string().optional(),
}, async (args) => {
  try { return ok(await zohoRequest('GET', `/contacts${buildQueryString(args)}`)); }
  catch (e) { return err(e.message); }
});

server.tool('update_contact', 'Update an existing contact', {
  contact_id: z.string().describe('Contact ID to update'),
  contact_name: z.string().optional(), company_name: z.string().optional(),
  email: z.string().optional(), phone: z.string().optional(), website: z.string().optional(),
  billing_address: z.object({ address: z.string().optional(), city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(), country: z.string().optional() }).optional(),
  shipping_address: z.object({ address: z.string().optional(), city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(), country: z.string().optional() }).optional(),
  payment_terms: z.number().optional(), notes: z.string().optional(),
}, async ({ contact_id, ...body }) => {
  try { return ok(await zohoRequest('PUT', `/contacts/${contact_id}`, body)); }
  catch (e) { return err(e.message); }
});

// ── Items ────────────────────────────────────────────────────────────────────

server.tool('create_item', 'Create a new item/product in Zoho Invoice', {
  name: z.string().describe('Item name'), rate: z.number().describe('Item rate'),
  description: z.string().optional(), tax_id: z.string().optional(),
  sku: z.string().optional(), unit: z.string().optional(),
  product_type: z.enum(['goods','service']).optional().default('service'),
}, async (args) => {
  try { return ok(await zohoRequest('POST', '/items', args)); }
  catch (e) { return err(e.message); }
});

server.tool('get_item', 'Get a single item by ID',
  { item_id: z.string().describe('Item ID') },
  async ({ item_id }) => {
    try { return ok(await zohoRequest('GET', `/items/${item_id}`)); }
    catch (e) { return err(e.message); }
  });

server.tool('list_items', 'List items with optional filters', {
  page: z.number().optional().default(1), per_page: z.number().optional().default(25),
  name: z.string().optional(), search_text: z.string().optional(),
}, async (args) => {
  try { return ok(await zohoRequest('GET', `/items${buildQueryString(args)}`)); }
  catch (e) { return err(e.message); }
});

server.tool('update_item', 'Update an existing item', {
  item_id: z.string().describe('Item ID to update'),
  name: z.string().optional(), rate: z.number().optional(),
  description: z.string().optional(), tax_id: z.string().optional(),
  sku: z.string().optional(), unit: z.string().optional(),
}, async ({ item_id, ...body }) => {
  try { return ok(await zohoRequest('PUT', `/items/${item_id}`, body)); }
  catch (e) { return err(e.message); }
});

// ── Reports, Projects, Salespersons, Settings ────────────────────────────────

server.tool('get_report', 'Retrieve a Zoho Invoice report', {
  report_name: z.enum(['tax_summary','invoice_details','customer_balances','credit_note_details','expense_details','payment_received','sales_by_customer','sales_by_item']).describe('Report type'),
  from_date: z.string().optional(), to_date: z.string().optional(),
}, async ({ report_name, from_date, to_date }) => {
  try { return ok(await zohoRequest('GET', `/reports/${report_name}${buildQueryString({ from_date, to_date })}`)); }
  catch (e) { return err(e.message); }
});

server.tool('get_projects', 'List projects from Zoho Invoice', {
  customer_id: z.string().optional(),
  sort_column: z.enum(['project_name','customer_name','rate','created_time']).optional(),
  sort_order: z.enum(['A','D']).optional(),
}, async (args) => {
  try { return ok(await zohoRequest('GET', `/projects${buildQueryString(args)}`)); }
  catch (e) { return err(e.message); }
});

server.tool('get_salespersons', 'List all salespersons', {}, async () => {
  try { return ok(await zohoRequest('GET', '/salespersons')); }
  catch (e) { return err(e.message); }
});

server.tool('get_preferences', 'Get organization preferences', {}, async () => {
  try { return ok(await zohoRequest('GET', '/preferences')); }
  catch (e) { return err(e.message); }
});

server.tool('get_currencies', 'List all currencies', {}, async () => {
  try { return ok(await zohoRequest('GET', '/settings/currencies')); }
  catch (e) { return err(e.message); }
});

server.tool('get_taxes', 'List all tax rates', {}, async () => {
  try { return ok(await zohoRequest('GET', '/settings/taxes')); }
  catch (e) { return err(e.message); }
});

server.tool('get_opening_balances', 'Get opening balances', {}, async () => {
  try { return ok(await zohoRequest('GET', '/settings/openingbalances')); }
  catch (e) { return err(e.message); }
});

} // end registerZohoTools
