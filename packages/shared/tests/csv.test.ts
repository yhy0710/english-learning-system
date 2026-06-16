import { describe, expect, it } from "vitest";
import { parseWordCsv, wordInputFromCsvRow, wordsToCsvRows } from "../src/csv";

describe("word CSV", () => {
  it("parses required word columns", () => {
    const rows = parseWordCsv(
      'word,phonetic,definition_zh,definition_en,example,tags,audio_file\n"hello",/həˈləʊ/,你好,used as a greeting,"hello, world",greeting;basic,hello.mp3'
    );

    expect(rows).toHaveLength(1);
    expect(wordInputFromCsvRow(rows[0])).toMatchObject({
      word: "hello",
      tags: ["greeting", "basic"],
      audioFile: "hello.mp3"
    });
  });

  it("exports escaped CSV cells", () => {
    const csv = wordsToCsvRows([
      {
        word: "hello",
        definitionZh: "你好",
        example: "hello, world",
        tags: ["basic"]
      }
    ]);

    expect(csv).toContain('"hello, world"');
  });
});
