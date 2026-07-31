# NTI Group 16 — Admin Guide

دليل سريع لإعداد الـ admin والـ data في لوحة التحكم.

## المشكلة الشائعة: "Activity log: permission-denied"

السبب: الـ admin اللي بيحاول يكتب في `activity` مش موجود في `admin_roles`.

### الحل (Firebase Console)

1. افتح [Firebase Console](https://console.firebase.google.com/) → اختار مشروع **group-a0ee4**
2. من الـ sidebar: **Firestore Database** → **Data** tab
3. لو مجموعة `admin_roles` مش موجودة، اضغط **Start collection** → اسمها `admin_roles`
4. اضغط **Add document**:
   - **Document ID**: الصق الـ UID بتاعك (اللي بتاخده من DevTools Console بعد ما تعمل login — أو اضغط على الـ email في الـ topbar هينسخه)
   - **Field 1**: `email` (string) = الإيميل بتاعك
   - **Field 2**: `role` (string) = `admin`
   - **Field 3**: `createdAt` (timestamp) = اضغط على الحقل واختار "Now"
5. اضغط **Save**
6. **Reload** صفحة الـ admin

### الحل البديل (Node.js — لو مش owner في Firebase Console)

1. Firebase Console → **Project Settings** (الترس) → **Service Accounts** tab
2. اضغط **Generate new private key** → هيحمّل ملف JSON
3. احفظه في نفس فولدر المشروع باسم `service-account.json`
4. ثبّت firebase-admin مرة واحدة:
   ```bash
   npm install --no-save firebase-admin
   ```
5. شغّل الـ bootstrap:
   ```bash
   node bootstrap-admin.cjs <UID> [email]
   ```
   مثال:
   ```bash
   node bootstrap-admin.cjs hY2PP47C5cdGhVE7FL1jtdKjrL53 group16@group.com
   ```
6. **مهم جداً:** امسح `service-account.json` فوراً بعد ما تخلص (الـ `.gitignore` بيمنع رفعه بالغلط بس).

## Deploy الـ Firestore Rules

في كل مرة تعدّل `firestore.rules` لازم تعمله deploy على Firebase:

### من Firebase Console
- **Firestore** → **Rules** tab → الصق المحتوى → **Publish**

### من Firebase CLI
```bash
npm install -g firebase-tools
firebase login
firebase use group-a0ee4
firebase deploy --only firestore:rules
```

## ⚠️ Demo Mode (مؤقت للتسليم)

للتسليم السريع، الـ `firestore.rules` الحالية **فضفاضة جداً**: أي مستخدم مسجّل دخوله يقدر يقرأ ويكتب كل حاجة. ده **مش آمن للإنتاج** لكنه مناسب للـ demo.

**لاسترجاع الـ rules الأصلية (الآمنة) بعد التسليم:**

```powershell
# 1) اقرأ النسخة المحفوظة
Get-Content firestore.rules.strict

# 2) الصقها في Firebase Console → Firestore → Rules → Publish
#    أو شغّل:
firebase deploy --only firestore:rules --file firestore.rules.strict
```

الـ `firestore.rules.strict` فيها:
- `isAdmin()` بيشترط وجود UID في `admin_roles`
- الـ public يقدر يقرأ فقط
- كل write محتاج `isAdmin()`

## Cache & Updates

الـ service worker بيخزّن الملفات بقوة. لو غيّرت أي ملف ومش شايف التحديث:
- **افتح DevTools (`F12`)** → **Application** tab → **Service Workers** → **Unregister**
- **Application** → **Storage** → **Clear site data**
- Reload

أو من داخل لوحة الأدمن اضغط على أيقونة الـ 🧹 broom في الـ topbar — هيعمل كل ده بضغطة.

## بنية المشروع

```
G16/
├── index.html         # الصفحة الرئيسية (الفريق)
├── 392010.html        # لوحة الإدارة
├── main.js            # منطق الصفحة الرئيسية
├── admin.js           # منطق لوحة الإدارة
├── main.css           # ستايل الصفحة
├── admin.css          # ستايل لوحة الإدارة
├── firebase-config.js # Firebase init
├── firestore.rules    # صلاحيات Firestore (loose demo mode)
├── firestore.rules.strict # النسخة الآمنة — استخدمها بعد التسليم
├── sw.js              # Service Worker
├── manifest.json      # PWA manifest
├── bootstrap-admin.cjs # سكريبت لإضافة admin من Node
├── seed-resources.cjs  # سكريبت seed لملء collection الـ resources
└── ADMIN.md           # هذا الملف
```

## ميزة "الملفات والروابط" (Resources)

من إصدار v2.1، قسم **"الملفات والتقارير"** في الصفحة الرئيسية مش ثابت — بيتعبّى ديناميكياً من `resources` collection في Firestore. تقدر من لوحة الأدمن (تاب "الملفات والروابط") تضيف/تعدل/تحذف أي رابط:

- **العنوان** + **الوصف** + **الرابط الخارجي** (Google Drive, Dropbox, GitHub, etc.)
- **النوع**: تقرير 📄 / عرض تقديمي 📊 / ملف 📁 / رابط خارجي 🔗
- **الأيقونة**: اختار من 10 أيقونات (PDF أحمر، مجلد، GitHub، كلاود، فيديو، صورة، كود...)
- **التمييز (highlight)**: لو عايز الكارت يبقى بارز زي الـ Final Report الأصلي
- **الترتيب**: drag-and-drop أو عدّل الرقم يدوياً
- **Bulk delete**: اختار كذا كارت مرة واحدة وامسحهم
- **Undo**: لو مسحت غلط، عندك 6 ثواني تراجع

### populate الـ resources بالكروت القديمة

لو عندك URLs في `settings/site` (masterPresentationUrl, reportUrl) وعايز تنقلهم للـ resources تلقائياً:

```powershell
node seed-resources.cjs
```

(بيشتغل بنفس `service-account.json` بتاع `bootstrap-admin.cjs`.)
