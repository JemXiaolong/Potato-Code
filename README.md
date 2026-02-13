# POTATO Code

Interfaz grafica de escritorio para [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI de Anthropic). Construida con [Tauri v2](https://v2.tauri.app/) + Rust + JavaScript vanilla.

POTATO Code envuelve el CLI de Claude Code en una ventana nativa con chat en tiempo real, historial de sesiones, seleccion de modelos y configuracion de proyecto.

## Funcionalidades

- **Chat en tiempo real** — Streaming token por token via `stream-json` + Tauri Channels
- **Seleccion de modelo** — Sonnet 4.5, Opus 4.6 y Haiku 4.5 desde un selector en la barra
- **Persistencia de sesion** — Las conversaciones se mantienen con `--resume` (session ID de Claude)
- **Historial de chats** — Sidebar con lista de conversaciones guardadas, reanudables y eliminables
- **Carpeta de proyecto** — Configura el directorio de trabajo para que Claude tenga contexto de tu codigo
- **Timeout por inactividad** — Aviso a los 4 min, expiracion automatica a los 5 min sin actividad
- **Slash commands** — `/model`, `/dir`, `/config`, `/clear`, `/new`, `/help`
- **Markdown + Syntax highlighting** — Respuestas renderizadas con [marked](https://github.com/markedjs/marked) y [highlight.js](https://highlightjs.org/) (tema Night Owl)
- **Atajos de teclado** — `Enter` enviar, `Shift+Enter` nueva linea, `Ctrl+N` nuevo chat, `Ctrl+B` toggle sidebar, `Escape` detener

## Requisitos

| Requisito | Version minima | Notas |
|-----------|---------------|-------|
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Cualquier version reciente | `npm install -g @anthropic-ai/claude-code` |
| [Node.js](https://nodejs.org/) | 18+ | Para las dependencias de Tauri |
| [Rust](https://www.rust-lang.org/tools/install) | 1.70+ | Backend de Tauri |
| Dependencias de sistema (Linux) | — | `build-essential`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` |

### Instalacion de dependencias del sistema (Linux - Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y build-essential libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

> **Nota**: En Arch Linux usa `webkit2gtk-4.1`, en Fedora usa `webkit2gtk4.1-devel`. Consulta la [documentacion de Tauri](https://v2.tauri.app/start/prerequisites/) para tu distribucion.

## Instalacion

```bash
# Clonar el repositorio
git clone git@github.com:JemXiaolong/Potato-Code.git
cd Potato-Code

# Instalar dependencias de Node
npm install
```

## Uso

### Modo desarrollo

```bash
npm run dev
```

Esto abre la aplicacion con hot-reload en el frontend. Los cambios en archivos Rust requieren recompilacion automatica.

### Compilar para produccion

```bash
npm run build
```

Los binarios se generan en `src-tauri/target/release/bundle/` (`.deb` y `.AppImage` en Linux).

## Estructura del proyecto

```
Potato-Code/
├── src/                    # Frontend (HTML + CSS + JS)
│   ├── index.html          # Layout principal
│   ├── css/
│   │   ├── style.css       # Estilos de la aplicacion
│   │   └── night-owl.css   # Tema de syntax highlighting
│   ├── js/
│   │   ├── app.js          # Logica principal (estado, IPC, eventos)
│   │   ├── chat.js         # Renderizado de mensajes y streaming
│   │   └── vendor/         # marked.min.js, highlight.min.js
│   ├── fonts/              # Nunito (Regular, Medium, SemiBold, Bold)
│   └── img/                # Logo
├── src-tauri/              # Backend (Rust + Tauri v2)
│   ├── src/
│   │   ├── lib.rs          # Comandos IPC (send_message, settings, sessions)
│   │   └── main.rs         # Entry point
│   ├── Cargo.toml          # Dependencias Rust
│   ├── tauri.conf.json     # Configuracion de Tauri
│   └── icons/              # Iconos de la aplicacion
├── package.json            # Scripts npm (dev, build)
└── README.md
```

## Configuracion

La configuracion se guarda en `~/.config/potato-code/`:

| Archivo | Contenido |
|---------|-----------|
| `settings.json` | Carpeta de proyecto (working directory) |
| `sessions/*.json` | Historial de conversaciones |

### Carpeta de proyecto

Puedes configurar la carpeta de trabajo de dos formas:

1. **Desde la interfaz**: Click en el icono de engranaje (configuracion)
2. **Slash command**: Escribe `/dir /ruta/a/tu/proyecto`

Claude usara esa carpeta como contexto, pudiendo leer archivos, `CLAUDE.md`, etc.

## Slash Commands

| Comando | Descripcion |
|---------|-------------|
| `/help` | Muestra la lista de comandos |
| `/model [sonnet\|opus\|haiku]` | Ver o cambiar el modelo de Claude |
| `/dir /ruta/proyecto` | Cambiar la carpeta de trabajo |
| `/config` | Abrir configuracion |
| `/clear` | Limpiar el chat (mantiene la sesion) |
| `/new` | Iniciar un nuevo chat |

## Atajos de teclado

| Atajo | Accion |
|-------|--------|
| `Enter` | Enviar mensaje |
| `Shift+Enter` | Nueva linea |
| `Ctrl+N` | Nuevo chat |
| `Ctrl+B` | Toggle sidebar de historial |
| `Escape` | Detener generacion |

## Arquitectura

```
┌──────────────────────────────────────────────┐
│  Frontend (WebView)                          │
│  HTML + CSS + JS vanilla                     │
│                                              │
│  app.js ──── invoke() ────┐                  │
│  chat.js                  │  Tauri IPC       │
│                    Channel (streaming)        │
└───────────────────────────┼──────────────────┘
                            │
┌───────────────────────────┼──────────────────┐
│  Backend (Rust)           │                  │
│                           ▼                  │
│  lib.rs ─── Command::new("claude")           │
│             --print --verbose                │
│             --output-format stream-json      │
│             --include-partial-messages        │
│             --resume <session_id>            │
│                                              │
│  stdout (NDJSON) ──► BufReader ──► Channel   │
└──────────────────────────────────────────────┘
                            │
                            ▼
                    Claude Code CLI
```

## Licencia

MIT

## Autor

**JemXiaoLong** — [GitHub](https://github.com/JemXiaolong)
