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

/**
 * claimChildren: Eltern/Spieler ordnen sich direkt nach dem Beitritt ihrem Kind bzw. Spielerprofil zu.
 *
 * Eingabe: { groupId, existingIds: [Spieler-IDs aus der Liste], newNames: [Namen neuer Kinder] }
 *  - vorhandene Profile werden mit dem Mitglied verknüpft (childIds)
 *  - neue Kinder werden direkt in der Spielerliste des Teams angelegt (shared/players + shared/playersPublic)
 *  - Ergebnis erscheint auch im Trainer-Log
 * Nur für Mitglieder mit der Rolle "eltern" oder "spieler".
 */
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

exports.claimChildren = onCall({ region: "europe-west1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Bitte anmelden.");
  const uid = request.auth.uid;
  const data = request.data || {};
  const groupId = typeof data.groupId === "string" ? data.groupId : "";
  if (!groupId) throw new HttpsError("invalid-argument", "Team fehlt.");

  const existingIds = [...new Set((Array.isArray(data.existingIds) ? data.existingIds : []).filter((x) => typeof x === "string" && x))].slice(0, 10);
  const seen = new Set();
  const newNames = (Array.isArray(data.newNames) ? data.newNames : [])
    .map((n) => (typeof n === "string" ? n.trim().replace(/\s+/g, " ").slice(0, 60) : ""))
    .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
    .slice(0, 5);
  if (existingIds.length + newNames.length === 0) {
    throw new HttpsError("invalid-argument", "Bitte ein Kind auswählen oder einen Namen eintragen.");
  }

  const memRef = db.doc(`groups/${groupId}/members/${uid}`);
  const memSnap = await memRef.get();
  if (!memSnap.exists) throw new HttpsError("permission-denied", "Du bist kein Mitglied dieses Teams.");
  const member = memSnap.data();
  const roles = memberRoles(member);
  const isParent = roles.includes("eltern");
  const isPlayer = roles.includes("spieler");
  if (!isParent && !isPlayer) {
    throw new HttpsError("permission-denied", "Nur Eltern und Spieler können sich mit einem Kind bzw. Profil verknüpfen.");
  }
  const playerOnly = isPlayer && !isParent;
  const already = Array.isArray(member.childIds) ? member.childIds : [];
  if (playerOnly && already.length + existingIds.filter((x) => !already.includes(x)).length + newNames.length > 1) {
    throw new HttpsError("failed-precondition", "Als Spieler kannst du nur mit einem Profil verknüpft sein.");
  }

  const playersRef = db.doc(`groups/${groupId}/shared/players`);
  const pubRef = db.doc(`groups/${groupId}/shared/playersPublic`);
  const who = member.name || member.email || "Ein Mitglied";

  const result = await db.runTransaction(async (tx) => {
    const [pSnap, pubSnap] = await Promise.all([tx.get(playersRef), tx.get(pubRef)]);
    const items = pSnap.exists && Array.isArray(pSnap.data().items) ? pSnap.data().items : [];
    const pubItems = pubSnap.exists && Array.isArray(pubSnap.data().items) ? pubSnap.data().items : [];

    // Vorhandene Profile müssen es wirklich geben (und aktiv sein)
    const linkedExisting = existingIds.map((id) => items.find((p) => p && p.id === id));
    if (linkedExisting.some((p) => !p || p.active === false)) {
      throw new HttpsError("not-found", "Ein gewähltes Kind gibt es nicht mehr. Bitte Liste neu laden.");
    }

    // Neue Kinder anlegen (Namen, die es schon gibt, werden nicht doppelt angelegt)
    const created = [];
    for (const n of newNames) {
      const dup = items.find((p) => p && p.active !== false && (p.name || "").trim().toLowerCase() === n.toLowerCase());
      if (dup) { if (!existingIds.includes(dup.id)) existingIds.push(dup.id); continue; }
      created.push({
        id: newId(), name: n, birthYear: 2019, birthDate: "", strength: 1, active: true, jersey: "", notes: "",
        vereinsmitglied: false, spielerpass: false,
        contacts: isParent && member.email ? [{ name: who, relation: "Elternteil", phone: "", email: member.email, address: "" }] : [],
      });
    }
    if (created.length) {
      tx.set(playersRef, { items: [...items, ...created], updatedAt: new Date().toISOString() });
      tx.set(pubRef, {
        items: [...pubItems, ...created.map((p) => ({ id: p.id, name: p.name, active: true }))],
        updatedAt: new Date().toISOString(),
      });
    }

    const childIds = [...new Set([...already, ...existingIds, ...created.map((p) => p.id)])];
    tx.set(memRef, { childIds }, { merge: true });

    // Log für Trainer/Admins (Stufe "coach"); Dokument-ID sortiert neueste zuerst wie in der App
    const ms = Date.now();
    const namesOf = [...linkedExisting.map((p) => p.name), ...created.map((p) => p.name)].join(", ");
    const logRef = db.collection(`groups/${groupId}/log_coach`).doc(String(9999999999999 - ms).padStart(13, "0") + "_" + Math.random().toString(36).slice(2, 6));
    tx.set(logRef, {
      ms, ts: new Date(ms).toISOString(), uid, name: who, cat: "spieler",
      text: `${who} hat sich mit ${namesOf || "einem Profil"} verknüpft${created.length ? ` (neu angelegt: ${created.map((p) => p.name).join(", ")})` : ""}`,
    });
    return { linked: childIds.length, created: created.map((p) => ({ id: p.id, name: p.name })) };
  });

  return { ok: true, ...result };
});
