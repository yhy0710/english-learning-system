import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyReview,
  createInitialSchedule,
  normalizeTags,
  normalizeWord,
  parseWordCsv,
  wordInputFromCsvRow,
  wordsToCsvRows,
  type Card,
  type CsvImportReport,
  type DueCard,
  type LearningStats,
  type PairingResponse,
  type ResourcePack,
  type ReviewRating,
  type SyncChange,
  type Word,
  type WordInput
} from "@els/shared";

interface DatabaseOptions {
  dbFile: string;
  assetsDir: string;
  deviceId?: string;
}

type Row = Record<string, unknown>;

export class LearningDatabase {
  readonly db: DatabaseSync;
  readonly assetsDir: string;
  readonly deviceId: string;

  constructor(options: DatabaseOptions) {
    const dbFile = resolve(options.dbFile);
    this.assetsDir = resolve(options.assetsDir);
    this.deviceId = options.deviceId ?? `server-${createHash("sha1").update(dbFile).digest("hex").slice(0, 10)}`;

    mkdirSync(dirname(dbFile), { recursive: true });
    mkdirSync(this.assetsDir, { recursive: true });

    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
    this.seedDefaults();
  }

  close(): void {
    this.db.close();
  }

  listWords(search = ""): Word[] {
    const query = `%${search.trim().toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `
        SELECT w.*, s.definition_zh, s.definition_en, s.example, a.file_path AS audio_file, a.missing AS audio_missing
        FROM words w
        LEFT JOIN word_senses s ON s.word_id = w.id AND s.deleted_at IS NULL
        LEFT JOIN audio_assets a ON a.word_id = w.id AND a.deleted_at IS NULL
        WHERE w.deleted_at IS NULL
          AND (? = '%%' OR w.normalized LIKE ? OR w.word LIKE ? OR s.definition_zh LIKE ? OR s.definition_en LIKE ?)
        ORDER BY w.updated_at DESC
        LIMIT 500
      `
      )
      .all(query, query, query, query, query) as Row[];

    return rows.map(rowToWord);
  }

  getWord(id: string): Word | null {
    const row = this.db
      .prepare(
        `
        SELECT w.*, s.definition_zh, s.definition_en, s.example, a.file_path AS audio_file, a.missing AS audio_missing
        FROM words w
        LEFT JOIN word_senses s ON s.word_id = w.id AND s.deleted_at IS NULL
        LEFT JOIN audio_assets a ON a.word_id = w.id AND a.deleted_at IS NULL
        WHERE w.id = ? AND w.deleted_at IS NULL
      `
      )
      .get(id) as Row | undefined;

    return row ? rowToWord(row) : null;
  }

  createWord(input: WordInput): Word {
    const normalized = normalizeWord(input.word);
    if (!normalized) throw new Error("word is required");

    const existing = this.db
      .prepare("SELECT id FROM words WHERE normalized = ? AND deleted_at IS NULL")
      .get(normalized) as { id: string } | undefined;

    if (existing) return this.updateWord(existing.id, input);

    const now = timestamp();
    const wordId = randomUUID();
    const senseId = randomUUID();
    const cardId = randomUUID();
    const deckId = this.defaultDeckId();
    const schedule = createInitialSchedule(new Date(now));

    this.db
      .prepare(
        `
        INSERT INTO words (id, word, normalized, phonetic, tags, source, device_id, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `
      )
      .run(
        wordId,
        input.word.trim(),
        normalized,
        input.phonetic?.trim() ?? "",
        JSON.stringify(normalizeTags(input.tags)),
        input.source ?? "manual",
        this.deviceId,
        now,
        now
      );

    this.db
      .prepare(
        `
        INSERT INTO word_senses (id, word_id, definition_zh, definition_en, example, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        senseId,
        wordId,
        input.definitionZh?.trim() ?? "",
        input.definitionEn?.trim() ?? "",
        input.example?.trim() ?? "",
        input.source ?? "manual",
        now,
        now
      );

    this.upsertAudioAsset(wordId, input.audioFile ?? "", input.source ?? "manual", now);

    this.db
      .prepare(
        `
        INSERT INTO cards (
          id, word_id, deck_id, ease_factor, interval_days, due_at, lapse_count, review_count,
          device_id, created_at, updated_at, version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `
      )
      .run(
        cardId,
        wordId,
        deckId,
        schedule.easeFactor,
        schedule.intervalDays,
        schedule.dueAt,
        schedule.lapseCount,
        schedule.reviewCount,
        this.deviceId,
        now,
        now
      );

    const word = this.getWord(wordId);
    if (!word) throw new Error("created word was not found");
    this.recordOperation("words", wordId, "create", word);
    return word;
  }

  updateWord(id: string, input: Partial<WordInput>): Word {
    const current = this.getWord(id);
    if (!current) throw new Error("word not found");

    const nextWord = input.word?.trim() || current.word;
    const now = timestamp();
    const tags = input.tags === undefined ? current.tags : normalizeTags(input.tags);

    this.db
      .prepare(
        `
        UPDATE words
        SET word = ?, normalized = ?, phonetic = ?, tags = ?, source = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND deleted_at IS NULL
      `
      )
      .run(
        nextWord,
        normalizeWord(nextWord),
        input.phonetic ?? current.phonetic,
        JSON.stringify(tags),
        input.source ?? current.source,
        now,
        id
      );

    this.db
      .prepare(
        `
        UPDATE word_senses
        SET definition_zh = ?, definition_en = ?, example = ?, source = ?, updated_at = ?
        WHERE word_id = ? AND deleted_at IS NULL
      `
      )
      .run(
        input.definitionZh ?? current.definitionZh,
        input.definitionEn ?? current.definitionEn,
        input.example ?? current.example,
        input.source ?? current.source,
        now,
        id
      );

    if (input.audioFile !== undefined) {
      this.upsertAudioAsset(id, input.audioFile, input.source ?? current.source, now);
    }

    const word = this.getWord(id);
    if (!word) throw new Error("updated word was not found");
    this.recordOperation("words", id, "update", word);
    return word;
  }

  deleteWord(id: string): void {
    const now = timestamp();
    this.db.prepare("UPDATE words SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now, now, id);
    this.db.prepare("UPDATE cards SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE word_id = ?").run(now, now, id);
    this.recordOperation("words", id, "delete", { id, deletedAt: now });
  }

  importCsv(text: string): CsvImportReport {
    const rows = parseWordCsv(text);
    const report: CsvImportReport = {
      created: 0,
      updated: 0,
      skipped: 0,
      missingAudio: 0,
      issues: []
    };

    rows.forEach((row, index) => {
      const input = wordInputFromCsvRow(row);
      if (!input.word.trim()) {
        report.skipped += 1;
        report.issues.push({ row: index + 2, message: "word is required" });
        return;
      }

      const existing = this.db
        .prepare("SELECT id FROM words WHERE normalized = ? AND deleted_at IS NULL")
        .get(normalizeWord(input.word)) as { id: string } | undefined;

      const word = existing ? this.updateWord(existing.id, input) : this.createWord(input);
      if (existing) report.updated += 1;
      else report.created += 1;
      if (word.audioMissing) {
        report.missingAudio += 1;
        report.issues.push({ row: index + 2, word: word.word, message: "audio file is missing" });
      }
    });

    return report;
  }

  exportCsv(): string {
    return wordsToCsvRows(
      this.listWords("").map((word) => ({
        word: word.word,
        phonetic: word.phonetic,
        definitionZh: word.definitionZh,
        definitionEn: word.definitionEn,
        example: word.example,
        tags: word.tags,
        audioFile: word.audioFile
      }))
    );
  }

  dueCards(limit = 20): DueCard[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          c.id AS card_id, c.word_id, c.deck_id, c.ease_factor, c.interval_days, c.due_at,
          c.lapse_count, c.review_count, c.device_id AS card_device_id, c.created_at AS card_created_at,
          c.updated_at AS card_updated_at, c.deleted_at AS card_deleted_at, c.version AS card_version,
          w.*, s.definition_zh, s.definition_en, s.example, a.file_path AS audio_file, a.missing AS audio_missing
        FROM cards c
        JOIN words w ON w.id = c.word_id
        LEFT JOIN word_senses s ON s.word_id = w.id AND s.deleted_at IS NULL
        LEFT JOIN audio_assets a ON a.word_id = w.id AND a.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND w.deleted_at IS NULL AND c.due_at <= ?
        ORDER BY c.due_at ASC
        LIMIT ?
      `
      )
      .all(timestamp(), limit) as Row[];

    return rows.map((row) => ({
      card: rowToCard(row),
      word: rowToWord(row)
    }));
  }

  reviewCard(cardId: string, rating: ReviewRating): DueCard {
    const row = this.db
      .prepare(
        `
        SELECT
          c.id AS card_id, c.word_id, c.deck_id, c.ease_factor, c.interval_days, c.due_at,
          c.lapse_count, c.review_count, c.device_id AS card_device_id, c.created_at AS card_created_at,
          c.updated_at AS card_updated_at, c.deleted_at AS card_deleted_at, c.version AS card_version,
          w.*, s.definition_zh, s.definition_en, s.example, a.file_path AS audio_file, a.missing AS audio_missing
        FROM cards c
        JOIN words w ON w.id = c.word_id
        LEFT JOIN word_senses s ON s.word_id = w.id AND s.deleted_at IS NULL
        LEFT JOIN audio_assets a ON a.word_id = w.id AND a.deleted_at IS NULL
        WHERE c.id = ? AND c.deleted_at IS NULL AND w.deleted_at IS NULL
      `
      )
      .get(cardId) as Row | undefined;

    if (!row) throw new Error("card not found");

    const card = rowToCard(row);
    const word = rowToWord(row);
    const now = timestamp();
    const next = applyReview(card, rating, new Date(now));
    const logId = randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO review_logs (
          id, card_id, word_id, rating, reviewed_at, previous_interval_days, next_interval_days,
          previous_ease_factor, next_ease_factor, device_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        logId,
        card.id,
        word.id,
        rating,
        now,
        card.intervalDays,
        next.intervalDays,
        card.easeFactor,
        next.easeFactor,
        this.deviceId
      );

    this.db
      .prepare(
        `
        UPDATE cards
        SET ease_factor = ?, interval_days = ?, due_at = ?, lapse_count = ?, review_count = ?,
            updated_at = ?, version = version + 1
        WHERE id = ?
      `
      )
      .run(next.easeFactor, next.intervalDays, next.dueAt, next.lapseCount, next.reviewCount, now, card.id);

    this.recordOperation("review_logs", logId, "review", {
      id: logId,
      cardId: card.id,
      wordId: word.id,
      rating,
      reviewedAt: now,
      next
    });

    const updated = this.dueCardById(card.id);
    return updated ?? { card: { ...card, ...next, updatedAt: now, version: card.version + 1 }, word };
  }

  stats(): LearningStats {
    const totalWords = scalarNumber(this.db.prepare("SELECT COUNT(*) AS value FROM words WHERE deleted_at IS NULL").get());
    const dueCards = scalarNumber(
      this.db.prepare("SELECT COUNT(*) AS value FROM cards WHERE deleted_at IS NULL AND due_at <= ?").get(timestamp())
    );
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const reviewedToday = scalarNumber(
      this.db.prepare("SELECT COUNT(*) AS value FROM review_logs WHERE reviewed_at LIKE ?").get(`${todayPrefix}%`)
    );
    const positiveToday = scalarNumber(
      this.db
        .prepare("SELECT COUNT(*) AS value FROM review_logs WHERE reviewed_at LIKE ? AND rating IN ('good', 'easy')")
        .get(`${todayPrefix}%`)
    );
    const missingAudio = scalarNumber(
      this.db.prepare("SELECT COUNT(*) AS value FROM audio_assets WHERE deleted_at IS NULL AND missing = 1").get()
    );

    return {
      totalWords,
      dueCards,
      reviewedToday,
      retentionRate: reviewedToday === 0 ? 0 : Math.round((positiveToday / reviewedToday) * 100),
      streakDays: this.streakDays(),
      missingAudio
    };
  }

  pairDevice(deviceName: string): PairingResponse {
    const id = randomUUID();
    const token = randomBytes(24).toString("hex");
    const now = timestamp();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    this.db
      .prepare("INSERT INTO sync_devices (id, device_name, token_hash, paired_at, last_sync_at) VALUES (?, ?, ?, ?, NULL)")
      .run(id, deviceName || "Android Device", tokenHash, now);
    return { deviceId: id, token, pairedAt: now };
  }

  changes(since = 0): { cursor: number; changes: SyncChange[] } {
    const rows = this.db
      .prepare("SELECT * FROM sync_operations WHERE seq > ? ORDER BY seq ASC LIMIT 500")
      .all(since) as Row[];
    const cursor = rows.length ? Number(rows[rows.length - 1].seq) : since;
    return {
      cursor,
      changes: rows.map((row) => ({
        id: String(row.id),
        entityType: String(row.entity_type),
        entityId: String(row.entity_id),
        operation: row.operation as SyncChange["operation"],
        payload: JSON.parse(String(row.payload)),
        deviceId: String(row.device_id),
        version: Number(row.version),
        createdAt: String(row.created_at)
      }))
    };
  }

  applyChanges(changes: SyncChange[]): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;

    for (const change of changes) {
      const exists = this.db.prepare("SELECT id FROM sync_operations WHERE id = ?").get(change.id);
      if (exists) {
        skipped += 1;
        continue;
      }
      this.db
        .prepare(
          `
          INSERT INTO sync_operations (id, entity_type, entity_id, operation, payload, device_id, version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          change.id,
          change.entityType,
          change.entityId,
          change.operation,
          JSON.stringify(change.payload),
          change.deviceId,
          change.version,
          change.createdAt
        );
      applied += 1;
    }

    return { applied, skipped };
  }

  listResourcePacks(): ResourcePack[] {
    const rows = this.db.prepare("SELECT * FROM resource_packs ORDER BY created_at DESC").all() as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      version: String(row.version),
      sources: parseJsonArray(row.sources),
      licenses: parseJsonArray(row.licenses),
      wordCount: Number(row.word_count),
      audioCount: Number(row.audio_count),
      createdAt: String(row.created_at)
    }));
  }

  addResourcePack(input: Omit<ResourcePack, "id" | "createdAt">): ResourcePack {
    const pack: ResourcePack = {
      id: randomUUID(),
      name: input.name,
      version: input.version,
      sources: input.sources ?? [],
      licenses: input.licenses ?? [],
      wordCount: input.wordCount ?? 0,
      audioCount: input.audioCount ?? 0,
      createdAt: timestamp()
    };
    this.db
      .prepare(
        `
        INSERT INTO resource_packs (id, name, version, sources, licenses, word_count, audio_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        pack.id,
        pack.name,
        pack.version,
        JSON.stringify(pack.sources),
        JSON.stringify(pack.licenses),
        pack.wordCount,
        pack.audioCount,
        pack.createdAt
      );
    return pack;
  }

  assetPath(sha256: string): string | null {
    const row = this.db
      .prepare("SELECT file_path FROM audio_assets WHERE sha256 = ? AND deleted_at IS NULL AND missing = 0")
      .get(sha256) as { file_path: string } | undefined;
    if (!row) return null;
    const fullPath = resolve(this.assetsDir, row.file_path);
    return existsSync(fullPath) ? fullPath : null;
  }

  private dueCardById(id: string): DueCard | null {
    const row = this.db
      .prepare(
        `
        SELECT
          c.id AS card_id, c.word_id, c.deck_id, c.ease_factor, c.interval_days, c.due_at,
          c.lapse_count, c.review_count, c.device_id AS card_device_id, c.created_at AS card_created_at,
          c.updated_at AS card_updated_at, c.deleted_at AS card_deleted_at, c.version AS card_version,
          w.*, s.definition_zh, s.definition_en, s.example, a.file_path AS audio_file, a.missing AS audio_missing
        FROM cards c
        JOIN words w ON w.id = c.word_id
        LEFT JOIN word_senses s ON s.word_id = w.id AND s.deleted_at IS NULL
        LEFT JOIN audio_assets a ON a.word_id = w.id AND a.deleted_at IS NULL
        WHERE c.id = ?
      `
      )
      .get(id) as Row | undefined;
    return row ? { card: rowToCard(row), word: rowToWord(row) } : null;
  }

  private upsertAudioAsset(wordId: string, audioFile: string, source: string, now: string): void {
    this.db.prepare("UPDATE audio_assets SET deleted_at = ?, updated_at = ? WHERE word_id = ? AND deleted_at IS NULL").run(now, now, wordId);
    if (!audioFile.trim()) return;

    const fullPath = resolve(this.assetsDir, audioFile);
    const missing = existsSync(fullPath) ? 0 : 1;
    const sha256 = missing ? createHash("sha256").update(audioFile).digest("hex") : createHash("sha256").update(readFileSync(fullPath)).digest("hex");
    const format = audioFile.split(".").pop() || "unknown";

    this.db
      .prepare(
        `
        INSERT INTO audio_assets (
          id, word_id, sha256, file_path, format, source, license, missing, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(randomUUID(), wordId, sha256, audioFile, format, source, "", missing, now, now);
  }

  private recordOperation(
    entityType: string,
    entityId: string,
    operation: SyncChange["operation"],
    payload: unknown
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO sync_operations (id, entity_type, entity_id, operation, payload, device_id, version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(randomUUID(), entityType, entityId, operation, JSON.stringify(payload), this.deviceId, 1, timestamp());
  }

  private defaultDeckId(): string {
    const row = this.db.prepare("SELECT id FROM decks WHERE name = '默认词本'").get() as { id: string } | undefined;
    if (!row) throw new Error("default deck was not created");
    return row.id;
  }

  private streakDays(): number {
    const rows = this.db
      .prepare("SELECT DISTINCT substr(reviewed_at, 1, 10) AS day FROM review_logs ORDER BY day DESC")
      .all() as { day: string }[];
    const days = new Set(rows.map((row) => row.day));
    let streak = 0;
    const cursor = new Date();
    for (;;) {
      const key = cursor.toISOString().slice(0, 10);
      if (!days.has(key)) break;
      streak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return streak;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS words (
        id TEXT PRIMARY KEY,
        word TEXT NOT NULL,
        normalized TEXT NOT NULL UNIQUE,
        phonetic TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'manual',
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        last_synced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS word_senses (
        id TEXT PRIMARY KEY,
        word_id TEXT NOT NULL REFERENCES words(id),
        definition_zh TEXT NOT NULL DEFAULT '',
        definition_en TEXT NOT NULL DEFAULT '',
        example TEXT NOT NULL DEFAULT '',
        part_of_speech TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audio_assets (
        id TEXT PRIMARY KEY,
        word_id TEXT NOT NULL REFERENCES words(id),
        sha256 TEXT NOT NULL,
        file_path TEXT NOT NULL,
        format TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        license TEXT NOT NULL DEFAULT '',
        missing INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS decks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        word_id TEXT NOT NULL REFERENCES words(id),
        deck_id TEXT NOT NULL REFERENCES decks(id),
        ease_factor REAL NOT NULL DEFAULT 2.5,
        interval_days INTEGER NOT NULL DEFAULT 0,
        due_at TEXT NOT NULL,
        lapse_count INTEGER NOT NULL DEFAULT 0,
        review_count INTEGER NOT NULL DEFAULT 0,
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        last_synced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS review_logs (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id),
        word_id TEXT NOT NULL REFERENCES words(id),
        rating TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        previous_interval_days INTEGER NOT NULL,
        next_interval_days INTEGER NOT NULL,
        previous_ease_factor REAL NOT NULL,
        next_ease_factor REAL NOT NULL,
        device_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_devices (
        id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        paired_at TEXT NOT NULL,
        last_sync_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_operations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        device_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resource_packs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '[]',
        licenses TEXT NOT NULL DEFAULT '[]',
        word_count INTEGER NOT NULL DEFAULT 0,
        audio_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private seedDefaults(): void {
    const existingDeck = this.db.prepare("SELECT id FROM decks WHERE name = '默认词本'").get();
    if (!existingDeck) {
      const now = timestamp();
      this.db
        .prepare("INSERT INTO decks (id, name, created_at, updated_at) VALUES (?, '默认词本', ?, ?)")
        .run(randomUUID(), now, now);
    }
  }
}

function rowToWord(row: Row): Word {
  return {
    id: String(row.id),
    word: String(row.word),
    normalized: String(row.normalized),
    phonetic: String(row.phonetic ?? ""),
    tags: parseJsonArray(row.tags),
    source: String(row.source ?? ""),
    definitionZh: String(row.definition_zh ?? ""),
    definitionEn: String(row.definition_en ?? ""),
    example: String(row.example ?? ""),
    audioFile: String(row.audio_file ?? ""),
    audioMissing: Boolean(row.audio_missing),
    deviceId: String(row.device_id ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    version: Number(row.version ?? 1),
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null
  };
}

function rowToCard(row: Row): Card {
  return {
    id: String(row.card_id),
    wordId: String(row.word_id),
    deckId: String(row.deck_id),
    easeFactor: Number(row.ease_factor),
    intervalDays: Number(row.interval_days),
    dueAt: String(row.due_at),
    lapseCount: Number(row.lapse_count),
    reviewCount: Number(row.review_count),
    deviceId: String(row.card_device_id),
    createdAt: String(row.card_created_at),
    updatedAt: String(row.card_updated_at),
    deletedAt: row.card_deleted_at ? String(row.card_deleted_at) : null,
    version: Number(row.card_version),
    lastSyncedAt: null
  };
}

function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function scalarNumber(row: unknown): number {
  return Number((row as { value?: number } | undefined)?.value ?? 0);
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function defaultDbFile(): string {
  return process.env.ELS_DB_FILE ?? join(projectRoot(), "data", "english-learning.sqlite");
}

export function defaultAssetsDir(): string {
  return process.env.ELS_ASSETS_DIR ?? join(projectRoot(), "assets");
}

export function projectRoot(): string {
  return process.env.INIT_CWD ?? process.cwd();
}
