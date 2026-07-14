mod server;
mod usage;
#[cfg(windows)]
mod win32;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// 用 `code <cwd>` 開啟專案：VS Code 單一實例機制會聚焦已開啟該資料夾的視窗
#[tauri::command]
fn open_in_editor(cwd: String) -> Result<(), String> {
    if cwd.is_empty() {
        return Err("此 session 沒有專案路徑".into());
    }
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", "code", &cwd]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("無法執行 code CLI：{e}"))?;
    Ok(())
}

/// 聚焦標題含 `title_hint` 的既有視窗（terminal_only 時僅限終端機視窗 class）。
/// 找不到就回錯誤，不強制開任何程式。
#[tauri::command]
fn focus_window(title_hint: String, terminal_only: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if win32::focus_matching_window(&title_hint, terminal_only) {
            return Ok(());
        }
        let scope = if terminal_only { "終端機" } else { "" };
        Err(format!("找不到標題含「{title_hint}」的{scope}視窗"))
    }
    #[cfg(not(windows))]
    {
        let _ = (title_hint, terminal_only);
        Err("僅支援 Windows".into())
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重複啟動時，把既有實例的視窗叫出來
            show_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            usage::get_usage,
            open_in_editor,
            focus_window
        ])
        .setup(|app| {
            let usage_file = app
                .path()
                .app_data_dir()
                .expect("no app data dir")
                .join("usage.json");
            app.manage(usage::UsageState {
                db: std::sync::Mutex::new(usage::UsageDb::load(&usage_file)),
                file: usage_file,
            });

            server::start(app.handle().clone());

            let show = MenuItem::with_id(app, "show", "顯示面板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ClaudeWatchers")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // 關窗縮到系統匣，不結束程式
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
