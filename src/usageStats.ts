// 用量統計的純計算層:把 Rust 端的 daily 資料整理成統計頁要的形狀。

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** 日期(YYYY-MM-DD) → 專案 → 當日累積 */
export type UsageDaily = Record<string, Record<string, TokenTotals>>;

export const EMPTY_TOTALS: TokenTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  };
}

/** 本地時區的 YYYY-MM-DD(與 Rust 端 today_local 對齊) */
export function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function lastNDays(n: number, today: Date): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(dateKey(d));
  }
  return days;
}

function dayTotal(daily: UsageDaily, date: string): TokenTotals {
  return Object.values(daily[date] ?? {}).reduce(addTotals, EMPTY_TOTALS);
}

export interface UsageSummary {
  today: TokenTotals;
  last7: TokenTotals;
  allTime: TokenTotals;
  /** 近 14 天,由舊到新,無資料的日期補零 */
  days: { date: string; totals: TokenTotals }[];
  /** 依累積輸出量排序(大→小) */
  projects: { project: string; today: TokenTotals; allTime: TokenTotals }[];
}

export function summarize(daily: UsageDaily, now: Date): UsageSummary {
  const todayKey = dateKey(now);
  const week = new Set(lastNDays(7, now));

  let last7 = EMPTY_TOTALS;
  let allTime = EMPTY_TOTALS;
  const byProject = new Map<string, { today: TokenTotals; allTime: TokenTotals }>();

  for (const [date, projects] of Object.entries(daily)) {
    for (const [project, totals] of Object.entries(projects)) {
      allTime = addTotals(allTime, totals);
      if (week.has(date)) last7 = addTotals(last7, totals);

      const row = byProject.get(project) ?? { today: EMPTY_TOTALS, allTime: EMPTY_TOTALS };
      row.allTime = addTotals(row.allTime, totals);
      if (date === todayKey) row.today = addTotals(row.today, totals);
      byProject.set(project, row);
    }
  }

  return {
    today: dayTotal(daily, todayKey),
    last7,
    allTime,
    days: lastNDays(14, now).map((date) => ({ date, totals: dayTotal(daily, date) })),
    projects: [...byProject.entries()]
      .map(([project, row]) => ({ project, ...row }))
      .sort((a, b) => b.allTime.output_tokens - a.allTime.output_tokens),
  };
}

// ---- 活動熱力圖(GitHub 風格) ----

export interface HeatCell {
  date: string;
  value: number;
  /** 0 = 無活動,1~4 = 相對個人峰值的四分位強度 */
  level: number;
}

export interface HeatmapGrid {
  /** 週為欄(舊→新),每欄 7 格(週一~週日);未來的日期為 null */
  weeks: (HeatCell | null)[][];
  /** 欄索引 → 月份標籤(該欄進入新的月份時) */
  monthLabels: { col: number; label: string }[];
  totalOutput: number;
  activeDays: number;
}

export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const r = value / max;
  if (r <= 0.25) return 1;
  if (r <= 0.5) return 2;
  if (r <= 0.75) return 3;
  return 4;
}

/** 過去 weeks 週(含本週)的活動格線,以每日輸出 tokens 為強度 */
export function buildHeatmap(daily: UsageDaily, now: Date, weeksCount = 52): HeatmapGrid {
  const dayValue = new Map<string, number>();
  let totalOutput = 0;
  for (const [date, projects] of Object.entries(daily)) {
    const v = Object.values(projects).reduce((sum, t) => sum + t.output_tokens, 0);
    dayValue.set(date, v);
    totalOutput += v;
  }
  const max = Math.max(0, ...dayValue.values());

  // 本週的週一
  const monday = new Date(now);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));

  const todayKey = dateKey(now);
  const weeks: (HeatCell | null)[][] = [];
  const monthLabels: { col: number; label: string }[] = [];
  let lastMonth = -1;

  for (let w = weeksCount - 1; w >= 0; w--) {
    const col: (HeatCell | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(monday);
      day.setDate(day.getDate() - w * 7 + d);
      const key = dateKey(day);
      if (key > todayKey) {
        col.push(null);
        continue;
      }
      const value = dayValue.get(key) ?? 0;
      col.push({ date: key, value, level: heatLevel(value, max) });
    }
    const first = col.find((c) => c !== null);
    if (first) {
      const month = Number(first.date.slice(5, 7));
      if (month !== lastMonth) {
        monthLabels.push({ col: weeks.length, label: `${month}月` });
        lastMonth = month;
      }
    }
    weeks.push(col);
  }

  return {
    weeks,
    monthLabels,
    totalOutput,
    activeDays: [...dayValue.values()].filter((v) => v > 0).length,
  };
}

// ---- 工具使用分析 ----

