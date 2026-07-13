import { describe, expect, it } from "vitest";
import {
  buildMiniRows,
  miniWindowHeight,
  MINI_DRAG_H,
  MINI_ROW_H,
  MAX_VISIBLE_ROWS,
} from "./miniView";
import type { SessionInfo } from "./sessionStore";

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "s1",
    project: "MyProject",
    cwd: "C:/dev/MyProject",
    status: "idle",
    workingSince: null,
    lastEventAt: 0,
    lastEventName: "SessionStart",
    ...over,
  };
}

describe("buildMiniRows", () => {
  it("working 顯示經過時間", () => {
    const rows = buildMiniRows([session({ status: "working", workingSince: 0 })], 90_000);
    expect(rows).toEqual([{ status: "working", project: "MyProject", detail: "⏱ 1 分 30 秒" }]);
  });

  it("其他狀態顯示狀態文字", () => {
    const rows = buildMiniRows(
      [session({ status: "waiting" }), session({ status: "done" }), session({ status: "idle" })],
      0
    );
    expect(rows.map((r) => r.detail)).toEqual(["等待授權", "已完成", "閒置"]);
  });
});

describe("miniWindowHeight", () => {
  it("無 session 時保留一列空狀態", () => {
    expect(miniWindowHeight(0)).toBe(MINI_DRAG_H + MINI_ROW_H + 6);
  });

  it("依列數成長", () => {
    expect(miniWindowHeight(3)).toBe(MINI_DRAG_H + 3 * MINI_ROW_H + 6);
  });

  it("超過上限固定高度", () => {
    expect(miniWindowHeight(20)).toBe(MINI_DRAG_H + MAX_VISIBLE_ROWS * MINI_ROW_H + 6);
  });
});
