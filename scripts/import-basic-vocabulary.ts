import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWord, wordsToCsvRows, type WordInput } from "@els/shared";
import { LearningDatabase } from "../apps/server/src/database.ts";

const DALE_CHALL_URL = "https://raw.githubusercontent.com/words/dale-chall/main/index.js";
const DICTIONARY_ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en";
const COMMONS_API_ENDPOINT = "https://commons.wikimedia.org/w/api.php";
const DEFAULT_SOURCE_ID = "basic-dale-chall-dictionaryapi";
const DEFAULT_PACK_NAME = "Basic Dale-Chall Foundation Vocabulary";
const BACKFILL_SOURCE_ID = "dictionaryapi-pronunciation-backfill";
const BACKFILL_PACK_NAME = "Dictionary API Pronunciation Backfill";
const DEFAULT_LIMIT = 300;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "EnglishLearningSystem/0.1 basic-vocabulary-importer";

interface Options {
  limit: number;
  offset: number;
  dbFile: string;
  assetsDir: string;
  packSlug: string;
  packName: string;
  sourceId: string;
  words: string[];
  wordListUrl: string;
  wordListFile: string;
  wordColumn: string;
  filterColumn: string;
  filterValues: string[];
  sourceName: string;
  sourceUrl: string;
  sourceLicense: string;
  baseTags: string[];
  preserveExistingSource: boolean;
  wordListOnly: boolean;
}

interface DictionaryEntry {
  word?: string;
  phonetic?: string;
  phonetics?: PhoneticEntry[];
  meanings?: MeaningEntry[];
}

interface PhoneticEntry {
  text?: string;
  audio?: string;
  sourceUrl?: string;
  license?: {
    name?: string;
    url?: string;
  };
}

interface MeaningEntry {
  partOfSpeech?: string;
  definitions?: DefinitionEntry[];
}

interface DefinitionEntry {
  definition?: string;
  example?: string;
}

interface ImportedItem {
  word: string;
  normalized: string;
  phonetic: string;
  definitionZh: string;
  definitionEn: string;
  example: string;
  partOfSpeech: string;
  tags: string[];
  audioFile: string;
  audioUrl: string;
  audioSha256: string;
  license: AudioLicense;
}

interface CandidateItem {
  word: string;
  tags: string[];
  phonetic?: string;
  definitionZh?: string;
  definitionEn?: string;
  example?: string;
}

interface AudioLicense {
  name: string;
  url: string;
  sourceUrl: string;
}

interface SkipRecord {
  word: string;
  reason: string;
}

