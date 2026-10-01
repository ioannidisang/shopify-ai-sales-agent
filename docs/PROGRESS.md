# Πρόοδος — Shopify AI Sales Agent

1 Οκτωβρίου 2026, Europe/Athens.

## Στόχος και συνέχεια

Ανακτήθηκε το chat «AI πωλητής Shopify»: η προηγούμενη εργασία ήταν σχεδιασμός, χωρίς υπάρχον κώδικα agent. Το παρόν repo ξεκίνησε κενό και βρίσκεται στο branch `codex/shopify-ai-sales-agent`.

Ο χρήστης ζητά reusable Shopify AI shopping platform, πρώτο pilot Nutri Tiger, text MVP, live commerce, explicit cart actions, approved knowledge, analytics/A-B και ανεξάρτητα voice/avatar layers. Η αρχιτεκτονική αποθηκεύτηκε πριν την υλοποίηση στο `docs/ARCHITECTURE.md`.

Νεότερες απαντήσεις χρήστη:
- Δεν έχει δημιουργηθεί ακόμη ξεχωριστό Shopify app ή OpenAI API project για τον agent· ζητά καθοδήγηση.
- Υπάρχει ήδη δικό του loyalty app και θέλει να εξεταστεί κοινή υποδομή.
- Δόθηκε το υπάρχον app: `https://admin.shopify.com/store/kooqie-loyalty-production-test/apps/kooqie-loyalty-1/app`. Ανοίχθηκε με επιτυχία σε read-only έλεγχο. Το embedded app φορτώνει από `kooqie-loyalty-production.onrender.com`, άρα επιβεβαιώθηκε Render hosting. Δεν αποθηκεύτηκε το authenticated iframe URL ή session tokens.
- Ο χρήστης συνδέθηκε στο Render και έγραψε «έτοιμο». Επιβεβαιώθηκαν το web service, ο migrator, το daily maintenance cron και η PostgreSQL 16 του Kooqie στη Φρανκφούρτη. Η βάση είναι Basic 256 MB/0.1 CPU, 1 GB storage με χρήση 8.57%. Οι μετρήσεις φόρτου δεν έδωσαν επαρκή στοιχεία για ασφαλές συμπέρασμα χωρητικότητας.
- Το ιδιωτικό GitHub repo `ioannidisang/kooqie-loyalty` διαβάστηκε από authenticated browser. Το production Blueprint στο commit `541365d4b9d453ec077ba4eaa6797c43cc20eb25` συμφωνεί με το deployed commit: Docker/Node 24, ξεχωριστά runtime/migrator credentials και PostgreSQL. Δεν διαβάστηκαν secrets ή customer rows και δεν έγιναν αλλαγές στο loyalty.
- Στον υπάρχοντα OpenAI οργανισμό `KOOQIE` δημιουργήθηκε και επιβεβαιώθηκε το νέο project `Shopify AI Sales Agent` (`proj_4Q1qfxEyu73sVqFDGmxwO1OI`). Εμφανιζόμενο credit balance $0.00. Δεν δημιουργήθηκαν keys, δεν καταχωρίστηκαν πληρωμές και δεν έγιναν API calls.

Ο χρήστης ενέκρινε να προχωρήσει το προτεινόμενο ανεξάρτητο hosting περίπου $14.30/μήνα, με προϋπόθεση reusable εφαρμογή για περισσότερα stores. Το ποσό είναι αρχική υποδομή pilot, πριν φόρους/υπερβάσεις/OpenAI και μελλοντική αύξηση πόρων. Δημιουργήθηκε το private GitHub repo `ioannidisang/shopify-ai-sales-agent` και ολοκληρώθηκε τοπικό Git login με τα υπάρχοντα Git Credential Manager δικαιώματα. Δημιουργήθηκε Render PostgreSQL `shopify-ai-sales-agent-db` (`dpg-dauvg4o473hc73crqerg-a`), PG16, Frankfurt, 256 MB/0.1 CPU, **1 GB** επαληθευμένο από το Plan, $6.30/μήνα. Logical database `sales_agent_production`, owner `sales_agent_owner`. Αφαιρέθηκε ο κανόνας δημόσιας πρόσβασης. Δεν χρησιμοποιήθηκαν ή τροποποιήθηκαν loyalty δεδομένα/credentials.

