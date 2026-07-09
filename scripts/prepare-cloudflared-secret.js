import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from '../src/config.js';

await loadEnvFile();

const token = String(process.env.CLOUDFLARE_TUNNEL_TOKEN ?? '').trim();
if (!token) {
  throw new Error('CLOUDFLARE_TUNNEL_TOKEN is required to prepare the cloudflared secret.');
}

const secretDir = path.resolve(process.cwd(), '.secrets');
const secretPath = path.join(secretDir, 'cloudflare_tunnel_token');
await mkdir(secretDir, { recursive: true, mode: 0o700 });
await writeFile(secretPath, `${token}\n`, { mode: 0o600 });
await chmod(secretPath, 0o600);
console.log(`Prepared ${path.relative(process.cwd(), secretPath)} for the cloudflared service.`);
