import { describe, expect, it } from "vitest";
import {
  aggregateTools,
  buildHeatmap,
  computeMilestones,
  computeStreak,
  displayToolName,
  EMPTY_TOTALS,
  formatTokens,
  heatLevel,
  lastNDays,
  summarize,
  type TokenTotals,
  type UsageDaily,
} from "./usageStats";

function t(output: number): TokenTotals {
  return { ...EMPTY_TOTALS, output_tokens: output };
}

const NOW = new Date(2026, 6, 9, 12, 0, 0); // 2026-07-09 本地時間

describe("usageStats", () => {
  it("lastNDays 產生連續本地日期(含跨月)", () => {
    expect(lastNDays(3, NOW)).toEqual(["2026-07-07", "2026-07-08", "2026-07-09"]);
    expect(lastNDays(2, new Date(2026, 7, 1))).toEqual(["2026-07-31", "2026-08-01"]);
  });

  it("summarize 計算今日/近7日/累積與專案排行", () => {
    const daily: UsageDaily = {
      "2026-07-01": { ProjA: t(100) }, // 7 天窗外
      "2026-07-05": { ProjA: t(10), ProjB: t(50) },
      "2026-07-09": { ProjA: t(30) },
    };
    const s = summarize(daily, NOW);

    expect(s.today.output_tokens).toBe(30);
    expect(s.last7.output_tokens).toBe(90);
    expect(s.allTime.output_tokens).toBe(190);

    expect(s.days).toHaveLength(14);
    expect(s.days[13]).toEqual({ date: "2026-07-09", totals: t(30) });
    expect(s.days[0].totals).toEqual(EMPTY_TOTALS); // 無資料補零

    expect(s.projects.map((p) => p.project)).toEqual(["ProjA", "ProjB"]);
    expect(s.projects[0].allTime.output_tokens).toBe(140);
    expect(s.projects[0].today.output_tokens).toBe(30);
    expect(s.projects[1].today.output_tokens).toBe(0);
  });

  it("heatLevel 依個人峰值分四級", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(10, 100)).toBe(1);
    expect(heatLevel(40, 100)).toBe(2);
    expect(heatLevel(75, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
    expect(heatLevel(5, 0)).toBe(0); // 無資料不除以零
  });

  it("buildHeatmap 產生週欄格線,今天在最後一欄,未來為 null", () => {
    // 2026-07-09 是週四
    const daily: UsageDaily = {
      "2026-07-09": { ProjA: t(100) },
      "2026-07-06": { ProjA: t(25) }, // 本週一
      "2026-01-01": { ProjB: t(50) },
    };
    const grid = buildHeatmap(daily, NOW, 52);

    expect(grid.weeks).toHaveLength(52);
    const lastWeek = grid.weeks[51];
    expect(lastWeek[0]?.date).toBe("2026-07-06"); // 週一
    expect(lastWeek[0]?.level).toBe(1); // 25/100
    expect(lastWeek[3]?.date).toBe("2026-07-09"); // 週四 = 今天
    expect(lastWeek[3]?.level).toBe(4);
    expect(lastWeek[4]).toBeNull(); // 週五還沒到
    expect(lastWeek[6]).toBeNull();

    expect(grid.totalOutput).toBe(175);
    expect(grid.activeDays).toBe(3);
    // 每欄進入新月份時有標籤,一年約 12~13 個
    expect(grid.monthLabels.length).toBeGreaterThanOrEqual(12);
    expect(grid.monthLabels[grid.monthLabels.length - 1].label).toBe("7月");
  });

  it("computeStreak 計算目前/最長連續與單日峰值", () => {
    const daily: UsageDaily = {
      "2026-07-01": { A: t(10) },
      "2026-07-02": { A: t(20) },
      "2026-07-03": { A: t(30) }, // 3 天連續(最長)
      "2026-07-08": { A: t(99) },
      "2026-07-09": { A: t(5) }, // 今天,目前連續 2 天
    };
    const s = computeStreak(daily, NOW);
    expect(s.current).toBe(2);
    expect(s.longest).toBe(3);
    expect(s.bestDay).toEqual({ date: "2026-07-08", value: 99 });
  });

  it("computeStreak 今天還沒活動時從昨天回算,輸出為零的日子不算活躍", () => {
    const daily: UsageDaily = {
      "2026-07-07": { A: t(10) },
      "2026-07-08": { A: t(10) },
      "2026-07-09": { A: t(0) }, // 今天有紀錄但輸出 0
    };
    const s = computeStreak(daily, NOW);
    expect(s.current).toBe(2);

    expect(computeStreak({}, NOW)).toEqual({ current: 0, longest: 0, bestDay: null });
  });

  it("computeMilestones 標記達成與下一目標進度", () => {
    const tracks = computeMilestones(340_000, 8, 3);

    const output = tracks[0];
    expect(output.badges[0]).toMatchObject({ label: "輸出 100k", achieved: true, progress: 1 });
    expect(output.next).toMatchObject({ label: "輸出 1M", achieved: false });
    expect(output.next!.progress).toBeCloseTo(0.34);

    const days = tracks[1];
    expect(days.badges[0].achieved).toBe(true); // 活躍 7 天
    expect(days.next!.label).toBe("活躍 30 天");

    const streak = tracks[2];
    expect(streak.badges[0].achieved).toBe(true); // 連續 3 天
    expect(streak.next!.label).toBe("連續 7 天");

    // 全數達成 → next 為 null
    expect(computeMilestones(1e9, 999, 99)[0].next).toBeNull();
  });

  it("aggregateTools 跨日加總、今日分開計、依累積排序", () => {
    const rows = aggregateTools(
      {
        "2026-07-08": { Bash: 10, Edit: 3 },
        "2026-07-09": { Bash: 5, Read: 7 },
      },
      "2026-07-09"
    );
    expect(rows.map((r) => r.name)).toEqual(["Bash", "Read", "Edit"]);
    expect(rows[0]).toEqual({ name: "Bash", total: 15, today: 5 });
    expect(rows[2]).toEqual({ name: "Edit", total: 3, today: 0 });
  });

  it("displayToolName 縮短 MCP 名稱", () => {
    expect(displayToolName("Bash")).toBe("Bash");
    expect(displayToolName("mcp__UnityMCP__manage_scene")).toBe("UnityMCP:manage_scene");
  });

  it("formatTokens 千/百萬縮寫", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.23k");
    expect(formatTokens(73228)).toBe("73.2k");
    expect(formatTokens(7802080)).toBe("7.80M");
  });
});
