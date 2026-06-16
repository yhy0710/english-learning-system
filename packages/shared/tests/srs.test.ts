import { describe, expect, it } from "vitest";
import { applyReview, createInitialSchedule } from "../src/srs";

describe("SRS schedule", () => {
  it("starts with a due card", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    expect(createInitialSchedule(now)).toMatchObject({
      easeFactor: 2.5,
      intervalDays: 0,
      dueAt: now.toISOString(),
      lapseCount: 0,
      reviewCount: 0
    });
  });

  it("pushes a good review forward", () => {
    const result = applyReview(
      { easeFactor: 2.5, intervalDays: 0, lapseCount: 0, reviewCount: 0 },
      "good",
      new Date("2026-06-15T00:00:00.000Z")
    );

    expect(result.intervalDays).toBe(1);
    expect(result.reviewCount).toBe(1);
    expect(result.dueAt).toBe("2026-06-16T00:00:00.000Z");
  });

  it("keeps failed reviews short and records lapses", () => {
    const result = applyReview(
      { easeFactor: 2.5, intervalDays: 7, lapseCount: 0, reviewCount: 2 },
      "again",
      new Date("2026-06-15T00:00:00.000Z")
    );

    expect(result.intervalDays).toBe(0);
    expect(result.lapseCount).toBe(1);
    expect(result.reviewCount).toBe(3);
    expect(result.easeFactor).toBeLessThan(2.5);
  });
});
