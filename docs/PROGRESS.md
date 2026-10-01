# Πρόοδος — Shopify AI Sales Agent

1 Οκτωβρίου 2026, Europe/Athens.

## Στόχος και συνέχεια

Ανακτήθηκε το chat «AI πωλητής Shopify»: η προηγούμενη εργασία ήταν σχεδιασμός, χωρίς υπάρχον κώδικα agent. Το παρόν repo ξεκίνησε κενό και βρίσκεται στο branch `codex/shopify-ai-sales-agent`.

Ο χρήστης ζητά reusable Shopify AI shopping platform, πρώτο pilot Nutri Tiger, text MVP, live commerce, explicit cart actions, approved knowledge, analytics/A-B και ανεξάρτητα voice/avatar layers. Η αρχιτεκτονική αποθηκεύτηκε πριν την υλοποίηση στο `docs/ARCHITECTURE.md`.

Απαντήσεις χρήστη και αρχική διερεύνηση:
- Αρχικά δεν υπήρχε ξεχωριστό Shopify app ή OpenAI API project για τον agent· ο χρήστης ζήτησε καθοδήγηση. Και τα δύο έχουν πλέον δημιουργηθεί, όπως καταγράφεται παρακάτω.
- Υπάρχει ήδη δικό του loyalty app και θέλει να εξεταστεί κοινή υποδομή.
- Δόθηκε το υπάρχον app: `https://admin.shopify.com/store/kooqie-loyalty-production-test/apps/kooqie-loyalty-1/app`. Ανοίχθηκε με επιτυχία σε read-only έλεγχο. Το embedded app φορτώνει από `kooqie-loyalty-production.onrender.com`, άρα επιβεβαιώθηκε Render hosting. Δεν αποθηκεύτηκε το authenticated iframe URL ή session tokens.
- Ο χρήστης συνδέθηκε στο Render και έγραψε «έτοιμο». Επιβεβαιώθηκαν το web service, ο migrator, το daily maintenance cron και η PostgreSQL 16 του Kooqie στη Φρανκφούρτη. Η βάση είναι Basic 256 MB/0.1 CPU, 1 GB storage με χρήση 8.57%. Οι μετρήσεις φόρτου δεν έδωσαν επαρκή στοιχεία για ασφαλές συμπέρασμα χωρητικότητας.
- Το ιδιωτικό GitHub repo `ioannidisang/kooqie-loyalty` διαβάστηκε από authenticated browser. Το production Blueprint στο commit `541365d4b9d453ec077ba4eaa6797c43cc20eb25` συμφωνεί με το deployed commit: Docker/Node 24, ξεχωριστά runtime/migrator credentials και PostgreSQL. Δεν διαβάστηκαν secrets ή customer rows και δεν έγιναν αλλαγές στο loyalty.
- Στον υπάρχοντα OpenAI οργανισμό `KOOQIE` δημιουργήθηκε και επιβεβαιώθηκε το νέο project `Shopify AI Sales Agent` (`proj_4Q1qfxEyu73sVqFDGmxwO1OI`). Εμφανιζόμενο credit balance $0.00. Δεν δημιουργήθηκαν keys, δεν καταχωρίστηκαν πληρωμές και δεν έγιναν API calls.

Ο χρήστης ενέκρινε να προχωρήσει το προτεινόμενο ανεξάρτητο hosting περίπου $14.30/μήνα, με προϋπόθεση reusable εφαρμογή για περισσότερα stores. Το ποσό είναι αρχική υποδομή pilot, πριν φόρους/υπερβάσεις/OpenAI και μελλοντική αύξηση πόρων. Δημιουργήθηκε το private GitHub repo `ioannidisang/shopify-ai-sales-agent`, ολοκληρώθηκε Git login με τα υπάρχοντα Git Credential Manager δικαιώματα και έγινε push του branch `codex/shopify-ai-sales-agent` έως το commit `86262b7`. Η πρόσβαση του Render στο GitHub αποθηκεύτηκε για τα δύο επιλεγμένα repositories, το νέο agent και το υπάρχον loyalty.