Για πολλαπλά ανεξάρτητα καταστήματα απαιτείται ξεχωριστή public Shopify registration και App Review. Το άμεσο Nutri pilot μπορεί να χρησιμοποιήσει partner-owned custom registration, με ίδιο source αλλά διαφορετική μελλοντική app identity. Custom distribution δεν μετατρέπεται σε public. Βλέπε `docs/DISTRIBUTION.md`.

## Επαληθευμένο περιβάλλον

- Windows PowerShell, Node 24.19.0, pnpm 11.25.0, Git 2.53.0.
- Shopify CLI 4.8.3 εγκαταστάθηκε τοπικά στο repo με κλειδωμένες εξαρτήσεις. Το npm/global Shopify CLI δεν ήταν διαθέσιμο στο PATH. Docker και gh δεν βρέθηκαν.
- Υπήρχε λειτουργικό CLI 4.8.2 στο `C:/Users/ioann/Documents/Codex/Nutritiger/.tooling/`.
- Πραγματικό authenticated `theme list --store ym5fhx-fa.myshopify.com --json` επιβεβαίωσε live theme `201753559387` και unpublished recovery theme `202147955035`.
- Shopify Dev Dashboard οργανισμού Nutri Tiger: organization `236813359`, με κανένα app στη λίστα κατά τον έλεγχο. Ανοίχθηκε η φόρμα δημιουργίας και συμπληρώθηκε μόνο το όνομα· δεν υποβλήθηκε.
- Απόπειρα `shopify app init` σταμάτησε πριν ολοκληρωθεί λόγω `ERR_PNPM_IGNORED_BUILDS` στο προσωρινό scaffold. Δεν έγινε γενική αλλαγή πολιτικής pnpm και δεν δημιουργήθηκε ενεργό app config. Διαδραστικό config link ακυρώθηκε χωρίς επιλογή οργανισμού.
- Δημιουργήθηκε ignored `.env` με ανεξάρτητα τυχαία κλειδιά κρυπτογράφησης/session. Δεν υπάρχουν Shopify/OpenAI credentials. Κανένα secret δεν εμφανίστηκε ή μπήκε στο Git.
- Το backend εκκίνησε πραγματικά στο `127.0.0.1:3000`: `/healthz` 200, `/readyz` 503 όπως αναμένεται χωρίς credentials.

## Υλοποιημένο τοπικά

- TypeScript/Fastify backend, official Shopify SDK OAuth, storefront token/pixel provisioning, encrypted credentials.
- Shopify app proxy signature/freshness, shop allowlist, signed conversation tokens, tenant-scoped PostgreSQL/PGlite, concurrency και shared limits.
- OpenAI structured planner με μηδενικό ελεύθερο factual prose. Fixed templates, verified live product IDs και approved fact IDs.
- Tenant/locale/approval filtering, ιατρικό όριο, short-lived encrypted context και medical-context marker.
- Live Storefront queries API 2026-07 με country/language, variants, τιμές, availability, backorder, selling plans/components και quantity rules.
- EL/EN theme app embed/widget, προϊόντα, επιλογή variant/ποσότητας και υπάρχον Shopify Ajax cart. Ρητές εντολές, revalidation, χωρίς αυτόματο retry αμφίβολων mutations.
- Analytics events, web pixel checkout_started/checkout_completed→purchase, deterministic consented A/B assignment, revocation και deduplication. A/B off στο pilot μέχρι πραγματικό attribution test.
- Privacy/uninstall webhooks, retention cleanup, scripts περιβάλλοντος/config/report, CI και Dockerfile.
- Voice/avatar interfaces μόνο· δεν υπάρχει ενεργό live voice ή avatar στο MVP.
- Nutri Tiger facts και media allowlist κενά. Οι παλιές μακέτες περιέχουν μη εγκεκριμένα claims και δεν φορτώνονται στον agent.

## Αποδεικτικά ελέγχου

