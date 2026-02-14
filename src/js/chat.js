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
    const content = this._streamBuffer;

    // Renderizar Markdown
    const html = marked.parse(content, { breaks: true });
    body.innerHTML = html;

    // Highlight code blocks
    body.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });

    // Agregar boton copiar al header despues del streaming
    if (content) {
      const header = this._currentStreamEl.querySelector('.message-header');
      if (header && !header.querySelector('.copy-btn')) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.innerHTML = '&#128203;';
        copyBtn.title = 'Copiar';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(content).then(() => {
            copyBtn.innerHTML = '&#10003;';
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.innerHTML = '&#128203;';
              copyBtn.classList.remove('copied');
            }, 2000);
          });
        });
        header.appendChild(copyBtn);
      }
    }

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

  // -- Tool Activity -----------------------------------------------------------

  showToolStart(tool) {
    this._hideWelcome();
    const el = document.createElement('div');
    el.className = 'tool-block';
    el.id = 'tool-' + tool.tool_id;

    const icon = this._toolIcon(tool.tool_name);
    const label = this._toolLabel(tool.tool_name, tool.input);

    el.innerHTML = `
      <div class="tool-header">
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${this._escapeHtml(tool.tool_name)}</span>
        <span class="tool-label">${this._escapeHtml(label)}</span>
        <span class="tool-spinner"></span>
      </div>
      <div class="tool-preview">${this._toolPreview(tool.tool_name, tool.input)}</div>
    `;

    this._container.appendChild(el);
    this._scrollToBottom();
  },

  showToolResult(tool) {
    const el = document.getElementById('tool-' + tool.tool_id);
    if (!el) return;

    // Quitar spinner, agregar status
    const spinner = el.querySelector('.tool-spinner');
    if (spinner) {
      spinner.remove();
    }

    const header = el.querySelector('.tool-header');
    const status = document.createElement('span');
    status.className = tool.is_error ? 'tool-status error' : 'tool-status success';
    status.textContent = tool.is_error ? 'Error' : 'OK';
    header.appendChild(status);

    // Agregar resultado colapsable si hay contenido
    if (tool.result && tool.result.trim()) {
      const preview = el.querySelector('.tool-preview');
      const lines = tool.result.split('\n');
      const truncated = lines.length > 8;
      const display = truncated ? lines.slice(0, 8).join('\n') + '\n...' : tool.result;

      const resultEl = document.createElement('div');
      resultEl.className = 'tool-result';
      resultEl.innerHTML = `<pre>${this._escapeHtml(display)}</pre>`;

      if (truncated) {
        const toggle = document.createElement('button');
        toggle.className = 'tool-expand';
        toggle.textContent = `Ver todo (${lines.length} lineas)`;
        toggle.addEventListener('click', () => {
          const pre = resultEl.querySelector('pre');
          if (toggle.dataset.expanded === '1') {
            pre.textContent = display;
            toggle.textContent = `Ver todo (${lines.length} lineas)`;
            toggle.dataset.expanded = '0';
          } else {
            pre.textContent = tool.result;
            toggle.textContent = 'Colapsar';
            toggle.dataset.expanded = '1';
          }
        });
        resultEl.appendChild(toggle);
      }

      preview.appendChild(resultEl);
    }

    this._scrollToBottom();
  },

  // Tool approval — pedir permiso antes de ejecutar
  _onToolApproval: null, // callback set by App

  showToolApproval(tool) {
    this._hideWelcome();
    const el = document.createElement('div');
    el.className = 'tool-approval-block';
    el.id = 'approval-' + tool.tool_id;

    const icon = this._toolIcon(tool.tool_name);
    const inp = tool.input || {};

    // Construir preview enriquecido segun el tool
    let summaryHtml = '';
    let hasFullPreview = false;

    switch (tool.tool_name) {
      case 'Write': {
        const fp = inp.file_path || 'archivo';
        const content = inp.content || '';
        const lines = content.split('\n');
        const previewLines = lines.slice(0, 12).join('\n');
        const suffix = lines.length > 12 ? `\n... (${lines.length} lineas total)` : '';
        summaryHtml = `
          <div class="approval-file-path">${this._escapeHtml(fp)}</div>
          <pre class="approval-content-preview">${this._escapeHtml(previewLines + suffix)}</pre>
        `;
        hasFullPreview = lines.length > 12;
        break;
      }
      case 'Edit': {
        const fp = inp.file_path || 'archivo';
        summaryHtml = `<div class="approval-file-path">${this._escapeHtml(fp)}</div>`;
        if (inp.old_string) {
          summaryHtml += `<div class="approval-diff-label">Eliminar:</div><pre class="tool-diff-del">${this._escapeHtml(inp.old_string)}</pre>`;
        }
        if (inp.new_string) {
          summaryHtml += `<div class="approval-diff-label">Agregar:</div><pre class="tool-diff-add">${this._escapeHtml(inp.new_string)}</pre>`;
        }
        hasFullPreview = (inp.old_string && inp.old_string.split('\n').length > 15) ||
                         (inp.new_string && inp.new_string.split('\n').length > 15);
        break;
      }
      case 'Bash': {
        const cmd = inp.command || '';
        const desc = inp.description || '';
        summaryHtml = desc ? `<div class="approval-desc">${this._escapeHtml(desc)}</div>` : '';
        summaryHtml += `<pre class="tool-cmd">${this._escapeHtml(cmd)}</pre>`;
        break;
      }
      default: {
        const label = this._toolLabel(tool.tool_name, inp);
        if (label) summaryHtml = `<div class="approval-desc">${this._escapeHtml(label)}</div>`;
      }
    }

    el.innerHTML = `
      <div class="tool-approval-header">
        <span class="tool-icon">${icon}</span>
        <span class="tool-approval-title">Claude quiere usar <strong>${this._escapeHtml(tool.tool_name)}</strong></span>
      </div>
      <div class="tool-approval-body">${summaryHtml}</div>
      <div class="tool-approval-actions">
        ${hasFullPreview ? '<button class="tool-preview-btn">Ver completo</button>' : ''}
        <button class="tool-approve-btn">Aprobar</button>
        <button class="tool-deny-btn">Rechazar</button>
      </div>
    `;

    // Preview completo en modal
    if (hasFullPreview) {
      el.querySelector('.tool-preview-btn').addEventListener('click', () => {
        this._showPreviewModal(tool);
      });
    }

    // Aprobar
    el.querySelector('.tool-approve-btn').addEventListener('click', () => {
      const actions = el.querySelector('.tool-approval-actions');
      actions.innerHTML = '<span class="tool-approval-status approved">Aprobado</span>';
      el.classList.add('decided');
      if (this._onToolApproval) this._onToolApproval(true);
    });

    // Rechazar
    el.querySelector('.tool-deny-btn').addEventListener('click', () => {
      const actions = el.querySelector('.tool-approval-actions');
      actions.innerHTML = '<span class="tool-approval-status denied">Rechazado</span>';
      el.classList.add('decided');
      if (this._onToolApproval) this._onToolApproval(false);
    });

    this._container.appendChild(el);
    this._scrollToBottom();
  },

  _showPreviewModal(tool) {
    // Quitar modal anterior si existe
    const prev = document.getElementById('preview-modal');
    if (prev) prev.remove();

    const inp = tool.input || {};
    let contentHtml = '';
    let title = '';

    switch (tool.tool_name) {
      case 'Write': {
        title = inp.file_path || 'Nuevo archivo';
        const content = inp.content || '';
        // Renderizar con numeros de linea
        const lines = content.split('\n');
        const numbered = lines.map((line, i) =>
          `<span class="preview-ln">${String(i + 1).padStart(4)}</span>${this._escapeHtml(line)}`
        ).join('\n');
        contentHtml = `<pre class="preview-code">${numbered}</pre>`;
        break;
      }
      case 'Edit': {
        title = inp.file_path || 'Editar archivo';
        let parts = '';
        if (inp.old_string) {
          const oldLines = inp.old_string.split('\n').map(l =>
            `<span class="preview-del">- ${this._escapeHtml(l)}</span>`
          ).join('\n');
          parts += oldLines + '\n';
        }
        if (inp.new_string) {
          const newLines = inp.new_string.split('\n').map(l =>
            `<span class="preview-add">+ ${this._escapeHtml(l)}</span>`
          ).join('\n');
          parts += newLines;
        }
        contentHtml = `<pre class="preview-code">${parts}</pre>`;
        break;
      }
      default: {
        title = tool.tool_name;
        contentHtml = `<pre class="preview-code">${this._escapeHtml(JSON.stringify(inp, null, 2))}</pre>`;
      }
    }

    const modal = document.createElement('div');
    modal.id = 'preview-modal';
    modal.className = 'preview-modal-overlay';
    modal.innerHTML = `
      <div class="preview-modal">
        <div class="preview-modal-header">
          <span class="preview-modal-title">${this._escapeHtml(title)}</span>
          <button class="preview-modal-close">&times;</button>
        </div>
        <div class="preview-modal-body">${contentHtml}</div>
      </div>
    `;

    // Cerrar
    modal.querySelector('.preview-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', handler);
      }
    });

    document.body.appendChild(modal);
  },

  _toolIcon(name) {
    const icons = {
      Bash: '&#9654;',      // ▶
      Edit: '&#9998;',      // ✎
      Write: '&#128221;',   // 📝
      Read: '&#128214;',    // 📖
      Glob: '&#128269;',    // 🔍
      Grep: '&#128270;',    // 🔎
      WebFetch: '&#127760;',// 🌐
      WebSearch: '&#127760;',// 🌐
      Task: '&#9881;',      // ⚙
    };
    return icons[name] || '&#128295;'; // 🔧
  },

  _toolLabel(name, input) {
    if (!input) return '';
    switch (name) {
      case 'Bash':
        return input.command ? '$ ' + input.command.slice(0, 60) : '';
      case 'Edit':
        return input.file_path || '';
      case 'Write':
        return input.file_path || '';
      case 'Read':
        return input.file_path || '';
      case 'Glob':
        return input.pattern || '';
      case 'Grep':
        return input.pattern || '';
      case 'WebFetch':
        return input.url || '';
      case 'WebSearch':
        return input.query || '';
      default:
        return '';
    }
  },

  _toolPreview(name, input) {
    if (!input) return '';
    switch (name) {
      case 'Bash': {
        const cmd = input.command || '';
        const desc = input.description || '';
        return desc
          ? `<div class="tool-desc">${this._escapeHtml(desc)}</div><pre class="tool-cmd">${this._escapeHtml(cmd)}</pre>`
          : `<pre class="tool-cmd">${this._escapeHtml(cmd)}</pre>`;
      }
      case 'Edit': {
        if (!input.old_string && !input.new_string) return '';
        let html = '';
        if (input.old_string) {
          html += `<pre class="tool-diff-del">${this._escapeHtml(input.old_string)}</pre>`;
        }
        if (input.new_string) {
          html += `<pre class="tool-diff-add">${this._escapeHtml(input.new_string)}</pre>`;
        }
        return html;
      }
      case 'Write': {
        const content = input.content || '';
        if (!content) return '';
        const lines = content.split('\n');
        const preview = lines.slice(0, 6).join('\n');
        const suffix = lines.length > 6 ? `\n... (${lines.length} lineas)` : '';
        return `<pre class="tool-file-preview">${this._escapeHtml(preview + suffix)}</pre>`;
      }
      case 'Read': {
        const file = input.file_path || '';
        const offset = input.offset ? ` (desde linea ${input.offset})` : '';
        return file ? `<span class="tool-file-path">${this._escapeHtml(file)}${offset}</span>` : '';
      }
      default:
        return '';
    }
  },

  // AskUserQuestion — preguntas interactivas de Claude
  _onUserAnswer: null, // callback set by App — recibe objeto {question: answer, ...}

  showAskUser(tool) {
    this._hideWelcome();
    const questions = tool.input?.questions;
    if (!questions || !questions.length) return;

    const el = document.createElement('div');
    el.className = 'ask-user-block';
    el.id = 'ask-' + tool.tool_id;

    // Tracking de respuestas: {index: answer}
    const answers = {};
    const totalQuestions = questions.length;

    // Referencia al boton de enviar (se crea al final)
    let sendBtn = null;

    const checkAllAnswered = () => {
      const answered = Object.keys(answers).length;
      if (sendBtn) {
        sendBtn.disabled = answered < totalQuestions;
        sendBtn.textContent = answered < totalQuestions
          ? `Responder (${answered}/${totalQuestions})`
          : 'Enviar respuestas';
      }
    };

    questions.forEach((q, idx) => {
      const qEl = document.createElement('div');
      qEl.className = 'ask-question';

      const header = document.createElement('div');
      header.className = 'ask-header';
      if (q.header) {
        const tag = document.createElement('span');
        tag.className = 'ask-tag';
        tag.textContent = q.header;
        header.appendChild(tag);
      }
      const qText = document.createElement('span');
      qText.className = 'ask-text';
      qText.textContent = q.question;
      header.appendChild(qText);
      qEl.appendChild(header);

      const optionsEl = document.createElement('div');
      optionsEl.className = 'ask-options';

      // Input personalizado
      const customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.className = 'ask-custom-input';
      customInput.placeholder = 'Respuesta personalizada...';

      if (q.options) {
        for (const opt of q.options) {
          const btn = document.createElement('button');
          btn.className = 'ask-option-btn';
          btn.innerHTML = `<span class="ask-opt-label">${this._escapeHtml(opt.label)}</span>` +
            (opt.description ? `<span class="ask-opt-desc">${this._escapeHtml(opt.description)}</span>` : '');
          btn.addEventListener('click', () => {
            // Toggle: deseleccionar si ya estaba seleccionado
            if (btn.classList.contains('selected')) {
              btn.classList.remove('selected');
              delete answers[idx];
            } else {
              // Deseleccionar otros de esta pregunta
              optionsEl.querySelectorAll('.ask-option-btn').forEach(b => b.classList.remove('selected'));
              btn.classList.add('selected');
              answers[idx] = { question: q.question, answer: opt.label };
              // Limpiar custom input si habia texto
              customInput.value = '';
            }
            checkAllAnswered();
          });
          optionsEl.appendChild(btn);
        }
      }

      // Custom input (sin boton propio, solo marca respuesta al escribir)
      const customRow = document.createElement('div');
      customRow.className = 'ask-custom-row';
      customInput.addEventListener('input', () => {
        const val = customInput.value.trim();
        if (val) {
          // Deseleccionar botones de opciones
          optionsEl.querySelectorAll('.ask-option-btn').forEach(b => b.classList.remove('selected'));
          answers[idx] = { question: q.question, answer: val };
        } else {
          // Si borro el texto y no hay opcion seleccionada, quitar respuesta
          const selected = optionsEl.querySelector('.ask-option-btn.selected');
          if (!selected) delete answers[idx];
        }
        checkAllAnswered();
      });
      customRow.appendChild(customInput);

      qEl.appendChild(optionsEl);
      qEl.appendChild(customRow);
      el.appendChild(qEl);
    });

    // Boton unico de enviar al final
    const sendRow = document.createElement('div');
    sendRow.className = 'ask-send-row';
    sendBtn = document.createElement('button');
    sendBtn.className = 'ask-send-btn';
    sendBtn.textContent = `Responder (0/${totalQuestions})`;
    sendBtn.disabled = true;
    sendBtn.addEventListener('click', () => {
      // Deshabilitar todo el bloque
      el.querySelectorAll('button').forEach(b => b.disabled = true);
      el.querySelectorAll('input').forEach(i => i.disabled = true);
      sendBtn.textContent = 'Enviado';
      sendBtn.classList.add('sent');

      // Enviar todas las respuestas
      if (this._onUserAnswer) {
        this._onUserAnswer(answers);
      }
    });
    sendRow.appendChild(sendBtn);
    el.appendChild(sendRow);

    checkAllAnswered();
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

    // Boton copiar (solo en mensajes de assistant)
    if (role === 'assistant' && content) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.innerHTML = '&#128203;';
      copyBtn.title = 'Copiar';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(content).then(() => {
          copyBtn.innerHTML = '&#10003;';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.innerHTML = '&#128203;';
            copyBtn.classList.remove('copied');
          }, 2000);
        });
      });
      header.appendChild(copyBtn);
    }

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
