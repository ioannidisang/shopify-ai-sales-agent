# Bionera — ενεργή δοκιμή στην κοινή εφαρμογή

13 Οκτωβρίου 2026. Η εφαρμογή εγκαταστάθηκε στο Bionera και λειτουργεί στο unpublished preview με τις νεότερες διορθώσεις. Επαληθεύτηκαν πραγματικές δοκιμές συνομιλίας, καλαθιού, συγκατάθεσης/ανάκλησης analytics, έναρξης checkout και cookie modal σε desktop και Chrome mobile viewport. Το live κατάστημα παραμένει χωρίς ενεργό assistant widget.

## Επιλεγμένη πορεία

Ο χρήστης επέλεξε «Bionera τώρα, Nutri Tiger αργότερα — ίδια υποδομή». Παραμένουν ένας κώδικας, ο υπάρχων Render server και η υπάρχουσα assistant PostgreSQL. Δεν δημιουργήθηκε νέα χρεώσιμη υπηρεσία. Η υφιστάμενη υλοποίηση εξυπηρετεί μία Shopify app identity ανά deployment, με ξεχωριστά δεδομένα ανά shop. Η μετάβαση άλλαξε την ενεργή identity και την allowlist σε Bionera· δεν ισοδυναμεί με ταυτόχρονη λειτουργία των δύο custom apps.

Τα αρχεία, τα κλειδιά κρυπτογράφησης/session και τα αποθηκευμένα δεδομένα του Nutri Tiger διατηρούνται. Η προσωρινή εξαίρεση καταλόγου του παλιού κλειστού καταστήματος έληξε στις 8 Οκτωβρίου και δεν αντιγράφεται ούτε ανανεώνεται για το Bionera.

## Επαληθευμένα στοιχεία

- Δημόσιο site: https://bionera.gr — δημόσιο Shopify κατάστημα.
- Canonical Shopify shop: `bionera-gr.myshopify.com`, επαληθευμένο από δημόσιο HTML στις 13 Οκτωβρίου.
- Live theme κατά τον έλεγχο: `199350681987`, CRO Dynamic Shop Menu - PREVIEW 2026-08-20. Το όνομα περιέχει PREVIEW αλλά η θέση του στο Admin το προσδιορίζει ως τρέχον theme. Το assistant embed επαληθεύτηκε disabled με screenshot, χωρίς αλλαγή του live theme.
- Unpublished αντίγραφο: **Bionera AI Sales Preview 2026-10-13**, `200088715651`. Το assistant embed ενεργοποιήθηκε και αποθηκεύτηκε μόνο εκεί, με επιλεγμένα χρώματα `#1E3D70` / `#FAF9F2`. Δεν πατήθηκε Publish.
- Δημόσια ανάγνωση 12 προϊόντων, με επιβεβαιωμένα IDs/handles και variant IDs. Τα τοπικά snapshots είναι υλικό εισαγωγής, όχι runtime πηγή τιμών ή αποθέματος.
- Υπάρχον Render service: `srv-dav36517lnhs73akj8fg`, `shopify-ai-sales-agent`, Frankfurt, auto-deploy off. Το τρέχον deployment `dep-db75iuou01pc73cbcmqg`, source `9e02f8239b3ff0d1b2f22f1219a6fc951aa81c50`, επαληθεύτηκε Live στις **16:18:13.583859 UTC / 19:18:13 Europe/Athens**. Πραγματικές hosted AI κλήσεις πέτυχαν· αυτό δεν αποτελεί έλεγχο του εναπομένοντος πιστωτικού υπολοίπου.
- Bionera tenant configuration: hosted installed/active/enabled, OpenAI, ελληνικά, **10/10 approved facts** και εγκεκριμένο προφίλ ύφους, GR/CY ως αρχική εμβέλεια δοκιμής. Το site αναφέρει και άλλες χώρες ΕΕ· δεν ισχυριζόμαστε ότι GR/CY είναι όλες οι αγορές του.
- A/B/C ανενεργό. Δεν υπάρχουν Mistral credentials στο τοπικό περιβάλλον.

## Έτοιμη ρύθμιση Shopify

