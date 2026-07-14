import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, type PhysicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  formatClock,
  formatElapsed,
  SessionStore,
  type HookEvent,
  type SessionInfo,
} from "./sessionStore";
import { launchConfetti } from "./confetti";
import { showBubble, type BubbleKind } from "./bubbles";
import { buildMiniRows, miniWindowHeight, MINI_WIDTH } from "./miniView";
import {
  aggregateTools,
  buildHeatmap,
  computeCostUsd,
  computeMilestones,
  computeStreak,
  dateKey,
  displayToolName,
  formatTokens,
  formatUsd,
  MODEL_PRICING,
  summarize,
  type ToolsDaily,
  type TokenTotals,
  type UsageDaily,
  type UsageSummary,
} from "./usageStats";

const store = new SessionStore();

const STATUS_LABEL: Record<SessionInfo["status"], string> = {
  idle: "閒置",
  working: "工作中",
  waiting: "等待授權",
  done: "已完成",
};

// ---- 使用者設定 ----

interface AppSettings {
  notifyDone: boolean;
  notifyWaiting: boolean;
  alwaysOnTop: boolean;
  notifyStyle: "windows" | "bubble";
}

const DEFAULT_SETTINGS: AppSettings = {
  notifyDone: true,
  notifyWaiting: true,
  alwaysOnTop: false,
  notifyStyle: "windows",
};

const SETTINGS_KEY = "cw-settings";

function loadSettings(): AppSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const settings = loadSettings();

function saveSettings(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applyAlwaysOnTop(): void {
  void getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop);
}

function setupSettings(): void {
  type BoolSettingKey = "notifyDone" | "notifyWaiting" | "alwaysOnTop";
  const bind = (id: string, key: BoolSettingKey, onChange?: () => void) => {
    const box = document.querySelector<HTMLInputElement>(`#${id}`)!;
    box.checked = settings[key];
    box.addEventListener("change", () => {
      settings[key] = box.checked;
      saveSettings();
      onChange?.();
    });
  };
  bind("set-notify-done", "notifyDone");
  bind("set-notify-waiting", "notifyWaiting");
  bind("set-always-top", "alwaysOnTop", applyAlwaysOnTop);

  const styleWin = document.querySelector<HTMLInputElement>("#style-windows")!;
  const styleBubble = document.querySelector<HTMLInputElement>("#style-bubble")!;
  (settings.notifyStyle === "bubble" ? styleBubble : styleWin).checked = true;
  for (const radio of [styleWin, styleBubble]) {
    radio.addEventListener("change", () => {
      settings.notifyStyle = styleBubble.checked ? "bubble" : "windows";
      saveSettings();
    });
  }
}

let notifyGranted = false;

async function initNotification(): Promise<void> {
  notifyGranted = await isPermissionGranted();
  if (!notifyGranted) {
    notifyGranted = (await requestPermission()) === "granted";
  }
}

function notify(title: string, body: string, kind: BubbleKind = "info"): void {
  if (settings.notifyStyle === "bubble") {
    if (miniMode) {
      showMiniNotice(kind, title);
    } else {
      showBubble(kind, title, body);
    }
  } else if (notifyGranted) {
    sendNotification({ title, body });
  }
}

/** waiting 通知的延遲確認時間：期間 session 恢復活動（auto 模式自動授權）就不吵使用者 */
const WAITING_TOAST_DELAY_MS = 6000;
const pendingWaitingToasts = new Map<string, number>();

function scheduleWaitingToast(sessionId: string, title: string, body: string): void {
  const prev = pendingWaitingToasts.get(sessionId);
  if (prev !== undefined) clearTimeout(prev);
  const timer = window.setTimeout(() => {
    pendingWaitingToasts.delete(sessionId);
    // 到期時仍在 waiting 才代表真的需要使用者決策
    if (store.get(sessionId)?.status === "waiting") notify(title, body, "waiting");
  }, WAITING_TOAST_DELAY_MS);
  pendingWaitingToasts.set(sessionId, timer);
}

// ---- 縮小模式 ----

/** 完整視窗的 minSize / 預設尺寸,須與 tauri.conf.json 一致 */
const FULL_MIN = new LogicalSize(360, 400);
const FULL_DEFAULT = new LogicalSize(460, 620);

let miniMode = false;
let savedSize: PhysicalSize | null = null;
let lastMiniHeight = 0;

/** mini 模式底部通知列:泡泡在小視窗會遮列表,改為長出一條通知列再收回 */
const MINI_NOTICE_MS = 4000;
let miniNotice: { kind: BubbleKind; text: string } | null = null;
let miniNoticeTimer = 0;

