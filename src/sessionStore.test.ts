import { describe, expect, it } from "vitest";
import { SessionStore, type HookEvent } from "./sessionStore";

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

  it("缺 session_id 或 hook_event_name 的事件應忽略", () => {
    const store = new SessionStore();
    store.apply({ hook_event_name: "Stop" } as HookEvent);
    store.apply({ session_id: "x" } as unknown as HookEvent);
    expect(store.list()).toHaveLength(0);
  });
});