Η νέα Render PostgreSQL `shopify-ai-sales-agent-db` (`dpg-dauvg4o473hc73crqerg-a`) είναι διαθέσιμη: PG16, Frankfurt, 256 MB/0.1 CPU, **1 GB**, $6.30/μήνα. Logical database `sales_agent_production`, owner `sales_agent_owner`. Η απαγόρευση δημόσιας πρόσβασης επαληθεύτηκε ξανά μετά από reload. Δημιουργήθηκε ανεξάρτητο cron `shopify-ai-sales-agent-migrator` (`crn-dav1af7pn0mc739l6cf0`), Docker/Frankfurt/Starter, με auto-deploy off και ετήσιο schedule `0 0 1 1 *`. Περιέχει μόνο το ιδιωτικό owner connection secret για migrations και το αναμενόμενο database name `sales_agent_production`. Το πρώτο build απέτυχε πριν από οποιοδήποτε migration, όπως περιγράφεται στους ελέγχους. Δεν έχει δημιουργηθεί ακόμη web service ή runtime database role. Δεν χρησιμοποιήθηκαν ή τροποποιήθηκαν loyalty δεδομένα/credentials.

Για πολλαπλά ανεξάρτητα καταστήματα απαιτείται ξεχωριστή public Shopify registration και App Review. Το άμεσο Nutri pilot μπορεί να χρησιμοποιήσει partner-owned custom registration, με ίδιο source αλλά διαφορετική μελλοντική app identity. Custom distribution δεν μετατρέπεται σε public. Βλέπε `docs/DISTRIBUTION.md`.

## Επαληθευμένο περιβάλλον

- Windows PowerShell, Node 24.19.0, pnpm 11.25.0, Git 2.53.0.
- Shopify CLI 4.8.3 εγκαταστάθηκε τοπικά στο repo με κλειδωμένες εξαρτήσεις. Το npm/global Shopify CLI δεν ήταν διαθέσιμο στο PATH. Docker και gh δεν βρέθηκαν.
- Υπήρχε λειτουργικό CLI 4.8.2 στο `C:/Users/ioann/Documents/Codex/Nutritiger/.tooling/`.
- Πραγματικό authenticated `theme list --store ym5fhx-fa.myshopify.com --json` επιβεβαίωσε live theme `201753559387` και unpublished recovery theme `202147955035`.
- Η αρχική φόρμα στον Nutri Tiger Dev Dashboard οργανισμό `236813359` δεν υποβλήθηκε. Η προσωρινή απόπειρα `shopify app init` σταμάτησε λόγω `ERR_PNPM_IGNORED_BUILDS`, χωρίς γενική αλλαγή πολιτικής pnpm.
- Δημιουργήθηκε μέσω CLI το Shopify app **Nutri Tiger Sales Pilot**, στον οργανισμό **KOOQIE IKE**, Dev Dashboard organization `227248842`, app `430277591041`, δημόσιο client ID `780164aa2eacd46fa59c4ae3275643a6`. Το legacy Partner organization `5058807` αντιστοιχεί στη σελίδα distribution `https://partners.shopify.com/5058807/apps/430277591041/distribution`.
- Το distribution **δεν έχει επιλεγεί**: το custom distribution dialog ακυρώθηκε. Δεν έγινε extension deploy ή εγκατάσταση στο store. Το συνδεδεμένο app TOML έχει τα απαιτούμενα scopes, proxy, OAuth routes και API 2026-07, αλλά διατηρεί ρητό backend placeholder μέχρι να δημιουργηθεί το πραγματικό HTTPS service.
- Shopify client ID/secret ανακτήθηκαν ιδιωτικά στο ignored `.env` με το output του env pull σε capture. OpenAI key δεν υπάρχει ακόμη. Σε προγενέστερο raw `app info --json` output εμφανίστηκαν ακούσια μόνο αχρησιμοποίητα τοπικά encryption/session keys· περιστράφηκαν αμέσως και το παλιό backend σταμάτησε. Δεν εκτέθηκε πραγματικό Shopify secret και δεν καταχωρίστηκαν secrets στο Git. Το `AGENTS.md` απαιτεί πλέον capture και allowlist ασφαλών πεδίων για αυτό το CLI command.
- Το backend είχε εκκινήσει πραγματικά στο `127.0.0.1:3000`, με `/healthz` 200 και `/readyz` 503 χωρίς ολοκληρωμένα credentials. Αυτή η παλιά διεργασία έχει σταματήσει.

