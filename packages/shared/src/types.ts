export type ReviewRating = "again" | "hard" | "good" | "easy";

export interface SyncMetadata {
  id: string;
  deviceId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  lastSyncedAt: string | null;
}

export interface Word extends SyncMetadata {
  word: string;
  normalized: string;
  phonetic: string;
  tags: string[];
  source: string;
  definitionZh: string;
  definitionEn: string;
  example: string;
  audioFile: string;
  audioMissing: boolean;
}

export interface WordInput {
  word: string;
  phonetic?: string;
  definitionZh?: string;
  definitionEn?: string;
  example?: string;
  tags?: string[];
  audioFile?: string;
  source?: string;
}

export interface Card extends SyncMetadata {
  wordId: string;
  deckId: string;
  easeFactor: number;
  intervalDays: number;
  dueAt: string;
  lapseCount: number;
  reviewCount: number;
}

export interface ReviewLog {
  id: string;
  cardId: string;
  wordId: string;
  rating: ReviewRating;
  reviewedAt: string;
  previousIntervalDays: number;
  nextIntervalDays: number;
  previousEaseFactor: number;
  nextEaseFactor: number;
  deviceId: string;
}

export interface DueCard {
  card: Card;
  word: Word;
}

export interface LearningStats {
  totalWords: number;
  dueCards: number;
  reviewedToday: number;
  retentionRate: number;
  streakDays: number;
  missingAudio: number;
}

export interface CsvImportIssue {
  row: number;
  word?: string;
  message: string;
}

export interface CsvImportReport {
  created: number;
  updated: number;
  skipped: number;
  missingAudio: number;
  issues: CsvImportIssue[];
}

export interface SyncChange {
  id: string;
  entityType: string;
  entityId: string;
  operation: "create" | "update" | "delete" | "review";
  payload: unknown;
  deviceId: string;
  version: number;
  createdAt: string;
}

export interface PairingResponse {
  deviceId: string;
  token: string;
  pairedAt: string;
}

export interface ResourcePack {
  id: string;
  name: string;
  version: string;
  sources: string[];
  licenses: string[];
  wordCount: number;
  audioCount: number;
  createdAt: string;
}
