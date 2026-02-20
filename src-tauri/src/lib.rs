// MyAgents Tauri Application
// Main entry point with sidecar lifecycle management

mod commands;
pub mod cron_task;
pub mod im;
pub mod logger;
pub mod management_api;
mod proxy_config;
mod sidecar;
mod sse_proxy;
mod tray;
mod updater;

use sidecar::{
    cleanup_stale_sidecars, create_sidecar_state, stop_all_sidecars,
    // Session activation commands (for Session singleton tracking)
    cmd_get_session_activation, cmd_activate_session, cmd_deactivate_session,
    cmd_update_session_tab,
    // Cron task execution command
    cmd_execute_cron_task,
    // Session-centric Sidecar API (v0.1.11)
    cmd_ensure_session_sidecar, cmd_release_session_sidecar, cmd_get_session_port,
    cmd_upgrade_session_id, cmd_session_has_persistent_owners,
    // Background session completion
    cmd_start_background_completion, cmd_cancel_background_completion,
};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri::{Emitter, Listener};
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // IMPORTANT: Clean up stale sidecar processes from previous app instances
    // This prevents "No available port found" errors caused by orphaned processes
    cleanup_stale_sidecars();

    // Create managed sidecar state (now supports multiple instances)
    let sidecar_state = create_sidecar_state();

    // Create IM Bot managed state
    let im_bot_state = im::create_im_bot_state();
    let sidecar_state_for_window = sidecar_state.clone();
    let sidecar_state_for_exit = sidecar_state.clone();
    let sidecar_state_for_tray_exit = sidecar_state.clone();

    let im_state_for_window = im_bot_state.clone();
    let im_state_for_exit = im_bot_state.clone();
    let im_state_for_tray_exit = im_bot_state.clone();

    // Track if cleanup has been performed to avoid duplicate cleanup
    // All clones share the same underlying AtomicBool - whichever exit path
    // triggers first will do cleanup, and all others will see the flag as true
    // and skip. The separate variables are needed because each is moved into
    // a different closure (window event, tray exit, app exit).
    let cleanup_done = Arc::new(AtomicBool::new(false));
    let cleanup_done_for_window = cleanup_done.clone();
    let cleanup_done_for_exit = cleanup_done.clone();
    let cleanup_done_for_tray_exit = cleanup_done.clone();

    // Create SSE proxy state
    let sse_proxy_state = Arc::new(sse_proxy::SseProxyState::default());

    // Build the app first, then run with event handler
    // This allows us to handle RunEvent::ExitRequested for Cmd+Q and Dock quit
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .manage(sidecar_state)
        .manage(sse_proxy_state)
        .manage(im_bot_state)
        .invoke_handler(tauri::generate_handler![
            // Legacy commands (backward compatibility)
            commands::cmd_start_sidecar,
            commands::cmd_stop_sidecar,
            commands::cmd_get_sidecar_status,
            commands::cmd_get_server_url,
            commands::cmd_restart_sidecar,
            commands::cmd_ensure_sidecar_running,
            commands::cmd_check_sidecar_alive,
            // New multi-instance commands
            commands::cmd_start_tab_sidecar,
            commands::cmd_stop_tab_sidecar,
            commands::cmd_get_tab_server_url,
            commands::cmd_get_tab_sidecar_status,
            commands::cmd_start_global_sidecar,
            commands::cmd_get_global_server_url,
            commands::cmd_stop_all_sidecars,
            commands::cmd_shutdown_for_update,
            // SSE proxy commands (multi-instance)
            sse_proxy::start_sse_proxy,
            sse_proxy::stop_sse_proxy,
            sse_proxy::stop_all_sse_proxies,
            sse_proxy::proxy_http_request,
            // Updater commands
            updater::check_and_download_update,
            updater::restart_app,
            updater::test_update_connectivity,
            updater::check_pending_update,
            updater::install_pending_update,
            // Platform & device info
            commands::cmd_get_platform,
            commands::cmd_get_device_id,
            // Bundled workspace initialization
            commands::cmd_initialize_bundled_workspace,
            // Cron task commands
            cron_task::cmd_create_cron_task,
            cron_task::cmd_start_cron_task,
            cron_task::cmd_stop_cron_task,
            cron_task::cmd_delete_cron_task,
            cron_task::cmd_get_cron_task,
            cron_task::cmd_get_cron_tasks,
            cron_task::cmd_get_workspace_cron_tasks,
            cron_task::cmd_get_session_cron_task,
            cron_task::cmd_get_tab_cron_task,
            cron_task::cmd_record_cron_execution,
            cron_task::cmd_update_cron_task_tab,
            cron_task::cmd_update_cron_task_session,
            cron_task::cmd_get_tasks_to_recover,
            // Cron scheduler commands
            cron_task::cmd_start_cron_scheduler,
            cron_task::cmd_mark_task_executing,
            cron_task::cmd_mark_task_complete,
            cron_task::cmd_is_task_executing,
            // Session activation commands (for Session singleton)
            cmd_get_session_activation,
            cmd_activate_session,
            cmd_deactivate_session,
            cmd_update_session_tab,
            // Cron task execution (Rust -> Sidecar direct call)
            cmd_execute_cron_task,
            // Session-centric Sidecar API (v0.1.11)
            cmd_ensure_session_sidecar,
            cmd_release_session_sidecar,
            cmd_get_session_port,
            cmd_upgrade_session_id,
            cmd_session_has_persistent_owners,
            // Background session completion
            cmd_start_background_completion,
            cmd_cancel_background_completion,
            // IM Bot commands
            im::cmd_start_im_bot,
            im::cmd_stop_im_bot,
            im::cmd_im_bot_status,
            im::cmd_im_all_bots_status,
            im::cmd_im_conversations,
            im::cmd_update_heartbeat_config,
            // IM Bot hot-update commands
            im::cmd_update_im_bot_ai_config,
            im::cmd_update_im_bot_permission_mode,
            im::cmd_update_im_bot_mcp_servers,
            im::cmd_update_im_bot_allowed_users,
            im::cmd_update_im_bot_workspace,
        ])
        .setup(|app| {
            // Initialize logging for all builds
            // Debug builds: DEBUG level for verbose output including third-party crates
            // Production builds: INFO level for important events only
            use tauri_plugin_log::{Target, TargetKind};

            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .target(Target::new(TargetKind::Stdout))
                    .target(Target::new(TargetKind::LogDir { file_name: None }))
                    .build(),
            )?;

            // Initialize global AppHandle for unified logging (IM module etc.)
            logger::init_app_handle(app.handle().clone());

            // Setup system tray
            if let Err(e) = tray::setup_tray(app) {
                log::error!("[App] Failed to setup system tray: {}", e);
            }

            // Setup tray exit handler (for when user confirms exit from tray menu)
            let app_handle_for_tray = app.handle().clone();
            app.listen("tray:confirm-exit", move |_| {
                log::info!("[App] Tray exit confirmed by user");
                use std::sync::atomic::Ordering::Relaxed;
                if !cleanup_done_for_tray_exit.swap(true, Relaxed) {
                    log::info!("[App] Cleaning up sidecars before exit...");
                    im::signal_all_bots_shutdown(&im_state_for_tray_exit);
                    let _ = stop_all_sidecars(&sidecar_state_for_tray_exit);
                }
                app_handle_for_tray.exit(0);
            });

            // Open DevTools in debug builds
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Windows: Remove system decorations for custom title bar
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    log::info!("[App] Windows: Disabled system decorations for custom title bar");
                }
            }

            // Start management API (internal HTTP server for Bun→Rust IPC)
            tauri::async_runtime::spawn(async move {
                match management_api::start_management_api().await {
                    Ok(port) => log::info!("[App] Management API started on port {}", port),
                    Err(e) => log::error!("[App] Failed to start management API: {}", e),
                }
            });

            // Initialize cron task manager with app handle
            let cron_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                cron_task::initialize_cron_manager(cron_app_handle).await;
            });
            log::info!("[App] Cron task manager initialized");

            // Auto-start IM Bot if previously enabled (3s delay)
            im::schedule_auto_start(app.handle().clone());
            log::info!("[App] IM Bot auto-start scheduled");

            // Start background update check (5 second delay to let app initialize)
            log::info!("[App] Setup complete, spawning background update check task...");
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                log::info!("[App] Background update task started, waiting 5 seconds...");
                updater::check_update_on_startup(app_handle).await;
                log::info!("[App] Background update task completed");
            });
            log::info!("[App] Background update task spawned successfully");

            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                // Handle window close request (X button) - minimize to tray instead
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Check if minimize to tray is enabled
                    // Emit event to frontend to check config and decide
                    log::info!("[App] Window close requested, emitting event to frontend");
                    let _ = window.emit("window:close-requested", ());
                    // Prevent default close behavior - let frontend decide
                    api.prevent_close();
                }
                // Clean up when window is actually destroyed
                tauri::WindowEvent::Destroyed => {
                    use std::sync::atomic::Ordering::Relaxed;
                    if !cleanup_done_for_window.swap(true, Relaxed) {
                        log::info!("[App] Window destroyed, cleaning up sidecars...");
                        im::signal_all_bots_shutdown(&im_state_for_window);
                        let _ = stop_all_sidecars(&sidecar_state_for_window);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler to catch Cmd+Q, Dock quit, and Dock click
    app.run(move |_app_handle, event| {
        match event {
            // Handle app exit events (Cmd+Q, Dock right-click quit, etc.)
            tauri::RunEvent::ExitRequested { .. } => {
                // Only cleanup once (Relaxed is sufficient for simple flag)
                use std::sync::atomic::Ordering::Relaxed;
                if !cleanup_done_for_exit.swap(true, Relaxed) {
                    log::info!("[App] Exit requested (Cmd+Q or Dock quit), cleaning up sidecars...");
                    im::signal_all_bots_shutdown(&im_state_for_exit);
                    let _ = stop_all_sidecars(&sidecar_state_for_exit);
                }
            }
            // Handle Dock icon click on macOS (Reopen event)
            // This is triggered when user clicks the Dock icon while app is running but window is hidden
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                log::info!("[App] Dock icon clicked (Reopen), showing main window");
                use tauri::Manager;
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }
    });
}
