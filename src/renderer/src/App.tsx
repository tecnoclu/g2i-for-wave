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
          {messages.map((m, idx) => (
            <div key={idx} className={`message-wrapper ${m.role}`}>
              <div className="message-bubble">
                {m.content}
              </div>
            </div>
          ))}
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
