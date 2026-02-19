// Internal Management API for Bun Sidecar → Rust IPC
// Provides HTTP endpoints on localhost for cron task management
// Only accessible from 127.0.0.1 (Bun Sidecar processes)

use axum::{
    extract::Query,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tokio::net::TcpListener;

use crate::cron_task::{
    self, CronDelivery, CronSchedule, CronTask, CronTaskConfig, TaskProviderEnv,
};

/// Global management API port (set once at startup)
static MANAGEMENT_PORT: OnceLock<u16> = OnceLock::new();

/// Get the management API port (returns 0 if not started)
pub fn get_management_port() -> u16 {
    MANAGEMENT_PORT.get().copied().unwrap_or(0)
}

/// Start the internal management API server on a random port
/// Returns the port number for injection into Sidecar env vars
pub async fn start_management_api() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind management API: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get management API address: {}", e))?
        .port();

    MANAGEMENT_PORT
        .set(port)
        .map_err(|_| "Management API already started".to_string())?;

    let app = Router::new()
        .route("/api/cron/create", post(create_cron_handler))
        .route("/api/cron/list", get(list_cron_handler))
        .route("/api/cron/update", post(update_cron_handler))
        .route("/api/cron/delete", post(delete_cron_handler))
        .route("/api/cron/run", post(run_cron_handler));

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("[management-api] Server error: {}", e);
        }
    });

    log::info!(
        "[management-api] Started on http://127.0.0.1:{}",
        port
    );
    Ok(port)
}

// ===== Request / Response types =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCronRequest {
    name: Option<String>,
    schedule: Option<CronSchedule>,
    message: String,
    session_target: Option<String>, // "new_session" | "single_session"
    source_bot_id: Option<String>,
    delivery: Option<CronDelivery>,
    workspace_path: String,
    model: Option<String>,
    permission_mode: Option<String>,
    provider_env: Option<TaskProviderEnv>,
    /// Fallback interval if no schedule provided
    interval_minutes: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct CreateCronResponse {
    task_id: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCronQuery {
    source_bot_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListCronResponse {
    tasks: Vec<CronTaskSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CronTaskSummary {
    id: String,
    name: Option<String>,
    prompt: String,
    status: String,
    schedule: Option<CronSchedule>,
    interval_minutes: u32,
    execution_count: u32,
    last_executed_at: Option<String>,
    created_at: String,
}

impl From<CronTask> for CronTaskSummary {
    fn from(t: CronTask) -> Self {
        Self {
            id: t.id,
            name: t.name,
            prompt: t.prompt,
            status: serde_json::to_value(&t.status)
                .and_then(|v| Ok(v.as_str().unwrap_or("unknown").to_string()))
                .unwrap_or_else(|_| "unknown".to_string()),
            schedule: t.schedule,
            interval_minutes: t.interval_minutes,
            execution_count: t.execution_count,
            last_executed_at: t.last_executed_at.map(|dt| dt.to_rfc3339()),
            created_at: t.created_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCronRequest {
    task_id: String,
    patch: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdRequest {
    task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ===== Handlers =====

async fn create_cron_handler(
    Json(req): Json<CreateCronRequest>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();

    let run_mode = match req.session_target.as_deref() {
        Some("single_session") => cron_task::RunMode::SingleSession,
        _ => cron_task::RunMode::NewSession,
    };

    let interval_minutes = match &req.schedule {
        Some(CronSchedule::Every { minutes }) => *minutes,
        Some(CronSchedule::At { .. }) => 60, // placeholder, not used for one-shot
        Some(CronSchedule::Cron { .. }) => 60, // placeholder, calculated by cron expression
        None => req.interval_minutes.unwrap_or(30),
    };

    let session_id = format!("cron-im-{}", uuid::Uuid::new_v4());

    let config = CronTaskConfig {
        workspace_path: req.workspace_path,
        session_id,
        prompt: req.message,
        interval_minutes: interval_minutes.max(5),
        end_conditions: Default::default(),
        run_mode,
        notify_enabled: true,
        tab_id: None,
        permission_mode: req.permission_mode.unwrap_or_else(|| "auto".to_string()),
        model: req.model,
        provider_env: req.provider_env,
        source_bot_id: req.source_bot_id,
        delivery: req.delivery,
        schedule: req.schedule,
        name: req.name,
    };

    match manager.create_task(config).await {
        Ok(task) => {
            // Auto-start the task
            let task_id = task.id.clone();
            if let Err(e) = manager.start_task(&task_id).await {
                log::warn!("[management-api] Created task {} but failed to start: {}", task_id, e);
            } else if let Err(e) = manager.start_task_scheduler(&task_id).await {
                log::warn!("[management-api] Started task {} but failed to start scheduler: {}", task_id, e);
            }

            Json(serde_json::json!({
                "ok": true,
                "taskId": task.id,
                "status": "running"
            }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": e
        })),
    }
}

async fn list_cron_handler(
    Query(query): Query<ListCronQuery>,
) -> Json<ListCronResponse> {
    let manager = cron_task::get_cron_task_manager();

    let tasks = if let Some(bot_id) = &query.source_bot_id {
        manager.get_tasks_for_bot(bot_id).await
    } else {
        manager.get_all_tasks().await
    };

    let summaries: Vec<CronTaskSummary> = tasks.into_iter().map(CronTaskSummary::from).collect();
    Json(ListCronResponse { tasks: summaries })
}

async fn update_cron_handler(
    Json(req): Json<UpdateCronRequest>,
) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    match manager.update_task_fields(&req.task_id, req.patch).await {
        Ok(_) => Json(ApiResponse { ok: true, error: None }),
        Err(e) => Json(ApiResponse {
            ok: false,
            error: Some(e),
        }),
    }
}

async fn delete_cron_handler(
    Json(req): Json<TaskIdRequest>,
) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    // Stop first if running
    let _ = manager.stop_task(&req.task_id, Some("Deleted via management API".to_string())).await;

    match manager.delete_task(&req.task_id).await {
        Ok(()) => Json(ApiResponse { ok: true, error: None }),
        Err(e) => Json(ApiResponse {
            ok: false,
            error: Some(e),
        }),
    }
}

async fn run_cron_handler(
    Json(req): Json<TaskIdRequest>,
) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    // Check task exists
    let task = match manager.get_task(&req.task_id).await {
        Some(t) => t,
        None => {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Task not found: {}", req.task_id)),
            });
        }
    };

    // If task is stopped, start it first
    if task.status == cron_task::TaskStatus::Stopped {
        if let Err(e) = manager.start_task(&req.task_id).await {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Failed to start task: {}", e)),
            });
        }
        if let Err(e) = manager.start_task_scheduler(&req.task_id).await {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Failed to start scheduler: {}", e)),
            });
        }
    }

    Json(ApiResponse { ok: true, error: None })
}
