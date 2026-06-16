import type { WordInput } from "./types.js";

export const WORD_CSV_COLUMNS = [
  "word",
  "phonetic",
  "definition_zh",
  "definition_en",
  "example",
  "tags",
  "audio_file"
] as const;

export type WordCsvColumn = (typeof WORD_CSV_COLUMNS)[number];
export type WordCsvRow = Record<WordCsvColumn, string>;

export function parseWordCsv(text: string): WordCsvRow[] {
  const rows = parseCsv(text.trim());
  if (rows.length === 0) return [];

  const header = rows[0].map((cell) => cell.trim());
  const columnIndexes = WORD_CSV_COLUMNS.map((column) => header.indexOf(column));

  return rows.slice(1).map((row) => {
    const record = {} as WordCsvRow;
    WORD_CSV_COLUMNS.forEach((column, index) => {
      const columnIndex = columnIndexes[index];
      record[column] = columnIndex >= 0 ? (row[columnIndex] ?? "").trim() : "";
    });
    return record;
  });
}

export function wordInputFromCsvRow(row: WordCsvRow): WordInput {
  return {
    word: row.word.trim(),
    phonetic: row.phonetic.trim(),
    definitionZh: row.definition_zh.trim(),
    definitionEn: row.definition_en.trim(),
    example: row.example.trim(),
    tags: normalizeTags(row.tags),
    audioFile: row.audio_file.trim(),
    source: "csv"
  };
}

export function wordsToCsvRows(words: WordInput[]): string {
  const rows = [
    WORD_CSV_COLUMNS,
    ...words.map((word) => [
      word.word,
      word.phonetic ?? "",
      word.definitionZh ?? "",
      word.definitionEn ?? "",
      word.example ?? "",
      (word.tags ?? []).join(";"),
      word.audioFile ?? ""
    ])
  ];
  return stringifyCsv(rows);
}

export function normalizeTags(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const values = Array.isArray(input) ? input : input.split(/[;,，；]/);
  return [...new Set(values.map((tag) => tag.trim()).filter(Boolean))];
}

export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

function parseCsv(text: string): string[][] {
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

    if (char === "," && !inQuotes) {
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
  return rows.filter((entry) => entry.some((cellValue) => cellValue.trim().length > 0));
}

function stringifyCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
