// ============================================================
//   BOOTSTRAP ADMIN — add a UID to admin_roles
// ============================================================
//
// Why: firestore.rules has `allow write: if false` for admin_roles,
// so no client-side code can self-register. You need either:
//   (a) Firebase Console → Firestore → admin_roles → Add document
//   (b) This script (Firebase Admin SDK, bypasses rules)
//
// Usage:
//   1. Go to Firebase Console → Project Settings → Service Accounts
//   2. Click "Generate new private key" → download the JSON
//   3. Save it next to this file as `service-account.json`
//   4. Run:    node bootstrap-admin.cjs <UID> [email]
//      Example: node bootstrap-admin.cjs hY2PP47C5cdGhVE7FL1jtdKjrL53 admin@group.com
//
//   5. **Delete `service-account.json` immediately after running!**
//      Never commit it to git. Never leave it on a shared machine.
//
// The script is idempotent — running it twice is safe; it just overwrites.
//
// ============================================================

const path = require('path');
const fs = require('fs');

// 1) Validate args
const uid = process.argv[2];
const email = process.argv[3] || '';
if (!uid) {
    console.error('\nUsage: node bootstrap-admin.cjs <UID> [email]');
    console.error('Example: node bootstrap-admin.cjs hY2PP47C5cdGhVE7FL1jtdKjrL53 admin@group.com\n');
    process.exit(1);
}
if (!/^[a-zA-Z0-9_-]{20,}$/.test(uid)) {
    console.error(`[error] "${uid}" doesn't look like a Firebase Auth UID (expected 20+ chars, alphanumeric/dash/underscore).`);
    process.exit(1);
}

// 2) Find the service account key
const keyPath = path.join(__dirname, 'service-account.json');
if (!fs.existsSync(keyPath)) {
    console.error(`[error] Missing service-account.json next to this script.`);
    console.error(`  → Firebase Console → Project Settings → Service Accounts → Generate new private key`);
    console.error(`  → Save the downloaded file as: ${keyPath}`);
    process.exit(1);
}

// 3) Lazy-load firebase-admin so the user gets a clean error if it's not installed
let admin;
try {
    admin = require('firebase-admin');
} catch (e) {
    console.error('[error] firebase-admin is not installed. Run:  npm install --no-save firebase-admin');
    console.error('        (use --no-save so it doesn\'t pollute your package.json — Admin SDK is a dev tool, not a runtime dep)');
    process.exit(1);
}

// 4) Initialize
const serviceAccount = require(keyPath);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 5) Write
const docRef = db.collection('admin_roles').doc(uid);
docRef.set({
    email: email || null,
    role: 'admin',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    bootstrappedBy: 'bootstrap-admin.cjs'
}, { merge: true })
    .then(() => {
        console.log(`\n✅ Done. admin_roles/${uid} is now an admin.`);
        if (email) console.log(`   email: ${email}`);
        console.log(`\nNext:`);
        console.log(`  1. Reload your admin dashboard (the activity log toast should disappear).`);
        console.log(`  2. DELETE service-account.json from this folder NOW — never commit it.\n`);
        process.exit(0);
    })
    .catch((err) => {
        console.error('[error] Firestore write failed:', err.message);
        process.exit(1);
    });
