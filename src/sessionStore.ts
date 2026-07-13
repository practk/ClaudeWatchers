// Session 狀態機：以 session_id 為 key 追蹤每個 Claude Code session 的狀態。
// 與 UI 分離，未來 token 統計、娛樂效果都從這裡的事件流擴充。

export type SessionStatus = "idle" | "working" | "waiting" | "done";

export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  message?: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  sessionId: string;
  project: string;
  cwd: string;
  status: SessionStatus;
  /** 進入 working 的時間，用來顯示經過時間 */
  workingSince: number | null;
  lastEventAt: number;
  lastEventName: string;
}

export interface Notice {
  title: string;
  body: string;
}

/** 超過此時間無任何事件的 session 視為殘留，自動移除（VS Code 強關不會送 SessionEnd） */
const STALE_MS = 2 * 60 * 60 * 1000;

function projectNameOf(cwd: string | undefined): string {
  if (!cwd) return "(未知專案)";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export class SessionStore {
  private sessions = new Map<string, SessionInfo>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /** 套用一個 hook 事件；若需要跳系統通知，回傳通知內容 */
  apply(event: HookEvent): Notice | null {
    if (!event.session_id || !event.hook_event_name) return null;

    const now = Date.now();
    const name = event.hook_event_name;

    if (name === "SessionEnd") {
      this.sessions.delete(event.session_id);
      this.emit();
      return null;
    }

    const session = this.ensure(event, now);
    session.lastEventAt = now;
    session.lastEventName = name;
    if (event.cwd) {
      session.cwd = event.cwd;
      session.project = projectNameOf(event.cwd);
    }

    let notice: Notice | null = null;
    switch (name) {
      case "SessionStart": {
        // compact / resume 是同一 session 的中途重啟，不能把工作中狀態打回閒置
        const source = typeof event.source === "string" ? event.source : "";
        if (source !== "compact" && source !== "resume") {
          session.status = "idle";
          session.workingSince = null;
        }
        break;
      }
      case "UserPromptSubmit":
        session.status = "working";
        session.workingSince = now;
        break;
      case "Notification":
        session.status = "waiting";
        notice = {
          title: `⏳ ${session.project} — 等待授權`,
          body: typeof event.message === "string" ? event.message : "Claude Code 正在等待你的回應",
        };
        break;
      case "PreToolUse":
        // 只有 AskUserQuestion(選項提問)需要人回答;hook 端 matcher 也只轉發它
        if (event.tool_name === "AskUserQuestion") {
          session.status = "waiting";
          notice = {
            title: `❓ ${session.project} — 等待回答`,
            body: "Claude 正在等你回答選項問題",
          };
        }
        break;
      case "Stop":
        notice = {
          title: `✅ ${session.project} — 回覆完成`,
          body: `耗時 ${formatElapsed(session.workingSince, now)}`,
        };
        session.status = "done";
        session.workingSince = null;
        break;
      default:
        // 其他事件（如 PostToolUse）代表 session 正在活動：
        // 監控中途啟動時只收得到這類事件，也要能進入 working；
        // waiting 收到後續事件表示授權已解決（含 auto 模式自動授權）
        if (name === "PostToolUse" || session.status === "waiting") {
          session.status = "working";
          session.workingSince ??= now;
        }
        break;
    }

    this.emit();
    return notice;
  }

  /** 移除長時間無事件的殘留 session；有移除時回傳 true */
  sweep(): boolean {
    const now = Date.now();
    let removed = false;
    for (const [id, s] of this.sessions) {
      if (now - s.lastEventAt > STALE_MS) {
        this.sessions.delete(id);
        removed = true;
      }
    }
    if (removed) this.emit();
    return removed;
  }

  private ensure(event: HookEvent, now: number): SessionInfo {
    let session = this.sessions.get(event.session_id);
    if (!session) {
      // 監控程式中途才啟動時，任何事件都能補建 session
      session = {
        sessionId: event.session_id,
        project: projectNameOf(event.cwd),
        cwd: event.cwd ?? "",
        status: "idle",
        workingSince: null,
        lastEventAt: now,
        lastEventName: event.hook_event_name,
      };
      this.sessions.set(event.session_id, session);
    }
    return session;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export function formatElapsed(since: number | null, now: number): string {
  if (since === null) return "—";
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  return `${Math.floor(min / 60)} 時 ${min % 60} 分`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
