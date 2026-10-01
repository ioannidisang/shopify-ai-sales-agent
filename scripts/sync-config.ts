import { readTenantFiles, readEnv } from '../apps/server/src/config.js';
import { openDatabase } from '../apps/server/src/database.js';
const shop=process.argv[2];
if(!shop)throw new Error('Usage: pnpm config:sync <shop>.myshopify.com');
const env=readEnv();
if(!env.allowedShops.includes(shop))throw new Error('Shop is not allowlisted');
const {config,facts}=await readTenantFiles(shop);
const db=await openDatabase(env.databaseUrl);
try {
  const result=await db.query('UPDATE shops SET config=$2,facts=$3 WHERE shop=$1 AND active=true RETURNING shop',[shop,JSON.stringify(config),JSON.stringify(facts)]);
  if(!result.rows.length)throw new Error('Shop is not installed; complete OAuth first');
  console.log(`Synced ${shop}: ${facts.length} fact records, knowledge version ${config.knowledgeVersion}.`);
}finally{await db.close();}
