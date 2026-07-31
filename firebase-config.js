// js/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBVpPhNB0UqQl62WxIZbPPfJ8KYnk2HYRM",
  authDomain: "group-a0ee4.firebaseapp.com",
  projectId: "group-a0ee4",
  storageBucket: "group-a0ee4.firebasestorage.app",
  messagingSenderId: "519444570577",
  appId: "1:519444570577:web:1af7aaa700c1e7962740f0"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, { experimentalForceLongPolling: true });
const auth = getAuth(app);
const storage = getStorage(app);

export { app, db, auth, storage };
