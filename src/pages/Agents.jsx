import React, { useState, useRef, useEffect } from 'react';
import { AGENTS, getAgentSystemPrompt } from '../lib/agents';
import { chat, listAvailableModels } from '../lib/ai-router';
import { useHealthStore } from '../store/healthStore';
import toast from 'react-hot-toast';

export default function Agents() {
  const [activeAgent, setActiveAgent] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeModel, setActiveModel] = useState(null);
  const { settings, agentConversations, addAgentMessage, clearAgentConversation, glucose } = useHealthStore();
  const messagesEndRef = useRef(null);

  useEffect(() => {
    const models = listAvailableModels();
    setActiveModel(models[0] || null);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agentConversations, loading]);

  const messages = activeAgent ? (agentConversations[activeAgent.id] || []) : [];

  const sendMessage = async () => {
    if (!input.trim() || loading || !activeAgent) return;
    const userMsg = { role: 'user', content: input.trim() };
    addAgentMessage(activeAgent.id, userMsg);
    setInput('');
    setLoading(true);

    try {
      const systemPrompt = getAgentSystemPrompt(
        activeAgent,
        settings.userName,
        activeAgent.id === 'glucocoach' || activeAgent.id === 'trendanalyst' ? glucose : null
      );

      const allMsgs = [...(agentConversations[activeAgent.id] || []), userMsg];
      const result = await chat({
        messages: allMsgs,
        system: systemPrompt,
        preferFor: activeAgent.preferFor,
      });

      addAgentMessage(activeAgent.id, { role: 'assistant', content: result.text });
      setActiveModel(result.model);
    } catch (err) {
      toast.error('Agent error: ' + err.message);
    }
    setLoading(false);
  };

  const handleKey = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // Grid view
  if (!activeAgent) return (
    <div className="page">
      <div className="page-header">
        <h1>AI Agents</h1>
        <div className="model-chip">
          {activeModel ? (
            <span>{activeModel.free ? '🟢' : '💳'} {activeModel.name}</span>
          ) : (
            <span className="no-model">⚠️ No AI configured — add keys in Settings</span>
          )}
        </div>
      </div>

      <div className="agents-grid">
        {AGENTS.map(agent => (
          <button
            key={agent.id}
            className="agent-card"
            onClick={() => setActiveAgent(agent)}
            style={{ '--agent-color': agent.color }}
          >
            <div className="agent-icon">{agent.icon}</div>
            <div className="agent-name">{agent.name}</div>
            <div className="agent-tagline">{agent.tagline}</div>
            <div className="agent-skills">
              {agent.skills.slice(0, 2).map((s, i) => (
                <span key={i} className="skill-tag">{s}</span>
              ))}
            </div>
            {agentConversations[agent.id]?.length > 0 && (
              <div className="chat-badge">{agentConversations[agent.id].length / 2} chats</div>
            )}
          </button>
        ))}
      </div>

      <div className="info-card">
        <strong>💡 Free AI models available:</strong>
        <ul>
          <li>Groq (Llama 3.1 70B) — <a href="https://console.groq.com" target="_blank" rel="noreferrer">console.groq.com</a></li>
          <li>Google Gemini Flash — <a href="https://aistudio.google.com" target="_blank" rel="noreferrer">aistudio.google.com</a></li>
          <li>Mistral AI — <a href="https://console.mistral.ai" target="_blank" rel="noreferrer">console.mistral.ai</a></li>
          <li>Ollama (local, totally private) — <a href="https://ollama.ai" target="_blank" rel="noreferrer">ollama.ai</a></li>
        </ul>
        Add keys in <strong>Settings → AI Models</strong>
      </div>
    </div>
  );

  // Chat view
  return (
    <div className="page chat-page">
      <div className="chat-header">
        <button className="back-btn" onClick={() => setActiveAgent(null)}>← Back</button>
        <div className="chat-agent-info">
          <span className="chat-agent-icon">{activeAgent.icon}</span>
          <div>
            <div className="chat-agent-name">{activeAgent.name}</div>
            <div className="chat-agent-sub">
              {activeModel ? `${activeModel.name}` : 'No model'} · {activeAgent.tagline}
            </div>
          </div>
        </div>
        <button className="clear-btn" onClick={() => { clearAgentConversation(activeAgent.id); toast.success('Cleared'); }}>
          🗑
        </button>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-welcome">
            <div className="welcome-icon">{activeAgent.icon}</div>
            <div className="welcome-name">Hi! I'm {activeAgent.name}</div>
            <div className="welcome-desc">{activeAgent.description}</div>
            <div className="starters">
              <div className="starters-label">Try asking:</div>
              {activeAgent.starters.map((s, i) => (
                <button key={i} className="starter-btn" onClick={() => { setInput(s); }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' && (
              <div className="msg-agent-icon">{activeAgent.icon}</div>
            )}
            <div className="msg-bubble">{m.content}</div>
          </div>
        ))}

        {loading && (
          <div className="msg assistant">
            <div className="msg-agent-icon">{activeAgent.icon}</div>
            <div className="msg-bubble typing">
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          className="chat-textarea"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={`Ask ${activeAgent.name}...`}
          rows={1}
        />
        <button
          className="send-btn"
          onClick={sendMessage}
          disabled={loading || !input.trim()}
          style={{ '--agent-color': activeAgent.color }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
