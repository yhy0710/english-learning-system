import { Bonjour } from "bonjour-service";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 5174);
const host = process.env.HOST ?? "0.0.0.0";

const app = await buildApp();

try {
  const bonjour = new Bonjour();
  bonjour.publish({
    name: "English Learning System",
    type: "elsync",
    protocol: "tcp",
    port,
    txt: {
      protocolVersion: "1",
      pairingRequired: "true"
    }
  });
  app.addHook("onClose", async () => bonjour.destroy());
} catch (error) {
  app.log.warn({ error }, "mDNS broadcast is not available; manual IP pairing remains supported");
}

await app.listen({ port, host });
