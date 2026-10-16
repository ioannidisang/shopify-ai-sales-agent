import { access, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Read-only public-source intake. This never loads credentials, approves facts,
// imports knowledge, or reads/writes a store configuration.
const ORIGIN = 'https://bionera.gr';
const SHOP = 'bionera-gr.myshopify.com';
const root = path.resolve(process.argv[2] ?? '.data/bionera-full-2026-10-16');
const intakeBase = path.resolve('.data');
if (!root.startsWith(intakeBase + path.sep)) throw new Error('Intake output must remain inside the ignored .data directory');
try {
  await access(path.join(root, 'normalized-products.json'));
  throw new Error('Completed intake exists; choose a new output folder to preserve reviewed source hashes');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PRODUCTS = 250;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', bull: '•', hellip: '…', copy: '©', reg: '®', trade: '™', times: '×', micro: 'µ', plusmn: '±', middot: '·', le: '≤', ge: '≥', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', thinsp: ' ', ensp: ' ', emsp: ' ' };
const decode = value => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
  if (name.startsWith('#')) {
    const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  }
  return entities[name.toLowerCase()] ?? all;
});

function sourceUrl(input) {
  const u = new URL(input, ORIGIN);
  if (u.origin !== ORIGIN || u.username || u.password || u.hash) throw new Error('Unexpected source origin');
  return u.href;
}

async function get(input) {
  const url = sourceUrl(input);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'text/html,application/json,application/xml;q=0.9', 'User-Agent': 'BioneraMerchantKnowledgeReview/1.0' } });
  if (!response.ok) throw new Error(`Public source returned ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('Public source too large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('Public source too large');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return { url, retrievedAt: new Date().toISOString(), sha256: sha256(buffer), bytes, content: buffer.toString('utf8') };
}

function parseHtml(input) {
  // Small, non-executing tree reader for this site's server-rendered HTML.
  // Script/style bodies and comments are removed before tokenization.
  const html = input.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const document = { tag: '#document', attrs: {}, children: [] };
  const stack = [document];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const match of html.matchAll(/<\/?[a-zA-Z][^>]*>|[^<]+/g)) {
    const token = match[0];
    if (!token.startsWith('<')) { stack.at(-1).children.push({ tag: '#text', text: decode(token) }); continue; }
    const closing = /^<\//.test(token);
    const tag = token.match(/^<\/?([a-zA-Z][\w:-]*)/)?.[1].toLowerCase();
    if (!tag) continue;
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const attrs = {};
    const attrText = token.slice(token.indexOf(tag) + tag.length, token.length - 1);
    for (const a of attrText.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return document;
}

const classes = node => (node.attrs?.class ?? '').split(/\s+/);
const hasClass = (node, cls) => classes(node).includes(cls);
function findAll(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, found);
  return found;
}
function omit(node) {
  if (['script', 'style', 'noscript', 'svg', 'form', 'button', 'select', 'input', 'img', 'picture', 'video', 'audio', 'iframe'].includes(node.tag)) return true;
  const markers = `${node.attrs?.class ?? ''} ${node.attrs?.id ?? ''} ${node.attrs?.['data-block-id'] ?? ''}`;
  return /jdgm|judge.?me|review|price|cart|payment|buy_buttons|quantity|selling-plan|product-form|newsletter|product__promo|product__gallery|product__media|pickup-availability/i.test(markers);
}
function textOf(node) {
  if (node.tag === '#text') return node.text;
  if (omit(node)) return '';
  const block = /^(?:p|div|section|h[1-6]|li|ul|ol|table|tr|td|th|summary|details|collapsible-section)$/.test(node.tag);
  return (block ? '\n' : '') + (node.tag === 'br' ? '\n' : '') + (node.children ?? []).map(textOf).join('') + (block ? '\n' : '');
}
const clean = text => text.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const normText = node => clean(textOf(node));

function pageContent(html) {
  const tree = parseHtml(html);
  const main = findAll(tree, n => n.tag === 'main')[0];
  if (!main) throw new Error('Missing public main content boundary');
  const sections = [];
  for (const section of main.children.filter(n => n.tag === 'section' && (n.attrs.id ?? '').startsWith('shopify-section-'))) {
    const id = section.attrs.id;
    if (/__separator_|__grid_view_|__newsletter_|__related_products_|__product_recommendations_|__recently_viewed_|__featured_collection_/i.test(id) || hasClass(section, 'wt-apps')) continue;
    const titleNodes = findAll(section, n => /^h[1-6]$/.test(n.tag));
    const headings = [...new Set(titleNodes.map(normText).filter(Boolean))];
    const sourceText = normText(section);
    if (!sourceText) continue;
    if (/[€$]/.test(sourceText) && /__features_banner_/.test(id)) continue; // Shared delivery/payment promotion, not product evidence.
    if (/[€$]/.test(sourceText) || /jdgm|reviewBody|data-review-id/.test(sourceText)) throw new Error(`Excluded commerce/review content reached snapshot in ${id}; currency=${/[€$]/.test(sourceText)}`);
    const tables = findAll(section, n => hasClass(n, 'hero__table__row') || n.tag === 'tr').map(row => {
      const cells = (row.children ?? []).filter(n => hasClass(n, 'hero__table__cell') || ['td', 'th'].includes(n.tag));
      return cells.map(normText).filter(Boolean);
    }).filter(cells => cells.length);
    const accordions = findAll(section, n => n.tag === 'collapsible-section').map(n => ({
      heading: normText(findAll(n, c => hasClass(c, 'wt-collapse__trigger__title'))[0] ?? { children: [] }),
      text: normText(findAll(n, c => hasClass(c, 'wt-collapse__target'))[0] ?? { children: [] }),
    })).filter(n => n.text);
    const links = [...new Set(findAll(section, n => n.tag === 'a' && n.attrs.href).map(n => n.attrs.href).filter(href => /^\/(?:pages|blogs|products)\//.test(href) || /^https:\/\/bionera\.gr\/(?:pages|blogs|products)\//.test(href)).map(href => new URL(href, ORIGIN).href))];
    sections.push({ sectionId: id, headings, sourceText, tables, accordions, links });
  }
  const canonical = findAll(tree, n => n.tag === 'link' && n.attrs.rel === 'canonical')[0]?.attrs.href;
  return { canonical, sections };
}

const refs = xml => [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map(m => decode(m[1].trim()));
function safeProduct(p) {
  if (!Number.isSafeInteger(p.id) || !/^[a-z0-9-]+$/.test(p.handle) || typeof p.title !== 'string') throw new Error('Invalid public product identity');
  return {
    id: `gid://shopify/Product/${p.id}`, handle: p.handle, title: p.title,
    productType: p.type ?? p.product_type ?? '', vendor: p.vendor ?? '',
    descriptionText: normText(parseHtml(p.description ?? p.body_html ?? '')),
    variants: (p.variants ?? []).map(v => {
      if (!Number.isSafeInteger(v.id)) throw new Error('Invalid public variant identity');
      return { id: `gid://shopify/ProductVariant/${v.id}`, title: v.title, options: [v.option1, v.option2, v.option3].filter(x => typeof x === 'string') };
    }),
    imageSources: [...new Set((p.images ?? []).map(image => typeof image === 'string' ? image : image.src).filter(Boolean).map(src => new URL(src, ORIGIN).href))],
  };
}

