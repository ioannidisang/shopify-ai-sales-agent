# OpenAI API setup για το pilot

Δημιουργήθηκε στις 1 Οκτωβρίου 2026 το project **Shopify AI Sales Agent** στον υπάρχοντα οργανισμό **KOOQIE**, και επιβεβαιώθηκε από το επιλεγμένο project στο dashboard. Project ID: `proj_4Q1qfxEyu73sVqFDGmxwO1OI`. Κατά τον έλεγχο εμφανιζόταν credit balance $0.00. Δεν δημιουργήθηκε API key, δεν προστέθηκε payment method/πίστωση και δεν πραγματοποιήθηκε πραγματική κλήση ή χρέωση API.

1. Άνοιξε το OpenAI API Platform: https://platform.openai.com/ και συνδέσου στον λογαριασμό που θα ανήκει στην επιχείρηση.
2. Επίλεξε το υπάρχον project `Shopify AI Sales Agent` στον οργανισμό `KOOQIE` — δεν χρειάζεται δεύτερη δημιουργία. Έτσι ο προϋπολογισμός, οι προσβάσεις και η χρήση του agent παρακολουθούνται χωριστά.
3. Ρύθμισε billing και επιθυμητό όριο/ειδοποιήσεις από τα settings του λογαριασμού. Τα payment στοιχεία και η τελική επιβεβαίωση πληρωμής συμπληρώνονται από τον χρήστη. Μην θεωρείς έναν μηνιαίο προϋπολογισμό από μόνο του εγγυημένο σκληρό cutoff· επαλήθευσε τη συμπεριφορά του dashboard. Ο κώδικας περιλαμβάνει ξεχωριστά όρια κλήσεων, όχι ακριβή μετρητή ευρώ.
4. Δημιούργησε project API key ή service-account key για το backend. Χρησιμοποίησε περιορισμένα δικαιώματα για τις απαραίτητες Responses/model λειτουργίες και διαδικασία ανανέωσης. Μην το επικολλήσεις σε chat ή Shopify theme setting.
5. Στο ignored τοπικό `.env` συμπλήρωσε `OPENAI_API_KEY=...`. Στο hosting καταχώρισέ το ως secret environment variable του νέου service. Το παράδειγμα χρησιμοποιεί `OPENAI_MODEL=gpt-4.1-mini`, ως configurable αρχική επιλογή για structured outputs. Η πρόσβαση/καταλληλότητα του συγκεκριμένου model πρέπει να επιβεβαιωθεί με την πρώτη πραγματική API κλήση και τα pilot evals.
6. Εκτέλεσε `pnpm run doctor`. Δείχνει μόνο αν υπάρχουν τιμές, ποτέ τις τιμές των secrets. Έπειτα χρειάζεται πραγματικό integration smoke test, όχι μόνο `/readyz` ή unit tests.

Μόνιμα API keys δεν στέλνονται ποτέ στον browser. Το model request χρησιμοποιεί `store:false`. Αυτό δεν αποτελεί ισχυρισμό για μηδενική διατήρηση από τον πάροχο· έλεγξε τα ισχύοντα API data controls για την επιχείρηση πριν τη δημόσια λειτουργία.

Επίσημη τεκμηρίωση: [Developer quickstart](https://developers.openai.com/api/docs/quickstart), [production practices](https://developers.openai.com/api/docs/guides/production-best-practices), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
