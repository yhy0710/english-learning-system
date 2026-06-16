import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "els-server-"));
  app = await buildApp({
    dbFile: join(dir, "test.sqlite"),
    assetsDir: join(dir, "assets"),
    logger: false
  });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("server API", () => {
  it("creates words and exposes due cards", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/words",
      payload: {
        word: "hello",
        phonetic: "/həˈləʊ/",
        definitionZh: "你好",
        definitionEn: "used as a greeting",
        example: "Hello there.",
        tags: ["basic"],
        audioFile: "hello.mp3"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toMatchObject({ word: "hello", audioMissing: true });

    const dueResponse = await app.inject({ method: "GET", url: "/reviews/due" });
    expect(dueResponse.statusCode).toBe(200);
    expect(dueResponse.json()).toHaveLength(1);
  });

  it("imports CSV and exports it back", async () => {
    const importResponse = await app.inject({
      method: "POST",
      url: "/imports/csv",
      payload: {
        csv: "word,phonetic,definition_zh,definition_en,example,tags,audio_file\nworld,/wɜːld/,世界,earth,hello world,basic,world.mp3"
      }
    });

    expect(importResponse.statusCode).toBe(200);
    expect(importResponse.json()).toMatchObject({ created: 1, missingAudio: 1 });

    const exportResponse = await app.inject({ method: "GET", url: "/exports/csv" });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.body).toContain("world");
  });

  it("reviews a due card and updates stats", async () => {
    await app.inject({
      method: "POST",
      url: "/words",
      payload: { word: "review", definitionZh: "复习" }
    });
    const due = await app.inject({ method: "GET", url: "/reviews/due" });
    const cardId = due.json()[0].card.id;

    const review = await app.inject({
      method: "POST",
      url: `/reviews/${cardId}`,
      payload: { rating: "good" }
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().card.reviewCount).toBe(1);

    const stats = await app.inject({ method: "GET", url: "/stats" });
    expect(stats.json()).toMatchObject({ totalWords: 1, reviewedToday: 1, retentionRate: 100 });
  });
});
