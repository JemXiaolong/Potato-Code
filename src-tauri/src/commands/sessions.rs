use std::fs;
use std::path::PathBuf;

use crate::models::ChatSession;

fn sessions_dir() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config")
    });
    config_dir.join("potato-code").join("sessions")
}

#[tauri::command]
pub fn save_chat(session: ChatSession) -> Result<(), String> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = dir.join(format!("{}.json", session.id));
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_chat(session_id: String) -> Result<ChatSession, String> {
    let path = sessions_dir().join(format!("{}.json", session_id));
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_chats() -> Result<Vec<ChatSession>, String> {
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
pub fn delete_chat(session_id: String) -> Result<(), String> {
    let path = sessions_dir().join(format!("{}.json", session_id));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        Err("Sesion no encontrada".to_string())
    }
}
