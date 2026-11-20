import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { doc, getFirestore, onSnapshot, setDoc } from "firebase/firestore";
import { sanitizeState } from "./storage";

const env = import.meta.env;
const ready = Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_AUTH_DOMAIN && env.VITE_FIREBASE_PROJECT_ID);
let auth, db;
if (ready) {
  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID
  });
  auth = getAuth(app);
  db = getFirestore(app);
}

export const firebaseEnabled = ready;

export async function connectCloud() {
  if (!ready) throw new Error("Firebase credentials are not configured.");
  const credential = await signInAnonymously(auth);
  return credential.user.uid;
}

export function watchCloud(uid, callback, onError = console.error) {
  if (!db || !uid) return () => {};
  return onSnapshot(
    doc(db, "physicsUsers", uid),
    snap => {
      if (snap.exists()) {
        callback(sanitizeState(snap.data()));
      }
    },
    onError
  );
}

export async function saveCloud(uid, data) {
  if (!db || !uid) return;
  const clean = sanitizeState(data);
  await setDoc(doc(db, "physicsUsers", uid), clean, { merge: true });
}
