// Token 用量統計:解析 Claude Code transcript JSONL,以 session 快照差額累積到「日期 × 專案」。
// 資料落地於 app data 目錄的 usage.json,監控程式重啟不遺失。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

impl TokenTotals {
    fn add(&mut self, other: &TokenTotals) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_creation_input_tokens += other.cache_creation_input_tokens;
        self.cache_read_input_tokens += other.cache_read_input_tokens;
    }

    /// self - old,任一欄位為負(transcript 被清空重寫等)就整組視為 0
    fn delta_since(&self, old: &TokenTotals) -> TokenTotals {
        TokenTotals {
            input_tokens: self.input_tokens.saturating_sub(old.input_tokens),
            output_tokens: self.output_tokens.saturating_sub(old.output_tokens),
            cache_creation_input_tokens: self
                .cache_creation_input_tokens
                .saturating_sub(old.cache_creation_input_tokens),
            cache_read_input_tokens: self
                .cache_read_input_tokens
                .saturating_sub(old.cache_read_input_tokens),
        }
    }

    fn is_zero(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_creation_input_tokens == 0
            && self.cache_read_input_tokens == 0
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub project: String,
    pub totals: TokenTotals,
    /// 最後更新日期(YYYY-MM-DD),用於清理舊快照
    pub last_seen: String,
}

