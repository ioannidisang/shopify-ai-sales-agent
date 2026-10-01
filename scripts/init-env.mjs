import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if(existsSync('.env')) { console.log('.env already exists; left unchanged.'); process.exit(0); }
const template=readFileSync('.env.example','utf8')
 .replace(/^ENCRYPTION_KEY=$/m,`ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`)
 .replace(/^SESSION_SECRET=$/m,`SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
writeFileSync('.env',template,{flag:'wx',mode:0o600});
console.log('Created ignored .env with independent local encryption/session keys. Add Shopify/OpenAI credentials locally. No credentials printed.');
