import { startProjectProvenanceServer } from './index.js';

const localServer = await startProjectProvenanceServer();
console.log(`Project Provenance local service: ${localServer.url}`);

async function shutdown(): Promise<void> {
  await localServer.close();
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
