// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDjnOLo0e2Qg74gWcQm6iD28B50a8IJKrM",
  authDomain: "geobanner-c8206.firebaseapp.com",
  projectId: "geobanner-c8206",
  storageBucket: "geobanner-c8206.firebasestorage.app",
  messagingSenderId: "386482254607",
  appId: "1:386482254607:web:79de7a48669a014a0c847a"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();