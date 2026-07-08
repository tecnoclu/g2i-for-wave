import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

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
  const globalInvoiceCache: Record<string, InvoiceCache> = {};
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

    const systemPrompt = `You are a financial analysis assistant for WaveApps. You help the user analyze their financial data.
When the user asks for data, use the 'search_cached_invoices' tool for invoices, or the 'query_wave_graphql' tool for other data.
The user is currently viewing business ID: ${businessId}.

CRITICAL INSTRUCTIONS:
1. If the user asks for invoices by PO Number, Customer Name, Invoice Number, or Date Range, ALWAYS use the 'search_cached_invoices' tool. It is much faster than raw GraphQL.
2. If 'search_cached_invoices' returns a warning about stale data, you MUST inform the user of the timestamp and ask them if they want you to refresh it. DO NOT call forceRefresh without asking the user first!
3. If the user's request is too broad (e.g. "show me invoices"), ask clarifying questions (like client name, date range, or PO) BEFORE making a tool call.
4. If you need a customer ID for a raw query, query the customers first.
5. Once you have all the necessary data, provide a final natural language answer and DO NOT output another tool call.
6. FINANCIAL MATH RULES: 
   - 'total' = What was originally billed (use this for "Total Invoiced"). 
   - 'amountDue' = What is currently unpaid/owed (use this for "Outstanding Balance"). Do NOT mix these up.
7. DO NOT DO MATH YOURSELF! The 'search_cached_invoices' tool returns a 'summary' block at the top of the JSON with the mathematically perfect sums of totalInvoiced and totalOutstanding. ALWAYS report the numbers exactly as provided in the summary block.

### WAVE APPS GRAPHQL SCHEMA REFERENCE:
**Invoice**: id, invoiceNumber, poNumber, invoiceDate (Date), dueDate (Date), amountDue { value }, amountPaid { value }, total { value }, status, customer { id name }
**Customer**: id, name, email, phone, createdAt, outstandingAmount { value }, overdueAmount { value }
**OffsetPageInfo**: currentPage (Int), totalPages (Int), totalCount (Int)
Note: Use \`page\` and \`pageSize\` arguments for pagination on connections (like \`invoices(page: 1, pageSize: 100)\`). Maximum pageSize is usually 100.
**Invoice Filters (Arguments on invoices field)**: You can pass these arguments to the invoices query: \`page\`, \`pageSize\`, \`customerId\`, \`status\`, \`invoiceDateStart\`, \`invoiceDateEnd\`, \`invoiceNumber\`.

Example Customer Query:
query {
  business(id: "${businessId}") {
    customers(page: 1, pageSize: 100) {
      edges { node { id name } }
    }
  }
}

Example Invoice Query (supports customerId and date filters):
query {
  business(id: "${businessId}") {
    invoices(page: 1, pageSize: 100, customerId: "QnVzaW...", invoiceDateStart: "2026-01-01", invoiceDateEnd: "2026-12-31") {
      pageInfo { currentPage totalPages totalCount }
      edges {
        node {
          id
          poNumber
          invoiceDate
          customer { name }
          amountDue { value }
          total { value }
          status
        }
      }
    }
  }
}
Generate only valid GraphQL queries.
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
          const q = `query { business(id: "${businessId}") { invoices(page: ${page}, pageSize: 100) { pageInfo { currentPage totalPages } edges { node { id poNumber invoiceDate invoiceNumber status amountDue { value } total { value } customer { name } } } } } }`;
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
      results.forEach((i: any) => {
         if (i.total?.value) {
           const cleanVal = i.total.value.toString().replace(/,/g, '');
           totalInvoiced += parseFloat(cleanVal);
         }
         if (i.amountDue?.value) {
           const cleanVal = i.amountDue.value.toString().replace(/,/g, '');
           totalOutstanding += parseFloat(cleanVal);
         }
      });

      const response: any = {
        summary: {
          totalInvoiced: parseFloat(totalInvoiced.toFixed(2)),
          totalOutstanding: parseFloat(totalOutstanding.toFixed(2))
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
        const llmResponse = await fetch(llmUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
