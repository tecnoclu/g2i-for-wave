import React, { useState, useEffect, useRef } from 'react';
import './index.css';

interface Business {
  id: string;
  name: string;
}

interface LlmModel {
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
  
  const [models, setModels] = useState<LlmModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Settings Modal State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [waveToken, setWaveToken] = useState('');
  const [showWaveToken, setShowWaveToken] = useState(false);
  
  const [llmHost, setLlmHost] = useState('');
  const [llmPort, setLlmPort] = useState('');
  const [llmToken, setLlmToken] = useState('');
  const [showLlmToken, setShowLlmToken] = useState(false);
  
  const [operationMode, setOperationMode] = useState('READ_ONLY');
  const [pendingOperationMode, setPendingOperationMode] = useState<string | null>(null);
  const [confirmWriteInput, setConfirmWriteInput] = useState('');
  const [showWriteWarningModal, setShowWriteWarningModal] = useState(false);

  const [settingsStatus, setSettingsStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [waveTestResult, setWaveTestResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [llmTestResult, setLlmTestResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isTestingWave, setIsTestingWave] = useState(false);
  const [isTestingLlm, setIsTestingLlm] = useState(false);

  const loadBusinesses = async (initialSavedId?: string) => {
    const savedBusinessId = initialSavedId || localStorage.getItem('g2i_selected_business');
    try {
      const res = await fetch(window.api.getProxyUrl() + '/api/businesses');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const fetchedBusinesses = data.data?.businesses?.edges?.map((e: any) => e.node) || [];
      setBusinesses(fetchedBusinesses);
      setError(null);

      if (fetchedBusinesses.length > 0) {
        if (savedBusinessId && fetchedBusinesses.some((b: Business) => b.id === savedBusinessId)) {
          setSelectedBusinessId(savedBusinessId);
        } else {
          setSelectedBusinessId(fetchedBusinesses[0].id);
          localStorage.setItem('g2i_selected_business', fetchedBusinesses[0].id);
        }
      }
    } catch (err: any) {
      setError('Failed to load businesses. Check API token in Settings.');
    }
  };

  const loadModels = async (initialSavedId?: string) => {
    const savedModelId = initialSavedId || localStorage.getItem('g2i_selected_model');
    try {
      const res = await fetch(window.api.getProxyUrl() + '/api/llm/models');
      const data = await res.json();
      const fetchedModels = data.models || [];
      setModels(fetchedModels);
      if (fetchedModels.length > 0) {
        if (savedModelId && fetchedModels.some((m: LlmModel) => m.id === savedModelId)) {
          setSelectedModelId(savedModelId);
        } else {
          setSelectedModelId(fetchedModels[0].id);
          localStorage.setItem('g2i_selected_model', fetchedModels[0].id);
        }
      } else if (savedModelId) {
        setSelectedModelId(savedModelId);
      }
    } catch (err) {
      console.warn('Failed to load LLM models:', err);
    }
  };

  useEffect(() => {
    // Load initial settings first to get stored SELECTED_BUSINESS_ID and SELECTED_MODEL_ID from config.local.json
    fetch(window.api.getProxyUrl() + '/api/settings')
      .then(res => res.json())
      .then(settings => {
        loadBusinesses(settings.SELECTED_BUSINESS_ID);
        loadModels(settings.SELECTED_MODEL_ID);
      })
      .catch(() => {
        loadBusinesses();
        loadModels();
      });
  }, []);

  const handleBusinessChange = (newBusinessId: string) => {
    setSelectedBusinessId(newBusinessId);
    localStorage.setItem('g2i_selected_business', newBusinessId);
    // Persist to local config file (gitignored)
    fetch(window.api.getProxyUrl() + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ SELECTED_BUSINESS_ID: newBusinessId })
    }).catch(err => console.warn('Failed saving business selection to config.local.json:', err));
  };

  const handleModelChange = (newModelId: string) => {
    setSelectedModelId(newModelId);
    localStorage.setItem('g2i_selected_model', newModelId);
    // Persist to local config file (gitignored)
    fetch(window.api.getProxyUrl() + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ SELECTED_MODEL_ID: newModelId })
    }).catch(err => console.warn('Failed saving model selection to config.local.json:', err));
  };

  const openSettings = () => {
    setSettingsStatus(null);
    setWaveTestResult(null);
    setLlmTestResult(null);
    fetch(window.api.getProxyUrl() + '/api/settings')
      .then(res => res.json())
      .then(data => {
        setWaveToken(data.WAVE_API_TOKEN || '');
        setLlmHost(data.LLM_HOST || 'http://127.0.0.1');
        setLlmPort(String(data.LLM_PORT || 1234));
        setLlmToken(data.LLM_API_TOKEN || '');
        setOperationMode(data.OPERATION_MODE || 'READ_ONLY');
        setIsSettingsOpen(true);
      })
      .catch(err => alert('Failed to fetch settings from server.'));
  };

  const handleOperationModeChange = (newMode: string) => {
    if (newMode === 'READ_WRITE' && operationMode !== 'READ_WRITE') {
      setPendingOperationMode(newMode);
      setConfirmWriteInput('');
      setShowWriteWarningModal(true);
    } else {
      setOperationMode(newMode);
    }
  };

  const confirmWriteMode = () => {
    if (confirmWriteInput.trim().toUpperCase() === 'CONFIRM WRITE') {
      setOperationMode('READ_WRITE');
      setShowWriteWarningModal(false);
      setPendingOperationMode(null);
    } else {
      alert('Confirmation word mismatch. Please type "CONFIRM WRITE" exactly.');
    }
  };

  const testWaveConnection = async () => {
    setIsTestingWave(true);
    setWaveTestResult(null);
    try {
      const res = await fetch(window.api.getProxyUrl() + '/api/settings/test-wave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waveToken })
      });
      const data = await res.json();
      if (data.success) {
        setWaveTestResult({ type: 'success', text: `✅ ${data.message}` });
      } else {
        setWaveTestResult({ type: 'error', text: `❌ Wave Error: ${data.error}` });
      }
    } catch (err: any) {
      setWaveTestResult({ type: 'error', text: `❌ Connection failed: ${err.message}` });
    } finally {
      setIsTestingWave(false);
    }
  };

  const testLlmConnection = async () => {
    setIsTestingLlm(true);
    setLlmTestResult(null);
    try {
      const res = await fetch(window.api.getProxyUrl() + '/api/settings/test-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llmHost, llmPort: Number(llmPort), llmToken })
      });
      const data = await res.json();
      if (data.success) {
        setLlmTestResult({ type: 'success', text: `✅ ${data.message}` });
      } else {
        setLlmTestResult({ type: 'error', text: `❌ LLM Error: ${data.error}` });
      }
    } catch (err: any) {
      setLlmTestResult({ type: 'error', text: `❌ Connection failed: ${err.message}` });
    } finally {
      setIsTestingLlm(false);
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingSettings(true);
    setSettingsStatus(null);

    try {
      const res = await fetch(window.api.getProxyUrl() + '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          WAVE_API_TOKEN: waveToken,
          LLM_HOST: llmHost,
          LLM_PORT: Number(llmPort),
          LLM_API_TOKEN: llmToken,
          OPERATION_MODE: operationMode
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to save settings');

      setSettingsStatus({ type: 'success', text: 'Settings saved successfully!' });
      loadBusinesses();
      loadModels();
      setTimeout(() => setIsSettingsOpen(false), 1200);
    } catch (err: any) {
      setSettingsStatus({ type: 'error', text: err.message });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || !selectedBusinessId) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const userMessage = { role: 'user' as const, content: input };
    const currentHistory = [...messages, userMessage];
    
    setMessages(currentHistory);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch(window.api.getProxyUrl() + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ 
          history: currentHistory, 
          businessId: selectedBusinessId,
          model: selectedModelId 
        })
      });
      const data = await res.json();
      
      if (data.error) throw new Error(data.error);
      
      setMessages(prev => [...prev, { role: 'assistant', content: data.answer }]);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: '⏹️ *Generation stopped by user.*' }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>G2i for Wave</h1>
        
        <div className="header-controls">
          <div className="selector-group">
            <label>Business: </label>
            <select 
              value={selectedBusinessId} 
              onChange={(e) => handleBusinessChange(e.target.value)}
              disabled={businesses.length === 0}
            >
              {businesses.length === 0 && <option>Loading...</option>}
              {businesses.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          <div className="selector-group">
            <label>Model: </label>
            <select 
              value={selectedModelId} 
              onChange={(e) => handleModelChange(e.target.value)}
            >
              {models.length === 0 && <option value={selectedModelId || "local-model"}>{selectedModelId || "Default (local-model)"}</option>}
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <button className="settings-btn" onClick={openSettings} title="Settings">
            ⚙️
          </button>
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
            onKeyDown={(e) => e.key === 'Enter' && !isLoading && sendMessage()}
            placeholder={isLoading ? "Analyzing... (Type next question or click Stop)" : "Type your query..."}
            disabled={!selectedBusinessId}
          />
          {isLoading ? (
            <button className="stop-btn" onClick={stopGeneration} title="Stop response generation">
              ⏹️ Stop
            </button>
          ) : (
            <button onClick={sendMessage} disabled={!input.trim() || !selectedBusinessId}>
              Send
            </button>
          )}
        </div>
      </main>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Connection & Deployment Settings</h2>
              <button className="close-btn" onClick={() => setIsSettingsOpen(false)}>✕</button>
            </div>

            <form onSubmit={saveSettings} className="settings-form">
              {settingsStatus && (
                <div className={`status-message ${settingsStatus.type}`}>
                  {settingsStatus.text}
                </div>
              )}

              {/* Wave API Token Field */}
              <div className="form-group">
                <label>Wave API Token (Masked)</label>
                <div className="input-with-button">
                  <input 
                    type={showWaveToken ? "text" : "password"} 
                    value={waveToken}
                    onChange={(e) => setWaveToken(e.target.value)}
                    placeholder="Paste Wave Bearer Token"
                    required
                  />
                  <button 
                    type="button" 
                    className="toggle-mask-btn"
                    onClick={() => setShowWaveToken(!showWaveToken)}
                    title={showWaveToken ? "Hide Token" : "Show Token"}
                  >
                    {showWaveToken ? "🙈" : "👁️"}
                  </button>
                  <button 
                    type="button" 
                    className="test-btn" 
                    onClick={testWaveConnection}
                    disabled={isTestingWave || !waveToken}
                  >
                    {isTestingWave ? "Testing..." : "Test Wave Connection"}
                  </button>
                </div>
                {waveTestResult && (
                  <div className={`test-badge ${waveTestResult.type}`}>
                    {waveTestResult.text}
                  </div>
                )}
              </div>

              {/* LLM Connection Fields */}
              <div className="form-row">
                <div className="form-group flex-2">
                  <label>LLM Host Base URL</label>
                  <input 
                    type="text" 
                    value={llmHost}
                    onChange={(e) => setLlmHost(e.target.value)}
                    placeholder="http://127.0.0.1 or http://localhost"
                    required
                  />
                </div>
                <div className="form-group flex-1">
                  <label>LLM Port</label>
                  <input 
                    type="number" 
                    value={llmPort}
                    onChange={(e) => setLlmPort(e.target.value)}
                    placeholder="1234 / 2574"
                    required
                  />
                </div>
              </div>

              {/* LLM API Token */}
              <div className="form-group">
                <label>LLM API Token (Optional, Masked)</label>
                <div className="input-with-button">
                  <input 
                    type={showLlmToken ? "text" : "password"} 
                    value={llmToken}
                    onChange={(e) => setLlmToken(e.target.value)}
                    placeholder="Optional for local models / Required for OpenAI"
                  />
                  <button 
                    type="button" 
                    className="toggle-mask-btn"
                    onClick={() => setShowLlmToken(!showLlmToken)}
                    title={showLlmToken ? "Hide Token" : "Show Token"}
                  >
                    {showLlmToken ? "🙈" : "👁️"}
                  </button>
                  <button 
                    type="button" 
                    className="test-btn" 
                    onClick={testLlmConnection}
                    disabled={isTestingLlm || !llmHost || !llmPort}
                  >
                    {isTestingLlm ? "Testing..." : "Test LLM Connection"}
                  </button>
                </div>
                {llmTestResult && (
                  <div className={`test-badge ${llmTestResult.type}`}>
                    {llmTestResult.text}
                  </div>
                )}
              </div>

              {/* Operation Mode */}
              <div className="form-group">
                <label>
                  Operation Mode 
                  {operationMode === 'READ_WRITE' && <span className="warning-pill">⚠️ WRITE ACTIVE</span>}
                </label>
                <select 
                  value={operationMode} 
                  onChange={(e) => handleOperationModeChange(e.target.value)}
                >
                  <option value="READ_ONLY">READ_ONLY (Safe Mode: Data changes disabled)</option>
                  <option value="READ_WRITE">READ_WRITE (Write Mode: Can create invoices/estimates)</option>
                </select>
              </div>

              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setIsSettingsOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={isSavingSettings}>
                  {isSavingSettings ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Extra Confirmation Warning Sub-Modal for READ_WRITE Mode */}
      {showWriteWarningModal && (
        <div className="modal-overlay danger-overlay" onClick={() => setShowWriteWarningModal(false)}>
          <div className="modal-content danger-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header danger-header">
              <h2>⚠️ HIGH-RISK ACTION: ENABLE WRITE ACCESS</h2>
              <button className="close-btn" onClick={() => setShowWriteWarningModal(false)}>✕</button>
            </div>

            <div className="danger-body">
              <p>
                You are changing the operation mode to <strong>READ_WRITE</strong>.
              </p>
              <p className="danger-warning">
                This grants the AI assistant authorization to perform write mutations on your live Wave account (such as creating draft invoices, creating estimates, sending estimates, and approving estimates).
              </p>
              <p>
                To confirm this risk, type <strong>CONFIRM WRITE</strong> in the box below:
              </p>

              <input 
                type="text" 
                className="confirm-input"
                value={confirmWriteInput}
                onChange={(e) => setConfirmWriteInput(e.target.value)}
                placeholder="Type CONFIRM WRITE"
                autoFocus
              />

              <div className="modal-actions">
                <button 
                  type="button" 
                  className="btn-secondary" 
                  onClick={() => setShowWriteWarningModal(false)}
                >
                  Cancel (Stay Read-Only)
                </button>
                <button 
                  type="button" 
                  className="btn-danger"
                  disabled={confirmWriteInput.trim().toUpperCase() !== 'CONFIRM WRITE'}
                  onClick={confirmWriteMode}
                >
                  Enable Write Access
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
