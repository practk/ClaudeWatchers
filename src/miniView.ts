// Mini 模式的列資料組裝與視窗尺寸計算:純函式,與 DOM / Tauri API 分離以便測試。

import { formatElapsed, type SessionInfo, type SessionStatus } from "./sessionStore";

export interface MiniRow {
  status: SessionStatus;
  project: string;
  detail: string;
  sessionId: string;
}

const STATUS_TEXT: Record<Exclude<SessionStatus, "working">, string> = {
  idle: "閒置",
  waiting: "等待授權",
  done: "已完成",
};

export function buildMiniRows(sessions: SessionInfo[], now: number): MiniRow[] {
  return sessions.map((s) => ({
    status: s.status,
    project: s.project,
    detail: s.status === "working" ? `⏱ ${formatElapsed(s.workingSince, now)}` : STATUS_TEXT[s.status],
    sessionId: s.sessionId,
  }));
}

/** mini 視窗尺寸(邏輯 px) */
export const MINI_WIDTH = 260;
export const MINI_DRAG_H = 30;
export const MINI_ROW_H = 28;
export const MINI_NOTICE_H = 26;
export const MAX_VISIBLE_ROWS = 8;

/** 拖曳列 + 列數(無 session 時保留 1 列空狀態,超過上限改內部捲動)+ 6px 上下留白 + 通知列 */
export function miniWindowHeight(rowCount: number, withNotice = false): number {
  const rows = Math.min(Math.max(rowCount, 1), MAX_VISIBLE_ROWS);
  return MINI_DRAG_H + rows * MINI_ROW_H + 6 + (withNotice ? MINI_NOTICE_H : 0);
}