/** 日期 → 工具名稱 → 次數(Rust 端 tools 欄位) */
export type ToolsDaily = Record<string, Record<string, number>>;

export interface ToolRow {
  name: string;
  total: number;
  today: number;
}

export function aggregateTools(tools: ToolsDaily, todayKey: string): ToolRow[] {
  const map = new Map<string, ToolRow>();
  for (const [date, counts] of Object.entries(tools)) {
    for (const [name, count] of Object.entries(counts)) {
      const row = map.get(name) ?? { name, total: 0, today: 0 };
      row.total += count;
      if (date === todayKey) row.today += count;
      map.set(name, row);
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/** MCP 工具名稱縮短:mcp__UnityMCP__manage_scene → UnityMCP:manage_scene */
export function displayToolName(name: string): string {
  return name.startsWith("mcp__") ? name.slice(5).replace("__", ":") : name;
}

// ---- 連續紀錄與里程碑 ----

export interface StreakInfo {
  /** 目前連續活躍天數(今天還沒動工時,從昨天往回算) */
  current: number;
  longest: number;
  bestDay: { date: string; value: number } | null;
}

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function computeStreak(daily: UsageDaily, now: Date): StreakInfo {
  const active = new Set<string>();
  let bestDay: StreakInfo["bestDay"] = null;
  for (const [date, projects] of Object.entries(daily)) {
    const v = Object.values(projects).reduce((s, t) => s + t.output_tokens, 0);
    if (v <= 0) continue;
    active.add(date);
    if (!bestDay || v > bestDay.value) bestDay = { date, value: v };
  }

  let current = 0;
  const cursor = new Date(now);
  if (!active.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(dateKey(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }

  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of [...active].sort()) {
    const day = parseKey(key);
    run = prev !== null && day.getTime() - prev.getTime() === 86_400_000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }

  return { current, longest, bestDay };
}

export interface Milestone {
  label: string;
  achieved: boolean;
  /** 0~1,達成即 1 */
  progress: number;
}

export interface MilestoneTrack {
  name: string;
  badges: Milestone[];
  /** 第一個未達成的目標;全數達成則為 null */
  next: (Milestone & { detail: string }) | null;
}

/** 門檻整數專用標籤:100k、1M、10M(formatTokens 會帶小數,不適合) */
function tierLabel(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1_000}k`;
}

const OUTPUT_TIERS = [100_000, 1_000_000, 10_000_000, 100_000_000];
const ACTIVE_DAY_TIERS = [7, 30, 100, 365];
const STREAK_TIERS = [3, 7, 14, 30];

function buildTrack(
  name: string,
  value: number,
  tiers: number[],
  label: (threshold: number) => string,
  detail: (value: number, threshold: number) => string
): MilestoneTrack {
  const badges = tiers.map((threshold) => ({
    label: label(threshold),
    achieved: value >= threshold,
    progress: Math.min(1, value / threshold),
  }));
  const first = badges.find((b) => !b.achieved);
  const next = first
    ? { ...first, detail: detail(value, tiers[badges.indexOf(first)]) }
    : null;
  return { name, badges, next };
}

export function computeMilestones(
  allTimeOutput: number,
  activeDays: number,
  longestStreak: number
): MilestoneTrack[] {
  return [
    buildTrack(
      "累積輸出",
      allTimeOutput,
      OUTPUT_TIERS,
      (t) => `輸出 ${tierLabel(t)}`,
      (v, t) => `${formatTokens(v)} / ${tierLabel(t)}`
    ),
    buildTrack(
      "活躍天數",
      activeDays,
      ACTIVE_DAY_TIERS,
      (t) => `活躍 ${t} 天`,
      (v, t) => `${v} / ${t} 天`
    ),
    buildTrack(
      "連續紀錄",
      longestStreak,
      STREAK_TIERS,
      (t) => `連續 ${t} 天`,
      (v, t) => `最長 ${v} / ${t} 天`
    ),
  ];
}

// ---- API 等值花費換算 ----

/** USD / 每百萬 tokens。寫死的時價(2026-07 查表);快取寫入採 5 分鐘 TTL 價(輸入 1.25 倍)、讀取為輸入 0.1 倍 */
export interface ModelPricing {
  name: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const MODEL_PRICING: ModelPricing[] = [
  { name: "Fable 5", input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  { name: "Opus 4.8", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
];

export function computeCostUsd(t: TokenTotals, p: ModelPricing): number {
  return (
    (t.input_tokens * p.input +
      t.output_tokens * p.output +
      t.cache_creation_input_tokens * p.cacheWrite +
      t.cache_read_input_tokens * p.cacheRead) /
    1_000_000
  );
}

export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 12,345 → "12.3k"、7,802,080 → "7.80M" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
