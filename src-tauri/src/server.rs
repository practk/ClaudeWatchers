use tauri::{AppHandle, Emitter, Manager};

use crate::usage::{self, UsageState};

pub const LISTEN_ADDR: &str = "127.0.0.1:47821";

/// PostToolUse = 一次工具執行:累加當日工具計數
fn record_tool_use(app: &AppHandle, payload: &serde_json::Value) {
    let Some(tool_name) = payload.get("tool_name").and_then(|v| v.as_str()) else {
        return;
    };
    let state = app.state::<UsageState>();
    {
        let Ok(mut db) = state.db.lock() else { return };
        db.record_tool(tool_name, &usage::today_local());
        db.save(&state.file);
    }
}

/// Stop 事件 = 一輪回覆結束:解析 transcript 結算 token 用量
fn record_usage_on_stop(app: &AppHandle, payload: &serde_json::Value) {
    match payload.get("hook_event_name").and_then(|v| v.as_str()) {
        Some("Stop") => {}
        Some("PostToolUse") => {
            record_tool_use(app, payload);
            return;
        }
        _ => return,
    }
    let (Some(session_id), Some(transcript_path)) = (
        payload.get("session_id").and_then(|v| v.as_str()),
        payload.get("transcript_path").and_then(|v| v.as_str()),
    ) else {
        return;
    };
    let project = payload
        .get("cwd")
        .and_then(|v| v.as_str())
        .and_then(|cwd| cwd.replace('\\', "/").split('/').filter(|s| !s.is_empty()).last().map(String::from))
        .unwrap_or_else(|| "(未知專案)".to_string());

    let Some(totals) = usage::parse_transcript(std::path::Path::new(transcript_path)) else {
        return;
    };

    let state = app.state::<UsageState>();
    let changed = {
        let Ok(mut db) = state.db.lock() else { return };
        let changed = db.record(
            session_id,
            &project,
            totals,
            &usage::today_local(),
            &usage::stamp_local(),
        );
        if changed {
            db.save(&state.file);
        }
        changed
    };
    if changed {
        let _ = app.emit("usage-updated", ());
    }
}

/// 在背景 thread 啟動 HTTP server，接收 Claude Code hook 轉發的事件。
/// POST /event：hook stdin 的 JSON 原樣轉發進來，解析後以 Tauri event 送給前端。
/// GET /health：供 hook 端或使用者確認監控程式是否在線。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(LISTEN_ADDR) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[ClaudeWatchers] HTTP server failed to bind {LISTEN_ADDR}: {e}");
                return;
            }
        };

        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();

            match (&method, url.as_str()) {
                (tiny_http::Method::Get, "/health") => {
                    let _ = request.respond(tiny_http::Response::from_string("ok"));
                }
                (tiny_http::Method::Post, "/event") => {
                    // hook 端用 header 附帶宿主環境變數（TERM_PROGRAM|WT_SESSION），
                    // 注入 payload 讓前端判斷點擊跳轉方式
                    let host_header = request
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("X-Claude-Host"))
                        .map(|h| h.value.as_str().to_string());
                    let mut body = String::new();
                    if request.as_reader().read_to_string(&mut body).is_ok() {
                        if let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(&body) {
                            if let (Some(host), Some(obj)) = (host_header, payload.as_object_mut()) {
                                obj.insert("cw_host".into(), serde_json::Value::String(host));
                            }
                            record_usage_on_stop(&app, &payload);
                            let _ = app.emit("claude-event", payload);
                        }
                    }
                    let _ = request.respond(tiny_http::Response::from_string("ok"));
                }
                _ => {
                    let _ = request.respond(
                        tiny_http::Response::from_string("not found").with_status_code(404),
                    );
                }
            }
        }
    });
}