Στο Dev Dashboard της KOOQIE IKE (`227248842`) δημιουργήθηκε το **Bionera Sales Pilot**, app ID `435011715073`, δημόσιο client ID `6eba3e1d30cecfb04b13698e8b055416`. Η ενεργή έκδοση **`bionera-sales-pilot-3` / `1165651968001`** περιλαμβάνει theme/pixel extensions, ίδιο HTTPS backend origin, standalone app, app proxy, privacy webhooks και ξεχωριστό OAuth callback `/auth/bionera/callback`. Η CLI validation, το build και το release πέτυχαν. Το `deploy/bionera/shopify.app.toml.example` καταγράφει την κοινή ρύθμιση και το ενημερωμένο `registration.json` μόνο επαληθευμένα δημόσια IDs.

Ο server υποστηρίζει `SHOPIFY_AUTH_CALLBACK_PATH=/auth/bionera/callback`, με ακριβώς μία ενεργή διαδρομή και αυστηρό έλεγχο. Επαληθεύτηκαν οι πραγματικοί SDK redirects/state cookies, η ολοκλήρωση callback και η απόρριψη legacy callback στη Bionera ρύθμιση. Η αλλαγή διορθώνει το αίτιο της αρχικής απόρριψης από τον αυτόματο έλεγχο έγκρισης. Η νέα υποβολή πέτυχε.

Απαιτούμενα scopes: `unauthenticated_read_product_listings`, `read_pixels`, `write_pixels`, `read_customer_events`, `write_app_proxy`. Δεν ζητούνται Admin reads πελατών/παραγγελιών ή δικαιώματα αλλαγής προϊόντων, stock και themes.

Το εγκεκριμένο custom distribution επιλέχθηκε μόνιμα για αυτή την pilot εγγραφή, αποκλειστικά στο Bionera, με Plus multiple-store installs off. Το OAuth, Storefront token/pixel provisioning και tenant persistence ολοκληρώθηκαν. Η μελλοντική δημόσια εφαρμογή εξακολουθεί να χρειάζεται διαφορετική registration και Shopify review.

## Εγκεκριμένα βήματα σύνδεσης

Ο χρήστης ενέκρινε ρητά όλα τα παρακάτω, περιλαμβανομένης της store-wide εμβέλειας του consent-gated pixel και της μόνιμης custom distribution. Τα βήματα εγκατάστασης ολοκληρώθηκαν· η ακολουθία διατηρείται ως runbook, όχι ως αίτημα νέας έγκρισης.

1. Δημιουργία της νέας registration, ιδιωτική αποθήκευση των δικών της credentials και custom distribution στο συγκεκριμένο shop. Δεν τροποποιείται η registration του Nutri Tiger ή το Loyalty.
2. Προετοιμασία ξεχωριστού ignored deployment workspace από τον ίδιο κώδικα με `node scripts/stage-shopify-pilot.mjs bionera`. Διατήρηση των root Nutri TOMLs. Το `deploy/bionera/registration.json` κρατά μόνο δημόσια IDs και αποκαθιστά τη σωστή Bionera identity. Τα extension UIDs είναι app-scoped, παράγονται από τα κοινά handles και επιτρέπεται να είναι ίδια σε διαφορετικές registrations. Η CLI επιβεβαίωσε το συγκεκριμένο Bionera app· δεν φορτώνει το root `.env` από το staging directory. Το `app info --json` δεν εκτυπώνεται ποτέ raw, επειδή περιλαμβάνει loaded `.env`.
3. Έλεγχος συνδεδεμένου client ID, `shopify app config validate --config bionera --json`, build και release από το αποκλειστικό Bionera workspace. Το αρχικό extension release ήταν `bionera-sales-pilot-2` και το τρέχον `bionera-sales-pilot-3`. Μεταδόθηκαν η ρύθμιση και τα κοινά extension bundles μόνο στο Bionera app. Τα releases δεν δημοσίευσαν theme ούτε έκαναν deploy τον server. Το version 1 ανήκει στην αρχική δημιουργία μέσω Dashboard.
4. Αποθήκευση του νέου client ID/secret στο υπάρχον Render service, `ALLOWED_SHOPS=bionera-gr.myshopify.com`, `SHOPIFY_AUTH_CALLBACK_PATH=/auth/bionera/callback`, διατήρηση database/session/encryption/OpenAI settings και backend deploy του ελεγμένου κώδικα. Ολοκληρώθηκε· η ενεργή allowlist εξαιρεί το προηγούμενο Nutri preview. Δεν δημιουργήθηκε δεύτερο service ή database.
5. Ενεργοποίηση μόνο της Bionera tenant configuration αφού ελεγχθεί το υλικό· πραγματικό OAuth, scope/token/pixel provisioning και tenant persistence. Τιμές, variants και διαθεσιμότητα διαβάζονται από live Shopify σε κάθε σχετική ενέργεια.
6. Ενεργοποίηση embed μόνο στο theme `200088715651`. Έλεγχος ελληνικού διαλόγου, πραγματικών καρτών, explicit Ajax add/update/remove, άδειου καλαθιού μετά τη δοκιμή, medical boundary και consent. Δεν απαιτείται μεταβολή αποθέματος ή αγορά.