function showMiniNotice(kind: BubbleKind, text: string): void {
  miniNotice = { kind, text };
  clearTimeout(miniNoticeTimer);
  miniNoticeTimer = window.setTimeout(() => {
    miniNotice = null;
    render();
  }, MINI_NOTICE_MS);
  render();
}

async function enterMiniMode(): Promise<void> {
  const win = getCurrentWindow();
  savedSize = await win.innerSize().catch(() => null);
  miniMode = true;
  lastMiniHeight = 0;
  document.body.classList.add("mini-mode");
  try {
    await win.setMinSize(new LogicalSize(MINI_WIDTH, miniWindowHeight(0)));
    await win.setDecorations(false);
    await win.setAlwaysOnTop(true);
  } catch {
    // 視窗 API 失敗時靜默:UI 已切換,不阻斷
  }
  render();
}

async function exitMiniMode(): Promise<void> {
  miniMode = false;
  miniNotice = null;
  clearTimeout(miniNoticeTimer);
  document.body.classList.remove("mini-mode");
  const win = getCurrentWindow();
  try {
    await win.setDecorations(true);
    await win.setAlwaysOnTop(settings.alwaysOnTop);
    await win.setMinSize(FULL_MIN);
    await win.setSize(savedSize ?? FULL_DEFAULT);
  } catch {
    // 同上,靜默
  }
  render();
}

function renderMini(): void {
  const rows = buildMiniRows(store.list(), Date.now());
  const listEl = document.querySelector<HTMLDivElement>("#mini-list")!;
  listEl.innerHTML =
    rows.length === 0
      ? `<div class="mini-row mini-empty">無活躍 session</div>`
      : rows
          .map(
            (r) => `
    <div class="mini-row" data-sid="${escapeHtml(r.sessionId)}" title="點擊切換到該視窗">
      <i class="dot dot-${r.status}"></i>
      <span class="mini-project" title="${escapeHtml(r.project)}">${escapeHtml(r.project)}</span>
      <span class="mini-detail">${escapeHtml(r.detail)}</span>
    </div>`
          )
          .join("");

  const noticeEl = document.querySelector<HTMLDivElement>("#mini-notice")!;
  noticeEl.hidden = miniNotice === null;
  if (miniNotice) {
    noticeEl.className = `notice-${miniNotice.kind}`;
    noticeEl.textContent = miniNotice.text;
    noticeEl.title = miniNotice.text;
  }

  // session 數或通知列變動時調整視窗高度
  const h = miniWindowHeight(rows.length, miniNotice !== null);
  if (h !== lastMiniHeight) {
    lastMiniHeight = h;
    getCurrentWindow()
      .setSize(new LogicalSize(MINI_WIDTH, h))
      .catch(() => {});
  }
}

function setupMiniMode(): void {
  document.querySelector<HTMLButtonElement>("#btn-mini")!.addEventListener("click", () => void enterMiniMode());
  document.querySelector<HTMLButtonElement>("#mini-restore")!.addEventListener("click", () => void exitMiniMode());
  document.querySelector<HTMLButtonElement>("#mini-hide")!.addEventListener("click", () => {
    void getCurrentWindow().hide();
  });
}

function render(): void {
  if (miniMode) {
    renderMini();
    return;
  }
  const listEl = document.querySelector<HTMLDivElement>("#session-list")!;
  const emptyEl = document.querySelector<HTMLDivElement>("#empty-hint")!;
  const sessions = store.list();

  emptyEl.style.display = sessions.length === 0 ? "block" : "none";
  const now = Date.now();

  listEl.innerHTML = sessions
    .map(
      (s) => `
    <div class="session-card status-${s.status}" data-sid="${escapeHtml(s.sessionId)}" title="點擊切換到該視窗">
      <div class="session-head">
        <span class="badge badge-${s.status}">${STATUS_LABEL[s.status]}</span>
        <span class="project" title="${escapeHtml(s.cwd)}">${escapeHtml(s.project)}</span>
      </div>
      <div class="session-meta">
        <span>${s.status === "working" ? `⏱ ${formatElapsed(s.workingSince, now)}` : ""}</span>
        <span class="last-event">${escapeHtml(s.lastEventName)} @ ${formatClock(s.lastEventAt)}</span>
      </div>
    </div>`
    )
    .join("");
}

// ---- 點擊卡片切換到該 session 的視窗 ----

/**
 * 依宿主路由：
 * - vscode → `code <cwd>`，單一實例機制會聚焦已開啟該資料夾的視窗
 * - terminal → Win32 找標題含專案名的終端機視窗聚焦
 * - unknown（hook 未更新或無環境資訊）→ 任何標題含專案名的視窗；找不到只報錯，不強制開 VS Code
 */
