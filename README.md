# ClaudeWatchers

Claude Code 狀態監控桌面程式（Windows 常駐系統匣）。即時顯示所有 Claude Code session 的工作狀態，在「回覆完成」與「等待授權」時跳 Windows 通知。

## 運作原理

Claude Code hooks（`SessionStart` / `UserPromptSubmit` / `Notification` / `Stop` / `SessionEnd` / `PostToolUse`）觸發時，用 `curl.exe` 把 hook stdin 的 JSON 轉發到 `http://127.0.0.1:47821/event`。本程式的 Rust 端 HTTP server 收到後轉發給前端狀態機，更新面板並發 toast 通知。

- Hook 端 `-m 1` 逾時 1 秒、失敗靜默：監控程式沒開也完全不影響 Claude Code。
- 對 VS Code 插件、CLI、多視窗多專案同時開啟一律通用。

## 開發

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run tauri build
```

單一 exe 產出於 `src-tauri/target/release/ClaudeWatchers.exe`。

## Hooks 安裝

已合併於 `~/.claude/settings.json` 的 `hooks` 區段，七個事件共用同一條指令
（`PreToolUse` 需設 `"matcher": "AskUserQuestion"` 只轉發選項提問，其餘六個不設 matcher）：

```
curl.exe -s -m 1 -o nul -X POST http://127.0.0.1:47821/event -H "Content-Type: application/json" -H "X-Claude-Host: %TERM_PROGRAM%|%WT_SESSION%|%VSCODE_PID%" --data-binary @-
```

`X-Claude-Host` header 帶上宿主環境變數（VS Code 整合終端機有 `TERM_PROGRAM=vscode`、
Windows Terminal 有 `WT_SESSION`、VS Code 擴充面板的 session 只有 `VSCODE_PID`），
供點擊跳轉判斷該 session 跑在哪個程式。
未定義的變數 cmd 會保留 `%VAR%` 原文，server 端視同無值，因此舊指令（沒有此 header）也相容。

（hooks 在 session 啟動時載入，安裝後需開新 session 才生效。）

## 開機自啟（可選）

`Win+R` → `shell:startup` → 把 `ClaudeWatchers.exe` 的捷徑放進去。

## 手動測試

```bash
# 健康檢查
curl.exe http://127.0.0.1:47821/health

# 模擬回覆完成事件（應跳 toast）
curl.exe -X POST http://127.0.0.1:47821/event -H "Content-Type: application/json" -d "{\"hook_event_name\":\"Stop\",\"session_id\":\"test-1\",\"cwd\":\"C:/dev/MyProject\"}"
```

## Token 用量統計（v0.2.0）

每輪對話結束（`Stop` 事件）時解析該 session 的 transcript JSONL，以訊息 id 去重加總 `usage`，
用「session 快照差額」制累積到「日期 × 專案」，落地於 `%APPDATA%\com.practk8001.claudewatchers\usage.json`。
面板「用量統計」分頁顯示今日/近7日/累積輸出量、近 14 天長條圖與專案排行。

## 點擊跳轉(v0.8.0)

點擊 session 卡片(主畫面)或列(縮小模式)切換到該 session 所在的視窗。依宿主路由:

- **VS Code**(hook header 帶 `TERM_PROGRAM=vscode` 或 `VSCODE_PID`,涵蓋整合終端機與擴充面板):執行 `code <cwd>`,單一實例機制會聚焦已開啟該資料夾的視窗。
- **獨立終端機**(header 帶 `WT_SESSION` 等):Win32 `EnumWindows` 找標題含專案名的終端機視窗(Windows Terminal / 傳統主控台 class);Claude Code 會把分頁標題改成任務摘要導致比對不到,此時若終端機視窗只有一個就直接聚焦它。
- **未知**(hook 未更新或無環境資訊):放寬為任何標題含專案名的視窗;找不到只跳錯誤通知,不會強制開 VS Code。

比對一律排除監控程式自己的視窗(否則點「ClaudeWatchers」專案會聚焦到自己)。
已知限制:Windows Terminal 視窗標題只反映作用中分頁;開多個終端機視窗且標題都比對不到時會報找不到。

## 通知方式(v0.7.2,v0.7.3 修訂)

設定頁可選:**Windows 通知**(現行,會進通知中心)或**視窗泡泡**(視窗右下角彈出、
4 秒淡出、閱後即焚;視窗隱藏時看不到,適合搭配縮小模式 + 置頂使用)。
縮小模式下泡泡改為**底部通知列**:視窗長出一條狀態色通知列並自動加高,4 秒後收回,不遮住列表。

## 選項提問偵測(v0.7.1)

Claude 用選項提問(AskUserQuestion)等你作答時,面板轉「等待授權」並立即跳「等待回答」通知
(靠 `PreToolUse` hook 偵測;此情境必等人回答,不套等授權的 6 秒延遲確認)。

## 縮小模式(v0.7.0)

主視窗右上 🗕 切換成無邊框、自動置頂的精簡小視窗(每個 session 一行:狀態色點 + 專案名 + 經過時間),
拖曳頂列移動、⤢ 還原完整視窗、✕ 縮到系統匣。適合掛在螢幕角落監控。

## 測試

```bash
npx vitest run        # 前端：狀態機 + 統計計算
cd src-tauri && cargo test   # Rust：transcript 解析 + 差額累積
```

## 未來擴充（架構已預留）

- 成本換算：transcript 的 `message.model` 搭配各模型單價即可估算金額
- 娛樂性視覺效果：完成彩帶、working 動態等（`sessionStore.ts` 與 UI 已分離）
