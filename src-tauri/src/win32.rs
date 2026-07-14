// 以視窗標題比對聚焦既有視窗（獨立終端機 / 未知宿主 session 的點擊跳轉用）。
// 限制：Windows Terminal 的視窗標題只反映作用中分頁，且 Claude Code 會把分頁標題
// 改成任務摘要而非專案名，所以終端機找不到專案名時退回「唯一終端機視窗」啟發式。

use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

/// Windows Terminal 與傳統主控台的視窗 class
const TERMINAL_CLASSES: [&str; 2] = ["CASCADIA_HOSTING_WINDOW_CLASS", "ConsoleWindowClass"];

pub struct WindowInfo {
    /// HWND 以 usize 保存，聚焦時再轉回指標（讓選擇邏輯可以純函式測試）
    pub hwnd: usize,
    pub title: String,
    pub class: String,
    pub pid: u32,
}

impl WindowInfo {
    fn is_terminal(&self) -> bool {
        TERMINAL_CLASSES.contains(&self.class.as_str())
    }
}

/// 從候選視窗中挑出要聚焦的一個，回傳索引：
/// 1. 一律排除自己（own_pid）的視窗，避免監控程式標題含專案名時聚焦到自己
/// 2. 標題含 needle（不分大小寫）者優先；terminal_only 時僅限終端機 class
/// 3. terminal_only 且無標題相符時，若終端機視窗恰好只有一個就選它
pub fn pick_window(
    windows: &[WindowInfo],
    needle: &str,
    terminal_only: bool,
    own_pid: u32,
) -> Option<usize> {
    let needle_lower = needle.to_lowercase();
    let candidates: Vec<usize> = windows
        .iter()
        .enumerate()
        .filter(|(_, w)| w.pid != own_pid && (!terminal_only || w.is_terminal()))
        .map(|(i, _)| i)
        .collect();

    if let Some(&i) = candidates
        .iter()
        .find(|&&i| windows[i].title.to_lowercase().contains(&needle_lower))
    {
        return Some(i);
    }
    if terminal_only && candidates.len() == 1 {
        return Some(candidates[0]);
    }
    None
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> i32 {
    let out = &mut *(lparam as *mut Vec<WindowInfo>);
    if IsWindowVisible(hwnd) == 0 {
        return 1; // 繼續枚舉
    }

    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if len <= 0 {
        return 1;
    }
    let title = String::from_utf16_lossy(&buf[..len as usize]);

    let mut cbuf = [0u16; 256];
    let clen = GetClassNameW(hwnd, cbuf.as_mut_ptr(), cbuf.len() as i32);
    let class = String::from_utf16_lossy(&cbuf[..clen.max(0) as usize]);

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);

    out.push(WindowInfo {
        hwnd: hwnd as usize,
        title,
        class,
        pid,
    });
    1
}

fn list_windows() -> Vec<WindowInfo> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    unsafe {
        EnumWindows(Some(enum_cb), &mut windows as *mut Vec<WindowInfo> as LPARAM);
    }
    windows
}

/// 找該聚焦的視窗並帶到前景；回傳是否成功
pub fn focus_matching_window(title_hint: &str, terminal_only: bool) -> bool {
    let windows = list_windows();
    let own_pid = unsafe { GetCurrentProcessId() };
    let Some(i) = pick_window(&windows, title_hint, terminal_only, own_pid) else {
        return false;
    };
    let hwnd = windows[i].hwnd as HWND;
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd) != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(title: &str, class: &str, pid: u32) -> WindowInfo {
        WindowInfo {
            hwnd: 1,
            title: title.into(),
            class: class.into(),
            pid,
        }
    }

    const OWN_PID: u32 = 99;

    #[test]
    fn 排除自己的視窗_即使標題相符() {
        let ws = [win("ClaudeWatchers", "TauriWindow", OWN_PID)];
        assert_eq!(pick_window(&ws, "claudewatchers", false, OWN_PID), None);
    }

    #[test]
    fn 標題比對不分大小寫_跳過自己選到別的視窗() {
        let ws = [
            win("ClaudeWatchers", "TauriWindow", OWN_PID),
            win("main.ts - ClaudeWatchers - Visual Studio Code", "Chrome_WidgetWin_1", 2),
        ];
        assert_eq!(pick_window(&ws, "claudewatchers", false, OWN_PID), Some(1));
    }

    #[test]
    fn terminal_only_只比對終端機_class() {
        let ws = [
            win("MyProj - Visual Studio Code", "Chrome_WidgetWin_1", 2),
            win("✳ 任務摘要 - MyProj", "CASCADIA_HOSTING_WINDOW_CLASS", 3),
        ];
        assert_eq!(pick_window(&ws, "myproj", true, OWN_PID), Some(1));
    }

    #[test]
    fn 終端機無標題相符_唯一終端機視窗就選它() {
        // Claude Code 會把 WT 分頁標題改成任務摘要,專案名比對不到
        let ws = [
            win("MyProj - Visual Studio Code", "Chrome_WidgetWin_1", 2),
            win("✳ 补充缺失的假别编号", "CASCADIA_HOSTING_WINDOW_CLASS", 3),
        ];
        assert_eq!(pick_window(&ws, "myproj", true, OWN_PID), Some(1));
    }

    #[test]
    fn 終端機無標題相符_多個終端機視窗則放棄() {
        let ws = [
            win("✳ 任務甲", "CASCADIA_HOSTING_WINDOW_CLASS", 2),
            win("✳ 任務乙", "CASCADIA_HOSTING_WINDOW_CLASS", 3),
        ];
        assert_eq!(pick_window(&ws, "myproj", true, OWN_PID), None);
    }

    #[test]
    fn 任意模式無標題相符_不套唯一視窗啟發式() {
        let ws = [win("Spotify Premium", "Chrome_WidgetWin_1", 2)];
        assert_eq!(pick_window(&ws, "myproj", false, OWN_PID), None);
    }
}
