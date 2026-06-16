import { createReadStream, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ReviewRating, SyncChange, WordInput } from "@els/shared";
import { defaultAssetsDir, defaultDbFile, LearningDatabase, projectRoot } from "./database.js";

export interface BuildAppOptions {
  dbFile?: string;
  assetsDir?: string;
  webDistDir?: string;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  const database = new LearningDatabase({
    dbFile: options.dbFile ?? defaultDbFile(),
    assetsDir: options.assetsDir ?? defaultAssetsDir()
  });
  const webDistDir = resolve(options.webDistDir ?? join(projectRoot(), "apps", "web", "dist"));

  app.addHook("onClose", async () => {
    database.close();
  });

  await app.register(cors, { origin: true });

  if (existsSync(webDistDir)) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/"
    });
  }

  app.get("/health", async () => ({
    ok: true,
    app: "English Learning System",
    protocolVersion: 1,
    deviceId: database.deviceId,
    time: new Date().toISOString()
  }));

  app.get("/.well-known/elsync", async () => ({
    serviceType: "_elsync._tcp.local",
    serviceName: "English Learning System",
    protocolVersion: 1,
    deviceName: hostname(),
    pairingRequired: true,
    endpoints: ["/pair", "/sync/changes", "/sync/apply"]
  }));

  app.get("/words", async (request) => {
    const query = request.query as { search?: string };
    return database.listWords(query.search ?? "");
  });

  app.post("/words", async (request, reply) => {
    const word = database.createWord(request.body as WordInput);
    return reply.code(201).send(word);
  });

  app.patch("/words/:id", async (request) => {
    const params = request.params as { id: string };
    return database.updateWord(params.id, request.body as Partial<WordInput>);
  });

  app.delete("/words/:id", async (request, reply) => {
    const params = request.params as { id: string };
    database.deleteWord(params.id);
    return reply.code(204).send();
  });

  app.post("/imports/csv", async (request) => {
    const body = request.body as { csv?: string };
    return database.importCsv(body.csv ?? "");
  });

  app.get("/exports/csv", async (_request, reply) => {
    return reply.header("content-type", "text/csv; charset=utf-8").send(database.exportCsv());
  });

  app.get("/reviews/due", async (request) => {
    const query = request.query as { limit?: string };
    return database.dueCards(Number(query.limit ?? 20));
  });

  app.post("/reviews/:cardId", async (request) => {
    const params = request.params as { cardId: string };
    const body = request.body as { rating: ReviewRating };
    return database.reviewCard(params.cardId, body.rating);
  });

  app.get("/stats", async () => database.stats());

  app.get("/resource-packs", async () => database.listResourcePacks());

  app.post("/resource-packs", async (request, reply) => {
    const pack = database.addResourcePack(
      request.body as {
        name: string;
        version: string;
        sources: string[];
        licenses: string[];
        wordCount: number;
        audioCount: number;
      }
    );
    return reply.code(201).send(pack);
  });

  app.post("/pair", async (request, reply) => {
    const body = request.body as { deviceName?: string };
    return reply.code(201).send(database.pairDevice(body.deviceName ?? "Android Device"));
  });

  app.get("/sync/changes", async (request) => {
    const query = request.query as { since?: string };
    return database.changes(Number(query.since ?? 0));
  });

  app.post("/sync/apply", async (request) => {
    const body = request.body as { changes?: SyncChange[] };
    return database.applyChanges(body.changes ?? []);
  });

  app.get("/assets/:sha256", async (request, reply) => {
    const params = request.params as { sha256: string };
    const assetPath = database.assetPath(params.sha256);
    if (!assetPath) return reply.code(404).send({ message: "asset not found" });
    return reply.send(createReadStream(assetPath));
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const message = error instanceof Error ? error.message : "request failed";
    reply.code(400).send({
      message,
      code: "ELS_REQUEST_FAILED"
    });
  });

  return app;
}