Η εγκατάσταση του analytics pixel έχει **εμβέλεια όλου του καταστήματος**, ακόμη και με widget μόνο στο unpublished preview. Η συλλογή απαιτεί analytics consent και έγκυρη attribution mapping. Αυτό πρέπει να περιλαμβάνεται στην έγκριση εγκατάστασης, όχι να παρουσιάζεται ως preview-only pixel.

## Πραγματικές δοκιμές και όρια της επαλήθευσης

Στο πραγματικό preview επαληθεύτηκαν ελληνική παρουσίαση Dr. Magnesium Bisglycinate με εγκεκριμένα στοιχεία μαγνησίου/γλυκίνης και 90 καψουλών, ζωντανή τιμή **€29,90**, και καλάθι **1 → 2 → αφαίρεση**, με τελικό άδειο καλάθι. Στα δύο τεμάχια το Shopify επέστρεψε line amount **€59,80** και cart total **€53,82**· δεν αποδόθηκε η διαφορά σε συγκεκριμένη έκπτωση ή κανόνα. Δεν δημιουργήθηκε παραγγελία ούτε μεταβολή αποθέματος.

Η απάντηση για Κύπρο ακολούθησε την εγκεκριμένη γνώση (Kronos Express, περίπου μία εβδομάδα, χωρίς αντικαταβολή) και το medical fallback λειτούργησε στο σχετικό αίτημα. Η απόρριψη analytics consent επαληθεύτηκε με `events: []` στη hosted βάση. Η πρώτη query είχε 4 επιτυχείς provider κλήσεις, 6.169 input / 394 output tokens· αυτό δεν είναι συνολικό usage report των δοκιμών.

Το false positive για πλήθος καψουλών συσκευασίας διορθώθηκε και επαληθεύτηκε σε πραγματική απάντηση: 90 κάψουλες, μαγνήσιο/γλυκίνη και κάρτα €29,90. Ακολούθησε διόρθωση ασυνέπειας όπου το κείμενο δήλωνε άγνωστη τιμή παρότι υπήρχε ζωντανή κάρτα: το deployed backend δίνει πλέον `productCards` UI metadata στη σύνθεση και αντίστοιχη οδηγία στον grounded verifier. Το τελικό πραγματικό replay στην έκδοση 3 πέτυχε με φυσική ελληνική παραπομπή στην τρέχουσα κάρτα για τιμή/διαθεσιμότητα, χωρίς την εσφαλμένη δήλωση άγνωστης τιμής.

Το δημοσιευμένο κουμπί **Ρυθμίσεις cookies** ανοίγει το πραγματικό Shopify modal χωρίς άμεση αλλαγή consent. Global `header` styling του theme επηρέαζε το modal· η διόρθωση `deploy/bionera/preview-cookie-preferences.css` εφαρμόστηκε μόνο στο Custom CSS του unpublished theme, διατηρώντας το υπάρχον CSS, αποθηκεύτηκε και επαληθεύτηκε σε desktop. Το live theme δεν τροποποιήθηκε.

