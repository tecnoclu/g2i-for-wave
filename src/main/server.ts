import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { app as electronApp, shell, BrowserWindow } from 'electron';

export function startProxyServer(port: number, configPath: string) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Load config safely
  let config: any = { 
    OPERATION_MODE: 'READ_ONLY', 
    WAVE_API_URL: 'https://gql.waveapps.com/graphql/public',
    LLM_HOST: 'http://127.0.0.1',
    LLM_PORT: 1234,
    MAX_CONTEXT_TOKENS: 262144 // Defaulting to max since local models can handle it
  };
  if (existsSync(configPath)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(configPath, 'utf8')) };
    } catch (e) {
      console.warn('[Proxy] Failed to parse config.local.json, using defaults.');
    }
  }

  const getWaveToken = () => process.env.WAVE_API_TOKEN || '';

  // Helper to run wave query securely
  async function runWaveQuery(query: string, variables: any, waveToken: string) {
    if (config.OPERATION_MODE === 'READ_ONLY') {
      if (query && typeof query === 'string' && query.trim().startsWith('mutation')) {
         throw new Error('Write access disabled. OPERATION_MODE is READ_ONLY.');
      }
    }

    const response = await fetch(config.WAVE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${waveToken}`
      },
      body: JSON.stringify({ query, variables })
    });

    let data: any;
    try {
      data = await response.json();
    } catch (e) {
      throw new Error(`Wave API HTTP Error: ${response.status} ${response.statusText}`);
    }

    if (data && data.errors) {
      throw new Error(`GraphQL Validation Error: ${JSON.stringify(data.errors)}`);
    }

    if (!response.ok) {
      throw new Error(`Wave API Error: ${response.status} ${response.statusText}`);
    }
    
    return data;
  }

  // --- Cache State ---
  interface InvoiceCache {
    invoices: any[];
    timestamp: number;
  }
  interface CustomerCache {
    customers: any[];
    timestamp: number;
  }
  interface ProductCache {
    products: any[];
    timestamp: number;
  }
  const globalInvoiceCache: Record<string, InvoiceCache> = {};
  const globalCustomerCache: Record<string, CustomerCache> = {};
  const globalProductCache: Record<string, ProductCache> = {};
  const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  // --- API Endpoints ---

  app.post('/api/wave', async (req, res) => {
    const waveToken = getWaveToken();
    if (!waveToken) return res.status(500).json({ error: 'Wave API token not configured locally' });

    try {
      const data = await runWaveQuery(req.body.query, req.body.variables || {}, waveToken);
      res.json(data);
    } catch (error: any) {
      res.status(error.message.includes('Write access') ? 403 : 500).json({ error: 'Proxy error', details: error.message });
    }
  });

  app.get('/api/businesses', async (req, res) => {
    const waveToken = getWaveToken();
    if (!waveToken) return res.status(500).json({ error: 'Wave API token not configured' });

    const query = `
      query {
        businesses {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `;

    try {
      const data = await runWaveQuery(query, {}, waveToken);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const { history, message, businessId } = req.body;
    const waveToken = getWaveToken();
    if (!waveToken) return res.status(500).json({ error: 'Wave API token not configured' });

    const llmUrl = `${config.LLM_HOST}:${config.LLM_PORT}/v1/chat/completions`;

    const systemPrompt = `You are a financial analysis assistant for WaveApps. You help the user analyze their financial data and manage invoices/estimates.
When the user asks for data or actions:
- Use the 'search_cached_invoices' tool for invoices.
- Use the 'search_cached_customers' tool for customers.
- Use the 'list_cached_products' tool for products/services catalog.
- Use the 'manage_invoice_or_estimate' tool for creating draft invoices, creating estimates, sending estimates, or approving estimates.
- Use the 'export_invoices_report' tool to generate and open a CSV spreadsheet of invoices. ALWAYS use this instead of 'export_to_spreadsheet' when exporting invoices because it handles formatting and line-item flattening natively, saving context space and latency.
- Use the 'export_to_spreadsheet' tool to generate and open a CSV spreadsheet for general data exports other than invoices.
- Use the 'generate_pdf_document' tool to generate and open a styled PDF when they want to print, download, or save reports/invoices/estimates as PDF.
- Use the 'draft_system_email' tool to draft an email using their native desktop email application.
- Use the 'query_wave_graphql' tool for other raw data queries.
The user is currently viewing business ID: ${businessId}.

CRITICAL INSTRUCTIONS:
1. If the user asks for invoices by PO Number, Customer Name, Invoice Number, or Date Range, ALWAYS use the 'search_cached_invoices' tool. It is much faster than raw GraphQL.
2. If the user asks for customers, ALWAYS use 'search_cached_customers'. It returns outstanding and overdue balances and aggregates them.
3. If the user asks for products, ALWAYS use 'list_cached_products'.
4. If the user wants to create a DRAFT invoice, create an estimate, send an estimate, or approve an estimate, ALWAYS use the 'manage_invoice_or_estimate' tool.
5. If the tools return a warning about stale data, you MUST inform the user of the timestamp and ask them if they want you to refresh it. DO NOT call forceRefresh without asking the user first!
6. If the 'manage_invoice_or_estimate' tool returns an error about OPERATION_MODE being READ_ONLY, inform the user they need to modify their settings/configuration (in config.local.json) to enable write access.
7. FINANCIAL MATH RULES: 
   - 'total' = What was originally billed (use this for "Total Invoiced"). 
   - 'amountDue' = What is currently unpaid/owed (use this for "Outstanding Balance"). Do NOT mix these up.
8. DO NOT DO MATH YOURSELF! The caching tools return a 'summary' block at the top of the JSON with the mathematically perfect sums. ALWAYS report the numbers exactly as provided in the summary block.

### WAVE APPS GRAPHQL SCHEMA REFERENCE:
**Invoice**: id, invoiceNumber, poNumber, invoiceDate (Date), dueDate (Date), amountDue { value }, amountPaid { value }, total { value }, status, customer { id name }, items { description quantity price subtotal { value } total { value } product { id name } taxes { amount { value } salesTax { id name } } }
**Customer**: id, name, email, phone, outstandingAmount { value }, overdueAmount { value }
**Product**: id, name, description, unitPrice, defaultSalesTaxes { id name rate }
**Estimate**: id, estimateNumber, status, title, subhead, estimateDate, dueDate, exchangeRate, total { value }, customer { id name }

### INPUT SCHEMAS FOR MUTATIONS:
**InvoiceCreateInput**:
- customerId: ID!
- status: InvoiceCreateStatus (forced to DRAFT by the tool, do not pass or worry about it)
- currency: CurrencyCode
- title: String
- subhead: String
- invoiceNumber: String
- poNumber: String
- invoiceDate: Date
- dueDate: Date
- items: [InvoiceCreateItemInput!]
  - productId: ID!
  - description: String
  - quantity: Decimal
  - unitPrice: Decimal
  - taxes: [InvoiceCreateItemTaxInput!]
    - salesTaxId: ID!
- memo: String
- footer: String

**EstimateCreateInput**:
- customerId: ID!
- status: EstimateCreateStatus
- currency: CurrencyCode
- title: String
- subhead: String
- estimateNumber: String
- poNumber: String
- estimateDate: Date
- dueDate: Date
- items: [EstimateCreateItemInput!]
  - productId: ID!
  - name: String
  - description: String
  - quantity: Decimal
  - unitPrice: Decimal!
  - taxes: [EstimateCreateItemTaxInput!]
    - salesTaxId: ID!
- memo: String
- footer: String

**EstimateSendInput**:
- estimateId: ID!
- to: [String!]!
- subject: String
- message: String
- attachPDF: Boolean!
- fromAddress: String
- ccMyself: Boolean
- hideGrandTotal: Boolean
- includeAttachments: Boolean
`;

    const tools = [
      {
        type: "function",
        function: {
          name: "search_cached_invoices",
          description: "Search local cache of invoices. Extremely fast. Best for PO Number, Customer Name, Invoice Number, Date Range, or Status searches. It automatically calculates sums.",
          parameters: {
            type: "object",
            properties: {
              poNumber: { type: "string" },
              customerName: { type: "string" },
              invoiceNumber: { type: "string" },
              status: { type: "string" },
              dateStart: { type: "string", description: "Format: YYYY-MM-DD" },
              dateEnd: { type: "string", description: "Format: YYYY-MM-DD" },
              forceRefresh: { type: "boolean", description: "Set to true ONLY if the user explicitly approved a fresh download." }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_cached_customers",
          description: "Search local cache of customers and their balance information. Includes client name, email, phone, and total outstanding/overdue balances.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Filter by customer name (partial case-insensitive match)" },
              forceRefresh: { type: "boolean", description: "Set to true ONLY if the user explicitly approved a fresh download." }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_cached_products",
          description: "List and search the product/service catalog from WaveApps, including pricing, description, and tax information.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Filter by product name (partial case-insensitive match)" },
              forceRefresh: { type: "boolean", description: "Set to true ONLY if the user explicitly approved a fresh download." }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "manage_invoice_or_estimate",
          description: "Perform invoice and estimate actions: create a DRAFT invoice, create an estimate, or send/approve an estimate. NOTE: This tool validates OPERATION_MODE. If write operations are blocked, it returns an error.",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["create_draft_invoice", "create_estimate", "send_estimate", "approve_estimate"],
                description: "The action to perform."
              },
              invoiceInput: {
                type: "object",
                description: "Input fields for create_draft_invoice action (matches InvoiceCreateInput; businessId is injected automatically)."
              },
              estimateInput: {
                type: "object",
                description: "Input fields for create_estimate action (matches EstimateCreateInput; businessId is injected automatically)."
              },
              emailInput: {
                type: "object",
                description: "Input fields for send_estimate action (matches EstimateSendInput, e.g., estimateId, to, subject, message, attachPDF)."
              },
              estimateId: {
                type: "string",
                description: "The ID of the estimate to approve."
              }
            },
            required: ["action"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "export_to_spreadsheet",
          description: "Generates a CSV spreadsheet file locally in the user's Downloads folder from the provided data and opens it in their default spreadsheet application (Excel/Numbers). Use this when the user asks to export data to Excel or CSV.",
          parameters: {
            type: "object",
            properties: {
              filename: { type: "string", description: "Name of the file, e.g. invoices_2026.csv (must end in .csv)" },
              headers: {
                type: "array",
                items: { type: "string" },
                description: "Array of header column names, e.g. ['Invoice Number', 'PO Number', 'Date']"
              },
              rows: {
                type: "array",
                items: {
                  type: "object",
                  description: "Object mapping header/column names to row cell values"
                },
                description: "Array of data row objects, matching the keys in headers"
              }
            },
            required: ["headers", "rows"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "export_invoices_report",
          description: "Generates a customized, flattened CSV spreadsheet of invoices directly on the backend, saves it to the user's Downloads folder, and opens it. ALWAYS use this instead of export_to_spreadsheet when exporting invoices because it processes line items instantly without taxing LLM context/latency bounds.",
          parameters: {
            type: "object",
            properties: {
              filename: { type: "string", description: "Name of the file, e.g. invoices_2026.csv (must end in .csv)" },
              dateStart: { type: "string", description: "Filter start date (YYYY-MM-DD)" },
              dateEnd: { type: "string", description: "Filter end date (YYYY-MM-DD)" },
              customerName: { type: "string", description: "Filter by customer name (partial case-insensitive match)" },
              includeLineItems: { type: "boolean", description: "Set to true to flatten and include all individual line items (multiple rows per invoice if needed). Set to false for invoice summaries." },
              forceRefresh: { type: "boolean", description: "Set to true ONLY if the user explicitly approved a fresh download." },
              projection: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    header: { type: "string", description: "Spreadsheet column header label, e.g. 'Client Name', 'Total'" },
                    path: { type: "string", description: "JSON path relative to the invoice object. For line items, start with 'item.' e.g. 'invoiceNumber', 'poNumber', 'invoiceDate', 'customer.name', 'status', 'amountDue.value', 'total.value', 'item.product.name', 'item.description', 'item.quantity', 'item.price', 'item.taxes', 'item.lineTotal', 'item.taxAmount', 'item.totalWithTax'" }
                  },
                  required: ["header", "path"]
                },
                description: "Optional custom column headers and path projection map. If omitted, a standard set of default columns is exported."
              }
            },
            required: ["filename", "includeLineItems"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "generate_pdf_document",
          description: "Generates a beautifully styled PDF document locally in the user's Downloads folder from custom HTML content and opens it. Use this when the user asks to print, save, or download a document as PDF (like reports, invoices, estimates). Include full CSS styles in the HTML content to make it look premium.",
          parameters: {
            type: "object",
            properties: {
              filename: { type: "string", description: "Name of the file, e.g. invoice_225.pdf (must end in .pdf)" },
              htmlContent: { type: "string", description: "Fully styled HTML string (including <style> blocks) to convert to PDF. Use elegant fonts and clean layouts." }
            },
            required: ["htmlContent"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "draft_system_email",
          description: "Opens the user's default system email application (Outlook/Apple Mail) with a pre-filled draft containing recipient, subject, and body.",
          parameters: {
            type: "object",
            properties: {
              to: { type: "string", description: "Recipient email address" },
              subject: { type: "string", description: "Subject of the email" },
              body: { type: "string", description: "Body of the email" }
            },
            required: ["to", "subject", "body"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "query_wave_graphql",
          description: "Execute a generic GraphQL query against the WaveApps API.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The GraphQL query string to execute."
              },
              variables: {
                type: "object",
                description: "Optional JSON object of variables for the query."
              }
            },
            required: ["query"]
          }
        }
      }
    ];

    // Helper to search invoices via Cache
    async function executeSearchInvoices(args: any) {
      let cache = globalInvoiceCache[businessId];
      let needsRefresh = !cache || cache.invoices.length === 0 || args.forceRefresh;
      let isExpired = !needsRefresh && (Date.now() - cache.timestamp > CACHE_TTL_MS);

      if (needsRefresh) {
        console.log('[Cache] Downloading all invoices for business...');
        let allInvoices: any[] = [];
        let hasNext = true;
        let page = 1;
        while(hasNext) {
          const q = `query { business(id: "${businessId}") { invoices(page: ${page}, pageSize: 100) { pageInfo { currentPage totalPages } edges { node { id poNumber invoiceDate invoiceNumber status amountDue { value } total { value } customer { name } items { product { id name } description quantity price subtotal { value } total { value } taxes { amount { value } salesTax { id name } } } } } } } }`;
          const res = await runWaveQuery(q, {}, waveToken);
          const invConnection = res.data?.business?.invoices;
          if (!invConnection) break;
          
          if (invConnection.edges) {
            invConnection.edges.forEach((e: any) => allInvoices.push(e.node));
          }
          if (invConnection.pageInfo && invConnection.pageInfo.currentPage < invConnection.pageInfo.totalPages) {
            page++;
          } else {
            hasNext = false;
          }
        }
        globalInvoiceCache[businessId] = {
          invoices: allInvoices,
          timestamp: Date.now()
        };
        cache = globalInvoiceCache[businessId];
        isExpired = false;
        console.log(`[Cache] Successfully cached ${allInvoices.length} invoices.`);
      }

      let results = cache.invoices;
      if (args.poNumber) results = results.filter((i: any) => i.poNumber && i.poNumber.includes(args.poNumber));
      if (args.customerName) results = results.filter((i: any) => i.customer && i.customer.name.toLowerCase().includes(args.customerName.toLowerCase()));
      if (args.status) results = results.filter((i: any) => i.status === args.status);
      if (args.invoiceNumber) results = results.filter((i: any) => i.invoiceNumber && i.invoiceNumber.includes(args.invoiceNumber));
      
      if (args.dateStart || args.dateEnd) {
        const start = args.dateStart ? new Date(args.dateStart).getTime() : 0;
        let end = Infinity;
        if (args.dateEnd) {
           const endDate = new Date(args.dateEnd);
           // If they provided just YYYY-MM-DD, it parses to midnight UTC. We must include the whole day.
           end = endDate.getTime() + (24 * 60 * 60 * 1000) - 1;
        }
        results = results.filter((i: any) => {
           if (!i.invoiceDate) return false;
           const d = new Date(i.invoiceDate).getTime();
           return d >= start && d <= end;
        });
      }

      // Calculate perfect math summary
      let totalInvoiced = 0;
      let totalOutstanding = 0;
      let totalPreTax = 0;
      let totalTax = 0;
      results.forEach((i: any) => {
         let invTotal = 0;
         if (i.total?.value) {
           const cleanVal = i.total.value.toString().replace(/,/g, '');
           invTotal = parseFloat(cleanVal);
           totalInvoiced += invTotal;
         }
         if (i.amountDue?.value) {
           const cleanVal = i.amountDue.value.toString().replace(/,/g, '');
           totalOutstanding += parseFloat(cleanVal);
         }
         
         let invoicePreTax = 0;
         let invoiceTax = 0;
         let hasItemDetail = false;

         if (i.items && i.items.length > 0) {
           hasItemDetail = true;
           i.items.forEach((item: any) => {
             let itemSubtotal = 0;
             if (item.subtotal?.value) {
               itemSubtotal = parseFloat(item.subtotal.value.toString().replace(/,/g, ''));
             } else {
               const qty = parseFloat(item.quantity || 0);
               const price = parseFloat(item.price || 0);
               itemSubtotal = qty * price;
             }
             invoicePreTax += itemSubtotal;

             if (item.taxes && item.taxes.length > 0) {
               item.taxes.forEach((tax: any) => {
                 if (tax.amount?.value) {
                   invoiceTax += parseFloat(tax.amount.value.toString().replace(/,/g, ''));
                 }
               });
             }
           });
         }

         if (hasItemDetail) {
           totalPreTax += invoicePreTax;
           totalTax += invoiceTax;
         } else {
           // If no item detail is available, assume pre-tax is invoice total and tax is 0
           totalPreTax += invTotal;
         }
      });

      const response: any = {
        summary: {
          totalInvoiced: parseFloat(totalInvoiced.toFixed(2)),
          totalOutstanding: parseFloat(totalOutstanding.toFixed(2)),
          totalPreTax: parseFloat(totalPreTax.toFixed(2)),
          totalTax: parseFloat(totalTax.toFixed(2))
        },
        totalCachedInvoices: cache.invoices.length,
        returnedResults: results.length,
        invoices: results
      };

      if (isExpired) {
        const dateStr = new Date(cache.timestamp).toLocaleTimeString();
        response.warning = `The cached data was last updated at ${dateStr}. You MUST inform the user of this time and ask if they want you to pull fresh data from Wave (using forceRefresh: true).`;
      }

      return response;
    }

    // Helper to search customers via Cache
    async function executeSearchCustomers(args: any) {
      let cache = globalCustomerCache[businessId];
      let needsRefresh = !cache || cache.customers.length === 0 || args.forceRefresh;
      let isExpired = !needsRefresh && (Date.now() - cache.timestamp > CACHE_TTL_MS);

      if (needsRefresh) {
        console.log('[Cache] Downloading all customers for business...');
        let allCustomers: any[] = [];
        let hasNext = true;
        let page = 1;
        while(hasNext) {
          const q = `query { business(id: "${businessId}") { customers(page: ${page}, pageSize: 100) { pageInfo { currentPage totalPages } edges { node { id name email phone outstandingAmount { value } overdueAmount { value } } } } } }`;
          const res = await runWaveQuery(q, {}, waveToken);
          const custConnection = res.data?.business?.customers;
          if (!custConnection) break;
          
          if (custConnection.edges) {
            custConnection.edges.forEach((e: any) => allCustomers.push(e.node));
          }
          if (custConnection.pageInfo && custConnection.pageInfo.currentPage < custConnection.pageInfo.totalPages) {
            page++;
          } else {
            hasNext = false;
          }
        }
        globalCustomerCache[businessId] = {
          customers: allCustomers,
          timestamp: Date.now()
        };
        cache = globalCustomerCache[businessId];
        isExpired = false;
        console.log(`[Cache] Successfully cached ${allCustomers.length} customers.`);
      }

      let results = cache.customers;
      if (args.name) {
        results = results.filter((c: any) => c.name && c.name.toLowerCase().includes(args.name.toLowerCase()));
      }

      // Calculate perfect math summary
      let totalOutstanding = 0;
      let totalOverdue = 0;
      results.forEach((c: any) => {
         if (c.outstandingAmount?.value) {
           const cleanVal = c.outstandingAmount.value.toString().replace(/,/g, '');
           totalOutstanding += parseFloat(cleanVal);
         }
         if (c.overdueAmount?.value) {
           const cleanVal = c.overdueAmount.value.toString().replace(/,/g, '');
           totalOverdue += parseFloat(cleanVal);
         }
      });

      const response: any = {
        summary: {
          totalOutstanding: parseFloat(totalOutstanding.toFixed(2)),
          totalOverdue: parseFloat(totalOverdue.toFixed(2))
        },
        totalCachedCustomers: cache.customers.length,
        returnedResults: results.length,
        customers: results
      };

      if (isExpired) {
        const dateStr = new Date(cache.timestamp).toLocaleTimeString();
        response.warning = `The cached customer data was last updated at ${dateStr}. You MUST inform the user of this time and ask if they want you to pull fresh data from Wave (using forceRefresh: true).`;
      }

      return response;
    }

    // Helper to search products via Cache
    async function executeSearchProducts(args: any) {
      let cache = globalProductCache[businessId];
      let needsRefresh = !cache || cache.products.length === 0 || args.forceRefresh;
      let isExpired = !needsRefresh && (Date.now() - cache.timestamp > CACHE_TTL_MS);

      if (needsRefresh) {
        console.log('[Cache] Downloading all products for business...');
        let allProducts: any[] = [];
        let hasNext = true;
        let page = 1;
        while(hasNext) {
          const q = `query { business(id: "${businessId}") { products(page: ${page}, pageSize: 100) { pageInfo { currentPage totalPages } edges { node { id name description unitPrice isSold isBought isArchived defaultSalesTaxes { id name rate } } } } } }`;
          const res = await runWaveQuery(q, {}, waveToken);
          const prodConnection = res.data?.business?.products;
          if (!prodConnection) break;
          
          if (prodConnection.edges) {
            prodConnection.edges.forEach((e: any) => allProducts.push(e.node));
          }
          if (prodConnection.pageInfo && prodConnection.pageInfo.currentPage < prodConnection.pageInfo.totalPages) {
            page++;
          } else {
            hasNext = false;
          }
        }
        globalProductCache[businessId] = {
          products: allProducts,
          timestamp: Date.now()
        };
        cache = globalProductCache[businessId];
        isExpired = false;
        console.log(`[Cache] Successfully cached ${allProducts.length} products.`);
      }

      let results = cache.products;
      if (args.name) {
        results = results.filter((p: any) => p.name && p.name.toLowerCase().includes(args.name.toLowerCase()));
      }

      const response: any = {
        totalCachedProducts: cache.products.length,
        returnedResults: results.length,
        products: results
      };

      if (isExpired) {
        const dateStr = new Date(cache.timestamp).toLocaleTimeString();
        response.warning = `The cached product data was last updated at ${dateStr}. You MUST inform the user of this time and ask if they want you to pull fresh data from Wave (using forceRefresh: true).`;
      }

      return response;
    }

    // Helper to perform invoice and estimate actions
    async function executeManageInvoiceOrEstimate(args: any) {
      if (config.OPERATION_MODE === 'READ_ONLY') {
        return { error: 'Write access disabled. OPERATION_MODE is READ_ONLY. You must inform the user they need to change the OPERATION_MODE flag in config.local.json to WRITE or ENABLED to execute modifications.' };
      }

      const action = args.action;
      if (action === 'create_draft_invoice') {
        const input = { ...args.invoiceInput, businessId, status: 'DRAFT' };
        const q = `mutation($input: InvoiceCreateInput!) {
          invoiceCreate(input: $input) {
            didSucceed
            inputErrors { message code path }
            invoice { id invoiceNumber status total { value } customer { name } }
          }
        }`;
        return await runWaveQuery(q, { input }, waveToken);
      } else if (action === 'create_estimate') {
        const input = { ...args.estimateInput, businessId };
        const q = `mutation($input: EstimateCreateInput!) {
          estimateCreate(input: $input) {
            didSucceed
            inputErrors { message code path }
            estimate { id estimateNumber status total { value } customer { name } }
          }
        }`;
        return await runWaveQuery(q, { input }, waveToken);
      } else if (action === 'send_estimate') {
        const input = { ...args.emailInput };
        const q = `mutation($input: EstimateSendInput!) {
          estimateSend(input: $input) {
            didSucceed
            inputErrors { message code path }
          }
        }`;
        return await runWaveQuery(q, { input }, waveToken);
      } else if (action === 'approve_estimate') {
        const input = { estimateId: args.estimateId };
        const q = `mutation($input: EstimateApproveInput!) {
          estimateApprove(input: $input) {
            didSucceed
            inputErrors { message code path }
            estimate { id status }
          }
        }`;
        return await runWaveQuery(q, { input }, waveToken);
      } else {
        throw new Error(`Unsupported action: ${action}`);
      }
    }

    // Helper to export invoices report with proxy-side flattening and dynamic projection
    async function executeExportInvoicesReport(args: any) {
      // Ensure cache is loaded and get filtered results (reusing the cache search helper)
      const searchRes = await executeSearchInvoices({
        forceRefresh: args.forceRefresh,
        customerName: args.customerName
      });
      
      let invoices = searchRes.invoices;
      
      // Filter by date range if provided
      if (args.dateStart || args.dateEnd) {
        const start = args.dateStart ? new Date(args.dateStart).getTime() : 0;
        let end = Infinity;
        if (args.dateEnd) {
           const endDate = new Date(args.dateEnd);
           end = endDate.getTime() + (24 * 60 * 60 * 1000) - 1;
        }
        invoices = invoices.filter((i: any) => {
           if (!i.invoiceDate) return false;
           const d = new Date(i.invoiceDate).getTime();
           return d >= start && d <= end;
        });
      }
      
      // Define path resolver
      function getValueByPath(obj: any, path: string): any {
        if (!obj) return '';
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
          if (current[part] === undefined || current[part] === null) {
            return '';
          }
          current = current[part];
        }
        return current;
      }
      
      const defaultProjection = [
        { header: 'Invoice Number', path: 'invoiceNumber' },
        { header: 'PO Number', path: 'poNumber' },
        { header: 'Invoice Date', path: 'invoiceDate' },
        { header: 'Customer Name', path: 'customer.name' },
        { header: 'Status', path: 'status' },
        { header: 'Product/Service', path: 'item.product.name' },
        { header: 'Description', path: 'item.description' },
        { header: 'Quantity', path: 'item.quantity' },
        { header: 'Price', path: 'item.price' },
        { header: 'Tax Names', path: 'item.taxes' },
        { header: 'Line Tax Amount', path: 'item.taxAmount' },
        { header: 'Line Total', path: 'item.lineTotal' },
        { header: 'Line Total (Tax Included)', path: 'item.totalWithTax' },
        { header: 'Amount Due', path: 'amountDue.value' },
        { header: 'Invoice Total', path: 'total.value' }
      ];
      
      const projection = args.projection && args.projection.length > 0 ? args.projection : defaultProjection;
      const headers = projection.map((p: any) => p.header);
      
      // Flatten data into spreadsheet rows
      const rows: any[] = [];
      invoices.forEach((inv: any) => {
        if (args.includeLineItems && inv.items && inv.items.length > 0) {
          inv.items.forEach((item: any) => {
            const row: any = {};
            projection.forEach((proj: any) => {
              const { header, path } = proj;
              if (path.startsWith('item.')) {
                const itemPath = path.substring(5);
                if (itemPath === 'taxes') {
                  row[header] = item.taxes?.map((t: any) => t.salesTax?.name).filter(Boolean).join(', ') || '';
                } else if (itemPath === 'taxAmount') {
                  let taxSum = 0;
                  if (item.taxes && item.taxes.length > 0) {
                    item.taxes.forEach((t: any) => {
                      if (t.amount?.value) {
                        taxSum += parseFloat(t.amount.value.toString().replace(/,/g, ''));
                      }
                    });
                  }
                  row[header] = taxSum.toFixed(2);
                } else if (itemPath === 'lineTotal') {
                  const qty = parseFloat(item.quantity || 0);
                  const price = parseFloat(item.price || 0);
                  row[header] = (qty * price).toFixed(2);
                } else if (itemPath === 'totalWithTax') {
                  const qty = parseFloat(item.quantity || 0);
                  const price = parseFloat(item.price || 0);
                  const lineTotal = qty * price;
                  let taxSum = 0;
                  if (item.taxes && item.taxes.length > 0) {
                    item.taxes.forEach((t: any) => {
                      if (t.amount?.value) {
                        taxSum += parseFloat(t.amount.value.toString().replace(/,/g, ''));
                      }
                    });
                  }
                  row[header] = (lineTotal + taxSum).toFixed(2);
                } else {
                  row[header] = getValueByPath(item, itemPath);
                }
              } else {
                row[header] = getValueByPath(inv, path);
              }
            });
            rows.push(row);
          });
        } else {
          const row: any = {};
          projection.forEach((proj: any) => {
            const { header, path } = proj;
            if (path.startsWith('item.')) {
              row[header] = '';
            } else {
              row[header] = getValueByPath(inv, path);
            }
          });
          rows.push(row);
        }
      });
      
      // Generate CSV content
      const csvLines: string[] = [];
      csvLines.push(headers.map((h: string) => `"${h.replace(/"/g, '""')}"`).join(','));
      
      rows.forEach(row => {
        const line = headers.map((h: string) => {
          let val = row[h] !== undefined && row[h] !== null ? row[h] : '';
          return `"${val.toString().replace(/"/g, '""')}"`;
        }).join(',');
        csvLines.push(line);
      });
      
      const csvContent = csvLines.join('\n');
      
      // Save to Downloads
      const filename = args.filename || `invoice_report_${Date.now()}.csv`;
      const downloadsDir = electronApp.getPath('downloads');
      const filePath = join(downloadsDir, filename);
      
      writeFileSync(filePath, csvContent, 'utf8');
      await shell.openPath(filePath);
      
      return {
        success: true,
        filePath,
        totalInvoicesProcessed: invoices.length,
        totalRowsGenerated: rows.length,
        message: `Successfully generated report containing ${invoices.length} invoices (${rows.length} rows) and opened the file.`
      };
    }

    // Helper to export data to CSV and open it
    async function executeExportToSpreadsheet(args: any) {
      const filename = args.filename || `export_${Date.now()}.csv`;
      const headers = args.headers as string[];
      const rows = args.rows as any[];
      
      const csvLines: string[] = [];
      csvLines.push(headers.map(h => `"${h.replace(/"/g, '""')}"`).join(','));
      
      rows.forEach(row => {
        const line = headers.map(h => {
          let val = row[h] !== undefined && row[h] !== null ? row[h] : '';
          return `"${val.toString().replace(/"/g, '""')}"`;
        }).join(',');
        csvLines.push(line);
      });
      
      const csvContent = csvLines.join('\n');
      const downloadsDir = electronApp.getPath('downloads');
      const filePath = join(downloadsDir, filename);
      
      writeFileSync(filePath, csvContent, 'utf8');
      await shell.openPath(filePath);
      
      return { success: true, filePath, message: `Successfully exported to ${filePath} and opened the file.` };
    }

    // Helper to generate a styled PDF report and open it
    async function executeGeneratePdfDocument(args: any) {
      const filename = args.filename || `document_${Date.now()}.pdf`;
      const htmlContent = args.htmlContent;
      
      const tempWin = new BrowserWindow({
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });
      
      await tempWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
      
      const pdfBuffer = await tempWin.webContents.printToPDF({
        printBackground: true
      });
      
      tempWin.close();
      
      const downloadsDir = electronApp.getPath('downloads');
      const filePath = join(downloadsDir, filename);
      
      writeFileSync(filePath, pdfBuffer);
      await shell.openPath(filePath);
      
      return { success: true, filePath, message: `Successfully generated PDF at ${filePath} and opened the file.` };
    }

    // Helper to open default mail client with draft
    async function executeDraftSystemEmail(args: any) {
      const { to, subject, body } = args;
      const mailtoUri = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      
      await shell.openExternal(mailtoUri);
      
      return { success: true, mailtoUri, message: "Successfully opened your default email application with pre-composed draft." };
    }

    // Support both the new history array and the old legacy message string for compatibility
    const userHistory = history || [{ role: 'user', content: message }];
    let messages = [
      { role: 'system', content: systemPrompt },
      ...userHistory
    ];

    let iterations = 0;
    const MAX_ITERATIONS = 15;
    const previousQueries = new Set<string>();

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;
        console.log(`\n[Chat] --- Iteration ${iterations} ---`);
        console.log(`[Chat] Sending request to LLM...`);
        const llmHeaders: any = { 'Content-Type': 'application/json' };
        if (process.env.LLM_API_TOKEN) {
          llmHeaders['Authorization'] = `Bearer ${process.env.LLM_API_TOKEN}`;
        }
        
        const llmResponse = await fetch(llmUrl, {
          method: 'POST',
          headers: llmHeaders,
          body: JSON.stringify({
            model: "local-model",
            messages: messages,
            tools: tools,
            tool_choice: "auto"
          })
        });

        if (!llmResponse.ok) {
          throw new Error(`LLM Error: ${llmResponse.statusText}`);
        }

        const llmData = await llmResponse.json();
        const responseMessage = llmData.choices[0].message;
        
        console.log('[Chat] Received response from LLM. Tool calls present:', !!responseMessage.tool_calls);

        // Parse Tool Call (Standard JSON or Fallback XML)
        const contentStr = responseMessage.content || '';
        let isXmlToolCall = false;
        let xmlQuery = '';

        if (contentStr.includes('<function=query_wave_graphql>') || contentStr.includes('query {') || contentStr.includes('<tool_call>')) {
          const match = contentStr.match(/<parameter=query>([\s\S]*?)<\/parameter>/);
          if (match && match[1]) {
            isXmlToolCall = true;
            xmlQuery = match[1].trim();
          } else {
            const fallbackMatch = contentStr.match(/query\s*\{[\s\S]*?\}/);
            if (fallbackMatch) {
              isXmlToolCall = true;
              xmlQuery = fallbackMatch[0];
            }
          }
          if (isXmlToolCall) {
              console.log('[Chat] Detected XML Fallback Tool Call!');
          }
        }

        if ((responseMessage.tool_calls && responseMessage.tool_calls.length > 0) || isXmlToolCall) {
          let queryToRun = '';
          let toolCallId = 'xml-fallback';
          let isStandardToolCall = false;
          let queryVariables = {};

          if (isXmlToolCall && xmlQuery) {
            queryToRun = xmlQuery;
          } else if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            const toolCall = responseMessage.tool_calls[0];
            toolCallId = toolCall.id;
            isStandardToolCall = true;
            const args = JSON.parse(toolCall.function.arguments);
            queryToRun = args.query || JSON.stringify(args);
            queryVariables = args.variables || {};
          }
            
          console.log('[Chat] Executing Wave GraphQL Query:\n', queryToRun);
          
          // Loop Prevention: If the exact same query is run twice, force an answer.
          if (previousQueries.has(queryToRun.trim())) {
             console.log('[Chat] Detected duplicate query. Forcing the LLM to answer instead of looping.');
             messages.push(responseMessage);
             messages.push({
               role: "user",
               content: "You already executed this exact same query. Please stop querying and provide the final natural language answer to the user based on the data you have."
             });
             continue;
          }
          previousQueries.add(queryToRun.trim());

          let queryResult;
          let executedToolName = 'query_wave_graphql';

          if (isStandardToolCall && responseMessage.tool_calls[0].function.name === 'search_cached_invoices') {
            executedToolName = 'search_cached_invoices';
            try {
              const args = JSON.parse(responseMessage.tool_calls[0].function.arguments);
              queryResult = await executeSearchInvoices(args);
              console.log('[Chat] Local Cache Search Successful');
            } catch (err: any) {
              console.error('[Chat] Local Cache Search Error:', err.message);
              queryResult = { error: err.message };
            }
          } else if (isStandardToolCall && responseMessage.tool_calls[0].function.name === 'search_cached_customers') {
            executedToolName = 'search_cached_customers';
            try {
              const args = JSON.parse(responseMessage.tool_calls[0].function.arguments);
              queryResult = await executeSearchCustomers(args);
              console.log('[Chat] Customer Cache Search Successful');
            } catch (err: any) {
              console.error('[Chat] Customer Cache Search Error:', err.message);
              queryResult = { error: err.message };
            }
          } else if (isStandardToolCall && responseMessage.tool_calls[0].function.name === 'list_cached_products') {
            executedToolName = 'list_cached_products';
            try {
              const args = JSON.parse(responseMessage.tool_calls[0].function.arguments);
              queryResult = await executeSearchProducts(args);
              console.log('[Chat] Product Cache Search Successful');
            } catch (err: any) {
              console.error('[Chat] Product Cache Search Error:', err.message);
              queryResult = { error: err.message };
            }
          } else if (isStandardToolCall && responseMessage.tool_calls[0].function.name === 'manage_invoice_or_estimate') {
            executedToolName = 'manage_invoice_or_estimate';
            try {
              const args = JSON.parse(responseMessage.tool_calls[0].function.arguments);
              queryResult = await executeManageInvoiceOrEstimate(args);
              console.log('[Chat] Manage Invoice/Estimate Successful');
            } catch (err: any) {
              console.error('[Chat] Manage Invoice/Estimate Error:', err.message);
              queryResult = { error: err.message };
            }
          } else if (isStandardToolCall && responseMessage.tool_calls[0].function.name === 'export_invoices_report') {
            executedToolName = 'export_invoices_report';
            try {
              const args = JSON.parse(responseMessage.tool_calls[0].function.arguments);
              queryResult = await executeExportInvoicesReport(args);
              console.log('[Chat] Export Invoices Report Successful');
            } catch (err: any) {
              console.error('[Chat] Export Invoices Report Error:', err.message);
              queryResult = { error: err.message };
            }
          } else if (isStandardToolCall && responseMessage.tool_calls[0].function.name === 'export_to_spreadsheet') {
            executedToolName = 'export_to_spreadsheet';
            try {
              const args = JSON.parse(responseMessage.tool_calls[0].function.arguments);
              queryResult = await executeExportToSpreadsheet(args);
              console.log('[Chat] Export to Spreadsheet Successful');
            } catch (err: any) {
              console.error('[Chat] Export to Spreadsheet Error:', err.message);
              queryResult = { error: err.message };
            }
          } else if (isStandardToolCall && responseMessage.tool_calls[0].function.name === 'generate_pdf_document') {
            executedToolName = 'generate_pdf_document';
            try {
              const args = JSON.parse(responseMessage.tool_calls[0].function.arguments);
              queryResult = await executeGeneratePdfDocument(args);
              console.log('[Chat] Generate PDF Document Successful');
            } catch (err: any) {
              console.error('[Chat] Generate PDF Document Error:', err.message);
              queryResult = { error: err.message };
            }
          } else if (isStandardToolCall && responseMessage.tool_calls[0].function.name === 'draft_system_email') {
            executedToolName = 'draft_system_email';
            try {
              const args = JSON.parse(responseMessage.tool_calls[0].function.arguments);
              queryResult = await executeDraftSystemEmail(args);
              console.log('[Chat] Draft System Email Successful');
            } catch (err: any) {
              console.error('[Chat] Draft System Email Error:', err.message);
              queryResult = { error: err.message };
            }
          } else {
            try {
              queryResult = await runWaveQuery(queryToRun, queryVariables, waveToken);
              console.log('[Chat] Wave API Query Successful');
            } catch (err: any) {
              console.error('[Chat] Wave API Query Error:', err.message);
              queryResult = { error: err.message };
            }
          }

          let resultString = JSON.stringify(queryResult);
          // Significantly increased the default context limit so JSON doesn't get broken easily
          const maxChars = (config.MAX_CONTEXT_TOKENS || 8192) * 4;
          if (resultString.length > maxChars) {
            console.log('[Chat] Truncating Wave API Response...');
            resultString = resultString.substring(0, maxChars) + '... [TRUNCATED DUE TO CONTEXT LIMITS]';
          }

          messages.push(responseMessage);
          
          if (isStandardToolCall) {
            messages.push({
              role: "tool",
              // @ts-ignore
              tool_call_id: toolCallId,
              name: executedToolName,
              content: resultString
            });
          } else {
            messages.push({
              role: "user",
              content: `The system executed your GraphQL query. Here is the result data from WaveApps:\n\n${resultString}\n\nCRITICAL: If you have enough data, provide the final answer to the user now (without any XML tool calls). If you need more data (e.g. next page), output another tool call.`
            });
          }

          console.log('[Chat] Data appended to context. Continuing loop for LLM analysis...');
          continue; // Loop again to let LLM analyze the new data
        }

        // No tool called, we assume this is the final answer or a clarifying question
        console.log('[Chat] No tool call detected, returning final response to UI.');
        return res.json({ answer: responseMessage.content });
      }

      console.warn('[Chat] Reached max iterations limit.');
      return res.json({ answer: "I needed to make too many requests to fetch that data. Could you please narrow down your search (e.g., specific dates or PO number)?" });

    } catch (error: any) {
      console.error('[Chat Error]', error);
      res.status(500).json({ error: 'LLM Orchestration error', details: error.message });
    }
  });

  app.listen(port, () => {
    console.log(`[Proxy] Server listening on http://localhost:${port} in ${config.OPERATION_MODE} mode`);
  });
}
