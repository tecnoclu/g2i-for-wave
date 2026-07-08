# G2i for Wave - Architecture Patterns

This document outlines the architectural paradigms and design patterns used in this local-first desktop application. Future AI agents and developers should strictly adhere to these paradigms when building new features.

## 1. Proxy-Side Mathematical Aggregation (Anti-Hallucination Pattern)
**The Problem**: Local LLMs (especially sub-10B parameter models) suffer from "Lost in the Middle" syndrome. When presented with a massive JSON array (e.g. 500 invoices) and asked to calculate a sum, they often lose track, forget items, and confidently hallucinate incorrect totals.

**The Solution**: The LLM must NEVER perform mathematical aggregations over large datasets itself.
- Instead, the Node.js Proxy must intercept the tool call, perform the mathematical sum/average accurately in code, and inject a `summary` block at the top of the JSON response payload.
- The LLM's system prompt must explicitly instruct it to read and report the `summary` block provided by the tool, rather than attempting to sum the array manually.
- *Whenever you add a new tool that returns arrays of numbers (e.g., Transactions, Payroll, Bills), you MUST implement proxy-side aggregation for it.*

## 2. Schema Pre-Fetching and Injection
**The Problem**: GraphQL APIs have strict typing. If an LLM guesses a field name (e.g., `invoiceDate` instead of `createdAt`), the API throws a 400 Bad Request. If the LLM doesn't know the schema, it guesses wildly and exhausts its iteration limit. Passing the entire GraphQL schema on every turn consumes too much context and slows down local inference.

**The Solution**: Inject a "Mini Schema" directly into the System Prompt.
- Before writing a new feature, run a GraphQL Introspection query (using a scratch script) against the Wave API to retrieve the exact fields and arguments for the types you need.
- Extract ONLY the highly relevant fields and pagination arguments.
- Hardcode this tiny, condensed "Schema Reference" directly into the Proxy's `server.ts` System Prompt.
- This gives the LLM 100% accuracy on its queries while burning almost zero context tokens.

## 3. Local-First Security Boundary
- **Zero Secrets in Repository**: Wave API tokens must NEVER be hardcoded, tracked in git, or sent to the frontend renderer. They must reside in `.env` (gitignored) or OS secure storage.
- **Node.js Proxy Pattern**: The frontend UI never communicates with WaveApps or the LLM directly. The frontend sends user messages to the local Node.js proxy (`http://localhost:3001/api/chat`). The proxy manages the token, orchestrates the LLM Agentic loop, and securely proxies requests to Wave.

## 4. Lazy-Loaded TTL Caching
**The Problem**: Wave GraphQL does not allow native filtering for certain fields (like PO Number), requiring massive brute-force pagination. Doing this on every query wastes time and Wave API rate limits.
**The Solution**: 
- Implement Lazy-Loaded caches in the Node.js proxy. 
- On the first query, download all data and store it in memory (`globalInvoiceCache`). 
- On subsequent queries, filter the memory array instantly.
- Implement a Time-To-Live (TTL) (e.g., 15 minutes). When the TTL expires, do NOT auto-refresh and cause a latency spike. Instead, append a warning to the LLM response, instructing the LLM to ask the user for permission to force a refresh.
