import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/server/src/app.js';
import { openDatabase, migrate, takeBudget, purgeExpired } from '../apps/server/src/database.js';
import { MEDICAL_HISTORY_MARKER } from '../packages/core/src/index.js';
import { Security } from '../apps/server/src/security.js';
import type { ShopConfig, Planner, Catalog } from '../packages/core/src/types.js';

const shop = 'ym5fhx-fa.myshopify.com';
const secondShop = 'second.myshopify.com';
const apiSecret = 'shopify-test-secret'.repeat(3);
const env = { port: 3000, appUrl: 'https://test.example', allowedShops: [shop,secondShop], apiKey: 'test-client-key', apiSecret, sessionSecret: 'session-secret'.repeat(4), encryptionKey: randomBytes(32).toString('base64'), openaiKey: undefined, openaiModel: undefined, databaseUrl: undefined };
const security = new Security(env.sessionSecret,env.encryptionKey);
const config: ShopConfig = { shop, brand:'Nutri Tiger',locale:'el',allowedCountries:['GR','CY'],enabled:true,experiment:{id:'v1',enabled:true,treatmentPercent:100},approvedImageUrls:[],knowledgeVersion:'empty-v1' };
const planner: Planner = { plan: async () => ({intent:'greeting',searchQuery:'',productIds:[],factIds:[],variantId:null,quantity:null}) };
const catalog: Catalog = { search:async()=>[],getProducts:async()=>[],getVariant:async()=>null };
const db = await openDatabase(undefined,'memory://');
const app = await buildApp(env,db,{planner,catalog:()=>catalog});

function proxy(path:string, tenant=shop, stamp=String(Math.floor(Date.now()/1000))) {
  const values: Record<string,string>={shop:tenant,timestamp:stamp,path_prefix:'/apps/sales-agent',logged_in_customer_id:''};
  const message=Object.keys(values).sort().map(k=>`${k}=${values[k]}`).join('');
  const params=new URLSearchParams(values); params.set('signature',createHmac('sha256',apiSecret).update(message).digest('hex'));
  return `/proxy/${path}?${params}`;
}
async function bootstrap(consent=true,tenant=shop,visitorId=randomUUID()) {
  const result=await app.inject({method:'POST',url:proxy('bootstrap',tenant),payload:{visitorId,analyticsConsent:consent,country:'GR',locale:'el'}});
  expect(result.statusCode).toBe(200); return result.json() as {token:string;conversationId:string;assignment:string;experimentId:string};
}

beforeAll(async()=>{
  await migrate(db);
  for (const tenant of [shop,secondShop]) await db.query('INSERT INTO shops(shop,config,credentials,facts) VALUES($1,$2,$3,$4)',[tenant,JSON.stringify({...config,shop:tenant}),security.encrypt({storefrontToken:'test'},tenant),'[]']);
});
afterAll(async()=>{await app.close();await db.close();});

