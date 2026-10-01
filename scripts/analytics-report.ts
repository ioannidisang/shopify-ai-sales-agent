import { pathToFileURL } from 'node:url';
import { readEnv } from '../apps/server/src/config.js';
import { openDatabase, type Database } from '../apps/server/src/database.js';

export async function experimentReport(db: Database, shop: string) {
  // Include every consented visitor enrolled by bootstrap, whether or not they open the assistant.
  const cohorts = await db.query(`SELECT x.experiment_id,x.assignment,x.config_fingerprint,
    count(DISTINCT x.visitor_hash)::int AS eligible_visitors,
    count(DISTINCT CASE WHEN e.name='assistant_open' THEN x.visitor_hash END)::int AS visitors_opened,
    count(DISTINCT CASE WHEN e.name='add_to_cart' THEN x.visitor_hash END)::int AS visitors_added_to_cart,
    count(DISTINCT CASE WHEN e.name='purchase' THEN x.visitor_hash END)::int AS visitors_checkout_completed,
    count(DISTINCT CASE WHEN e.name='purchase' THEN e.id END)::int AS checkout_completions,
    round(100.0*count(DISTINCT CASE WHEN e.name='purchase' THEN x.visitor_hash END)/NULLIF(count(DISTINCT x.visitor_hash),0),4) AS observed_checkout_completion_percent
    FROM eligible_exposures x LEFT JOIN events e ON e.shop=x.shop AND e.experiment_id=x.experiment_id AND e.assignment=x.assignment
      AND e.visitor_hash=x.visitor_hash AND e.created_at>=x.created_at
    WHERE x.shop=$1 GROUP BY x.experiment_id,x.assignment,x.config_fingerprint ORDER BY x.experiment_id,x.assignment`, [shop]);
  const checkoutValues = await db.query(`SELECT e.experiment_id,e.assignment,e.metadata->>'currency' AS currency,
    count(*)::int AS checkout_completions_with_value,sum((e.metadata->>'totalAmount')::numeric) AS observed_checkout_value
    FROM events e JOIN eligible_exposures x ON x.shop=e.shop AND x.experiment_id=e.experiment_id AND x.visitor_hash=e.visitor_hash AND x.assignment=e.assignment AND e.created_at>=x.created_at
    WHERE e.shop=$1 AND e.name='purchase' AND e.metadata ? 'currency' AND e.metadata ? 'totalAmount'
    GROUP BY e.experiment_id,e.assignment,e.metadata->>'currency' ORDER BY e.experiment_id,e.assignment,currency`, [shop]);
  const usage = await db.query(`SELECT experiment_id,assignment,provider,model,knowledge_version,config_fingerprint,operation,
    sum(requests) AS requests,sum(successful_requests) AS successful_requests,sum(input_tokens) AS input_tokens,
    sum(output_tokens) AS output_tokens,sum(unknown_token_requests) AS unknown_token_requests,
    round(sum(duration_ms)::numeric/NULLIF(sum(requests),0)) AS average_request_ms
    FROM model_usage WHERE shop=$1 GROUP BY experiment_id,assignment,provider,model,knowledge_version,config_fingerprint,operation ORDER BY experiment_id,assignment,provider,model,operation`, [shop]);
  return { cohorts: cohorts.rows, checkoutValues: checkoutValues.rows, usage: usage.rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shop = process.argv[2]; const env = readEnv();
  if (!shop || !env.allowedShops.includes(shop)) throw new Error('Usage: pnpm analytics:report <allowlisted-shop>.myshopify.com');
  const db = await openDatabase(env.databaseUrl);
  try {
    const result = await experimentReport(db, shop);
    console.log('Consented visitor cohorts, retained up to 90 days; repeat sessions count once.');
    console.table(result.cohorts);
    console.log('Observed checkout values, separate per currency; not paid or net revenue.');
    console.table(result.checkoutValues);
    console.log('Operational model totals contain no shopper identifiers. Unknown token usage is not zero cost.');
    console.table(result.usage);
    console.log('Descriptive results only: client-reported checkout completion is not verified payment. Consent withdrawal removes linked analytics and changes cohorts. Cross-domain attribution, consent coverage and sample size must be validated before assessing uplift or ROI.');
  } finally { await db.close(); }
}