/// 一次結算(= 一輪回覆)的用量紀錄
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEntry {
    pub when: String,
    pub session: String,
    pub delta: TokenTotals,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UsageDb {
    /// session_id → 上次結算的累計量(算差額用)
    pub sessions: HashMap<String, SessionSnapshot>,
    /// 日期 → 專案 → 當日累積量
    pub daily: BTreeMap<String, HashMap<String, TokenTotals>>,
    /// 專案 → 最近幾次結算(新→舊),舊版 usage.json 沒有此欄位
    #[serde(default)]
    pub recent: HashMap<String, Vec<RecentEntry>>,
    /// 日期 → 工具名稱 → 執行次數
    #[serde(default)]
    pub tools: BTreeMap<String, HashMap<String, u64>>,
}

/// 快照保留天數:超過即視為 session 已結束,清掉以免無限成長
const SNAPSHOT_KEEP_DAYS: i64 = 30;

/// 每個專案保留的最近結算筆數
const RECENT_KEEP: usize = 10;

impl UsageDb {
    /// 結算一次 Stop:以 transcript 總量對快照算差額,累積到當日該專案。
    /// 回傳是否有實際變動(需要存檔/通知前端)。
    pub fn record(
        &mut self,
        session_id: &str,
        project: &str,
        totals: TokenTotals,
        today: &str,
        stamp: &str,
    ) -> bool {
        let old = self
            .sessions
            .get(session_id)
            .map(|s| s.totals.clone())
            .unwrap_or_default();
        let delta = totals.delta_since(&old);

        self.sessions.insert(
            session_id.to_string(),
            SessionSnapshot {
                project: project.to_string(),
                totals,
                last_seen: today.to_string(),
            },
        );
        self.prune(today);

        if delta.is_zero() {
            return false;
        }
        self.daily
            .entry(today.to_string())
            .or_default()
            .entry(project.to_string())
            .or_default()
            .add(&delta);

        let recent = self.recent.entry(project.to_string()).or_default();
        recent.insert(
            0,
            RecentEntry {
                when: stamp.to_string(),
                session: session_id.to_string(),
                delta,
            },
        );
        recent.truncate(RECENT_KEEP);
        true
    }

    /// 記一次工具執行(PostToolUse)
    pub fn record_tool(&mut self, tool_name: &str, today: &str) {
        *self
            .tools
            .entry(today.to_string())
            .or_default()
            .entry(tool_name.to_string())
            .or_default() += 1;
    }

    fn prune(&mut self, today: &str) {
        let Ok(today) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d") else {
            return;
        };
        self.sessions.retain(|_, snap| {
            chrono::NaiveDate::parse_from_str(&snap.last_seen, "%Y-%m-%d")
                .map(|d| (today - d).num_days() <= SNAPSHOT_KEEP_DAYS)
                .unwrap_or(false)
        });
    }

    pub fn load(path: &Path) -> UsageDb {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(self) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// 解析 transcript JSONL,加總所有 assistant 訊息的 usage(以 message.id 去重)
pub fn parse_transcript(path: &Path) -> Option<TokenTotals> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut totals = TokenTotals::default();
    let mut seen = HashSet::new();

    for line in reader.lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        if let Some(id) = message.get("id").and_then(|v| v.as_str()) {
            if !seen.insert(id.to_string()) {
                continue;
            }
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let g = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        totals.add(&TokenTotals {
            input_tokens: g("input_tokens"),
            output_tokens: g("output_tokens"),
            cache_creation_input_tokens: g("cache_creation_input_tokens"),
            cache_read_input_tokens: g("cache_read_input_tokens"),
        });
    }
    Some(totals)
}

pub struct UsageState {
    pub db: Mutex<UsageDb>,
    pub file: PathBuf,
}

pub fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn stamp_local() -> String {
    chrono::Local::now().format("%m-%d %H:%M").to_string()
}

#[derive(Debug, Default, Serialize)]
pub struct UsageView {
    pub daily: BTreeMap<String, HashMap<String, TokenTotals>>,
    pub recent: HashMap<String, Vec<RecentEntry>>,
    pub tools: BTreeMap<String, HashMap<String, u64>>,
}

/// 前端查詢用:回傳 daily 統計與各專案最近結算
#[tauri::command]
pub fn get_usage(state: tauri::State<'_, UsageState>) -> UsageView {
    state
        .db
        .lock()
        .map(|db| UsageView {
            daily: db.daily.clone(),
            recent: db.recent.clone(),
            tools: db.tools.clone(),
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(i: u64, o: u64, cc: u64, cr: u64) -> TokenTotals {
        TokenTotals {
            input_tokens: i,
            output_tokens: o,
            cache_creation_input_tokens: cc,
            cache_read_input_tokens: cr,
        }
    }

    #[test]
    fn parse_transcript_sums_and_dedupes() {
        let dir = std::env::temp_dir().join("cw-usage-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transcript.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","message":{"content":"hi"}}"#, "\n",
                r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":30,"cache_read_input_tokens":40}}}"#, "\n",
                r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":30,"cache_read_input_tokens":40}}}"#, "\n",
                "not json\n",
                r#"{"type":"assistant","message":{"id":"m2","usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4}}}"#, "\n",
                r#"{"type":"assistant","message":{"id":"m3"}}"#, "\n"
            ),
        )
        .unwrap();

        let totals = parse_transcript(&path).unwrap();
        assert_eq!(totals, t(11, 22, 33, 44));
    }

    #[test]
    fn record_accumulates_delta_only() {
        let mut db = UsageDb::default();

        // 第一次 Stop:全量入帳
        assert!(db.record("s1", "ProjA", t(10, 20, 30, 40), "2026-07-09", "07-09 12:00"));
        // 第二次 Stop:只入差額
        assert!(db.record("s1", "ProjA", t(15, 25, 30, 40), "2026-07-09", "07-09 12:00"));
        let day = &db.daily["2026-07-09"]["ProjA"];
        assert_eq!(*day, t(15, 25, 30, 40));

        // 無變化的 Stop 不入帳
        assert!(!db.record("s1", "ProjA", t(15, 25, 30, 40), "2026-07-09", "07-09 12:00"));
    }

    #[test]
    fn record_shrunk_transcript_clamps_to_zero() {
        let mut db = UsageDb::default();
        db.record("s1", "ProjA", t(100, 100, 100, 100), "2026-07-09", "07-09 12:00");
        // transcript 變小(被清空重開):不得出現負數,且快照重設為新值
        assert!(!db.record("s1", "ProjA", t(1, 1, 1, 1), "2026-07-09", "07-09 12:00"));
        assert_eq!(db.sessions["s1"].totals, t(1, 1, 1, 1));
    }

    #[test]
    fn record_splits_across_days_and_projects() {
        let mut db = UsageDb::default();
        db.record("s1", "ProjA", t(0, 10, 0, 0), "2026-07-08", "07-09 12:00");
        db.record("s1", "ProjA", t(0, 25, 0, 0), "2026-07-09", "07-09 12:00");
        db.record("s2", "ProjB", t(0, 7, 0, 0), "2026-07-09", "07-09 12:00");

        assert_eq!(db.daily["2026-07-08"]["ProjA"].output_tokens, 10);
        assert_eq!(db.daily["2026-07-09"]["ProjA"].output_tokens, 15);
        assert_eq!(db.daily["2026-07-09"]["ProjB"].output_tokens, 7);
    }

    #[test]
    fn prune_drops_stale_snapshots_keeps_daily() {
        let mut db = UsageDb::default();
        db.record("old", "ProjA", t(0, 10, 0, 0), "2026-05-01", "07-09 12:00");
        db.record("new", "ProjB", t(0, 5, 0, 0), "2026-07-09", "07-09 12:00");

        assert!(!db.sessions.contains_key("old"));
        assert!(db.sessions.contains_key("new"));
        // 歷史統計不受快照清理影響
        assert_eq!(db.daily["2026-05-01"]["ProjA"].output_tokens, 10);
    }

    #[test]
    fn record_tool_counts_per_day() {
        let mut db = UsageDb::default();
        db.record_tool("Bash", "2026-07-09");
        db.record_tool("Bash", "2026-07-09");
        db.record_tool("Edit", "2026-07-09");
        db.record_tool("Bash", "2026-07-10");

        assert_eq!(db.tools["2026-07-09"]["Bash"], 2);
        assert_eq!(db.tools["2026-07-09"]["Edit"], 1);
        assert_eq!(db.tools["2026-07-10"]["Bash"], 1);
    }

    #[test]
    fn load_old_usage_json_without_new_fields() {
        let dir = std::env::temp_dir().join("cw-usage-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage-old.json");
        std::fs::write(&path, r#"{"sessions":{},"daily":{}}"#).unwrap();

        let db = UsageDb::load(&path);
        assert!(db.tools.is_empty());
        assert!(db.recent.is_empty());
    }

    #[test]
    fn record_keeps_recent_entries_newest_first() {
        let mut db = UsageDb::default();
        for i in 1..=12u64 {
            db.record(
                "s1",
                "ProjA",
                t(0, i * 10, 0, 0),
                "2026-07-09",
                &format!("07-09 10:{i:02}"),
            );
        }
        let recent = &db.recent["ProjA"];
        // 超過上限只留最近 10 筆,新的在前
        assert_eq!(recent.len(), 10);
        assert_eq!(recent[0].when, "07-09 10:12");
        // 每筆是「該輪的差額」而非累計
        assert_eq!(recent[0].delta, t(0, 10, 0, 0));

        // 無變化的結算不產生紀錄
        db.record("s1", "ProjA", t(0, 120, 0, 0), "2026-07-09", "07-09 10:13");
        assert_eq!(db.recent["ProjA"].len(), 10);
        assert_eq!(db.recent["ProjA"][0].when, "07-09 10:12");
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = std::env::temp_dir().join("cw-usage-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage.json");

        let mut db = UsageDb::default();
        db.record("s1", "ProjA", t(1, 2, 3, 4), "2026-07-09", "07-09 12:00");
        db.save(&path);

        let loaded = UsageDb::load(&path);
        assert_eq!(loaded.daily["2026-07-09"]["ProjA"], t(1, 2, 3, 4));
        assert_eq!(loaded.sessions["s1"].totals, t(1, 2, 3, 4));
    }
}
