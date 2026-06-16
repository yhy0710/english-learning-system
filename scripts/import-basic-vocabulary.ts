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
  definitionEn: string;
  example: string;
  partOfSpeech: string;
  audioFile: string;
  audioUrl: string;
  audioSha256: string;
  license: AudioLicense;
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
} else {
  console.log(`Downloading basic word list from ${DALE_CHALL_URL}`);
}
const candidateWords = options.words.length > 0 ? options.words : await fetchDaleChallCandidates(options.offset);

console.log(`Found ${candidateWords.length} candidate words after offset ${options.offset}`);
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
  for (const word of candidateWords) {
    if (report.imported.length >= options.limit) break;

    const normalized = normalizeWord(word);
    if (!isImportableWord(normalized)) {
      report.skipped.push({ word, reason: "unsupported word shape" });
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
      tags: mergedTags(existing?.id, meaning.partOfSpeech),
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
      definitionEn: input.definitionEn ?? "",
      example: input.example ?? "",
      partOfSpeech: meaning.partOfSpeech,
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
    `Done. Created ${report.created}, updated ${report.updated}, audio saved ${report.imported.length}, skipped ${report.skipped.length}.`
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
    words: []
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
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (parsed.words.length > 0) {
    if (!limitProvided) parsed.limit = parsed.words.length;
    if (!packSlugProvided) parsed.packSlug = `pronunciation-backfill-${today}`;
    if (!packNameProvided) parsed.packName = BACKFILL_PACK_NAME;
    if (!sourceIdProvided) parsed.sourceId = BACKFILL_SOURCE_ID;
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
  console.log(`Usage: npm run import:basic-vocabulary -- [options]

Options:
  --limit <number>       Number of words with saved audio to import. Default: ${DEFAULT_LIMIT}
  --offset <number>      Skip this many Dale-Chall entries before collecting. Default: 0
  --db-file <path>       SQLite database path. Default: data/english-learning.sqlite
  --assets-dir <path>    Assets root path. Default: assets
  --pack-slug <slug>     Resource pack directory name. Default: basic-dale-chall-foundation-YYYY-MM-DD
  --pack-name <name>     Resource pack display name
  --source-id <id>       Source id written to imported audio assets
  --words <csv>          Comma-separated words to import instead of the Dale-Chall list
`);
  process.exit(0);
}

async function fetchDaleChallCandidates(offset: number): Promise<string[]> {
  const wordListSource = await fetchText(DALE_CHALL_URL);
  return parseDaleChallWords(wordListSource).slice(offset);
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
  const response = await fetchWithRetry(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) return null;
  return (await response.json()) as DictionaryEntry[];
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
  const response = await fetchWithRetry(`${COMMONS_API_ENDPOINT}?${params}`, {
    headers: { "user-agent": USER_AGENT }
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
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
  const response = await fetchWithRetry(`${COMMONS_API_ENDPOINT}?${searchParams}`, {
    headers: { "user-agent": USER_AGENT }
  });
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

function mergedTags(existingId: string | undefined, partOfSpeech: string): string[] {
  const existingTags = existingId ? database.getWord(existingId)?.tags ?? [] : [];
  return [...new Set([...existingTags, ...itemTags(partOfSpeech)])];
}

function wordSource(existingId: string | undefined): string {
  if (!existingId || options.words.length === 0) return options.sourceId;
  return database.getWord(existingId)?.source ?? options.sourceId;
}

function itemTags(partOfSpeech: string): string[] {
  return [
    ...(options.words.length > 0 ? ["pronunciation-backfill"] : ["basic", "dale-chall"]),
    partOfSpeech ? `pos:${partOfSpeech}` : ""
  ].filter(Boolean);
}

async function saveAudio(
  word: string,
  audio: PhoneticEntry
): Promise<{ relativePath: string; audioUrl: string; sha256: string } | null> {
  const audioUrl = normalizeAudioUrl(audio.audio ?? "");
  if (!audioUrl) return null;

  const response = await fetchWithRetry(audioUrl, { headers: { "user-agent": USER_AGENT } });
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
    audioCount: report.imported.length,
    sources: manifestSources(),
    licenses: uniqueLicenses(report.imported),
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
    definitionZh: "",
    example: item.example,
    tags: itemTags(item.partOfSpeech),
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
    audioCount: report.imported.length
  });
}

function manifestSources(): { name: string; url: string; license: string }[] {
  return [
    ...(options.words.length === 0
      ? [
          {
            name: "words/dale-chall",
            url: "https://github.com/words/dale-chall",
            license: "MIT"
          }
        ]
      : []),
    {
      name: "Free Dictionary API",
      url: "https://dictionaryapi.dev/",
      license: "API data includes per-pronunciation source and license metadata"
    }
  ];
}

function resourcePackSources(): string[] {
  return [...(options.words.length === 0 ? ["words/dale-chall"] : []), "Free Dictionary API"];
}

function resourcePackLicenses(items: ImportedItem[]): string[] {
  return [...(options.words.length === 0 ? ["words/dale-chall: MIT"] : []), ...uniqueLicenses(items)];
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

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await delay(500 * attempt);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
