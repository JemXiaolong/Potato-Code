mod commands;
mod models;
mod process;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::claude::check_claude,
            commands::claude::get_claude_version,
            commands::claude::send_message,
            commands::claude::stop_generation,
            commands::settings::validate_folder,
            commands::settings::save_settings,
            commands::settings::load_settings,
            commands::sessions::save_chat,
            commands::sessions::load_chat,
            commands::sessions::list_chats,
            commands::sessions::delete_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
