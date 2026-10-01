# Merchant knowledge and conversation training

Each store owns its knowledge and conversation profile in `config/stores/<shop>.json`. Nutri Tiger is one tenant. This workflow does not crawl a storefront, call an AI provider, train model weights, publish a theme, or automatically approve website claims. Imported source content is untrusted data. Only reviewed product facts can become product evidence; a conversation example is never a source of a product fact.

## Import a public source snapshot

Export selected visible site content, merchant documentation, policies, or approved product-label material to a local UTF-8 `.txt`, `.md`, or `.json` file. Use only content the merchant is authorized to provide. Exclude customer messages, personal information, access credentials, authenticated URLs, and account exports. Keep original working exports outside Git (for example in the ignored `.data` directory).

Every snapshot needs its public canonical HTTPS source URL. Query strings, fragments, embedded credentials, IP hosts, local hosts and common authenticated path segments are rejected. The importer never requests the URL, so it has no remote-fetch or redirect path. It cannot determine whether an otherwise public-looking URL is actually a secret bearer link; merchants must never supply such links.

The import limit is 256 KiB per file, 200 passages per import, 1,200 characters per passage, and 1,000 fact records per tenant including revoked history. Plain text/Markdown is split at paragraph and whitespace boundaries. Raw HTML must first be exported as visible text. For precise product association, use the JSON format below. Each entry can override the default locale/product scope, but cannot override approval metadata or tenant identity.

```json
{
  "facts": [
    {
      "text": "Exact reviewed source passage goes here.",
      "productId": "gid://shopify/Product/123",
      "locale": "en"
    }
  ]
}
```

The examples below use a fictitious tenant and public source. They do not approve or modify the Nutri Tiger pilot.

```sh
pnpm knowledge import pilot.myshopify.com --file .data/shipping.md --source https://example.com/pages/shipping --locale el
pnpm knowledge import pilot.myshopify.com --file .data/product.json --source https://example.com/products/product-name --locale el --product gid://shopify/Product/123
pnpm knowledge review pilot.myshopify.com --status draft
```

Imports write **drafts** inside the tenant JSON, with a SHA-256 hash of the exact source bytes, a hash-derived source version, retrieval time, source URL, tenant, locale and optional product ID. Drafts use an empty approver and an epoch placeholder approval date; these are not approvals. Drafts are excluded even if the configuration is synced to the database.

When any source bytes change, all previous non-revoked facts from that source URL are revoked before the new drafts are saved, even when the extracted passage text stays the same. Previously approved claims are therefore unavailable until the new version is reviewed and explicitly approved. Identical imports are idempotent and cannot resurrect a revoked fact. Reverting to an old snapshot does not resurrect its approvals. Retained revoked history is not automatically deleted; if the tenant limit is reached, archive it through a separately reviewed configuration change.

The retrieval timestamp records when this application imported the snapshot, not when the public page was originally modified. The operator is responsible for supplying a current export. Automated site monitoring and scheduled re-import are not implemented.

## Review, approve and revoke

An authorized merchant checks the exact passages and their product association before approval, including supplement claims. The source being on the website does not itself constitute approval. The existing medical/diagnostic claim filter also applies, but it is defense in depth and does not replace human review.

Copy specific IDs from the review output; there is no automatic approve-all operation:

```sh
pnpm knowledge approve pilot.myshopify.com --ids knowledge_example_id --by Merchant --confirm-reviewed true
pnpm knowledge revoke pilot.myshopify.com --ids knowledge_example_id
pnpm knowledge review pilot.myshopify.com --status all
```

Approval records the supplied merchant approver and timestamp. Revocation removes eligibility immediately in the local file while preserving the previous approval record. Only current drafts can be approved. Unknown, duplicate, cross-tenant, revoked, expired, stale-source, and medically disallowed records are rejected. An ID must exist in the named tenant file. Commands are local administrative operations, not public unauthenticated endpoints; filesystem access is the access boundary for this MVP workflow.

Changes are saved under an exclusive lock using an atomic temporary-file replacement. Every successful mutation gets a new knowledge version. They do not update a running store automatically:

```sh
pnpm config:sync pilot.myshopify.com
```

Use that existing publication operation only for an installed, allowlisted store, after review and relevant release checks. It updates the tenant configuration in the configured database. A failed import or approval does not partially replace the tenant file. An interrupted process can leave a `.json.lock` file; verify no knowledge command is still running before removing that lock. Ordinary command output contains counts and versions only; explicit `review`/`training-review` displays merchant knowledge, so do not redirect those views into committed logs.

## Teach conversation behavior

Merchant training means editable instructions and curated examples provided to the model at conversation time. It is not automatic learning from shoppers, and it does not require fine-tuning. The same approved profile can be supplied to different model adapters. Product prices, variants, availability, discounts and medical claims never become valid merely because an example contains them.

Create a local JSON profile with a new version, up to 2,000 characters of instructions and at most eight examples (500 characters per user example and 1,000 per assistant example). These must be invented examples or reviewed merchant-written examples, not stored customer conversations.

```json
{
  "version": "greek-service-v1",
  "instructions": "Μίλα στον ενικό, σύντομα και φυσικά. Κάνε μία χρήσιμη διευκρινιστική ερώτηση κάθε φορά. Σεβάσου το budget του πελάτη.",
  "examples": [
    {
      "user": "Αυτό είναι ακριβό για μένα.",
      "assistant": "Μέχρι ποιο ποσό θα ήθελες να κινηθούμε;"
    }
  ]
}
```

```sh
pnpm knowledge training-review pilot.myshopify.com --file .data/conversation-profile.json
pnpm knowledge training-import pilot.myshopify.com --file .data/conversation-profile.json --by Merchant --confirm-reviewed true
```

Review is read-only; import explicitly records the approver and date. Reusing the currently installed profile version is rejected. These instructions and examples guide conversational style and questioning; platform safety, grounding and cart rules retain priority. The platform does not repeat an example as a required script. Correcting an answer means revising the relevant source facts or profile, issuing a new version, checking the result and then syncing. A shopper message never edits the profile or approved knowledge.

## Retrieval limits and evaluation

`retrieveFacts` accepts the tenant, locale, latest message plus recent **user-only** context, and optionally the product IDs selected from the live catalog. It returns at most 24 eligible records (12 by default). It verifies current source versions and the existing approval/expiry/medical boundaries, ranks the bounded tenant set by lexical overlap, and keeps product claims within the supplied product IDs. Product-specific evidence may support an explicitly selected product even if the follow-up uses only “this”; unrelated global policies need a matching query term. Draft and newer-source records can invalidate stale evidence even before the new content is approved.

The first implementation is deterministic lexical retrieval with Greek accent/case/final-sigma normalization. It does not provide embeddings, semantic paraphrase search, Greeklish transliteration, a website crawler, OCR, PDF extraction, a merchant graphical review interface, or automatic quality evaluation. It can miss synonyms and paraphrases; absence of retrieved evidence must result in uncertainty or a clarifying question, not an invented claim. Legacy approved facts without provenance remain supported until migrated, but they lose eligibility if a versioned snapshot of the same source exists.

Source approval and citation filtering reduce risk but do not prove that all freely generated wording is accurate. Provider comparisons still need adversarial grounding checks and reviewed Greek conversations before a live A/B/C experiment. No live Nutri Tiger claims or training examples were approved as part of implementing this workflow.
