/**
 * Chat: renderizado de mensajes y streaming.
 */
const Chat = {
  _container: null,
  _currentStreamEl: null,  // elemento del mensaje en streaming
  _streamBuffer: '',       // texto acumulado durante streaming

  init(containerId) {
    this._container = document.getElementById(containerId);
  },

  clear() {
    this._container.innerHTML = '';
  },

  // Agregar mensaje del usuario
  addUserMessage(content) {
    this._hideWelcome();
    const el = this._createMessageEl('user', content, true);
    this._container.appendChild(el);
    this._scrollToBottom();
  },

  // Iniciar un mensaje de asistente (streaming)
  startAssistantMessage() {
    this._hideWelcome();
    this._streamBuffer = '';

    const el = this._createMessageEl('assistant', '', false);

    // Agregar cursor de streaming
    const body = el.querySelector('.message-body');
    body.innerHTML = '<span class="streaming-cursor"></span>';

    this._container.appendChild(el);
    this._currentStreamEl = el;
    this._scrollToBottom();
  },

  // Agregar thinking indicator
  showThinking() {
    const el = document.createElement('div');
    el.className = 'thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div><span>Claude esta pensando...</span>';
    this._container.appendChild(el);
    this._scrollToBottom();
  },

  hideThinking() {
    const el = document.getElementById('thinking-indicator');
    if (el) el.remove();
  },

  // Append texto durante streaming
  appendToStream(text) {
    if (!this._currentStreamEl) return;

    this._streamBuffer += text;

    const body = this._currentStreamEl.querySelector('.message-body');
    // Mostrar texto plano durante streaming (renderizar Markdown al final)
    const escaped = this._escapeHtml(this._streamBuffer);
    body.innerHTML = escaped + '<span class="streaming-cursor"></span>';

    this._scrollToBottom();
  },

  // Finalizar streaming: renderizar Markdown completo
  finalizeStream() {
    if (!this._currentStreamEl) return;

    const body = this._currentStreamEl.querySelector('.message-body');

    // Renderizar Markdown
    const html = marked.parse(this._streamBuffer, { breaks: true });
    body.innerHTML = html;

    // Highlight code blocks
    body.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });

    this._currentStreamEl = null;
    this._streamBuffer = '';
    this._scrollToBottom();
  },

  // Mostrar error
  showError(message) {
    const el = document.createElement('div');
    el.className = 'error-banner';
    el.textContent = message;
    this._container.appendChild(el);
    this._scrollToBottom();
  },

  // Mostrar aviso (warning amarillo)
  showWarning(message) {
    const el = document.createElement('div');
    el.className = 'warning-banner';
    el.textContent = message;
    this._container.appendChild(el);
    this._scrollToBottom();
  },

  // Mostrar mensaje de sistema (slash commands)
  showSystem(message) {
    this._hideWelcome();
    const el = document.createElement('div');
    el.className = 'system-banner';
    const pre = document.createElement('pre');
    pre.textContent = message;
    el.appendChild(pre);
    this._container.appendChild(el);
    this._scrollToBottom();
  },

  // Mostrar chat expirado
  showExpired(message) {
    const el = document.createElement('div');
    el.className = 'expired-banner';
    el.innerHTML = '<span class="expired-icon">&#9202;</span> ' + message;
    this._container.appendChild(el);
    this._scrollToBottom();
  },

  // Renderizar historial completo
  renderMessages(messages) {
    this.clear();
    this._hideWelcome();

    for (const msg of messages) {
      const el = this._createMessageEl(msg.role, msg.content, true);
      this._container.appendChild(el);
    }

    this._scrollToBottom();
  },

  // -- Helpers -----------------------------------------------------------------

  _createMessageEl(role, content, renderMarkdown) {
    const msg = document.createElement('div');
    msg.className = 'message';

    // Header
    const header = document.createElement('div');
    header.className = 'message-header';

    const roleEl = document.createElement('span');
    roleEl.className = 'message-role ' + role;
    roleEl.textContent = role === 'user' ? 'Tu' : 'Claude';
    header.appendChild(roleEl);

    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    header.appendChild(time);

    msg.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'message-body ' + role;

    if (renderMarkdown && content) {
      body.innerHTML = marked.parse(content, { breaks: true });
      // Highlight code
      body.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
      });
    } else {
      body.textContent = content;
    }

    msg.appendChild(body);
    return msg;
  },

  _hideWelcome() {
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.style.display = 'none';
  },

  showWelcome() {
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.style.display = '';
  },

  _escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  _scrollToBottom() {
    const area = document.getElementById('chat-area');
    requestAnimationFrame(() => {
      area.scrollTop = area.scrollHeight;
    });
  },
};