interface ImportReport {
  created: number;
  updated: number;
  skipped: SkipRecord[];
  imported: ImportedItem[];
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
const packDir = resolve(options.assetsDir, "resource-packs", options.packSlug);
const audioDir = resolve(packDir, "audio");

mkdirSync(audioDir, { recursive: true });

if (options.words.length > 0) {
  console.log(`Using provided word list with ${options.words.length} words`);
} else if (options.wordListUrl) {
  console.log(`Downloading external word list from ${options.wordListUrl}`);
} else if (options.wordListFile) {
  console.log(`Reading external word list from ${options.wordListFile}`);
} else {
  console.log(`Downloading basic word list from ${DALE_CHALL_URL}`);
}
const candidateItems = await loadCandidateItems(options);

console.log(`Found ${candidateItems.length} candidate words after offset ${options.offset}`);
console.log(`Import target: ${options.limit} words with saved pronunciation audio`);
console.log(`Assets pack: ${packDir}`);

const database = new LearningDatabase({
  dbFile: options.dbFile,
  assetsDir: options.assetsDir,
  deviceId: "resource-importer"
});

const report: ImportReport = {
  created: 0,
  updated: 0,
  skipped: [],
  imported: []
};

try {
  for (const candidate of candidateItems) {
    if (report.imported.length >= options.limit) break;

    const word = candidate.word;
    const normalized = normalizeWord(word);
    if (!isImportableWord(normalized)) {
      report.skipped.push({ word, reason: "unsupported word shape" });
      continue;
    }

    if (options.wordListOnly) {
      const existing = database.db
        .prepare("SELECT id FROM words WHERE normalized = ? AND deleted_at IS NULL")
        .get(normalized) as { id: string } | undefined;

      const input: WordInput = {
        word,
        phonetic: candidate.phonetic ?? "",
        definitionZh: candidate.definitionZh ?? "",
        definitionEn: candidate.definitionEn ?? "",
        example: candidate.example ?? "",
        tags: mergedTags(existing?.id, "", candidate.tags),
        source: wordSource(existing?.id)
      };

      database.createWord(input);
      if (existing) report.updated += 1;
      else report.created += 1;

      report.imported.push({
        word,
        normalized,
        phonetic: input.phonetic ?? "",
        definitionZh: input.definitionZh ?? "",
        definitionEn: input.definitionEn ?? "",
        example: input.example ?? "",
        partOfSpeech: "",
        tags: itemTags("", candidate.tags),
        audioFile: "",
        audioUrl: "",
        audioSha256: "",
        license: { name: "", url: "", sourceUrl: "" }
      });

      if (report.imported.length % 25 === 0) {
        console.log(`Imported ${report.imported.length}/${options.limit} words`);
      }
      continue;
    }

    const entries = await lookupDictionary(normalized);
    if (!entries?.length) {
      report.skipped.push({ word, reason: "no dictionary entry" });
      continue;
    }

    const entry = entries[0];
    const meaning = pickMeaning(entry);
    if (!meaning?.definition) {
      report.skipped.push({ word, reason: "no definition" });
      continue;
    }

    const audio = pickAudio(entry) ?? (await lookupCommonsAudio(normalized));
    if (!audio?.audio) {
      report.skipped.push({ word, reason: "no pronunciation audio" });
      continue;
    }

    const audioResult = await saveAudio(word, audio);
    if (!audioResult) {
      report.skipped.push({ word, reason: "audio download failed" });
      continue;
    }

    const existing = database.db
      .prepare("SELECT id FROM words WHERE normalized = ? AND deleted_at IS NULL")
      .get(normalized) as { id: string } | undefined;

    const input: WordInput = {
      word,
      phonetic: pickPhonetic(entry, audio),
      definitionEn: compactText(meaning.definition),
      definitionZh: "",
      example: compactText(meaning.example ?? ""),
      tags: mergedTags(existing?.id, meaning.partOfSpeech, candidate.tags),
      audioFile: audioResult.relativePath,
      source: wordSource(existing?.id)
    };

    const savedWord = database.createWord(input);
    if (existing) report.updated += 1;
    else report.created += 1;

    const license: AudioLicense = {
      name: audio.license?.name ?? "",
      url: audio.license?.url ?? "",
      sourceUrl: audio.sourceUrl ?? ""
    };

    database.db
      .prepare(
        "UPDATE audio_assets SET source = ?, license = ? WHERE word_id = ? AND deleted_at IS NULL"
      )
      .run(options.sourceId, JSON.stringify(license), savedWord.id);

    database.db
      .prepare("UPDATE word_senses SET part_of_speech = ? WHERE word_id = ? AND deleted_at IS NULL")
      .run(meaning.partOfSpeech, savedWord.id);

    report.imported.push({
      word,
      normalized,
      phonetic: input.phonetic ?? "",
      definitionZh: input.definitionZh ?? "",
      definitionEn: input.definitionEn ?? "",
      example: input.example ?? "",
      partOfSpeech: meaning.partOfSpeech,
      tags: itemTags(meaning.partOfSpeech, candidate.tags),
      audioFile: audioResult.relativePath,
      audioUrl: audioResult.audioUrl,
      audioSha256: audioResult.sha256,
      license
    });

    if (report.imported.length % 25 === 0) {
      console.log(`Imported ${report.imported.length}/${options.limit} words`);
    }
  }

  writePackFiles(report);
  registerResourcePack(report);

  console.log(
    `Done. Created ${report.created}, updated ${report.updated}, audio saved ${audioCount(report.imported)}, skipped ${report.skipped.length}.`
  );
  console.log(`Manifest: ${resolve(packDir, "manifest.json")}`);
  console.log(`CSV: ${resolve(packDir, "dictionary.csv")}`);
} finally {
  database.close();
}

function parseArgs(args: string[]): Options {
  const today = new Date().toISOString().slice(0, 10);
  const parsed: Options = {
    limit: DEFAULT_LIMIT,
    offset: 0,
    dbFile: resolve(rootDir, "data", "english-learning.sqlite"),
    assetsDir: resolve(rootDir, "assets"),
    packSlug: `basic-dale-chall-foundation-${today}`,
    packName: DEFAULT_PACK_NAME,
    sourceId: DEFAULT_SOURCE_ID,
    words: [],
    wordListUrl: "",
    wordListFile: "",
    wordColumn: "",
    filterColumn: "",
    filterValues: [],
    sourceName: "",
    sourceUrl: "",
    sourceLicense: "",
    baseTags: [],
    preserveExistingSource: false,
    wordListOnly: false
  };
  let limitProvided = false;
  let packSlugProvided = false;
  let packNameProvided = false;
  let sourceIdProvided = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--limit" && next) {
      parsed.limit = Number(next);
      limitProvided = true;
      index += 1;
    } else if (arg === "--offset" && next) {
      parsed.offset = Number(next);
      index += 1;
    } else if (arg === "--db-file" && next) {
      parsed.dbFile = resolve(next);
      index += 1;
    } else if (arg === "--assets-dir" && next) {
      parsed.assetsDir = resolve(next);
      index += 1;
    } else if (arg === "--pack-slug" && next) {
      parsed.packSlug = next;
      packSlugProvided = true;
      index += 1;
    } else if (arg === "--pack-name" && next) {
      parsed.packName = next;
      packNameProvided = true;
      index += 1;
    } else if (arg === "--source-id" && next) {
      parsed.sourceId = next;
      sourceIdProvided = true;
      index += 1;
    } else if (arg === "--words" && next) {
      parsed.words = next
        .split(",")
        .map((word) => normalizeWord(word))
        .filter(Boolean);
      index += 1;
    } else if (arg === "--word-list-url" && next) {
      parsed.wordListUrl = next;
      index += 1;
    } else if (arg === "--word-list-file" && next) {
      parsed.wordListFile = resolve(next);
      index += 1;
    } else if (arg === "--word-column" && next) {
      parsed.wordColumn = next;
      index += 1;
    } else if (arg === "--filter-column" && next) {
      parsed.filterColumn = next;
      index += 1;
    } else if (arg === "--filter-values" && next) {
      parsed.filterValues = splitList(next).map((value) => value.toLowerCase());
      index += 1;
    } else if (arg === "--source-name" && next) {
      parsed.sourceName = next;
      index += 1;
    } else if (arg === "--source-url" && next) {
      parsed.sourceUrl = next;
      index += 1;
    } else if (arg === "--source-license" && next) {
      parsed.sourceLicense = next;
      index += 1;
    } else if (arg === "--tag" && next) {
      parsed.baseTags.push(...splitList(next));
      index += 1;
    } else if (arg === "--word-list-only") {
      parsed.wordListOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const hasExternalWordList = Boolean(parsed.wordListUrl || parsed.wordListFile);
  if (parsed.words.length > 0 && hasExternalWordList) {
    throw new Error("--words cannot be combined with --word-list-url or --word-list-file");
  }
  if (parsed.wordListUrl && parsed.wordListFile) {
    throw new Error("--word-list-url and --word-list-file are mutually exclusive");
  }
  if (parsed.filterValues.length > 0 && !parsed.filterColumn) {
    throw new Error("--filter-values requires --filter-column");
  }

  if (parsed.words.length > 0) {
    if (!limitProvided) parsed.limit = parsed.words.length;
    if (!packSlugProvided) parsed.packSlug = `pronunciation-backfill-${today}`;
    if (!packNameProvided) parsed.packName = BACKFILL_PACK_NAME;
    if (!sourceIdProvided) parsed.sourceId = BACKFILL_SOURCE_ID;
    if (parsed.baseTags.length === 0) parsed.baseTags = ["pronunciation-backfill"];
    parsed.preserveExistingSource = !sourceIdProvided;
  } else if (hasExternalWordList) {
    if (!packSlugProvided) parsed.packSlug = `external-word-list-${today}`;
    if (!packNameProvided) parsed.packName = "External Word List Vocabulary";
    if (!sourceIdProvided) parsed.sourceId = "external-word-list-dictionaryapi";
    if (parsed.baseTags.length === 0) parsed.baseTags = ["external-word-list"];
  }

  if (!Number.isInteger(parsed.limit) || parsed.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isInteger(parsed.offset) || parsed.offset < 0) {
    throw new Error("--offset must be a non-negative integer");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(parsed.packSlug)) {
    throw new Error("--pack-slug may only contain letters, numbers, dot, underscore, and dash");
  }
  if (!parsed.packName.trim()) {
    throw new Error("--pack-name must not be empty");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(parsed.sourceId)) {
    throw new Error("--source-id may only contain letters, numbers, dot, underscore, and dash");
  }

  return parsed;
}

function printHelpAndExit(): never {
  console.log(`Usage: npm run import:vocabulary -- [options]

Legacy alias:
  npm run import:basic-vocabulary -- [options]

Options:
  --limit <number>       Number of words with saved audio to import. Default: ${DEFAULT_LIMIT}
  --offset <number>      Skip this many Dale-Chall entries before collecting. Default: 0
  --db-file <path>       SQLite database path. Default: data/english-learning.sqlite
  --assets-dir <path>    Assets root path. Default: assets
  --pack-slug <slug>     Resource pack directory name. Default: basic-dale-chall-foundation-YYYY-MM-DD
  --pack-name <name>     Resource pack display name
  --source-id <id>       Source id written to imported audio assets
  --words <csv>          Comma-separated words to import instead of the Dale-Chall list
  --word-list-url <url>  External CSV/TXT word list URL
  --word-list-file <p>   External CSV/TXT word list file
  --word-column <name>   CSV column that contains the word. Defaults to word/headword/first column
  --filter-column <name> CSV column used for filtering, e.g. CEFR
  --filter-values <csv>  Accepted values for --filter-column, e.g. A1,A2
  --source-name <name>   Source name written to the resource pack manifest
  --source-url <url>     Source URL written to the resource pack manifest
  --source-license <txt> Source license or terms written to the resource pack manifest
  --tag <csv>            Tags added to every imported word. Can be repeated
  --word-list-only       Import source words/metadata only; do not fetch dictionary definitions or audio
`);
  process.exit(0);
}

async function loadCandidateItems(importOptions: Options): Promise<CandidateItem[]> {
  let items: CandidateItem[];
  if (importOptions.words.length > 0) {
    items = importOptions.words.map((word) => ({ word, tags: importOptions.baseTags }));
  } else if (importOptions.wordListUrl || importOptions.wordListFile) {
    const text = importOptions.wordListUrl
      ? await fetchText(importOptions.wordListUrl)
      : readFileSync(importOptions.wordListFile, "utf8");
    items = parseExternalWordList(text, importOptions);
  } else {
    const words = await fetchDaleChallCandidates(0);
    items = words.map((word) => ({ word, tags: ["basic", "dale-chall"] }));
  }
  return uniqueCandidateItems(items).slice(importOptions.offset);
}

async function fetchDaleChallCandidates(offset: number): Promise<string[]> {
  const wordListSource = await fetchText(DALE_CHALL_URL);
  return parseDaleChallWords(wordListSource).slice(offset);
}

function parseExternalWordList(text: string, importOptions: Options): CandidateItem[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (looksLikeJson(trimmed)) {
    return parseJsonWordList(trimmed, importOptions);
  }

  if (importOptions.wordColumn || looksLikeCsv(trimmed)) {
    return parseCsvRecords(trimmed)
      .filter((row) => rowMatchesFilter(row, importOptions))
      .map((row) => {
        const word = pickWordFromRow(row, importOptions.wordColumn);
        return {
          word,
          phonetic: pickPhoneticFromRow(row),
          definitionZh: pickDefinitionZhFromRow(row, importOptions.wordColumn),
          tags: [...importOptions.baseTags, ...filterTags(row, importOptions)]
        };
      })
      .filter((item) => item.word);
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => ({
      word: extractLineWord(line),
      phonetic: extractLinePhonetic(line),
      definitionZh: extractLineDefinitionZh(line),
      tags: importOptions.baseTags
    }))
    .filter((item) => item.word);
}

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

function parseJsonWordList(text: string, importOptions: Options): CandidateItem[] {
  const records = text.startsWith("[")
    ? (JSON.parse(text) as unknown[])
    : text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);