await mkdir(path.join(root, 'sources'), { recursive: true });
const startedAt = new Date().toISOString();
const index = await get('/sitemap.xml');
await writeFile(path.join(root, 'sources/sitemap.xml'), index.content);
const productMaps = refs(index.content).filter(url => /^https:\/\/bionera\.gr\/sitemap_products_\d+\.xml(?:\?|$)/.test(url));
if (!productMaps.length || productMaps.length > 10) throw new Error('Unexpected sitemap count');
const sitemapProducts = new Set();
const sourceManifest = [{ kind: 'sitemap_index', ...index, content: undefined, snapshot: 'sources/sitemap.xml' }];
for (let i = 0; i < productMaps.length; i++) {
  const map = await get(productMaps[i]);
  const file = `sources/sitemap-products-${i + 1}.xml`;
  await writeFile(path.join(root, file), map.content);
  sourceManifest.push({ kind: 'product_sitemap', ...map, content: undefined, snapshot: file });
  for (const url of refs(map.content)) {
    const match = /^https:\/\/bionera\.gr\/products\/([a-z0-9-]+)$/.exec(url);
    if (match) sitemapProducts.add(match[1]);
  }
}
const listed = new Map();
let listingPages = 0;
for (let page = 1; page <= 10; page++) {
  const response = await get(`/products.json?limit=250&page=${page}`);
  const json = JSON.parse(response.content);
  if (!Array.isArray(json.products)) throw new Error('Invalid public product listing');
  listingPages++;
  sourceManifest.push({ kind: 'public_listing', url: response.url, retrievedAt: response.retrievedAt, sha256: response.sha256, bytes: response.bytes, itemCount: json.products.length, snapshot: null, note: 'Raw commerce fields deliberately not stored; identity list recorded in manifest.' });
  if (!json.products.length) break;
  for (const p of json.products) {
    const safe = safeProduct(p);
    if (listed.has(safe.handle)) throw new Error('Duplicate product between listing pages');
    listed.set(safe.handle, safe);
    if (listed.size > MAX_PRODUCTS) throw new Error('Product safety cap exceeded');
  }
  if (page === 10) throw new Error('Product pagination did not terminate');
}
const missingFromListing = [...sitemapProducts].filter(handle => !listed.has(handle));
const missingFromSitemap = [...listed.keys()].filter(handle => !sitemapProducts.has(handle));
if (missingFromListing.length || missingFromSitemap.length) throw new Error('Catalog sources disagree; do not call intake complete');
const products = [];
for (const handle of [...sitemapProducts].sort()) {
  const page = await get(`/products/${handle}`);
  if (!page.content.includes(SHOP)) throw new Error('Public shop identity mismatch');
  const metadata = await get(`/products/${handle}.js`);
  const p = safeProduct(JSON.parse(metadata.content));
  if (p.handle !== handle || p.id !== listed.get(handle).id) throw new Error('Product identity mismatch');
  const extracted = pageContent(page.content);
  if (extracted.canonical !== `${ORIGIN}/products/${handle}` || extracted.sections.length < 2) throw new Error('Invalid product page extraction');
  const snapshot = { kind: 'merchant_product_source_only', sourceUrl: page.url, retrievedAt: page.retrievedAt, rawResponseSha256: page.sha256, excluded: ['scripts', 'styles', 'customer_reviews', 'customer_identity', 'prices', 'availability', 'purchase_controls', 'recommendation_grids', 'newsletter'], ...extracted };
  const pageFile = `sources/${handle}.page-content.json`;
  const pageBytes = JSON.stringify(snapshot, null, 2) + '\n';
  await writeFile(path.join(root, pageFile), pageBytes);
  const metadataFile = `sources/${handle}.product-metadata.json`;
  const metadataBytes = JSON.stringify({ sourceUrl: metadata.url, retrievedAt: metadata.retrievedAt, rawResponseSha256: metadata.sha256, ...p }, null, 2) + '\n';
  await writeFile(path.join(root, metadataFile), metadataBytes);
  products.push({ ...p, sourceUrl: page.url, retrievedAt: page.retrievedAt, status: 'draft_intake_not_approved', approval: null, pageSource: { file: pageFile, sha256: sha256(pageBytes), rawResponseSha256: page.sha256 }, metadataSource: { file: metadataFile, sha256: sha256(metadataBytes), rawResponseSha256: metadata.sha256 }, sections: extracted.sections, extractionNotes: ['All text is unapproved source material.', 'Image-only labels have not been transcribed or verified.', 'Ingredient amounts may lack a stated serving basis; do not infer it.', 'Public health, certification and suitability claims require separate review.', 'Variants are identity snapshots only; runtime commerce must use live Shopify reads.'] });
  sourceManifest.push({ kind: 'product_page', url: page.url, retrievedAt: page.retrievedAt, rawResponseSha256: page.sha256, bytes: page.bytes, snapshot: pageFile, snapshotSha256: sha256(pageBytes), sectionCount: extracted.sections.length });
  sourceManifest.push({ kind: 'product_metadata', url: metadata.url, retrievedAt: metadata.retrievedAt, rawResponseSha256: metadata.sha256, bytes: metadata.bytes, snapshot: metadataFile, snapshotSha256: sha256(metadataBytes) });
  console.log(JSON.stringify({ collected: products.length, total: sitemapProducts.size, handle, sections: extracted.sections.length, tables: extracted.sections.reduce((n, s) => n + s.tables.length, 0) }));
}
const normalized = { schemaVersion: 1, shop: SHOP, origin: ORIGIN, startedAt, completedAt: new Date().toISOString(), purpose: 'Complete public product intake for merchant review only; no approval or runtime changes', completeness: { sitemapCount: productMaps.length, sitemapProducts: sitemapProducts.size, listingPages, listingProducts: listed.size, fetchedProducts: products.length, missingFromListing, missingFromSitemap, duplicateProductIds: products.length - new Set(products.map(p => p.id)).size }, products };
await writeFile(path.join(root, 'normalized-products.json'), JSON.stringify(normalized, null, 2) + '\n');
await writeFile(path.join(root, 'provenance-manifest.json'), JSON.stringify({ ...normalized, products: products.map(p => ({ id: p.id, title: p.title, handle: p.handle, sourceUrl: p.sourceUrl })), sources: sourceManifest }, null, 2) + '\n');
console.log(JSON.stringify({ complete: true, products: products.length, output: root, approved: false, runtimeChanged: false }));
