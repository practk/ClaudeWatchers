import { describe, expect, it } from "vitest";
import { classifyHost, SessionStore, type HookEvent } from "./sessionStore";

function evt(name: string, extra: Partial<HookEvent> = {}): HookEvent {
  return {
    hook_event_name: name,
    session_id: "s1",
    cwd: "C:/dev/Demo",
    ...extra,
  };
}

describe("SessionStore 狀態機", () => {
  it("完整生命週期:start → working → waiting → working → done → 移除", () => {
    const store = new SessionStore();
    store.apply(evt("SessionStart", { source: "startup" }));
    expect(store.get("s1")?.status).toBe("idle");

    store.apply(evt("UserPromptSubmit"));
    expect(store.get("s1")?.status).toBe("working");

    const notice = store.apply(evt("Notification", { message: "需要授權" }));
    expect(store.get("s1")?.status).toBe("waiting");
    expect(notice).not.toBeNull();

    store.apply(evt("PostToolUse"));
    expect(store.get("s1")?.status).toBe("working");

    const done = store.apply(evt("Stop"));
    expect(store.get("s1")?.status).toBe("done");
    expect(done).not.toBeNull();

    store.apply(evt("SessionEnd"));
    expect(store.get("s1")).toBeUndefined();
  });

  it("監控中途啟動:只收到 PostToolUse 的未知 session 應顯示 working(bug 1)", () => {
    const store = new SessionStore();
    store.apply(evt("PostToolUse"));
    const s = store.get("s1");
    expect(s?.status).toBe("working");
    expect(s?.workingSince).not.toBeNull();
  });

  it("compact/resume 的 SessionStart 不得把 working 打回 idle(bug 1)", () => {
    const store = new SessionStore();
    store.apply(evt("UserPromptSubmit"));
    expect(store.get("s1")?.status).toBe("working");

    store.apply(evt("SessionStart", { source: "compact" }));
    expect(store.get("s1")?.status).toBe("working");

    store.apply(evt("SessionStart", { source: "resume" }));
    expect(store.get("s1")?.status).toBe("working");
  });

  it("startup 的 SessionStart 才重置為 idle", () => {
    const store = new SessionStore();
    store.apply(evt("UserPromptSubmit"));
    store.apply(evt("SessionStart", { source: "startup" }));
    expect(store.get("s1")?.status).toBe("idle");
  });

  it("done 之後收到 PostToolUse 回到 working(背景任務喚醒)", () => {
    const store = new SessionStore();
    store.apply(evt("UserPromptSubmit"));
    store.apply(evt("Stop"));
    expect(store.get("s1")?.status).toBe("done");

    store.apply(evt("PostToolUse"));
    expect(store.get("s1")?.status).toBe("working");
  });

  it("waiting 期間收到活動事件即恢復 working,通知判斷用 get() 查得到最新狀態(bug 2)", () => {
    const store = new SessionStore();
    store.apply(evt("UserPromptSubmit"));
    store.apply(evt("Notification", { message: "Claude needs your permission to use Bash" }));
    expect(store.get("s1")?.status).toBe("waiting");

    // auto 模式自動授權 → 工具跑完回報 → 應已不在 waiting
    store.apply(evt("PostToolUse"));
    expect(store.get("s1")?.status).toBe("working");
  });

  it("PreToolUse AskUserQuestion → waiting + 等待回答通知", () => {
    const store = new SessionStore();
    store.apply(evt("UserPromptSubmit"));

    const notice = store.apply(evt("PreToolUse", { tool_name: "AskUserQuestion" }));
    expect(store.get("s1")?.status).toBe("waiting");
    expect(notice?.title).toContain("等待回答");

    // 回答後 PostToolUse 恢復 working
    store.apply(evt("PostToolUse", { tool_name: "AskUserQuestion" }));
    expect(store.get("s1")?.status).toBe("working");
  });

  it("其他工具的 PreToolUse 不改變狀態、不通知", () => {
    const store = new SessionStore();
    store.apply(evt("UserPromptSubmit"));

    const notice = store.apply(evt("PreToolUse", { tool_name: "Bash" }));
    expect(store.get("s1")?.status).toBe("working");
    expect(notice).toBeNull();
  });

  it("事件帶 cw_host 時記錄宿主,後續事件缺 cw_host 不清掉", () => {
    const store = new SessionStore();
    store.apply(evt("SessionStart", { source: "startup", cw_host: "vscode|%WT_SESSION%" }));
    expect(store.get("s1")?.host).toBe("vscode");

    store.apply(evt("PostToolUse"));
    expect(store.get("s1")?.host).toBe("vscode");
  });

  it("無 cw_host 的 session 宿主為 unknown", () => {
    const store = new SessionStore();
    store.apply(evt("SessionStart", { source: "startup" }));
    expect(store.get("s1")?.host).toBe("unknown");
  });

  it("缺 session_id 或 hook_event_name 的事件應忽略", () => {
    const store = new SessionStore();
    store.apply({ hook_event_name: "Stop" } as HookEvent);
    store.apply({ session_id: "x" } as unknown as HookEvent);
    expect(store.list()).toHaveLength(0);
  });
});

describe("classifyHost 宿主判別(hook header 值:TERM_PROGRAM|WT_SESSION|VSCODE_PID)", () => {
  it("TERM_PROGRAM=vscode → vscode(整合終端機)", () => {
    expect(classifyHost("vscode|%WT_SESSION%|%VSCODE_PID%")).toBe("vscode");
    expect(classifyHost("vscode|a1b2c3d4-0000-0000-0000-000000000000|123")).toBe("vscode");
  });

  it("VSCODE_PID 有展開的值 → vscode(擴充面板 session 沒有 TERM_PROGRAM)", () => {
    expect(classifyHost("%TERM_PROGRAM%|%WT_SESSION%|43268")).toBe("vscode");
  });

  it("WT_SESSION 有展開的值 → terminal(優先於 VSCODE_PID:從 VS Code 開的 WT 仍是終端機)", () => {
    expect(classifyHost("%TERM_PROGRAM%|a1b2c3d4-0000-0000-0000-000000000000|%VSCODE_PID%")).toBe("terminal");
    expect(classifyHost("%TERM_PROGRAM%|a1b2c3d4-0000-0000-0000-000000000000|43268")).toBe("terminal");
  });

  it("TERM_PROGRAM 是其他終端機 → terminal", () => {
    expect(classifyHost("mintty|%WT_SESSION%|%VSCODE_PID%")).toBe("terminal");
  });

  it("變數未展開(cmd 對未定義變數保留 %VAR% 原文)或空值 → unknown", () => {
    expect(classifyHost("%TERM_PROGRAM%|%WT_SESSION%|%VSCODE_PID%")).toBe("unknown");
    expect(classifyHost("||")).toBe("unknown");
    expect(classifyHost("")).toBe("unknown");
    expect(classifyHost(undefined)).toBe("unknown");
  });

  it("舊版兩欄位 header 仍相容", () => {
    expect(classifyHost("vscode|%WT_SESSION%")).toBe("vscode");
    expect(classifyHost("%TERM_PROGRAM%|%WT_SESSION%")).toBe("unknown");
  });
});