## Υλοποιημένο τοπικά

- TypeScript/Fastify backend, official Shopify SDK OAuth, storefront token/pixel provisioning, encrypted credentials.
- Shopify app proxy signature/freshness, shop allowlist, signed conversation tokens, tenant-scoped PostgreSQL/PGlite, concurrency και shared limits.
- OpenAI structured planner με μηδενικό ελεύθερο factual prose. Fixed templates, verified live product IDs και approved fact IDs.
- Tenant/locale/approval filtering, ιατρικό όριο, short-lived encrypted context και medical-context marker.
- Live Storefront queries API 2026-07 με country/language, variants, τιμές, availability, backorder, selling plans/components και quantity rules.
- EL/EN theme app embed/widget, προϊόντα, επιλογή variant/ποσότητας και υπάρχον Shopify Ajax cart. Ρητές εντολές, revalidation, χωρίς αυτόματο retry αμφίβολων mutations.
- Lazy loading του widget: loader **6,628 bytes**, ξεχωριστό UI bundle **27,482 bytes**. Το UI φορτώνεται μόνο όταν ανοίξει ο assistant και δεν φορτώνεται στο control arm.
- Analytics events, web pixel checkout_started/checkout_completed→purchase, deterministic consented A/B assignment, revocation και deduplication. A/B off στο pilot μέχρι πραγματικό attribution test.
- Privacy/uninstall webhooks, retention cleanup, scripts περιβάλλοντος/config/report, CI και Dockerfile.
- Voice/avatar interfaces μόνο· δεν υπάρχει ενεργό live voice ή avatar στο MVP.
- Nutri Tiger facts και media allowlist κενά. Οι παλιές μακέτες περιέχουν μη εγκεκριμένα claims και δεν φορτώνονται στον agent.

## Αποδεικτικά ελέγχου