Επιλέχθηκε analytics-only consent από το πραγματικό UI. Στο τελευταίο bounded hosted audit πριν από την ανάκληση καταγράφηκαν `add_to_cart:1`, `assistant_open:4`, `cart_updated:2`, `checkout_started:1`, `conversation_started:2`, `experiment_exposure:5`, `product_clicked:1`, `recommendation_shown:2`. Aggregate χρήση στο ίδιο σημείο: **16/16 επιτυχείς κλήσεις, 25.082 input / 1.564 output tokens, 0 unknown**. Αυτοί οι αριθμοί είναι στιγμιότυπο, όχι τελικό συνολικό usage report. Το checkout ανοίχτηκε χωρίς στοιχεία επικοινωνίας, παραγγελία ή πληρωμή· μετά την επιστροφή έγινε ενημέρωση ποσότητας και αφαίρεση, με τελικό άδειο καλάθι.

Η διάταξη του assistant επαληθεύτηκε στο mobile viewport του Shopify editor. Το cookie modal επαληθεύτηκε σε πραγματικό Chrome viewport **390 × 844**, μετά τη διόρθωση αναδίπλωσης των κειμένων των κουμπιών, και το viewport επανήλθε. Απόδειξη: `.data/evidence/bionera-mobile-cookies-2026-10-13.png`.

Η ανάκληση έγινε μέσω του πραγματικού Shopify **Reject all** UI. Με νέο άνοιγμα προτιμήσεων, analytics/marketing/personalization ήταν απενεργοποιημένα. Ο hosted read-only έλεγχος επέστρεψε **`events: []`**: τα test analytics events διαγράφηκαν, ενώ παρέμειναν μη ταυτοποιητικά λειτουργικά usage aggregates, χωρίς shopper IDs. Ακολούθησε επιτυχημένη πραγματική συνομιλία με φυσικά Ελληνικά, εγκεκριμένη σύνθεση/90 κάψουλες και παραπομπή στην κάρτα €29,90. Ο τελικός έλεγχος εξακολούθησε να δίνει **`events: []`**, με **20/20 επιτυχείς κλήσεις, 31.407 input / 1.992 output tokens, 0 unknown** στο τελευταίο usage snapshot. Η συνομιλία λειτουργεί με tracking απενεργοποιημένο. Απόδειξη: `.data/evidence/bionera-working-preview-2026-10-13.png`.

Το `purchase` παραμένει μη επαληθευμένο· δεν δημιουργήθηκε παραγγελία. Πλήρες **`pnpm check` μετά από όλες τις αλλαγές: 329 tests / 20 suites, typecheck και production build πέρασαν στις 19:27:42 Europe/Athens**, διάρκεια tests 26,04s.

## Γνώση και επόμενοι έλεγχοι

Το δημόσιο περιεχόμενο εισάγεται ως drafts, με πηγή, hash και πραγματικό product ID. Στις 13 Οκτωβρίου ο χρήστης ενέκρινε τα ακριβή 10 αρχικά facts και το ελληνικό προφίλ· εισήχθησαν, επαληθεύτηκαν τοπικά και φορτώθηκαν στη hosted εγκατάσταση. Δείτε `BIONERA-KNOWLEDGE-REVIEW.md`. Καμία άλλη διατύπωση του site δεν θεωρείται εγκεκριμένη. Οι εικόνες παραμένουν εκτός approved allowlist μέχρι έλεγχο.

Πριν από επισκέπτες απαιτούνται purchase attribution, διεύρυνση της εγκεκριμένης γνώσης/μέσων και ενημέρωση ιδιωτικότητας όπου χρειάζεται, αξιολόγηση ελληνικών και ρητή απόφαση rollout. Mistral και A/B/C παραμένουν ανενεργά. Πλήρης δημόσια ενεργοποίηση δεν περιλαμβάνεται στην ιδιωτική δοκιμή· φωνή και avatar παραμένουν μελλοντική εργασία.

## Πηγές

- [Bionera](https://bionera.gr/)
- [Shopify: επιλογή διανομής](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method), επανελέγχθηκε 13 Οκτωβρίου 2026.
