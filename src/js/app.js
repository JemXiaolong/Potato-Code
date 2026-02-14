/**
 * App: logica principal de POTATO Code.
 */
const App = {
  state: {
    currentSessionId: null,
    claudeSessionId: null,  // session_id de Claude Code para --resume
    messages: [],        // { role, content, timestamp, model }
    isStreaming: false,
    claudeInstalled: false,
    chatExpired: false,
    workingDir: null,    // carpeta de proyecto para Claude
    allowedTools: [],    // herramientas auto-aprobadas (no piden permiso)
    unrestricted: true,  // modo sin restricciones (todo auto-aprobado)
    sessionApprovedTools: [], // tools aprobados durante esta sesion (reset al hacer new chat)
  },

  _warningTimeout: null,    // 4 min inactividad: "Sigues ahi?"
  _killTimeout: null,        // 5 min inactividad: expirar chat

  invoke: null,

  async init() {
    // Tauri IPC
    if (window.__TAURI__) {
      this.invoke = window.__TAURI__.core.invoke;
    } else {
      console.warn('Tauri API no disponible');
      this.invoke = async () => null;
    }

    // Init chat renderer
    Chat.init('chat-messages');

    // Verificar que claude esta instalado
    await this._checkClaude();

    // Event listeners
    document.getElementById('send-btn').addEventListener('click', () => this.sendMessage());
    document.getElementById('stop-btn').addEventListener('click', () => this.stopGeneration());
    document.getElementById('new-chat-btn').addEventListener('click', () => this.newChat());
    document.getElementById('sidebar-toggle').addEventListener('click', () => this.toggleSidebar());
    document.getElementById('settings-btn').addEventListener('click', () => this._showSettings());

    // Input: auto-resize + shortcuts
    const input = document.getElementById('input-box');
    input.addEventListener('input', () => this._autoResize(input));
    input.addEventListener('keydown', (e) => this._onInputKeyDown(e));

    // Global shortcuts
    document.addEventListener('keydown', (e) => this._onKeyDown(e));

    // Cargar settings
    await this._loadSettings();

    // Cargar historial de chats
    await this._loadChatList();

    // Tracker de inactividad
    this._initInactivityTracker();

    // Focus input
    input.focus();
  },

  // -- Claude check ------------------------------------------------------------

  async _checkClaude() {
    try {
      const version = await this.invoke('check_claude');
      this.state.claudeInstalled = true;
      this._setStatus('Claude Code ' + version);
    } catch (err) {
      this.state.claudeInstalled = false;
      this._setStatus('Claude Code no instalado');
      Chat.showError('Claude Code no esta instalado.\n\nInstala con: npm install -g @anthropic-ai/claude-code');
    }
  },

  // -- Send message ------------------------------------------------------------

  async sendMessage() {
    if (this.state.isStreaming) return;
    if (this.state.chatExpired) {
      Chat.showError('Este chat ha expirado. Inicia uno nuevo con Ctrl+N.');
      return;
    }
    if (!this.state.claudeInstalled) {
      Chat.showError('Claude Code no esta instalado.');
      return;
    }

    const input = document.getElementById('input-box');
    const text = input.value.trim();
    if (!text) return;

    // Interceptar slash commands
    if (text.startsWith('/')) {
      input.value = '';
      this._autoResize(input);
      this._handleSlashCommand(text);
      return;
    }

    // Limpiar input
    input.value = '';
    this._autoResize(input);

    // Crear sesion si no existe
    if (!this.state.currentSessionId) {
      this.state.currentSessionId = this._generateId();
    }

    // Iniciar timer de inactividad (desde que envias, empieza a contar)
    this._resetInactivityTimers();

    // Agregar mensaje del usuario
    const timestamp = new Date().toISOString();
    const model = document.getElementById('model-select').value;

    this.state.messages.push({
      role: 'user',
      content: text,
      timestamp,
      model,
    });

    Chat.addUserMessage(text);

    // Iniciar streaming
    this.state.isStreaming = true;
    this._setStreamingUI(true);
    this._setStatus('Generando respuesta...');

    Chat.showThinking();

    // Crear Channel para recibir streaming en tiempo real
    const channel = new window.__TAURI__.core.Channel();
    let streamStarted = false;

    channel.onmessage = (chunk) => {
      // Capturar session_id de Claude para mantener conversacion
      if (chunk.session_id) {
        this.state.claudeSessionId = chunk.session_id;
      }

      // Tool activity
      if (chunk.tool) {
        Chat.hideThinking();
        // Si habia texto en streaming, finalizarlo antes del tool block
        if (streamStarted && Chat._currentStreamEl) {
          Chat.finalizeStream();
          streamStarted = false;
        }

        // Fase "ask" — AskUserQuestion (proceso ya matado por backend)
        if (chunk.tool.phase === 'ask') {
          this.state.isStreaming = false;
          this._setStreamingUI(false);
          this._setStatus('Claude te hace una pregunta...');
          Chat._onUserAnswer = (answers) => {
            Chat._onUserAnswer = null;
            this._answerQuestion(answers);
          };
          Chat.showAskUser(chunk.tool);
          return;
        }

        // Fase "approval" — tool necesita aprobacion (proceso ya matado por backend)
        if (chunk.tool.phase === 'approval') {
          this.state.isStreaming = false;
          this._setStreamingUI(false);
          this._setStatus('Claude necesita tu aprobacion...');
          Chat._onToolApproval = (approved) => {
            Chat._onToolApproval = null;
            if (approved) {
              this.state.sessionApprovedTools.push(chunk.tool.tool_name);
              this._resumeAfterApproval(chunk.tool);
            } else {
              this._resumeAfterDenial(chunk.tool);
            }
          };
          Chat.showToolApproval(chunk.tool);
          return;
        }

        // Fase normal: start / result
        if (chunk.tool.phase === 'start') {
          this._setStatus('Usando ' + chunk.tool.tool_name + '...');
          Chat.showToolStart(chunk.tool);
        } else if (chunk.tool.phase === 'result') {
          Chat.showToolResult(chunk.tool);
          this._setStatus('Generando respuesta...');
        }
        return;
      }

      if (chunk.done) {
        const fullResponse = Chat._streamBuffer || '';
        if (fullResponse) {
          this.state.messages.push({
            role: 'assistant',
            content: fullResponse,
            timestamp: new Date().toISOString(),
            model,
          });
        }

        Chat.finalizeStream();
        this.state.isStreaming = false;
        this._setStreamingUI(false);
        this._setStatus('Ready');
        this._saveCurrentChat();

        // Token counter
        if (chunk.usage) {
          this._updateTokenInfo(chunk.usage.input_tokens, chunk.usage.output_tokens);
        }
        return;
      }

      if (!streamStarted) {
        Chat.hideThinking();
        Chat.startAssistantMessage();
        streamStarted = true;
      }

      Chat.appendToStream(chunk.content);
    };

    // Construir allowedTools para el backend
    // null = unrestricted (todo auto-aprobado)
    // [...] = solo estos tools auto-aprobados, el resto pide permiso
    const allowedTools = this.state.unrestricted
      ? null
      : [...new Set([...this.state.allowedTools, ...this.state.sessionApprovedTools])];

    try {
      await this.invoke('send_message', {
        message: text,
        processId: this.state.currentSessionId,
        sessionId: this.state.claudeSessionId,
        model,
        workingDir: this.state.workingDir,
        allowedTools,
        onEvent: channel,
      });

    } catch (err) {
      Chat.hideThinking();
      if (Chat._currentStreamEl) {
        Chat.finalizeStream();
      }
      Chat.showError('Error: ' + err);
      this.state.isStreaming = false;
      this._setStreamingUI(false);
      this._setStatus('Error');
    }
  },

  // -- Inactividad --------------------------------------------------------------

  _initInactivityTracker() {
    const input = document.getElementById('input-box');
    const chatArea = document.getElementById('chat-area');

    // Escribir en el input
    input.addEventListener('input', () => this._onUserActivity());

    // Enviar mensaje
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) this._onUserActivity();
    });

    // Scrollear en el chat
    chatArea.addEventListener('scroll', () => this._onUserActivity(), { passive: true });
  },

  _onUserActivity() {
    if (this.state.chatExpired) return;
    this._hideInactivityPopup();
    this._resetInactivityTimers();
  },

  _resetInactivityTimers() {
    if (this._warningTimeout) clearTimeout(this._warningTimeout);
    if (this._killTimeout) clearTimeout(this._killTimeout);

    // Solo activar timers si hay una sesion activa con mensajes
    if (!this.state.currentSessionId || this.state.messages.length === 0) return;

    // 4 minutos: aviso popup
    this._warningTimeout = setTimeout(() => {
      this._showInactivityPopup();
    }, 4 * 60 * 1000);

    // 5 minutos: expirar chat
    this._killTimeout = setTimeout(() => {
      this._hideInactivityPopup();
      this._expireChat();
    }, 5 * 60 * 1000);
  },

  _showInactivityPopup() {
    // No duplicar
    if (document.getElementById('inactivity-popup')) return;

    const overlay = document.createElement('div');
    overlay.id = 'inactivity-popup';
    overlay.className = 'popup-overlay';

    overlay.innerHTML = `
      <div class="popup-box">
        <div class="popup-icon">&#9202;</div>
        <div class="popup-title">Sigues ahi?</div>
        <div class="popup-msg">Llevas un rato sin actividad. El chat se cerrara pronto.</div>
        <button class="popup-btn" id="still-here-btn">Sigo aqui</button>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('still-here-btn').addEventListener('click', () => {
      this._hideInactivityPopup();
      this._resetInactivityTimers();
    });

    this._setStatus('Inactivo...');
  },

  _hideInactivityPopup() {
    const popup = document.getElementById('inactivity-popup');
    if (popup) popup.remove();
  },

  async _answerQuestion(answers) {
    // answers = {0: {question, answer}, 1: {question, answer}, ...}
    // El proceso ya fue matado por el backend, enviar con --resume
    const parts = Object.values(answers).map(a =>
      `"${a.question}" -> ${a.answer}`
    );
    const msg = parts.length === 1
      ? `Mi respuesta: ${parts[0]}`
      : `Mis respuestas:\n${parts.join('\n')}`;

    const input = document.getElementById('input-box');
    input.value = msg;
    this.sendMessage();
  },

  _resumeAfterApproval(tool) {
    // Construir mensaje con los detalles completos del tool para que Claude lo re-ejecute
    const inp = tool.input || {};
    let details = '';

    switch (tool.tool_name) {
      case 'Write':
        details = `Crea el archivo "${inp.file_path}" con exactamente el mismo contenido que ibas a escribir. Hazlo ahora.`;
        break;
      case 'Edit':
        details = `Edita el archivo "${inp.file_path}". ` +
          (inp.old_string ? `Reemplaza:\n${inp.old_string}\nPor:\n${inp.new_string}` : 'Aplica el cambio que ibas a hacer.');
        break;
      case 'Bash':
        details = `Ejecuta este comando:\n${inp.command}`;
        break;
      case 'WebFetch':
        details = `Fetch: ${inp.url}`;
        break;
      case 'WebSearch':
        details = `Busca: ${inp.query}`;
        break;
      default:
        details = `Usa ${tool.tool_name} con los parametros que tenias planeados.`;
        if (Object.keys(inp).length > 0) {
          details += '\nParametros: ' + JSON.stringify(inp).slice(0, 500);
        }
    }

    const msg = `APROBADO. ${details}`;
    const input = document.getElementById('input-box');
    input.value = msg;
    this.sendMessage();
  },

  _resumeAfterDenial(tool) {
    const msg = `RECHAZADO: NO uses ${tool.tool_name}. Busca otra forma de resolver la tarea sin usar esa herramienta.`;
    const input = document.getElementById('input-box');
    input.value = msg;
    this.sendMessage();
  },

  async _expireChat() {
    // Matar proceso de claude si hay uno corriendo
    if (this.state.isStreaming) {
      try {
        await this.invoke('stop_generation', { processId: this.state.currentSessionId || '' });
      } catch (_) {}

      Chat.hideThinking();
      if (Chat._currentStreamEl) {
        Chat.finalizeStream();
      }
      this.state.isStreaming = false;
      this._setStreamingUI(false);
    }

    // Marcar como expirado
    this.state.chatExpired = true;

    Chat.showExpired('Chat terminado por inactividad (5 min).');
    this._setStatus('Chat expirado');

    // Deshabilitar input
    const input = document.getElementById('input-box');
    input.disabled = true;
    input.placeholder = 'Chat expirado - Inicia uno nuevo (Ctrl+N)';

    this._saveCurrentChat();
  },

  async stopGeneration() {
    try {
      await this.invoke('stop_generation', { processId: this.state.currentSessionId || '' });
    } catch (err) {
      // Ignorar si no hay proceso
    }

    Chat.hideThinking();
    if (Chat._currentStreamEl) {
      Chat.finalizeStream();
    }
    this.state.isStreaming = false;
    this._streamStarted = false;
    this._setStreamingUI(false);
    this._setStatus('Detenido');
  },

  // -- Chat sessions -----------------------------------------------------------

  newChat() {
    this._saveCurrentChat();

    // Reset
    this.state.currentSessionId = null;
    this.state.claudeSessionId = null;
    this.state.messages = [];
    this.state.chatExpired = false;
    this.state.sessionApprovedTools = [];
    Chat.clear();
    Chat.showWelcome();
    this._setStatus('Ready');

    // Rehabilitar input
    const input = document.getElementById('input-box');
    input.disabled = false;
    input.placeholder = 'Escribe tu mensaje...';

    // Deseleccionar en sidebar
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));

    input.focus();
  },

  async _saveCurrentChat() {
    if (!this.state.currentSessionId || this.state.messages.length === 0) return;

    const title = this.state.messages[0]?.content.slice(0, 50) || 'Chat sin titulo';

    try {
      await this.invoke('save_chat', {
        session: {
          id: this.state.currentSessionId,
          title,
          messages: this.state.messages,
          created_at: this.state.messages[0]?.timestamp || new Date().toISOString(),
          model: document.getElementById('model-select').value,
        },
      });

      await this._loadChatList();
    } catch (err) {
      console.warn('Error guardando chat:', err);
    }
  },

  async _loadChatList() {
    try {
      const chats = await this.invoke('list_chats');
      const list = document.getElementById('chat-list');

      if (!chats || chats.length === 0) {
        list.innerHTML = '<div class="sidebar-empty">Sin conversaciones</div>';
        return;
      }

      list.innerHTML = '';
      for (const chat of chats) {
        const item = document.createElement('div');
        item.className = 'chat-item';
        if (chat.id === this.state.currentSessionId) {
          item.classList.add('active');
        }

        const title = document.createElement('span');
        title.className = 'chat-item-title';
        title.textContent = chat.title;
        item.appendChild(title);

        const del = document.createElement('button');
        del.className = 'chat-item-delete';
        del.innerHTML = '&times;';
        del.title = 'Eliminar';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          this._deleteChat(chat.id);
        });
        item.appendChild(del);

        item.addEventListener('click', () => this._openChat(chat.id));
        list.appendChild(item);
      }
    } catch (err) {
      console.warn('Error cargando chats:', err);
    }
  },

  async _openChat(sessionId) {
    try {
      const chat = await this.invoke('load_chat', { sessionId });
      this.state.currentSessionId = chat.id;
      this.state.messages = chat.messages;

      Chat.renderMessages(chat.messages);

      // Highlight active
      document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
      // Re-load list to update active state
      await this._loadChatList();

      this._setStatus('Ready');
    } catch (err) {
      console.warn('Error abriendo chat:', err);
    }
  },

  async _deleteChat(sessionId) {
    try {
      await this.invoke('delete_chat', { sessionId });

      if (this.state.currentSessionId === sessionId) {
        this.newChat();
      }

      await this._loadChatList();
    } catch (err) {
      console.warn('Error eliminando chat:', err);
    }
  },

  // -- Slash commands -----------------------------------------------------------

  _handleSlashCommand(text) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
      case '/model': {
        if (arg) {
          // Cambiar modelo
          const select = document.getElementById('model-select');
          const aliases = {
            'sonnet': 'claude-sonnet-4-5-20250929',
            'opus': 'claude-opus-4-6',
            'haiku': 'claude-haiku-4-5-20251001',
          };
          const modelId = aliases[arg.toLowerCase()] || arg;
          const option = [...select.options].find(o => o.value === modelId);
          if (option) {
            select.value = modelId;
            Chat.showSystem('Modelo cambiado a: ' + option.text);
          } else {
            Chat.showError('Modelo no encontrado: ' + arg + '\nDisponibles: sonnet, opus, haiku');
          }
        } else {
          const select = document.getElementById('model-select');
          Chat.showSystem('Modelo actual: ' + select.options[select.selectedIndex].text + '\n\nUso: /model sonnet | opus | haiku');
        }
        break;
      }

      case '/clear':
        this.state.messages = [];
        Chat.clear();
        Chat.showWelcome();
        this._setStatus('Chat limpiado');
        break;

      case '/new':
        this.newChat();
        break;

      case '/dir':
      case '/folder':
      case '/project': {
        if (arg) {
          this.invoke('validate_folder', { path: arg }).then(valid => {
            if (valid) {
              this.state.workingDir = arg;
              this._saveSettings();
              Chat.showSystem('Carpeta de proyecto: ' + arg);
              this._setStatus('Proyecto: ' + arg.split('/').pop());
            } else {
              Chat.showError('Carpeta no existe: ' + arg);
            }
          });
        } else {
          Chat.showSystem('Carpeta actual: ' + (this.state.workingDir || 'No configurada') + '\n\nUso: /dir /ruta/al/proyecto');
        }
        break;
      }

      case '/config':
      case '/settings':
        this._showSettings();
        break;

      case '/help':
        Chat.showSystem(
          'Comandos disponibles:\n\n' +
          '/model [sonnet|opus|haiku]  — Ver o cambiar modelo\n' +
          '/dir /ruta/proyecto         — Cambiar carpeta de proyecto\n' +
          '/config                     — Abrir configuracion\n' +
          '/clear                      — Limpiar chat (mantiene sesion)\n' +
          '/new                        — Nuevo chat\n' +
          '/help                       — Mostrar esta ayuda'
        );
        break;

      default:
        Chat.showError('Comando no reconocido: ' + cmd + '\nEscribe /help para ver comandos disponibles.');
        break;
    }
  },

  // -- Settings ----------------------------------------------------------------

  async _loadSettings() {
    try {
      const settings = await this.invoke('load_settings');
      if (settings.workingDir) {
        this.state.workingDir = settings.workingDir;
      }
      if (Array.isArray(settings.allowedTools)) {
        this.state.allowedTools = settings.allowedTools;
      }
      if (typeof settings.unrestricted === 'boolean') {
        this.state.unrestricted = settings.unrestricted;
      }
    } catch (_) {}
  },

  async _saveSettings() {
    try {
      await this.invoke('save_settings', {
        settings: {
          workingDir: this.state.workingDir,
          allowedTools: this.state.allowedTools,
          unrestricted: this.state.unrestricted,
        },
      });
    } catch (_) {}
  },

  _showSettings() {
    // No duplicar
    if (document.getElementById('settings-popup')) return;

    const currentDir = this.state.workingDir || 'No configurado (usa directorio de la app)';

    const allTools = [
      { id: 'Read', label: 'Read', desc: 'Leer archivos' },
      { id: 'Edit', label: 'Edit', desc: 'Editar archivos' },
      { id: 'Write', label: 'Write', desc: 'Crear archivos' },
      { id: 'Bash', label: 'Bash', desc: 'Ejecutar comandos' },
      { id: 'Glob', label: 'Glob', desc: 'Buscar archivos' },
      { id: 'Grep', label: 'Grep', desc: 'Buscar en contenido' },
      { id: 'WebFetch', label: 'WebFetch', desc: 'Obtener contenido web' },
      { id: 'WebSearch', label: 'WebSearch', desc: 'Buscar en la web' },
    ];

    const toolCheckboxes = allTools.map(t => {
      const checked = this.state.allowedTools.includes(t.id) ? 'checked' : '';
      return `<label class="tool-checkbox">
        <input type="checkbox" value="${t.id}" ${checked} ${this.state.unrestricted ? 'disabled' : ''}>
        <span class="tool-name">${t.label}</span>
        <span class="tool-desc">${t.desc}</span>
      </label>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'settings-popup';
    overlay.className = 'popup-overlay';

    overlay.innerHTML = `
      <div class="popup-box settings-box">
        <div class="popup-title">Configuracion</div>

        <div class="settings-field">
          <label class="settings-label">Carpeta de proyecto</label>
          <p class="settings-hint">Claude usara esta carpeta como contexto (CLAUDE.md, archivos, etc.)</p>
          <div class="settings-dir-row">
            <input type="text" class="settings-input" id="settings-dir-input"
              value="${this.state.workingDir || ''}"
              placeholder="/home/jem/MiProyecto" spellcheck="false">
          </div>
          <div class="settings-current">Actual: ${currentDir}</div>
        </div>

        <div class="settings-field">
          <label class="settings-label">Permisos de herramientas</label>
          <p class="settings-hint">Controla que herramientas puede usar Claude</p>
          <label class="tool-checkbox unrestricted-toggle">
            <input type="checkbox" id="settings-unrestricted" ${this.state.unrestricted ? 'checked' : ''}>
            <span class="tool-name">Modo sin restricciones</span>
            <span class="tool-desc">Todas las herramientas sin pedir permiso</span>
          </label>
          <div class="tools-grid" id="settings-tools-grid">
            ${toolCheckboxes}
          </div>
        </div>

        <div class="settings-actions">
          <button class="popup-btn-secondary" id="settings-cancel">Cancelar</button>
          <button class="popup-btn" id="settings-save">Guardar</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Toggle unrestricted: deshabilitar/habilitar checkboxes
    const unrestrictedCheckbox = document.getElementById('settings-unrestricted');
    const toolsGrid = document.getElementById('settings-tools-grid');

    unrestrictedCheckbox.addEventListener('change', () => {
      const disabled = unrestrictedCheckbox.checked;
      toolsGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.disabled = disabled;
      });
      toolsGrid.classList.toggle('tools-disabled', disabled);
    });

    // Inicializar estado visual
    if (this.state.unrestricted) {
      toolsGrid.classList.add('tools-disabled');
    }

    document.getElementById('settings-cancel').addEventListener('click', () => {
      overlay.remove();
    });

    document.getElementById('settings-save').addEventListener('click', async () => {
      const input = document.getElementById('settings-dir-input');
      const dir = input.value.trim();

      if (dir) {
        const valid = await this.invoke('validate_folder', { path: dir });
        if (!valid) {
          input.style.borderColor = '#ef4444';
          input.placeholder = 'Esa carpeta no existe!';
          return;
        }
        this.state.workingDir = dir;
      } else {
        this.state.workingDir = null;
      }

      // Guardar modo unrestricted
      this.state.unrestricted = unrestrictedCheckbox.checked;

      // Guardar tools seleccionadas
      const selected = [];
      toolsGrid.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
        selected.push(cb.value);
      });
      this.state.allowedTools = selected;

      await this._saveSettings();
      overlay.remove();
      this._setStatus(this.state.workingDir ? 'Proyecto: ' + this.state.workingDir.split('/').pop() : 'Ready');
    });

    // Cerrar con Escape
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.remove();
    });

    document.getElementById('settings-dir-input').focus();
  },

  // -- UI helpers --------------------------------------------------------------

  toggleSidebar() {
    document.body.classList.toggle('sidebar-hidden');
  },

  _setStreamingUI(streaming) {
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const input = document.getElementById('input-box');

    if (streaming) {
      sendBtn.style.display = 'none';
      stopBtn.classList.remove('hidden');
      input.disabled = true;
      input.placeholder = 'Esperando respuesta...';
    } else {
      sendBtn.style.display = '';
      stopBtn.classList.add('hidden');
      input.disabled = false;
      input.placeholder = 'Escribe tu mensaje...';
      input.focus();
    }
  },

  _setStatus(text) {
    document.getElementById('status-text').textContent = text;
  },

  _autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
  },

  // -- Keyboard shortcuts ------------------------------------------------------

  _onInputKeyDown(e) {
    // Enter sin Shift = enviar
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessage();
    }
  },

  _onKeyDown(e) {
    // Escape = detener generacion
    if (e.key === 'Escape' && this.state.isStreaming) {
      this.stopGeneration();
      return;
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          this.newChat();
          break;
        case 'b':
          e.preventDefault();
          this.toggleSidebar();
          break;
      }
    }
  },

  // -- Helpers -----------------------------------------------------------------

  _updateTokenInfo(input, output) {
    const el = document.getElementById('token-info');
    if (el && input && output) {
      const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n;
      el.textContent = fmt(input) + ' in / ' + fmt(output) + ' out';
    }
  },

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },
};

// Iniciar cuando el DOM este listo
document.addEventListener('DOMContentLoaded', () => App.init());
