// Firebase initialization.
// Fill in your project's config in firebase-config.js (see README.md for setup steps).
import { firebaseConfig } from '../firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, serverTimestamp, query, where, getDocs
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
const auth = getAuth(app);

export const authReady = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  signInAnonymously(auth).catch((err) => {
    console.error('Firebase anonymous sign-in failed:', err);
    reject(err);
  });
});

export { doc, getDoc, setDoc, collection, serverTimestamp, query, where, getDocs };
