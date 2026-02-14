use std::fs;
use std::path::PathBuf;

fn settings_dir() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config")
    });
    config_dir.join("potato-code")
}

#[tauri::command]
pub fn validate_folder(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(&path).is_dir())
}

#[tauri::command]
pub fn save_settings(settings: serde_json::Value) -> Result<(), String> {
    let dir = settings_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_settings() -> Result<serde_json::Value, String> {
    let path = settings_dir().join("settings.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}
