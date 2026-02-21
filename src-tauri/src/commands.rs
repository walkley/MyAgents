// Tauri IPC commands for sidecar management and app operations
// Supports both legacy single-instance and new multi-instance APIs

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::sidecar::{
    // Legacy exports
    get_sidecar_status, start_sidecar, stop_sidecar, restart_sidecar,
    ensure_sidecar_running, check_process_alive,
    ManagedSidecar, LegacySidecarConfig, SidecarStatus,
    // New multi-instance exports
    start_tab_sidecar, stop_tab_sidecar, get_tab_server_url, get_tab_sidecar_status,
    start_global_sidecar, stop_all_sidecars, GLOBAL_SIDECAR_ID,
    // Update shutdown
    shutdown_for_update,
};
use crate::logger;
use crate::{ulog_info, ulog_warn};

// ============= Legacy Commands (for backward compatibility) =============

/// Command: Start the sidecar for a project (legacy single-instance)
#[tauri::command]
pub async fn cmd_start_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    agent_dir: String,
    initial_prompt: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, format!("[sidecar] Starting for project: {}", agent_dir));

    let config = LegacySidecarConfig {
        port: find_available_port().unwrap_or(31415),
        agent_dir: PathBuf::from(&agent_dir),
        initial_prompt,
    };

    match start_sidecar(&app_handle, &state, config) {
        Ok(_) => {
            let status = get_sidecar_status(&state)?;
            logger::info(&app_handle, format!("[sidecar] Started on port {}", status.port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Failed to start: {}", e));
            Err(e)
        }
    }
}

/// Command: Stop the sidecar (legacy)
#[tauri::command]
pub async fn cmd_stop_sidecar(state: State<'_, ManagedSidecar>) -> Result<(), String> {
    stop_sidecar(&state)
}

/// Command: Get sidecar status (legacy)
#[tauri::command]
pub async fn cmd_get_sidecar_status(
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    get_sidecar_status(&state)
}

/// Command: Get the backend server URL (legacy)
#[tauri::command]
pub async fn cmd_get_server_url(state: State<'_, ManagedSidecar>) -> Result<String, String> {
    let status = get_sidecar_status(&state)?;
    if status.running {
        Ok(format!("http://127.0.0.1:{}", status.port))
    } else {
        Err("Sidecar is not running".to_string())
    }
}

/// Command: Restart the sidecar (legacy)
#[tauri::command]
pub async fn cmd_restart_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, "[sidecar] Restart requested".to_string());

    match restart_sidecar(&app_handle, &state) {
        Ok(port) => {
            let status = get_sidecar_status(&state)?;
            logger::info(&app_handle, format!("[sidecar] Restarted on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Restart failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Ensure sidecar is running (legacy)
#[tauri::command]
pub async fn cmd_ensure_sidecar_running<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    match ensure_sidecar_running(&app_handle, &state) {
        Ok(port) => {
            let status = get_sidecar_status(&state)?;
            logger::debug(&app_handle, format!("[sidecar] Ensured running on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Ensure running failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Check if sidecar process is alive (legacy)
#[tauri::command]
pub async fn cmd_check_sidecar_alive(
    state: State<'_, ManagedSidecar>,
) -> Result<bool, String> {
    check_process_alive(&state)
}

// ============= New Multi-instance Commands =============

/// Command: Start a sidecar for a specific Tab
#[tauri::command]
pub async fn cmd_start_tab_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    tab_id: String,
    agent_dir: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(
        &app_handle,
        format!("[sidecar] Starting for tab {}, agent_dir: {:?}", tab_id, agent_dir),
    );

    let agent_path = agent_dir.map(PathBuf::from);

    match start_tab_sidecar(&app_handle, &state, &tab_id, agent_path) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, &tab_id)?;
            logger::info(&app_handle, format!("[sidecar] Tab {} started on port {}", tab_id, port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Tab {} failed to start: {}", tab_id, e));
            Err(e)
        }
    }
}

/// Command: Stop a sidecar for a specific Tab
#[tauri::command]
pub async fn cmd_stop_tab_sidecar(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<(), String> {
    logger::info(&app_handle, format!("[sidecar] Stopping tab {}", tab_id));
    stop_tab_sidecar(&state, &tab_id)
}

/// Command: Get server URL for a specific Tab
#[tauri::command]
pub async fn cmd_get_tab_server_url(
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<String, String> {
    get_tab_server_url(&state, &tab_id)
}

/// Command: Get sidecar status for a specific Tab
#[tauri::command]
pub async fn cmd_get_tab_sidecar_status(
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<SidecarStatus, String> {
    get_tab_sidecar_status(&state, &tab_id)
}

/// Command: Start the global sidecar (for Settings page)
#[tauri::command]
pub async fn cmd_start_global_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, "[sidecar] Starting global sidecar".to_string());

    match start_global_sidecar(&app_handle, &state) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, GLOBAL_SIDECAR_ID)?;
            logger::info(&app_handle, format!("[sidecar] Global sidecar started on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Global sidecar failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Get global sidecar server URL
#[tauri::command]
pub async fn cmd_get_global_server_url(
    state: State<'_, ManagedSidecar>,
) -> Result<String, String> {
    get_tab_server_url(&state, GLOBAL_SIDECAR_ID)
}

/// Command: Stop all sidecar instances (for app exit)
#[tauri::command]
pub async fn cmd_stop_all_sidecars(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    logger::info(&app_handle, "[sidecar] Stopping all instances".to_string());
    stop_all_sidecars(&state)
}

/// Command: Shutdown for update — blocks until all child processes are fully terminated.
/// Must be called before relaunch() to prevent NSIS installer file-lock errors on Windows.
#[tauri::command]
pub async fn cmd_shutdown_for_update(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    logger::info(&app_handle, "[sidecar] Shutdown for update requested".to_string());
    shutdown_for_update(&state)
}

// ============= Utility Functions =============

/// Find an available port
fn find_available_port() -> Option<u16> {
    let preferred = [31415, 31416, 31417, 31418, 31419];

    for &port in &preferred {
        if is_port_available(port) {
            return Some(port);
        }
    }

    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

// ============= Platform & Device Info Commands =============

/// Command: Get platform identifier (matches build target naming)
/// Returns: darwin-aarch64, darwin-x86_64, windows-x86_64, linux-x86_64, etc.
#[tauri::command]
pub fn cmd_get_platform() -> String {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64".to_string();

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "windows-aarch64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-aarch64".to_string();

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return "unknown".to_string();
}

/// Command: Get or create device ID
/// Stored in ~/.myagents/device_id to persist across app reinstalls
/// Only regenerates if the file is deleted by user
#[tauri::command]
pub fn cmd_get_device_id() -> Result<String, String> {
    use std::fs;
    use uuid::Uuid;

    // Get home directory
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Failed to get home directory".to_string())?;

    // ~/.myagents/ directory
    let myagents_dir = home_dir.join(".myagents");
    let device_id_file = myagents_dir.join("device_id");

    // Try to read existing device_id
    if device_id_file.exists() {
        match fs::read_to_string(&device_id_file) {
            Ok(id) => {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Ok(id);
                }
            }
            Err(_) => {
                // File exists but can't read, will regenerate
            }
        }
    }

    // Generate new UUID
    let new_id = Uuid::new_v4().to_string();

    // Ensure directory exists
    if !myagents_dir.exists() {
        fs::create_dir_all(&myagents_dir)
            .map_err(|e| format!("Failed to create ~/.myagents directory: {}", e))?;
    }

    // Write device_id to file
    fs::write(&device_id_file, &new_id)
        .map_err(|e| format!("Failed to write device_id file: {}", e))?;

    Ok(new_id)
}

// ============= Bundled Workspace Commands =============

#[derive(serde::Serialize)]
pub struct InitBundledWorkspaceResult {
    pub path: String,
    pub is_new: bool,
}

/// Command: Initialize bundled workspace (mino) on first launch
/// Copies from app resources to ~/.myagents/projects/mino/
#[tauri::command]
pub fn cmd_initialize_bundled_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<InitBundledWorkspaceResult, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let mino_dest = home_dir.join(".myagents").join("projects").join("mino");

    if mino_dest.exists() {
        return Ok(InitBundledWorkspaceResult {
            path: mino_dest.to_string_lossy().to_string(),
            is_new: false,
        });
    }

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let mino_src = resource_dir.join("mino");
    if !mino_src.exists() || !mino_src.join("CLAUDE.md").exists() {
        return Err(format!(
            "Bundled mino not found or incomplete in resources: {:?}",
            mino_src
        ));
    }

    ulog_info!("[workspace] Initializing bundled workspace from {:?}", mino_src);
    copy_dir_recursive(&mino_src, &mino_dest)
        .map_err(|e| format!("Failed to copy mino workspace: {}", e))?;

    // Validate the copy produced a valid workspace
    if !mino_dest.join("CLAUDE.md").exists() {
        let _ = fs::remove_dir_all(&mino_dest);
        return Err("Bundled mino copy produced incomplete workspace".to_string());
    }

    Ok(InitBundledWorkspaceResult {
        path: mino_dest.to_string_lossy().to_string(),
        is_new: true,
    })
}

/// Command: Create a dedicated workspace for an IM Bot by copying bundled mino template.
/// Sanitizes the name for path safety and auto-appends numeric suffix on collision.
/// Falls back to local mino copy if bundled resources are incomplete.
/// Returns the created workspace path.
#[tauri::command]
pub fn cmd_create_bot_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
    workspace_name: String,
) -> Result<InitBundledWorkspaceResult, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let projects_dir = home_dir.join(".myagents").join("projects");

    // Sanitize name: remove @, replace non-alphanumeric (except CJK) with dash, trim
    let sanitized = sanitize_workspace_name(&workspace_name);
    if sanitized.is_empty() {
        return Err("Workspace name is empty after sanitization".to_string());
    }

    // Find available path (handle collisions with numeric suffix)
    let dest = find_available_workspace_path(&projects_dir, &sanitized);

    // Primary: copy from bundled resources
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let mino_src = resource_dir.join("mino");

    if mino_src.exists() && mino_src.join("CLAUDE.md").exists() {
        ulog_info!("[workspace] Copying bundled mino from {:?} to {:?}", mino_src, dest);
        copy_dir_recursive(&mino_src, &dest)
            .map_err(|e| format!("Failed to copy workspace template: {}", e))?;
    }

    // Validate: CLAUDE.md must exist in destination (marker file for a valid mino template)
    if !dest.join("CLAUDE.md").exists() {
        // Fallback: copy from the local mino created on first launch
        let local_mino = projects_dir.join("mino");
        if local_mino.exists() && local_mino.join("CLAUDE.md").exists() {
            ulog_warn!("[workspace] Bundled mino incomplete, falling back to local {:?}", local_mino);
            // Clean up the potentially empty dest before fallback copy
            let _ = fs::remove_dir_all(&dest);
            copy_dir_recursive(&local_mino, &dest)
                .map_err(|e| format!("Failed to copy from local mino: {}", e))?;
        } else {
            // Clean up the empty dest
            let _ = fs::remove_dir_all(&dest);
            return Err("Mino template not found: bundled resources incomplete and no local copy available".to_string());
        }
    }

    ulog_info!("[workspace] Bot workspace created: {:?}", dest);
    Ok(InitBundledWorkspaceResult {
        path: dest.to_string_lossy().to_string(),
        is_new: true,
    })
}

/// Command: Remove a workspace directory created by `cmd_create_bot_workspace`.
/// Safety: only allows deleting directories under `~/.myagents/projects/`.
#[tauri::command]
pub fn cmd_remove_bot_workspace(workspace_path: String) -> Result<(), String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let projects_dir = home_dir.join(".myagents").join("projects");

    let target = PathBuf::from(&workspace_path);
    // Canonicalize both paths to prevent traversal attacks
    let canon_projects = projects_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve projects dir: {}", e))?;
    let canon_target = target.canonicalize()
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;

    if !canon_target.starts_with(&canon_projects) || canon_target == canon_projects {
        return Err("Refusing to delete: path is not inside ~/.myagents/projects/".to_string());
    }

    fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("Failed to remove workspace directory: {}", e))?;

    Ok(())
}

/// Sanitize a workspace name for use as a directory name.
/// Keeps alphanumeric, CJK characters, hyphens, and underscores.
fn sanitize_workspace_name(name: &str) -> String {
    let result: String = name
        .chars()
        .filter_map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                Some(c)
            } else if c == ' ' || c == '@' || c == '/' || c == '\\' {
                Some('-')
            } else if c > '\u{2E7F}' {
                // Keep CJK and other non-ASCII characters
                Some(c)
            } else {
                None
            }
        })
        .collect();

    // Trim leading/trailing dashes and collapse consecutive dashes
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for c in result.chars() {
        if c == '-' {
            if !prev_dash && !collapsed.is_empty() {
                collapsed.push(c);
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    collapsed.trim_end_matches('-').to_string()
}

/// Find an available workspace path, appending numeric suffix on collision.
fn find_available_workspace_path(projects_dir: &Path, base_name: &str) -> PathBuf {
    let first = projects_dir.join(base_name);
    if !first.exists() {
        return first;
    }
    for i in 2..=100 {
        let candidate = projects_dir.join(format!("{}-{}", base_name, i));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Extremely unlikely fallback
    projects_dir.join(format!("{}-{}", base_name, uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("x")))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        // Skip .git and node_modules
        if name == ".git" || name == "node_modules" {
            continue;
        }
        // Skip symlinks to avoid circular copies and unexpected data
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let dest = dst.join(name);
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(&entry.path(), &dest)?;
        }
    }
    Ok(())
}