function jumpToSession(s: SessionInfo): void {
  const jump =
    s.host === "vscode"
      ? invoke("open_in_editor", { cwd: s.cwd })
      : invoke("focus_window", { titleHint: s.project, terminalOnly: s.host === "terminal" });
  jump.catch((err) => notify("⚠️ 無法切換視窗", String(err), "info"));
}

function setupJumpToSession(): void {
  const bind = (containerId: string, rowSelector: string) => {
    document.querySelector<HTMLDivElement>(containerId)!.addEventListener("click", (e) => {
      const sid = (e.target as HTMLElement).closest<HTMLElement>(rowSelector)?.dataset.sid;
      const session = sid ? store.get(sid) : undefined;
      if (session) jumpToSession(session);
    });
  };
  bind("#session-list", ".session-card");
  bind("#mini-list", ".mini-row");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- 用量統計頁 ----

interface RecentEntry {
  when: string;
  session: string;
  delta: TokenTotals;
}

interface UsageView {
  daily: UsageDaily;
  recent: Record<string, RecentEntry[]>;
  tools: ToolsDaily;
}

let lastSummary: UsageSummary | null = null;
let lastRecent: Record<string, RecentEntry[]> = {};

function describeTotals(t: TokenTotals): string {
  return (
    `輸出 ${formatTokens(t.output_tokens)}｜輸入 ${formatTokens(t.input_tokens)}｜` +
    `快取寫入 ${formatTokens(t.cache_creation_input_tokens)}｜快取讀取 ${formatTokens(t.cache_read_input_tokens)}`
  );
}

async function loadUsage(): Promise<void> {
  const view = await invoke<UsageView>("get_usage");
  lastSummary = summarize(view.daily, new Date());
  lastRecent = view.recent;
  renderStats(lastSummary);
  renderTools(view.tools);
  renderHeatmap(view.daily);
}

function renderTools(tools: ToolsDaily): void {
  const rows = aggregateTools(tools, dateKey(new Date()));
  const container = document.querySelector<HTMLDivElement>("#tool-rows")!;
  const totalEl = document.querySelector<HTMLElement>("#tools-total")!;

  if (rows.length === 0) {
    container.innerHTML = `<div class="tools-empty">尚無資料（從 v0.6.0 起開始記錄）</div>`;
    totalEl.textContent = "";
    return;
  }

  const grand = rows.reduce((s, r) => s + r.total, 0);
  totalEl.textContent = `共 ${grand} 次`;
  const max = rows[0].total;
  container.innerHTML = rows
    .slice(0, 8)
    .map(
      (r) => `
    <div class="tool-row" title="${escapeHtml(r.name)}：累積 ${r.total} 次，今日 ${r.today} 次">
      <span class="tool-name">${escapeHtml(displayToolName(r.name))}</span>
      <span class="tool-bar"><span class="tool-fill" style="width:${Math.max(2, Math.round((r.total / max) * 100))}%"></span></span>
      <span class="tool-count">${r.total}${r.today > 0 ? `（今日 ${r.today}）` : ""}</span>
    </div>`
    )
    .join("");
}

function renderHeatmap(daily: UsageDaily): void {
  const grid = buildHeatmap(daily, new Date());

  document.querySelector<HTMLElement>("#heatmap-headline")!.textContent =
    `過去一年累積輸出 ${formatTokens(grid.totalOutput)} tokens・活躍 ${grid.activeDays} 天`;

  const gridEl = document.querySelector<HTMLDivElement>("#heatmap-grid")!;
  gridEl.innerHTML = grid.weeks
    .map(
      (col) =>
        `<div class="heat-col">${col
          .map((cell) =>
            cell === null
              ? `<i class="heat-cell heat-future"></i>`
              : `<i class="heat-cell heat-${cell.level}" title="${cell.date}：輸出 ${formatTokens(cell.value)} tokens"></i>`
          )
          .join("")}</div>`
    )
    .join("");

  const COL_W = 13; // 11px 格 + 2px 間距
  document.querySelector<HTMLDivElement>("#heatmap-months")!.innerHTML = grid.monthLabels
    .map((m) => `<span style="left:${m.col * COL_W}px">${m.label}</span>`)
    .join("");

  // 預設捲到最新(右端)
  const scroll = document.querySelector<HTMLDivElement>(".heatmap-scroll")!;
  scroll.scrollLeft = scroll.scrollWidth;

  renderAchievements(daily);
}

const ACHIEVED_KEY = "cw-achieved";

/** 比對已達成清單,有新解鎖就放彩帶 + 通知;首次執行只記錄不慶祝 */
function celebrateNewAchievements(achieved: string[]): void {
  const stored = localStorage.getItem(ACHIEVED_KEY);
  if (stored === null) {
    localStorage.setItem(ACHIEVED_KEY, JSON.stringify(achieved));
    return;
  }
  let previous: string[];
  try {
    previous = JSON.parse(stored);
  } catch {
    previous = [];
  }
  const fresh = achieved.filter((a) => !previous.includes(a));
  if (fresh.length === 0) return;

  localStorage.setItem(ACHIEVED_KEY, JSON.stringify(achieved));
  launchConfetti();
  const names = fresh.map((f) => f.split(":")[1]).join("、");
  notify("🎉 新成就解鎖！", names);
}

function renderAchievements(daily: UsageDaily): void {
  const streak = computeStreak(daily, new Date());
  document.querySelector<HTMLElement>("#streak-current")!.textContent = `${streak.current} 天`;
  document.querySelector<HTMLElement>("#streak-longest")!.textContent = `${streak.longest} 天`;
  const best = document.querySelector<HTMLElement>("#streak-best")!;
  best.textContent = streak.bestDay ? formatTokens(streak.bestDay.value) : "—";
  best.title = streak.bestDay ? `${streak.bestDay.date}` : "";

  const allTimeOutput = lastSummary?.allTime.output_tokens ?? 0;
  const activeDays = [...Object.entries(daily)].filter(([, projects]) =>
    Object.values(projects).some((t) => t.output_tokens > 0)
  ).length;
  const tracks = computeMilestones(allTimeOutput, activeDays, streak.longest);

  celebrateNewAchievements(tracks.flatMap((t) => t.badges.filter((b) => b.achieved).map((b) => `${t.name}:${b.label}`)));

  document.querySelector<HTMLElement>("#milestones")!.innerHTML = tracks
    .map((track) => {
      const chips = track.badges
        .map(
          (b) =>
            `<span class="badge-chip ${b.achieved ? "achieved" : ""}">${b.achieved ? "✓ " : ""}${escapeHtml(b.label)}</span>`
        )
        .join("");
      const next = track.next
        ? `<div class="next-goal">
             <span class="next-label">下一個：${escapeHtml(track.next.label)}（${escapeHtml(track.next.detail)}）</span>
             <span class="progress-track"><span class="progress-fill" style="width:${Math.round(track.next.progress * 100)}%"></span></span>
           </div>`
        : `<div class="next-goal all-done">全部達成 🎉</div>`;
      return `<div class="milestone-track">
        <div class="milestone-name">${escapeHtml(track.name)}</div>
        <div class="badge-row">${chips}</div>
        ${next}
      </div>`;
    })
    .join("");
}

function renderStats(s: UsageSummary): void {
  const byId = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

  byId("tile-today").textContent = formatTokens(s.today.output_tokens);
  byId("tile-today").title = describeTotals(s.today);
  byId("tile-week").textContent = formatTokens(s.last7.output_tokens);
  byId("tile-week").title = describeTotals(s.last7);
  byId("tile-all").textContent = formatTokens(s.allTime.output_tokens);
  byId("tile-all").title = describeTotals(s.allTime);

  byId("cost-rows").innerHTML = MODEL_PRICING.map((p) => {
    const parts = [
      `輸入 ${formatUsd((s.allTime.input_tokens * p.input) / 1e6)}`,
      `輸出 ${formatUsd((s.allTime.output_tokens * p.output) / 1e6)}`,
      `快取寫入 ${formatUsd((s.allTime.cache_creation_input_tokens * p.cacheWrite) / 1e6)}`,
      `快取讀取 ${formatUsd((s.allTime.cache_read_input_tokens * p.cacheRead) / 1e6)}`,
    ].join("｜");
    return `
    <div class="cost-row" title="${escapeHtml(parts)}">
      <span class="cost-model">${escapeHtml(p.name)}</span>
      <span class="cost-rates">$${p.input}/$${p.output} per MTok</span>
      <span class="cost-value">${formatUsd(computeCostUsd(s.allTime, p))}</span>
    </div>`;
  }).join("");

  const max = Math.max(...s.days.map((d) => d.totals.output_tokens));
  byId("chart-max").textContent = max > 0 ? `峰值 ${formatTokens(max)}` : "";
  byId("usage-chart").innerHTML = s.days
    .map((d, i) => {
      const pct = max > 0 ? Math.round((d.totals.output_tokens / max) * 100) : 0;
      const h = d.totals.output_tokens > 0 ? Math.max(pct, 3) : 0;
      return `<div class="bar-slot" data-i="${i}"><div class="bar" style="height:${h}%"></div></div>`;
    })
    .join("");
  byId("axis-start").textContent = s.days[0].date.slice(5);
  byId("axis-end").textContent = s.days[13].date.slice(5);

  byId("project-rows").innerHTML = s.projects
    .map((p) => {
      const main = `
    <tr>
      <td class="project-name" title="${escapeHtml(p.project)}">${escapeHtml(p.project)}</td>
      <td>${formatTokens(p.today.output_tokens)}</td>
      <td title="${escapeHtml(describeTotals(p.allTime))}">${formatTokens(p.allTime.output_tokens)}</td>
    </tr>`;
      const recents = (lastRecent[p.project] ?? [])
        .slice(0, 3)
        .map(
          (r) => `
    <tr class="recent-row" title="session ${escapeHtml(r.session.slice(0, 8))}｜${escapeHtml(describeTotals(r.delta))}">
      <td class="recent-when">└ ${escapeHtml(r.when)}</td>
      <td colspan="2">輸出 ${formatTokens(r.delta.output_tokens)}｜快取讀 ${formatTokens(r.delta.cache_read_input_tokens)}</td>
    </tr>`
        )
        .join("");
      return main + recents;
    })
    .join("");

  const hasData = s.allTime.output_tokens > 0 || s.allTime.input_tokens > 0;
  byId("stats-empty").hidden = hasData;
}

function setupChartTooltip(): void {
  const chart = document.querySelector<HTMLDivElement>("#usage-chart")!;
  const tooltip = document.querySelector<HTMLDivElement>("#chart-tooltip")!;

  chart.addEventListener("mouseover", (e) => {
    const slot = (e.target as HTMLElement).closest<HTMLElement>(".bar-slot");
    if (!slot || !lastSummary) return;
    const day = lastSummary.days[Number(slot.dataset.i)];
    if (!day) return;
    tooltip.innerHTML =
      `<strong>${day.date}</strong><br>` +
      `輸出 ${formatTokens(day.totals.output_tokens)}<br>` +
      `輸入 ${formatTokens(day.totals.input_tokens)}<br>` +
      `快取讀取 ${formatTokens(day.totals.cache_read_input_tokens)}`;
    tooltip.hidden = false;
    const chartRect = chart.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    const left = slotRect.left - chartRect.left + slotRect.width / 2;
    tooltip.style.left = `${Math.min(Math.max(left, 60), chartRect.width - 60)}px`;
  });
  chart.addEventListener("mouseleave", () => {
    tooltip.hidden = true;
  });
}

type ViewName = "sessions" | "stats" | "activity" | "settings";
let currentView: ViewName = "sessions";

function showView(view: ViewName): void {
  currentView = view;
  for (const name of ["sessions", "stats", "activity", "settings"] as const) {
    document.querySelector<HTMLElement>(`#view-${name}`)!.hidden = name !== view;
  }
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === view);
  });
  document.querySelector<HTMLElement>("#btn-settings")!.classList.toggle("active", view === "settings");
  if (view === "stats" || view === "activity") void loadUsage();
}

