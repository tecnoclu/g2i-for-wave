import React, { useState, useEffect } from 'react';
import './index.css';

interface Business {
  id: string;
  name: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

function parseTextFormatting(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function renderMessageContent(content: string) {
  // Regex to check if there is a markdown table in the content
  const tableRegex = /((?:\|[^\n]+\|\r?\n?)+)/g;
  const parts = content.split(tableRegex);
  
  return parts.map((part, idx) => {
    if (part.startsWith('|')) {
      const lines = part.split(/\r?\n/).filter(line => line.trim().startsWith('|'));
      if (lines.length < 2) return <span key={idx}>{part}</span>;
      
      const rows = lines.map(line => {
        return line
          .split('|')
          .slice(1, -1)
          .map(cell => cell.trim());
      });
      
      const headers = rows[0];
      const dataRows = rows.slice(1).filter(row => {
        return !row.every(cell => cell.startsWith(':') || cell.startsWith('-') || cell.endsWith('-'));
      });
      
      return (
        <div key={idx} className="table-responsive">
          <table className="chat-table">
            <thead>
              <tr>
                {headers.map((h, i) => <th key={i}>{parseTextFormatting(h)}</th>)}
              </tr>
            </thead>
            <tbody>
              {dataRows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((cell, cIdx) => <td key={cIdx}>{parseTextFormatting(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    
    // Split by newlines to render paragraphs/lists and preserve bold formatting
    const lines = part.split('\n');
    return (
      <span key={idx}>
        {lines.map((line, lIdx) => (
          <React.Fragment key={lIdx}>
            {parseTextFormatting(line)}
            {lIdx < lines.length - 1 && <br />}
          </React.Fragment>
        ))}
      </span>
    );
  });
}

function App() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Fetch businesses on mount
    fetch(window.api.getProxyUrl() + '/api/businesses')
      .then(res => res.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        const fetchedBusinesses = data.data?.businesses?.edges?.map((e: any) => e.node) || [];
        setBusinesses(fetchedBusinesses);
        if (fetchedBusinesses.length > 0) {
          setSelectedBusinessId(fetchedBusinesses[0].id);
        }
      })
      .catch(err => setError('Failed to load businesses. Check API token.'));
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || !selectedBusinessId) return;

    const userMessage = { role: 'user' as const, content: input };
    const currentHistory = [...messages, userMessage];
    
    setMessages(currentHistory);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch(window.api.getProxyUrl() + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: currentHistory, businessId: selectedBusinessId })
      });
      const data = await res.json();
      
      if (data.error) throw new Error(data.error);
      
      setMessages(prev => [...prev, { role: 'assistant', content: data.answer }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>G2i for Wave</h1>
        <div className="business-selector">
          <label>Business: </label>
          <select 
            value={selectedBusinessId} 
            onChange={(e) => setSelectedBusinessId(e.target.value)}
            disabled={businesses.length === 0}
          >
            {businesses.length === 0 && <option>Loading...</option>}
            {businesses.map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      </header>
      
      <main className="chat-container">
        {error && <div className="error-banner">{error}</div>}
        <div className="messages-area">
          {messages.length === 0 && (
            <div className="empty-state">
              <p>Ask a financial question, e.g., "how much have we invoiced for PO 'abc' for client 'xyz'?"</p>
            </div>
          )}
          {messages.map((m, idx) => {
            const hasTable = m.content.includes('|');
            return (
              <div key={idx} className={`message-wrapper ${m.role}`}>
                <div className={`message-bubble ${hasTable ? 'wide-bubble' : ''}`}>
                  {renderMessageContent(m.content)}
                </div>
              </div>
            );
          })}
          {isLoading && (
            <div className="message-wrapper assistant">
              <div className="message-bubble loading">Analyzing...</div>
            </div>
          )}
        </div>
        
        <div className="input-area">
          <input 
            type="text" 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
            placeholder="Type your query..."
            disabled={isLoading || !selectedBusinessId}
          />
          <button onClick={sendMessage} disabled={isLoading || !input.trim() || !selectedBusinessId}>
            Send
          </button>
        </div>
      </main>
    </div>
  );
}

export default App;
