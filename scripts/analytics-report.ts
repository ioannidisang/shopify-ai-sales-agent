import { readEnv } from '../apps/server/src/config.js';
import { openDatabase } from '../apps/server/src/database.js';
const shop=process.argv[2];
const env=readEnv();
if(!shop||!env.allowedShops.includes(shop))throw new Error('Usage: pnpm analytics:report <allowlisted-shop>.myshopify.com');
const db=await openDatabase(env.databaseUrl);
try {
  const result=await db.query(`SELECT experiment_id,assignment,name,source,count(*)::int AS events,count(DISTINCT conversation_id)::int AS conversations FROM events WHERE shop=$1 GROUP BY experiment_id,assignment,name,source ORDER BY experiment_id,assignment,name`,[shop]);
  console.table(result.rows);
  console.log('Observed events only. Checkout completed is not paid-order settlement. Do not infer uplift before cross-domain attribution and consent coverage are verified.');
}finally{await db.close();}