- Τελικό `pnpm check`: **typecheck, 104 tests σε 11 suites και production build πέρασαν**, μαζί με διαχωρισμό migrator/runtime, έλεγχο σωστής βάσης και ασφαλές one-time runtime-role bootstrap. Οι έλεγχοι SQL ρόλων έγιναν σε τοπικό PGlite μέσω test adapter· δεν υποκαθιστούν δοκιμή στην πραγματική hosted PostgreSQL.
- Το `deploy/render.production.yaml.example` πέρασε τοπικό YAML/JSON Schema validation απέναντι στο τρέχον επίσημο Render schema. Δεν έγινε provider validation, Docker build ή πραγματικό deployment.
- Τέσσερα Storefront queries και πέντε Admin provisioning operations ελέγχθηκαν στον επίσημο Shopify validator για 2026-07.
- Theme app Liquid block πέρασε τον επίσημο stateless validator. Το ενεργό app TOML δεν έχει ελεγχθεί μέσω CLI, γιατί δεν υπάρχει πραγματικό client ID/config ακόμη.
- Browser στο πραγματικό compiled widget με σαφώς επισημασμένα synthetic test endpoints: άνοιγμα, text→product card, επιβεβαίωση προσθήκης, αλλαγή ποσότητας 1→2, αφαίρεση 2→0 επιβεβαιώθηκαν από UI. Mobile viewport 390×844 επιθεωρήθηκε.
- Βρέθηκε στον Chrome bug native fetch receiver binding· διορθώθηκε και προστέθηκε regression test. Τα test fixtures είναι αποκλειστικά στο `tests/browser/`, δεν υπάρχει mock fallback στην εφαρμογή.
- Επιπλέον browser checks: αλλαγή τιμής 20→21 ζητά νέα επιβεβαίωση με μηδέν cart writes, ανάκληση consent σταματά analytics ενώ η συνομιλία λειτουργεί, Escape επιστρέφει focus στο launcher, control arm δεν εμφανίζει launcher. Τα χρώματα ορίζονται από theme settings και το modal κλειδώνει/επαναφέρει το page scroll.
- Ο τελικός οπτικός επανέλεγχος επιβεβαίωσε τα νέα χρώματα και scroll lock/restore. Η τελευταία απόπειρα viewport override 390×844 δεν εφαρμόστηκε από τον browser (μετρήθηκαν 887×871), επομένως ο τελικός mobile επανέλεγχος παραμένει εκκρεμής· το override επαναφέρθηκε.
- `git diff --check` χωρίς σφάλματα. Μία μη λειτουργική προειδοποίηση Fastify για το παλιό όνομα option απενεργοποίησης request logging.

## Τι απομένει για λειτουργικό πραγματικό storefront

1. Git push και Render backend/migrator provisioning. Hosting εγκρίθηκε, private remote repo και νέα PostgreSQL δημιουργήθηκαν. Εκκρεμούν πραγματικά migrations/runtime role και deployed backend.
2. OpenAI billing και API key που εισάγεται ιδιωτικά στο `.env`/secret manager. Το project δημιουργήθηκε, αλλά δεν έγινε πραγματικό OpenAI API call.
3. Δημιουργία ξεχωριστού Shopify app με πραγματικό HTTPS backend URL, σύνδεση config, CLI validation, deploy extensions και OAuth install στο Nutri Tiger.
4. Εγκεκριμένες πληροφορίες/εικόνες προϊόντων και πραγματική catalog visibility για το app.
5. Ενεργοποίηση embed σε ξεχωριστό unpublished preview, έλεγχος live Shopify reads/cart και πραγματικού checkout pixel attribution. Δεν έγινε πραγματική αγορά ή αλλαγή αποθέματος.
6. Production database/container/backup verification, installation concurrency lock πριν πολυκαταστηματική διανομή, privacy access-request διαδικασία και live rollout έπειτα από έγκριση.

Το MVP **δεν είναι live και δεν έχει ακόμη επαληθευτεί end-to-end με πραγματικά Shopify/OpenAI APIs**. Η ολοκληρωμένη τοπική υλοποίηση και τα tests δεν υποκαθιστούν αυτό το βήμα. Κανένα theme δεν δημοσιεύτηκε ή τροποποιήθηκε απομακρυσμένα.
