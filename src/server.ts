import { createApp } from "./app";
import { connectDatabase } from "./config/database";
import { env } from "./config/env";
import { warmUpVoices } from "./modules/tts/tts.service";

async function main() {
  await connectDatabase();
  const app = createApp();

  app.listen(env.port, () => {
    console.log(`[server] listening on http://localhost:${env.port}`);
    warmUpVoices();
  });
}

main().catch((err) => {
  console.error("[server] failed to start", err);
  process.exit(1);
});