  return records.map((record) => candidateFromJson(record, importOptions)).filter((item) => item.word);
}

function candidateFromJson(record: unknown, importOptions: Options): CandidateItem {
  if (typeof record === "string") return { word: record, tags: importOptions.baseTags };
  if (!record || typeof record !== "object") return { word: "", tags: importOptions.baseTags };
  const value = record as Record<string, unknown>;
  const candidates = [
    importOptions.wordColumn ? lookupJsonPath(value, importOptions.wordColumn) : "",
    value.headWord,
    value.headword,
    value.word,
    value.wordHead,
    lookupJsonPath(value, "content.word.wordHead")
  ];
  const content = asRecord(lookupJsonPath(value, "content.word.content"));
  return {
    word: candidates.find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() ?? "",
    phonetic: compactText(String(content?.usphone ?? content?.ukphone ?? "")),
    definitionZh: pickJsonDefinitionZh(content),
    definitionEn: pickJsonDefinitionEn(content),
    example: pickJsonExample(content),
    tags: importOptions.baseTags
  };
}

function lookupJsonPath(value: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (!current || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[key];
    }, value);
}

function extractLineWord(line: string): string {
  const normalizedLine = line.replace(/^\uFEFF/, "").trim();
  return normalizedLine.match(/^[A-Za-z][A-Za-z'-]*/)?.[0] ?? "";
}

function extractLinePhonetic(line: string): string {
  return line.match(/\[[^\]]+\]|\/[^/]+\//)?.[0] ?? "";
}

function extractLineDefinitionZh(line: string): string {
  const word = extractLineWord(line);
  if (!word) return "";
  return compactText(
    line
      .replace(/^\uFEFF/, "")
      .trim()
      .slice(word.length)
      .replace(/^\s*(\[[^\]]+\]|\/[^/]+\/)?\s*/, "")
  );
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.includes(",") || firstLine.includes("\t");
}

function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseDelimitedRows(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((cell) => cell.trim());
  return rows.slice(1).map((row) =>
    Object.fromEntries(header.map((column, index) => [column, (row[index] ?? "").trim()]))
  );
}

function parseDelimitedRows(text: string): string[][] {
  const delimiter = (text.split(/\r?\n/, 1)[0] ?? "").includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((entry) => entry.some((cellValue) => cellValue.trim()));
}

function rowMatchesFilter(row: Record<string, string>, importOptions: Options): boolean {
  if (!importOptions.filterColumn || importOptions.filterValues.length === 0) return true;
  const value = lookupColumn(row, importOptions.filterColumn).toLowerCase();
  return importOptions.filterValues.includes(value);
}

function pickWordFromRow(row: Record<string, string>, wordColumn: string): string {
  if (wordColumn) return lookupColumn(row, wordColumn);
  return lookupColumn(row, "word") || lookupColumn(row, "headword") || Object.values(row)[0] || "";
}

function lookupColumn(row: Record<string, string>, column: string): string {
  const wanted = column.trim().toLowerCase();
  const match = Object.keys(row).find((key) => key.trim().toLowerCase() === wanted);
  return match ? row[match] ?? "" : "";
}

function pickPhoneticFromRow(row: Record<string, string>): string {
  return lookupColumn(row, "phonetic") || lookupColumn(row, "phone") || "";
}

function pickDefinitionZhFromRow(row: Record<string, string>, wordColumn: string): string {
  const direct =
    lookupColumn(row, "definition_zh") ||
    lookupColumn(row, "translation") ||
    lookupColumn(row, "meaning") ||
    lookupColumn(row, "trans");
  if (direct) return direct;

  const wordKey = wordColumn.trim().toLowerCase();
  const values = Object.entries(row)
    .filter(([key]) => !wordKey || key.trim().toLowerCase() !== wordKey)
    .map(([, value]) => value)
    .filter(Boolean);
  return values[1] ?? values[0] ?? "";
}

function pickJsonDefinitionZh(content: Record<string, unknown> | null): string {
  return asArray(content?.trans)
    .map(asRecord)
    .filter(Boolean)
    .map((item) => [item?.pos, item?.tranCn].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");
}

function pickJsonDefinitionEn(content: Record<string, unknown> | null): string {
  return asArray(content?.trans)
    .map(asRecord)
    .filter(Boolean)
    .map((item) => String(item?.tranOther ?? ""))
    .filter(Boolean)
    .join("; ");
}

function pickJsonExample(content: Record<string, unknown> | null): string {
  const sentences = asArray(asRecord(content?.sentence)?.sentences);
  return String(asRecord(sentences[0])?.sContent ?? "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function filterTags(row: Record<string, string>, importOptions: Options): string[] {
  if (!importOptions.filterColumn) return [];
  const value = lookupColumn(row, importOptions.filterColumn);
  if (!value) return [];
  const key = importOptions.filterColumn.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return [`${key}:${value.toLowerCase()}`];
}

function uniqueCandidateItems(items: CandidateItem[]): CandidateItem[] {
  const byWord = new Map<string, CandidateItem>();
  for (const item of items) {
    const word = normalizeWord(item.word);
    if (!word) continue;
    const existing = byWord.get(word);
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...item.tags])];
      existing.phonetic ||= item.phonetic;
      existing.definitionZh ||= item.definitionZh;
      existing.definitionEn ||= item.definitionEn;
      existing.example ||= item.example;
    } else {
      byWord.set(word, { ...item, word, tags: [...new Set(item.tags)] });
    }
  }
  return [...byWord.values()];
}

