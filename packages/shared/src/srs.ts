import type { Card, ReviewRating } from "./types.js";

export interface ReviewScheduleResult {
  easeFactor: number;
  intervalDays: number;
  dueAt: string;
  lapseCount: number;
  reviewCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createInitialSchedule(now = new Date()): ReviewScheduleResult {
  return {
    easeFactor: 2.5,
    intervalDays: 0,
    dueAt: now.toISOString(),
    lapseCount: 0,
    reviewCount: 0
  };
}

export function applyReview(
  card: Pick<Card, "easeFactor" | "intervalDays" | "lapseCount" | "reviewCount">,
  rating: ReviewRating,
  now = new Date()
): ReviewScheduleResult {
  const previousEase = clamp(card.easeFactor || 2.5, 1.3, 3.2);
  const previousInterval = Math.max(0, card.intervalDays || 0);
  const reviewCount = (card.reviewCount || 0) + 1;

  let easeFactor = previousEase;
  let intervalDays = previousInterval;
  let lapseCount = card.lapseCount || 0;

  if (rating === "again") {
    easeFactor = clamp(previousEase - 0.25, 1.3, 3.2);
    intervalDays = 0;
    lapseCount += 1;
  } else if (rating === "hard") {
    easeFactor = clamp(previousEase - 0.1, 1.3, 3.2);
    intervalDays = previousInterval <= 1 ? 1 : Math.max(1, Math.ceil(previousInterval * 1.2));
  } else if (rating === "good") {
    intervalDays = nextNormalInterval(previousInterval, previousEase);
  } else {
    easeFactor = clamp(previousEase + 0.15, 1.3, 3.2);
    intervalDays = Math.max(3, Math.ceil(nextNormalInterval(previousInterval, easeFactor) * 1.35));
  }

  const dueAt = new Date(now.getTime() + intervalDays * DAY_MS).toISOString();

  return {
    easeFactor,
    intervalDays,
    dueAt,
    lapseCount,
    reviewCount
  };
}

function nextNormalInterval(previousInterval: number, easeFactor: number): number {
  if (previousInterval <= 0) return 1;
  if (previousInterval === 1) return 3;
  return Math.max(2, Math.ceil(previousInterval * easeFactor));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(2))));
}