function setupTabs(): void {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view as ViewName));
  });
  document.querySelector<HTMLButtonElement>("#btn-settings")!.addEventListener("click", () => {
    showView(currentView === "settings" ? "sessions" : "settings");
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  await initNotification();
  setupTabs();
  setupSettings();
  setupMiniMode();
  setupJumpToSession();
  setupChartTooltip();
  applyAlwaysOnTop();

  store.onChange(render);
  render();
  void loadUsage();

  await listen<HookEvent>("claude-event", (event) => {
    const notice = store.apply(event.payload);
    if (!notice) return;
    if (event.payload.hook_event_name === "Notification") {
      if (settings.notifyWaiting) {
        scheduleWaitingToast(event.payload.session_id, notice.title, notice.body);
      }
    } else if (event.payload.hook_event_name === "PreToolUse") {
      // 選項提問(AskUserQuestion)必定需要人回答,立即通知、不套延遲確認
      if (settings.notifyWaiting) {
        notify(notice.title, notice.body, "waiting");
      }
    } else if (settings.notifyDone) {
      notify(notice.title, notice.body, "done");
    }
  });

  await listen("usage-updated", () => void loadUsage());

  // 每秒重繪（更新 working 經過時間），每分鐘清一次殘留 session
  setInterval(render, 1000);
  setInterval(() => store.sweep(), 60 * 1000);
});
