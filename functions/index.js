/**
 * Teammanager – Cloud Functions
 *
 * deleteUserAccount: Löscht einen Nutzer vollständig – Anmeldekonto (Firebase Authentication)
 * UND alle zugehörigen Daten in Firestore (Rolle, Mitgliedschaften, Beitrittswünsche, Presence).
 *
 * Aufruf nur durch den globalen Admin (roles/{uid}.role == "admin"), entweder mit
 *   { uid: "<Nutzer-ID>" }   oder   { email: "<E-Mail>" }   (z. B. für verwaiste Konten ohne Datenbank-Eintrag).
 *
 * Schutzmaßnahmen:
 *  - nicht anmeldbar ohne Login, nur globale Admins
 *  - nicht das eigene Konto (dafür gibt es "Profil löschen" in den Einstellungen)
 *  - keine globalen Admins
 *  - nicht, wenn die Person der einzige Admin eines Teams ist
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Rollen eines Mitglieds (Feld "roles" oder altes Einzelfeld "role")
const memberRoles = (m) =>
  Array.isArray(m && m.roles) && m.roles.length ? m.roles : [(m && m.role) || "eltern"];

async function assertGlobalAdmin(uid) {
  const snap = await db.doc(`roles/${uid}`).get();
  if (!snap.exists || snap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Nur der globale Admin darf Konten vollständig löschen.");
  }
}

// Löscht Dokumente in Paketen (Firestore erlaubt max. 500 Operationen je Batch)
async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
}

exports.deleteUserAccount = onCall({ region: "europe-west1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Bitte anmelden.");
  const callerUid = request.auth.uid;
  await assertGlobalAdmin(callerUid);

  const data = request.data || {};
  let uid = typeof data.uid === "string" ? data.uid.trim() : "";
  const email = typeof data.email === "string" ? data.email.trim() : "";

  // Konto über die E-Mail finden (z. B. verwaiste Konten, die in der App nicht mehr auftauchen)
  if (!uid && email) {
    try {
      uid = (await admin.auth().getUserByEmail(email)).uid;
    } catch (e) {
      if (e.code === "auth/user-not-found") {
        throw new HttpsError("not-found", "Kein Anmeldekonto mit dieser E-Mail gefunden.");
      }
      throw new HttpsError("internal", "Suche fehlgeschlagen: " + e.message);
    }
  }
  if (!uid) throw new HttpsError("invalid-argument", "Bitte uid oder email angeben.");
  if (uid === callerUid) {
    throw new HttpsError("failed-precondition", "Dein eigenes Profil löschst du in den Einstellungen unter „Profil löschen“.");
  }

  const target = await db.doc(`roles/${uid}`).get();
  if (target.exists && target.data().role === "admin") {
    throw new HttpsError("failed-precondition", "Ein globaler Admin kann hier nicht gelöscht werden.");
  }

  // Einziger Admin eines Teams? Dann abbrechen, damit kein Team ohne Admin zurückbleibt
  const groups = await db.collection("groups").get();
  const blockers = [];
  for (const g of groups.docs) {
    const mine = await g.ref.collection("members").doc(uid).get();
    if (!mine.exists || !memberRoles(mine.data()).includes("admin")) continue;
    const all = await g.ref.collection("members").get();
    const otherAdmins = all.docs.filter((d) => d.id !== uid && memberRoles(d.data()).includes("admin"));
    if (otherAdmins.length === 0) blockers.push(g.data().name || g.id);
  }
  if (blockers.length) {
    throw new HttpsError(
      "failed-precondition",
      `Die Person ist einziger Admin von: ${blockers.join(", ")}. Bitte zuerst einen weiteren Admin ernennen.`
    );
  }

  // 1) Datenbank aufräumen
  const refs = [];
  groups.docs.forEach((g) => {
    refs.push(g.ref.collection("members").doc(uid));
    refs.push(g.ref.collection("joinRequests").doc(uid));
  });
  refs.push(db.doc(`presence/${uid}`), db.doc(`roles/${uid}`));
  await deleteRefs(refs);

  // 2) Anmeldekonto löschen
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw new HttpsError("internal", "Anmeldekonto konnte nicht gelöscht werden: " + e.message);
    }
  }
  console.log(`deleteUserAccount: ${uid} gelöscht durch ${callerUid}`);
  return { ok: true, uid };
});