function parseDaleChallWords(source: string): string[] {
  const match = source.match(/export const daleChall = \[([\s\S]*?)\]/);
  if (!match) throw new Error("Could not parse Dale-Chall word list");

  const words: string[] = [];
  const quotedWordPattern = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g;
  let quotedWord: RegExpExecArray | null;
  while ((quotedWord = quotedWordPattern.exec(match[1])) !== null) {
    words.push(unescapeJsString(quotedWord[1] ?? quotedWord[2] ?? "").toLowerCase());
  }
  return [...new Set(words)];
}

function unescapeJsString(value: string): string {
  return value.replace(/\\(['"\\])/g, "$1");
}

function isImportableWord(word: string): boolean {
  return /^[a-z][a-z'-]*$/.test(word);
}

async function lookupDictionary(word: string): Promise<DictionaryEntry[] | null> {
  const url = `${DICTIONARY_ENDPOINT}/${encodeURIComponent(word)}`;
  try {
    const response = await fetchWithRetry(url, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) return null;
    return (await response.json()) as DictionaryEntry[];
  } catch {
    return null;
  }
}

function pickMeaning(entry: DictionaryEntry): { partOfSpeech: string; definition: string; example: string } | null {
  for (const meaning of entry.meanings ?? []) {
    for (const definition of meaning.definitions ?? []) {
      if (definition.definition?.trim()) {
        return {
          partOfSpeech: compactText(meaning.partOfSpeech ?? ""),
          definition: compactText(definition.definition),
          example: compactText(definition.example ?? "")
        };
      }
    }
  }
  return null;
}

function pickAudio(entry: DictionaryEntry): PhoneticEntry | null {
  const candidates = (entry.phonetics ?? []).filter((phonetic) => Boolean(phonetic.audio?.trim()));
  candidates.sort((left, right) => audioScore(right) - audioScore(left));
  return candidates[0] ?? null;
}

async function lookupCommonsAudio(word: string): Promise<PhoneticEntry | null> {
  const titles = await searchCommonsAudioTitles(word);
  if (titles.length === 0) return null;

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "imageinfo",
    iiprop: "url|mime|extmetadata",
    titles: titles.join("|")
  });
  let data: {
    query?: {
      pages?: Record<
        string,
        {
          title?: string;
          imageinfo?: Array<{
            url?: string;
            descriptionurl?: string;
            mime?: string;
            extmetadata?: Record<string, { value?: string }>;
          }>;
        }
      >;
    };
  };
  try {
    const response = await fetchWithRetry(`${COMMONS_API_ENDPOINT}?${params}`, {
      headers: { "user-agent": USER_AGENT }
    });
    if (!response.ok) return null;
    data = (await response.json()) as typeof data;
  } catch {
    return null;
  }

  for (const page of Object.values(data.query?.pages ?? {})) {
    const imageInfo = page.imageinfo?.[0];
    if (!imageInfo?.url || !imageInfo.mime?.startsWith("audio/")) continue;
    const metadata = imageInfo.extmetadata ?? {};
    return {
      audio: imageInfo.url,
      sourceUrl: imageInfo.descriptionurl ?? "",
      license: {
        name: stripHtml(metadata.LicenseShortName?.value ?? metadata.License?.value ?? ""),
        url: stripHtml(metadata.LicenseUrl?.value ?? "")
      }
    };
  }

  return null;
}

async function searchCommonsAudioTitles(word: string): Promise<string[]> {
  const exactCandidates = [
    `File:En-us-${word}.ogg`,
    `File:En-${word}.ogg`,
    `File:LL-Q1860 (eng)-Vealhurl-${word}.wav`
  ];
  const searchParams = new URLSearchParams({
    action: "query",
    format: "json",
    list: "search",
    srnamespace: "6",
    srlimit: "10",
    srsearch: `${word} Q1860 eng`
  });
  let response: Response;
  try {
    response = await fetchWithRetry(`${COMMONS_API_ENDPOINT}?${searchParams}`, {
      headers: { "user-agent": USER_AGENT }
    });
  } catch {
    return exactCandidates;
  }
  if (!response.ok) return exactCandidates;

  const data = (await response.json()) as {
    query?: {
      search?: Array<{ title?: string }>;
    };
  };
  const searched = (data.query?.search ?? [])
    .map((item) => item.title ?? "")
    .filter((title) => commonsTitleMatchesWord(title, word));
  return [...new Set([...exactCandidates, ...searched])];
}

function commonsTitleMatchesWord(title: string, word: string): boolean {
  const filename = title.replace(/^File:/i, "").toLowerCase();
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[- ])${escaped}\\.(ogg|oga|wav|mp3)$`).test(filename);
}

function audioScore(phonetic: PhoneticEntry): number {
  const audioUrl = phonetic.audio ?? "";
  let score = 0;
  if (phonetic.license?.name) score += 10;
  if (phonetic.text) score += 3;
  if (/-us\.|_us_|us\.mp3|en-us/i.test(audioUrl)) score += 3;
  if (/-uk\.|_uk_|gb\.mp3|en-gb/i.test(audioUrl)) score += 2;
  return score;
}

function pickPhonetic(entry: DictionaryEntry, audio: PhoneticEntry): string {
  return compactText(audio.text ?? entry.phonetic ?? entry.phonetics?.find((phonetic) => phonetic.text)?.text ?? "");
}

function mergedTags(existingId: string | undefined, partOfSpeech: string, candidateTags: string[]): string[] {
  const existingTags = existingId ? database.getWord(existingId)?.tags ?? [] : [];
  return [...new Set([...existingTags, ...itemTags(partOfSpeech, candidateTags)])];
}

function wordSource(existingId: string | undefined): string {
  if (!existingId || !options.preserveExistingSource) return options.sourceId;
  return database.getWord(existingId)?.source ?? options.sourceId;
}

function itemTags(partOfSpeech: string, candidateTags = options.baseTags): string[] {
  return [
    ...candidateTags,
    partOfSpeech ? `pos:${partOfSpeech}` : ""
  ].filter(Boolean);
}

async function saveAudio(
  word: string,
  audio: PhoneticEntry
): Promise<{ relativePath: string; audioUrl: string; sha256: string } | null> {
  const audioUrl = normalizeAudioUrl(audio.audio ?? "");
  if (!audioUrl) return null;

  let response: Response;
  try {
    response = await fetchWithRetry(audioUrl, { headers: { "user-agent": USER_AGENT } });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) return null;

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const extension = audioExtension(audioUrl, response.headers.get("content-type"));
  const filename = `${safeFilename(word)}.${extension}`;
  const filePath = resolve(audioDir, filename);

  if (!existsSync(filePath) || createHash("sha256").update(readFileSync(filePath)).digest("hex") !== sha256) {
    writeFileSync(filePath, bytes);
  }

  return {
    relativePath: relative(options.assetsDir, filePath).split(sep).join("/"),
    audioUrl,
    sha256
  };
}

function normalizeAudioUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

function audioExtension(audioUrl: string, contentType: string | null): string {
  const urlExtension = extname(new URL(audioUrl).pathname).slice(1).toLowerCase();
  if (["mp3", "ogg", "wav", "m4a"].includes(urlExtension)) return urlExtension;
  if (contentType?.includes("mpeg")) return "mp3";
  if (contentType?.includes("ogg")) return "ogg";
  if (contentType?.includes("wav")) return "wav";
  return "mp3";
}

function safeFilename(word: string): string {
  const base = normalizeWord(word).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || createHash("sha1").update(word).digest("hex").slice(0, 12);
}

function writePackFiles(report: ImportReport): void {
  const manifest = {
    name: options.packName,
    version: options.packSlug,
    createdAt: new Date().toISOString(),
    sourceId: options.sourceId,
    wordCount: report.imported.length,
    audioCount: audioCount(report.imported),
    sources: manifestSources(),
    licenses: resourcePackLicenses(report.imported),
    skipped: summarizeSkips(report.skipped),
    files: {
      dictionaryCsv: "dictionary.csv",
      audioIndex: "audio-index.json",
      audioDirectory: "audio/"
    }
  };

  writeFileSync(resolve(packDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(packDir, "audio-index.json"), `${JSON.stringify(report.imported, null, 2)}\n`);
  writeFileSync(resolve(packDir, "skipped.json"), `${JSON.stringify(report.skipped, null, 2)}\n`);
  writeFileSync(resolve(packDir, "dictionary.csv"), csvForImportedItems(report.imported));
}

function csvForImportedItems(items: ImportedItem[]): string {
  const rows = items.map((item) => ({
    word: item.word,
    phonetic: item.phonetic,
    definitionEn: item.definitionEn,
    definitionZh: item.definitionZh,
    example: item.example,
    tags: item.tags,
    audioFile: item.audioFile,
    source: options.sourceId
  }));
  return `${wordsToCsvRows(rows)}\n`;
}

function registerResourcePack(report: ImportReport): void {
  const existing = database.db
    .prepare("SELECT id FROM resource_packs WHERE name = ? AND version = ?")
    .get(options.packName, options.packSlug);

  if (existing) return;

  database.addResourcePack({
    name: options.packName,
    version: options.packSlug,
    sources: resourcePackSources(),
    licenses: resourcePackLicenses(report.imported),
    wordCount: report.imported.length,
    audioCount: audioCount(report.imported)
  });
}

function audioCount(items: ImportedItem[]): number {
  return items.filter((item) => item.audioFile).length;
}

function manifestSources(): { name: string; url: string; license: string }[] {
  return [
    ...(usesDaleChallSource()
      ? [
          {
            name: "words/dale-chall",
            url: "https://github.com/words/dale-chall",
            license: "MIT"
          }
        ]
      : []),
    ...(externalManifestSource() ? [externalManifestSource() as { name: string; url: string; license: string }] : []),
    ...(!options.wordListOnly
      ? [
          {
            name: "Free Dictionary API",
            url: "https://dictionaryapi.dev/",
            license: "API data includes per-pronunciation source and license metadata"
          }
        ]
      : [])
  ];
}

function resourcePackSources(): string[] {
  return [
    ...(usesDaleChallSource() ? ["words/dale-chall"] : []),
    ...(externalManifestSource()?.name ? [externalManifestSource()?.name ?? ""] : []),
    ...(!options.wordListOnly ? ["Free Dictionary API"] : [])
  ].filter(Boolean);
}

function resourcePackLicenses(items: ImportedItem[]): string[] {
  return [
    ...(usesDaleChallSource() ? ["words/dale-chall: MIT"] : []),
    ...(externalManifestSource()?.license ? [`${externalManifestSource()?.name}: ${externalManifestSource()?.license}`] : []),
    ...uniqueLicenses(items)
  ];
}

function usesDaleChallSource(): boolean {
  return options.words.length === 0 && !options.wordListUrl && !options.wordListFile;
}

function externalManifestSource(): { name: string; url: string; license: string } | null {
  if (!options.wordListUrl && !options.wordListFile && !options.sourceName && !options.sourceUrl && !options.sourceLicense) {
    return null;
  }
  return {
    name: options.sourceName || "External word list",
    url: options.sourceUrl || options.wordListUrl || "",
    license: options.sourceLicense || "Unspecified"
  };
}

function uniqueLicenses(items: ImportedItem[]): string[] {
  return [
    ...new Set(
      items
        .map((item) => [item.license.name, item.license.url].filter(Boolean).join(" "))
        .filter(Boolean)
    )
  ].sort();
}

function summarizeSkips(skips: SkipRecord[]): Record<string, number> {
  return skips.reduce<Record<string, number>>((summary, skip) => {
    summary[skip.reason] = (summary[skip.reason] ?? 0) + 1;
    return summary;
  }, {});
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithRetry(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 5): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let retryDelayMs = 500 * attempt;
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("retry-after") ?? 0);
        retryDelayMs = Math.max(retryAfterSeconds * 1000, 2000 * attempt);
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < attempts) {
      await delay(retryDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function splitList(value: string): string[] {
  return value
    .split(/[;,，；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
