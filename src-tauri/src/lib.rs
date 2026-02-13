use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read as IoRead};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::ipc::Channel;

// -- Estado global: proceso activo de claude ------------------------------------

static CLAUDE_PID: Mutex<Option<u32>> = Mutex::new(None);

// -- Structs -------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    role: String,
    content: String,
    timestamp: String,
    model: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatSession {
    id: String,
    title: String,
    messages: Vec<ChatMessage>,
    created_at: String,
    model: String,
}

#[derive(Serialize, Clone)]
pub struct StreamChunk {
    content: String,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

// -- Comandos: Claude ----------------------------------------------------------

#[tauri::command]
fn check_claude() -> Result<String, String> {
    let output = std::process::Command::new("which")
        .arg("claude")
        .output()
        .map_err(|e| format!("Error: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(path)
    } else {
        Err("Claude Code no esta instalado. Ejecuta: npm install -g @anthropic-ai/claude-code".to_string())
    }
}

#[tauri::command]
fn get_claude_version() -> Result<String, String> {
    let output = std::process::Command::new("claude")
        .arg("--version")
        .output()
        .map_err(|e| format!("Error: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("No se pudo obtener la version".to_string())
    }
}

#[tauri::command]
fn validate_folder(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(&path).is_dir())
}

#[tauri::command]
fn save_settings(settings: serde_json::Value) -> Result<(), String> {
    let dir = settings_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_settings() -> Result<serde_json::Value, String> {
    let path = settings_dir().join("settings.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn settings_dir() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"));
    config_dir.join("potato-code")
}

#[tauri::command]
async fn send_message(
    message: String,
    session_id: Option<String>,
    model: Option<String>,
    working_dir: Option<String>,
    on_event: Channel<StreamChunk>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<String> = vec![
            "--print".to_string(),
            "--verbose".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--include-partial-messages".to_string(),
            "--dangerously-skip-permissions".to_string(),
        ];

        if let Some(ref sid) = session_id {
            args.push("--resume".to_string());
            args.push(sid.clone());
        }

        if let Some(ref m) = model {
            args.push("--model".to_string());
            args.push(m.clone());
        }

        args.push(message);

        let mut cmd = std::process::Command::new("claude");
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Directorio de trabajo para Claude
        if let Some(ref dir) = working_dir {
            cmd.current_dir(dir);
        }

        let mut child = cmd.spawn()
            .map_err(|e| format!("No se pudo ejecutar claude: {}", e))?;

        // Guardar PID para poder cancelar
        if let Ok(mut pid) = CLAUDE_PID.lock() {
            *pid = Some(child.id());
        }

        // Capturar stderr en un thread separado
        let stderr_handle = child.stderr.take();
        let stderr_thread = std::thread::spawn(move || {
            let mut err_output = String::new();
            if let Some(mut stderr) = stderr_handle {
                let _ = stderr.read_to_string(&mut err_output);
            }
            err_output
        });

        // Leer stdout linea por linea (stream-json = NDJSON)
        let mut full_response = String::new();
        let mut claude_session_id: Option<String> = None;

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };

                if line.trim().is_empty() {
                    continue;
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                    // Capturar session_id de Claude (viene en el primer evento)
                    if claude_session_id.is_none() {
                        if let Some(sid) = json.get("session_id").and_then(|s| s.as_str()) {
                            claude_session_id = Some(sid.to_string());
                            // Enviar session_id al frontend
                            let _ = on_event.send(StreamChunk {
                                content: String::new(),
                                done: false,
                                session_id: Some(sid.to_string()),
                            });
                        }
                    }

                    // Extraer texto de content_block_delta events
                    let text = json.get("event")
                        .and_then(|e| e.get("delta"))
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str());

                    if let Some(text) = text {
                        full_response.push_str(text);
                        let _ = on_event.send(StreamChunk {
                            content: text.to_string(),
                            done: false,
                            session_id: None,
                        });
                    }
                }
            }
        }

        // Proceso terminado
        let status = child.wait().map_err(|e| e.to_string())?;
        let stderr_output = stderr_thread.join().unwrap_or_default();

        // Limpiar PID
        if let Ok(mut pid) = CLAUDE_PID.lock() {
            *pid = None;
        }

        // Enviar done
        let _ = on_event.send(StreamChunk {
            content: String::new(),
            done: true,
            session_id: None,
        });

        if status.success() || !full_response.trim().is_empty() {
            Ok(full_response.trim().to_string())
        } else {
            let err_msg = if stderr_output.trim().is_empty() {
                format!("Claude salio con codigo: {}", status.code().unwrap_or(-1))
            } else {
                stderr_output.trim().to_string()
            };
            Err(err_msg)
        }
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
fn stop_generation() -> Result<(), String> {
    if let Ok(mut pid) = CLAUDE_PID.lock() {
        if let Some(p) = pid.take() {
            // Kill the process
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &p.to_string()])
                .output();
            return Ok(());
        }
    }
    Err("No hay proceso activo".to_string())
}

// -- Comandos: Sesiones --------------------------------------------------------

fn sessions_dir() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"));
    config_dir.join("potato-code").join("sessions")
}

#[tauri::command]
fn save_chat(session: ChatSession) -> Result<(), String> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = dir.join(format!("{}.json", session.id));
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_chat(session_id: String) -> Result<ChatSession, String> {
    let path = sessions_dir().join(format!("{}.json", session_id));
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_chats() -> Result<Vec<ChatSession>, String> {
    let dir = sessions_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(session) = serde_json::from_str::<ChatSession>(&content) {
                    sessions.push(session);
                }
            }
        }
    }

    // Mas recientes primero
    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(sessions)
}

#[tauri::command]
fn delete_chat(session_id: String) -> Result<(), String> {
    let path = sessions_dir().join(format!("{}.json", session_id));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        Err("Sesion no encontrada".to_string())
    }
}

// -- App -----------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_claude,
            get_claude_version,
            send_message,
            stop_generation,
            validate_folder,
            save_settings,
            load_settings,
            save_chat,
            load_chat,
            list_chats,
            delete_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