describe('server integration with real PostgreSQL engine and Shopify HMAC verification',()=>{
  it('bridges an allowlisted application-url launch into secure OAuth without forwarding other parameters',async()=>{
    const launch=await app.inject(`/?shop=${shop}&return_to=https://untrusted.example&hmac=untrusted`);
    expect(launch.statusCode).toBe(302);
    expect(launch.headers.location).toBe(`/auth?shop=${shop}`);
    const auth=await app.inject({url:launch.headers.location!,headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'}});
    expect(auth.statusCode).toBe(302);
    expect(new URL(auth.headers.location!).origin).toBe(`https://${shop}`);
    expect(auth.cookies.some(cookie=>cookie.name==='shopify_app_state'&&cookie.secure)).toBe(true);
    expect((await app.inject('/')).statusCode).toBe(200);
    expect((await app.inject('/?shop=unknown.myshopify.com')).statusCode).toBe(403);
    expect((await app.inject(`/?shop=${shop}&shop=${secondShop}`)).statusCode).toBe(400);
    expect((await app.inject('/?shop=https://untrusted.example')).statusCode).toBe(400);
  });
  it('keeps provider health checks available after a client exhausts its traffic bucket',async()=>{
    const isolated=await buildApp(env,db,{planner,catalog:()=>catalog});
    try {
      for(let i=0;i<240;i++) expect((await isolated.inject('/')).statusCode).toBe(200);
      expect((await isolated.inject('/')).statusCode).toBe(429);
      expect((await isolated.inject('/healthz')).statusCode).toBe(200);
      expect((await isolated.inject('/readyz')).statusCode).toBe(200);
    } finally { await isolated.close(); }
  });
  it('runs health but rejects unsigned, stale, duplicated and uninstalled proxy shops',async()=>{
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    const payload={analyticsConsent:false,country:'GR',locale:'el'};
    for (const url of ['/proxy/bootstrap?shop='+shop,proxy('bootstrap',shop,'1'),proxy('bootstrap')+'&shop='+secondShop,proxy('bootstrap','unknown.myshopify.com')]) {
      const r=await app.inject({method:'POST',url,payload});expect([401,403]).toContain(r.statusCode);
    }
  });
  it('isolates conversation across tenants and rejects market switching',async()=>{
    const s=await bootstrap();
    const body={token:s.token,message:'hello',country:'GR',locale:'el'};
    expect((await app.inject({method:'POST',url:proxy('chat',secondShop),payload:body})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:proxy('chat'),payload:{...body,country:'CY'}})).statusCode).toBe(400);
    const reply=await app.inject({method:'POST',url:proxy('chat'),payload:body});
    expect(reply.statusCode).toBe(200);expect(reply.json().products).toEqual([]);
    const stored=await db.query<{history:string}>('SELECT history FROM conversations WHERE shop=$1 AND id=$2',[shop,s.conversationId]);
    expect(stored.rows[0]!.history).not.toContain('hello');
  });
  it('does not store analytics without consent, deduplicates events, rejects free-text metadata',async()=>{
    const s=await bootstrap(false);expect(s.assignment).toBe('untracked');
    const event={id:randomUUID(),name:'assistant_open'};
    expect((await app.inject({method:'POST',url:proxy('events'),payload:{token:s.token,events:[event]}})).statusCode).toBe(204);
    expect((await db.query('SELECT id FROM events WHERE conversation_id=$1',[s.conversationId])).rows).toHaveLength(0);
    const consented=await bootstrap();
    for(let i=0;i<2;i++) await app.inject({method:'POST',url:proxy('events'),payload:{token:consented.token,events:[event]}});
    expect((await db.query('SELECT id FROM events WHERE conversation_id=$1',[consented.conversationId])).rows).toHaveLength(1);
    const invalid=await app.inject({method:'POST',url:proxy('events'),payload:{token:consented.token,events:[{...event,message:'health details'}]}});
    expect(invalid.statusCode).toBe(400);
  });
  it('keeps medical follow-up boundaries without storing the disclosed health details',async()=>{
    const s=await bootstrap(false);
    const send=(message:string)=>app.inject({method:'POST',url:proxy('chat'),payload:{token:s.token,message,country:'GR',locale:'el'}});
    const response=await send('I am pregnant and taking medication, recommend a supplement');
    expect(response.statusCode).toBe(200);expect(response.json().policy).toBeUndefined();
    const row=await db.query<{history:string}>('SELECT history FROM conversations WHERE shop=$1 AND id=$2',[shop,s.conversationId]);
    const history=security.decrypt<{role:string;content:string}[]>(row.rows[0]!.history,shop);
    expect(history[0]!.content).toBe(MEDICAL_HISTORY_MARKER);
    expect(JSON.stringify(history)).not.toContain('pregnant');
    expect((await send('yes')).json().products).toEqual([]);
  });
  it('purges expired conversation content without dropping the independent attribution window',async()=>{
    const s=await bootstrap();
    await db.query("UPDATE conversations SET expires_at=now()-interval '1 second' WHERE shop=$1 AND id=$2",[shop,s.conversationId]);
    await purgeExpired(db);
    expect((await db.query('SELECT id FROM conversations WHERE shop=$1 AND id=$2',[shop,s.conversationId])).rows).toHaveLength(0);
    expect((await app.inject({method:'POST',url:proxy('chat'),payload:{token:s.token,message:'hello',country:'GR',locale:'el'}})).statusCode).toBe(401);
  });
  it('links checkout to consented assignment, deduplicates purchase by order, revokes linking',async()=>{
    const s=await bootstrap();const clientId=randomUUID();
    const send=(event:unknown)=>app.inject({method:'POST',url:'/api/pixel/events',payload:{shop,ingestKey:security.pixelKey(shop),event}});
    expect((await send({id:randomUUID(),name:'experiment_exposure',clientId,conversationId:s.conversationId,experimentId:s.experimentId,assignment:s.assignment})).statusCode).toBe(204);
    for(const orderId of ['1234','gid://shopify/Order/1234']) expect((await send({id:randomUUID(),name:'purchase',clientId,orderId})).statusCode).toBe(204);
    const purchases=await db.query<{id:string}>('SELECT id FROM events WHERE conversation_id=$1 AND name=$2',[s.conversationId,'purchase']);
    expect(purchases.rows).toHaveLength(1);expect(purchases.rows[0]!.id).toMatch(/^purchase:[a-f0-9]{64}$/);
    await app.inject({method:'POST',url:proxy('consent'),payload:{token:s.token,analyticsConsent:false}});
    await send({id:randomUUID(),name:'checkout_started',clientId});
    expect((await db.query('SELECT id FROM events WHERE conversation_id=$1 AND name=$2',[s.conversationId,'checkout_started'])).rows).toHaveLength(0);
  });
  it('withdraws every known experiment mapping for a client and prevents an old session from relinking',async()=>{
    const older=await bootstrap();const current=await bootstrap();const clientId=randomUUID();
    const hash=security.hashClient(shop,clientId);
    await db.query('UPDATE conversations SET experiment_id=$3 WHERE shop=$1 AND id=$2',[shop,older.conversationId,'older-v0']);
    for(const [id,experimentId] of [[older.conversationId,'older-v0'],[current.conversationId,current.experimentId]]) {
      await db.query("INSERT INTO pixel_assignments(shop,client_hash,experiment_id,assignment,conversation_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 day')",[shop,hash,experimentId,'assistant',id]);
    }
    await app.inject({method:'POST',url:proxy('consent'),payload:{token:current.token,analyticsConsent:false}});
    expect((await db.query('SELECT client_hash FROM pixel_assignments WHERE shop=$1 AND client_hash=$2',[shop,hash])).rows).toHaveLength(0);
    const response=await app.inject({method:'POST',url:'/api/pixel/events',payload:{shop,ingestKey:security.pixelKey(shop),event:{id:randomUUID(),name:'experiment_exposure',clientId,conversationId:older.conversationId,experimentId:'older-v0',assignment:'assistant'}}});
    expect(response.statusCode).toBe(204);
    expect((await db.query('SELECT client_hash FROM pixel_assignments WHERE shop=$1 AND client_hash=$2',[shop,hash])).rows).toHaveLength(0);
    expect((await db.query<{consent:boolean}>('SELECT consent FROM conversations WHERE shop=$1 AND id=$2',[shop,older.conversationId])).rows[0]!.consent).toBe(false);
  });
  it('withdraws older sessions for the same visitor after their pixel mapping was replaced',async()=>{
    const visitorId=randomUUID();const older=await bootstrap(true,shop,visitorId);const current=await bootstrap(true,shop,visitorId);const clientId=randomUUID();
    const expose=(s:typeof current)=>app.inject({method:'POST',url:'/api/pixel/events',payload:{shop,ingestKey:security.pixelKey(shop),event:{id:randomUUID(),name:'experiment_exposure',clientId,conversationId:s.conversationId,experimentId:s.experimentId,assignment:s.assignment}}});
    await expose(older);await expose(current);
    await app.inject({method:'POST',url:proxy('consent'),payload:{token:current.token,analyticsConsent:false}});
    await expose(older);
    expect((await db.query('SELECT client_hash FROM pixel_assignments WHERE shop=$1 AND client_hash=$2',[shop,security.hashClient(shop,clientId)])).rows).toHaveLength(0);
    expect((await db.query<{consent:boolean}>('SELECT consent FROM conversations WHERE shop=$1 AND id=$2',[shop,older.conversationId])).rows[0]!.consent).toBe(false);
  });
  it('allows revocation of the checkout mapping after conversation expiry without extending chat access',async()=>{
    const s=await bootstrap();const hash=security.hashClient(shop,randomUUID());
    await db.query("INSERT INTO pixel_assignments(shop,client_hash,experiment_id,assignment,conversation_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 day')",[shop,hash,s.experimentId,'assistant',s.conversationId]);
    await db.query('DELETE FROM conversations WHERE shop=$1 AND id=$2',[shop,s.conversationId]);
    const expired=security.sign({...security.verify(s.token,shop),exp:Math.floor(Date.now()/1000)-3600});
    expect((await app.inject({method:'POST',url:proxy('chat'),payload:{token:expired,message:'hello',country:'GR',locale:'el'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:proxy('consent'),payload:{token:expired,analyticsConsent:false}})).statusCode).toBe(204);
    expect((await db.query('SELECT client_hash FROM pixel_assignments WHERE shop=$1 AND client_hash=$2',[shop,hash])).rows).toHaveLength(0);
  });
  it('enforces shared budget atomically during parallel requests',async()=>{
    const results=await Promise.all(Array.from({length:20},()=>takeBudget(db,shop,'test-limit',5)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
  it('verifies raw webhook signature and disables installation idempotently',async()=>{
    const payload=JSON.stringify({shop_domain:secondShop});const id=randomUUID();
    const headers={'content-type':'application/json','x-shopify-shop-domain':secondShop,'x-shopify-topic':'app/uninstalled','x-shopify-webhook-id':id,'x-shopify-hmac-sha256':createHmac('sha256',apiSecret).update(payload).digest('base64')};
    expect((await app.inject({method:'POST',url:'/webhooks',headers:{...headers,'x-shopify-hmac-sha256':'bad'},payload})).statusCode).toBe(401);
    for(let n=0;n<2;n++) expect((await app.inject({method:'POST',url:'/webhooks',headers,payload})).statusCode).toBe(200);
    const row=await db.query<{active:boolean;credentials:string}>('SELECT active,credentials FROM shops WHERE shop=$1',[secondShop]);
    expect(row.rows[0]).toEqual({active:false,credentials:''});
  });
  it('conservatively purges unlinked shopper context and analytics on a verified customer erasure',async()=>{
    await bootstrap();
    const payload=JSON.stringify({shop_domain:shop,customer:{id:123},orders_to_redact:[]});
    const headers={'content-type':'application/json','x-shopify-shop-domain':shop,'x-shopify-topic':'customers/redact','x-shopify-webhook-id':randomUUID(),'x-shopify-hmac-sha256':createHmac('sha256',apiSecret).update(payload).digest('base64')};
    expect((await app.inject({method:'POST',url:'/webhooks',headers,payload})).statusCode).toBe(200);
    for(const table of ['conversations','pixel_assignments','events']) expect((await db.query(`SELECT shop FROM ${table} WHERE shop=$1`,[shop])).rows).toHaveLength(0);
    expect((await db.query<{active:boolean}>('SELECT active FROM shops WHERE shop=$1',[shop])).rows[0]!.active).toBe(true);
  });
});
