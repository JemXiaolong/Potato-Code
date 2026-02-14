use std::io::{BufRead, BufReader, Read as IoRead};
use std::process::Stdio;
use tauri::ipc::Channel;

use crate::models::{StreamChunk, ToolActivity, UsageInfo};
use crate::process;

#[tauri::command]
pub fn check_claude() -> Result<String, String> {
    let output = std::process::Command::new("claude")
        .arg("--version")
        .output()
        .map_err(|_| {
            "Claude Code no esta instalado. Ejecuta: npm install -g @anthropic-ai/claude-code"
                .to_string()
        })?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(version)
    } else {
        Err(
            "Claude Code no esta instalado. Ejecuta: npm install -g @anthropic-ai/claude-code"
                .to_string(),
        )
    }
}

#[tauri::command]
pub fn get_claude_version() -> Result<String, String> {
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
pub async fn send_message(
    message: String,
    process_id: String,
    session_id: Option<String>,
    model: Option<String>,
    working_dir: Option<String>,
    allowed_tools: Option<Vec<String>>,
    on_event: Channel<StreamChunk>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<String> = vec![
            "--print".to_string(),
            "--verbose".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--include-partial-messages".to_string(),
        ];

        // Siempre usar --dangerously-skip-permissions para que Claude pueda
        // intentar usar cualquier tool. La aprobacion la manejamos nosotros:
        // interceptamos en content_block_stop y matamos el proceso ANTES
        // de que el tool se ejecute si necesita aprobacion del usuario.
        args.push("--dangerously-skip-permissions".to_string());

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

        if let Some(ref dir) = working_dir {
            cmd.current_dir(dir);
        }

        let mut child =
            cmd.spawn()
                .map_err(|e| format!("No se pudo ejecutar claude: {}", e))?;

        // Registrar proceso
        process::register(&process_id, child.id());

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
        let mut usage_info: Option<UsageInfo> = None;
        let mut killed_for_interaction = false;

        // Tool use tracking
        let mut active_tool_name: Option<String> = None;
        let mut active_tool_id: Option<String> = None;
        let mut active_tool_index: Option<u64> = None;
        let mut tool_input_buf = String::new();

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
                    let line_type = json.get("type").and_then(|t| t.as_str()).unwrap_or("");

                    // Capturar session_id de Claude (viene en el primer evento)
                    if claude_session_id.is_none() {
                        if let Some(sid) = json.get("session_id").and_then(|s| s.as_str()) {
                            claude_session_id = Some(sid.to_string());
                            let _ = on_event.send(StreamChunk {
                                content: String::new(),
                                done: false,
                                session_id: Some(sid.to_string()),
                                usage: None,
                                tool: None,
                            });
                        }
                    }

                    if line_type == "stream_event" {
                        let event = json.get("event");
                        let event_type = event
                            .and_then(|e| e.get("type"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("");

                        match event_type {
                            // Text delta — streaming de texto
                            "content_block_delta" => {
                                if let Some(delta) = event.and_then(|e| e.get("delta")) {
                                    let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");

                                    if delta_type == "text_delta" {
                                        if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                                            full_response.push_str(text);
                                            let _ = on_event.send(StreamChunk {
                                                content: text.to_string(),
                                                done: false,
                                                session_id: None,
                                                usage: None,
                                                tool: None,
                                            });
                                        }
                                    } else if delta_type == "input_json_delta" {
                                        // Acumular JSON del tool input
                                        if let Some(partial) = delta.get("partial_json").and_then(|t| t.as_str()) {
                                            tool_input_buf.push_str(partial);
                                        }
                                    }
                                }
                            }

                            // Tool use start
                            "content_block_start" => {
                                if let Some(block) = event.and_then(|e| e.get("content_block")) {
                                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("unknown").to_string();
                                        let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                                        let index = event.and_then(|e| e.get("index")).and_then(|i| i.as_u64());

                                        active_tool_name = Some(name);
                                        active_tool_id = Some(id);
                                        active_tool_index = index;
                                        tool_input_buf.clear();
                                    }
                                }
                            }

                            // Tool use stop — decidir si auto-aprobar o pedir permiso
                            "content_block_stop" => {
                                let stop_index = event.and_then(|e| e.get("index")).and_then(|i| i.as_u64());
                                if stop_index == active_tool_index && active_tool_name.is_some() {
                                    let input_json = serde_json::from_str::<serde_json::Value>(&tool_input_buf)
                                        .unwrap_or(serde_json::Value::Null);

                                    let tool_name_str = active_tool_name.clone().unwrap_or_default();
                                    let tool_id_str = active_tool_id.clone().unwrap_or_default();

                                    // Determinar si necesita interaccion del usuario
                                    let is_ask_user = tool_name_str == "AskUserQuestion";
                                    let needs_approval = if !is_ask_user {
                                        if let Some(ref approved) = allowed_tools {
                                            // Modo restringido: checar si el tool esta auto-aprobado
                                            !approved.iter().any(|t| t == &tool_name_str)
                                        } else {
                                            false // Modo sin restricciones: todo auto-aprobado
                                        }
                                    } else {
                                        false
                                    };

                                    if is_ask_user || needs_approval {
                                        // Fase especial: el frontend debe mostrar UI y esperar
                                        let phase = if is_ask_user {
                                            "ask".to_string()
                                        } else {
                                            "approval".to_string()
                                        };

                                        let _ = on_event.send(StreamChunk {
                                            content: String::new(),
                                            done: false,
                                            session_id: None,
                                            usage: None,
                                            tool: Some(ToolActivity {
                                                tool_name: tool_name_str,
                                                tool_id: tool_id_str,
                                                phase,
                                                input: Some(input_json),
                                                result: None,
                                                is_error: None,
                                            }),
                                        });

                                        // Matar proceso INMEDIATAMENTE antes de que ejecute el tool
                                        let _ = process::stop(&process_id);
                                        killed_for_interaction = true;
                                        break;
                                    }

                                    // Tool auto-aprobado: dejar que se ejecute normalmente
                                    let _ = on_event.send(StreamChunk {
                                        content: String::new(),
                                        done: false,
                                        session_id: None,
                                        usage: None,
                                        tool: Some(ToolActivity {
                                            tool_name: tool_name_str,
                                            tool_id: tool_id_str,
                                            phase: "start".to_string(),
                                            input: Some(input_json),
                                            result: None,
                                            is_error: None,
                                        }),
                                    });

                                    // Reset para la siguiente tool
                                    active_tool_name = None;
                                    active_tool_id = None;
                                    active_tool_index = None;
                                    tool_input_buf.clear();
                                }
                            }

                            _ => {}
                        }
                    }

                    // Tool result — viene como type:"user" con tool_result
                    if line_type == "user" {
                        if let Some(content) = json.get("message")
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_array())
                        {
                            for item in content {
                                if item.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                                    let tool_id = item.get("tool_use_id")
                                        .and_then(|t| t.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let result_content = item.get("content")
                                        .and_then(|c| c.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let is_error = item.get("is_error")
                                        .and_then(|e| e.as_bool())
                                        .unwrap_or(false);

                                    // Buscar nombre del tool en tool_use_result
                                    let tool_name = json.get("tool_use_result")
                                        .and_then(|r| r.get("tool_name"))
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("Tool")
                                        .to_string();

                                    let _ = on_event.send(StreamChunk {
                                        content: String::new(),
                                        done: false,
                                        session_id: None,
                                        usage: None,
                                        tool: Some(ToolActivity {
                                            tool_name,
                                            tool_id,
                                            phase: "result".to_string(),
                                            input: None,
                                            result: Some(result_content),
                                            is_error: Some(is_error),
                                        }),
                                    });
                                }
                            }
                        }
                    }

                    // Extraer usage info del evento type:"result"
                    if line_type == "result" {
                        if let Some(usage) = json.get("usage") {
                            let input = usage.get("input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                            let cache_create = usage.get("cache_creation_input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                            let cache_read = usage.get("cache_read_input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                            let output = usage.get("output_tokens").and_then(|t| t.as_u64()).unwrap_or(0);

                            usage_info = Some(UsageInfo {
                                input_tokens: input + cache_create + cache_read,
                                output_tokens: output,
                            });
                        }
                    }
                }
            }
        }

        // Proceso terminado
        let status = child.wait().map_err(|e| e.to_string())?;
        let stderr_output = stderr_thread.join().unwrap_or_default();

        // Limpiar registro
        process::unregister(&process_id);

        // Enviar done con usage info
        let _ = on_event.send(StreamChunk {
            content: String::new(),
            done: true,
            session_id: None,
            usage: usage_info,
            tool: None,
        });

        // Si matamos por interaccion (approval/ask), no es un error
        if killed_for_interaction {
            return Ok(full_response.trim().to_string());
        }

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
pub fn stop_generation(process_id: String) -> Result<(), String> {
    process::stop(&process_id)
}
