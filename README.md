# G2i for Wave

**G2i for Wave** is a powerful, local-first, AI-driven desktop application built with Electron, React, and Node.js. It acts as an autonomous financial agent that directly interfaces with your WaveApps accounting data to answer complex natural-language queries, generate reports, and summarize financial metrics securely.

## ✨ Core Features

* **AI Agentic UI**: Chat naturally with your financial data. Ask complex questions like *"What is the total invoiced for Acme Corp in 2026?"* and the LLM will dynamically query the Wave GraphQL API to find your answer.
* **Local-First Security**: 
  * Your `WAVE_API_TOKEN` and chat history never leave your machine.
  * Connects to local LLMs (e.g., Qwen 3.5 9B via Ollama or LM Studio) to ensure your financial data is never sent to a cloud AI provider.
  * Secrets are safely quarantined in `.env` and excluded from version control.
* **Proxy-Side Mathematical Aggregation**: Solves the notorious "Lost in the Middle" AI hallucination problem. Instead of asking the LLM to do math over massive JSON arrays, a specialized Node.js proxy instantly calculates perfect sums (`totalInvoiced`, `totalOutstanding`) before passing the verified answers back to the LLM.
* **Lazy-Loaded TTL Caching**: Bypasses the Wave API's lack of native PO Number filters by securely caching all invoices in-memory on your first query. Subsequent searches for PO numbers or customer names return instantaneously in zero API calls.
* **Schema Pre-fetching & Injection**: Condenses the massive Wave GraphQL schema into a miniature reference prompt, giving the AI 100% accuracy on its queries while burning almost zero context tokens.

## 🚀 Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) (v18+)
* A local LLM server running on `http://127.0.0.1`
* A WaveApps Personal Access Token

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/tecnoclu/g2i-for-wave.git
   cd g2i-for-wave
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure your Environment:
   * Create a `.env` file in the root directory.
   * Add your token: `WAVE_API_TOKEN=your_wave_personal_access_token`
   * Copy `config.local.json.example` to `config.local.json` and adjust your LLM ports and Context Limits.

4. Run the Development Server:
   ```bash
   npm run dev
   ```

## 🏗️ Architecture
See [ARCHITECTURE.md](./ARCHITECTURE.md) for a detailed explanation of the design patterns and paradigms used in this application, specifically regarding Anti-Hallucination strategies and GraphQL Schema injection.
