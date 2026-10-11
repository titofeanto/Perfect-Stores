// Pintu tunggal akses data transaksi. Semua modul mengimpor dari sini (doc, getDoc, setDoc, ...).
// Implementasinya dipilih lewat backend-config.js: Firestore (default) atau Google Sheets.
import { BACKEND } from '../backend-config.js';

const impl = BACKEND.transactions === 'sheets' && BACKEND.endpoint
  ? await import('./backend-sheets.js')
  : await import('./backend-firebase.js');

export const db = impl.db;
export const authReady = impl.authReady;
export const doc = impl.doc;
export const getDoc = impl.getDoc;
export const setDoc = impl.setDoc;
export const collection = impl.collection;
export const serverTimestamp = impl.serverTimestamp;
export const query = impl.query;
export const where = impl.where;
export const getDocs = impl.getDocs;