- Το πιο πρόσφατο ολοκληρωμένο τοπικό `pnpm check` πέρασε **typecheck, 119 tests σε 12 suites και production build**, περιλαμβάνοντας lazy widget, διαχωρισμό migrator/runtime, έλεγχο σωστής βάσης και one-time runtime-role bootstrap. Οι έλεγχοι SQL ρόλων έγιναν σε τοπικό PGlite μέσω test adapter· δεν υποκαθιστούν δοκιμή στην πραγματική hosted PostgreSQL.
- Το GitHub CI run `36823678292` στο pushed commit `86262b7` ολοκληρώθηκε επιτυχώς με **106 tests και Docker build**· το Docker build διήρκεσε περίπου 1 λεπτό και 30 δευτερόλεπτα. Το νεότερο τοπικό widget/check δεν έχει ακόμη επιβεβαιωθεί από νέο hosted CI run.
- Το πρώτο Render build του migrator στο ίδιο commit `86262b7` απέτυχε με **105/106 tests**: ένα PGlite test υπερέβη το timeout των 5,000 ms. Το timeout μόνο του συγκεκριμένου cold-start test αυξήθηκε σε 15 δευτερόλεπτα. Μετά τη διόρθωση, το root `pnpm check` πέρασε με **119 tests σε 12 suites, typecheck και build**, σε περίπου 13.7 δευτερόλεπτα. Εκκρεμεί push και επιτυχές Render rebuild. Δεν εκτελέστηκε migration ή runtime-role bootstrap.
- Το `deploy/render.production.yaml.example` πέρασε τοπικό YAML/JSON Schema validation απέναντι στο τρέχον επίσημο Render schema. Το backend δεν έχει ακόμη αναπτυχθεί στο Render.
- Τέσσερα Storefront queries και πέντε Admin provisioning operations ελέγχθηκαν στον επίσημο Shopify validator για 2026-07.
- Το συνδεδεμένο app TOML πέρασε CLI config validation (`valid: true`). Πραγματικό `shopify app build`, Theme Check και ο επίσημος Liquid validator ολοκληρώθηκαν επιτυχώς. Το build δεν δημοσιεύει extensions ή theme.
- Browser στο πραγματικό compiled widget με σαφώς επισημασμένα synthetic test endpoints: **0 UI bundle requests πριν το άνοιγμα, 1 μετά**, text→product card, προσθήκη ποσότητας 1, ενημέρωση σε 2 και αφαίρεση σε 0 επιβεβαιώθηκαν. Ανάκληση consent σταμάτησε τα analytics ενώ η συνομιλία συνέχισε να λειτουργεί. Το control arm είχε μηδέν UI bundle requests και κανένα launcher. Δεν χρησιμοποιήθηκαν πραγματικά Shopify/OpenAI APIs σε αυτά τα browser checks.
- Βρέθηκε στον Chrome bug native fetch receiver binding· διορθώθηκε και προστέθηκε regression test. Τα test fixtures είναι αποκλειστικά στο `tests/browser/`, δεν υπάρχει mock fallback στην εφαρμογή.
- Επιπλέον browser checks: αλλαγή τιμής 20→21 ζητά νέα επιβεβαίωση με μηδέν cart writes, ανάκληση consent σταματά analytics ενώ η συνομιλία λειτουργεί, Escape επιστρέφει focus στο launcher, control arm δεν εμφανίζει launcher. Τα χρώματα ορίζονται από theme settings και το modal κλειδώνει/επαναφέρει το page scroll.
- Ο τελικός οπτικός επανέλεγχος επιβεβαίωσε τα νέα χρώματα και scroll lock/restore. Η τελευταία απόπειρα viewport override 390×844 δεν εφαρμόστηκε από τον browser (μετρήθηκαν 887×871), επομένως ο τελικός mobile επανέλεγχος παραμένει εκκρεμής· το override επαναφέρθηκε.
- `git diff --check` χωρίς σφάλματα, μόνο προειδοποίηση κανονικοποίησης CRLF. Μία μη λειτουργική προειδοποίηση Fastify για το παλιό όνομα option απενεργοποίησης request logging.

## Τι απομένει για λειτουργικό πραγματικό storefront

1. Commit/push των νεότερων ελεγμένων αλλαγών και επιτυχές hosted rebuild. Κατόπιν πραγματικά migrations/runtime role και δημιουργία/deployment του web service. Το migration cron πρέπει να μένει suspended μεταξύ σκόπιμων εκτελέσεων· το auto-deploy off δεν απενεργοποιεί το ετήσιο schedule.
2. OpenAI billing και API key που εισάγεται ιδιωτικά στο `.env`/secret manager. Το project δημιουργήθηκε, αλλά δεν έγινε πραγματικό OpenAI API call.
3. Επιλογή κατάλληλου distribution για το ήδη δημιουργημένο Shopify pilot app, αντικατάσταση του backend placeholder με το πραγματικό HTTPS URL, επανέλεγχος config, deploy extensions και OAuth install στο Nutri Tiger.
4. Εγκεκριμένες πληροφορίες/εικόνες προϊόντων και πραγματική catalog visibility για το app.
5. Ενεργοποίηση embed σε ξεχωριστό unpublished preview, έλεγχος live Shopify reads/cart και πραγματικού checkout pixel attribution. Δεν έγινε πραγματική αγορά ή αλλαγή αποθέματος.
6. Πραγματικό production database/runtime και backup/restore verification, τελικός mobile επανέλεγχος, installation concurrency lock πριν πολυκαταστηματική διανομή, privacy access-request διαδικασία και live rollout έπειτα από έγκριση.

Το MVP **δεν είναι live και δεν έχει ακόμη επαληθευτεί end-to-end με πραγματικά Shopify/OpenAI APIs**. Η ολοκληρωμένη τοπική υλοποίηση και τα tests δεν υποκαθιστούν αυτό το βήμα. Κανένα theme δεν δημοσιεύτηκε ή τροποποιήθηκε απομακρυσμένα.
