# Bionera — ενεργή δοκιμή στην κοινή εφαρμογή

13 Οκτωβρίου 2026. Η νέα app registration δημιουργήθηκε και η γνώση εγκρίθηκε. Η σύνδεση του backend και η εγκατάσταση του assistant εκκρεμούν.

## Επιλεγμένη πορεία

Ο χρήστης επέλεξε «Bionera τώρα, Nutri Tiger αργότερα — ίδια υποδομή». Παραμένουν ένας κώδικας, ο υπάρχων Render server και η υπάρχουσα assistant PostgreSQL. Δεν δημιουργήθηκε νέα χρεώσιμη υπηρεσία. Η υφιστάμενη υλοποίηση εξυπηρετεί μία Shopify app identity ανά deployment, με ξεχωριστά δεδομένα ανά shop. Η μετάβαση στο Bionera θα αλλάξει την ενεργή identity και την allowlist· δεν ισοδυναμεί με ταυτόχρονη λειτουργία των δύο custom apps.

Τα αρχεία, τα κλειδιά κρυπτογράφησης/session και τα αποθηκευμένα δεδομένα του Nutri Tiger διατηρούνται. Η προσωρινή εξαίρεση καταλόγου του παλιού κλειστού καταστήματος έληξε στις 8 Οκτωβρίου και δεν αντιγράφεται ούτε ανανεώνεται για το Bionera.

## Επαληθευμένα στοιχεία

- Δημόσιο site: https://bionera.gr — δημόσιο Shopify κατάστημα.
- Canonical Shopify shop: `bionera-gr.myshopify.com`, επαληθευμένο από δημόσιο HTML στις 13 Οκτωβρίου.
- Live theme κατά τον έλεγχο: `199350681987`, CRO Dynamic Shop Menu - PREVIEW 2026-08-20. Το όνομα περιέχει PREVIEW αλλά η θέση του στο Admin το προσδιορίζει ως τρέχον theme.
- Νέο unpublished αντίγραφο: **Bionera AI Sales Preview 2026-10-13**, `200088715651`. Δεν πατήθηκε Publish και δεν ενεργοποιήθηκε embed.
- Δημόσια ανάγνωση 12 προϊόντων, με επιβεβαιωμένα IDs/handles και variant IDs. Τα τοπικά snapshots είναι υλικό εισαγωγής, όχι runtime πηγή τιμών ή αποθέματος.
- Υπάρχον Render service: `srv-dav36517lnhs73akj8fg`, `shopify-ai-sales-agent`, Frankfurt, μη suspended, auto-deploy off (read-only connector έλεγχος). Δεν επανεπαληθεύτηκε ακόμη runtime readiness ή διαθέσιμο AI credit.
- Bionera tenant configuration: `enabled:true` στο τοπικό εγκεκριμένο configuration, OpenAI, ελληνικά, GR/CY ως αρχική εμβέλεια δοκιμής. Θα φορτωθεί στην εγκατάσταση. Το site αναφέρει και άλλες χώρες ΕΕ· δεν ισχυριζόμαστε ότι GR/CY είναι όλες οι αγορές του.
- A/B/C ανενεργό. Δεν υπάρχουν Mistral credentials στο τοπικό περιβάλλον.

## Έτοιμη ρύθμιση Shopify

Στο Dev Dashboard της KOOQIE IKE (`227248842`) δημιουργήθηκε το **Bionera Sales Pilot**, app ID `435011715073`, αρχική active version `bionera-sales-pilot-1` / `1165595017217`, ίδιο HTTPS backend origin, standalone app και ξεχωριστό OAuth callback `/auth/bionera/callback`. Το `deploy/bionera/shopify.app.toml.example` καταγράφει τη ρύθμιση χωρίς επινοημένο client ID. Η έκδοση αυτή δεν περιέχει ακόμη extensions.

Ο server υποστηρίζει `SHOPIFY_AUTH_CALLBACK_PATH=/auth/bionera/callback`, με ακριβώς μία ενεργή διαδρομή και αυστηρό έλεγχο. Επαληθεύτηκαν οι πραγματικοί SDK redirects/state cookies, η ολοκλήρωση callback και η απόρριψη legacy callback στη Bionera ρύθμιση. Η αλλαγή διορθώνει το αίτιο της αρχικής απόρριψης από τον αυτόματο έλεγχο έγκρισης. Η νέα υποβολή πέτυχε.

Απαιτούμενα scopes: `unauthenticated_read_product_listings`, `read_pixels`, `write_pixels`, `read_customer_events`, `write_app_proxy`. Δεν ζητούνται Admin reads πελατών/παραγγελιών ή δικαιώματα αλλαγής προϊόντων, stock και themes.

Το προτεινόμενο custom distribution είναι μόνιμη επιλογή για αυτή την pilot εγγραφή, αποκλειστικά στο Bionera, με Plus multiple-store installs off. Η μελλοντική δημόσια εφαρμογή εξακολουθεί να χρειάζεται διαφορετική registration και Shopify review.

