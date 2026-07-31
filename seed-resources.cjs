// ============================================================
//   SEED RESOURCES — one-time migration from settings to `resources`
// ============================================================
//
// What: Reads `settings/site.{masterPresentationUrl, reportPreviewUrl,
// reportUrl}` and creates two matching docs in the `resources`
// collection, so the main site's "Files and Reports" section can
// render them dynamically.
//
// Why: Before v2.1, the two cards were hardcoded in index.html. The
// new `resources` collection lets the admin add/remove/edit them.
// Running this once migrates any existing URLs from settings.
//
// Usage:
//   1. Same service-account.json as bootstrap-admin.cjs
//   2. Run:    node seed-resources.cjs
//   3. The script is idempotent — it uses fixed doc IDs so re-running
//      just overwrites the same two docs.
//   4. Delete service-account.json after.
//
// ============================================================

const path = require('path');
const fs = require('fs');

const keyPath = path.join(__dirname, 'service-account.json');
if (!fs.existsSync(keyPath)) {
    console.error('[error] Missing service-account.json next to this script.');
    process.exit(1);
}

let admin;
try {
    admin = require('firebase-admin');
} catch (e) {
    console.error('[error] firebase-admin not installed. Run: npm install --no-save firebase-admin');
    process.exit(1);
}

const serviceAccount = require(keyPath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

(async () => {
    try {
        const settingsSnap = await db.collection('settings').doc('site').get();
        const settings = settingsSnap.exists ? settingsSnap.data() : {};

        const seeds = [
            {
                id: 'seed-master-presentation',
                title: 'Master Presentation',
                description: 'البريزنتيشن المجمع لكل أعضاء الفريق',
                url: settings.masterPresentationUrl || '',
                type: 'presentation',
                icon: 'ph-presentation-chart',
                order: 0,
                highlight: false
            },
            {
                id: 'seed-final-report',
                title: 'Final Report',
                description: 'التقرير النهائي الشامل (47 صفحة)',
                url: settings.reportUrl || settings.reportPreviewUrl || '',
                type: 'report',
                icon: 'ph-file-pdf',
                order: 1,
                highlight: true
            }
        ];

        // Skip seeds with no URL — they would render as a broken card.
        const toWrite = seeds.filter(s => s.url && /^https?:\/\//i.test(s.url));
        if (!toWrite.length) {
            console.log('\n[info] No URLs found in settings/site. Nothing to seed.');
            console.log('       Add URLs via the admin Settings tab first, then re-run.\n');
            process.exit(0);
        }

        const batch = db.batch();
        toWrite.forEach(s => {
            batch.set(db.collection('resources').doc(s.id), {
                ...s,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                seededBy: 'seed-resources.cjs'
            });
        });
        await batch.commit();

        console.log(`\n✅ Seeded ${toWrite.length} resource(s) into the "resources" collection:`);
        toWrite.forEach(s => console.log(`   - [${s.type}] ${s.title} → ${s.url}`));
        console.log(`\nNext:`);
        console.log(`  1. Reload the main site (index.html) — the two cards should now render.`);
        console.log(`  2. In the admin Resources tab, you can edit them freely.`);
        console.log(`  3. DELETE service-account.json from this folder NOW.\n`);
        process.exit(0);
    } catch (err) {
        console.error('[error] seeding failed:', err.message);
        process.exit(1);
    }
})();
