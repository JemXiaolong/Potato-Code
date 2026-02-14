use std::collections::HashMap;
use std::sync::Mutex;

pub struct ProcessEntry {
    pub pid: u32,
}

static REGISTRY: Mutex<Option<HashMap<String, ProcessEntry>>> = Mutex::new(None);

fn with_registry<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, ProcessEntry>) -> R,
{
    let mut guard = REGISTRY.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

pub fn register(id: &str, pid: u32) {
    with_registry(|map| {
        map.insert(id.to_string(), ProcessEntry { pid });
    });
}

pub fn unregister(id: &str) {
    with_registry(|map| {
        map.remove(id);
    });
}

pub fn get_pid(id: &str) -> Option<u32> {
    with_registry(|map| map.get(id).map(|e| e.pid))
}

pub fn stop(id: &str) -> Result<(), String> {
    let pid = with_registry(|map| {
        map.remove(id).map(|e| e.pid)
    });

    match pid {
        Some(p) => {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &p.to_string()])
                .output();
            Ok(())
        }
        None => Err("No hay proceso activo para esa sesion".to_string()),
    }
}

pub fn stop_all() {
    let entries: Vec<u32> = with_registry(|map| {
        let pids: Vec<u32> = map.values().map(|e| e.pid).collect();
        map.clear();
        pids
    });

    for pid in entries {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}