## Εγκεκριμένα βήματα σύνδεσης

Ο χρήστης ενέκρινε ρητά όλα τα παρακάτω, περιλαμβανομένης της store-wide εμβέλειας του consent-gated pixel και της μόνιμης custom distribution. Η δημιουργία registration και οι τοπικές εγκρίσεις γνώσης ολοκληρώθηκαν· η υπόλοιπη εκτέλεση συνεχίζεται.

1. Δημιουργία της νέας registration, ιδιωτική αποθήκευση των δικών της credentials και custom distribution στο συγκεκριμένο shop. Δεν τροποποιείται η registration του Nutri Tiger ή το Loyalty.
2. Προετοιμασία ξεχωριστού ignored deployment workspace από τον ίδιο κώδικα με `node scripts/stage-shopify-pilot.mjs bionera`. Διατήρηση των root Nutri TOMLs. Το `deploy/bionera/registration.json` κρατά μόνο δημόσια IDs και αποκαθιστά τη σωστή Bionera identity. Τα extension UIDs είναι app-scoped, παράγονται από τα κοινά handles και επιτρέπεται να είναι ίδια σε διαφορετικές registrations. Η CLI επιβεβαίωσε το συγκεκριμένο Bionera app· δεν φορτώνει το root `.env` από το staging directory. Το `app info --json` δεν εκτυπώνεται ποτέ raw, επειδή περιλαμβάνει loaded `.env`.
3. Έλεγχος συνδεδεμένου client ID, `shopify app config validate --json`, build και release. Η εγκεκριμένη εντολή, από το αποκλειστικό Bionera workspace, είναι `pnpm exec shopify app deploy --config bionera --version bionera-sales-pilot-2 --allow-updates`. Μεταδίδει μόνο τη ρύθμιση και τα κοινά extension bundles στο Bionera app. Δεν δημοσιεύει theme και δεν κάνει deploy τον server. Εκκρεμεί η εκτέλεση· το version 1 ανήκει στην αρχική δημιουργία μέσω Dashboard.
4. Αποθήκευση του νέου client ID/secret στο υπάρχον Render service, `ALLOWED_SHOPS=bionera-gr.myshopify.com`, `SHOPIFY_AUTH_CALLBACK_PATH=/auth/bionera/callback`, διατήρηση database/session/encryption/OpenAI settings και backend deploy του ελεγμένου κώδικα. Το προηγούμενο preview θα γίνει μη διαθέσιμο από την allowlist. Δεν δημιουργείται δεύτερο service ή database.
5. Ενεργοποίηση μόνο της Bionera tenant configuration αφού ελεγχθεί το υλικό· πραγματικό OAuth, scope/token/pixel provisioning και tenant persistence. Τιμές, variants και διαθεσιμότητα διαβάζονται από live Shopify σε κάθε σχετική ενέργεια.
6. Ενεργοποίηση embed μόνο στο theme `200088715651`. Έλεγχος ελληνικού διαλόγου, πραγματικών καρτών, explicit Ajax add/update/remove, άδειου καλαθιού μετά τη δοκιμή, medical boundary και consent. Δεν απαιτείται μεταβολή αποθέματος ή αγορά.

Η εγκατάσταση του analytics pixel έχει **εμβέλεια όλου του καταστήματος**, ακόμη και με widget μόνο στο unpublished preview. Η συλλογή απαιτεί analytics consent και έγκυρη attribution mapping. Αυτό πρέπει να περιλαμβάνεται στην έγκριση εγκατάστασης, όχι να παρουσιάζεται ως preview-only pixel.

## Γνώση και επόμενοι έλεγχοι

Το δημόσιο περιεχόμενο εισάγεται ως drafts, με πηγή, hash και πραγματικό product ID. Στις 13 Οκτωβρίου ο χρήστης ενέκρινε τα ακριβή 10 αρχικά facts και το ελληνικό προφίλ· εισήχθησαν και επαληθεύτηκαν τοπικά. Δείτε `BIONERA-KNOWLEDGE-REVIEW.md`. Καμία άλλη διατύπωση του site δεν θεωρείται εγκεκριμένη. Οι εικόνες παραμένουν εκτός approved allowlist μέχρι έλεγχο.

Πριν από επισκέπτες απαιτούνται εγκεκριμένα facts/media, ενημέρωση ιδιωτικότητας όπου χρειάζεται, positive-consent analytics, πραγματική checkout attribution, αξιολόγηση ελληνικών και ρητή απόφαση rollout. Πλήρης δημόσια ενεργοποίηση και A/B/C δεν περιλαμβάνονται στην προετοιμασία της ιδιωτικής δοκιμής.

## Πηγές

- [Bionera](https://bionera.gr/)
- [Shopify: επιλογή διανομής](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method), επανελέγχθηκε 13 Οκτωβρίου 2026.
