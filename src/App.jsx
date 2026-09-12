import React, { useState, useEffect, useRef, useCallback } from "react";
import Dexie from "dexie";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile, sendPasswordResetEmail } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, deleteDoc, collection, addDoc, query, orderBy, limit, getDocs, serverTimestamp } from "firebase/firestore";
import { Home, ArrowLeft, Menu, X, BookOpen, Users, CalendarDays, Settings, Plus, Search, Edit2, Trash2, Download, Upload, Shuffle, Filter, Clock, Trophy, Bot, RefreshCw, CheckSquare, Square, Dices, ListChecks, Wallet, Phone, MapPin, AlertTriangle, ShieldCheck, ClipboardList, Star } from "lucide-react";

// ── DEXIE DB ──────────────────────────────────────────────────────
const db = new Dexie('GJugendCoachDB');
db.version(1).stores({ kv: 'key' });
db.version(2).stores({ kv: 'key', teamsets: '++id,date' });

// ── FIREBASE ──────────────────────────────────────────────────────
const FB_CONFIG = {
  apiKey: "AIzaSyDsC6ATr4_9F4GJxxgZ7NrEQy2QQobCnIY",
  authDomain: "teammanager-football.firebaseapp.com",
  projectId: "teammanager-football",
  storageBucket: "teammanager-football.firebasestorage.app",
  messagingSenderId: "418794589338",
  appId: "1:418794589338:web:8e919240086fabb5b9e323"
};
let fbApp, fbAuth, fbDb;
try {
  fbApp  = initializeApp(FB_CONFIG);
  fbAuth = getAuth(fbApp);
  fbDb   = getFirestore(fbApp);
} catch(e) { console.error("Firebase init failed:", e); }

// Read a shared collection document (stored as one doc per collection for simplicity)
// LEGACY (pre-Gruppen) — wird nur noch von der Migration gelesen, nicht mehr live genutzt
async function fbRead(col) {
  if(!fbDb) return null;
  try {
    const snap = await getDoc(doc(fbDb,"shared",col));
    return snap.exists() ? snap.data().items : null;
  } catch(e) { console.warn("fbRead",col,e); return null; }
}
async function fbWrite(col, items) {
  if(!fbDb) return;
  try {
    await setDoc(doc(fbDb,"shared",col),{items, updatedAt: new Date().toISOString()});
  } catch(e) { console.warn("fbWrite",col,e); }
}

// ── GRUPPEN ───────────────────────────────────────────────────────
// Erste Gruppe (fest vergebene, lesbare ID statt zufällig — vereinfacht die Migration).
// Später, sobald die UI zum Anlegen weiterer Gruppen steht, kommen dynamische IDs dazu.
const DEFAULT_GROUP_ID = "sternschanze-g2019";

async function fbReadGroup(groupId, col) {
  if(!fbDb) return null;
  try {
    const snap = await getDoc(doc(fbDb,"groups",groupId,"shared",col));
    return snap.exists() ? snap.data().items : null;
  } catch(e) { console.warn("fbReadGroup",col,e); return null; }
}
async function fbWriteGroup(groupId, col, items) {
  if(!fbDb) return;
  try {
    await setDoc(doc(fbDb,"groups",groupId,"shared",col),{items, updatedAt: new Date().toISOString()});
  } catch(e) { console.warn("fbWriteGroup",col,e); }
}

// Einmalige Migration: legt die erste Gruppe an, kopiert bestehende shared/*-Daten
// hinein und spiegelt die bisherigen globalen Rollen als Gruppen-Mitgliedschaften.
// Idempotent: bricht sofort ab, falls die Gruppe schon existiert.
const SHARED_COLLECTIONS = ["exercises","players","coaches","sessions","tournaments","kassenbuch","todos","meetings","customCats","teamsets"];
async function ensureGroupMigrated(user) {
  if(!fbDb || !user) return;
  try {
    const groupRef = doc(fbDb,"groups",DEFAULT_GROUP_ID);
    const groupSnap = await getDoc(groupRef);
    if(groupSnap.exists()) return; // bereits migriert
    await setDoc(groupRef,{
      name: "SC Sternschanze G-Jugend 2019",
      createdAt: new Date().toISOString(),
      createdBy: user.uid,
      migratedFromShared: true
    });
    for(const col of SHARED_COLLECTIONS) {
      const items = await fbRead(col);
      if(items!==null) await fbWriteGroup(DEFAULT_GROUP_ID, col, items);
    }
    const rolesSnap = await getDocs(collection(fbDb,"roles"));
    for(const d of rolesSnap.docs) {
      const data = d.data();
      await setDoc(doc(fbDb,"groups",DEFAULT_GROUP_ID,"members",d.id),{
        uid: d.id,
        role: data.role||"pending",
        name: data.name||"",
        email: data.email||"",
        photo: data.photo||null,
        joinedAt: data.createdAt||new Date().toISOString()
      });
    }
    console.info("[Gruppen-Migration] abgeschlossen:", DEFAULT_GROUP_ID);
  } catch(e) { console.warn("[Gruppen-Migration] fehlgeschlagen", e); }
}

// ── GRUPPEN-VERWALTUNG (Erstellen / Beitreten / Anfragen) ──────────
function genInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne verwechselbare Zeichen (0/O, 1/I)
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function slugifyGroupName(name) {
  return (name || "team").toLowerCase()
    .replace(/[äöüß]/g, c => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" }[c]))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "team";
}

// Neue Gruppe anlegen, Ersteller wird automatisch admin dieser Gruppe, Einladungscode wird generiert
async function createGroup(user, name) {
  if (!fbDb || !user || !name?.trim()) return { ok: false, error: "invalid" };
  try {
    const base = slugifyGroupName(name);
    let groupId = base;
    for (let i = 0; i < 20; i++) {
      const snap = await getDoc(doc(fbDb, "groups", groupId));
      if (!snap.exists()) break;
      groupId = `${base}-${Math.floor(Math.random() * 1000)}`;
    }
    const code = genInviteCode();
    await setDoc(doc(fbDb, "groups", groupId), {
      name: name.trim(), createdAt: new Date().toISOString(), createdBy: user.uid
    });
    await setDoc(doc(fbDb, "groups", groupId, "settings", "invite"), { code });
    await setDoc(doc(fbDb, "inviteCodes", code), { groupId });
    await setDoc(doc(fbDb, "groups", groupId, "members", user.uid), {
      uid: user.uid, role: "admin", name: user.displayName || "", email: user.email || "",
      photo: user.photoURL || null, joinedAt: new Date().toISOString()
    });
    return { ok: true, groupId };
  } catch (e) { return { ok: false, error: e.code || "unknown" }; }
}

// Sofortiger Beitritt per Einladungscode — landet immer als Rolle "eltern"
// (Admin kann danach in der Nutzerverwaltung hochstufen)
async function joinGroupByCode(user, code) {
  if (!fbDb || !user || !code?.trim()) return { ok: false, error: "invalid" };
  try {
    const codeSnap = await getDoc(doc(fbDb, "inviteCodes", code.trim().toUpperCase()));
    if (!codeSnap.exists()) return { ok: false, error: "invalid-code" };
    const groupId = codeSnap.data().groupId;
    await setDoc(doc(fbDb, "groups", groupId, "members", user.uid), {
      uid: user.uid, role: "eltern", name: user.displayName || "", email: user.email || "",
      photo: user.photoURL || null, joinedAt: new Date().toISOString()
    });
    return { ok: true, groupId };
  } catch (e) { return { ok: false, error: e.code || "unknown" }; }
}

// Beitrittswunsch ohne Code — Admin der Zielgruppe muss aktiv bestätigen
async function requestToJoinGroup(user, groupId) {
  if (!fbDb || !user) return { ok: false, error: "invalid" };
  try {
    await setDoc(doc(fbDb, "groups", groupId, "joinRequests", user.uid), {
      uid: user.uid, name: user.displayName || "", email: user.email || "",
      photo: user.photoURL || null, requestedAt: new Date().toISOString()
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.code || "unknown" }; }
}
async function cancelJoinRequest(user, groupId) {
  if (!fbDb || !user) return;
  try { await deleteDoc(doc(fbDb, "groups", groupId, "joinRequests", user.uid)); } catch (e) {}
}
async function approveJoinRequest(groupId, uid, role = "eltern") {
  if (!fbDb) return;
  try {
    const reqSnap = await getDoc(doc(fbDb, "groups", groupId, "joinRequests", uid));
    const data = reqSnap.exists() ? reqSnap.data() : {};
    await setDoc(doc(fbDb, "groups", groupId, "members", uid), {
      uid, role, name: data.name || "", email: data.email || "", photo: data.photo || null,
      joinedAt: new Date().toISOString()
    });
    await deleteDoc(doc(fbDb, "groups", groupId, "joinRequests", uid));
  } catch (e) { console.warn("approveJoinRequest", e); }
}
async function rejectJoinRequest(groupId, uid) {
  if (!fbDb) return;
  try { await deleteDoc(doc(fbDb, "groups", groupId, "joinRequests", uid)); } catch (e) {}
}

// Offenes Verzeichnis aller Gruppen (fürs Dropdown "Team beitreten")
function useAllGroups(user) {
  const [groups, setGroups] = useState([]);
  useEffect(() => {
    if (!fbDb || !user) return;
    const unsub = onSnapshot(collection(fbDb, "groups"), snap => {
      setGroups(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || "").localeCompare(b.name || "")));
    }, () => {});
    return unsub;
  }, [user]);
  return groups;
}

// Gruppen, in denen der aktuelle Nutzer Mitglied ist (Live)
// Bewusst OHNE collectionGroup-Abfrage: stattdessen alle Gruppen auflisten (schon erlaubt)
// und pro Gruppe einen einfachen, gezielten Dokument-Zugriff auf den eigenen Mitgliedschafts-Eintrag machen.
// Das ist bei wenigen Gruppen genauso schnell, aber deutlich weniger fehleranfällig bzgl. Security Rules.
function useUserGroups(user) {
  const [memberships, setMemberships] = useState(null); // null = lädt noch
  const [allGroupIds, setAllGroupIds] = useState(null);

  useEffect(() => {
    if (!fbDb || !user) { setAllGroupIds(null); setMemberships(user === null ? null : []); return; }
    const unsub = onSnapshot(collection(fbDb, "groups"), snap => {
      setAllGroupIds(snap.docs.map(d => d.id));
    }, e => { console.error("[useUserGroups] Fehler beim Laden der Gruppenliste:", e); setAllGroupIds([]); });
    return unsub;
  }, [user]);

  useEffect(() => {
    if (!fbDb || !user || !allGroupIds) return;
    let cancelled = false;
    (async () => {
      const results = [];
      for (const gid of allGroupIds) {
        try {
          const snap = await getDoc(doc(fbDb, "groups", gid, "members", user.uid));
          if (snap.exists()) results.push({ groupId: gid, role: snap.data().role });
        } catch (e) {
          // kein Zugriff = keine Mitgliedschaft in dieser Gruppe, einfach überspringen
        }
      }
      if (!cancelled) setMemberships(results);
    })();
    return () => { cancelled = true; };
  }, [user, allGroupIds ? allGroupIds.join(",") : null]);

  return memberships;
}

// Offene Beitrittswünsche einer Gruppe (für Admin/Trainer-Ansicht)
function useJoinRequests(groupId, canSee) {
  const [requests, setRequests] = useState([]);
  useEffect(() => {
    if (!fbDb || !groupId || !canSee) { setRequests([]); return; }
    const unsub = onSnapshot(collection(fbDb, "groups", groupId, "joinRequests"), snap => {
      setRequests(snap.docs.map(d => d.data()));
    }, () => {});
    return unsub;
  }, [groupId, canSee]);
  return requests;
}
// ── ROLE SYSTEM ───────────────────────────────────────────────────
// Roles: "admin" | "trainer" | "eltern" | "pending"
// Permissions per role
const USER_ROLES = {
  admin:   {label:"Admin",    color:"#dc2626",bg:"#fee2e2",emoji:"👑"},
  trainer: {label:"Trainer",  color:"#2563eb",bg:"#dbeafe",emoji:"🧑‍🏫"},
  eltern:  {label:"Eltern",   color:"#16a34a",bg:"#dcfce7",emoji:"👪"},
  pending: {label:"Ausstehend",color:"#92400e",bg:"#fef3c7",emoji:"⏳"},
  banned:  {label:"Gesperrt", color:"#64748b",bg:"#f1f5f9",emoji:"🚫"},
};
const CAN = {
  // tabs visible
  start:    ["admin","trainer","eltern"],
  library:  ["admin","trainer"],
  team:     ["admin","trainer","eltern"],
  training: ["admin","trainer","eltern"],
  calendar: ["admin","trainer","eltern"],
  teamplaner:["admin","trainer","eltern"],
  turnier:  ["admin","trainer","eltern"],
  kasse:    ["admin","trainer"],
  orga:     ["admin","trainer"],
  settings: ["admin"],
  // actions
  editAnything:   ["admin","trainer"],
  editKasse:      ["admin"],
  seeStrength:    ["admin","trainer"],
  manageRoles:    ["admin"],
  seeActivity:    ["admin"],
};
function can(role, perm) {
  return (CAN[perm]||[]).includes(role||"pending");
}

function useRole(user) {
  const [role,setRole]=useState(null); // null=loading
  const [allUsers,setAllUsers]=useState([]);

  useEffect(()=>{
    if(!fbDb||!user){
      // If no Firebase, give full access (local mode)
      setRole(user===null?null:!fbDb?"admin":"pending");
      return;
    }
    // Listen to own role doc
    // Track whether we've connected to Firestore at all
    let connected=false;
    // Fallback: if Firestore never responds (offline/rules error), grant admin only if no connection
    const fallback=setTimeout(()=>{
      if(!connected) setRole(r=>r===null?"admin":r); // truly offline = admin fallback
    },8000);
    const unsub=onSnapshot(doc(fbDb,"roles",user.uid),async snap=>{
      connected=true;
      clearTimeout(fallback);
      if(snap.exists()){
        // Update name/email/photo on each login in case they changed
        const updates={};
        if(user.email&&snap.data().email!==user.email) updates.email=user.email;
        if(user.displayName&&snap.data().name!==user.displayName) updates.name=user.displayName;
        if(user.photoURL&&snap.data().photo!==user.photoURL) updates.photo=user.photoURL;
        if(Object.keys(updates).length>0) setDoc(doc(fbDb,"roles",user.uid),updates,{merge:true}).catch(()=>{});
        setRole(snap.data().role||"pending");
      } else {
        // New user: first ever = admin, otherwise pending
        try {
          const rolesSnap=await getDocs(collection(fbDb,"roles"));
          const newRole=rolesSnap.empty?"admin":"pending";
          await setDoc(doc(fbDb,"roles",user.uid),{
            uid:user.uid, name:user.displayName||"",
            email:user.email||"",
            photo:user.photoURL||null, role:newRole,
            createdAt:new Date().toISOString()
          });
          // Notify admins if this is a new pending user
          if(newRole==="pending"){
            await addDoc(collection(fbDb,"activity"),{
              uid:user.uid, name:user.displayName||user.email,
              photo:user.photoURL||null,
              action:"new_user", detail:user.displayName||user.email||"",
              ts:new Date().toISOString()
            });
          }
          setRole(newRole);
        } catch(e){clearTimeout(fallback);setRole("pending");} // if write fails, pending
      }
    },e=>{
      // Firestore error (e.g. permission denied before rules update)
      clearTimeout(fallback);
      if(!connected) setRole("admin"); // never connected = offline fallback
      else setRole("pending"); // connected but error = pending for safety
    });
    return ()=>{clearTimeout(fallback);unsub();};
  },[user]);

  // Admin: listen to all users
  useEffect(()=>{
    if(!fbDb||!user) return;
    const unsub=onSnapshot(collection(fbDb,"roles"),snap=>{
      setAllUsers(snap.docs.map(d=>d.data()).sort((a,b)=>(a.name||"").localeCompare(b.name||"")));
    },()=>{});
    return unsub;
  },[user]);

  const setUserRole=async(uid,newRole)=>{
    if(!fbDb) return;
    await setDoc(doc(fbDb,"roles",uid),{role:newRole},{merge:true});
  };
  const setUserName=async(uid,name)=>{
    if(!fbDb) return;
    await setDoc(doc(fbDb,"roles",uid),{name},{merge:true});
  };
  const deleteUser=async(uid)=>{
    if(!fbDb) return;
    await deleteDoc(doc(fbDb,"roles",uid));
  };

  const pendingCount=allUsers.filter(u=>u.role==="pending").length;
  return {role, allUsers, setUserRole, setUserName, deleteUser, pendingCount};
}



// ── PERSONAL SETTINGS ─────────────────────────────────────────────
function usePersonalSettings(userId) {
  const key = userId ? `personal_${userId}` : "personal_guest";
  const load = () => { try { return JSON.parse(localStorage.getItem(key)||"{}"); } catch{return {};} };
  const [prefs, setPrefsRaw] = useState(load);

  useEffect(()=>{ if(userId) setPrefsRaw(load()); },[userId]);

  const setPrefs = (update) => {
    setPrefsRaw(prev => {
      const next = {...prev,...(typeof update==="function"?update(prev):update)};
      localStorage.setItem(key, JSON.stringify(next));
      return next;
    });
  };

  // Apply dark mode whenever prefs change
  useEffect(()=>{ applyTheme(prefs.darkMode||false); },[prefs.darkMode]);

  return [prefs, setPrefs];
}
// ── PRESENCE ──────────────────────────────────────────────────────
async function setPresence(user, online) {
  if(!fbDb||!user) return;
  try {
    await setDoc(doc(fbDb,"presence",user.uid),{
      uid:user.uid, name:user.displayName||user.email,
      photo:user.photoURL||null,
      online, lastSeen:new Date().toISOString()
    });
  } catch(e) {}
}

// ── ACTIVITY LOG ──────────────────────────────────────────────────
async function logActivity(user, action, detail="") {
  if(!fbDb||!user) return;
  try {
    await addDoc(collection(fbDb,"activity"),{
      uid:user.uid, name:user.displayName||user.email,
      photo:user.photoURL||null,
      action, detail,
      ts:new Date().toISOString()
    });
  } catch(e) {}
}

const APP_VERSION = "3.23.0";
const BUILTIN_CATS = {
  aufwaermen: { label:"Aufwärmen", emoji:"🔥", color:"#ea580c", bg:"#fff7ed", builtin:true },
  uebung:     { label:"Übung",     emoji:"⚽", color:"#2563eb", bg:"#eff6ff", builtin:true },
  spielform:  { label:"Spielform", emoji:"🏆", color:"#16a34a", bg:"#f0fdf4", builtin:true },
};
// Legacy category keys → new keys (for existing exercises in DB)
const CAT_LEGACY = { koordination:"uebung", technik:"uebung", abschluss:"uebung" };
// Normalize a category key (handle legacy + unknown)
function normCat(cat) { return CAT_LEGACY[cat]||cat; }
// Will be overwritten at runtime with merged builtin+custom cats
let CATS = {...BUILTIN_CATS};
const CUSTOM_CAT_PALETTE = [
  {color:"#0891b2",bg:"#ecfeff"},{color:"#65a30d",bg:"#f7fee7"},
  {color:"#9333ea",bg:"#faf5ff"},{color:"#e11d48",bg:"#fff1f2"},
  {color:"#0369a1",bg:"#f0f9ff"},{color:"#b45309",bg:"#fffbeb"},
];
const PTAGS = ["Dribbeln","Passspiel","Torschuss","Zweikampf","Koordination","Gleichgewicht","Reaktion","Schnelligkeit","Ausdauer","Teamwork","Spaß","Kreativität","Wettkampf","Funino","Motorik","Raumgefühl"];
const PMAT  = ["Hütchen","Bälle","Minitore","Leibchen","Stangen","Reifen","Pylonen","Markierungsscheiben","Seilchen","Tore (groß)"];
const STR = {
  1:{label:"Entdecker", emoji:"🌱",color:"#16a34a",light:"#dcfce7",desc:"Findet den Ball, läuft hinterher – noch kein gezieltes Dribbeln"},
  2:{label:"Entwickler",emoji:"🌟",color:"#b45309",light:"#fef3c7",desc:"Ball unter Kontrolle, einfaches Dribbling – spielt manchmal mit Team"},
  3:{label:"Spieler",   emoji:"⭐",color:"#dc2626",light:"#fee2e2",desc:"Gezieltes Passspiel, Torabschluss – liest einfache Spielsituationen"},
  4:{label:"Antreiber", emoji:"🏆",color:"#1d4ed8",light:"#dbeafe",desc:"Konstant stark, sucht aktiv den Ball – motiviert Mitspieler"},
};
const ROLES = {head:"Cheftrainer",assistant:"Co-Trainer",helper:"Helfer"};
const TCOLORS = ["#ef4444","#3b82f6","#22c55e","#f59e0b","#8b5cf6","#ec4899","#06b6d4","#f97316"];
// ── ERROR DISPLAY ─────────────────────────────────────────────────
if(typeof window!=="undefined"){
  window.onerror=(msg,src,line,col,err)=>{
    document.body.innerHTML=`<div style="padding:24px;font-family:monospace;background:#fee2e2;min-height:100vh">
      <div style="font-weight:900;font-size:18px;color:#dc2626;margin-bottom:12px">⚠️ App-Fehler</div>
      <div style="font-size:14px;color:#7f1d1d;margin-bottom:8px">${msg}</div>
      <div style="font-size:12px;color:#991b1b">${src} Zeile ${line}:${col}</div>
      <div style="font-size:11px;color:#7f1d1d;margin-top:8px;white-space:pre-wrap">${err?.stack||""}</div>
      <button onclick="location.reload()" style="margin-top:16px;padding:8px 16px;background:#dc2626;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:700">Neu laden</button>
    </div>`;
    return true;
  };
}

// ── THEME ─────────────────────────────────────────────────────────
const THEMES = {
  light: {nav:"#0f2419",primary:"#166534",accent:"#22c55e",accentL:"#dcfce7",bg:"#f0f4f0",card:"#fff",border:"#e2e8f0",text:"#1e293b",muted:"#64748b"},
  dark:  {nav:"#0a1a10",primary:"#22c55e",accent:"#4ade80",accentL:"#14532d",bg:"#0f172a",card:"#1e293b",border:"#334155",text:"#f1f5f9",muted:"#94a3b8"},
};
// C is set dynamically - default light until theme loads
let C = {...THEMES.light};
function applyTheme(dark) {
  Object.assign(C, dark ? THEMES.dark : THEMES.light);
  document.body.style.background = C.bg;
  document.body.style.colorScheme = dark ? "dark" : "light";
}

// ── UTILITIES ─────────────────────────────────────────────────────
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2);
const now = () => new Date().toISOString();
const fmtDate = s => s?new Date(s).toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"2-digit",year:"numeric"}):"";
const todayISO = () => new Date().toISOString().split("T")[0];
const addDaysISO = (dateStr,n) => { const d=new Date(dateStr+"T12:00:00"); d.setDate(d.getDate()+n); return d.toISOString().split("T")[0]; };
const isoWeekday = dateStr => { const day=new Date(dateStr+"T12:00:00").getDay(); return day===0?7:day; }; // Montag=1 ... Sonntag=7
const diffDaysISO = (a,b) => Math.round((new Date(b+"T12:00:00")-new Date(a+"T12:00:00"))/86400000);
const WEEKDAYS = [{v:1,l:"Montag"},{v:2,l:"Dienstag"},{v:3,l:"Mittwoch"},{v:4,l:"Donnerstag"},{v:5,l:"Freitag"},{v:6,l:"Samstag"},{v:7,l:"Sonntag"}];
const weekdayLabel = v => WEEKDAYS.find(w=>w.v===v)?.l || "";
// Ein Training gilt als "geplant", sobald Spieler oder Übungen zugewiesen sind
const isSessionPlanned = s => !!((s.playerIds&&s.playerIds.length>0)||(s.exerciseIds&&s.exerciseIds.length>0));
// Erzeugt Trainings-Session-Objekte aus wiederkehrenden Wochenslots für einen Zeitraum.
// Vermeidet Duplikate anhand (Datum + Slot-ID), erlaubt aber mehrere Slots am selben Wochentag.
function buildSessionsFromSlots(slots, startDate, endDate, existingSessions) {
  const existingKeys = new Set((existingSessions||[]).map(s=>`${s.date}|${s.seriesId||""}`));
  const created = [];
  let d = startDate, guard = 0;
  while (d <= endDate && guard < 400) {
    const wd = isoWeekday(d);
    (slots||[]).forEach(slot=>{
      if (slot.weekday !== wd) return;
      const key = `${d}|${slot.id}`;
      if (existingKeys.has(key)) return;
      created.push({
        id: uid(), date: d, time: slot.time||"", duration: slot.duration||60, location: slot.location||"",
        weather:"", participantCount:"", coachIds:[], playerIds:[], exerciseIds:[], teams:[], notes:"",
        seriesId: slot.id, createdAt: now(),
      });
      existingKeys.add(key);
    });
    d = addDaysISO(d,1); guard++;
  }
  return created;
}
// ── SAVE FILE mit Dialog (Android/Desktop: zeigt "Speichern unter") ──
// ── DEBUG EXPORT LOG ──────────────────────────────────────────────
const _dbg = [];
const dbgLog = (msg) => { _dbg.push(`${new Date().toISOString().slice(11,23)} ${msg}`); console.log('[EXPORT]', msg); };
window._getExportLog = () => _dbg.join('\n');

// Synchroner Download-Kern – muss direkt im Click-Handler aufgerufen werden
// bevor irgendein await den User-Gesture-Context zerstört
function saveFileSync(content, filename, mimeType) {
  const mime = mimeType || 'application/json;charset=utf-8';
  dbgLog(`saveFileSync called: ${filename} (${content.length} chars, mime=${mime})`);
  dbgLog(`showSaveFilePicker=${!!window.showSaveFilePicker} userAgent=${navigator.userAgent.slice(0,80)}`);
  // Versuch 1: Blob URL
  try {
    const blob = new Blob([content], {type: mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    dbgLog('Blob URL created, calling a.click()...');
    a.click();
    dbgLog('a.click() returned (blob)');
    setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
    return 'blob';
  } catch(e) { dbgLog(`Blob method failed: ${e.name}: ${e.message}`); }
  // Versuch 2: data: URI
  try {
    const dataUri = 'data:' + mime + ',' + encodeURIComponent(content);
    dbgLog(`data: URI length=${dataUri.length}`);
    const a = document.createElement('a');
    a.href = dataUri; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    dbgLog('Calling a.click() (data: URI)...');
    a.click();
    dbgLog('a.click() returned (datauri)');
    setTimeout(() => document.body.removeChild(a), 500);
    return 'datauri';
  } catch(e) { dbgLog(`data: URI method failed: ${e.name}: ${e.message}`); }
  dbgLog('All sync methods failed');
  return null;
}

const saveFile = async (content, filename, mimeType) => {
  dbgLog(`saveFile async called: ${filename}`);
  // Desktop Chrome/Edge: zeige echten Speichern-Dialog
  if (window.showSaveFilePicker) {
    try {
      const ext = filename.split('.').pop();
      const types = {
        json: [{description:'JSON Datei', accept:{'application/json':['.json']}}],
        csv:  [{description:'CSV Datei',  accept:{'text/csv':['.csv']}}],
      };
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: types[ext] || [{description:'Datei', accept:{'*/*':['.' + ext]}}],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      dbgLog(`picker success: ${handle.name}`);
      return {ok:true, method:'picker', filename: handle.name};
    } catch(e) {
      dbgLog(`picker failed: ${e.name}: ${e.message}`);
      if (e.name === 'AbortError') return {ok:false, method:'cancelled'};
    }
  }
  return {ok:true, method:'sync', filename};
};
// Helper: führt Export durch und zeigt passenden Toast
const doExport = async (content, filename, mimeType, toast) => {
  const syncResult = saveFileSync(content, filename, mimeType);
  if (syncResult) { if(toast) toast(`📥 ${filename} → Downloads`); return; }
  const r = await saveFile(content, filename, mimeType);
  if (!r.ok && r.method === 'cancelled') return;
  if (!r.ok) { toast?.('Export fehlgeschlagen', 'err'); return; }
  if (r.method === 'picker') toast?.(`✅ Gespeichert: ${r.filename}`);
  else toast?.(`📥 ${r.filename} → Downloads`);
};

const dlJson = async (o, n, toast) => {
  const content = JSON.stringify(o, null, 2);
  const mime = 'application/json;charset=utf-8';
  dbgLog(`dlJson called: ${n} (${content.length} chars)`);
  // Sofort synchron auslösen (User-Gesture-Context noch aktiv)
  const syncResult = saveFileSync(content, n, mime); // immer sync zuerst, picker nur als Desktop-Upgrade
  dbgLog(`dlJson syncResult: ${syncResult}`);
  if (syncResult) { if(toast) toast(`📥 ${n} → Downloads`); return {ok:true,method:syncResult,filename:n}; }
  // Desktop: async Picker
  const r = await saveFile(content, n, mime);
  if (!toast || !r) return r;
  if (!r.ok && r.method === 'cancelled') return r;
  if (!r.ok) toast('Export fehlgeschlagen', 'err');
  else if (r.method === 'picker') toast(`✅ Gespeichert: ${r.filename}`);
  else toast(`📥 ${r.filename} → Downloads`);
  return r;
};
const dlCsv = async (rows, cols, n, toast) => {
  const csv = [cols.join(','), ...rows.map(x => cols.map(k => `"${String(x[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const content = '\uFEFF' + csv;
  const mime = 'text/csv;charset=utf-8';
  const syncResult = saveFileSync(content, n, mime);
  if (syncResult) { if(toast) toast(`📥 ${n} → Downloads`); return {ok:true,method:syncResult,filename:n}; }
  const r = await saveFile(content, n, mime);
  if (!toast || !r) return r;
  if (!r.ok && r.method === 'cancelled') return r;
  if (!r.ok) toast('Export fehlgeschlagen', 'err');
  else if (r.method === 'picker') toast(`✅ Gespeichert: ${r.filename}`);
  else toast(`📥 ${r.filename} → Downloads`);
  return r;
};
const exportExJson = (ex) => dlJson(
  {version:APP_VERSION, exportDate:now(), type:'exercises', exercises:[ex]},
  `GJugend_Uebung_${ex.title.replace(/[^a-z0-9äöüÄÖÜ]/gi,'_').slice(0,30)}_${todayISO()}.json`
);

const buildExHtml = (ex) => {
  const cat=CATS[normCat(ex.category)]||{label:ex.category,emoji:'❓',color:'#64748b',bg:'#f1f5f9'};
  const stars='★'.repeat(ex.rating||0)+'☆'.repeat(5-(ex.rating||0));
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>${ex.title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:780px;margin:40px auto;padding:20px 28px;color:#1e293b}h1{font-size:26px;margin:0 0 8px}
.badge{display:inline-block;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700;background:${cat.bg||'#f1f5f9'};color:${cat.color||'#64748b'}}
.meta{color:#64748b;font-size:14px;margin:10px 0 20px}.stars{color:#f59e0b;font-size:16px;letter-spacing:2px}
.sec{margin:18px 0}.sec h2{font-size:13px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin:0 0 8px}
.box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;font-size:15px;line-height:1.7;white-space:pre-wrap}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600}
.mat{background:#dcfce7;color:#166534}.tag{background:#f1f5f9;color:#64748b}
img{width:100%;max-height:280px;object-fit:cover;border-radius:8px;margin-bottom:18px}
.footer{margin-top:40px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8}
.btns{display:flex;gap:10px;justify-content:flex-end;margin-bottom:20px}
.btn{padding:8px 18px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700}
@media print{body{margin:0;padding:16px}.btns{display:none}}</style></head>
<body>
<div class="btns">
  <button class="btn" style="background:#e2e8f0;color:#1e293b" onclick="window.close()">✕ Schließen</button>
  <button class="btn" style="background:#166534;color:white" onclick="window.print()">🖨 Drucken / PDF speichern</button>
</div>
<h1>${ex.title}</h1>
<span class="badge">${cat.emoji||''} ${cat.label||ex.category}</span>
<div class="meta"><span class="stars">${stars}</span> &nbsp;·&nbsp; ⏱ ${ex.duration} Min &nbsp;·&nbsp; 👥 ${ex.minPlayers}–${ex.maxPlayers} Kinder${ex.source?' &nbsp;·&nbsp; Quelle: '+ex.source:''}</div>
${ex.imageUrl?`<img src="${ex.imageUrl}" alt=""/>`:''} 
${ex.setup?`<div class="sec"><h2>📐 Aufbau</h2><div class="box">${ex.setup}</div></div>`:''}
${ex.description?`<div class="sec"><h2>🎯 Ablauf</h2><div class="box">${ex.description}</div></div>`:''}
${ex.material?.length?`<div class="sec"><h2>📦 Material</h2><div class="chips">${ex.material.map(m=>`<span class="chip mat">📦 ${m}</span>`).join('')}</div></div>`:''}
${ex.tags?.length?`<div class="sec"><h2>🏷️ Tags</h2><div class="chips">${ex.tags.map(t=>`<span class="chip tag">${t}</span>`).join('')}</div></div>`:''}
${ex.notes?`<div class="sec"><h2>💬 Notizen & Varianten</h2><div class="box" style="font-style:italic">${ex.notes}</div></div>`:''}
<div class="footer">G-Jugend Coach v${APP_VERSION} · Erstellt: ${new Date().toLocaleDateString('de-DE')}</div>
${PDF_SCRIPT}</body></html>`;
};

// HTML: In neuem Tab öffnen + als Datei speichern
const exportExHtml = async (ex) => {
  const html = buildExHtml(ex);
  const filename = `uebung_${ex.title.replace(/[^a-z0-9]/gi,'_')}_${todayISO()}.html`;
  // Versuche zuerst Speicherdialog
  const saved = await saveFile(html, filename, 'text/html');
  // Öffne zusätzlich im Browser zum direkten Drucken
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
};

const readText    = f=>new Promise((r,j)=>{const x=new FileReader();x.onload=e=>r(e.target.result);x.onerror=j;x.readAsText(f);});
const readDataURL = f=>new Promise((r,j)=>{const x=new FileReader();x.onload=e=>r(e.target.result);x.onerror=j;x.readAsDataURL(f);});
const parseJsonSafe = t=>{ try{return JSON.parse(t.replace(/```json\n?/g,"").replace(/```\n?/g,"").trim());}catch{return null;} };

// ── PDF Helpers ──
const PDF_CSS=`*{box-sizing:border-box}body{font-family:-apple-system,system-ui,sans-serif;padding:24px;max-width:820px;margin:0 auto;color:#111;font-size:14px}h1{font-size:22px;margin:0 0 4px}.meta{font-size:13px;color:#6b7280;margin-bottom:14px;padding-bottom:12px;border-bottom:2px solid #e5e7eb}.footer{margin-top:20px;font-size:11px;color:#9ca3af;text-align:center;padding-top:12px;border-top:1px solid #e5e7eb}img{max-height:none!important;height:auto!important;width:100%!important;display:block!important}@media print{body{padding:12px}@page{margin:1.5cm}img{max-height:500px!important;width:auto!important;max-width:100%!important;object-fit:contain!important;display:block!important;margin:0 auto!important;page-break-inside:avoid;break-inside:avoid}}`;
const PDF_SCRIPT=`<scr`+`ipt>(function(){var MAX_H=500;function fx(img){if(!img.naturalWidth)return;var r=img.naturalHeight/img.naturalWidth,mW=img.parentElement?img.parentElement.offsetWidth:img.offsetWidth,h=mW*r,w=mW;if(h>MAX_H){h=MAX_H;w=h/r;}img.style.cssText="width:"+w+"px;height:"+h+"px;display:block;object-fit:contain;background:#f8fafc;margin:0 auto 8px;border-radius:6px";}function run(){document.querySelectorAll("img").forEach(function(i){if(i.complete&&i.naturalWidth)fx(i);else i.addEventListener("load",function(){fx(i);});});}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run();window.addEventListener("load",run);})();<`+`/script>`;
function openPdf(html,filename,toast){const w=window.open("","_blank");if(w){w.document.write(html);w.document.close();w.onload=()=>setTimeout(()=>w.print(),300);setTimeout(()=>w.print(),800);}else{saveFileSync(html,filename,"text/html");toast?.("Als HTML gespeichert");}}
const parseCsvPlayers = text=>{ const ls=text.trim().split("\n");if(ls.length<2)return[];const hs=ls[0].split(",").map(h=>h.replace(/"/g,"").trim().toLowerCase());return ls.slice(1).map(l=>{const vs=l.split(",").map(v=>v.replace(/"/g,"").trim()),o={};hs.forEach((h,i)=>o[h]=vs[i]??"");return{id:uid(),createdAt:now(),name:o.name||"?",birthYear:Number(o.birthyear||o.jahrgang||2019),strength:Math.min(4,Math.max(1,Number(o.strength||o.staerke||1))),active:o.active!=="false",jersey:o.jersey||o.trikot||"",notes:o.notes||o.notizen||""};}).filter(p=>p.name&&p.name!=="?"); };

// ── SHUFFLE FIX ───────────────────────────────────────────────────
// Bug vorher: Spieler gleicher Stärke kamen immer in derselben Reihenfolge
// → Fisher-Yates Shuffle löst das
const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };

function buildTeams(players,numTeams,mode,skillDist) {
  if(!players.length||!numTeams) return [];
  const n=Math.max(1,numTeams);
  const teams=Array.from({length:n},(_,i)=>({id:uid(),name:`Team ${i+1}`,players:[]}));

  // Snake-Draft: verteilt Spieler serpentinenartig → maximale Fairness
  // Innerhalb gleicher Stärke: zufällig gemischt
  // Garantiert: Teamgrößen unterscheiden sich um max. 1 Spieler
  const snakeDraft=(pool,targetTeams)=>{
    if(!pool.length||!targetTeams.length) return;
    const tn=targetTeams.length;
    // Innerhalb gleicher Stärke shufflen, dann nach Stärke absteigend sortieren
    const byStr={};
    pool.forEach(p=>{ (byStr[p.strength]=byStr[p.strength]||[]).push(p); });
    const ordered=Object.keys(byStr).sort((a,b)=>b-a).flatMap(k=>shuffle(byStr[k]));
    ordered.forEach((p,i)=>{
      const round=Math.floor(i/tn), pos=i%tn;
      const ti=round%2===0 ? pos : tn-1-pos; // links→rechts, rechts→links, ...
      targetTeams[ti].players.push(p);
    });
  };

  if(mode==="random") {
    shuffle(players).forEach((p,i)=>teams[i%n].players.push(p));
  } else if(mode==="balanced") {
    snakeDraft(players,teams);
  } else if(mode==="mixed") {
    // Jedes Stärke-Level gleichmäßig über alle Teams verteilen
    [4,3,2,1].forEach(s=>shuffle(players.filter(p=>p.strength===s)).forEach((p,i)=>teams[i%n].players.push(p)));
  } else if(mode==="profile"&&skillDist?.profiles) {
    // Profile-Modus: Profil bestimmt Mischverhältnis aus oberer/unterer Spielerhälfte.
    // 4=Sehr stark: 80% aus stärkerer Hälfte, 20% aus schwächerer
    // 3=Stark:      60% / 40%
    // 2=Mittel:     40% / 60%
    // 1=Schwach:    20% / 80%
    const profiles=skillDist.profiles.slice(0,n);
    const sorted=shuffle([...players]).sort((a,b)=>b.strength-a.strength);
    const total=sorted.length;
    const perTeam=Math.floor(total/n);
    const half=Math.floor(total/2);
    const upperRatio={4:0.8,3:0.6,2:0.4,1:0.2};
    let remUpper=[...sorted.slice(0,half)];
    let remLower=[...sorted.slice(half)];
    // Stärkste Teams zuerst bedienen
    const teamOrder=[...teams.keys()].sort((a,b)=>(profiles[b]||2)-(profiles[a]||2));
    teamOrder.forEach(ti=>{
      const prof=profiles[ti]||2;
      const nUp=Math.round(perTeam*(upperRatio[prof]||0.5));
      const nLow=perTeam-nUp;
      const takenUp=remUpper.splice(0,nUp);
      const takenLow=remLower.splice(0,nLow);
      [...takenUp,...takenLow].forEach(p=>teams[ti].players.push(p));
    });
    // Restliche Spieler verteilen
    const rest=[...remUpper,...remLower];
    rest.forEach((p,i)=>teams[i%n].players.push(p));
  } else if(mode==="skill"&&skillDist) {
    const {strong:nS=0,weak:nW=0}=skillDist;
    const nM=n-nS-nW;
    // Trenne Spieler in Gruppen
    const strongP=players.filter(p=>p.strength>=3);
    const weakP=players.filter(p=>p.strength<=2);
    // Snake-Draft innerhalb jeder Gruppe
    if(nS>0) snakeDraft(strongP, teams.slice(0,nS));
    if(nW>0) snakeDraft(weakP,   teams.slice(nS,nS+nW));
    if(nM>0) {
      const usedIds=new Set([...teams.slice(0,nS),...teams.slice(nS,nS+nW)].flatMap(t=>t.players.map(p=>p.id)));
      const rest=players.filter(p=>!usedIds.has(p.id));
      snakeDraft(rest, teams.slice(nS+nW));
    }
  } else {
    snakeDraft(players,teams);
  }
  return teams;
}

// ── TOURNAMENT HELPERS ────────────────────────────────────────────
// excludePairs: array of [idA, idB] that should NOT play each other
// teams: array of {id, name, club?, ...}
const generateRR = (teams, excludePairs=[], clubOverrides=[]) => {
  // Build set of excluded pair keys for fast lookup
  const excluded=new Set(excludePairs.map(([a,b])=>[a,b].sort().join("|")));
  // Also auto-exclude same-club pairs (unless overridden)
  teams.forEach((t1,i)=>teams.forEach((t2,j)=>{
    if(i>=j)return;
    if(t1.club&&t2.club&&t1.club.trim()&&t1.club.trim()===t2.club.trim()){
      const key=[t1.id,t2.id].sort().join("|");
      if(!clubOverrides.includes(key)) excluded.add(key);
    }
  }));
  const isExcluded=(a,b)=>excluded.has([a,b].sort().join("|"));

  const n=teams.length, list=teams.map(t=>t.id);
  if(n%2===1) list.push(null);
  const rounds=[];
  for(let r=0;r<list.length-1;r++){
    const round=[];
    for(let i=0;i<list.length/2;i++){
      const h=list[i],a=list[list.length-1-i];
      if(h&&a&&!isExcluded(h,a))
        round.push({id:uid(),homeId:h,awayId:a,homeScore:null,awayScore:null,played:false});
    }
    rounds.push(round);
    list.splice(1,0,list.pop());
  }
  return shuffle(rounds).flat();
};
const calcStandings = (teams,matches) => {
  const t=teams.map(x=>({...x,pl:0,w:0,d:0,l:0,gf:0,ga:0,pts:0}));
  matches.filter(m=>m.played).forEach(m=>{ const h=t.find(x=>x.id===m.homeId),a=t.find(x=>x.id===m.awayId);if(!h||!a)return;h.pl++;a.pl++;h.gf+=m.homeScore;h.ga+=m.awayScore;a.gf+=m.awayScore;a.ga+=m.homeScore;if(m.homeScore>m.awayScore){h.w++;h.pts+=3;a.l++;}else if(m.homeScore<m.awayScore){a.w++;a.pts+=3;h.l++;}else{h.d++;h.pts++;a.d++;a.pts++;} });
  return t.sort((a,b)=>b.pts-a.pts||(b.gf-b.ga)-(a.gf-a.ga)||b.gf-a.gf);
};

// ── TOURNAMENT SCHEDULING (pure, no React state — reads config directly from tournament object) ──
const fmtTimeHM=m=>{const hh=Math.floor(m/60),mm=m%60;return`${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;};
const computeTournamentSchedule=(t)=>{
  const fields=t.fields||1;
  const startTime=t.startTime||"10:00";
  const pauseMin=t.pauseMin??t.defaultPause??2;
  const slotPauses=t.slotPauses||{};
  const [h,m]=startTime.split(":").map(Number);
  const startMin=(h||0)*60+(m||0);
  const matches=[...t.matches];
  const n=matches.length;
  if(n===0) return [];
  const teamDeg={};
  matches.forEach(mt=>{teamDeg[mt.homeId]=(teamDeg[mt.homeId]||0)+1;teamDeg[mt.awayId]=(teamDeg[mt.awayId]||0)+1;});
  const sorted=[...matches].sort((a,b)=>((teamDeg[b.homeId]+teamDeg[b.awayId])-(teamDeg[a.homeId]+teamDeg[a.awayId])));
  const minRounds=Math.ceil(n/fields);
  let assignment=null;
  for(let maxR=minRounds;maxR<=n&&!assignment;maxR++){
    const asgn=new Array(n).fill(-1);
    const roundTeams={};
    const roundCnt={};
    const bt=(idx)=>{
      if(idx===n) return true;
      const {homeId,awayId}=sorted[idx];
      for(let r=0;r<maxR;r++){
        const busy=roundTeams[r]||(roundTeams[r]=new Set());
        const cnt=roundCnt[r]||0;
        if(!busy.has(homeId)&&!busy.has(awayId)&&cnt<fields){
          busy.add(homeId);busy.add(awayId);
          roundCnt[r]=cnt+1;
          asgn[idx]=r;
          if(bt(idx+1)) return true;
          busy.delete(homeId);busy.delete(awayId);
          roundCnt[r]=cnt;
          asgn[idx]=-1;
        }
      }
      return false;
    };
    if(bt(0)) assignment={asgn,sorted};
  }
  if(!assignment) return [];
  const slots=[];
  const fieldUsed={};
  assignment.asgn.forEach((r,i)=>{
    fieldUsed[r]=(fieldUsed[r]||0)+1;
    slots.push({match:assignment.sorted[i],field:fieldUsed[r],round:r});
  });
  const maxRound=slots.reduce((mx,s)=>Math.max(mx,s.round),-1);
  let cumMin=startMin;
  const roundStart={};
  for(let r=0;r<=maxRound;r++){
    roundStart[r]=cumMin;
    const pause=slotPauses[r]??pauseMin;
    cumMin+=t.matchDuration+pause;
  }
  return slots.map(s=>({...s,startMin:roundStart[s.round]})).sort((a,b)=>a.startMin-b.startMin||a.field-b.field);
};

// ── TOURNAMENT PDF SECTIONS (pure — builds Teams/Zeitplan/Übersicht HTML for one tournament) ──
const escHtml=s=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const legLabel=leg=>leg===2?`<span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:10px;background:#f3e8ff;color:#7c3aed;margin-left:4px">RÜCK</span>`:``;
function buildTournamentPdfSections(t,coaches=[]){
  const fields=t.fields||1;
  const gt=id=>t.teams.find(x=>x.id===id);
  const schedule=computeTournamentSchedule(t);
  const coachAssign=t.coachAssign||{};
  const hasRueckrunde=t.matches.some(m=>m.leg===2);
  const meta=`📅 ${escHtml(fmtDate(t.date))} · 👥 ${t.teams.length} Teams · ⏱ ${t.matchDuration} Min/Spiel · ⚽ ${fields} Feld${fields>1?"er":""} · 🏟 ${t.matches.length} Spiele${hasRueckrunde?" · 🔁 Hin- &amp; Rückrunde":""}`;

  // Teams
  const teamsHtml=t.teams.map(team=>{
    const tm=t.matches.filter(m=>m.homeId===team.id||m.awayId===team.id)
      .map(m=>({m,slot:schedule.find(s=>s.match.id===m.id)}))
      .sort((a,b)=>(a.slot?.startMin??9999)-(b.slot?.startMin??9999));
    const rows=tm.map(({m,slot})=>{
      const isHome=m.homeId===team.id;
      const opp=gt(isHome?m.awayId:m.homeId);
      const res=m.played?`<span style="font-weight:800;color:#166534">${m.homeScore}:${m.awayScore}</span>`:`<span style="color:#9ca3af">offen</span>`;
      return`<tr><td style="padding:5px 8px;font-weight:700;white-space:nowrap">${slot?fmtTimeHM(slot.startMin):"–"}${legLabel(m.leg)}</td><td style="padding:5px 8px;white-space:nowrap">${fields>1&&slot?`Feld ${slot.field}`:""}</td><td style="padding:5px 8px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${opp?.color||"#ccc"};margin-right:5px"></span>vs. ${escHtml(opp?.name)}</td><td style="padding:5px 8px;text-align:right">${res}</td></tr>`;
    }).join("");
    return`<div style="border:1.5px solid #e2e8f0;border-radius:10px;margin-bottom:12px;overflow:hidden;page-break-inside:avoid">
      <div style="padding:9px 14px;background:${team.color}18;border-bottom:1px solid ${team.color}44;display:flex;align-items:center;gap:8px">
        <span style="width:13px;height:13px;border-radius:50%;background:${team.color};display:inline-block;flex-shrink:0"></span>
        <span style="font-weight:800;font-size:14px">${escHtml(team.name)}</span>
        ${team.club?`<span style="font-size:11px;color:#6b7280">· 🏛 ${escHtml(team.club)}</span>`:""}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">${rows}</table>
    </div>`;
  }).join("");

  // Zeitplan
  const sortedSlots=[...schedule].sort((a,b)=>a.startMin-b.startMin||a.field-b.field);
  const zpRows=sortedSlots.map(sl=>{
    const h=gt(sl.match.homeId),a=gt(sl.match.awayId);
    const res=sl.match.played?`<span style="font-weight:800;color:#166534">${sl.match.homeScore}:${sl.match.awayScore}</span>`:`<span style="color:#9ca3af">–</span>`;
    return`<tr><td style="padding:6px 8px;font-weight:800;white-space:nowrap">${fmtTimeHM(sl.startMin)}${legLabel(sl.match.leg)}</td><td style="padding:6px 8px;white-space:nowrap">${fields>1?`⚽ Feld ${sl.field}`:""}</td><td style="padding:6px 8px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${h?.color||"#ccc"};margin-right:5px"></span><strong>${escHtml(h?.name)}</strong></td><td style="padding:6px 8px;text-align:center;color:#94a3b8">vs.</td><td style="padding:6px 8px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${a?.color||"#ccc"};margin-right:5px"></span><strong>${escHtml(a?.name)}</strong></td><td style="padding:6px 8px;text-align:right">${res}</td></tr>`;
  }).join("");
  const zpHtml=`<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>${["Zeit","Feld","Heim","","Gast","Ergebnis"].map(h=>`<th style="padding:6px 8px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;border-bottom:2px solid #e2e8f0">${h}</th>`).join("")}</tr></thead><tbody>${zpRows}</tbody></table>`;

  // Übersicht
  const rows3=schedule.reduce((rs,sl)=>{
    const last=rs[rs.length-1];
    if(!last||last.startMin!==sl.startMin) rs.push({startMin:sl.startMin,slots:[]});
    rs[rs.length-1].slots.push(sl);
    return rs;
  },[]);
  const ueHtml=rows3.map(row=>{
    const allTeamIds=[...new Set(row.slots.flatMap(sl=>[sl.match.homeId,sl.match.awayId]))];
    const allTeams=allTeamIds.map(gt).filter(Boolean);
    const kidCount=allTeams.reduce((s,tm)=>s+(t.teamSizes?.[tm.id]||tm.players?.length||t.defaultTeamSize||4),0);
    const cells=row.slots.map(sl=>{
      const h=gt(sl.match.homeId),a=gt(sl.match.awayId);
      const coach=coachAssign[sl.field-1]?coaches.find(c=>c.id===coachAssign[sl.field-1]):null;
      return`<div style="flex:1;min-width:140px;padding:8px 10px;border-left:1px solid #e2e8f0">
        <div style="font-size:10px;font-weight:800;color:#64748b;margin-bottom:4px">⚽ Feld ${sl.field}${coach?` · 🧑‍🏫 ${escHtml(coach.name)}`:""}${legLabel(sl.match.leg)}</div>
        <div style="font-size:12px;font-weight:700"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${h?.color||"#ccc"};margin-right:4px"></span>${escHtml(h?.name)}</div>
        <div style="font-size:9px;color:#94a3b8;padding-left:12px">vs.</div>
        <div style="font-size:12px;font-weight:700"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${a?.color||"#ccc"};margin-right:4px"></span>${escHtml(a?.name)}</div>
      </div>`;
    }).join("");
    return`<div style="border:1.5px solid #e2e8f0;border-radius:10px;margin-bottom:10px;overflow:hidden;page-break-inside:avoid">
      <div style="padding:8px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:800;font-size:14px">${fmtTimeHM(row.startMin)}</span>
        <span style="font-size:11px;color:#64748b">⏱ ${t.matchDuration} Min</span>
        <span style="margin-left:auto;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;background:#dbeafe;color:#1d4ed8">👥 ${kidCount} Kinder aktiv</span>
      </div>
      <div style="display:flex;flex-wrap:wrap">${cells}</div>
    </div>`;
  }).join("");

  return {meta,teamsHtml,zpHtml,ueHtml};
}

// ── CLAUDE API ────────────────────────────────────────────────────
async function callClaude(messages,apiKey,system) {
  const headers={"Content-Type":"application/json","anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"};
  if(apiKey) headers["x-api-key"]=apiKey;
  const body={model:"claude-sonnet-4-20250514",max_tokens:messages[0]?.content?.length>500?4000:2000,messages};
  if(system) body.system=system;
  const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers,body:JSON.stringify(body)});
  if(!res.ok){const e=await res.json();throw new Error(e.error?.message||`Fehler ${res.status}`);}
  return (await res.json()).content[0].text;
}

// ── HOOKS ─────────────────────────────────────────────────────────
function useStorage(key,def) {
  const [data,setData]=useState(def);
  const [ready,setReady]=useState(false);
  useEffect(()=>{
    db.kv.get(key)
      .then(row=>{ if(row?.value) setData(JSON.parse(row.value)); setReady(true); })
      .catch(()=>setReady(true));
  },[key]);
  // Supports both direct values AND functional updates (prev=>next)
  // This prevents stale closure bugs when saving rapidly
  const save = (nextOrFn) => {
    setData(prev=>{
      const next = typeof nextOrFn==='function' ? nextOrFn(prev) : nextOrFn;
      db.kv.put({key, value:JSON.stringify(next)}).catch(e=>console.error('DB write error:',e));
      return next;
    });
  };
  return [data,save,ready];
}
function useToast() {
  const [list,setList]=useState([]);
  const toast=(msg,type="ok")=>{const id=uid();setList(p=>[...p,{id,msg,type}]);setTimeout(()=>setList(p=>p.filter(t=>t.id!==id)),3500);};
  const Toasts=()=><div style={{position:"fixed",top:16,right:16,zIndex:9999,display:"flex",flexDirection:"column",gap:8,pointerEvents:"none"}}>{list.map(t=><div key={t.id} style={{padding:"10px 18px",borderRadius:10,fontSize:14,fontWeight:700,color:"white",background:t.type==="err"?"#ef4444":t.type==="warn"?"#f59e0b":"#16a34a",boxShadow:"0 4px 16px rgba(0,0,0,.2)"}}>{t.msg}</div>)}</div>;
  return {toast,Toasts};
}

// ── UI PRIMITIVES ─────────────────────────────────────────────────
const Modal=({title,onClose,children,wide})=>(
  <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
    <div style={{background:C.card,borderRadius:18,width:"100%",maxWidth:wide?760:540,maxHeight:"92vh",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 28px 80px rgba(0,0,0,.35)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"20px 24px",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
        <h2 style={{margin:0,fontSize:18,fontWeight:800,color:C.text}}>{title}</h2>
        <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,fontSize:20,lineHeight:1}}>✕</button>
      </div>
      <div style={{overflowY:"auto",flex:1,padding:24}}>{children}</div>
    </div>
  </div>
);
const CatBadge=({cat,small})=>{
  const key=normCat(cat);
  const c=CATS[key]||{label:"Nicht zugeordnet",emoji:"❓",color:"#64748b",bg:"#f1f5f9"};
  return<span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:small?11:12,fontWeight:700,padding:small?"2px 8px":"3px 10px",borderRadius:20,background:c.bg,color:c.color,whiteSpace:"nowrap"}}>{c.emoji} {c.label}</span>;
};
const Stars=({value,onChange,readonly})=>{
  const v=value||0;
  return<div style={{display:"flex",gap:2,alignItems:"center"}}>
    {[1,2,3,4,5].map(n=><span key={n} onClick={()=>{if(readonly)return;onChange?.(n===v?0:n);}} style={{cursor:readonly?"default":"pointer",fontSize:readonly?14:18,color:n<=v?"#f59e0b":"#e2e8f0",lineHeight:1,userSelect:"none"}}>★</span>)}
    {!readonly&&v>0&&<button onClick={()=>onChange?.(0)} style={{fontSize:10,color:C.muted,background:"none",border:"none",cursor:"pointer",padding:"0 2px",marginLeft:2,fontFamily:"inherit"}}>✕</button>}
    {v===0&&<span style={{fontSize:11,color:C.muted,marginLeft:2,fontStyle:"italic"}}>unbewertet</span>}
  </div>;
};
const StrBadge=({level,small})=>{const s=STR[level];if(!s)return null;return<span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:small?11:12,fontWeight:700,padding:"2px 10px",borderRadius:20,background:s.light,color:s.color}}>{s.emoji} {s.label}</span>;};
const Inp=({label,style:st,...p})=><div style={{marginBottom:14}}>{label&&<label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>{label}</label>}<input {...p} style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,color:C.text,background:"white",outline:"none",boxSizing:"border-box",...st}}/></div>;
const Txta=({label,...p})=><div style={{marginBottom:14}}>{label&&<label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>{label}</label>}<textarea {...p} style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,color:C.text,background:"white",outline:"none",resize:"vertical",fontFamily:"inherit",boxSizing:"border-box"}}/></div>;
const Sel=({label,children,...p})=><div style={{marginBottom:14}}>{label&&<label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>{label}</label>}<select {...p} style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,color:C.text,background:"white",outline:"none",boxSizing:"border-box"}}>{children}</select></div>;
const Btn=({children,variant="primary",sm,...p})=><button {...p} style={{padding:sm?"6px 14px":"9px 18px",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,fontSize:sm?13:14,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:6,...(variant==="primary"?{background:C.primary,color:"white"}:variant==="danger"?{background:"#ef4444",color:"white"}:variant==="ai"?{background:"#6d28d9",color:"white"}:{background:"white",color:C.text,border:`1.5px solid ${C.border}`}),...p.style}}>{children}</button>;
const Divider=()=><div style={{borderTop:`1px solid ${C.border}`,margin:"20px 0"}}/>;
const Empty=({icon,title,sub,onAdd,addLabel})=><div style={{textAlign:"center",padding:"60px 24px",color:C.muted}}><div style={{fontSize:48,marginBottom:16}}>{icon}</div><div style={{fontSize:18,fontWeight:700,color:C.text,marginBottom:8}}>{title}</div>{sub&&<div style={{fontSize:14,marginBottom:24}}>{sub}</div>}{onAdd&&<Btn onClick={onAdd}><Plus size={16}/> {addLabel}</Btn>}</div>;
const Stepper=({value,onChange,min=1,max=99})=>(
  <div style={{display:"flex",alignItems:"center",border:`1.5px solid ${C.border}`,borderRadius:8,overflow:"hidden",background:"white",height:38}}>
    <button onClick={()=>onChange(Math.max(min,value-1))} style={{width:38,height:"100%",border:"none",borderRight:`1px solid ${C.border}`,cursor:"pointer",background:"transparent",fontSize:20,color:value<=min?"#cbd5e1":C.text,lineHeight:1,flexShrink:0}}>−</button>
    <div style={{flex:1,textAlign:"center",fontWeight:800,fontSize:16,color:C.text,minWidth:32}}>{value}</div>
    <button onClick={()=>onChange(Math.min(max,value+1))} style={{width:38,height:"100%",border:"none",borderLeft:`1px solid ${C.border}`,cursor:"pointer",background:"transparent",fontSize:20,color:value>=max?"#cbd5e1":C.text,lineHeight:1,flexShrink:0}}>+</button>
  </div>
);

// ── AI IMPORT ─────────────────────────────────────────────────────
function AIImportModal({onSave,onClose,apiKey}) {
  const [text,setText]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [preview,setPreview]=useState(null);
  const SYS=`Du bist Experte für G-Jugend (U7) Fußballtraining. Extrahiere eine Übung aus dem Text.
Antworte NUR mit JSON, keine Codeblöcke: {"title":"","category":"uebung","description":"","setup":"","material":[],"minPlayers":4,"maxPlayers":12,"duration":10,"tags":[],"source":"","notes":""}
category: aufwaermen|uebung|spielform`;
  const run=async()=>{ if(!text.trim())return;setLoading(true);setError("");try{const r=await callClaude([{role:"user",content:`Extrahiere diese Übung:\n\n${text}`}],apiKey,SYS);const d=parseJsonSafe(r);if(!d?.title)throw new Error("Keine Übung erkannt");setPreview({...d,id:uid(),createdAt:now(),updatedAt:now(),rating:3,imageUrl:""});}catch(e){setError(e.message);}setLoading(false); };
  if(preview) return(<div>
    <div style={{background:"#f0fdf4",borderRadius:10,padding:"10px 14px",marginBottom:14,border:`1px solid ${C.accent}`,fontSize:13,color:C.primary,fontWeight:600}}>✅ Übung erkannt – bitte prüfen:</div>
    <Inp label="Titel" value={preview.title} onChange={e=>setPreview(p=>({...p,title:e.target.value}))}/>
    <Sel label="Kategorie" value={normCat(preview.category)} onChange={e=>setPreview(p=>({...p,category:e.target.value}))}>{Object.entries(BUILTIN_CATS).map(([k,v])=><option key={k} value={k}>{v.emoji} {v.label}</option>)}</Sel>
    <Txta label="Ablauf" value={preview.description} onChange={e=>setPreview(p=>({...p,description:e.target.value}))} rows={3}/>
    <Txta label="Aufbau" value={preview.setup} onChange={e=>setPreview(p=>({...p,setup:e.target.value}))} rows={2}/>
    <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>{preview.material?.map(m=><span key={m} style={{padding:"3px 10px",borderRadius:20,background:C.accentL,color:C.primary,fontSize:12,fontWeight:700}}>📦 {m}</span>)}</div>
    <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>{preview.tags?.map(t=><span key={t} style={{padding:"3px 10px",borderRadius:20,background:"#f1f5f9",color:C.muted,fontSize:12,fontWeight:600}}>{t}</span>)}</div>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}><Btn onClick={()=>setPreview(null)} variant="secondary">Zurück</Btn><Btn onClick={()=>onSave(preview)}>Speichern</Btn></div>
  </div>);
  return(<div>
    <div style={{background:"#faf5ff",borderRadius:10,padding:"12px 14px",marginBottom:14,border:"1px solid #e9d5ff",fontSize:13,color:"#6d28d9"}}>🤖 Text aus Trainingsbuch, DFB-PDF, Website oder eigene Notizen einfügen – KI erkennt automatisch die Übung.</div>
    <Txta label="Text einfügen" value={text} onChange={e=>setText(e.target.value)} placeholder="z.B. 'Hütchendribbeln: Jeder Spieler dribbliert durch eine Gasse aus 6 Hütchen...'" rows={8}/>
    {error&&<div style={{color:"#ef4444",fontSize:13,marginBottom:12,fontWeight:600}}>❌ {error}</div>}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}><Btn onClick={onClose} variant="secondary">Abbrechen</Btn><Btn onClick={run} variant="ai" disabled={loading||!text.trim()}>{loading?<><RefreshCw size={14} style={{animation:"spin 1s linear infinite"}}/> Erkenne...</>:<><Bot size={14}/> Übung erkennen</>}</Btn></div>
  </div>);
}

// ── EXERCISE FORM ─────────────────────────────────────────────────
function ExerciseForm({exercise,onSave,onClose}) {
  const [form,setForm]=useState({title:"",category:"uebung",description:"",setup:"",material:[],minPlayers:4,maxPlayers:12,duration:10,rating:0,done:false,tags:[],imageUrl:"",source:"",notes:"",...exercise});
  const [mi,setMi]=useState("");const imgRef=useRef();
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const addMat=m=>{ if(!m.trim())return;if(!form.material.includes(m.trim()))set("material",[...form.material,m.trim()]);setMi(""); };
  const chip=a=>({padding:"4px 10px",borderRadius:20,border:`1.5px solid ${a?C.primary:C.border}`,background:a?C.accentL:"white",color:a?C.primary:C.muted,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"});
  return(<div>
    <Inp label="Titel *" value={form.title} onChange={e=>set("title",e.target.value)} placeholder="Name der Übung"/>
    <Sel label="Kategorie" value={normCat(form.category)} onChange={e=>set("category",e.target.value)}>{Object.entries(BUILTIN_CATS).map(([k,v])=><option key={k} value={k}>{v.emoji} {v.label}</option>)}</Sel>
    <div style={{display:"flex",gap:10,marginBottom:14,alignItems:"center"}}>
      <div style={{flex:1}}>
        <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Status</label>
        <div style={{display:"flex",gap:8}}>
          {[[false,"⏳ Noch nicht gemacht","#f1f5f9",C.muted],[true,"✅ Schon gemacht","#dcfce7","#16a34a"]].map(([v,l,bg,col])=>
            <button key={String(v)} onClick={()=>set("done",v)} style={{flex:1,padding:"7px 10px",borderRadius:8,border:`2px solid ${form.done===v?col:C.border}`,background:form.done===v?bg:"white",color:form.done===v?col:C.muted,cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit"}}>{l}</button>)}
        </div>
      </div>
    </div>
    <Txta label="Ablauf / Beschreibung" value={form.description} onChange={e=>set("description",e.target.value)} placeholder="Wie läuft die Übung ab?" rows={4}/>
    <Txta label="Aufbau" value={form.setup} onChange={e=>set("setup",e.target.value)} placeholder="Wie wird das Feld aufgebaut?" rows={3}/>
    <div style={{marginBottom:14}}>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Material</label>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>{PMAT.map(m=><button key={m} onClick={()=>addMat(m)} style={chip(form.material.includes(m))}>{m}</button>)}</div>
      <div style={{display:"flex",gap:8}}><input value={mi} onChange={e=>setMi(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addMat(mi)} placeholder="Eigenes Material..." style={{flex:1,padding:"8px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:13,outline:"none",fontFamily:"inherit"}}/><Btn sm onClick={()=>addMat(mi)}>+</Btn></div>
      {form.material.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>{form.material.map(m=><span key={m} style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 10px",borderRadius:20,background:C.accentL,color:C.primary,fontSize:12,fontWeight:700}}>📦 {m}<button onClick={()=>set("material",form.material.filter(x=>x!==m))} style={{background:"none",border:"none",cursor:"pointer",color:C.primary,padding:0,fontSize:13}}>✕</button></span>)}</div>}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
      <Inp label="Min. Kinder" type="number" value={form.minPlayers} onChange={e=>set("minPlayers",Number(e.target.value))} min={1} style={{marginBottom:0}}/>
      <Inp label="Max. Kinder" type="number" value={form.maxPlayers} onChange={e=>set("maxPlayers",Number(e.target.value))} min={1} style={{marginBottom:0}}/>
      <Inp label="Dauer (Min)" type="number" value={form.duration} onChange={e=>set("duration",Number(e.target.value))} min={1} style={{marginBottom:0}}/>
    </div>
    <div style={{marginBottom:14}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Bewertung</label><Stars value={form.rating} onChange={v=>set("rating",v)}/></div>
    <div style={{marginBottom:14}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Tags</label><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{PTAGS.map(t=><button key={t} onClick={()=>set("tags",form.tags.includes(t)?form.tags.filter(x=>x!==t):[...form.tags,t])} style={chip(form.tags.includes(t))}>{t}</button>)}</div></div>
    <div style={{marginBottom:14}}>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Skizze / Foto</label>
      {form.imageUrl?<div style={{position:"relative",display:"inline-block"}}><img src={form.imageUrl} alt="" style={{maxWidth:"100%",maxHeight:300,borderRadius:8,objectFit:"contain",border:`1px solid ${C.border}`,background:"#f8fafc"}}/><button onClick={()=>set("imageUrl","")} style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,.6)",color:"white",border:"none",borderRadius:6,cursor:"pointer",padding:"3px 8px",fontSize:12}}>✕</button></div>:<button onClick={()=>imgRef.current.click()} style={{padding:"10px 16px",border:`1.5px dashed ${C.border}`,borderRadius:8,cursor:"pointer",background:"white",color:C.muted,fontSize:13,fontFamily:"inherit"}}>📷 Bild hochladen</button>}
      <input ref={imgRef} type="file" accept="image/*" onChange={async e=>{const f=e.target.files?.[0];if(f)set("imageUrl",await readDataURL(f));}} style={{display:"none"}}/>
    </div>
    <Inp label="Quelle" value={form.source} onChange={e=>set("source",e.target.value)} placeholder="DFB Übungssammlung, eigene Idee..."/>
    <Txta label="Notizen & Varianten" value={form.notes} onChange={e=>set("notes",e.target.value)} rows={2}/>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`,flexWrap:"wrap"}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      {!exercise?.id&&<Btn variant="secondary" onClick={()=>{
        if(!form.title.trim())return;
        onSave({...form,id:uid(),createdAt:now(),updatedAt:now()},true);
        setForm({title:"",category:form.category,description:"",setup:"",material:[],minPlayers:4,maxPlayers:12,duration:10,rating:3,tags:[],imageUrl:"",source:"",notes:""});
      }}>+ Weiteren anlegen</Btn>}
      <Btn onClick={()=>{if(!form.title.trim())return;onSave({...form,id:form.id||uid(),createdAt:form.createdAt||now(),updatedAt:now()});}}>{exercise?.id?"Speichern":"Erstellen"}</Btn>
    </div>
  </div>);
}

// ── EXERCISE DETAIL ───────────────────────────────────────────────
function ExDetail({exercise:ex,onEdit,onSave,onDelete,onClose}) {
  return(<div>
    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
      <CatBadge cat={ex.category}/>
      <span style={{color:C.muted,fontSize:13,marginLeft:"auto"}}>⏱ {ex.duration} Min · 👥 {ex.minPlayers}–{ex.maxPlayers}</span>
    </div>
    <div style={{display:"flex",gap:8,marginBottom:16,alignItems:"center",background:"#f8fafc",borderRadius:10,padding:"10px 12px",border:`1px solid ${C.border}`,flexWrap:"wrap"}}>
      <button onClick={()=>(onSave||onEdit)({...ex,done:!ex.done})} style={{padding:"5px 12px",borderRadius:20,border:`1.5px solid ${ex.done?"#22c55e":C.border}`,background:ex.done?"#dcfce7":"white",color:ex.done?"#15803d":C.muted,cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit",flexShrink:0}}>{ex.done?"✅ Gemacht":"⏳ Noch nicht"}</button>
      <div style={{display:"flex",gap:3,alignItems:"center",marginLeft:4}}>
        {[1,2,3,4,5].map(n=><button key={n} onClick={()=>(onSave||onEdit)({...ex,rating:ex.rating===n?0:n})} style={{width:30,height:30,borderRadius:6,border:"none",background:"transparent",fontSize:20,cursor:"pointer",color:n<=(ex.rating||0)?"#f59e0b":"#d1d5db",padding:0,lineHeight:1}}>★</button>)}
        {!(ex.rating>0)&&<span style={{fontSize:11,color:C.muted,marginLeft:2,fontStyle:"italic"}}>Tippen zum Bewerten</span>}
      </div>
    </div>
    {ex.imageUrl&&<img src={ex.imageUrl} alt="" style={{width:"100%",maxHeight:400,objectFit:"contain",borderRadius:10,marginBottom:16,border:`1px solid ${C.border}`,background:"#f8fafc"}}/>}
    {ex.setup&&<div style={{marginBottom:14}}><div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>📐 Aufbau</div><div style={{fontSize:14,color:C.text,lineHeight:1.6,background:"#f8fafc",borderRadius:8,padding:"12px 14px",border:`1px solid ${C.border}`}}>{ex.setup}</div></div>}
    {ex.description&&<div style={{marginBottom:14}}><div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>🎯 Ablauf</div><div style={{fontSize:14,color:C.text,lineHeight:1.6,background:"#f8fafc",borderRadius:8,padding:"12px 14px",border:`1px solid ${C.border}`}}>{ex.description}</div></div>}
    {ex.material?.length>0&&<div style={{marginBottom:14}}><div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>📦 Material</div><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{ex.material.map(m=><span key={m} style={{padding:"4px 10px",borderRadius:20,background:C.accentL,color:C.primary,fontSize:12,fontWeight:700}}>📦 {m}</span>)}</div></div>}
    {ex.tags?.length>0&&<div style={{marginBottom:14}}><div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>🏷️ Tags</div><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{ex.tags.map(t=><span key={t} style={{padding:"3px 10px",borderRadius:20,background:"#f1f5f9",color:C.muted,fontSize:12,fontWeight:600}}>{t}</span>)}</div></div>}
    {ex.notes&&<div style={{marginBottom:12}}><div style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>💬 Notizen</div><div style={{fontSize:14,color:C.text,fontStyle:"italic"}}>{ex.notes}</div></div>}
    {ex.source&&<div style={{fontSize:12,color:C.muted,marginBottom:8}}>Quelle: {ex.source}</div>}
    <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:20,paddingTop:16,borderTop:`1px solid ${C.border}`,flexWrap:"wrap"}}>
      <Btn onClick={()=>{onDelete(ex.id);onClose();}} variant="danger" sm><Trash2 size={14}/> Löschen</Btn>
      <Btn onClick={onEdit} variant="secondary" sm><Edit2 size={14}/> Bearbeiten</Btn>
      <Btn onClick={()=>exportExJson(ex)} variant="secondary" sm><Download size={14}/> JSON</Btn>
      <Btn onClick={()=>exportExHtml(ex)} variant="secondary" sm>🖨 HTML/PDF</Btn>
      <Btn onClick={onClose} sm>Schließen</Btn>
    </div>
  </div>);
}

// ── LIBRARY PAGE ──────────────────────────────────────────────────
function LibraryPage({exercises,onSave,onDelete,apiKey,toast,onlineUsers,currentUser,initialCategory,onConsumeInitialCategory,onGoHome,onGoBack}) {
  const [search,setSearch]=useState("");
  const [fCat,setFCat]=useState(initialCategory||"");
  useEffect(()=>{ if(initialCategory){ setFCat(initialCategory); onConsumeInitialCategory?.(); } },[initialCategory]);
  const [fTag,setFTag]=useState("");
  const [fRat,setFRat]=useState(0);
  const [showF,setShowF]=useState(false);
  const [modal,setModal]=useState(null);
  const [selMode,setSelMode]=useState(false);
  const [selIds,setSelIds]=useState([]);
  const [collapsed,setCollapsed]=useState({});
  const [viewMode,setViewMode]=useState("grid"); // grid | compact
  const toggleCat=cat=>setCollapsed(c=>({...c,[cat]:!c[cat]}));
  const importRef=useRef();
  const toggleSel=id=>setSelIds(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
  const bulkExport=()=>{
    const sel=exercises.filter(e=>selIds.includes(e.id));
    dlJson({version:APP_VERSION,exportDate:now(),type:"exercises",exercises:sel},`GJugend_Uebungen-Auswahl_${sel.length}-Eintraege_${todayISO()}.json`,toast);
  };

  const printExercises=(exList)=>{
    const esc=s=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const bgMap={aufwaermen:"#fff3e0",koordination:"#f3e8ff",technik:"#e8f0fe",spielform:"#e8f5e9",abschluss:"#fce4ec"};
    const colMap={aufwaermen:"#e65100",koordination:"#6d28d9",technik:"#1a56db",spielform:"#166534",abschluss:"#9d174d"};
    const exHtml=exList.map(ex=>{
      const bg=bgMap[ex.category]||"#f8fafc";
      const col=colMap[ex.category]||"#374151";
      const img=ex.imageUrl?`<img src="${ex.imageUrl}" style="width:100%;height:auto;display:block;background:#f8fafc;border-radius:6px;margin:8px 0;border:1px solid #e5e7eb;box-sizing:content-box" onerror="this.style.display='none'"/>`:"";
      const stars=ex.rating>0?"★".repeat(ex.rating)+"☆".repeat(5-ex.rating):"";
      return `
        <div style="border:1.5px solid #e2e8f0;border-radius:10px;margin-bottom:20px;overflow:visible">
          <div style="background:${bg};padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="font-weight:900;font-size:16px;color:${col};flex:1">${esc(ex.title)}</span>
            <span style="font-size:12px;padding:2px 10px;border-radius:20px;background:${col}22;color:${col};font-weight:700">${esc(CATS[ex.category]?.emoji||"")} ${esc(CATS[ex.category]?.label||ex.category)}</span>
            ${ex.duration?`<span style="font-size:12px;color:#64748b">⏱ ${ex.duration} Min</span>`:""}
            ${ex.minPlayers?`<span style="font-size:12px;color:#64748b">👥 ${ex.minPlayers}–${ex.maxPlayers}</span>`:""}
            ${stars?`<span style="font-size:13px;color:#f59e0b">${stars}</span>`:""}
          </div>
          <div style="padding:14px 16px">
            ${img}
            ${ex.setup?`<div style="background:#f8fafc;border-radius:8px;padding:10px 14px;margin-bottom:12px;border-left:3px solid #94a3b8"><div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">📐 Aufbau</div><div style="font-size:14px;line-height:1.7;color:#111">${esc(ex.setup)}</div></div>`:""}
            ${ex.description?`<div style="margin-bottom:12px"><div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">🎯 Ablauf</div><div style="font-size:14px;line-height:1.7;color:#111">${esc(ex.description)}</div></div>`:""}
            ${ex.material?.length?`<div style="margin-bottom:8px;font-size:13px;color:#475569">📦 <strong>Material:</strong> ${esc(ex.material.join(", "))}</div>`:""}
            ${ex.tags?.length?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">${ex.tags.map(t=>`<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#f1f5f9;color:#475569">${esc(t)}</span>`).join("")}</div>`:""}
            ${ex.notes?`<div style="padding:8px 12px;background:#faf5ff;border-radius:6px;font-size:13px;color:#6d28d9;font-style:italic">💡 ${esc(ex.notes)}</div>`:""}
          </div>
        </div>`;
    }).join("");
    const css=`${PDF_CSS}`;
    const html=`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Übungen (${exList.length})</title><style>${css}</style></head><body>
      <h1 style="font-size:22px;margin:0 0 4px">Übungssammlung</h1>
      <div style="font-size:13px;color:#6b7280;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #e5e7eb">${exList.length} Übung${exList.length!==1?"en":""} · SC Sternschanze G-Jugend</div>
      ${exHtml}
      <div class="footer">Erstellt mit G-Jugend Coach App · ${new Date().toLocaleDateString("de-DE")}</div>
${PDF_SCRIPT}</body></html>`;
    const w=window.open("","_blank");
    if(w){w.document.write(html);w.document.close();setTimeout(()=>w.print(),500);}
    else{saveFileSync(html,`GJugend_Uebungen_${todayISO()}.html`,"text/html");toast("Als HTML gespeichert – im Browser öffnen und drucken");}
  };

  const handleImportJson=async e=>{
    const f=e.target.files?.[0];if(!f)return;
    try{
      const data=JSON.parse(await readText(f));
      const list=data.exercises||( Array.isArray(data)?data:null);
      if(!list) throw new Error("Keine Übungen gefunden");
      const valid=list.map(ex=>({rating:3,minPlayers:4,maxPlayers:12,duration:10,tags:[],material:[],imageUrl:"",source:"",notes:"",description:"",setup:"",...ex,id:uid(),createdAt:now(),updatedAt:now()})).filter(ex=>ex.title&&ex.category);
      valid.forEach(ex=>onSave(ex,true));
      toast(`${valid.length} Übungen importiert ✓`);
    }catch(err){toast("Import fehlgeschlagen: "+err.message,"err");}
    e.target.value="";
  };

  const filtered=exercises.filter(ex=>{
    if(search&&!ex.title.toLowerCase().includes(search.toLowerCase())&&!ex.description?.toLowerCase().includes(search.toLowerCase())) return false;
    if(fCat&&fCat!=="__none__"&&normCat(ex.category)!==fCat) return false;if(fCat==="__none__"&&BUILTIN_CATS[normCat(ex.category)]) return false;
    if(fTag&&!ex.tags?.includes(fTag)) return false;
    if(fRat&&ex.rating<fRat) return false;
    return true;
  });
  const allTags=[...new Set(exercises.flatMap(e=>e.tags||[]))].sort();
  return(<div>
    <PageHeader title="Übungsbibliothek" sub={`${exercises.length} Übungen`} onlineUsers={onlineUsers} currentUser={currentUser} onGoHome={onGoHome} onGoBack={onGoBack}/>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
      {selMode
        ?<><Btn sm variant="secondary" onClick={()=>setSelIds(filtered.map(e=>e.id))}>Alle</Btn>
          <Btn sm variant="secondary" onClick={()=>setSelIds([])}>Keine</Btn>
          {selIds.length>0&&<><Btn sm onClick={bulkExport}><Download size={13}/> {selIds.length} JSON</Btn>
          <Btn sm onClick={()=>printExercises(exercises.filter(e=>selIds.includes(e.id)))}>🖨️ PDF</Btn></>}
          <Btn sm variant="secondary" onClick={()=>{setSelMode(false);setSelIds([]);}}>✕ Auswahl</Btn></>
        :<><Btn onClick={()=>setSelMode(true)} variant="secondary" sm><CheckSquare size={14}/> Auswahl</Btn>
          <Btn onClick={()=>importRef.current.click()} variant="secondary" sm><Upload size={14}/> Import</Btn>
          <input ref={importRef} type="file" accept=".json" onChange={handleImportJson} style={{display:"none"}}/>
          <Btn onClick={()=>setModal({type:"ai"})} variant="ai" sm><Bot size={14}/> KI</Btn>
          <Btn onClick={()=>setModal({type:"form",ex:null})}><Plus size={16}/> Neu</Btn></>}
      <div style={{display:"flex",border:`1.5px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
        {[["grid","⊞"],["compact","☰"]].map(([m,icon])=>(
          <button key={m} onClick={()=>setViewMode(m)} style={{padding:"6px 11px",border:"none",background:viewMode===m?C.primary:"white",color:viewMode===m?"white":C.muted,cursor:"pointer",fontSize:14,lineHeight:1}}>{icon}</button>
        ))}
      </div>
    </div>
    <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap"}}>
      <div style={{flex:1,minWidth:200,position:"relative"}}>
        <Search size={15} style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:C.muted}}/>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Suchen..." style={{width:"100%",padding:"9px 12px 9px 36px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
      </div>
      <Btn onClick={()=>setShowF(f=>!f)} variant="secondary" sm><Filter size={14}/> Filter {(fCat||fTag||fRat)?"(aktiv)":""}</Btn>
    </div>
    {showF&&<div style={{background:C.card,border:`1.5px solid ${C.border}`,borderRadius:10,padding:"14px 16px",marginBottom:14,display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
      <div style={{flex:1,minWidth:130}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:4}}>KATEGORIE</label><select value={fCat} onChange={e=>setFCat(e.target.value)} style={{width:"100%",padding:"7px 10px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:13,outline:"none"}}><option value="">Alle</option>{Object.entries(CATS).map(([k,v])=><option key={k} value={k}>{v.emoji} {v.label}</option>)}</select></div>
      <div style={{flex:1,minWidth:130}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:4}}>TAG</label><select value={fTag} onChange={e=>setFTag(e.target.value)} style={{width:"100%",padding:"7px 10px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:13,outline:"none"}}><option value="">Alle</option>{allTags.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
      <div style={{flex:1,minWidth:130}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:4}}>MIN. BEWERTUNG</label><select value={fRat} onChange={e=>setFRat(Number(e.target.value))} style={{width:"100%",padding:"7px 10px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:13,outline:"none"}}><option value={0}>Alle</option>{[1,2,3,4,5].map(n=><option key={n} value={n}>{"★".repeat(n)} +</option>)}</select></div>
      <Btn sm variant="secondary" onClick={()=>{setFCat("");setFTag("");setFRat(0);setShowF(false);}}>Reset</Btn>
    </div>}
    <div style={{display:"flex",gap:6,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
      {(()=>{
        const tabs=[["","Alle",exercises.length],...Object.entries(BUILTIN_CATS).map(([k,v])=>[k,`${v.emoji} ${v.label}`,exercises.filter(e=>normCat(e.category)===k).length])];
        const noneCount=exercises.filter(e=>!BUILTIN_CATS[normCat(e.category)]).length;
        if(noneCount>0) tabs.push(["__none__","❓ Nicht zugeordnet",noneCount]);
        return tabs.map(([k,l,n])=>{
          const col=k&&k!=="__none__"?BUILTIN_CATS[k]:null;
          return(<button key={k} onClick={()=>setFCat(k)} style={{padding:"5px 14px",borderRadius:20,border:`1.5px solid ${fCat===k?(col?col.color:C.primary):C.border}`,background:fCat===k?(col?col.bg:C.accentL):"white",color:fCat===k?(col?col.color:C.primary):C.muted,cursor:"pointer",fontSize:13,fontWeight:700,whiteSpace:"nowrap",fontFamily:"inherit"}}>{l} ({n})</button>);
        });
      })()}
    </div>
    {exercises.length===0?<Empty icon="📚" title="Noch keine Übungen" sub="Lege deine erste Übung an oder nutze KI-Import." onAdd={()=>setModal({type:"form",ex:null})} addLabel="Erste Übung erstellen"/>
    :filtered.length===0?<div style={{textAlign:"center",padding:"40px 0",color:C.muted,fontSize:14}}>Keine Übungen für diese Suche / diesen Filter.</div>
    :<div style={{display:"flex",flexDirection:"column",gap:16}}>
      {[...Object.entries(BUILTIN_CATS).map(([k,v])=>({key:k,info:v,exs:filtered.filter(e=>normCat(e.category)===k)})),
        ...(filtered.filter(e=>!BUILTIN_CATS[normCat(e.category)]).length?[{key:"__none__",info:{label:"Nicht zugeordnet",emoji:"❓",color:"#64748b",bg:"#f1f5f9"},exs:filtered.filter(e=>!BUILTIN_CATS[normCat(e.category)])}]:[])
      ].filter(g=>g.exs.length>0).map(({key:cat,info:catInfo,exs:catExs})=>{
        if(!catExs.length)return null;
        const isOpen=collapsed[cat]!==true;
        return(<div key={cat}>
          <button onClick={()=>toggleCat(cat)} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"10px 14px",borderRadius:10,border:`1.5px solid ${catInfo.color}44`,background:catInfo.bg,cursor:"pointer",fontFamily:"inherit",marginBottom:isOpen?10:0}}>
            <span style={{fontSize:16}}>{catInfo.emoji}</span>
            <span style={{fontWeight:800,fontSize:15,color:catInfo.color,flex:1,textAlign:"left"}}>{catInfo.label}</span>
            <span style={{fontSize:12,fontWeight:700,color:catInfo.color,padding:"2px 8px",borderRadius:20,background:catInfo.color+"22"}}>{catExs.length}</span>
            <span style={{fontSize:12,color:catInfo.color,marginLeft:4}}>{isOpen?"▲":"▼"}</span>
          </button>
          {isOpen&&(viewMode==="compact"
            ?<div style={{display:"flex",flexDirection:"column",gap:1,background:C.card,borderRadius:8,overflow:"hidden",border:`1px solid ${C.border}`,marginBottom:4}}>
              {catExs.map(ex=>{
                const isSel=selIds.includes(ex.id);
                return(<div key={ex.id} onClick={()=>selMode?toggleSel(ex.id):setModal({type:"detail",ex})}
                  style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",cursor:"pointer",background:isSel?C.accentL:"white",borderBottom:`1px solid #f1f5f9`,transition:"background .1s"}}>
                  {/* Color bar left */}
                  <div style={{width:4,height:40,borderRadius:3,background:catInfo.color,flexShrink:0,opacity:.7}}/>
                  {/* Thumbnail or emoji */}
                  {ex.imageUrl
                    ?<img src={ex.imageUrl} alt="" style={{width:44,height:44,objectFit:"cover",borderRadius:8,flexShrink:0}}/>
                    :<div style={{width:44,height:44,borderRadius:8,background:catInfo.bg,border:`1.5px solid ${catInfo.color}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>{catInfo.emoji}</div>}
                  {selMode&&<div style={{color:isSel?C.primary:C.muted,flexShrink:0}}>{isSel?<CheckSquare size={16}/>:<Square size={16}/>}</div>}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14,color:C.text,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span style={{flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ex.title}</span>
                      {ex.done&&<span style={{fontSize:10,padding:"1px 6px",borderRadius:10,background:"#dcfce7",color:"#16a34a",fontWeight:700,flexShrink:0}}>✅</span>}
                    </div>
                    <div style={{fontSize:12,color:C.muted,display:"flex",gap:8,marginTop:3,alignItems:"center"}}>
                      <span>⏱ {ex.duration} Min</span>
                      <span>👥 {ex.minPlayers||4}–{ex.maxPlayers||12}</span>
                      {ex.rating>0&&<span style={{color:"#f59e0b",letterSpacing:1}}>{"★".repeat(ex.rating)}</span>}
                      {ex.material?.length>0&&<span style={{color:C.muted}}>📦 {ex.material.length}</span>}
                    </div>
                    {ex.tags?.length>0&&<div style={{display:"flex",gap:4,marginTop:4,flexWrap:"wrap"}}>
                      {ex.tags.slice(0,3).map(t=><span key={t} style={{fontSize:10,padding:"1px 7px",borderRadius:20,background:"#f1f5f9",color:C.muted,fontWeight:600}}>{t}</span>)}
                    </div>}
                  </div>
                  <span style={{color:C.muted,fontSize:18,flexShrink:0}}>›</span>
                </div>);
              })}
            </div>
            :<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12}}>
              {catExs.map(ex=>{
                const isSel=selIds.includes(ex.id);
                return(<div key={ex.id} onClick={()=>selMode?toggleSel(ex.id):setModal({type:"detail",ex})}
                  style={{background:C.card,borderRadius:12,border:`2px solid ${selMode&&isSel?C.primary:catInfo.color+"33"}`,overflow:"hidden",cursor:"pointer",display:"flex",flexDirection:"column",transition:"box-shadow .15s, transform .1s",position:"relative",opacity:selMode&&!isSel?.6:1}}
                  onMouseEnter={e=>{e.currentTarget.style.boxShadow="0 4px 20px rgba(0,0,0,.12)";e.currentTarget.style.transform="translateY(-1px)";}} onMouseLeave={e=>{e.currentTarget.style.boxShadow="none";e.currentTarget.style.transform="none";}}>
                  {/* Card header strip */}
                  <div style={{height:4,background:catInfo.color,width:"100%"}}/>
                  {selMode&&<div style={{position:"absolute",top:10,right:10,color:isSel?C.primary:C.muted,background:"white",borderRadius:5,padding:1}}>{isSel?<CheckSquare size={18}/>:<Square size={18}/>}</div>}
                  {ex.imageUrl&&<img src={ex.imageUrl} alt="" style={{width:"100%",height:110,objectFit:"cover"}}/>}
                  <div style={{padding:"12px 14px",display:"flex",flexDirection:"column",gap:7,flex:1}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8}}>
                    <CatBadge cat={ex.category} small/>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      {ex.done&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:10,background:"#dcfce7",color:"#16a34a"}}>✅</span>}
                      <Stars value={ex.rating} readonly/>
                    </div>
                  </div>
                  <div style={{fontWeight:800,fontSize:15,color:C.text}}>{ex.title}</div>
                  <div style={{display:"flex",gap:10,color:C.muted,fontSize:12,fontWeight:600,flexWrap:"wrap"}}><span>⏱ {ex.duration} Min</span><span>👥 {ex.minPlayers}–{ex.maxPlayers}</span>{ex.material?.length>0&&<span>📦 {ex.material.length}x</span>}</div>
                  {ex.tags?.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:4}}>{ex.tags.slice(0,3).map(t=><span key={t} style={{padding:"2px 7px",borderRadius:20,background:"#f1f5f9",color:C.muted,fontSize:10,fontWeight:600}}>{t}</span>)}{ex.tags.length>3&&<span style={{padding:"2px 7px",borderRadius:20,background:"#f1f5f9",color:C.muted,fontSize:10}}>+{ex.tags.length-3}</span>}</div>}
                  </div>
                </div>);
              })}
            </div>
          )}
        </div>);
      })}
    </div>}
    {modal?.type==="ai"&&<Modal title="🤖 KI-Import" onClose={()=>setModal(null)} wide><AIImportModal apiKey={apiKey} onSave={ex=>{onSave(ex);setModal(null);}} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="form"&&<Modal title={modal.ex?"Übung bearbeiten":"Neue Übung"} onClose={()=>setModal(null)} wide><ExerciseForm exercise={modal.ex} onSave={(ex,andAdd)=>{onSave(ex);if(!andAdd)setModal(null);}} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="detail"&&<Modal title={modal.ex.title} onClose={()=>setModal(null)} wide><ExDetail exercise={modal.ex} onEdit={()=>setModal({type:"form",ex:modal.ex})} onSave={ex=>{onSave({...ex,updatedAt:now()});setModal(m=>m?{...m,ex}:m);}} onDelete={onDelete} onClose={()=>setModal(null)}/></Modal>}
  </div>);
}

// ── PLAYER FORM ───────────────────────────────────────────────────
const EMPTY_PLAYER = {name:"",birthYear:2019,birthDate:"",strength:1,active:true,jersey:"",notes:"",vereinsmitglied:false,spielerpass:false,contacts:[]};
const EMPTY_CONTACT = {name:"",relation:"Mutter",phone:"",email:"",address:""};
const RELATIONS = ["Mutter","Vater","Elternteil","Großelternteil","Geschwister","Sonstiges"];

function ContactsEditor({contacts,onChange}) {
  const [editIdx,setEditIdx]=useState(null);
  const [form,setForm]=useState(null);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const startAdd=()=>{setForm({...EMPTY_CONTACT,id:uid()});setEditIdx(-1);};
  const startEdit=(i)=>{setForm({...contacts[i]});setEditIdx(i);};
  const save=()=>{if(!form.name.trim())return;if(editIdx===-1)onChange([...contacts,form]);else onChange(contacts.map((c,i)=>i===editIdx?form:c));setForm(null);setEditIdx(null);};
  const remove=(i)=>onChange(contacts.filter((_,j)=>j!==i));
  if(form) return(
    <div style={{background:"#f8fafc",borderRadius:10,border:`1.5px solid ${C.border}`,padding:"14px 16px",marginBottom:14}}>
      <div style={{fontWeight:700,fontSize:13,color:C.text,marginBottom:12}}>{editIdx===-1?"Kontakt hinzufügen":"Kontakt bearbeiten"}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><Inp label="Name *" value={form.name} onChange={e=>set("name",e.target.value)} style={{marginBottom:0}}/><Sel label="Beziehung" value={form.relation} onChange={e=>set("relation",e.target.value)} style={{marginBottom:0}}>{RELATIONS.map(r=><option key={r} value={r}>{r}</option>)}</Sel></div>
      <Inp label="Telefon" value={form.phone} onChange={e=>set("phone",e.target.value)} placeholder="+49 ..."/>
      <Inp label="E-Mail" type="email" value={form.email} onChange={e=>set("email",e.target.value)} placeholder="email@beispiel.de"/>
      <Txta label="Adresse" value={form.address} onChange={e=>set("address",e.target.value)} rows={2} placeholder="Straße, PLZ Ort"/>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}><Btn sm variant="secondary" onClick={()=>{setForm(null);setEditIdx(null);}}>Abbrechen</Btn><Btn sm onClick={save}>Speichern</Btn></div>
    </div>);
  return(<div style={{marginBottom:14}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}><label style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6}}>Kontaktpersonen ({contacts.length})</label><Btn sm onClick={startAdd}><Plus size={12}/> Hinzufügen</Btn></div>
    {contacts.length===0&&<div style={{fontSize:13,color:C.muted,padding:"6px 0"}}>Noch keine Kontaktperson eingetragen.</div>}
    {contacts.map((c,i)=><div key={c.id||i} style={{background:"#f8fafc",borderRadius:8,border:`1px solid ${C.border}`,padding:"10px 14px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
      <div><div style={{fontWeight:700,fontSize:14,color:C.text}}>{c.name} <span style={{fontSize:12,color:C.muted,fontWeight:400}}>({c.relation})</span></div>{c.phone&&<div style={{fontSize:13,color:C.muted,marginTop:2}}>📞 {c.phone}</div>}{c.email&&<div style={{fontSize:13,color:C.muted}}>✉️ {c.email}</div>}{c.address&&<div style={{fontSize:12,color:C.muted}}>📍 {c.address}</div>}</div>
      <div style={{display:"flex",gap:4,flexShrink:0}}><button onClick={()=>startEdit(i)} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,padding:4}}><Edit2 size={13}/></button><button onClick={()=>remove(i)} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:4}}><Trash2 size={13}/></button></div>
    </div>)}
  </div>);
}
function PlayerForm({player,onSave,onClose}) {
  const [form,setForm]=useState({...EMPTY_PLAYER,...player,contacts:player?.contacts||[]});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const doSave=(andAdd)=>{
    if(!form.name.trim())return;
    onSave({...form,id:form.id||uid(),createdAt:form.createdAt||now()});
    if(andAdd) setForm({...EMPTY_PLAYER,contacts:[]});
  };
  return(<div>
    <Inp label="Name *" value={form.name} onChange={e=>set("name",e.target.value)} placeholder="Vorname"/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
      <Inp label="Jahrgang" type="number" value={form.birthYear} onChange={e=>set("birthYear",Number(e.target.value))} style={{marginBottom:0}}/>
      <Inp label="Trikot #" value={form.jersey} onChange={e=>set("jersey",e.target.value)} placeholder="z.B. 7" style={{marginBottom:0}}/>
    </div>
    <Inp label="Geburtstag" type="date" value={form.birthDate||""} onChange={e=>{const d=e.target.value;set("birthDate",d);if(d)set("birthYear",Number(d.slice(0,4)));}} placeholder="TT.MM.JJJJ"/>
    <div style={{marginBottom:14}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>Stärke</label><div style={{display:"flex",flexDirection:"column",gap:8}}>{[1,2,3,4].map(n=>{const s=STR[n];return(<button key={n} onClick={()=>set("strength",n)} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"10px 14px",borderRadius:10,border:`2px solid ${form.strength===n?s.color:C.border}`,background:form.strength===n?s.light:"white",cursor:"pointer",textAlign:"left",fontFamily:"inherit"}}><span style={{fontSize:20,lineHeight:1}}>{s.emoji}</span><div><div style={{fontWeight:700,fontSize:14,color:form.strength===n?s.color:C.text}}>{s.label}</div><div style={{fontSize:12,color:C.muted,marginTop:2}}>{s.desc}</div></div></button>);})}</div></div>
    <div style={{display:"flex",gap:16,marginBottom:14,flexWrap:"wrap"}}>
      <label style={{display:"flex",gap:8,alignItems:"center",cursor:"pointer"}}><input type="checkbox" checked={form.active} onChange={e=>set("active",e.target.checked)} style={{width:16,height:16}}/><span style={{fontSize:14,fontWeight:600,color:C.text}}>Aktiv</span></label>
      <label style={{display:"flex",gap:8,alignItems:"center",cursor:"pointer"}}><input type="checkbox" checked={!!form.vereinsmitglied} onChange={e=>set("vereinsmitglied",e.target.checked)} style={{width:16,height:16}}/><span style={{fontSize:14,fontWeight:600,color:C.text}}>Vereinsmitglied</span></label>
      <label style={{display:"flex",gap:8,alignItems:"center",cursor:"pointer"}}><input type="checkbox" checked={!!form.spielerpass} onChange={e=>set("spielerpass",e.target.checked)} style={{width:16,height:16}}/><span style={{fontSize:14,fontWeight:600,color:C.text}}>Spielerpass ✓</span></label>
    </div>
    <Txta label="Notizen" value={form.notes} onChange={e=>set("notes",e.target.value)} rows={2}/>
    <ContactsEditor contacts={form.contacts||[]} onChange={v=>set("contacts",v)}/>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`,flexWrap:"wrap"}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      {!player?.id&&<Btn variant="secondary" onClick={()=>doSave(true)}>+ Weiteren anlegen</Btn>}
      <Btn onClick={()=>doSave(false)}>{player?.id?"Speichern":"Erstellen"}</Btn>
    </div>
  </div>);
}

// ── COACH FORM ────────────────────────────────────────────────────
const EMPTY_COACH = {name:"",role:"assistant",phone:"",active:true,notes:""};
function CoachForm({coach,onSave,onClose}) {
  const [form,setForm]=useState({...EMPTY_COACH,...coach});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const doSave=(andAdd)=>{
    if(!form.name.trim())return;
    onSave({...form,id:form.id||uid(),createdAt:form.createdAt||now()});
    if(andAdd) setForm(EMPTY_COACH);
  };
  return(<div>
    <Inp label="Name *" value={form.name} onChange={e=>set("name",e.target.value)}/>
    <Sel label="Rolle" value={form.role} onChange={e=>set("role",e.target.value)}>{Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</Sel>
    <Inp label="Telefon" value={form.phone} onChange={e=>set("phone",e.target.value)} placeholder="+49..."/>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}><input type="checkbox" id="ca" checked={form.active} onChange={e=>set("active",e.target.checked)} style={{width:16,height:16}}/><label htmlFor="ca" style={{fontSize:14,fontWeight:600,color:C.text,cursor:"pointer"}}>Aktiv</label></div>
    <Txta label="Notizen" value={form.notes} onChange={e=>set("notes",e.target.value)} rows={2}/>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`,flexWrap:"wrap"}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      {!coach?.id&&<Btn variant="secondary" onClick={()=>doSave(true)}>+ Weiteren anlegen</Btn>}
      <Btn onClick={()=>doSave(false)}>{coach?.id?"Speichern":"Erstellen"}</Btn>
    </div>
  </div>);
}

// ── TEAM PAGE ─────────────────────────────────────────────────────
function getBdInfo(p) {
  if(!p.birthDate) return p.birthYear?{label:String(p.birthYear),isToday:false,wasPast:false,isSoon:false,date:String(p.birthYear),diff:999}:null;
  const now=new Date(),parts=p.birthDate.split("-");
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const mm=Number(parts[1]),dd=Number(parts[2]);
  const bDay=new Date(today.getFullYear(),mm-1,dd);
  let diff=Math.round((bDay-today)/86400000);
  if(diff<-7){bDay.setFullYear(today.getFullYear()+1);diff=Math.round((bDay-today)/86400000);}
  const age=today.getFullYear()-Number(parts[0])+(diff<0?0:-1);
  const isToday=diff===0,wasPast=diff<0&&diff>=-7,isSoon=diff>0&&diff<=7;
  const pad=n=>String(n).padStart(2,"0");
  return{diff,age:diff<=0?age+1:age,isToday,wasPast,isSoon,
    label:isToday?"🎉 Heute!":diff===1?"Morgen":diff===-1?"Gestern":wasPast?`vor ${Math.abs(diff)}d`:isSoon?`in ${diff}d`:`${pad(dd)}.${pad(mm)}.`,
    date:`${pad(dd)}.${pad(mm)}.${parts[0]}`};
}

function PlayerList({players,selPlayers,setSelPlayers,onEdit,onDel,showStrength=true}) {
  const [search,setSearch]=useState("");
  const [sortBy,setSortBy]=useState("name");     // name|strength|birthday|jersey
  const [filterStr,setFilterStr]=useState("");   // ""=all|"1"|"2"|"3"|"4"
  const [filterActive,setFilterActive]=useState("active"); // active|inactive|all
  const [showFilters,setShowFilters]=useState(false);
  // toggleAll computed after filtered (see below)

  const filtered=players
    .filter(p=>{
      if(filterActive==="active"&&!p.active&&!selPlayers.includes(p.id))return false;
      if(filterActive==="inactive"&&p.active)return false;
      if(filterStr&&String(p.strength)!==filterStr)return false;
      if(search){const q=search.toLowerCase();if(!p.name.toLowerCase().includes(q))return false;}
      return true;
    })
    .sort((a,b)=>{
      if(sortBy==="name") return a.name.localeCompare(b.name,"de");
      if(sortBy==="strength") return b.strength-a.strength;
      if(sortBy==="birthday"){
        const da=getBdInfo(a),db=getBdInfo(b);
        const da2=da?((da.diff<0&&da.diff>=-7)?da.diff:da.diff<0?da.diff+365:da.diff):999;
        const db2=db?((db.diff<0&&db.diff>=-7)?db.diff:db.diff<0?db.diff+365:db.diff):999;
        return da2-db2;
      }
      if(sortBy==="jersey"){const ja=Number(a.jersey)||999,jb=Number(b.jersey)||999;return ja-jb;}
      return 0;
    });
  const filteredIds=filtered.map(p=>p.id);
  const allSel=filteredIds.length>0&&filteredIds.every(id=>selPlayers.includes(id));
  const toggleAll=()=>setSelPlayers(allSel
    ?selPlayers.filter(id=>!filteredIds.includes(id))
    :[...new Set([...selPlayers,...filteredIds])]);

  const chip=(label,active,onClick,col)=>(
    <button onClick={onClick} style={{padding:"4px 12px",borderRadius:20,border:`1.5px solid ${active?(col||C.primary):C.border}`,background:active?(col?col+"22":C.accentL):"white",color:active?(col||C.primary):C.muted,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit",whiteSpace:"nowrap"}}>{label}</button>
  );

  return(<div>
    {/* Search + filter toggle */}
    <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"center"}}>
      <div style={{flex:1,position:"relative"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Suchen..." style={{width:"100%",padding:"8px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
        {search&&<button onClick={()=>setSearch("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:C.muted,fontSize:16}}>✕</button>}
      </div>
      <button onClick={()=>setShowFilters(v=>!v)} style={{padding:"8px 14px",borderRadius:8,border:`1.5px solid ${showFilters?C.primary:C.border}`,background:showFilters?C.accentL:"white",color:showFilters?C.primary:C.muted,cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit",whiteSpace:"nowrap"}}>
        ⚙️ Filter{(filterStr||filterActive!=="active"||sortBy!=="name")?` ●`:""}
      </button>
    </div>

    {showFilters&&<div style={{background:"#f8fafc",borderRadius:10,border:`1px solid ${C.border}`,padding:"12px 14px",marginBottom:12}}>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>Sortieren</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {[["name","A–Z"],["strength","Stärke"],["birthday","Geburtstag"],["jersey","Trikot #"]].map(([k,l])=>chip(l,sortBy===k,()=>setSortBy(k)))}
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>Status</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {[["active","Aktiv"],["inactive","Inaktiv"],["all","Alle"]].map(([k,l])=>chip(l,filterActive===k,()=>setFilterActive(k)))}
        </div>
      </div>
      <div>
        <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>Stärke</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {chip("Alle",!filterStr,()=>setFilterStr(""))}
          {[4,3,2,1].map(s=>chip(`${STR[s].emoji} ${STR[s].label}`,filterStr===String(s),()=>setFilterStr(filterStr===String(s)?"":String(s)),STR[s].color))}
        </div>
      </div>
    </div>}

    {/* Select-all + count */}
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,padding:"6px 2px"}}>
      <button onClick={toggleAll} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",cursor:"pointer",color:allSel?C.primary:C.muted,fontFamily:"inherit",padding:0}}>
        {allSel?<CheckSquare size={16}/>:<Square size={16}/>}
        <span style={{fontSize:12,fontWeight:700}}>{selPlayers.length>0?`${selPlayers.length} ausgewählt`:"Alle auswählen"}</span>
      </button>
      <span style={{fontSize:12,color:C.muted,marginLeft:"auto"}}>{filtered.length} Spieler</span>
      {selPlayers.length>0&&<button onClick={()=>setSelPlayers([])} style={{fontSize:12,color:"#ef4444",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>✕ Leeren</button>}
    </div>

    {/* Player rows */}
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      {filtered.map(p=>{
        const isSel=selPlayers.includes(p.id);
        const bd=getBdInfo(p);
        const rowBg=bd?.isToday?"#dcfce7":bd?.wasPast?"#fef9c3":isSel?C.accentL:"white";
        const borderL=`4px solid ${bd?.isToday?"#22c55e":bd?.wasPast?"#fde047":isSel?C.primary:STR[p.strength]?.color||C.border}`;
        return(<div key={p.id} onClick={()=>setSelPlayers(prev=>prev.includes(p.id)?prev.filter(x=>x!==p.id):[...prev,p.id])}
          style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,background:rowBg,borderLeft:borderL,border:`1px solid ${isSel?C.primary:C.border}`,borderLeftWidth:4,cursor:"pointer",opacity:p.active?1:.6}}>
          {/* Checkbox */}
          <div style={{color:isSel?C.primary:C.muted,flexShrink:0}}>{isSel?<CheckSquare size={17}/>:<Square size={17}/>}</div>
          {/* Strength dot */}
          <div style={{width:8,height:8,borderRadius:"50%",background:showStrength!==false?(STR[p.strength]?.color||"#e2e8f0"):"#e2e8f0",flexShrink:0}}/>
          {/* Name + meta */}
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:800,fontSize:14,color:C.text,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              {p.name}
              {bd?.isToday&&<span style={{fontSize:12}}>🎉</span>}
              {!p.active&&<span style={{fontSize:10,padding:"1px 6px",borderRadius:10,background:"#fef3c7",color:"#d97706",fontWeight:700}}>inaktiv</span>}
              {p.guest&&<span style={{fontSize:10,padding:"1px 6px",borderRadius:10,background:"#e0e7ff",color:"#4338ca",fontWeight:700}}>Gast</span>}
            </div>
            <div style={{display:"flex",gap:8,marginTop:2,flexWrap:"wrap",alignItems:"center"}}>
              {showStrength!==false&&<span style={{fontSize:11,color:STR[p.strength]?.color||C.muted,fontWeight:600}}>{STR[p.strength]?.emoji} {STR[p.strength]?.label}</span>}
              {p.jersey&&<span style={{fontSize:11,color:C.muted}}>#{p.jersey}</span>}
              {bd&&<span style={{fontSize:11,fontWeight:bd.isToday||bd.wasPast||bd.isSoon?700:400,color:bd.isToday?"#16a34a":bd.wasPast?"#92400e":bd.isSoon?"#7c3aed":C.muted}}>🎂 {bd.label}</span>}
              {(p.contacts||[]).length>0&&<span style={{fontSize:11,color:C.muted}}>📞 {p.contacts.length}</span>}
            </div>
          </div>
          {/* Actions */}
          {(onEdit||onDel)&&<div style={{display:"flex",gap:2,flexShrink:0}} onClick={e=>e.stopPropagation()}>
            {onEdit&&<button onClick={()=>onEdit(p)} style={{padding:6,borderRadius:6,border:"none",background:"transparent",cursor:"pointer",color:C.muted}}><Edit2 size={14}/></button>}
            {onDel&&<button onClick={()=>onDel(p)} style={{padding:6,borderRadius:6,border:"none",background:"transparent",cursor:"pointer",color:"#ef4444"}}><Trash2 size={14}/></button>}
          </div>}
        </div>);
      })}
      {filtered.length===0&&<div style={{textAlign:"center",padding:"30px 0",color:C.muted,fontSize:14}}>Keine Spieler gefunden.</div>}
    </div>
  </div>);
}


function AddToSessionModal({playerIds,sessions,players,onSaveSession,onClose,toast}) {
  const [selSess,setSelSess]=useState(null);
  const newIds=playerIds;

  const doAdd=(mode)=>{
    if(!selSess)return;
    const s=sessions.find(x=>x.id===selSess);
    if(!s)return;
    let updated;
    if(mode==="replace") updated={...s,playerIds:newIds,participantCount:String(newIds.length),updatedAt:now()};
    else updated={...s,playerIds:[...new Set([...(s.playerIds||[]),...newIds])],participantCount:String(new Set([...(s.playerIds||[]),...newIds]).size),updatedAt:now()};
    onSaveSession(updated);
    toast(mode==="replace"?"Spieler ersetzt ✓":"Spieler hinzugefügt ✓");
    onClose();
  };

  const sorted=[...sessions].sort((a,b)=>b.date?.localeCompare(a.date||"")||0);
  const getName=id=>players.find(p=>p.id===id)?.name||"?";

  const sel=selSess?sessions.find(s=>s.id===selSess):null;
  const existing=sel?.playerIds||[];
  const onlyInNew=newIds.filter(id=>!existing.includes(id));
  const onlyInExist=existing.filter(id=>!newIds.includes(id));
  const inBoth=newIds.filter(id=>existing.includes(id));

  return(<div>
    <div style={{fontSize:13,color:C.muted,marginBottom:12}}>Wähle ein Training, zu dem {newIds.length} Spieler hinzugefügt werden sollen.</div>
    <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:200,overflowY:"auto",marginBottom:16}}>
      {sorted.map(s=><button key={s.id} onClick={()=>setSelSess(s.id===selSess?null:s.id)} style={{padding:"10px 14px",borderRadius:8,border:`2px solid ${s.id===selSess?C.primary:C.border}`,background:s.id===selSess?C.accentL:"white",cursor:"pointer",textAlign:"left",fontFamily:"inherit"}}>
        <div style={{fontWeight:700,fontSize:14,color:C.text}}>{new Date(s.date).toLocaleDateString("de-DE")}</div>
        <div style={{fontSize:12,color:C.muted}}>⏱ {s.duration} Min · 👥 {s.participantCount||0} Kinder · {s.exerciseIds?.length||0} Übungen</div>
      </button>)}
    </div>
    {sel&&existing.length>0&&<div style={{marginBottom:16,background:"#f8fafc",borderRadius:10,border:`1px solid ${C.border}`,padding:"12px 14px"}}>
      <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Unterschiede</div>
      {inBoth.length>0&&<div style={{marginBottom:6}}><span style={{fontSize:11,fontWeight:700,color:"#16a34a"}}>✓ Bereits dabei ({inBoth.length}):</span><div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:3}}>{inBoth.map(id=><span key={id} style={{fontSize:11,padding:"2px 7px",borderRadius:20,background:"#dcfce7",color:"#16a34a"}}>{getName(id)}</span>)}</div></div>}
      {onlyInNew.length>0&&<div style={{marginBottom:6}}><span style={{fontSize:11,fontWeight:700,color:C.primary}}>+ Neu hinzufügen ({onlyInNew.length}):</span><div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:3}}>{onlyInNew.map(id=><span key={id} style={{fontSize:11,padding:"2px 7px",borderRadius:20,background:C.accentL,color:C.primary}}>{getName(id)}</span>)}</div></div>}
      {onlyInExist.length>0&&<div><span style={{fontSize:11,fontWeight:700,color:"#dc2626"}}>✕ Nur im Training ({onlyInExist.length}):</span><div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:3}}>{onlyInExist.map(id=><span key={id} style={{fontSize:11,padding:"2px 7px",borderRadius:20,background:"#fee2e2",color:"#dc2626"}}>{getName(id)}</span>)}</div></div>}
    </div>}
    {sel&&<div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
      <Btn sm variant="secondary" onClick={onClose}>Abbrechen</Btn>
      {onlyInNew.length>0&&<Btn sm variant="secondary" onClick={()=>doAdd("merge")}>+ {onlyInNew.length} hinzufügen</Btn>}
      <Btn sm onClick={()=>doAdd("replace")} style={{background:"#dc2626"}}>Ersetzen ({newIds.length})</Btn>
    </div>}
    {!sel&&<div style={{display:"flex",justifyContent:"flex-end"}}><Btn sm variant="secondary" onClick={onClose}>Abbrechen</Btn></div>}
  </div>);
}

function TeamPage({players,coaches,sessions,onSaveSession,onSavePlayer,onDeletePlayer,onSaveCoach,onDeleteCoach,toast,onAddToTraining,showStrength=true,readOnly=false,onlineUsers,currentUser,onGoHome,onGoBack}) {
  const [tab,setTab]=useState("players");
  const [modal,setModal]=useState(null);
  const [del,setDel]=useState(null);
  const [kontakteSearch,setKontakteSearch]=useState("");
  const [kontakteFilter,setKontakteFilter]=useState({active:"active",mitglied:"",pass:""});
  const playerImportRef=useRef();
  const coachImportRef=useRef();

  const handleImportPlayers=async e=>{
    const f=e.target.files?.[0];if(!f)return;
    try{
      const data=JSON.parse(await readText(f));
      const list=data.players||(Array.isArray(data)?data:null);
      if(!list) throw new Error("Keine Spieler gefunden");
      list.forEach(p=>onSavePlayer({...p,id:uid(),createdAt:now()}));
      toast(`${list.length} Spieler importiert ✓`);
    }catch(err){toast("Fehler: "+err.message,"err");}
    e.target.value="";
  };
  const handleImportCoaches=async e=>{
    const f=e.target.files?.[0];if(!f)return;
    try{
      const data=JSON.parse(await readText(f));
      const list=data.coaches||(Array.isArray(data)?data:null);
      if(!list) throw new Error("Keine Trainer gefunden");
      list.forEach(c=>onSaveCoach({...c,id:uid(),createdAt:now()}));
      toast(`${list.length} Trainer importiert ✓`);
    }catch(err){toast("Fehler: "+err.message,"err");}
    e.target.value="";
  };

  const [selPlayers,setSelPlayers]=useState([]);
  const [selCoaches,setSelCoaches]=useState([]);
  const grp={4:[],3:[],2:[],1:[]};players.forEach(p=>grp[p.strength]?.push(p));
  const tb=(k,l,n)=><button onClick={()=>setTab(k)} style={{padding:"8px 20px",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,fontSize:14,fontFamily:"inherit",background:tab===k?C.primary:"transparent",color:tab===k?"white":C.muted}}>{l} <span style={{fontSize:12,opacity:.7}}>({n})</span></button>;
  const totalSel=selPlayers.length+selCoaches.length;
  return(<div>
    <PageHeader title="Team" sub={`${players.filter(p=>p.active).length} aktive Spieler · ${coaches.filter(c=>c.active).length} Trainer`} onlineUsers={onlineUsers} currentUser={currentUser} onGoHome={onGoHome} onGoBack={onGoBack}/>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
      {tab==="players"&&<><Btn onClick={()=>playerImportRef.current.click()} variant="secondary" sm><Upload size={14}/> Spieler importieren</Btn><input ref={playerImportRef} type="file" accept=".json,.csv" onChange={async e=>{const f=e.target.files?.[0];if(!f)return;if(f.name.endsWith(".csv")){const p=parseCsvPlayers(await readText(f));p.forEach(x=>onSavePlayer(x));toast(`${p.length} Spieler importiert`);} else handleImportPlayers(e); e.target.value="";}} style={{display:"none"}}/></>}
      {tab==="coaches"&&<><Btn onClick={()=>coachImportRef.current.click()} variant="secondary" sm><Upload size={14}/> Trainer importieren</Btn><input ref={coachImportRef} type="file" accept=".json" onChange={handleImportCoaches} style={{display:"none"}}/></>}
      {(tab==="players"||tab==="coaches")&&<Btn onClick={()=>setModal({type:tab==="players"?"pf":"cf",data:null})}><Plus size={16}/> {tab==="players"?"Spieler":"Trainer"} hinzufügen</Btn>}
    </div>
    <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:10,padding:4,marginBottom:12,width:"fit-content"}}>{tb("players","Spieler",players.length)}{tb("coaches","Trainer",coaches.length)}{tb("kontakte","Kontakte",players.filter(p=>(p.contacts||[]).length>0).length)}</div>
    {totalSel>0&&<div style={{borderRadius:10,border:`1.5px solid ${C.primary}`,background:C.accentL,padding:"10px 14px",marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <span style={{fontWeight:800,color:C.primary,fontSize:14,flex:1}}>✓ {selPlayers.length>0?`${selPlayers.length} Spieler`:""}{selPlayers.length>0&&selCoaches.length>0?" + ":""}{selCoaches.length>0?`${selCoaches.length} Trainer`:""} ausgewählt</span>
        <button onClick={()=>{setSelPlayers([]);setSelCoaches([]);}} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,fontSize:13,fontFamily:"inherit",fontWeight:700}}>✕ Leeren</button>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <Btn sm onClick={()=>{const selectedC=coaches.filter(c=>selCoaches.includes(c.id));onAddToTraining?.({playerIds:selPlayers,coachIds:selCoaches,kids:selPlayers.length,coachCount:selectedC.length||1});}}><CalendarDays size={13}/> Neues Training</Btn>
        <Btn sm variant="secondary" onClick={()=>setModal({type:"addToSession",playerIds:selPlayers})}>+ Zu Training</Btn>
        <Btn sm variant="secondary" onClick={()=>setModal({type:"teamBuilder",players:players.filter(p=>selPlayers.includes(p.id))})}><Shuffle size={13}/> Teams bilden</Btn>
      </div>
    </div>}
    {tab==="players"&&(players.length===0?<Empty icon="👦" title="Noch keine Spieler" onAdd={!readOnly&&onSavePlayer?()=>setModal({type:"pf",data:null}):null} addLabel="Ersten Spieler anlegen"/>:
      <PlayerList players={players} selPlayers={selPlayers} setSelPlayers={setSelPlayers}
        onEdit={!readOnly&&onSavePlayer?p=>setModal({type:"pf",data:p}):null}
        onDel={!readOnly&&onDeletePlayer?p=>setDel({type:"player",id:p.id,name:p.name}):null}
        showStrength={showStrength}/>
    )}
    {tab==="coaches"&&(coaches.length===0?<Empty icon="🧑‍🏫" title="Noch keine Trainer" onAdd={()=>setModal({type:"cf",data:null})} addLabel="Ersten Trainer anlegen"/>:
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:12}}>
        {coaches.map(c=>{const isSel=selCoaches.includes(c.id);return(<div key={c.id} style={{background:C.card,borderRadius:10,border:`2px solid ${isSel?C.primary:C.border}`,padding:"14px 16px",opacity:c.active?1:.6,cursor:"pointer"}} onClick={()=>setSelCoaches(prev=>prev.includes(c.id)?prev.filter(x=>x!==c.id):[...prev,c.id])}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
              <div style={{color:isSel?C.primary:C.muted,marginTop:2}}>{isSel?<CheckSquare size={16}/>:<Square size={16}/>}</div>
              <div><div style={{fontWeight:800,fontSize:15,color:C.text}}>{c.name}</div><div style={{fontSize:12,color:C.muted}}>{ROLES[c.role]}</div>{c.phone&&<div style={{fontSize:12,color:C.muted}}>{c.phone}</div>}</div>
            </div>
            <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}><button onClick={()=>setModal({type:"cf",data:c})} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,padding:4}}><Edit2 size={14}/></button><button onClick={()=>setDel({type:"coach",id:c.id,name:c.name})} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:4}}><Trash2 size={14}/></button></div>
          </div>
        </div>);})}
      </div>)}
    {tab==="kontakte"&&(<div>
      <div style={{position:"relative",marginBottom:10}}>
        <Search size={15} style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:C.muted}}/>
        <input value={kontakteSearch} onChange={e=>setKontakteSearch(e.target.value)} placeholder="Spieler oder Kontakt suchen..." style={{width:"100%",padding:"9px 12px 9px 36px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
      </div>
      {/* Filterzeile */}
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
        {[["active","Aktiv"],["","Alle"],["inactive","Inaktiv"]].map(([v,l])=>{
          const on=kontakteFilter.active===v;
          return <button key={v} onClick={()=>setKontakteFilter(f=>({...f,active:v}))} style={{padding:"4px 11px",borderRadius:20,border:`1.5px solid ${on?C.primary:C.border}`,background:on?C.accentL:"white",color:on?C.primary:C.muted,cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:12}}>{l}</button>;
        })}
        <div style={{width:1,background:C.border,margin:"0 2px"}}/>
        {[["ja","✓ Mitglied"],["nein","○ Kein Mitglied"]].map(([v,l])=>{
          const on=kontakteFilter.mitglied===v;
          return <button key={v} onClick={()=>setKontakteFilter(f=>({...f,mitglied:on?"":v}))} style={{padding:"4px 11px",borderRadius:20,border:`1.5px solid ${on?"#16a34a":C.border}`,background:on?"#dcfce7":"white",color:on?"#16a34a":C.muted,cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:12}}>{l}</button>;
        })}
        <div style={{width:1,background:C.border,margin:"0 2px"}}/>
        {[["ja","✓ Pass"],["nein","○ Kein Pass"]].map(([v,l])=>{
          const on=kontakteFilter.pass===v;
          return <button key={v} onClick={()=>setKontakteFilter(f=>({...f,pass:on?"":v}))} style={{padding:"4px 11px",borderRadius:20,border:`1.5px solid ${on?"#1d4ed8":C.border}`,background:on?"#dbeafe":"white",color:on?"#1d4ed8":C.muted,cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:12}}>{l}</button>;
        })}
      </div>
      {players.length===0?<Empty icon="👥" title="Noch keine Spieler" sub="Lege zuerst Spieler im Tab ‚Spieler' an." onAdd={()=>setTab("players")} addLabel="Zu Spieler"/>:
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {players.filter(p=>{
            const q=kontakteSearch.toLowerCase();
            if(q&&!p.name.toLowerCase().includes(q)&&!(p.contacts||[]).some(c=>c.name.toLowerCase().includes(q)||c.phone?.includes(q)))return false;
            if(kontakteFilter.active==="active"&&!p.active)return false;
            if(kontakteFilter.active==="inactive"&&p.active)return false;
            if(kontakteFilter.mitglied==="ja"&&!p.vereinsmitglied)return false;
            if(kontakteFilter.mitglied==="nein"&&p.vereinsmitglied)return false;
            if(kontakteFilter.pass==="ja"&&!p.spielerpass)return false;
            if(kontakteFilter.pass==="nein"&&p.spielerpass)return false;
            return true;
          }).map(p=>{
            const contacts=p.contacts||[];
            return(<div key={p.id} style={{background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,overflow:"hidden"}}>
              <div style={{padding:"12px 16px",background:"#f8fafc",borderBottom:contacts.length?`1px solid ${C.border}`:"none",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:36,height:36,borderRadius:"50%",background:STR[p.strength].light,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{STR[p.strength].emoji}</div>
                  <div>
                    <div style={{fontWeight:800,fontSize:15,color:C.text}}>{p.name}{!p.active&&<span style={{fontSize:11,color:C.muted,fontWeight:400,marginLeft:6}}>(inaktiv)</span>}</div>
                    <div style={{display:"flex",gap:8,marginTop:2}}>
                      {p.jersey&&<span style={{fontSize:11,color:C.muted}}>#{p.jersey}</span>}
                      <span style={{fontSize:11,padding:"1px 6px",borderRadius:10,background:p.vereinsmitglied?"#dcfce7":"#f1f5f9",color:p.vereinsmitglied?"#16a34a":C.muted,fontWeight:700}}>{p.vereinsmitglied?"✓ Mitglied":"○ Kein Mitglied"}</span>
                      <span style={{fontSize:11,padding:"1px 6px",borderRadius:10,background:p.spielerpass?"#dbeafe":"#f1f5f9",color:p.spielerpass?"#1d4ed8":C.muted,fontWeight:700}}>{p.spielerpass?"✓ Pass":"○ Kein Pass"}</span>
                    </div>
                  </div>
                </div>
                <button onClick={()=>setModal({type:"pf",data:p})} style={{background:"none",border:`1.5px solid ${C.border}`,borderRadius:8,cursor:"pointer",color:C.muted,padding:"6px 10px",display:"flex",alignItems:"center",gap:4,fontFamily:"inherit",fontSize:12,fontWeight:700}}><Edit2 size={12}/> Bearbeiten</button>
              </div>
              {contacts.length===0&&<div style={{padding:"10px 16px",fontSize:13,color:C.muted,fontStyle:"italic"}}>Keine Kontaktperson – <button onClick={()=>setModal({type:"pf",data:p})} style={{background:"none",border:"none",cursor:"pointer",color:C.primary,fontWeight:700,fontSize:13,padding:0,fontFamily:"inherit"}}>jetzt hinzufügen</button></div>}
              {contacts.map((c,i)=><div key={i} style={{padding:"10px 16px",borderTop:i>0?`1px solid ${C.border}`:"none",display:"flex",alignItems:"flex-start",gap:12}}>
                <div style={{fontSize:20,marginTop:2,flexShrink:0}}>{c.relation==="Mutter"?"👩":c.relation==="Vater"?"👨":"👤"}</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,color:C.text}}>{c.name} <span style={{fontWeight:400,fontSize:12,color:C.muted}}>({c.relation})</span></div>
                  {c.phone&&<a href={`tel:${c.phone}`} style={{display:"flex",alignItems:"center",gap:4,fontSize:13,color:"#2563eb",textDecoration:"none",marginTop:2}}><Phone size={12}/> {c.phone}</a>}
                  {c.email&&<div style={{fontSize:12,color:C.muted,marginTop:1}}>✉️ {c.email}</div>}
                  {c.address&&<div style={{display:"flex",alignItems:"flex-start",gap:4,fontSize:12,color:C.muted,marginTop:1}}><MapPin size={11} style={{marginTop:2,flexShrink:0}}/>{c.address}</div>}
                </div>
              </div>)}
            </div>);
          })}
        </div>}
    </div>)}
    {del&&<Modal title="Löschen?" onClose={()=>setDel(null)}><p style={{color:C.text,marginTop:0}}>„<strong>{del.name}</strong>" wirklich löschen?</p><div style={{display:"flex",gap:10,justifyContent:"flex-end"}}><Btn onClick={()=>setDel(null)} variant="secondary">Abbrechen</Btn><Btn onClick={()=>{del.type==="player"?onDeletePlayer(del.id):onDeleteCoach(del.id);setDel(null);}} variant="danger"><Trash2 size={14}/> Löschen</Btn></div></Modal>}
    {modal?.type==="pf"&&<Modal title={modal.data?"Spieler bearbeiten":"Neuer Spieler"} onClose={()=>setModal(null)}><PlayerForm player={modal.data} onSave={(p,andAdd)=>{onSavePlayer(p);if(!andAdd)setModal(null);}} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="cf"&&<Modal title={modal.data?"Trainer bearbeiten":"Neuer Trainer"} onClose={()=>setModal(null)}><CoachForm coach={modal.data} onSave={(c,andAdd)=>{onSaveCoach(c);if(!andAdd)setModal(null);}} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="teamBuilder"&&<Modal title="Teams bilden" onClose={()=>setModal(null)} wide><TeamBuilderModal availablePlayers={modal.players||players.filter(p=>p.active)} onSaveTeams={(teams,goToTraining)=>{toast(`${teams.length} Teams erstellt`);setModal(null);if(goToTraining){const ids=(modal.players||players.filter(p=>p.active)).map(p=>p.id);onAddToTraining?.({playerIds:ids,coachIds:[],kids:ids.length,coachCount:1,teams});}}} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="addToSession"&&<Modal title="Zu Training hinzufügen" onClose={()=>setModal(null)} wide><AddToSessionModal playerIds={modal.playerIds} sessions={sessions||[]} players={players} onSaveSession={onSaveSession} onClose={()=>setModal(null)} toast={toast}/></Modal>}
  </div>);
}

// ── TEAM BUILDER ──────────────────────────────────────────────────
function TeamBuilderModal({availablePlayers,onSaveTeams,onClose,onSaveTeamset,actionLabel="Als Training"}) {
  const activeDef=availablePlayers.filter(p=>p.active);
  const defTeams=Math.max(2,Math.round(activeDef.length/3));
  const [numTeams,setNumTeams]=useState(defTeams);
  const [mode,setMode]=useState("balanced");
  const [skillDist,setSkillDist]=useState({strong:0,weak:0});
  const [profiles,setProfiles]=useState(Array.from({length:4},()=>2));
  const [teams,setTeams]=useState([]);
  const [selIds,setSelIds]=useState(activeDef.map(p=>p.id));
  const sel=availablePlayers.filter(p=>selIds.includes(p.id));
  const perTeam=sel.length?Math.round(sel.length/numTeams):3;
  const generate=()=>{const sd=mode==="profile"?{...skillDist,profiles:profiles.slice(0,numTeams)}:skillDist;setTeams(buildTeams(sel,numTeams,mode,sd));};
  const mb=(k,l,d)=><button onClick={()=>setMode(k)} style={{flex:1,minWidth:110,padding:"8px 10px",borderRadius:8,border:`2px solid ${mode===k?C.primary:C.border}`,background:mode===k?C.accentL:"white",cursor:"pointer",textAlign:"left",fontFamily:"inherit"}}><div style={{fontWeight:700,fontSize:13,color:mode===k?C.primary:C.text}}>{l}</div><div style={{fontSize:11,color:C.muted}}>{d}</div></button>;
  return(<div>
    <div style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}><label style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6}}>Spieler ({sel.length})</label><div style={{display:"flex",gap:6}}><Btn sm variant="secondary" onClick={()=>setSelIds(availablePlayers.filter(p=>p.active).map(p=>p.id))}>Alle</Btn><Btn sm variant="secondary" onClick={()=>setSelIds([])}>Keine</Btn></div></div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,padding:10,background:"#f8fafc",borderRadius:8,border:`1.5px solid ${C.border}`}}>
        {availablePlayers.map(p=><button key={p.id} onClick={()=>setSelIds(prev=>prev.includes(p.id)?prev.filter(x=>x!==p.id):[...prev,p.id])} style={{padding:"4px 12px",borderRadius:20,border:`2px solid ${selIds.includes(p.id)?STR[p.strength].color:C.border}`,background:selIds.includes(p.id)?STR[p.strength].light:"white",color:selIds.includes(p.id)?STR[p.strength].color:C.muted,cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:"inherit"}}>{STR[p.strength].emoji} {p.name}</button>)}
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
      <div>
        <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Anzahl Teams</label>
        <Stepper value={numTeams} onChange={setNumTeams} min={2} max={12}/>
        <div style={{fontSize:11,color:C.muted,marginTop:4}}>≈ {perTeam} Spieler/Team</div>
      </div>
      <div>
        <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Modus</label>
        <div style={{display:"flex",flexDirection:"column",gap:5}}>
          {[["balanced","⚖️ Ausgeglichen","Stärken gleichmäßig verteilt"],["profile","📊 Stärkeverteilung","Pro Team Stärke-Profil wählen"],["mixed","🎨 Durchmischt","Alle Level in jedem Team"],["skill","📋 Stärke-Gruppen","Anzahl stark/schwach bestimmen"],["random","🎲 Zufällig","Komplett zufällig"]].map(([k,l,d])=><button key={k} onClick={()=>setMode(k)} style={{padding:"6px 10px",borderRadius:7,border:`2px solid ${mode===k?C.primary:C.border}`,background:mode===k?C.accentL:"white",cursor:"pointer",textAlign:"left",fontFamily:"inherit",display:"flex",gap:8,alignItems:"center"}}><div style={{flex:1}}><span style={{fontWeight:700,fontSize:12,color:mode===k?C.primary:C.text}}>{l}</span><span style={{fontSize:11,color:C.muted,marginLeft:4}}>{d}</span></div></button>)}
        </div>
      </div>
    </div>
    {mode==="profile"&&<ProfileConfig numTeams={numTeams} profiles={profiles} setProfiles={setProfiles}/>}
    {mode==="skill"&&<div style={{background:"#f0f9ff",borderRadius:10,padding:"12px 14px",marginBottom:14,border:"1px solid #bae6fd"}}>
      <div style={{fontSize:12,fontWeight:700,color:"#0369a1",marginBottom:10}}>📊 Stärke-Verteilung ({numTeams} Teams gesamt)</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {[["strong","💪 Starke Teams","#dc2626","#fee2e2"],["mid","➖ Gemischte Teams","#d97706","#fef3c7"],["weak","🌱 Schwache Teams","#16a34a","#dcfce7"]].map(([k,l,col,bg])=>{
          const val=k==="mid"?numTeams-skillDist.strong-skillDist.weak:skillDist[k]||0;
          const setVal=v=>{if(k==="mid")return;const other=k==="strong"?"weak":"strong";const max=numTeams-(skillDist[other]||0);setSkillDist(d=>({...d,[k]:Math.min(Math.max(0,v),max)}));};
          return(<div key={k} style={{textAlign:"center",padding:"8px",borderRadius:8,background:bg,border:`1.5px solid ${col}33`}}>
            <div style={{fontSize:11,fontWeight:700,color:col,marginBottom:6}}>{l}</div>
            {k==="mid"?<div style={{fontWeight:900,fontSize:22,color:col}}>{val}</div>:<Stepper value={val} onChange={setVal} min={0} max={numTeams-1}/>}
          </div>);
        })}
      </div>
      <div style={{fontSize:11,color:C.muted,marginTop:8}}>Starke Teams spielen gegen starke, schwache gegen schwache → fairer Spaß für alle</div>
    </div>}
    <Btn onClick={generate} style={{width:"100%",justifyContent:"center",marginBottom:16}}><Shuffle size={16}/> Teams generieren</Btn>
    {teams.length>0&&(<><Divider/>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10}}>
        {teams.map(t=><div key={t.id} style={{background:C.card,borderRadius:10,border:`2px solid ${C.accent}`,padding:"12px 14px"}}>
          <div style={{fontWeight:800,fontSize:14,color:C.primary,marginBottom:8}}>{t.name}</div>
          {t.players.map(p=><div key={p.id} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 0",borderBottom:`1px solid ${C.border}`}}><span>{STR[p.strength].emoji}</span><span style={{fontSize:13,fontWeight:600,color:C.text}}>{p.name}</span></div>)}
          <div style={{fontSize:11,color:C.muted,marginTop:6}}>Ø {(t.players.reduce((s,p)=>s+p.strength,0)/(t.players.length||1)).toFixed(1)}</div>
        </div>)}
      </div>
      <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16,flexWrap:"wrap"}}>
        <Btn onClick={generate} variant="secondary"><RefreshCw size={14}/> Neu mischen</Btn>
        {onSaveTeamset&&<Btn variant="secondary" onClick={()=>{onSaveTeamset({id:uid(),date:todayISO(),name:`Teams ${new Date().toLocaleDateString("de-DE")}`,teams,createdAt:now()});onSaveTeams(teams,false);}}>💾 Speichern</Btn>}
        <Btn onClick={()=>onSaveTeams(teams,true)}><CalendarDays size={14}/> {actionLabel}</Btn>
      </div>
    </>)}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:12,paddingTop:12,borderTop:`1px solid ${C.border}`}}><Btn onClick={onClose} variant="secondary">Schließen</Btn></div>
  </div>);
}

// ── NOTFALL-PLAN ──────────────────────────────────────────────────
function NotfallModal({exercises,onClose}) {
  const [kids,setKids]=useState(10);
  const [minutes,setMinutes]=useState(10);
  const [mat,setMat]=useState([]);
  const [results,setResults]=useState(null);
  const toggleMat=m=>setMat(prev=>prev.includes(m)?prev.filter(x=>x!==m):[...prev,m]);
  const find=()=>{
    const scored=exercises.filter(ex=>{
      if((ex.duration||10)>minutes+3)return false;
      if(kids<(ex.minPlayers||0))return false;
      if(kids>(ex.maxPlayers||99))return false;
      return true;
    }).map(ex=>{
      let score=0;
      const exMat=ex.material||[];
      if(exMat.length===0)score+=3;
      else{const ok=exMat.filter(m=>mat.includes(m)).length;score+=(ok/exMat.length)*3;}
      score+=Math.max(0,1-(Math.abs((ex.duration||10)-minutes)/(minutes+1)))*2;
      score+=(ex.rating||3)*0.2;
      return{...ex,score};
    }).sort((a,b)=>b.score-a.score).slice(0,3);
    setResults(scored);
  };
  if(results) return(<div>
    <div style={{background:"#fef2f2",borderRadius:10,padding:"10px 14px",marginBottom:14,border:"1px solid #fecaca",fontSize:13,color:"#dc2626",fontWeight:600}}>🚨 Alternativen für {kids} Kinder · {minutes} Min übrig</div>
    {results.length===0?<div style={{textAlign:"center",padding:"30px 0",color:C.muted}}><div style={{fontSize:36,marginBottom:8}}>😕</div><div style={{fontWeight:700,color:C.text}}>Keine passenden Übungen gefunden</div><div style={{fontSize:13,marginTop:4}}>Mehr Material wählen oder Zeit erhöhen</div></div>:
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {results.map((ex,i)=><div key={ex.id} style={{background:C.card,borderRadius:10,border:`2px solid ${i===0?C.accent:C.border}`,padding:"12px 16px"}}>
          {i===0&&<div style={{fontSize:11,fontWeight:800,color:C.primary,marginBottom:6}}>⭐ BESTE OPTION</div>}
          <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:6}}><CatBadge cat={ex.category} small/><span style={{fontSize:12,color:C.muted,marginLeft:"auto"}}>⏱ {ex.duration} Min · 👥 {ex.minPlayers}–{ex.maxPlayers}</span></div>
          <div style={{fontWeight:800,fontSize:15,color:C.text,marginBottom:4}}>{ex.title}</div>
          {ex.description&&<div style={{fontSize:13,color:C.muted,lineHeight:1.5,marginBottom:6}}>{ex.description.slice(0,120)}{ex.description.length>120?"…":""}</div>}
          {ex.material?.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:4}}>{ex.material.map(m=><span key={m} style={{fontSize:11,padding:"2px 8px",borderRadius:10,background:mat.includes(m)?C.accentL:"#f1f5f9",color:mat.includes(m)?C.primary:C.muted,fontWeight:600}}>📦 {m}</span>)}</div>}
        </div>)}
      </div>}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}><Btn onClick={()=>setResults(null)} variant="secondary">Zurück</Btn><Btn onClick={onClose}>Schließen</Btn></div>
  </div>);
  return(<div>
    <div style={{background:"#fef2f2",borderRadius:10,padding:"12px 14px",marginBottom:16,border:"1px solid #fecaca",fontSize:13,color:"#dc2626",fontWeight:700}}>🚨 Übung funktioniert nicht – sofort Alternativen finden</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
      <div><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Kinder am Platz</label><input type="number" min={2} max={20} value={kids} onChange={e=>setKids(Number(e.target.value))} style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:18,fontWeight:800,textAlign:"center",outline:"none",boxSizing:"border-box"}}/></div>
      <div><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Zeit übrig</label><div style={{display:"flex",gap:6}}>{[5,10,15,20].map(m=><button key={m} onClick={()=>setMinutes(m)} style={{flex:1,padding:"9px 4px",borderRadius:8,border:`2px solid ${minutes===m?"#dc2626":C.border}`,background:minutes===m?"#fee2e2":"white",color:minutes===m?"#dc2626":C.muted,cursor:"pointer",fontWeight:800,fontSize:14,fontFamily:"inherit"}}>{m}'</button>)}</div></div>
    </div>
    <div style={{marginBottom:16}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>Verfügbares Material (optional)</label><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{PMAT.map(m=><button key={m} onClick={()=>toggleMat(m)} style={{padding:"4px 12px",borderRadius:20,border:`1.5px solid ${mat.includes(m)?C.primary:C.border}`,background:mat.includes(m)?C.accentL:"white",color:mat.includes(m)?C.primary:C.muted,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit"}}>{m}</button>)}</div></div>
    {exercises.length===0&&<div style={{background:"#fffbeb",borderRadius:8,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#92400e",border:"1px solid #fde68a"}}>⚠️ Noch keine Übungen in der Bibliothek.</div>}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}><Btn onClick={onClose} variant="secondary">Abbrechen</Btn><Btn onClick={find} style={{background:"#dc2626",color:"white"}} disabled={exercises.length===0}><AlertTriangle size={14}/> Alternativen finden</Btn></div>
  </div>);
}


function SessionDetailView({s,players,coaches,exercises,onDelete,onClose,onSaveSession,onReplan,onPrint}) {
  const gP=id=>players.find(p=>p.id===id);
  const gC=id=>coaches.find(c=>c.id===id);
  const gE=id=>exercises.find(e=>e.id===id);
  const pr=(s.playerIds||[]).map(gP).filter(Boolean);
  const tr=(s.coachIds||[]).map(gC).filter(Boolean);
  const ex=(s.exerciseIds||[]).map(gE).filter(Boolean);
  const kids=s.participantCount?Number(s.participantCount):pr.length;
  const [selEx,setSelEx]=useState(null);
  return(<div>
    {/* Header meta */}
    <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
      {s.isDraft&&<span style={{fontSize:12,fontWeight:700,padding:"2px 10px",borderRadius:20,background:"#fef9c3",color:"#854d0e",border:"1px solid #fde047"}}>📋 Entwurf</span>}
      <span style={{fontSize:13,color:C.muted,marginLeft:"auto"}}>{fmtDate(s.date)}</span>
    </div>
    {/* Quick stats */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
      {[["⏱",`${s.duration} Min`,"Dauer"],["👥",`${kids}`,"Kinder"],["🧑‍🏫",`${tr.length||"–"}`,"Trainer"]].map(([icon,val,lbl])=>(
        <div key={lbl} style={{textAlign:"center",padding:"10px 8px",background:"#f8fafc",borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{fontSize:18,marginBottom:2}}>{icon}</div>
          <div style={{fontWeight:900,fontSize:18,color:C.text,lineHeight:1}}>{val}</div>
          <div style={{fontSize:11,color:C.muted,marginTop:2}}>{lbl}</div>
        </div>
      ))}
    </div>
    {/* Location + weather */}
    {(s.location||s.weather)&&<div style={{display:"flex",gap:10,marginBottom:14,fontSize:13,color:C.muted}}>
      {s.location&&<span>📍 {s.location}</span>}
      {s.weather&&<span>🌤 {s.weather}</span>}
    </div>}
    {/* Trainer */}
    {tr.length>0&&<div style={{marginBottom:14}}>
      <div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>Trainer</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>{tr.map(c=><span key={c.id} style={{fontSize:13,padding:"3px 10px",borderRadius:20,background:C.accentL,color:C.primary,fontWeight:700}}>🧑‍🏫 {c.name}</span>)}</div>
    </div>}
    {/* Players */}
    {pr.length>0&&<div style={{marginBottom:14}}>
      <div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>Anwesend ({pr.length})</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{pr.map(p=><span key={p.id} style={{fontSize:12,padding:"3px 10px",borderRadius:20,background:STR[p.strength]?.light||"#f1f5f9",color:STR[p.strength]?.color||C.muted,fontWeight:600}}>{STR[p.strength]?.emoji} {p.name}</span>)}</div>
    </div>}
    {/* Phase Timeline (when plan data available) */}
    {s.planData?.phases?(<div style={{marginBottom:14}}>
      <div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Trainingsplan</div>
      {(()=>{
        const phases=s.planData.phases;
        const breakMin=s.planData.breakMin||0;
        const totalMin=s.planData.totalMin||s.duration;
        const totalKids=s.planData.kids||kids;
        const colMap={ankommen:"#64748b",aufwaermen:"#e65100",koordination:"#6d28d9",technik:"#1a56db",spielform:"#166534",abschluss:"#9d174d"};
        let cursor=0;
        const items=[];
        phases.forEach((ph,i)=>{
          const start=cursor;
          cursor+=ph.minutes;
          items.push({type:"phase",ph,start,end:cursor,i});
          if(i<phases.length-1&&breakMin>0&&!ph.isFree){
            items.push({type:"break",start:cursor,end:cursor+breakMin});
            cursor+=breakMin;
          }
        });
        // Helper: render one exercise's detail fields
        const ExDetail=({ex})=>{
          if(!ex) return null;
          return(<div style={{marginTop:8,padding:"10px 12px",background:"#f8fafc",borderRadius:8,border:`1px solid ${C.border}`}}>
            {ex.imageUrl&&<img src={ex.imageUrl} alt={ex.title} style={{width:"100%",maxHeight:220,objectFit:"contain",borderRadius:6,marginBottom:10,background:"#f1f5f9"}}/>}
            {ex.setup&&<div style={{marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.5,marginBottom:3}}>📐 Aufbau</div>
              <div style={{fontSize:12,lineHeight:1.65,color:C.text}}>{ex.setup}</div>
            </div>}
            {ex.description&&<div style={{marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.5,marginBottom:3}}>🎯 Ablauf</div>
              <div style={{fontSize:12,lineHeight:1.65,color:C.text}}>{ex.description}</div>
            </div>}
            {ex.notes&&<div style={{marginBottom:8,padding:"6px 10px",background:"#fffbeb",borderRadius:6,border:"1px solid #fde68a"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#92400e",textTransform:"uppercase",letterSpacing:.5,marginBottom:3}}>💡 Variationen / Hinweise</div>
              <div style={{fontSize:12,lineHeight:1.65,color:"#78350f"}}>{ex.notes}</div>
            </div>}
            {ex.material?.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:4}}>
              {ex.material.map(m=><span key={m} style={{fontSize:11,padding:"2px 8px",borderRadius:20,background:C.accentL,color:C.primary,fontWeight:600}}>📦 {m}</span>)}
            </div>}
          </div>);
        };
        // Phase card component with expand/collapse
        const PhaseCard=({item})=>{
          const [open,setOpen]=useState(false);
          const ph=item.ph;
          const col=colMap[ph.block?.cat||ph.block?.key]||C.primary;
          const isParallel=!!ph.stations;
          const exEntries=isParallel
            ?ph.stations.map((st,si)=>({ex:st.exercise,label:`Gruppe ${si+1}`,groupKids:Math.floor(totalKids/(ph.stations.length||1))}))
            :[{ex:ph.exercise,label:null,groupKids:totalKids}];
          const hasDetail=exEntries.some(e=>e.ex&&(e.ex.setup||e.ex.description||e.ex.notes||e.ex.imageUrl));
          return(<div style={{marginBottom:6}}>
            <button onClick={()=>hasDetail&&setOpen(o=>!o)} style={{width:"100%",background:"white",borderRadius:8,border:`1.5px solid ${col}33`,padding:"8px 10px",borderLeft:`3px solid ${col}`,cursor:hasDetail?"pointer":"default",fontFamily:"inherit",textAlign:"left",WebkitTapHighlightColor:"transparent"}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:14}}>{ph.block?.emoji}</span>
                <span style={{fontWeight:800,fontSize:13,color:col,flex:1}}>{ph.block?.label}</span>
                <span style={{fontSize:11,color:C.muted,whiteSpace:"nowrap"}}>⏱ {ph.minutes} Min</span>
                <span style={{fontSize:11,color:C.muted,whiteSpace:"nowrap",marginLeft:4}}>{item.start}–{item.end}</span>
                {hasDetail&&<span style={{fontSize:11,color:C.muted,marginLeft:6,transition:"transform .2s",display:"inline-block",transform:open?"rotate(180deg)":"none"}}>▼</span>}
              </div>
              {isParallel&&<div style={{fontSize:11,color:"#7c3aed",marginTop:3}}>🔄 {ph.stations.length} Gruppen · {Math.floor(ph.minutes/ph.stations.length)} Min/Gruppe · {Math.floor(totalKids/(ph.stations.length||1))} Kinder/Gruppe</div>}
              {exEntries.map((e,i)=>e.ex&&<div key={i} style={{fontSize:11,color:C.muted,marginTop:2}}>📍 {isParallel?`G${i+1}: `:""}{e.ex.title}</div>)}
            </button>
            {open&&<div style={{paddingLeft:4,paddingRight:0}}>
              {isParallel?exEntries.map((e,i)=>e.ex&&<div key={i} style={{marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:800,color:"#7c3aed",marginTop:6,marginBottom:2,paddingLeft:4}}>Gruppe {i+1} · {e.groupKids} Kinder · {e.ex.title}</div>
                <ExDetail ex={e.ex}/>
              </div>):<ExDetail ex={exEntries[0]?.ex}/>}
            </div>}
          </div>);
        };
        return(<div>
          {items.map((item,idx)=>{
            if(item.type==="break") return(
              <div key={idx} style={{display:"flex",alignItems:"center",gap:8,padding:"2px 0 6px 6px"}}>
                <div style={{width:2,height:14,background:"#e2e8f0",borderRadius:1,flexShrink:0}}/>
                <span style={{fontSize:11,color:C.muted}}>⏸ {item.end-item.start} Min Pause</span>
              </div>
            );
            return <PhaseCard key={idx} item={item}/>;
          })}
          <div style={{padding:"4px 0 0 6px"}}>
            <span style={{fontSize:11,color:C.muted,fontWeight:700}}>{cursor} Min — Ende</span>
          </div>
        </div>);
      })()}
    </div>):
    /* Exercises (fallback for sessions without planData) */
    ex.length>0&&<div style={{marginBottom:14}}>
      <div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>Übungen ({ex.length})</div>
      {selEx?(<div style={{background:"#f8fafc",borderRadius:10,border:`1.5px solid ${C.border}`,overflow:"hidden",marginBottom:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderBottom:`1px solid ${C.border}`,background:"white"}}>
          <CatBadge cat={selEx.category} small/>
          <span style={{fontWeight:800,fontSize:14,color:C.text,flex:1}}>{selEx.title}</span>
          <button onClick={()=>setSelEx(null)} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,fontSize:18,lineHeight:1}}>✕</button>
        </div>
        <div style={{padding:"12px 14px"}}>
          {selEx.setup&&<div style={{marginBottom:10}}><div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",marginBottom:4}}>📐 Aufbau</div><div style={{fontSize:13,lineHeight:1.6,color:C.text}}>{selEx.setup}</div></div>}
          {selEx.description&&<div style={{marginBottom:10}}><div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",marginBottom:4}}>🎯 Ablauf</div><div style={{fontSize:13,lineHeight:1.6,color:C.text}}>{selEx.description}</div></div>}
          {selEx.material?.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:4}}>{selEx.material.map(m=><span key={m} style={{fontSize:11,padding:"2px 8px",borderRadius:20,background:C.accentL,color:C.primary,fontWeight:600}}>📦 {m}</span>)}</div>}
        </div>
      </div>):(
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          {ex.map(e=><button key={e.id} onClick={()=>setSelEx(e)} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,background:"white",border:`1px solid ${C.border}`,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
            <span style={{fontSize:16}}>{CATS[e.category]?.emoji||"📋"}</span>
            <span style={{fontWeight:700,fontSize:13,color:C.text,flex:1}}>{e.title}</span>
            <span style={{fontSize:11,color:C.muted}}>⏱ {e.duration} Min →</span>
          </button>)}
        </div>
      )}
    </div>}
    {/* Teams */}
    {s.teams?.length>0&&<div style={{marginBottom:14}}>
      <div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>Teams ({s.teams.length})</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{s.teams.map(tm=><div key={tm.id} style={{padding:"8px 12px",borderRadius:8,background:C.accentL,border:`1px solid ${C.accent}`,minWidth:100}}>
        <div style={{fontSize:12,fontWeight:800,color:C.primary,marginBottom:4}}>{tm.name}</div>
        <div style={{fontSize:11,color:C.muted,lineHeight:1.5}}>{tm.players?.map(p=>p.name).join(", ")||"–"}</div>
      </div>)}</div>
    </div>}
    {/* Notes */}
    {s.notes&&<div style={{marginBottom:14,padding:"10px 14px",background:"#fffbeb",borderRadius:8,border:"1px solid #fde68a",fontSize:13,color:C.text,lineHeight:1.6}}>💬 {s.notes}</div>}
    {/* Actions */}
    <div style={{paddingTop:14,borderTop:`1px solid ${C.border}`}}>
      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        {onReplan&&<Btn onClick={onReplan} variant="secondary" style={{flex:1,justifyContent:"center",minWidth:120}}>✏️ Plan bearbeiten</Btn>}
        {onPrint&&<Btn onClick={onPrint} variant="secondary" style={{flex:1,justifyContent:"center",minWidth:100}}>🖨️ PDF erstellen</Btn>}
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end",flexWrap:"wrap"}}>
        <Btn sm variant="danger" onClick={()=>onDelete()}><Trash2 size={13}/> Löschen</Btn>
        <Btn sm onClick={onClose}>Schließen</Btn>
      </div>
    </div>
  </div>);
}


function printSession(s,exercises,toast) {
  // If session has planData (from ManualTrainingPlanner), use full phase-based PDF
  if(s.planData?.phases) {
    const fakePlan={...s.planData};
    const fakeTeams=s.teams||[];
    // Re-hydrate exercises in phases from library
    fakePlan.phases=fakePlan.phases.map(ph=>{
      if(ph.stations){
        const stations=ph.stations.map(st=>({...st,exercise:st.exercise?exercises.find(e=>e.id===st.exercise?.id)||st.exercise:null}));
        return {...ph,stations};
      }
      return {...ph,exercise:ph.exercise?exercises.find(e=>e.id===ph.exercise?.id)||ph.exercise:null};
    });
    // Use same printPlan logic inline
    const esc=t=>String(t||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const bgMap={ankommen:"#f1f5f9",aufwaermen:"#fff3e0",koordination:"#f3e8ff",technik:"#e8f0fe",spielform:"#e8f5e9",abschluss:"#fce4ec"};
    const colMap={ankommen:"#475569",aufwaermen:"#e65100",koordination:"#6d28d9",technik:"#1a56db",spielform:"#166534",abschluss:"#9d174d"};
    const exBlock=(ex)=>{
      if(!ex) return`<p style="color:#9ca3af;font-style:italic;margin:4px 0">Freie Übung</p>`;
      const img=ex.imageUrl?`<img src="${ex.imageUrl}" style="width:100%;height:auto;display:block;background:#f8fafc;border-radius:6px;margin:8px 0;border:1px solid #e5e7eb;box-sizing:content-box" onerror="this.style.display='none'"/>`:"";
      return`${img}${ex.setup?`<div style="background:#f8fafc;border-radius:6px;padding:8px 12px;margin:6px 0;border-left:3px solid #94a3b8"><span style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase">📐 Aufbau</span><br><span style="font-size:13px;line-height:1.6">${esc(ex.setup)}</span></div>`:""}${ex.description?`<div style="margin:6px 0"><span style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase">🎯 Ablauf</span><br><p style="font-size:13px;line-height:1.7;margin:4px 0">${esc(ex.description)}</p></div>`:""}${ex.material?.length?`<div style="font-size:12px;color:#6b7280;margin:4px 0">📦 ${esc(ex.material.join(", "))}</div>`:""}${ex.notes?`<div style="padding:6px 10px;background:#faf5ff;border-radius:6px;font-size:12px;color:#6d28d9;font-style:italic;margin-top:6px">💡 ${esc(ex.notes)}</div>`:""}`;
    };
    // Collect all materials across all phases
    const matCount={};
    fakePlan.phases.forEach(ph=>{
      const exs=ph.stations?ph.stations.map(st=>st.exercise).filter(Boolean):[ph.exercise].filter(Boolean);
      exs.forEach(ex=>(ex.material||[]).forEach(m=>{const k=m.trim().toLowerCase();matCount[k]=(matCount[k]||0)+1;}));
    });
    const matHtml=Object.keys(matCount).length?`<div style="margin-bottom:20px;padding:12px 16px;background:#fefce8;border-radius:10px;border:1.5px solid #fde047"><div style="font-weight:800;font-size:14px;color:#854d0e;margin-bottom:8px">📦 Material (Gesamtliste)</div><div style="display:flex;flex-wrap:wrap;gap:6px">${Object.entries(matCount).sort((a,b)=>b[1]-a[1]).map(([m,c])=>`<span style="padding:3px 10px;border-radius:20px;background:#fef9c3;border:1px solid #fde047;font-size:13px;color:#92400e">${m}${c>1?` (×${c})`:""}</span>`).join("")}</div></div>`:"";
    let cur=0;const tl=[];
    fakePlan.phases.forEach((ph,i)=>{tl.push({label:`${ph.block.emoji} ${esc(ph.block.label)}`,min:ph.minutes,col:colMap[ph.block.cat||ph.block.key]||"#374151"});cur+=ph.minutes;if(i<fakePlan.phases.length-1&&fakePlan.breakMin>0&&!ph.isFree){tl.push({label:"⏸",min:fakePlan.breakMin,col:"#94a3b8"});cur+=fakePlan.breakMin;}});
    const tlHtml=`<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:20px;padding:10px 14px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0">${tl.map(t=>`<span style="padding:3px 10px;border-radius:20px;background:${t.col}18;border:1px solid ${t.col}33;font-size:12px;font-weight:700;color:${t.col}">${t.label} ${t.min}m</span>`).join('<span style="color:#cbd5e1;font-size:12px"> → </span>')}<span style="margin-left:auto;font-size:12px;color:#6b7280">= ${cur} / ${fakePlan.totalMin} Min</span></div>`;
    const rows=fakePlan.phases.map(ph=>{
      const bg=bgMap[ph.block.cat||ph.block.key]||"#f8fafc";const col=colMap[ph.block.cat||ph.block.key]||"#374151";
      const kidsLabel=ph.stations?`${ph.kidsPerStation}/Gruppe · ${ph.kidsTotal} gesamt`:`${ph.kidsTotal} Kinder`;
      let body="";
      if(ph.isFree){body=`<div style="padding:12px 14px"><p style="margin:0 0 6px;font-size:14px">⚽ <strong>Kinder spielen frei</strong></p><p style="margin:0;padding:8px 12px;background:#faf5ff;border-radius:6px;color:#6d28d9;font-size:13px">🧑‍🏫 Trainer: <strong>${ph.minutes} Min</strong> Aufbau der nächsten Station.</p></div>`;}
      else if(ph.stations){
        const rot=Math.floor(ph.minutes/ph.stations.length);const swaps=ph.stations.length-1;
        body=`<div style="padding:8px 14px;background:#faf5ff;border-bottom:1px solid #e9d5ff"><strong style="font-size:13px;color:#7c3aed">🔄 ${ph.stations.length} Stationen parallel</strong><span style="font-size:12px;color:#6d28d9;margin-left:8px">· alle <strong>${rot} Min</strong> wechseln · ${swaps}× · ${ph.minutes} Min gesamt</span></div>`;
        body+=ph.stations.map((st,j)=>`<div style="padding:12px 14px;border-top:1px solid #f1f5f9;page-break-inside:avoid"><div style="font-weight:800;font-size:14px;color:#1d4ed8;margin-bottom:6px">📍 ${esc(st.label)} · ${st.kids} Kinder${st.trainerName?` · 🧑‍🏫 ${esc(st.trainerName)}`:""}</div>${st.exercise?`<div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:6px">⚽ ${esc(st.exercise.title)}</div>`:""}${exBlock(st.exercise)}</div>`).join("");
        body+=`<div style="padding:8px 14px;background:#fef9c3;border-top:1px solid #fde047;font-size:12px;color:#92400e;font-weight:600">⏱ Zeitplan: ${Array.from({length:ph.stations.length},(_,i)=>`${i*rot}–${(i+1)*rot} Min → Gruppe ${i+1}`).join(" → ")}</div>`;
      } else {body=`<div style="padding:12px 14px">${ph.exercise?`<div style="font-weight:800;font-size:15px;color:#111;margin-bottom:8px">${esc(ph.exercise.title)}</div>${exBlock(ph.exercise)}`:`<p style="color:#9ca3af;font-style:italic">Freie Übung</p>`}</div>`;}
      return`<div style="border:1.5px solid #e2e8f0;border-radius:10px;margin-bottom:14px"><div style="background:${bg};padding:10px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px"><span style="font-weight:900;font-size:16px;color:${col}">${ph.block.emoji} ${esc(ph.block.label)}</span><span style="font-size:13px;color:#475569;font-weight:700">⏱ ${ph.minutes} Min &nbsp; 👥 ${kidsLabel}</span></div>${body}</div>`;
    }).join("");
    const teamsHtml2=fakeTeams.length?`<div style="margin-top:20px;border:1.5px solid #e2e8f0;border-radius:10px;overflow:hidden"><div style="background:#f0fdf4;padding:10px 16px;font-weight:800;font-size:14px;color:#166534">👥 Teams</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:12px">${fakeTeams.map(t=>`<div style="border:1.5px solid #e2e8f0;border-radius:8px;padding:10px"><div style="font-weight:800;font-size:13px;color:#1d4ed8;margin-bottom:6px">${esc(t.name)}</div>${(t.players||[]).map(p=>`<div style="font-size:12px;padding:2px 0;border-bottom:1px solid #f1f5f9">${esc(p.name)}</div>`).join("")}</div>`).join("")}</div></div>`:"";
    const css=`${PDF_CSS}`;
    const html=`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Trainingsplan ${esc(s.date)}</title><style>${css}</style></head><body><h1>Trainingsplan</h1><div class="meta">📅 ${esc(s.date)} · ⏱ ${fakePlan.totalMin} Min · 👥 ${fakePlan.kids} Kinder · 🧑‍🏫 ${fakePlan.coaches} Trainer${fakePlan.location?` · 📍 ${esc(fakePlan.location)}`:""}${fakePlan.breakMin>0?` · ⏸ ${fakePlan.breakMin} Min Pausen`:""}</div>${tlHtml}${rows}${teamsHtml2}<div class="footer">Erstellt mit G-Jugend Coach App · ${new Date().toLocaleDateString("de-DE")}</div>${PDF_SCRIPT}</body></html>`;
    const w=window.open("","_blank");
    if(w){w.document.write(html);w.document.close();w.onload=()=>setTimeout(()=>w.print(),300);setTimeout(()=>w.print(),800);}
    else{saveFileSync(html,"Trainingsplan_"+s.date+".html","text/html");toast("Als HTML gespeichert");}
    return;
  }

  // Fallback: simple exercise list (old sessions without planData)
  const esc=t=>String(t||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const ex=(s.exerciseIds||[]).map(id=>exercises.find(e=>e.id===id)).filter(Boolean);
  const bgMap={aufwaermen:"#fff3e0",koordination:"#f3e8ff",technik:"#e8f0fe",spielform:"#e8f5e9",abschluss:"#fce4ec"};
  const colMap={aufwaermen:"#e65100",koordination:"#6d28d9",technik:"#1a56db",spielform:"#166534",abschluss:"#9d174d"};
  const exHtml=ex.map(e=>{
    const bg=bgMap[e.category]||"#f8fafc";const col=colMap[e.category]||"#374151";
    const img=e.imageUrl?`<img src="${e.imageUrl}" style="width:100%;height:auto;display:block;background:#f8fafc;border-radius:6px;margin:8px 0;border:1px solid #e5e7eb;box-sizing:content-box" onerror="this.style.display='none'"/>`:"";
    return`<div style="border:1.5px solid #e2e8f0;border-radius:10px;margin-bottom:14px"><div style="background:${bg};padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="font-size:16px">${esc(CATS[e.category]?.emoji||"📋")}</span><span style="font-weight:800;font-size:15px;color:${col};flex:1">${esc(e.title)}</span>${e.duration?`<span style="font-size:12px;color:#64748b">⏱ ${e.duration} Min</span>`:""}</div><div style="padding:12px 16px">${img}${e.setup?`<div style="background:#f8fafc;border-radius:6px;padding:8px 12px;margin-bottom:8px;border-left:3px solid #94a3b8"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">📐 Aufbau</div><div style="font-size:13px;line-height:1.6">${esc(e.setup)}</div></div>`:""}${e.description?`<div style="margin-bottom:8px"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">🎯 Ablauf</div><div style="font-size:13px;line-height:1.7">${esc(e.description)}</div></div>`:""}${e.material?.length?`<div style="font-size:12px;color:#6b7280;margin-bottom:4px">📦 ${esc(e.material.join(", "))}</div>`:""}${e.notes?`<div style="padding:6px 10px;background:#faf5ff;border-radius:6px;font-size:12px;color:#6d28d9;font-style:italic">💡 ${esc(e.notes)}</div>`:""}</div></div>`;
  }).join("");
  const teamsHtml=(s.teams||[]).length?`<div style="margin-top:20px;border:1.5px solid #e2e8f0;border-radius:10px;page-break-inside:avoid"><div style="background:#f0fdf4;padding:10px 16px;font-weight:800;font-size:14px;color:#166534">👥 Teams</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:12px">${(s.teams||[]).map(t=>`<div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px"><div style="font-weight:800;font-size:13px;color:#1d4ed8;margin-bottom:6px">${esc(t.name)}</div>${(t.players||[]).map(p=>`<div style="font-size:12px;padding:2px 0;border-bottom:1px solid #f1f5f9">${esc(p.name)}</div>`).join("")}</div>`).join("")}</div></div>`:"";
  const css=`${PDF_CSS}`;
  const html=`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Training ${s.date||""}</title><style>${css}</style></head><body><h1>Trainingsplan</h1><div class="meta">📅 ${esc(s.date)} · ⏱ ${s.duration} Min · 👥 ${s.participantCount||"–"} Kinder${s.location?` · 📍 ${esc(s.location)}`:""}</div>${teamsHtml}${ex.length?`<h2 style="font-size:16px;font-weight:800;margin:0 0 12px">📚 Übungen (${ex.length})</h2>${exHtml}`:`<p style="color:#9ca3af">Keine Übungen verknüpft.</p>`}<div class="footer">Erstellt mit G-Jugend Coach App · ${new Date().toLocaleDateString("de-DE")}</div>${PDF_SCRIPT}</body></html>`;
  const w=window.open("","_blank");
  if(w){w.document.write(html);w.document.close();w.onload=()=>setTimeout(()=>w.print(),300);setTimeout(()=>w.print(),800);}
  else{saveFileSync(html,"Training_"+s.date+".html","text/html");toast("Als HTML gespeichert");}
}


function ShareTeamsModal({teamset,onClose,toast}) {
  const lines=[
    `⚽ ${teamset.name||"Teams"}`,
    `📅 ${new Date(teamset.date).toLocaleDateString("de-DE")}`,
    "",
    ...teamset.teams.flatMap((t,i)=>[
      `${["🔴","🔵","🟢","🟡","🟠","🟣","⚪","🟤"][i%8]} *${t.name}* (${t.players?.length||0} Kinder)`,
      ...(t.players||[]).map(p=>`  • ${p.name}`),
      ""
    ])
  ];
  const text=lines.join("\n").trim();

  const copyText=()=>{
    if(navigator.clipboard) navigator.clipboard.writeText(text).then(()=>toast("Text kopiert ✓"));
    else{const ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);toast("Text kopiert ✓");}
  };
  const shareWA=()=>{
    const url="https://wa.me/?text="+encodeURIComponent(text);
    window.open(url,"_blank");
  };
  const printTeams=()=>{
    const css=`body{font-family:-apple-system,sans-serif;padding:24px;max-width:600px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.date{font-size:13px;color:#6b7280;margin-bottom:20px}.teams{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}.team{border:1.5px solid #e2e8f0;border-radius:10px;overflow:hidden}.team-header{padding:8px 14px;font-weight:800;font-size:14px}.player{padding:4px 14px;font-size:13px;border-top:1px solid #f1f5f9}@media print{@page{margin:1cm}}`;
    const teamsHtml=teamset.teams.map((t,i)=>{
      const cols=["#fee2e2","#dbeafe","#dcfce7","#fef9c3","#ffedd5","#f3e8ff","#f1f5f9","#fce7f3"];
      return`<div class="team"><div class="team-header" style="background:${cols[i%cols.length]}">${["🔴","🔵","🟢","🟡","🟠","🟣","⚪","🟤"][i%8]} ${t.name}</div>${(t.players||[]).map(p=>`<div class="player">${p.name}</div>`).join("")}</div>`;
    }).join("");
    const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Teams</title><style>${css}</style></head><body><h1>${teamset.name||"Teams"}</h1><div class="date">📅 ${new Date(teamset.date).toLocaleDateString("de-DE")} · ${teamset.teams.length} Teams · ${teamset.teams.reduce((s,t)=>s+(t.players?.length||0),0)} Kinder</div><div class="teams">${teamsHtml}</div>${PDF_SCRIPT}</body></html>`;
    const w=window.open("","_blank");
    if(w){w.document.write(html);w.document.close();setTimeout(()=>w.print(),400);}
    else{saveFileSync(html,"teams.html","text/html");toast("Als HTML gespeichert");}
  };

  return(<div>
    <div style={{background:"#f8fafc",borderRadius:10,padding:"14px 16px",marginBottom:16,border:`1px solid ${C.border}`,fontFamily:"monospace",fontSize:13,lineHeight:1.7,whiteSpace:"pre-wrap",maxHeight:300,overflowY:"auto"}}>{text}</div>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
      <Btn sm variant="secondary" onClick={onClose}>Schließen</Btn>
      <Btn sm variant="secondary" onClick={copyText}>📋 Kopieren</Btn>
      <Btn sm variant="secondary" onClick={printTeams}>🖨️ PDF</Btn>
      <Btn sm onClick={shareWA}>💬 WhatsApp</Btn>
    </div>
  </div>);
}



// ── TEAMPLANER PAGE ───────────────────────────────────────────────
const TEAM_COLORS = [
  {bg:"#fee2e2",border:"#fca5a5",text:"#991b1b",emoji:"🔴"},
  {bg:"#dbeafe",border:"#93c5fd",text:"#1e40af",emoji:"🔵"},
  {bg:"#dcfce7",border:"#86efac",text:"#166534",emoji:"🟢"},
  {bg:"#fef9c3",border:"#fde047",text:"#854d0e",emoji:"🟡"},
  {bg:"#ffedd5",border:"#fdba74",text:"#9a3412",emoji:"🟠"},
  {bg:"#f3e8ff",border:"#c4b5fd",text:"#6b21a8",emoji:"🟣"},
  {bg:"#f1f5f9",border:"#cbd5e1",text:"#334155",emoji:"⚪"},
  {bg:"#fce7f3",border:"#f9a8d4",text:"#9d174d",emoji:"🩷"},
];

function TeamDetailView({ts,onEdit,onClose,toast}) {
  return(<div>
    <div style={{marginBottom:16}}>
      <div style={{fontSize:13,color:C.muted}}>📅 {ts.date?new Date(ts.date+"T12:00").toLocaleDateString("de-DE",{weekday:"long",day:"numeric",month:"long",year:"numeric"}):""}</div>
      <div style={{fontSize:12,color:C.muted,marginTop:2}}>{ts.teams.length} Teams · {ts.teams.reduce((s,t)=>s+(t.players?.length||0),0)} Kinder</div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10,marginBottom:20}}>
      {ts.teams.map((team,i)=>{
        const col=TEAM_COLORS[i%TEAM_COLORS.length];
        const avg=(team.players||[]).reduce((s,p)=>s+(p.strength||1),0)/((team.players||[]).length||1);
        return(<div key={team.id} style={{borderRadius:10,border:`2px solid ${col.border}`,overflow:"hidden"}}>
          <div style={{background:col.bg,padding:"10px 12px",display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:16}}>{col.emoji}</span>
            <span style={{fontWeight:900,fontSize:14,color:col.text,flex:1}}>{team.name}</span>
            <span style={{fontSize:11,color:col.text,opacity:.7}}>{team.players?.length||0}✕</span>
          </div>
          {(team.players||[]).map(p=><div key={p.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",borderBottom:`1px solid ${col.border}33`}}>
            <span style={{fontSize:14}}>{STR[p.strength||1].emoji}</span>
            <span style={{fontSize:13,fontWeight:600,color:C.text}}>{p.name}</span>
          </div>)}
          <div style={{padding:"6px 12px",background:col.bg+"88",fontSize:11,color:col.text}}>Ø Stärke {avg.toFixed(1)}</div>
        </div>);
      })}
    </div>
    <div style={{display:"flex",gap:8,justifyContent:"flex-end",paddingTop:12,borderTop:`1px solid ${C.border}`}}>
      <Btn variant="secondary" onClick={onClose}>Schließen</Btn>
      <Btn variant="secondary" onClick={()=>setModal({type:"share",ts})} >📤 Teilen</Btn>
      <Btn onClick={onEdit}><Edit2 size={14}/> Bearbeiten</Btn>
    </div>
  </div>);
}

function TeamplanerPage({players,teamsets,onSaveTeamset,onDeleteTeamset,toast,readOnly=false,showStrength=true,onlineUsers,currentUser,onGoHome,onGoBack}) {
  const [view,setView]=useState("list");
  const [editTs,setEditTs]=useState(null);
  const [detailTs,setDetailTs]=useState(null);
  const [modal,setModal]=useState(null);

  const activePlayers=players.filter(p=>p.active);
  const sorted=[...(teamsets||[])].sort((a,b)=>(b.date||"").localeCompare(a.date||""));

  const openNew=()=>{setEditTs({id:uid(),date:todayISO(),name:"",teams:[],isNew:true});setView("edit");};
  const openEdit=(ts)=>{setEditTs(JSON.parse(JSON.stringify(ts)));setView("edit");setDetailTs(null);};
  const save=(ts)=>{const t={...ts};delete t.isNew;onSaveTeamset(t);toast("Aufstellung gespeichert");setView("list");};

  if(view==="edit"&&editTs) return <TeamEditor ts={editTs} setTs={setEditTs} allPlayers={activePlayers} onSave={save} onCancel={()=>setView("list")}/>;

  if(detailTs) {
    // Refresh from latest teamsets in case it was edited
    const latest=teamsets.find(t=>t.id===detailTs.id)||detailTs;
    return(<div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={()=>setDetailTs(null)} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${C.border}`,background:"white",cursor:"pointer",fontFamily:"inherit",fontSize:13,color:C.muted}}>← Zurück</button>
        <h1 style={{margin:0,fontSize:20,fontWeight:900,color:C.text,flex:1}}>{latest.name||"Aufstellung"}</h1>
      </div>
      <div style={{marginBottom:16}}>
        <div style={{fontSize:13,color:C.muted}}>📅 {latest.date?new Date(latest.date+"T12:00").toLocaleDateString("de-DE",{weekday:"long",day:"numeric",month:"long",year:"numeric"}):""}</div>
        <div style={{fontSize:12,color:C.muted,marginTop:2}}>{latest.teams.length} Teams · {latest.teams.reduce((s,t)=>s+(t.players?.length||0),0)} Kinder</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(148px,1fr))",gap:10,marginBottom:20}}>
        {latest.teams.map((team,i)=>{
          const col=TEAM_COLORS[i%TEAM_COLORS.length];
          const avg=(team.players||[]).reduce((s,p)=>s+(p.strength||1),0)/((team.players||[]).length||1);
          return(<div key={team.id} style={{borderRadius:10,border:`2px solid ${col.border}`,overflow:"hidden"}}>
            <div style={{background:col.bg,padding:"10px 12px",display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:16}}>{col.emoji}</span>
              <span style={{fontWeight:900,fontSize:14,color:col.text,flex:1}}>{team.name}</span>
              <span style={{fontSize:11,color:col.text,opacity:.7}}>{team.players?.length||0} Kinder</span>
            </div>
            {(team.players||[]).map(p=><div key={p.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderBottom:`1px solid ${col.border}33`}}>
              <span style={{fontSize:15}}>{STR[p.strength||1].emoji}</span>
              <span style={{fontSize:14,fontWeight:600,color:C.text}}>{p.name}</span>
            </div>)}
            <div style={{padding:"6px 12px",background:col.bg+"88",fontSize:11,color:col.text,fontWeight:700}}>Ø Stärke {avg.toFixed(1)}</div>
          </div>);
        })}
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end",paddingTop:12,borderTop:`1px solid ${C.border}`,flexWrap:"wrap"}}>
        <Btn variant="secondary" onClick={()=>setModal({type:"share",ts:latest})}>📤 Teilen</Btn>
        <Btn onClick={()=>openEdit(latest)}><Edit2 size={14}/> Bearbeiten</Btn>
      </div>
      {modal?.type==="share"&&<Modal title="Teams teilen" onClose={()=>setModal(null)} wide><ShareTeamsModal teamset={modal.ts} onClose={()=>setModal(null)} toast={toast}/></Modal>}
    </div>);
  }

  return(<div>
    <PageHeader title="Teams" sub={`${sorted.length} gespeicherte Aufstellungen`} onlineUsers={onlineUsers} currentUser={currentUser} onGoHome={onGoHome} onGoBack={onGoBack}/>
    {!readOnly&&onSaveTeamset&&<div style={{marginBottom:16}}><Btn onClick={openNew}><Plus size={15}/> Neue Aufstellung</Btn></div>}

    {sorted.length===0&&<div style={{textAlign:"center",padding:"60px 20px",color:C.muted}}>
      <div style={{fontSize:40,marginBottom:12}}>👥</div>
      <div style={{fontWeight:700,marginBottom:6}}>Noch keine Aufstellungen</div>
      <div style={{fontSize:13,marginBottom:16}}>Erstelle deine erste Team-Aufstellung</div>
      <Btn onClick={openNew}><Plus size={14}/> Erste Aufstellung</Btn>
    </div>}

    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {sorted.map(ts=>{
        const total=ts.teams.reduce((s,t)=>s+(t.players?.length||0),0);
        return(<div key={ts.id} onClick={()=>setDetailTs(ts)} style={{background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,padding:"14px 16px",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.08)"} onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>
          <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
            <div style={{flex:1}}>
              <div style={{fontWeight:800,fontSize:15,color:C.text}}>{ts.name||"Aufstellung"}</div>
              <div style={{fontSize:12,color:C.muted,marginTop:2}}>📅 {ts.date?new Date(ts.date+"T12:00").toLocaleDateString("de-DE"):""} · {ts.teams.length} Teams · {total} Kinder</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:8}}>
                {ts.teams.map((t,i)=>{const col=TEAM_COLORS[i%TEAM_COLORS.length];return(
                  <span key={t.id} style={{fontSize:11,padding:"2px 8px",borderRadius:20,background:col.bg,border:`1px solid ${col.border}`,color:col.text,fontWeight:700}}>
                    {col.emoji} {t.name} ({t.players?.length||0})
                  </span>
                );})}
              </div>
            </div>
            <div style={{display:"flex",gap:6,flexShrink:0}} onClick={e=>e.stopPropagation()}>
              <button onClick={()=>openEdit(ts)} style={{padding:"8px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:"white",cursor:"pointer",color:C.muted,display:"flex",alignItems:"center",gap:4,fontSize:12,fontWeight:700,fontFamily:"inherit"}}><Edit2 size={14}/></button>
              <button onClick={()=>onDeleteTeamset(ts.id)} style={{padding:"8px 10px",borderRadius:8,border:"1px solid #fca5a5",background:"#fff5f5",cursor:"pointer",color:"#ef4444"}}><Trash2 size={14}/></button>
            </div>
          </div>
        </div>);
      })}
    </div>
    {modal?.type==="share"&&<Modal title="Teams teilen" onClose={()=>setModal(null)} wide><ShareTeamsModal teamset={modal.ts} onClose={()=>setModal(null)} toast={toast}/></Modal>}
  </div>);
}

function PlayerPicker({allPlayers,selIds,setSelIds}) {
  const [sortMode,setSortMode]=useState("alpha");
  const sel=allPlayers.filter(p=>selIds.includes(p.id));
  const sorted=[...allPlayers].sort((a,b)=>sortMode==="alpha"
    ?a.name.localeCompare(b.name,"de")
    :(b.strength||1)-(a.strength||1)||a.name.localeCompare(b.name,"de"));
  return(<div style={{marginBottom:14}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
      <label style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6}}>Spieler ({sel.length}/{allPlayers.length})</label>
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        <div style={{display:"flex",background:"#f1f5f9",borderRadius:8,padding:2,gap:2}}>
          <button onClick={()=>setSortMode("alpha")} style={{padding:"3px 10px",borderRadius:6,border:"none",background:sortMode==="alpha"?C.primary:"transparent",color:sortMode==="alpha"?"white":C.muted,cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>A–Z</button>
          <button onClick={()=>setSortMode("strength")} style={{padding:"3px 10px",borderRadius:6,border:"none",background:sortMode==="strength"?C.primary:"transparent",color:sortMode==="strength"?"white":C.muted,cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>Stärke</button>
        </div>
        <Btn sm variant="secondary" onClick={()=>setSelIds(allPlayers.map(p=>p.id))}>Alle</Btn>
        <Btn sm variant="secondary" onClick={()=>setSelIds([])}>Keine</Btn>
      </div>
    </div>
    <div style={{background:"#f8fafc",borderRadius:10,border:`1.5px solid ${C.border}`,overflow:"hidden"}}>
      {sorted.map((p,idx)=>{
        const isSel=selIds.includes(p.id);
        const str=STR[p.strength||1];
        return(<div key={p.id} onClick={()=>setSelIds(prev=>prev.includes(p.id)?prev.filter(x=>x!==p.id):[...prev,p.id])}
          style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderBottom:idx<sorted.length-1?`1px solid ${C.border}`:"none",cursor:"pointer",background:isSel?"white":"#f8fafc",transition:"background .1s"}}>
          <div style={{width:20,height:20,borderRadius:5,border:`2px solid ${isSel?C.primary:C.border}`,background:isSel?C.primary:"white",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            {isSel&&<span style={{color:"white",fontSize:13,lineHeight:1}}>✓</span>}
          </div>
          <span style={{fontSize:16}}>{str.emoji}</span>
          <span style={{fontSize:14,fontWeight:isSel?700:500,color:isSel?C.text:C.muted,flex:1}}>{p.name}</span>
          <span style={{fontSize:11,padding:"2px 8px",borderRadius:20,background:str.light,color:str.color,fontWeight:700}}>{str.label}</span>
        </div>);
      })}
    </div>
  </div>);
}

function ProfileConfig({numTeams,profiles,setProfiles}) {
  const PLEVELS=[
    {v:4,label:"💪 Sehr stark",color:"#dc2626",bg:"#fee2e2"},
    {v:3,label:"⭐ Stark",     color:"#d97706",bg:"#fef3c7"},
    {v:2,label:"➡️ Mittel",    color:"#2563eb",bg:"#eff6ff"},
    {v:1,label:"🌱 Schwach",   color:"#16a34a",bg:"#dcfce7"},
  ];
  // Ensure profiles array has correct length
  const profs=Array.from({length:numTeams},(_,i)=>profiles[i]??2);
  const setProf=(i,v)=>{const p=[...profs];p[i]=v;setProfiles(p);};
  return(<div style={{marginBottom:14}}>
    <div style={{fontSize:11,color:C.muted,marginBottom:8}}>Wähle für jedes Team das gewünschte Stärke-Profil. Der Algorithmus verteilt Spieler entsprechend.</div>
    <div style={{display:"flex",flexDirection:"column",gap:6}}>
      {profs.map((pv,i)=>{
        const cur=PLEVELS.find(l=>l.v===pv)||PLEVELS[2];
        return(<div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:13,fontWeight:700,color:C.muted,minWidth:52}}>Team {i+1}</span>
          <div style={{display:"flex",gap:4,flex:1,flexWrap:"wrap"}}>
            {PLEVELS.map(pl=><button key={pl.v} onClick={()=>setProf(i,pl.v)}
              style={{flex:1,minWidth:60,padding:"5px 6px",borderRadius:8,border:`2px solid ${pv===pl.v?pl.color:C.border}`,background:pv===pl.v?pl.bg:"white",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,color:pv===pl.v?pl.color:C.muted,textAlign:"center"}}>
              {pl.label}
            </button>)}
          </div>
        </div>);
      })}
    </div>
    <div style={{marginTop:8,padding:"6px 10px",borderRadius:8,background:"#f8fafc",border:`1px solid ${C.border}`,fontSize:11,color:C.muted}}>
      Verteilung: {["💪","⭐","➡️","🌱"].map((e,j)=>{const cnt=profs.filter(p=>p===4-j).length;return cnt>0?`${e}×${cnt}`:null;}).filter(Boolean).join("  ·  ")}
    </div>
  </div>);
}

function TeamQuickAdd({allPlayers,team,allTeams,col,onAdd}) {
  const notInThisTeam=allPlayers.filter(p=>!(team.players||[]).some(tp=>tp.id===p.id));
  if(notInThisTeam.length===0) return null;
  const inOtherTeam=id=>allTeams.some(t=>t.id!==team.id&&(t.players||[]).some(p=>p.id===id));
  return(<div style={{padding:"4px 8px",borderTop:`1px solid ${col.border}33`}}>
    <select onChange={e=>{if(e.target.value){onAdd(e.target.value);e.target.value=""}}} style={{width:"100%",fontSize:11,padding:"3px 4px",border:`1px solid ${col.border}`,borderRadius:6,background:"white",fontFamily:"inherit",color:C.text,cursor:"pointer"}}>
      <option value="">+ Spieler hinzufügen</option>
      {notInThisTeam.map(p=><option key={p.id} value={p.id}>{STR[p.strength||1].emoji} {p.name}{inOtherTeam(p.id)?" (anderes Team)":""}</option>)}
    </select>
  </div>);
}

function TeamEditor({ts,setTs,allPlayers,onSave,onCancel}) {
  const [genMode,setGenMode]=useState("balanced");
  const [numTeams,setNumTeams]=useState(ts.teams.length||Math.max(2,Math.round(allPlayers.length/3)));
  const [selIds,setSelIds]=useState(()=>{
    // Always include all active players so unassigned ones can be added
    return allPlayers.map(p=>p.id);
  });
  const [dragInfo,setDragInfo]=useState(null); // {playerId, fromTeamId}
  const [skillDist,setSkillDist]=useState({strong:0,weak:0});
  const [profiles,setProfiles]=useState(Array.from({length:4},()=>2)); // default: alle Mittel
  const [tab,setTab]=useState(ts.teams.length>0?"manual":"generate"); // generate | manual

  const sel=allPlayers.filter(p=>selIds.includes(p.id));

  // All player IDs currently assigned to any team
  const assignedIds=ts.teams.flatMap(t=>t.players?.map(p=>p.id)||[]);
  // Unassigned selected players
  const unassigned=sel.filter(p=>!assignedIds.includes(p.id));

  const generate=()=>{
    const sd=genMode==="profile"?{...skillDist,profiles:profiles.slice(0,numTeams)}:skillDist;
    const teams=buildTeams(sel,numTeams,genMode,sd);
    setTs(prev=>({...prev,teams}));
    setTab("manual");
  };

  const movePlayer=(playerId, toTeamId)=>{
    setTs(prev=>{
      const teams=prev.teams.map(t=>({...t,players:[...(t.players||[])]}));
      // Remove from current team
      teams.forEach(t=>{t.players=t.players.filter(p=>p.id!==playerId);});
      if(toTeamId==="unassigned") return {...prev,teams};
      const player=allPlayers.find(p=>p.id===playerId);
      if(!player) return prev;
      const target=teams.find(t=>t.id===toTeamId);
      if(target) target.players.push(player);
      return {...prev,teams};
    });
  };

  const addTeam=()=>{
    const i=ts.teams.length;
    setTs(prev=>({...prev,teams:[...prev.teams,{id:uid(),name:`Team ${i+1}`,players:[]}]}));
  };

  const removeTeam=(teamId)=>{
    setTs(prev=>{
      const team=prev.teams.find(t=>t.id===teamId);
      // Players go back to unassigned (they stay in selIds)
      return {...prev,teams:prev.teams.filter(t=>t.id!==teamId)};
    });
  };

  const renameTeam=(teamId,name)=>{
    setTs(prev=>({...prev,teams:prev.teams.map(t=>t.id===teamId?{...t,name}:t)}));
  };

  const tb=(k,l)=><button onClick={()=>setTab(k)} style={{padding:"7px 16px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit",background:tab===k?C.primary:"transparent",color:tab===k?"white":C.muted}}>{l}</button>;

  return(<div>
    {/* Header */}
    <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
      <input value={ts.name} onChange={e=>setTs(p=>({...p,name:e.target.value}))} placeholder="Titel der Aufstellung..." style={{flex:1,minWidth:160,padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:15,fontWeight:700,fontFamily:"inherit",outline:"none"}}/>
      <input type="date" value={ts.date} onChange={e=>setTs(p=>({...p,date:e.target.value}))} style={{padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,fontFamily:"inherit",outline:"none"}}/>
    </div>

    {/* Tabs: Generate vs Manual */}
    <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:10,padding:4,marginBottom:16,width:"fit-content"}}>
      {tb("generate","🎲 Generieren")}
      {tb("manual","✋ Manuell")}
    </div>

    {tab==="generate"&&<div>
      <PlayerPicker allPlayers={allPlayers} selIds={selIds} setSelIds={setSelIds}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div>
          <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Anzahl Teams</label>
          <Stepper value={numTeams} onChange={setNumTeams} min={2} max={8}/>
          <div style={{fontSize:11,color:C.muted,marginTop:4}}>≈ {sel.length?Math.round(sel.length/numTeams):"-"} Spieler/Team</div>
        </div>
        <div>
          <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Modus</label>
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            {[["balanced","⚖️ Ausgeglichen","Stärken gleichmäßig verteilt"],["profile","📊 Stärkeverteilung","Pro Team Stärke-Profil wählen"],["mixed","🎨 Durchmischt","Alle Level in jedem Team"],["random","🎲 Zufällig","Komplett zufällig"]].map(([k,l,d])=><button key={k} onClick={()=>setGenMode(k)} style={{padding:"6px 10px",borderRadius:7,border:`2px solid ${genMode===k?C.primary:C.border}`,background:genMode===k?C.accentL:"white",cursor:"pointer",textAlign:"left",fontFamily:"inherit"}}><span style={{fontWeight:700,fontSize:12,color:genMode===k?C.primary:C.text}}>{l}</span><span style={{fontSize:11,color:C.muted,marginLeft:4}}>{d}</span></button>)}
          </div>
        </div>
      </div>
      {genMode==="profile"&&<ProfileConfig numTeams={numTeams} profiles={profiles} setProfiles={setProfiles}/>}
      <Btn onClick={generate} style={{width:"100%",justifyContent:"center"}}><Shuffle size={15}/> Teams generieren</Btn>
    </div>}

    {tab==="manual"&&<div>
      {ts.teams.length===0&&<div style={{textAlign:"center",padding:"30px 0",color:C.muted}}>
        <div style={{marginBottom:10}}>Noch keine Teams — generiere welche oder füge manuell hinzu</div>
        <div style={{display:"flex",gap:8,justifyContent:"center"}}><Btn onClick={()=>setTab("generate")} variant="secondary"><Shuffle size={14}/> Generieren</Btn><Btn onClick={addTeam}><Plus size={14}/> Team hinzufügen</Btn></div>
      </div>}

      {ts.teams.length>0&&<div>
        {/* Unassigned players pool */}
        {unassigned.length>0&&<div style={{marginBottom:14,padding:"10px 12px",background:"#fffbeb",borderRadius:10,border:"1.5px solid #fde68a"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#92400e",marginBottom:8}}>⚠️ Nicht zugewiesen ({unassigned.length})</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
            {unassigned.map(p=><div key={p.id} style={{position:"relative"}}>
              <span style={{fontSize:12,padding:"3px 10px",borderRadius:20,background:"#fef3c7",border:"1.5px solid #fde68a",color:"#92400e",fontWeight:700,display:"block"}}>{STR[p.strength||1].emoji} {p.name}</span>
              {/* Assign to team buttons */}
              <div style={{display:"flex",gap:3,marginTop:3,flexWrap:"wrap"}}>
                {ts.teams.map((t,i)=>{const col=TEAM_COLORS[i%TEAM_COLORS.length];return(
                  <button key={t.id} onClick={()=>movePlayer(p.id,t.id)} style={{fontSize:10,padding:"2px 6px",borderRadius:12,border:`1px solid ${col.border}`,background:col.bg,color:col.text,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>→ {t.name}</button>
                );})}
              </div>
            </div>)}
          </div>
        </div>}

        {/* Team columns */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:12}}>
          {ts.teams.map((team,i)=>{
            const col=TEAM_COLORS[i%TEAM_COLORS.length];
            return(<div key={team.id} style={{borderRadius:10,border:`2px solid ${col.border}`,overflow:"hidden"}}>
              <div style={{background:col.bg,padding:"8px 10px",display:"flex",alignItems:"center",gap:6}}>
                <span>{col.emoji}</span>
                <input value={team.name} onChange={e=>renameTeam(team.id,e.target.value)} style={{flex:1,border:"none",background:"transparent",fontWeight:800,fontSize:13,color:col.text,fontFamily:"inherit",outline:"none",minWidth:0}}/>
                <button onClick={()=>removeTeam(team.id)} style={{border:"none",background:"transparent",cursor:"pointer",color:col.text,opacity:.6,padding:0,lineHeight:1}}>✕</button>
              </div>
              <div style={{padding:"6px 8px",minHeight:60}}>
                {(team.players||[]).map(p=><div key={p.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"3px 0",borderBottom:`1px solid ${col.border}33`}}>
                  <span style={{fontSize:12,fontWeight:600,color:C.text}}>{STR[p.strength||1].emoji} {p.name}</span>
                  {/* Move to other team or unassign */}
                  <div style={{display:"flex",gap:2}}>
                    {ts.teams.filter(t=>t.id!==team.id).map((t,j)=>{const c2=TEAM_COLORS[ts.teams.indexOf(t)%TEAM_COLORS.length];return(
                      <button key={t.id} title={`→ ${t.name}`} onClick={()=>movePlayer(p.id,t.id)} style={{minWidth:28,height:28,borderRadius:8,border:`1.5px solid ${c2.border}`,background:c2.bg,cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",color:c2.text,fontWeight:900,padding:"0 6px"}}>→{c2.emoji}</button>
                    );})}
                    <button title="Entfernen" onClick={()=>movePlayer(p.id,"unassigned")} style={{width:28,height:28,borderRadius:8,border:"1px solid #fca5a5",background:"#fff5f5",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",color:"#ef4444"}}>✕</button>
                  </div>
                </div>)}
                {/* Add unassigned player to this team */}
                {unassigned.length===0&&(team.players||[]).length===0&&<div style={{fontSize:11,color:C.muted,textAlign:"center",padding:"8px 0"}}>Leer</div>}
              </div>
              {/* Quick-add: show all players not in THIS team */}
              <TeamQuickAdd allPlayers={allPlayers} team={team} allTeams={ts.teams} col={col} onAdd={id=>movePlayer(id,team.id)}/>
            </div>);
          })}
        </div>
        <Btn variant="secondary" onClick={addTeam} style={{width:"100%",justifyContent:"center"}}><Plus size={14}/> Team hinzufügen</Btn>
      </div>}
    </div>}

    {/* Actions */}
    <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:20,paddingTop:14,borderTop:`1px solid ${C.border}`,flexWrap:"wrap"}}>
      <Btn variant="secondary" onClick={onCancel}>Abbrechen</Btn>
      {ts.teams.length>0&&<Btn onClick={()=>onSave({...ts,name:ts.name||`Teams ${new Date(ts.date+"T12:00").toLocaleDateString("de-DE")}`})}><CheckSquare size={14}/> Speichern</Btn>}
    </div>
  </div>);
}

// ── ORGA PAGE ─────────────────────────────────────────────────────
// ── ORGA PAGE ─────────────────────────────────────────────────────
function OrgaPage({todos,onSaveTodo,onDeleteTodo,coaches,currentUser,toast,showUndo,readOnly,onlineUsers,pendingTarget,onClearPendingTarget,onGoHome,onGoBack}) {
  const openCount=(todos||[]).filter(t=>!t.done).length;
  return(<div>
    <PageHeader title="To Dos" sub={`${openCount} offen`} onlineUsers={onlineUsers} currentUser={currentUser} onGoHome={onGoHome} onGoBack={onGoBack}/>
    <TodosTab todos={todos||[]} onSave={onSaveTodo} onDelete={onDeleteTodo} coaches={coaches} currentUser={currentUser} toast={toast} showUndo={showUndo} readOnly={readOnly} initialOpenId={pendingTarget?.tab==="todos"?pendingTarget.id:null} onConsumeInitialOpen={onClearPendingTarget}/>
  </div>);
}

// ─── TODO TAB ────────────────────────────────────────────────────
function TodosTab({todos,onSave,onDelete,coaches,currentUser,toast,showUndo,readOnly,initialOpenId,onConsumeInitialOpen}) {
  const [quickText,setQuickText]=useState("");
  const [modal,setModal]=useState(null);
  const [filter,setFilter]=useState("open");
  const todayStr=()=>new Date().toISOString().slice(0,10);
  const isOverdue=t=>!t.done&&t.due&&t.due<todayStr();
  const isDueToday=t=>!t.done&&t.due&&t.due===todayStr();

  useEffect(()=>{
    if(!initialOpenId)return;
    const t=todos.find(x=>x.id===initialOpenId);
    if(t){setModal({data:t});setFilter("all");}
    onConsumeInitialOpen?.();
  },[initialOpenId]); // eslint-disable-line

  const addQuick=()=>{
    if(!quickText.trim())return;
    const t={id:uid(),task:quickText.trim(),owner:null,due:null,done:false,doneAt:null,createdAt:now(),createdBy:currentUser?.uid||null,createdByName:currentUser?.displayName||currentUser?.email||null,updatedAt:now()};
    onSave(t);setQuickText("");toast("Task erstellt");
  };
  const toggle=t=>onSave({...t,done:!t.done,doneAt:!t.done?now():null,updatedAt:now()});
  const del=t=>{onDelete(t.id);showUndo&&showUndo("Task",t,()=>onSave(t));};

  const sorted=[...todos].sort((a,b)=>{
    if(a.done!==b.done)return a.done?1:-1;
    if(a.due&&b.due)return a.due.localeCompare(b.due);
    if(a.due)return -1;if(b.due)return 1;return 0;
  });
  const filtered=sorted.filter(t=>filter==="all"?true:filter==="done"?t.done:!t.done);

  return(<div>
    {/* Quick-add */}
    {!readOnly&&<div style={{display:"flex",gap:8,marginBottom:12}}>
      <input value={quickText} onChange={e=>setQuickText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addQuick()} placeholder="Schnell-Task eingeben + Enter..." style={{flex:1,padding:"10px 14px",border:`1.5px solid ${C.border}`,borderRadius:10,fontSize:14,fontFamily:"inherit",outline:"none",background:C.card,color:C.text}}/>
      <button onClick={addQuick} style={{padding:"10px 14px",borderRadius:10,border:"none",background:C.primary,color:"white",fontWeight:700,cursor:"pointer",fontFamily:"inherit",fontSize:18}}>+</button>
      <button onClick={()=>setModal({data:null})} style={{padding:"10px 14px",borderRadius:10,border:`1.5px solid ${C.border}`,background:"white",color:C.text,cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700}} title="Mit Details anlegen">⋯</button>
    </div>}
    {/* Filter */}
    <div style={{display:"flex",gap:6,marginBottom:14}}>
      {[["open","Offen"],["done","Erledigt"],["all","Alle"]].map(([k,l])=>(
        <button key={k} onClick={()=>setFilter(k)} style={{padding:"5px 12px",borderRadius:20,border:`1.5px solid ${filter===k?C.primary:C.border}`,background:filter===k?C.accentL:"white",color:filter===k?C.primary:C.muted,cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:13}}>{l}</button>
      ))}
    </div>
    {/* List */}
    {filtered.length===0&&<div style={{textAlign:"center",padding:"36px 0",color:C.muted}}><div style={{fontSize:32,marginBottom:8}}>{filter==="done"?"🎉":"📭"}</div><div style={{fontWeight:700}}>{filter==="done"?"Noch nichts erledigt":"Keine offenen Tasks"}</div></div>}
    {filtered.map(t=>(
      <div key={t.id} onClick={()=>!readOnly&&setModal({data:t})} style={{background:C.card,borderRadius:10,border:`1.5px solid ${isOverdue(t)?"#fca5a5":isDueToday(t)?"#fcd34d":t.done?"#d1fae5":C.border}`,marginBottom:6,overflow:"hidden",cursor:readOnly?"default":"pointer",opacity:t.done?.78:1}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px"}}>
          <button onClick={e=>{e.stopPropagation();if(!readOnly)toggle(t);}} style={{width:26,height:26,borderRadius:8,border:`2px solid ${t.done?C.primary:C.border}`,background:t.done?C.primary:"white",cursor:readOnly?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"white",fontSize:14,transition:"all .15s"}}>{t.done?"✓":""}</button>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,fontWeight:600,color:t.done?C.muted:C.text,textDecoration:t.done?"line-through":"none",wordBreak:"break-word"}}>{t.task}</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:t.owner||t.due?4:0}}>
              {t.owner&&<span style={{fontSize:11,color:C.muted}}>👤 {t.owner}</span>}
              {t.due&&<span style={{fontSize:11,fontWeight:700,color:isOverdue(t)?"#dc2626":isDueToday(t)?"#d97706":C.muted}}>{isOverdue(t)?"⚠️ ":isDueToday(t)?"📅 ":"🗓 "}{new Date(t.due+"T12:00:00").toLocaleDateString("de-DE")}</span>}
            </div>
          </div>
          {!readOnly&&<button onClick={e=>{e.stopPropagation();del(t);}} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:4,flexShrink:0}}><Trash2 size={15}/></button>}
        </div>
        {t.createdByName&&<div style={{fontSize:11,color:C.muted,padding:"0 14px 7px",borderTop:`1px solid ${C.border}22`,paddingTop:4}}>👤 Erstellt von {t.createdByName}{t.createdAt?" · "+new Date(t.createdAt).toLocaleDateString("de-DE"):""}</div>}
      </div>
    ))}
    {/* Detail modal */}
    {modal&&<Modal title={modal.data?"Task bearbeiten":"Neuer Task"} onClose={()=>setModal(null)}>
      <TodoForm todo={modal.data} coaches={coaches} currentUser={currentUser} onSave={t=>{onSave(t);setModal(null);toast(modal.data?"Task gespeichert":"Task erstellt");}} onClose={()=>setModal(null)}/>
    </Modal>}
  </div>);
}

function TodoForm({todo,coaches,currentUser,onSave,onClose}) {
  const [task,setTask]=useState(todo?.task||"");
  const [owner,setOwner]=useState(todo?.owner||"");
  const [due,setDue]=useState(todo?.due||"");
  const [ownerOpen,setOwnerOpen]=useState(false);
  const coachNames=(coaches||[]).map(c=>c.name).filter(Boolean);
  const suggestions=coachNames.filter(n=>n.toLowerCase().includes(owner.toLowerCase())&&n!==owner);
  return(<div>
    <Inp label="Aufgabe *" value={task} onChange={e=>setTask(e.target.value)} placeholder="Was ist zu tun?"/>
    <div style={{marginBottom:14,position:"relative"}}>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Zuständig</label>
      <input value={owner} onChange={e=>{setOwner(e.target.value);setOwnerOpen(true);}} onFocus={()=>setOwnerOpen(true)} onBlur={()=>setTimeout(()=>setOwnerOpen(false),150)} placeholder="Name oder frei eingeben" style={{width:"100%",padding:"9px 12px",borderRadius:8,border:`1.5px solid ${C.border}`,fontSize:14,fontFamily:"inherit",boxSizing:"border-box",outline:"none"}}/>
      {ownerOpen&&suggestions.length>0&&<div style={{position:"absolute",top:"100%",left:0,right:0,background:"white",border:`1.5px solid ${C.border}`,borderRadius:8,boxShadow:"0 4px 12px rgba(0,0,0,.12)",zIndex:200,maxHeight:140,overflowY:"auto"}}>
        {suggestions.map(n=><div key={n} onMouseDown={()=>{setOwner(n);setOwnerOpen(false);}} style={{padding:"9px 14px",cursor:"pointer",fontSize:14,color:C.text}}>👤 {n}</div>)}
      </div>}
    </div>
    <Inp label="Fällig bis" type="date" value={due} onChange={e=>setDue(e.target.value)}/>
    <div style={{display:"flex",gap:8,marginTop:18}}>
      <Btn variant="secondary" onClick={onClose}>Abbrechen</Btn>
      <Btn onClick={()=>{if(!task.trim())return;const n=now();onSave({id:todo?.id||uid(),task:task.trim(),owner:owner.trim()||null,due:due||null,done:todo?.done||false,doneAt:todo?.doneAt||null,createdAt:todo?.createdAt||n,createdBy:todo?.createdBy||currentUser?.uid||null,createdByName:todo?.createdByName||currentUser?.displayName||currentUser?.email||null,updatedAt:n});}}>Speichern</Btn>
    </div>
  </div>);
}

// ─── MEETINGS ────────────────────────────────────────────────────
const normalizeAgenda=agenda=>(Array.isArray(agenda)?agenda:[]).map(ag=>typeof ag==="string"?{text:ag,done:false,sub:[]}:(ag&&typeof ag==="object"?{sub:[],...ag}:{text:"",done:false,sub:[]}));

function MeetingCard({m,onEdit,onDel,onSave,readOnly,initialOpen}) {
  const [open,setOpen]=useState(!!initialOpen);
  const [showAdd,setShowAdd]=useState(false);
  const agenda=normalizeAgenda(m.agenda);
  const toggleAgenda=idx=>{const ag=[...agenda];ag[idx]={...ag[idx],done:!ag[idx].done};onSave({...m,agenda:ag});};
  const doneCount=agenda.filter(a=>a.done).length;
  return(<div style={{background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,marginBottom:10,overflow:"hidden"}}>
    <div onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",cursor:"pointer"}}>
      <div style={{width:40,height:40,borderRadius:10,background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>📅</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:800,fontSize:15,color:C.text}}>{m.title||"Trainertreff"}</div>
        <div style={{fontSize:12,color:C.muted,marginTop:2}}>{m.date?new Date(m.date+"T12:00").toLocaleDateString("de-DE",{weekday:"long",day:"numeric",month:"long",year:"numeric"}):""}{m.location?` · 📍 ${m.location}`:""}{agenda.length>0?` · ${doneCount}/${agenda.length} Punkte`:""}</div>
      </div>
      <div style={{display:"flex",gap:4,alignItems:"center"}} onClick={e=>e.stopPropagation()}>
        {!readOnly&&<button onClick={onEdit} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,padding:6}}><Edit2 size={16}/></button>}
        {!readOnly&&<button onClick={onDel} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:6}}><Trash2 size={16}/></button>}
        <span style={{color:C.muted,padding:6,fontSize:14}} onClick={()=>setOpen(o=>!o)}>{open?"▲":"▼"}</span>
      </div>
    </div>
    {open&&<div style={{borderTop:`1px solid ${C.border}`,padding:"8px 16px 12px"}}>
      {agenda.length===0&&<div style={{fontSize:13,color:C.muted,fontStyle:"italic",padding:"8px 0"}}>Keine Agendapunkte</div>}
      {agenda.map((ag,i)=><div key={i} style={{borderBottom:i<agenda.length-1?`1px solid ${C.border}33`:"none"}}>
        <div onClick={e=>{e.stopPropagation();if(!readOnly)toggleAgenda(i);}} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",cursor:readOnly?"default":"pointer"}}>
          <div style={{width:26,height:26,borderRadius:"50%",background:ag.done?C.primary:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:ag.done?"white":C.primary,flexShrink:0,transition:"all .15s"}}>{ag.done?"✓":i+1}</div>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:600,color:ag.done?C.muted:C.text,textDecoration:ag.done?"line-through":"none"}}>{ag.text}</div>
            {Array.isArray(ag.sub)&&ag.sub.length>0&&ag.sub.map((s,j)=><div key={j} style={{fontSize:12,color:C.muted,marginLeft:8,marginTop:3,textDecoration:ag.done?"line-through":"none"}}>↳ {s}</div>)}
          </div>
        </div>
      </div>)}
      {!readOnly&&<Btn variant="secondary" onClick={e=>{e.stopPropagation();setShowAdd(true);}} style={{marginTop:10,width:"100%",justifyContent:"center"}}><Plus size={14}/> Neuer Punkt</Btn>}
      {(m.createdByName||m.createdBy)&&<div style={{fontSize:11,color:C.muted,marginTop:8}}>Erstellt von {m.createdByName||m.createdBy}</div>}
    </div>}
    {showAdd&&<Modal title="Neuer Agendapunkt" onClose={()=>setShowAdd(false)}>
      <AddAgendaPointModal onSave={pt=>{onSave({...m,agenda:[...agenda,pt]});setShowAdd(false);}} onClose={()=>setShowAdd(false)}/>
    </Modal>}
  </div>);
}

function AddAgendaPointModal({onSave,onClose}) {
  const [text,setText]=useState("");
  const [subs,setSubs]=useState([]);
  const addSub=()=>setSubs(s=>[...s,""]);
  const setSub=(i,v)=>setSubs(s=>{const n=[...s];n[i]=v;return n;});
  const delSub=i=>setSubs(s=>s.filter((_,j)=>j!==i));
  return(<div>
    <Inp label="Agendapunkt" value={text} onChange={e=>setText(e.target.value)} placeholder="z.B. Nächstes Turnier besprechen"/>
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <label style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6}}>Unterpunkte <span style={{fontWeight:400,textTransform:"none"}}>(optional)</span></label>
        <Btn sm variant="secondary" onClick={addSub}><Plus size={13}/> Unterpunkt</Btn>
      </div>
      {subs.map((s,i)=><div key={i} style={{display:"flex",gap:6,alignItems:"center",marginBottom:6}}>
        <span style={{color:C.muted,fontSize:12}}>↳</span>
        <input value={s} onChange={e=>setSub(i,e.target.value)} placeholder="Unterpunkt..." style={{flex:1,padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:13,fontFamily:"inherit",outline:"none",background:"white",color:C.text}}/>
        <button onClick={()=>delSub(i)} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:4}}><Trash2 size={14}/></button>
      </div>)}
    </div>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      <Btn onClick={()=>{if(!text.trim())return;onSave({text:text.trim(),done:false,sub:subs.map(s=>s.trim()).filter(Boolean)});}}>Hinzufügen</Btn>
    </div>
  </div>);
}

function MeetingForm({m,onSave,onClose}) {
  const [form,setForm]=useState({...m,agenda:normalizeAgenda(m.agenda)});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const addAgenda=()=>setForm(f=>({...f,agenda:[...f.agenda,{text:"",done:false,sub:[]}]}));
  const setAgenda=(i,k,v)=>setForm(f=>{const ag=[...f.agenda];ag[i]={...ag[i],[k]:v};return{...f,agenda:ag};});
  const delAgenda=i=>setForm(f=>({...f,agenda:f.agenda.filter((_,j)=>j!==i)}));
  const addSub=i=>setForm(f=>{const ag=[...f.agenda];ag[i]={...ag[i],sub:[...(Array.isArray(ag[i].sub)?ag[i].sub:[]),""]};return{...f,agenda:ag};});
  const setSub=(i,j,v)=>setForm(f=>{const ag=[...f.agenda];const sub=[...(Array.isArray(ag[i].sub)?ag[i].sub:[])];sub[j]=v;ag[i]={...ag[i],sub};return{...f,agenda:ag};});
  const delSub=(i,j)=>setForm(f=>{const ag=[...f.agenda];ag[i]={...ag[i],sub:(Array.isArray(ag[i].sub)?ag[i].sub:[]).filter((_,k)=>k!==j)};return{...f,agenda:ag};});

  // Drag & Drop (Pointer Events – funktioniert per Maus UND Touch)
  const rowRefs=useRef([]);
  const dragFromRef=useRef(null);
  const [draggingIdx,setDraggingIdx]=useState(null);
  const startDrag=i=>e=>{
    e.preventDefault();
    dragFromRef.current=i;
    setDraggingIdx(i);
    const onMove=ev=>{
      const y=ev.touches?ev.touches[0].clientY:ev.clientY;
      const from=dragFromRef.current;
      if(from===null)return;
      let to=from,bestDist=Infinity;
      rowRefs.current.forEach((el,idx)=>{
        if(!el)return;
        const r=el.getBoundingClientRect();
        const mid=r.top+r.height/2;
        const dist=Math.abs(y-mid);
        if(dist<bestDist){bestDist=dist;to=idx;}
      });
      if(to!==from){
        setForm(f=>{const ag=[...f.agenda];const [item]=ag.splice(from,1);ag.splice(to,0,item);return{...f,agenda:ag};});
        dragFromRef.current=to;
        setDraggingIdx(to);
      }
    };
    const onUp=()=>{
      dragFromRef.current=null;
      setDraggingIdx(null);
      document.removeEventListener("pointermove",onMove);
      document.removeEventListener("pointerup",onUp);
    };
    document.addEventListener("pointermove",onMove);
    document.addEventListener("pointerup",onUp);
  };

  return(<div>
    <Inp label="Titel" value={form.title} onChange={e=>set("title",e.target.value)}/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
      <Inp label="Datum" type="date" value={form.date} onChange={e=>set("date",e.target.value)}/>
      <Inp label="Ort" value={form.location||""} onChange={e=>set("location",e.target.value)} placeholder="z.B. Vereinsheim"/>
    </div>
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <label style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6}}>Agenda</label>
        <Btn sm onClick={addAgenda}><Plus size={13}/> Punkt</Btn>
      </div>
      {form.agenda.map((ag,i)=><div key={i} ref={el=>rowRefs.current[i]=el} style={{marginBottom:8,padding:"10px 12px",background:draggingIdx===i?"#eff6ff":"#f8fafc",borderRadius:8,border:`1px solid ${draggingIdx===i?C.primary:C.border}`,opacity:draggingIdx===i?.85:1}}>
        <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:Array.isArray(ag.sub)&&ag.sub.length>0?8:0}}>
          <span onPointerDown={startDrag(i)} style={{cursor:"grab",touchAction:"none",color:C.muted,fontSize:16,padding:"2px 4px",lineHeight:1,userSelect:"none"}}>⠿</span>
          <span style={{fontSize:12,fontWeight:700,color:C.muted,minWidth:16}}>{i+1}.</span>
          <input value={ag.text} onChange={e=>setAgenda(i,"text",e.target.value)} placeholder="Agendapunkt..." style={{flex:1,padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:13,fontFamily:"inherit",outline:"none",background:"white",color:C.text}}/>
          <button onClick={()=>addSub(i)} title="Unterpunkt hinzufügen" style={{padding:"6px 10px",borderRadius:6,border:`1px solid ${C.border}`,background:"white",cursor:"pointer",color:C.muted,fontSize:13,fontFamily:"inherit"}}>↳ Sub</button>
          <button onClick={()=>delAgenda(i)} style={{padding:"6px 8px",borderRadius:6,border:"1px solid #fca5a5",background:"#fff5f5",cursor:"pointer",color:"#ef4444"}}><Trash2 size={15}/></button>
        </div>
        {(Array.isArray(ag.sub)?ag.sub:[]).map((s,j)=><div key={j} style={{display:"flex",gap:6,alignItems:"center",marginLeft:24,marginTop:4}}>
          <span style={{color:C.muted,fontSize:12}}>↳</span>
          <input value={s} onChange={e=>setSub(i,j,e.target.value)} placeholder="Unterpunkt..." style={{flex:1,padding:"4px 8px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,fontFamily:"inherit",outline:"none",background:"white",color:C.text}}/>
          <button onClick={()=>delSub(i,j)} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:2}}><Trash2 size={12}/></button>
        </div>)}
      </div>)}
    </div>
    <div style={{display:"flex",gap:8,justifyContent:"flex-end",paddingTop:12,borderTop:`1px solid ${C.border}`}}>
      <Btn variant="secondary" onClick={onClose}>Abbrechen</Btn>
      <Btn onClick={()=>onSave(form)}>Speichern</Btn>
    </div>
  </div>);
}

// ── KALENDER (vereinheitlichte Terminübersicht) ─────────────────
function CalendarPage({sessions,meetings,tournaments,players,coaches,exercises,onSaveSession,onDeleteSession,onSavePlayer,onSaveMeeting,onDeleteMeeting,onSaveTournament,onSaveExercise,apiKey,toast,readOnly,onOpenTournament,pendingTarget,onClearPendingTarget,onlineUsers,currentUser,onGoHome,onGoBack}) {
  const todayStr=todayISO();
  const [types,setTypes]=useState({training:true,spieltag:true,treffen:true});
  const [view,setView]=useState("list"); // list | month
  const [showFuture,setShowFuture]=useState(true);
  const [showPast,setShowPast]=useState(false);
  const [monthCursor,setMonthCursor]=useState(todayStr.slice(0,7)); // "YYYY-MM"
  const [selectedDay,setSelectedDay]=useState(todayStr);
  const [modal,setModal]=useState(null);

  useEffect(()=>{
    if(!pendingTarget){return;}
    if(pendingTarget.type==="training"){
      const s=sessions.find(x=>x.id===pendingTarget.id);
      if(s)setModal(isSessionPlanned(s)?{type:"sessionDetail",data:s}:{type:"setup",continueSessionId:s.id});
    }else if(pendingTarget.type==="meeting"){
      const m=meetings.find(x=>x.id===pendingTarget.id);
      if(m)setModal({type:"meetingDetail",data:m});
    }
    onClearPendingTarget?.();
  },[]); // eslint-disable-line

  const gP=id=>players.find(p=>p.id===id),gC=id=>coaches.find(c=>c.id===id),gE=id=>exercises.find(e=>e.id===id);

  const items=[
    ...(types.training?sessions.map(s=>({type:"training",id:"tr-"+s.id,date:s.date,raw:s})):[]),
    ...(types.treffen?meetings.map(m=>({type:"treffen",id:"mt-"+m.id,date:m.date,raw:m})):[]),
    ...(types.spieltag?tournaments.map(t=>({type:"spieltag",id:"tn-"+t.id,date:t.date,raw:t})):[]),
  ];
  const future=items.filter(i=>i.date>=todayStr).sort((a,b)=>a.date.localeCompare(b.date));
  const past=items.filter(i=>i.date<todayStr).sort((a,b)=>a.date.localeCompare(b.date));

  const itemsByDate={};
  items.forEach(it=>{(itemsByDate[it.date]=itemsByDate[it.date]||[]).push(it);});

  const isoLocal=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const shiftMonth=delta=>{
    const [y,m]=monthCursor.split("-").map(Number);
    const d=new Date(y,m-1+delta,1);
    setMonthCursor(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);
  };
  const buildMonthGrid=ym=>{
    const [y,m]=ym.split("-").map(Number);
    const first=new Date(y,m-1,1);
    const firstWeekday=first.getDay()===0?7:first.getDay(); // Montag=1...Sonntag=7
    const daysInMonth=new Date(y,m,0).getDate();
    const cells=[];
    for(let i=firstWeekday-1;i>0;i--){const d=new Date(y,m-1,1-i);cells.push({date:isoLocal(d),inMonth:false});}
    for(let day=1;day<=daysInMonth;day++)cells.push({date:`${y}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}`,inMonth:true});
    while(cells.length%7!==0){const last=cells[cells.length-1].date;cells.push({date:addDaysISO(last,1),inMonth:false});}
    return cells;
  };
  const monthGrid=buildMonthGrid(monthCursor);
  const monthLabel=(()=>{const [y,m]=monthCursor.split("-").map(Number);return new Date(y,m-1,1).toLocaleDateString("de-DE",{month:"long",year:"numeric"});})();
  const selectedDayItems=(itemsByDate[selectedDay]||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));

  const typeChip=(key,label,emoji)=>(
    <button onClick={()=>setTypes(t=>({...t,[key]:!t[key]}))} style={{padding:"6px 14px",borderRadius:20,border:`1.5px solid ${types[key]?C.primary:C.border}`,background:types[key]?C.accentL:"white",color:types[key]?C.primary:C.muted,cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:"inherit"}}>{emoji} {label}</button>
  );

  const sectionHeader=(label,open,setOpen,count)=>(
    <div onClick={()=>setOpen(v=>!v)} style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",padding:"6px 2px",marginBottom:open?10:0}}>
      <span style={{fontSize:12,color:C.muted,width:14,flexShrink:0}}>{open?"▼":"▶"}</span>
      <span style={{fontWeight:800,fontSize:15,color:C.text}}>{label}</span>
      <span style={{fontSize:12,color:C.muted,fontWeight:600}}>({count})</span>
    </div>
  );

  const openItem=it=>{
    if(it.type==="training"){
      setModal(isSessionPlanned(it.raw)?{type:"sessionDetail",data:it.raw}:{type:"setup",continueSessionId:it.raw.id});
    }else if(it.type==="treffen"){
      setModal({type:"meetingDetail",data:it.raw});
    }else{
      onOpenTournament(it.raw.id);
    }
  };
  const renderItem=it=>{
    if(it.type==="training"){
      const s=it.raw;
      const pr=(s.playerIds||[]).map(gP).filter(Boolean),tr=(s.coachIds||[]).map(gC).filter(Boolean),ex=(s.exerciseIds||[]).map(gE).filter(Boolean);
      const kids=s.participantCount?Number(s.participantCount):pr.length;
      const planned=isSessionPlanned(s);
      return(<div key={it.id} onClick={()=>setModal(planned?{type:"sessionDetail",data:s}:{type:"setup",continueSessionId:s.id})} style={{display:"flex",alignItems:"center",gap:10,background:C.card,borderRadius:12,border:`1.5px solid ${s.isDraft?"#fde047":C.border}`,padding:"12px 16px",cursor:"pointer"}}>
        <div style={{width:40,height:40,borderRadius:10,background:"#eff6ff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>📅</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:800,fontSize:14,color:C.text,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            {fmtDate(s.date)}{s.time?` · ${s.time} Uhr`:""}
            {s.seriesId&&<span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:20,background:C.accentL,color:C.primary}}>🔁 Serie</span>}
            <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:20,background:planned?"#dcfce7":"#fef3c7",color:planned?"#16a34a":"#b45309"}}>{planned?"✅ Geplant":"🕒 Ungeplant"}</span>
          </div>
          <div style={{fontSize:12,color:C.muted,marginTop:2}}>Training · ⏱ {s.duration} Min{kids>0?` · 👥 ${kids}`:""}{s.location?` · 📍 ${s.location}`:""}{ex.length>0?` · ${ex.length} Übung${ex.length!==1?"en":""}`:""}</div>
        </div>
      </div>);
    }
    if(it.type==="treffen"){
      const m=it.raw;
      const agenda=normalizeAgenda(m.agenda);
      const doneCount=agenda.filter(a=>a.done).length;
      return(<div key={it.id} onClick={()=>setModal({type:"meetingDetail",data:m})} style={{display:"flex",alignItems:"center",gap:10,background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,padding:"12px 16px",cursor:"pointer"}}>
        <div style={{width:40,height:40,borderRadius:10,background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🧑‍🏫</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:800,fontSize:14,color:C.text}}>{m.title||"Trainertreff"}</div>
          <div style={{fontSize:12,color:C.muted,marginTop:2}}>Treffen · {fmtDate(m.date)}{m.location?` · 📍 ${m.location}`:""}{agenda.length>0?` · ${doneCount}/${agenda.length} Punkte`:""}</div>
        </div>
      </div>);
    }
    const t=it.raw;
    const played=(t.matches||[]).filter(m=>m.played).length,total=(t.matches||[]).length;
    return(<div key={it.id} onClick={()=>onOpenTournament(t.id)} style={{display:"flex",alignItems:"center",gap:10,background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,padding:"12px 16px",cursor:"pointer"}}>
      <div style={{width:40,height:40,borderRadius:10,background:"#f0fdf4",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🏆</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:800,fontSize:14,color:C.text}}>{t.name||"Turnier"}</div>
        <div style={{fontSize:12,color:C.muted,marginTop:2}}>Spieltag · {fmtDate(t.date)}{(t.teams||[]).length>0?` · ${t.teams.length} Teams`:""}{total>0?` · ${played}/${total} Spiele`:""}</div>
      </div>
    </div>);
  };

  return(<div>
    <PageHeader title="Termine" sub={`${items.length} Termine`} onlineUsers={onlineUsers} currentUser={currentUser} onGoHome={onGoHome} onGoBack={onGoBack}/>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12,alignItems:"center",justifyContent:"space-between"}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {typeChip("training","Training","📅")}
        {typeChip("spieltag","Spieltag","🏆")}
        {typeChip("treffen","Treffen","🧑‍🏫")}
      </div>
      <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:10,padding:4}}>
        <button onClick={()=>setView("list")} style={{padding:"7px 14px",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit",background:view==="list"?C.primary:"transparent",color:view==="list"?"white":C.muted}}>📋 Liste</button>
        <button onClick={()=>setView("month")} style={{padding:"7px 14px",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit",background:view==="month"?C.primary:"transparent",color:view==="month"?"white":C.muted}}>🗓 Kalender</button>
      </div>
    </div>
    {!readOnly&&<div style={{marginBottom:16}}>
      <Btn onClick={()=>setModal({type:"eventType"})}><Plus size={14}/> Neuer Termin</Btn>
    </div>}
    {items.length===0?<Empty icon="🗓" title="Noch keine Termine" sub="Trainings, Trainertreffen und Turniere erscheinen hier, sobald sie angelegt sind."/>:
      view==="list"?
      <div>
        <div style={{marginBottom:20}}>
          {sectionHeader("Zukünftige Termine",showFuture,setShowFuture,future.length)}
          {showFuture&&(future.length===0?<div style={{color:C.muted,fontSize:13,padding:"0 2px 8px"}}>Keine zukünftigen Termine</div>:
            <div style={{display:"flex",flexDirection:"column",gap:8}}>{future.map(renderItem)}</div>)}
        </div>
        <div>
          {sectionHeader("Vergangene Termine",showPast,setShowPast,past.length)}
          {showPast&&(past.length===0?<div style={{color:C.muted,fontSize:13,padding:"0 2px 8px"}}>Keine vergangenen Termine</div>:
            <div style={{display:"flex",flexDirection:"column",gap:8}}>{past.map(renderItem)}</div>)}
        </div>
      </div>
      :
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <button onClick={()=>shiftMonth(-1)} style={{background:"none",border:`1.5px solid ${C.border}`,borderRadius:8,width:32,height:32,cursor:"pointer",color:C.text,fontSize:16}}>‹</button>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{fontWeight:800,fontSize:15,color:C.text,textTransform:"capitalize"}}>{monthLabel}</div>
            <button onClick={()=>{setMonthCursor(todayStr.slice(0,7));setSelectedDay(todayStr);}} style={{fontSize:11,fontWeight:700,color:C.primary,background:C.accentL,border:"none",borderRadius:20,padding:"3px 10px",cursor:"pointer",fontFamily:"inherit"}}>Heute</button>
          </div>
          <button onClick={()=>shiftMonth(1)} style={{background:"none",border:`1.5px solid ${C.border}`,borderRadius:8,width:32,height:32,cursor:"pointer",color:C.text,fontSize:16}}>›</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4,marginBottom:4}}>
          {["Mo","Di","Mi","Do","Fr","Sa","So"].map(d=><div key={d} style={{textAlign:"center",fontSize:11,fontWeight:700,color:C.muted,padding:"4px 0"}}>{d}</div>)}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4,marginBottom:16}}>
          {monthGrid.map(cell=>{
            const dayItems=itemsByDate[cell.date]||[];
            const isToday=cell.date===todayStr;
            const isSel=cell.date===selectedDay;
            return(<div key={cell.date} onClick={()=>setSelectedDay(cell.date)} style={{minHeight:80,padding:"4px 3px",borderRadius:8,border:`1.5px solid ${isSel?C.primary:isToday?C.accent:C.border}`,background:isSel?C.accentL:cell.inMonth?C.card:"#f8fafc",opacity:cell.inMonth?1:.45,cursor:"pointer",overflow:"hidden"}}>
              <div style={{fontSize:12,fontWeight:isToday?800:600,color:isToday?C.primary:C.text,marginBottom:2}}>{Number(cell.date.slice(8,10))}</div>
              {dayItems.slice(0,3).map((it,i)=>{
                const label=it.type==="training"?"Training":it.type==="spieltag"?(it.raw.name||"Turnier"):(it.raw.title||"Treffen");
                const bg=it.type==="training"?"#a7ddc8":it.type==="spieltag"?"#14532d":"#fde68a";
                const fg=it.type==="training"?"#14532d":it.type==="spieltag"?"#ffffff":"#78350f";
                return(<div key={i} onClick={e=>{e.stopPropagation();openItem(it);}} style={{fontSize:10,fontWeight:700,padding:"2px 4px",borderRadius:4,background:bg,color:fg,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginBottom:2,cursor:"pointer"}}>{label}</div>);
              })}
              {dayItems.length>3&&<div style={{fontSize:9,color:C.muted,fontWeight:700}}>+{dayItems.length-3} mehr</div>}
            </div>);
          })}
        </div>
        <div style={{fontWeight:800,fontSize:14,color:C.text,marginBottom:10}}>{fmtDate(selectedDay)}</div>
        {selectedDayItems.length===0?<div style={{color:C.muted,fontSize:13}}>Keine Termine an diesem Tag</div>:
          <div style={{display:"flex",flexDirection:"column",gap:8}}>{selectedDayItems.map(renderItem)}</div>}
      </div>}

    {modal?.type==="sessionDetail"&&modal.data&&<Modal title={fmtDate(modal.data.date)} onClose={()=>setModal(null)} wide><SessionDetailView s={modal.data} players={players} coaches={coaches} exercises={exercises} onDelete={()=>{onDeleteSession(modal.data.id);setModal(null);}} onClose={()=>setModal(null)} onSaveSession={onSaveSession} onPrint={()=>printSession(modal.data,exercises,toast)} onReplan={()=>setModal({type:"setup",continueSessionId:modal.data.id})}/></Modal>}
    {modal?.type==="setup"&&<Modal title="Training planen" onClose={()=>setModal(null)} wide><NewTrainingWizard sessions={sessions} players={players} exercises={exercises} initialSessionId={modal.continueSessionId} startStep={modal.continueSessionId?2:1} onSaveSession={s=>{onSaveSession(s);setModal(null);toast("Training gespeichert");}} onSavePlayer={onSavePlayer} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="meetingDetail"&&modal.data&&<Modal title={modal.data.title||"Trainertreff"} onClose={()=>setModal(null)} wide><MeetingCard m={modal.data} initialOpen onEdit={()=>setModal({type:"meetingForm",data:modal.data})} onDel={()=>{onDeleteMeeting(modal.data.id);setModal(null);}} onSave={m=>{onSaveMeeting(m);setModal({type:"meetingDetail",data:m});}} readOnly={readOnly}/></Modal>}
    {modal?.type==="eventType"&&<Modal title="Neuer Termin" onClose={()=>setModal(null)}>
      <div style={{fontSize:13,color:C.muted,marginBottom:16}}>Was für ein Termin soll angelegt werden?</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        <button onClick={()=>setModal({type:"setup"})} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:12,border:`1.5px solid ${C.border}`,background:C.card,cursor:"pointer",textAlign:"left",fontFamily:"inherit"}}>
          <div style={{width:40,height:40,borderRadius:10,background:"#eff6ff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>📅</div>
          <div><div style={{fontWeight:800,fontSize:14,color:C.text}}>Training</div><div style={{fontSize:12,color:C.muted}}>Neue Trainingseinheit planen</div></div>
        </button>
        <button onClick={()=>setModal({type:"meetingForm",data:{id:uid(),title:"Trainertreff",date:todayISO(),location:"",agenda:[],createdBy:currentUser?.uid||"",createdByName:currentUser?.displayName||currentUser?.email||"",createdAt:now()}})} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:12,border:`1.5px solid ${C.border}`,background:C.card,cursor:"pointer",textAlign:"left",fontFamily:"inherit"}}>
          <div style={{width:40,height:40,borderRadius:10,background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🧑‍🏫</div>
          <div><div style={{fontWeight:800,fontSize:14,color:C.text}}>Treffen</div><div style={{fontSize:12,color:C.muted}}>Neuer Trainertreff mit Agenda</div></div>
        </button>
        <button onClick={()=>setModal({type:"tournamentForm"})} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:12,border:`1.5px solid ${C.border}`,background:C.card,cursor:"pointer",textAlign:"left",fontFamily:"inherit"}}>
          <div style={{width:40,height:40,borderRadius:10,background:"#f0fdf4",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🏆</div>
          <div><div style={{fontWeight:800,fontSize:14,color:C.text}}>Turnier</div><div style={{fontSize:12,color:C.muted}}>Neues Turnier / Spieltag anlegen</div></div>
        </button>
      </div>
    </Modal>}
    {modal?.type==="tournamentForm"&&<Modal title="Neues Turnier" onClose={()=>setModal(null)} wide><TournamentForm onSave={t=>{onSaveTournament(t);setModal(null);toast("Turnier erstellt");onOpenTournament(t.id);}} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="meetingForm"&&<Modal title={meetings.find(x=>x.id===modal.data?.id)?"Trainertreff bearbeiten":"Neuer Trainertreff"} onClose={()=>setModal(null)} wide><MeetingForm m={modal.data} onSave={m=>{onSaveMeeting(m);setModal(null);toast("Trainertreff gespeichert");}} onClose={()=>setModal(null)}/></Modal>}
  </div>);
}

// ── TRAINING PAGE ─────────────────────────────────────────────────
function TrainingPage({sessions,players,coaches,exercises,onSaveSession,onDeleteSession,onSavePlayer,apiKey,toast,onSaveExercise,pendingSetup,onClearPendingSetup,onlineUsers,currentUser,onGoHome,onGoBack,onGoToCalendar,recurringSlots,onSaveSlot,onDeleteSlot,onGenerateSessions}) {
  const [modal,setModal]=useState(()=>pendingSetup?{type:"setup",setup:pendingSetup}:null);
  useEffect(()=>{if(pendingSetup){setModal({type:"setup",setup:pendingSetup});onClearPendingSetup?.();}},[]);
  const todayStr=todayISO();
  const gP=id=>players.find(p=>p.id===id),gC=id=>coaches.find(c=>c.id===id),gE=id=>exercises.find(e=>e.id===id);
  const next5=[...sessions].filter(s=>s.date>=todayStr).sort((a,b)=>a.date.localeCompare(b.date)||(a.time||"").localeCompare(b.time||"")).slice(0,5);
  const WEEKDAY_ADVERB={1:"Montags",2:"Dienstags",3:"Mittwochs",4:"Donnerstags",5:"Freitags",6:"Samstags",7:"Sonntags"};
  const sortedSlots=[...(recurringSlots||[])].sort((a,b)=>a.weekday-b.weekday||(a.time||"").localeCompare(b.time||""));

  const renderRow=s=>{
    const pr=(s.playerIds||[]).map(gP).filter(Boolean),ex=(s.exerciseIds||[]).map(gE).filter(Boolean);
    const kids=s.participantCount?Number(s.participantCount):pr.length;
    const planned=isSessionPlanned(s);
    return(<div key={s.id} onClick={()=>setModal(planned?{type:"sessionDetail",data:s}:{type:"setup",continueSessionId:s.id})} style={{display:"flex",alignItems:"center",gap:10,background:C.card,borderRadius:12,border:`1.5px solid ${s.isDraft?"#fde047":C.border}`,padding:"12px 16px",cursor:"pointer",marginBottom:8}}>
      <div style={{width:40,height:40,borderRadius:10,background:"#eff6ff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>📅</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:800,fontSize:14,color:C.text,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {fmtDate(s.date)}{s.time?` · ${s.time} Uhr`:""}
          <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:20,background:planned?"#dcfce7":"#fef3c7",color:planned?"#16a34a":"#b45309"}}>{planned?"✅ Geplant":"🕒 Ungeplant"}</span>
        </div>
        <div style={{fontSize:12,color:C.muted,marginTop:2}}>⏱ {s.duration} Min{kids>0?` · 👥 ${kids}`:""}{s.location?` · 📍 ${s.location}`:""}{ex.length>0?` · ${ex.length} Übung${ex.length!==1?"en":""}`:""}</div>
      </div>
    </div>);
  };

  return(<div>
    <PageHeader title="Training" sub="Nächste Trainings & Serientermine" onlineUsers={onlineUsers} currentUser={currentUser} onGoHome={onGoHome} onGoBack={onGoBack}/>

    <div style={{background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,padding:"14px 16px",marginBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:sortedSlots.length>0?10:0}}>
        <div style={{fontWeight:800,fontSize:14,color:C.text}}>🔁 Trainingszeiten</div>
        <button onClick={()=>setModal({type:"slots"})} title="Trainingszeiten bearbeiten" style={{background:"none",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"5px 10px",cursor:"pointer",color:C.text,display:"flex",alignItems:"center",gap:4,fontSize:12,fontWeight:700,fontFamily:"inherit"}}><Edit2 size={13}/> Bearbeiten</button>
      </div>
      {sortedSlots.length===0?<div style={{fontSize:13,color:C.muted}}>Noch keine festen Trainingszeiten hinterlegt.</div>:
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          {sortedSlots.map(s=><div key={s.id} style={{fontSize:15,color:C.text,fontWeight:700}}>{WEEKDAY_ADVERB[s.weekday]} {s.time||"–"} Uhr{s.location?<span style={{color:C.muted,fontWeight:400}}> · {s.location}</span>:null}</div>)}
        </div>}
    </div>

    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
      <Btn onClick={()=>setModal({type:"notfall"})} style={{background:"#dc2626",color:"white"}} sm><AlertTriangle size={14}/> SOS</Btn>
      <Btn onClick={()=>setModal({type:"setup"})}><CalendarDays size={16}/> Neues Training</Btn>
    </div>

    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
      <div style={{fontWeight:800,fontSize:15,color:C.text}}>Nächste Trainings</div>
      {onGoToCalendar&&<button onClick={onGoToCalendar} style={{background:"none",border:"none",color:C.primary,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Alle anzeigen →</button>}
    </div>
    {next5.length===0?<div style={{color:C.muted,fontSize:13,marginBottom:20}}>Keine anstehenden Trainings.</div>:
      <div style={{marginBottom:24}}>{next5.map(renderRow)}</div>}

    {modal?.type==="slots"&&<Modal title="Trainingszeiten" onClose={()=>setModal(null)} wide><RecurringSlotsTab slots={recurringSlots||[]} sessions={sessions} onSaveSlot={onSaveSlot} onDeleteSlot={onDeleteSlot} onGenerateSessions={onGenerateSessions} toast={toast}/></Modal>}
    {modal?.type==="notfall"&&<Modal title="🚨 SOS-Notfall-Plan" onClose={()=>setModal(null)} wide><NotfallModal exercises={exercises} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="setup"&&<Modal title="Training planen" onClose={()=>setModal(null)} wide><NewTrainingWizard sessions={sessions} players={players} exercises={exercises} initialSetup={modal.setup} initialSessionId={modal.continueSessionId} startStep={modal.continueSessionId?2:1} onSaveSession={s=>{onSaveSession(s);setModal(null);toast("Training gespeichert");}} onSavePlayer={onSavePlayer} onClose={()=>setModal(null)}/></Modal>}
    {modal?.type==="sessionDetail"&&modal.data&&<Modal title={fmtDate(modal.data.date)} onClose={()=>setModal(null)} wide><SessionDetailView s={modal.data} players={players} coaches={coaches} exercises={exercises} onDelete={()=>{onDeleteSession(modal.data.id);setModal(null);}} onClose={()=>setModal(null)} onSaveSession={onSaveSession} onPrint={()=>printSession(modal.data,exercises,toast)} onReplan={()=>setModal({type:"setup",continueSessionId:modal.data.id})}/></Modal>}
  </div>);
}

// ── SERIENTERMINE (wiederkehrende Wochenslots) ───────────────────
function RecurringSlotsTab({slots,sessions,onSaveSlot,onDeleteSlot,onGenerateSessions,toast}) {
  const [modal,setModal]=useState(null);
  const sorted=[...slots].sort((a,b)=>a.weekday-b.weekday||(a.time||"").localeCompare(b.time||""));
  const del=s=>{onDeleteSlot(s.id);};
  return(<div>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end",marginBottom:16}}>
      <Btn variant="secondary" onClick={()=>setModal({type:"slot",data:null})}><Plus size={14}/> Neuer Wochentermin</Btn>
      <Btn onClick={()=>setModal({type:"generate"})} disabled={slots.length===0}><CalendarDays size={14}/> Trainings generieren</Btn>
    </div>
    {sorted.length===0&&<Empty icon="🔁" title="Noch keine Serientermine" sub="Lege feste Wochentermine an (z.B. Dienstag 16:00 Uhr), um daraus automatisch Trainings für einen Zeitraum zu erzeugen." onAdd={()=>setModal({type:"slot",data:null})} addLabel="Ersten Wochentermin anlegen"/>}
    {sorted.map(s=>(
      <div key={s.id} onClick={()=>setModal({type:"slot",data:s})} style={{display:"flex",alignItems:"center",gap:10,background:C.card,border:`1.5px solid ${C.border}`,borderRadius:10,padding:"12px 14px",marginBottom:8,cursor:"pointer"}}>
        <div style={{fontSize:22}}>🔁</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:14,color:C.text}}>{weekdayLabel(s.weekday)} · {s.time||"–"} Uhr</div>
          <div style={{fontSize:12,color:C.muted,marginTop:2}}>⏱ {s.duration||60} Min{s.location?` · 📍 ${s.location}`:""}</div>
        </div>
        <button onClick={e=>{e.stopPropagation();del(s);}} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:4,flexShrink:0}}><Trash2 size={15}/></button>
      </div>
    ))}
    {modal?.type==="slot"&&<Modal title={modal.data?"Wochentermin bearbeiten":"Neuer Wochentermin"} onClose={()=>setModal(null)}>
      <SlotForm slot={modal.data} onSave={s=>{onSaveSlot(s);setModal(null);toast(modal.data?"Wochentermin gespeichert":"Wochentermin angelegt");}} onClose={()=>setModal(null)}/>
    </Modal>}
    {modal?.type==="generate"&&<Modal title="Trainings generieren" onClose={()=>setModal(null)}>
      <GenerateSessionsModal slots={slots} sessions={sessions} onGenerate={created=>{onGenerateSessions(created);setModal(null);}} onClose={()=>setModal(null)}/>
    </Modal>}
  </div>);
}

function SlotForm({slot,onSave,onClose}) {
  const [weekday,setWeekday]=useState(slot?.weekday||1);
  const [time,setTime]=useState(slot?.time||"16:00");
  const [duration,setDuration]=useState(slot?.duration||60);
  const [location,setLocation]=useState(slot?.location||"");
  return(<div>
    <Sel label="Wochentag" value={weekday} onChange={e=>setWeekday(Number(e.target.value))}>
      {WEEKDAYS.map(w=><option key={w.v} value={w.v}>{w.l}</option>)}
    </Sel>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      <Inp label="Uhrzeit" type="time" value={time} onChange={e=>setTime(e.target.value)}/>
      <Inp label="Dauer (Min)" type="number" min={15} value={duration} onChange={e=>setDuration(Number(e.target.value))}/>
    </div>
    <Inp label="Ort" value={location} onChange={e=>setLocation(e.target.value)} placeholder="Sportplatz..."/>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      <Btn onClick={()=>onSave({id:slot?.id||uid(),weekday,time,duration,location,createdAt:slot?.createdAt||now()})}>{slot?.id?"Speichern":"Anlegen"}</Btn>
    </div>
  </div>);
}

function GenerateSessionsModal({slots,sessions,onGenerate,onClose}) {
  const [start,setStart]=useState(todayISO());
  const [end,setEnd]=useState(addDaysISO(todayISO(),90));
  const maxEnd=addDaysISO(start,365);
  const tooLong=diffDaysISO(start,end)>365;
  const invalidRange=end<start;
  const preview=(!invalidRange&&!tooLong)?buildSessionsFromSlots(slots,start,end,sessions):[];
  return(<div>
    <div style={{background:"#f8fafc",borderRadius:8,border:`1px solid ${C.border}`,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.muted}}>
      Es werden Trainings für alle hinterlegten Wochentermine im gewählten Zeitraum erstellt. Bereits vorhandene Termine (gleiches Datum + gleicher Wochentermin) werden übersprungen.
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      <Inp label="Von" type="date" value={start} onChange={e=>setStart(e.target.value)}/>
      <Inp label="Bis (max. 12 Monate)" type="date" value={end} max={maxEnd} onChange={e=>setEnd(e.target.value)}/>
    </div>
    {invalidRange&&<div style={{color:"#dc2626",fontSize:13,fontWeight:700,marginBottom:10}}>⚠️ Das Enddatum muss nach dem Startdatum liegen.</div>}
    {tooLong&&<div style={{color:"#dc2626",fontSize:13,fontWeight:700,marginBottom:10}}>⚠️ Der Zeitraum darf maximal 12 Monate umfassen.</div>}
    {!invalidRange&&!tooLong&&<div style={{fontSize:13,color:C.text,fontWeight:700,marginBottom:10}}>📅 {preview.length} neue Trainings werden erstellt.</div>}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      <Btn onClick={()=>onGenerate(preview)} disabled={invalidRange||tooLong||preview.length===0}>{preview.length} Trainings erstellen</Btn>
    </div>
  </div>);
}

function NewTrainingWizard({sessions,players,exercises,initialSetup,initialSessionId,startStep,onSaveSession,onSavePlayer,onClose}) {
  const todayStr=todayISO();
  const upcoming=[...sessions].filter(s=>s.date>=todayStr&&(!s.playerIds||s.playerIds.length===0)&&(!s.exerciseIds||s.exerciseIds.length===0)).sort((a,b)=>a.date.localeCompare(b.date)||(a.time||"").localeCompare(b.time||""));
  const initSession=initialSessionId?sessions.find(s=>s.id===initialSessionId):null;
  const [step,setStep]=useState(startStep||1);
  const [selectedSessionId,setSelectedSessionId]=useState(initSession?.id||null);
  const [date,setDate]=useState(initSession?.date||initialSetup?.date||todayStr);
  const [time,setTime]=useState(initSession?.time||initialSetup?.time||"");
  const [duration,setDuration]=useState(initSession?.duration||initialSetup?.duration||60);
  const initLoc=initSession?.location||initialSetup?.location;
  const [location,setLocation]=useState(initLoc&&initLoc!=="outdoor"&&initLoc!=="indoor"?initLoc:"");
  const [playerIds,setPlayerIds]=useState(initSession?.playerIds||initialSetup?.playerIds||[]);
  const [teams,setTeams]=useState(initSession?.teams||[]);
  const [exerciseIds,setExerciseIds]=useState(initSession?.exerciseIds||[]);
  const [newName,setNewName]=useState("");
  const [confirmPlayer,setConfirmPlayer]=useState(null); // {id,name} wartet auf Auswahl
  const [newPlayerFormOpen,setNewPlayerFormOpen]=useState(false);

  const selectSlot=s=>{setSelectedSessionId(s.id);setDate(s.date);setTime(s.time||"");setDuration(s.duration||60);setLocation(s.location||"");};
  const togE=id=>setExerciseIds(v=>v.includes(id)?v.filter(x=>x!==id):[...v,id]);

  const addPlayer=()=>{
    if(!newName.trim())return;
    setConfirmPlayer({id:uid(),name:newName.trim()});
    setNewName("");
  };
  const addAsGuest=()=>{
    if(!confirmPlayer)return;
    onSavePlayer?.({...EMPTY_PLAYER,id:confirmPlayer.id,name:confirmPlayer.name,active:false,guest:true,createdAt:now()});
    setPlayerIds(v=>[...v,confirmPlayer.id]);
    setConfirmPlayer(null);
  };

  const finish=()=>{
    const existing=selectedSessionId?sessions.find(s=>s.id===selectedSessionId):null;
    onSaveSession({
      ...(existing||{}),
      id:existing?.id||uid(),
      date,time,duration,location,
      playerIds,exerciseIds,
      coachIds:existing?.coachIds?.length?existing.coachIds:(initialSetup?.coachIds||[]),
      weather:existing?.weather||"", participantCount:existing?.participantCount||"", teams:teams.length?teams:(existing?.teams||[]), notes:existing?.notes||"",
      createdAt:existing?.createdAt||now(),
    });
  };

  const teamBuilderPlayers=playerIds.length?players.filter(p=>playerIds.includes(p.id)):players.filter(p=>p.active);
  const sortedEx=[...exercises].sort((a,b)=>(a.category||"").localeCompare(b.category||"")||a.title.localeCompare(b.title,"de"));

  const stepLabel=step===1?"Termin":step===2?"Spieler":step===3?"Teams":"Übungen";
  return(<div>
    <div style={{display:"flex",gap:6,marginBottom:6}}>
      {[1,2,3,4].map(n=><div key={n} style={{flex:1,height:4,borderRadius:2,background:n<=step?C.primary:C.border}}/>)}
    </div>
    <div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:18}}>Schritt {step} von 4 · {stepLabel}</div>

    {step===1&&<div>
      {upcoming.length>0&&<div style={{marginBottom:16}}>
        <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Anstehende Serientermine</label>
        <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:220,overflowY:"auto"}}>
          {upcoming.map(s=>{const sel=selectedSessionId===s.id;return(
            <div key={s.id} onClick={()=>selectSlot(s)} style={{padding:"10px 12px",borderRadius:10,border:`1.5px solid ${sel?C.primary:C.border}`,background:sel?C.accentL:C.card,cursor:"pointer"}}>
              <div style={{fontWeight:700,fontSize:13,color:sel?C.primary:C.text}}>{fmtDate(s.date)}{s.time?` · ${s.time} Uhr`:""}</div>
              <div style={{fontSize:12,color:C.muted,marginTop:2}}>⏱ {s.duration||60} Min{s.location?` · 📍 ${s.location}`:""}</div>
            </div>
          );})}
        </div>
      </div>}
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>{upcoming.length>0?"Oder Termin manuell eingeben":"Termin eingeben"}</label>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <Inp label="Datum" type="date" value={date} onChange={e=>setDate(e.target.value)}/>
        <Inp label="Uhrzeit" type="time" value={time} onChange={e=>setTime(e.target.value)}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <Inp label="Dauer (Min)" type="number" min={15} value={duration} onChange={e=>setDuration(Number(e.target.value))}/>
        <Inp label="Ort" value={location} onChange={e=>setLocation(e.target.value)} placeholder="Sportplatz..."/>
      </div>
    </div>}

    {step===2&&<div>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Spieler <span style={{fontWeight:400,textTransform:"none"}}>(optional – Weiter zum Überspringen)</span></label>
      <div style={{marginBottom:14}}>
        <PlayerList players={players} selPlayers={playerIds} setSelPlayers={setPlayerIds} showStrength/>
      </div>
      {!confirmPlayer?<div style={{display:"flex",gap:8}}>
        <input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addPlayer()} placeholder="Neuer Spieler – Name eingeben..." style={{flex:1,padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,fontFamily:"inherit",outline:"none",background:"white",color:C.text}}/>
        <Btn variant="secondary" onClick={addPlayer}><Plus size={14}/> Hinzufügen</Btn>
      </div>:<div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px 14px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#92400e",marginBottom:10}}>„{confirmPlayer.name}" wie hinzufügen?</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn sm onClick={()=>setNewPlayerFormOpen(true)}>Zum Team hinzufügen</Btn>
          <Btn sm variant="secondary" onClick={addAsGuest}>Gastspieler</Btn>
        </div>
      </div>}
      {newPlayerFormOpen&&confirmPlayer&&<Modal title="Neuer Spieler" onClose={()=>{setNewPlayerFormOpen(false);setConfirmPlayer(null);}}>
        <PlayerForm player={{name:confirmPlayer.name}} onSave={p=>{onSavePlayer?.(p);setPlayerIds(v=>[...v,p.id]);setNewPlayerFormOpen(false);setConfirmPlayer(null);}} onClose={()=>{setNewPlayerFormOpen(false);setConfirmPlayer(null);}}/>
      </Modal>}
    </div>}

    {step===3&&<div>
      <div style={{fontSize:12,color:C.muted,marginBottom:10}}>(optional – Teams können hier direkt für das Training gebildet werden. „Schließen" überspringt diesen Schritt.)</div>
      <TeamBuilderModal availablePlayers={teamBuilderPlayers} onSaveTeams={(t)=>{setTeams(t);setStep(4);}} onClose={()=>setStep(4)}/>
    </div>}

    {step===4&&<div>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:10,textTransform:"uppercase",letterSpacing:.6}}>Übungen <span style={{fontWeight:400,textTransform:"none"}}>(optional – {exerciseIds.length} ausgewählt)</span></label>
      {[{key:"aufwaermen",label:"Aufwärmen"},{key:"uebung",label:"Übung"},{key:"spielform",label:"Spielform"}].map(({key,label})=>{
        const exs=sortedEx.filter(e=>normCat(e.category)===key);
        if(exs.length===0)return null;
        const catInfo=CATS[key]||BUILTIN_CATS[key];
        return(<div key={key} style={{marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:13,color:C.text,marginBottom:6}}>{catInfo?.emoji} {label} <span style={{fontWeight:400,color:C.muted}}>({exs.length})</span></div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,padding:10,background:"#f8fafc",borderRadius:8,border:`1.5px solid ${C.border}`,maxHeight:180,overflowY:"auto"}}>
            {exs.map(e=><button key={e.id} onClick={()=>togE(e.id)} style={{padding:"4px 12px",borderRadius:20,border:`1.5px solid ${exerciseIds.includes(e.id)?C.primary:C.border}`,background:exerciseIds.includes(e.id)?C.accentL:"white",color:exerciseIds.includes(e.id)?C.primary:C.muted,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit"}}>{e.title}</button>)}
          </div>
        </div>);
      })}
      {sortedEx.length===0&&<span style={{color:C.muted,fontSize:13}}>Noch keine Übungen in der Bibliothek</span>}
    </div>}

    <div style={{borderTop:`1px solid ${C.border}`,marginTop:18,paddingTop:16,display:"flex",gap:8,flexWrap:"nowrap"}}>
      {step===1?<Btn onClick={onClose} variant="secondary" sm style={{flex:1,justifyContent:"center"}}>Abbrechen</Btn>:<Btn onClick={()=>setStep(step-1)} variant="secondary" sm style={{flex:1,justifyContent:"center"}}>← Zurück</Btn>}
      {step<4&&<Btn onClick={finish} variant="secondary" sm style={{flex:1,justifyContent:"center"}}><CheckSquare size={13}/> Speichern</Btn>}
      {step<4?<Btn onClick={()=>setStep(step+1)} sm style={{flex:1,justifyContent:"center"}}>Weiter →</Btn>:<Btn onClick={finish} sm style={{flex:1,justifyContent:"center"}}><CheckSquare size={13}/> Fertig</Btn>}
    </div>
  </div>);
}


// ── TURNIER PAGE ──────────────────────────────────────────────────
function TournamentForm({onSave,onClose}) {
  const [form,setForm]=useState({name:"",date:todayISO(),location:"",opponent:"",surface:"",hosting:"self",matchDuration:8,fields:1,notes:"",defaultTeamSize:4,defaultPause:2,startTime:"10:00",planLink:"",planFileData:null,planFileName:"",planFileType:""});
  // Club setup: {name, count}
  const [clubs,setClubs]=useState([{id:uid(),name:"",count:1}]);
  // Derived teams (generated from clubs)
  const [teams,setTeams]=useState([]);
  const [excludePairs,setExcludePairs]=useState([]);
  const [clubOverrides,setClubOverrides]=useState([]);
  const [showExclusions,setShowExclusions]=useState(false);
  const [step,setStep]=useState("general"); // general | clubs | teams | external
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));

  const handlePlanFile=e=>{
    const file=e.target.files?.[0];
    if(!file)return;
    const reader=new FileReader();
    reader.onload=()=>setForm(f=>({...f,planFileData:reader.result,planFileName:file.name,planFileType:file.type}));
    reader.readAsDataURL(file);
  };
  const saveExternal=()=>{
    if(!form.name.trim())return;
    onSave({...form,id:uid(),createdAt:now(),teams:[],matches:[],excludePairs:[],clubOverrides:[]});
  };

  // Generate teams from clubs
  const buildTeamsFromClubs=()=>{
    let colorIdx=0;
    const built=[];
    clubs.forEach(cl=>{
      const name=cl.name.trim()||"Verein";
      const n=Number(cl.count)||1;
      for(let i=1;i<=n;i++){
        built.push({id:uid(),name:n>1?`${name} ${i}`:name,club:name,color:TCOLORS[colorIdx%TCOLORS.length]});
        colorIdx++;
      }
    });
    return built;
  };

  const goToTeams=()=>{
    setTeams(buildTeamsFromClubs());
    setExcludePairs([]);
    setClubOverrides([]);
    setStep("teams");
  };

  const updateTeam=(id,k,v)=>setTeams(ts=>ts.map(t=>t.id===id?{...t,[k]:v}:t));
  const togglePair=(a,b)=>{
    const key=[a,b].sort().join("|");
    setExcludePairs(prev=>prev.some(p=>p.sort().join("|")===key)?prev.filter(p=>p.sort().join("|")!==key):[...prev,[a,b]]);
  };
  const isPairExcluded=(a,b)=>excludePairs.some(p=>p.sort().join("|")===[a,b].sort().join("|"));

  const sameClubPairs=[];
  teams.forEach((t1,i)=>teams.forEach((t2,j)=>{
    if(i>=j)return;
    if(t1.club&&t2.club&&t1.club.trim()&&t1.club.trim()===t2.club.trim())
      sameClubPairs.push([t1.id,t2.id]);
  }));
  const effectiveMatches=()=>{
    const excl=new Set([...excludePairs,...sameClubPairs].map(([a,b])=>[a,b].sort().join("|")));
    clubOverrides.forEach(k=>excl.delete(k));
    let c=0;
    for(let i=0;i<teams.length;i++) for(let j=i+1;j<teams.length;j++)
      if(!excl.has([teams[i].id,teams[j].id].sort().join("|"))) c++;
    return c;
  };
  const allExcluded=[...excludePairs,...sameClubPairs];

  // STEP 0: Allgemeine Fragen + wer richtet aus
  if(step==="general") return(<div>
    <Inp label="Turniername *" value={form.name} onChange={e=>set("name",e.target.value)} placeholder="z.B. Herbstturnier"/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      <Inp label="Datum" type="date" value={form.date} onChange={e=>set("date",e.target.value)}/>
      <Inp label="Uhrzeit" type="time" value={form.startTime} onChange={e=>set("startTime",e.target.value)}/>
    </div>
    <Inp label="Ort" value={form.location} onChange={e=>set("location",e.target.value)} placeholder="z.B. Sportplatz Schanzenstraße"/>
    <Inp label="Gegen wen / teilnehmende Vereine" value={form.opponent} onChange={e=>set("opponent",e.target.value)} placeholder="z.B. SC Sternschanze, FC Falke, ..."/>
    <Sel label="Untergrund" value={form.surface} onChange={e=>set("surface",e.target.value)}>
      <option value="">– auswählen –</option>
      <option value="rasen">Rasen</option>
      <option value="kunstrasen">Kunstrasen</option>
      <option value="halle">Halle</option>
      <option value="asche">Asche</option>
    </Sel>
    <Txta label="Notizen (optional)" value={form.notes} onChange={e=>set("notes",e.target.value)} rows={2}/>

    <div style={{marginTop:4,marginBottom:16}}>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>Wer richtet das Turnier aus?</label>
      <div style={{display:"flex",gap:8}}>
        {[["self","🏠 Wir selbst"],["other","🤝 Anderer Verein"]].map(([v,l])=><button key={v} onClick={()=>set("hosting",v)} style={{flex:1,padding:"10px 8px",borderRadius:8,border:`2px solid ${form.hosting===v?C.primary:C.border}`,background:form.hosting===v?C.accentL:"white",color:form.hosting===v?C.primary:C.muted,cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit"}}>{l}</button>)}
      </div>
      <div style={{fontSize:12,color:C.muted,marginTop:6}}>{form.hosting==="self"?"Du planst Teams, Spielplan und Ergebnisse selbst.":"Du hinterlegst den Turnierplan des ausrichtenden Vereins (Link, PDF oder Foto)."}</div>
    </div>

    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      <Btn onClick={()=>setStep(form.hosting==="self"?"clubs":"external")} disabled={!form.name.trim()}>Weiter →</Btn>
    </div>
  </div>);

  // STEP EXTERNAL: Turnierplan als Link/PDF/Foto hinterlegen
  if(step==="external") return(<div>
    <div style={{background:"#f8fafc",borderRadius:8,border:`1px solid ${C.border}`,padding:"10px 14px",marginBottom:16,fontSize:13,color:C.muted}}>Hinterlege den Turnierplan des ausrichtenden Vereins – als Link, PDF oder Foto.</div>
    <Inp label="Link zum Turnierplan (optional)" value={form.planLink} onChange={e=>set("planLink",e.target.value)} placeholder="https://..."/>
    <div style={{marginBottom:16}}>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>PDF oder Foto hochladen (optional)</label>
      <input type="file" accept="application/pdf,image/*" onChange={handlePlanFile} style={{fontSize:13,fontFamily:"inherit"}}/>
      {form.planFileName&&<div style={{fontSize:12,color:C.primary,marginTop:8,fontWeight:600}}>📎 {form.planFileName}</div>}
    </div>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={()=>setStep("general")} variant="secondary">← Zurück</Btn>
      <Btn onClick={saveExternal}><CheckSquare size={14}/> Turnier speichern</Btn>
    </div>
  </div>);

  // STEP 1: Club setup
  if(step==="clubs") return(<div>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
      <button onClick={()=>setStep("general")} style={{padding:"5px 10px",borderRadius:8,border:`1px solid ${C.border}`,background:"white",cursor:"pointer",fontFamily:"inherit",fontSize:13,color:C.muted}}>← Zurück</button>
      <div style={{fontWeight:800,fontSize:16,color:C.text,flex:1}}>{form.name}</div>
    </div>
    <div style={{marginBottom:14}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Spieldauer (Min)</label><Stepper value={form.matchDuration} onChange={v=>set("matchDuration",v)} min={3} max={30}/></div>
        <div><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Felder</label><Stepper value={form.fields} onChange={v=>set("fields",v)} min={1} max={6}/></div>
        <div><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Kinder/Team</label><Stepper value={form.defaultTeamSize} onChange={v=>set("defaultTeamSize",v)} min={1} max={12}/></div>
        <div><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Pause zw. Spielen (Min)</label><Stepper value={form.defaultPause} onChange={v=>set("defaultPause",v)} min={0} max={15}/></div>
      </div>
    </div>

    <div style={{marginBottom:16}}>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>Vereine & Teams</label>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:10}}>
        {clubs.map((cl,ci)=><div key={cl.id} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 12px",borderRadius:10,background:"#f8fafc",border:`1.5px solid ${C.border}`}}>
          <span style={{fontSize:18,flexShrink:0}}>🏛</span>
          <input value={cl.name} onChange={e=>setClubs(cs=>cs.map(c=>c.id===cl.id?{...c,name:e.target.value}:c))}
            placeholder="Vereinsname" style={{flex:1,border:"none",background:"transparent",fontSize:14,fontWeight:700,color:C.text,outline:"none"}}/>
          <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
            <span style={{fontSize:12,color:C.muted,fontWeight:600}}>Teams:</span>
            <Stepper value={cl.count} onChange={v=>setClubs(cs=>cs.map(c=>c.id===cl.id?{...c,count:Math.max(1,v)}:c))} min={1} max={8}/>
          </div>
          {clubs.length>1&&<button onClick={()=>setClubs(cs=>cs.filter(c=>c.id!==cl.id))} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:2,lineHeight:1,flexShrink:0}}>✕</button>}
        </div>)}
      </div>
      <Btn sm variant="secondary" onClick={()=>setClubs(cs=>[...cs,{id:uid(),name:"",count:1}])}><Plus size={13}/> Verein hinzufügen</Btn>
      {/* Preview */}
      {clubs.some(c=>c.name.trim())&&<div style={{marginTop:12,padding:"10px 12px",borderRadius:8,background:"white",border:`1px solid ${C.border}`}}>
        <div style={{fontSize:11,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.5}}>Vorschau Teams</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
          {buildTeamsFromClubs().map((t,i)=><span key={i} style={{fontSize:12,padding:"2px 10px",borderRadius:20,background:t.color+"33",border:`1px solid ${t.color}66`,color:C.text,fontWeight:600}}>{t.name}</span>)}
        </div>
        <div style={{fontSize:11,color:C.muted,marginTop:6}}>{buildTeamsFromClubs().length} Teams · {buildTeamsFromClubs().length*(buildTeamsFromClubs().length-1)/2} mögliche Spiele</div>
      </div>}
    </div>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      <Btn onClick={goToTeams} disabled={!form.name.trim()||buildTeamsFromClubs().length<2}>Weiter →</Btn>
    </div>
  </div>);

  // STEP 2: Team names + exclusions
  return(<div>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
      <button onClick={()=>setStep("clubs")} style={{padding:"5px 10px",borderRadius:8,border:`1px solid ${C.border}`,background:"white",cursor:"pointer",fontFamily:"inherit",fontSize:13,color:C.muted}}>← Zurück</button>
      <div style={{fontWeight:800,fontSize:16,color:C.text,flex:1}}>{form.name}</div>
    </div>

    {/* Team list grouped by club */}
    <div style={{marginBottom:14}}>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>Teams ({teams.length})</label>
      {/* Group by club */}
      {Object.entries(teams.reduce((g,t)=>{const k=t.club||"Ohne Verein";if(!g[k])g[k]=[];g[k].push(t);return g;},{})).map(([club,clubTeams])=>(
        <div key={club} style={{marginBottom:10}}>
          <div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.5,marginBottom:4}}>🏛 {club}</div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {clubTeams.map(t=><div key={t.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderRadius:8,background:"#f8fafc",border:`1.5px solid ${C.border}`}}>
              <div style={{width:14,height:14,borderRadius:"50%",background:t.color,flexShrink:0}}/>
              <input value={t.name} onChange={e=>updateTeam(t.id,"name",e.target.value)}
                style={{flex:1,border:"none",background:"transparent",fontSize:14,fontWeight:600,color:C.text,outline:"none"}}/>
            </div>)}
          </div>
        </div>
      ))}
    </div>

    {/* Exclusions */}
    <div style={{marginBottom:14}}>
      <button onClick={()=>setShowExclusions(v=>!v)} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,fontWeight:700,color:C.primary,background:"none",border:"none",cursor:"pointer",padding:0,fontFamily:"inherit",marginBottom:showExclusions?10:0}}>
        {showExclusions?"▲":"▼"} Paarungen verwalten
        {(excludePairs.length>0||sameClubPairs.length>0)&&<span style={{fontSize:11,padding:"1px 7px",borderRadius:20,background:C.accentL,color:C.primary,marginLeft:4}}>{allExcluded.length-clubOverrides.length} ausgeschlossen</span>}
      </button>
      {showExclusions&&<div style={{display:"flex",flexDirection:"column",gap:4}}>
        {teams.map((t1,i)=>teams.slice(i+1).map(t2=>{
          const excl=isPairExcluded(t1.id,t2.id);
          const sameClub=t1.club&&t2.club&&t1.club.trim()&&t1.club.trim()===t2.club.trim();
          const key=[t1.id,t2.id].sort().join("|");
          const overridden=clubOverrides.includes(key);
          if(sameClub) return(
            <div key={key} onClick={()=>setClubOverrides(prev=>overridden?prev.filter(k=>k!==key):[...prev,key])}
              style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,border:`1.5px solid ${overridden?"#bbf7d0":"#bfdbfe"}`,background:overridden?"#f0fdf4":"#eff6ff",cursor:"pointer"}}>
              <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${overridden?"#16a34a":"#3b82f6"}`,background:overridden?"#16a34a":"#3b82f6",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <span style={{color:"white",fontSize:10,lineHeight:1}}>{overridden?"✓":"🏛"}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}>
                <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:t1.color}}/><span style={{fontSize:13,fontWeight:600,color:C.text}}>{t1.name}</span>
                <span style={{color:C.muted,fontSize:12}}>vs</span>
                <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:t2.color}}/><span style={{fontSize:13,fontWeight:600,color:C.text}}>{t2.name}</span>
              </div>
              <span style={{fontSize:11,fontWeight:700,color:overridden?"#16a34a":"#1e40af"}}>{overridden?"✓ Wird gespielt":"🏛 Gleicher Verein"}</span>
            </div>);
          return(
            <div key={key} onClick={()=>togglePair(t1.id,t2.id)}
              style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,border:`1.5px solid ${excl?"#fca5a5":C.border}`,background:excl?"#fff5f5":"white",cursor:"pointer"}}>
              <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${excl?"#ef4444":C.border}`,background:excl?"#ef4444":"white",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {excl&&<span style={{color:"white",fontSize:11,lineHeight:1}}>✕</span>}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}>
                <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:t1.color}}/><span style={{fontSize:13,fontWeight:600,color:C.text}}>{t1.name}</span>
                <span style={{color:C.muted,fontSize:12}}>vs</span>
                <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:t2.color}}/><span style={{fontSize:13,fontWeight:600,color:C.text}}>{t2.name}</span>
              </div>
              {excl&&<span style={{fontSize:11,color:"#ef4444",fontWeight:700}}>Ausgeschlossen</span>}
            </div>);
        }))}
      </div>}
    </div>

    <div style={{fontSize:12,color:C.muted,marginBottom:14}}>→ {effectiveMatches()} Spiele (Round Robin{allExcluded.length-clubOverrides.length>0?`, ${allExcluded.length-clubOverrides.length} Paar${allExcluded.length-clubOverrides.length>1?"e":""} ausgeschlossen`:""})</div>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      <Btn onClick={()=>{
        if(!form.name.trim()||teams.length<2)return;
        onSave({...form,id:uid(),createdAt:now(),teams,excludePairs,clubOverrides,matches:generateRR(teams,excludePairs,clubOverrides).map(m=>({...m,leg:1}))});
      }} disabled={teams.length<2}>Turnier erstellen</Btn>
    </div>
  </div>);
}

function RueckrundeForm({teams,baseExcludePairs,baseClubOverrides,onSave,onClose}) {
  const [mode,setMode]=useState("same"); // same | custom
  const [excludePairs,setExcludePairs]=useState(baseExcludePairs);
  const [clubOverrides,setClubOverrides]=useState(baseClubOverrides);
  const togglePair=(a,b)=>{
    const key=[a,b].sort().join("|");
    setExcludePairs(prev=>prev.some(p=>p.sort().join("|")===key)?prev.filter(p=>p.sort().join("|")!==key):[...prev,[a,b]]);
  };
  const isPairExcluded=(a,b)=>excludePairs.some(p=>p.sort().join("|")===[a,b].sort().join("|"));
  const sameClubPairs=[];
  teams.forEach((t1,i)=>teams.forEach((t2,j)=>{
    if(i>=j)return;
    if(t1.club&&t2.club&&t1.club.trim()&&t1.club.trim()===t2.club.trim())
      sameClubPairs.push([t1.id,t2.id]);
  }));
  const allExcluded=[...excludePairs,...sameClubPairs];
  const effectiveMatches=()=>{
    const excl=new Set([...excludePairs,...sameClubPairs].map(([a,b])=>[a,b].sort().join("|")));
    clubOverrides.forEach(k=>excl.delete(k));
    let c=0;
    for(let i=0;i<teams.length;i++) for(let j=i+1;j<teams.length;j++)
      if(!excl.has([teams[i].id,teams[j].id].sort().join("|"))) c++;
    return c;
  };
  return(<div>
    <div style={{background:"#f0f9ff",borderRadius:10,padding:"10px 14px",marginBottom:16,border:"1px solid #bae6fd",fontSize:13,color:"#0369a1"}}>
      Erstellt eine zweite Runde (Rückrunde) zusätzlich zur bestehenden Hinrunde. Die Tabelle summiert danach automatisch beide Runden.
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
      <div onClick={()=>setMode("same")} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:10,border:`1.5px solid ${mode==="same"?C.primary:C.border}`,background:mode==="same"?C.accentL:"white",cursor:"pointer"}}>
        <div style={{width:18,height:18,borderRadius:"50%",border:`2px solid ${mode==="same"?C.primary:C.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{mode==="same"&&<div style={{width:9,height:9,borderRadius:"50%",background:C.primary}}/>}</div>
        <div><div style={{fontWeight:700,fontSize:14,color:C.text}}>Gleiche Kriterien</div><div style={{fontSize:12,color:C.muted}}>Gleiche Paarungen wie Hinrunde, Heim/Auswärts getauscht</div></div>
      </div>
      <div onClick={()=>setMode("custom")} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:10,border:`1.5px solid ${mode==="custom"?C.primary:C.border}`,background:mode==="custom"?C.accentL:"white",cursor:"pointer"}}>
        <div style={{width:18,height:18,borderRadius:"50%",border:`2px solid ${mode==="custom"?C.primary:C.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{mode==="custom"&&<div style={{width:9,height:9,borderRadius:"50%",background:C.primary}}/>}</div>
        <div><div style={{fontWeight:700,fontSize:14,color:C.text}}>Veränderte Kriterien</div><div style={{fontSize:12,color:C.muted}}>Neue Paarungen mit angepassten Ausschlüssen erstellen</div></div>
      </div>
    </div>
    {mode==="custom"&&<div style={{marginBottom:14}}>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>Paarungen für die Rückrunde</label>
      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        {teams.map((t1,i)=>teams.slice(i+1).map(t2=>{
          const excl=isPairExcluded(t1.id,t2.id);
          const sameClub=t1.club&&t2.club&&t1.club.trim()&&t1.club.trim()===t2.club.trim();
          const key=[t1.id,t2.id].sort().join("|");
          const overridden=clubOverrides.includes(key);
          if(sameClub) return(
            <div key={key} onClick={()=>setClubOverrides(prev=>overridden?prev.filter(k=>k!==key):[...prev,key])}
              style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,border:`1.5px solid ${overridden?"#bbf7d0":"#bfdbfe"}`,background:overridden?"#f0fdf4":"#eff6ff",cursor:"pointer"}}>
              <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${overridden?"#16a34a":"#3b82f6"}`,background:overridden?"#16a34a":"#3b82f6",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <span style={{color:"white",fontSize:10,lineHeight:1}}>{overridden?"✓":"🏛"}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}>
                <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:t1.color}}/><span style={{fontSize:13,fontWeight:600,color:C.text}}>{t1.name}</span>
                <span style={{color:C.muted,fontSize:12}}>vs</span>
                <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:t2.color}}/><span style={{fontSize:13,fontWeight:600,color:C.text}}>{t2.name}</span>
              </div>
              <span style={{fontSize:11,fontWeight:700,color:overridden?"#16a34a":"#1e40af"}}>{overridden?"✓ Wird gespielt":"🏛 Gleicher Verein"}</span>
            </div>);
          return(
            <div key={key} onClick={()=>togglePair(t1.id,t2.id)}
              style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,border:`1.5px solid ${excl?"#fca5a5":C.border}`,background:excl?"#fff5f5":"white",cursor:"pointer"}}>
              <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${excl?"#ef4444":C.border}`,background:excl?"#ef4444":"white",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {excl&&<span style={{color:"white",fontSize:11,lineHeight:1}}>✕</span>}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}>
                <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:t1.color}}/><span style={{fontSize:13,fontWeight:600,color:C.text}}>{t1.name}</span>
                <span style={{color:C.muted,fontSize:12}}>vs</span>
                <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:t2.color}}/><span style={{fontSize:13,fontWeight:600,color:C.text}}>{t2.name}</span>
              </div>
              {excl&&<span style={{fontSize:11,color:"#ef4444",fontWeight:700}}>Ausgeschlossen</span>}
            </div>);
        }))}
      </div>
      <div style={{fontSize:12,color:C.muted,marginTop:10}}>→ {effectiveMatches()} Spiele in der Rückrunde{allExcluded.length-clubOverrides.length>0?`, ${allExcluded.length-clubOverrides.length} Paar${allExcluded.length-clubOverrides.length>1?"e":""} ausgeschlossen`:""}</div>
    </div>}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      <Btn onClick={()=>onSave({mode,excludePairs,clubOverrides})}>Rückrunde erstellen</Btn>
    </div>
  </div>);
}

function PauseEditor({round,value,defaultVal,isCustom,onChange}) {
  const setVal=v=>{const u={};u[round]=v;onChange(p=>Object.assign({},p,u));};
  const reset=()=>{const u={};u[round]=defaultVal;onChange(p=>Object.assign({},p,u));};
  return(<div style={{display:"flex",alignItems:"center",gap:10,padding:"6px 12px"}}>
    <div style={{flex:1,height:1,background:"#e2e8f0"}}/>
    <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
      <span style={{fontSize:11,color:"#64748b"}}>⏸ Pause:</span>
      <Stepper value={value} onChange={setVal} min={0} max={30}/>
      <span style={{fontSize:11,color:"#64748b"}}>Min</span>
      {isCustom&&<button onClick={reset} style={{fontSize:10,padding:"1px 6px",borderRadius:10,border:"1px solid #e2e8f0",background:"white",cursor:"pointer",color:"#64748b",fontFamily:"inherit"}}>Reset</button>}
    </div>
    <div style={{flex:1,height:1,background:"#e2e8f0"}}/>
  </div>);
}

// ── TURNIER BEARBEITEN (Allgemein + optional Spieler/Teams bei externer Ausrichtung) ──
function TournamentEditWizard({tournament,players,onSavePlayer,onSave,onClose}) {
  const [form,setForm]=useState({...tournament});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const isExternal=form.hosting==="other";
  const totalSteps=isExternal?3:1;
  const [step,setStep]=useState(1);
  const [playerIds,setPlayerIds]=useState(tournament.playerIds||[]);
  const [teams,setTeams]=useState(tournament.hosting==="other"?(tournament.teams||[]):[]);
  const [newName,setNewName]=useState("");
  const [confirmPlayer,setConfirmPlayer]=useState(null);
  const [newPlayerFormOpen,setNewPlayerFormOpen]=useState(false);

  const handlePlanFile=e=>{
    const file=e.target.files?.[0];
    if(!file)return;
    const reader=new FileReader();
    reader.onload=()=>setForm(f=>({...f,planFileData:reader.result,planFileName:file.name,planFileType:file.type}));
    reader.readAsDataURL(file);
  };
  const addPlayer=()=>{
    if(!newName.trim())return;
    setConfirmPlayer({id:uid(),name:newName.trim()});
    setNewName("");
  };
  const addAsGuest=()=>{
    if(!confirmPlayer)return;
    onSavePlayer?.({...EMPTY_PLAYER,id:confirmPlayer.id,name:confirmPlayer.name,active:false,guest:true,createdAt:now()});
    setPlayerIds(v=>[...v,confirmPlayer.id]);
    setConfirmPlayer(null);
  };
  const teamBuilderPlayers=playerIds.length?players.filter(p=>playerIds.includes(p.id)):players.filter(p=>p.active);
  const finish=(extra)=>onSave({...form,...(isExternal?{playerIds,teams}:{}),...(extra||{})});
  const stepLabel=step===1?"Allgemein":step===2?"Spieler":"Teams";

  return(<div>
    {totalSteps>1&&<>
      <div style={{display:"flex",gap:6,marginBottom:6}}>{[1,2,3].map(n=><div key={n} style={{flex:1,height:4,borderRadius:2,background:n<=step?C.primary:C.border}}/>)}</div>
      <div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:18}}>Schritt {step} von {totalSteps} · {stepLabel}</div>
    </>}

    {step===1&&<div>
      <Inp label="Turniername *" value={form.name} onChange={e=>set("name",e.target.value)}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <Inp label="Datum" type="date" value={form.date} onChange={e=>set("date",e.target.value)}/>
        <Inp label="Uhrzeit" type="time" value={form.startTime||""} onChange={e=>set("startTime",e.target.value)}/>
      </div>
      <Inp label="Ort" value={form.location||""} onChange={e=>set("location",e.target.value)} placeholder="z.B. Sportplatz..."/>
      <Inp label="Gegen wen / teilnehmende Vereine" value={form.opponent||""} onChange={e=>set("opponent",e.target.value)}/>
      <Sel label="Untergrund" value={form.surface||""} onChange={e=>set("surface",e.target.value)}>
        <option value="">– auswählen –</option>
        <option value="rasen">Rasen</option>
        <option value="kunstrasen">Kunstrasen</option>
        <option value="halle">Halle</option>
        <option value="asche">Asche</option>
      </Sel>
      <Txta label="Notizen (optional)" value={form.notes||""} onChange={e=>set("notes",e.target.value)} rows={2}/>
      <div style={{marginTop:4,marginBottom:16}}>
        <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>Wer richtet das Turnier aus?</label>
        <div style={{display:"flex",gap:8}}>
          {[["self","🏠 Wir selbst"],["other","🤝 Anderer Verein"]].map(([v,l])=><button key={v} onClick={()=>set("hosting",v)} style={{flex:1,padding:"10px 8px",borderRadius:8,border:`2px solid ${form.hosting===v?C.primary:C.border}`,background:form.hosting===v?C.accentL:"white",color:form.hosting===v?C.primary:C.muted,cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit"}}>{l}</button>)}
        </div>
      </div>
      {isExternal&&<div>
        <Inp label="Link zum Turnierplan (optional)" value={form.planLink||""} onChange={e=>set("planLink",e.target.value)} placeholder="https://..."/>
        <div style={{marginBottom:14}}>
          <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:.6}}>PDF oder Foto hochladen (optional)</label>
          <input type="file" accept="application/pdf,image/*" onChange={handlePlanFile} style={{fontSize:13,fontFamily:"inherit"}}/>
          {form.planFileName&&<div style={{fontSize:12,color:C.primary,marginTop:8,fontWeight:600}}>📎 {form.planFileName}</div>}
        </div>
      </div>}
      <div style={{display:"flex",gap:8,paddingTop:16,borderTop:`1px solid ${C.border}`,flexWrap:"nowrap"}}>
        <Btn onClick={onClose} variant="secondary" sm style={{flex:1,justifyContent:"center"}}>Abbrechen</Btn>
        {isExternal?<>
          <Btn onClick={()=>finish()} variant="secondary" sm style={{flex:1,justifyContent:"center"}} disabled={!form.name.trim()}><CheckSquare size={13}/> Speichern</Btn>
          <Btn onClick={()=>setStep(2)} sm style={{flex:1,justifyContent:"center"}} disabled={!form.name.trim()}>Weiter →</Btn>
        </>:<Btn onClick={()=>finish()} sm style={{flex:1,justifyContent:"center"}} disabled={!form.name.trim()}><CheckSquare size={13}/> Speichern</Btn>}
      </div>
    </div>}

    {step===2&&<div>
      <label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:.6}}>Spieler <span style={{fontWeight:400,textTransform:"none"}}>(optional – Weiter zum Überspringen)</span></label>
      <div style={{marginBottom:14}}>
        <PlayerList players={players} selPlayers={playerIds} setSelPlayers={setPlayerIds} showStrength/>
      </div>
      {!confirmPlayer?<div style={{display:"flex",gap:8,marginBottom:16}}>
        <input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addPlayer()} placeholder="Neuer Spieler – Name eingeben..." style={{flex:1,padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,fontFamily:"inherit",outline:"none",background:"white",color:C.text}}/>
        <Btn variant="secondary" onClick={addPlayer}><Plus size={14}/> Hinzufügen</Btn>
      </div>:<div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px 14px",marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:700,color:"#92400e",marginBottom:10}}>„{confirmPlayer.name}" wie hinzufügen?</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn sm onClick={()=>setNewPlayerFormOpen(true)}>Zum Team hinzufügen</Btn>
          <Btn sm variant="secondary" onClick={addAsGuest}>Gastspieler</Btn>
        </div>
      </div>}
      {newPlayerFormOpen&&confirmPlayer&&<Modal title="Neuer Spieler" onClose={()=>{setNewPlayerFormOpen(false);setConfirmPlayer(null);}}>
        <PlayerForm player={{name:confirmPlayer.name}} onSave={p=>{onSavePlayer?.(p);setPlayerIds(v=>[...v,p.id]);setNewPlayerFormOpen(false);setConfirmPlayer(null);}} onClose={()=>{setNewPlayerFormOpen(false);setConfirmPlayer(null);}}/>
      </Modal>}
      <div style={{display:"flex",gap:8,paddingTop:16,borderTop:`1px solid ${C.border}`,flexWrap:"nowrap"}}>
        <Btn onClick={()=>setStep(1)} variant="secondary" sm style={{flex:1,justifyContent:"center"}}>← Zurück</Btn>
        <Btn onClick={()=>finish()} variant="secondary" sm style={{flex:1,justifyContent:"center"}}><CheckSquare size={13}/> Speichern</Btn>
        <Btn onClick={()=>setStep(3)} sm style={{flex:1,justifyContent:"center"}}>Weiter →</Btn>
      </div>
    </div>}

    {step===3&&<div>
      <div style={{fontSize:12,color:C.muted,marginBottom:10}}>(optional – Teams können hier direkt für das Turnier gebildet werden. „Schließen" speichert ohne Team-Änderung.)</div>
      <TeamBuilderModal availablePlayers={teamBuilderPlayers} onSaveTeams={(tm)=>finish({teams:tm})} onClose={()=>finish()} actionLabel="✓ Fertig"/>
      <div style={{display:"flex",gap:8,paddingTop:16,marginTop:12,borderTop:`1px solid ${C.border}`,flexWrap:"nowrap"}}>
        <Btn onClick={()=>setStep(2)} variant="secondary" sm style={{flex:1,justifyContent:"center"}}>← Zurück</Btn>
      </div>
    </div>}
  </div>);
}

function TournamentDetail({tournament:t,onUpdate,onBack,coaches=[],toast,players,onSavePlayer}) {
  const [tab,setTab]=useState("plan");
  const [sc,setSc]=useState(Object.fromEntries(t.matches.map(m=>[m.id,{h:m.homeScore??0,a:m.awayScore??0}])));
  // Startzeit/Pause/Trainer-Zuweisung werden aus dem Turnier initialisiert UND bei jeder Änderung sofort zurückgeschrieben,
  // damit sie beim Verlassen/Wiederöffnen des Turniers erhalten bleiben (statt immer auf Default zu resetten).
  const [startTime,setStartTimeLocal]=useState(t.startTime||"10:00");
  const [pauseMin,setPauseMinLocal]=useState(t.pauseMin??t.defaultPause??2);
  const [slotPauses,setSlotPausesLocal]=useState(t.slotPauses||{});
  const [coachAssign,setCoachAssignLocal]=useState(t.coachAssign||{});
  const setStartTime=v=>{setStartTimeLocal(v);onUpdate({...t,startTime:v});};
  const setPauseMin=v=>{setPauseMinLocal(v);onUpdate({...t,pauseMin:v});};
  const setSlotPauses=fn=>{setSlotPausesLocal(prev=>{const next=typeof fn==="function"?fn(prev):fn;onUpdate({...t,slotPauses:next});return next;});};
  const assignCoach=(fi,cid)=>{setCoachAssignLocal(a=>{const next={...a,[fi]:cid};onUpdate({...t,coachAssign:next});return next;});};
  const [rueckrundeModal,setRueckrundeModal]=useState(false);
  const [editModal,setEditModal]=useState(false);
  const gt=id=>t.teams.find(x=>x.id===id);
  const fields=t.fields||1;
  const adjScore=(mId,side,delta)=>setSc(s=>({...s,[mId]:{...s[mId],[side]:Math.max(0,(s[mId]?.[side]||0)+delta)}}));
  const save=mId=>{ const s=sc[mId],h=Number(s.h),a=Number(s.a);if(isNaN(h)||isNaN(a))return;onUpdate({...t,matches:t.matches.map(m=>m.id===mId?{...m,homeScore:h,awayScore:a,played:true}:m)}); };
  const standings=calcStandings(t.teams,t.matches);
  const played=t.matches.filter(m=>m.played).length;
  const hasRueckrunde=t.matches.some(m=>m.leg===2);
  // Live-Vorschau (übernimmt sofortige lokale Änderungen, auch bevor onUpdate zurückgespiegelt wurde)
  const buildSchedule=()=>computeTournamentSchedule({...t,startTime,pauseMin,slotPauses});
  const fmtTime=fmtTimeHM;
  const [expandedField,setExpandedField]=useState(null);
  const tb=(k,l)=><button onClick={()=>setTab(k)} style={{padding:"7px 16px",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit",background:tab===k?C.primary:"transparent",color:tab===k?"white":C.muted}}>{l}</button>;

  // ── PDF: Teams + Zeitplan + Übersicht zusammengefasst ──────────
  const printTournament=()=>{
    const liveT={...t,startTime,pauseMin,slotPauses,coachAssign};
    const {meta,teamsHtml,zpHtml,ueHtml}=buildTournamentPdfSections(liveT,coaches);
    const css=`${PDF_CSS}
      .sec-title{font-size:16px;font-weight:900;margin:22px 0 12px;padding-top:14px;border-top:2px solid #e2e8f0}
      .sec-title:first-of-type{border-top:none;margin-top:0;padding-top:0}
      @media print{.pagebreak{page-break-before:always}}`;
    const html=`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>${escHtml(t.name)} – Turnierplan</title><style>${css}</style></head><body>
      <h1>🏆 ${escHtml(t.name)}</h1>
      <div class="meta">${meta}</div>
      <div class="sec-title">👥 Teams &amp; Spielplan pro Team</div>
      ${teamsHtml}
      <div class="sec-title pagebreak">🗓 Zeitplan (chronologisch)</div>
      ${zpHtml}
      <div class="sec-title pagebreak">📊 Übersicht (gleichzeitige Spiele)</div>
      ${ueHtml}
      <div class="footer">Erstellt mit G-Jugend Coach App · ${new Date().toLocaleDateString("de-DE")}</div>
      ${PDF_SCRIPT}
    </body></html>`;
    openPdf(html,`Turnierplan_${(t.name||"Turnier").replace(/[^a-z0-9]+/gi,"_")}_${t.date||todayISO()}.html`,toast);
  };

  // ── Rückrunde erstellen (Hin-/Rückrunde) ──────────────────────
  const createRueckrunde=({mode,excludePairs,clubOverrides})=>{
    let leg2;
    if(mode==="same"){
      // Gleiche Paarungen, Heim/Auswärts getauscht
      leg2=t.matches.filter(m=>m.leg!==2).map(m=>({id:uid(),homeId:m.awayId,awayId:m.homeId,homeScore:null,awayScore:null,played:false,leg:2}));
    } else {
      // Neue Paarungen nach angepassten Ausschlusskriterien
      leg2=generateRR(t.teams,excludePairs,clubOverrides).map(m=>({...m,leg:2}));
    }
    const leg1=t.matches.filter(m=>m.leg!==2).map(m=>({...m,leg:m.leg||1}));
    onUpdate({...t,matches:[...leg1,...leg2]});
    setSc(s=>({...s,...Object.fromEntries(leg2.map(m=>[m.id,{h:0,a:0}]))}));
    setRueckrundeModal(false);
    toast?.("Rückrunde erstellt ✓");
  };

  const SURFACE_LABELS={rasen:"Rasen",kunstrasen:"Kunstrasen",halle:"Halle",asche:"Asche"};
  return(<div>
    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,flexWrap:"wrap"}}>
      <button onClick={onBack} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,fontSize:14,display:"flex",alignItems:"center",gap:4}}>← Zurück</button>
      <div style={{flex:1}}><h2 style={{margin:0,fontSize:20,fontWeight:900,color:C.text}}>{t.name}</h2><div style={{fontSize:13,color:C.muted}}>{t.hosting==="other"?`${fmtDate(t.date)}${t.location?` · 📍 ${t.location}`:""}${t.opponent?` · ⚽ ${t.opponent}`:""}`:`${fmtDate(t.date)} · ${t.teams.length} Teams · ${played}/${t.matches.length} Spiele · ${t.matchDuration} Min/Spiel${hasRueckrunde?" · 🔁 Hin- & Rückrunde":""}`}</div></div>
      {t.hosting!=="other"&&!hasRueckrunde&&<Btn sm variant="secondary" onClick={()=>setRueckrundeModal(true)}>🔁 Rückrunde erstellen</Btn>}
      {t.hosting!=="other"&&<Btn sm variant="secondary" onClick={printTournament}>🖨️ Turnierplan PDF</Btn>}
      <Btn sm variant="secondary" onClick={()=>setEditModal(true)}><Edit2 size={13}/> Bearbeiten</Btn>
    </div>
    {editModal&&<Modal title="Turnier bearbeiten" onClose={()=>setEditModal(false)} wide><TournamentEditWizard tournament={t} players={players} onSavePlayer={onSavePlayer} onSave={upd=>{onUpdate({...t,...upd});setEditModal(false);toast?.("Turnier gespeichert");}} onClose={()=>setEditModal(false)}/></Modal>}
    {t.hosting==="other"?(
      <div style={{background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,padding:"16px 18px"}}>
        <div style={{fontSize:13,color:C.muted,marginBottom:12}}>🤝 Dieses Turnier wird von einem anderen Verein ausgerichtet.</div>
        {t.surface&&<div style={{fontSize:14,marginBottom:6,color:C.text}}>🌱 Untergrund: {SURFACE_LABELS[t.surface]||t.surface}</div>}
        {t.notes&&<div style={{fontSize:13,color:C.muted,marginTop:8,fontStyle:"italic"}}>{t.notes}</div>}
        <div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Turnierplan</div>
          {t.planLink&&<div style={{marginBottom:8}}><a href={t.planLink} target="_blank" rel="noopener noreferrer" style={{color:C.primary,fontWeight:700,fontSize:14}}>🔗 {t.planLink}</a></div>}
          {t.planFileData&&<div>
            {t.planFileType?.startsWith("image/")?<img src={t.planFileData} alt="Turnierplan" style={{maxWidth:"100%",borderRadius:8,border:`1px solid ${C.border}`}}/>:
              <a href={t.planFileData} download={t.planFileName||"Turnierplan.pdf"} style={{color:C.primary,fontWeight:700,fontSize:14}}>📎 {t.planFileName||"Datei öffnen"}</a>}
          </div>}
          {!t.planLink&&!t.planFileData&&<div style={{fontSize:13,color:C.muted,fontStyle:"italic"}}>Noch kein Turnierplan hinterlegt.</div>}
        </div>
        <div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Teilnehmende Spieler</div>
          {(t.playerIds||[]).length===0?<div style={{fontSize:13,color:C.muted,fontStyle:"italic"}}>Noch keine Spieler ausgewählt.</div>:
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {(t.playerIds||[]).map(id=>{const p=(players||[]).find(pl=>pl.id===id);return p?<span key={id} style={{padding:"3px 10px",borderRadius:20,background:p.guest?"#e0e7ff":C.accentL,color:p.guest?"#4338ca":C.primary,fontSize:12,fontWeight:700}}>{p.guest?"🎫 ":`${STR[p.strength]?.emoji} `}{p.name}{p.guest?" (Gast)":""}</span>:null;})}
            </div>}
        </div>
        {(t.teams||[]).length>0&&<div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Teams</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10}}>
            {t.teams.map(tm=><div key={tm.id} style={{background:"#f8fafc",borderRadius:10,border:`1.5px solid ${C.border}`,padding:"10px 12px"}}>
              <div style={{fontWeight:800,fontSize:13,color:C.text,marginBottom:6}}>{tm.name}</div>
              {(tm.players||[]).map(p=><div key={p.id} style={{fontSize:12,color:C.muted}}>{p.name}</div>)}
            </div>)}
          </div>
        </div>}
      </div>
    ):(<>
    {rueckrundeModal&&<Modal title="Rückrunde erstellen" onClose={()=>setRueckrundeModal(false)} wide><RueckrundeForm teams={t.teams} baseExcludePairs={t.excludePairs||[]} baseClubOverrides={t.clubOverrides||[]} onSave={createRueckrunde} onClose={()=>setRueckrundeModal(false)}/></Modal>}
    <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:10,padding:4,marginBottom:20,width:"fit-content",flexWrap:"wrap"}}>{tb("plan","Spielplan")}{tb("teams","Teams")}{tb("schedule","Zeitplan")}{tb("uebersicht","Übersicht")}{tb("table","Tabelle")}</div>
    {tab==="plan"&&<div style={{display:"flex",flexDirection:"column",gap:8}}>
      {t.matches.map((m,i)=>{ const field=(i%fields)+1; const h=gt(m.homeId),a=gt(m.awayId);if(!h||!a)return null;return(<div key={m.id} style={{background:C.card,borderRadius:10,border:`1.5px solid ${m.played?"#22c55e":C.border}`,padding:"12px 16px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{fontSize:12,color:C.muted,fontWeight:600,minWidth:60}}>#{i+1}{fields>1&&` · F${field}`}{hasRueckrunde&&<span style={{marginLeft:6,fontSize:9,fontWeight:800,padding:"1px 6px",borderRadius:10,background:m.leg===2?"#f3e8ff":"#eff6ff",color:m.leg===2?"#7c3aed":"#1d4ed8"}}>{m.leg===2?"RÜCK":"HIN"}</span>}</div>
        <div style={{display:"flex",alignItems:"center",gap:10,flex:1,justifyContent:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:700,fontSize:15}}><div style={{width:12,height:12,borderRadius:"50%",background:h.color}}/>{h.name}</div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{display:"flex",alignItems:"center",border:`1.5px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
              <button onClick={()=>adjScore(m.id,"h",-1)} style={{width:28,height:32,border:"none",cursor:"pointer",background:"#f1f5f9",fontSize:14,color:C.muted,display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
              <div style={{width:32,textAlign:"center",fontWeight:800,fontSize:16,color:C.text}}>{sc[m.id]?.h??0}</div>
              <button onClick={()=>adjScore(m.id,"h",1)} style={{width:28,height:32,border:"none",cursor:"pointer",background:"#f1f5f9",fontSize:14,color:C.text,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
            </div>
            <span style={{fontWeight:700,color:C.muted,fontSize:18}}>:</span>
            <div style={{display:"flex",alignItems:"center",border:`1.5px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
              <button onClick={()=>adjScore(m.id,"a",-1)} style={{width:28,height:32,border:"none",cursor:"pointer",background:"#f1f5f9",fontSize:14,color:C.muted,display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
              <div style={{width:32,textAlign:"center",fontWeight:800,fontSize:16,color:C.text}}>{sc[m.id]?.a??0}</div>
              <button onClick={()=>adjScore(m.id,"a",1)} style={{width:28,height:32,border:"none",cursor:"pointer",background:"#f1f5f9",fontSize:14,color:C.text,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:700,fontSize:15}}>{a.name}<div style={{width:12,height:12,borderRadius:"50%",background:a.color}}/></div>
        </div>
        <Btn sm onClick={()=>save(m.id)}>{m.played?"✓ Update":"Eintragen"}</Btn>
      </div>);})}
    </div>}
    {tab==="teams"&&<div style={{display:"flex",flexDirection:"column",gap:14}}>
      {t.teams.map(team=>{
        const tm=t.matches.filter(m=>m.homeId===team.id||m.awayId===team.id);
        const schedule=buildSchedule();
        return(<div key={team.id} style={{background:C.card,borderRadius:12,border:`2px solid ${team.color}55`,overflow:"hidden"}}>
          <div style={{padding:"10px 16px",background:team.color+"18",borderBottom:`1px solid ${team.color}33`,display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:14,height:14,borderRadius:"50%",background:team.color,flexShrink:0}}/>
            <span style={{fontWeight:800,fontSize:15,color:C.text}}>{team.name}</span>
            <span style={{fontSize:12,color:C.muted,marginLeft:"auto"}}>{tm.filter(m=>m.played).length}/{tm.length} Spiele</span>
          </div>
          <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:6}}>
            {tm.length===0?<div style={{fontSize:13,color:C.muted}}>Keine Spiele</div>:
              tm.map((m,i)=>{
                const isHome=m.homeId===team.id;
                const opp=gt(isHome?m.awayId:m.homeId);
                const slot=schedule.find(s=>s.match.id===m.id);
                const myScore=isHome?m.homeScore:m.awayScore;
                const oppScore=isHome?m.awayScore:m.homeScore;
                const result=m.played?(myScore>oppScore?"🏆":myScore===oppScore?"🤝":"❌"):null;
                return(<div key={m.id} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 10px",borderRadius:8,background:m.played?"#f8fafc":"white",border:`1px solid ${C.border}`,flexWrap:"wrap"}}>
                  {slot&&<span style={{fontSize:11,fontWeight:700,color:C.muted,minWidth:40}}>{fmtTime(slot.startMin)}</span>}
                  {fields>1&&slot&&<span style={{fontSize:11,color:C.muted}}>F{slot.field}</span>}
                  {hasRueckrunde&&<span style={{fontSize:9,fontWeight:800,padding:"1px 6px",borderRadius:10,background:m.leg===2?"#f3e8ff":"#eff6ff",color:m.leg===2?"#7c3aed":"#1d4ed8"}}>{m.leg===2?"RÜCK":"HIN"}</span>}
                  <div style={{display:"flex",alignItems:"center",gap:6,flex:1}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:opp?.color,flexShrink:0}}/>
                    <span style={{fontWeight:600,fontSize:13,color:C.text}}>vs. {opp?.name}</span>
                  </div>
                  {m.played?<span style={{fontSize:13,fontWeight:800,color:C.text}}>{result} {myScore}:{oppScore}</span>:<span style={{fontSize:12,color:C.muted}}>offen</span>}
                </div>);
              })}
          </div>
        </div>);
      })}
    </div>}
    {tab==="schedule"&&<div>
      <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:16,flexWrap:"wrap"}}>
        <div><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:.6}}>Startzeit</label><input type="time" value={startTime} onChange={e=>setStartTime(e.target.value)} style={{padding:"8px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,outline:"none",fontFamily:"inherit"}}/></div>
        <div><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:.6}}>Pause zw. Spielen (Min)</label><Stepper value={pauseMin} onChange={setPauseMin} min={0} max={15}/></div>
        <div style={{fontSize:13,color:C.muted,alignSelf:"center",paddingBottom:2}}>Spieldauer: {t.matchDuration} Min · {fields} Feld{fields>1?"er":""}</div>
      </div>
      {fields>1&&<div style={{display:"grid",gridTemplateColumns:Array.from({length:fields},(_,fi)=>expandedField===fi?"2.5fr":"1fr").join(" "),gap:10,marginBottom:16,transition:"grid-template-columns .25s"}}>
        {Array.from({length:fields},(_,fi)=>{
          const fieldSlots=buildSchedule().filter(s=>s.field===fi+1);
          return(<div key={fi} style={{background:C.card,borderRadius:10,border:`1.5px solid ${C.border}`,overflow:"hidden"}}>
            <button onClick={()=>setExpandedField(expandedField===fi?null:fi)} style={{display:"block",width:"100%",textAlign:"left",padding:"8px 12px",background:TCOLORS[fi]+"22",borderBottom:`1px solid ${C.border}`,fontWeight:800,fontSize:13,color:C.text,border:"none",cursor:"pointer",fontFamily:"inherit"}}>⚽ Feld {fi+1}{expandedField===fi?" ↙":" ↔"}</button>
            <div style={{padding:"8px 10px",display:"flex",flexDirection:"column",gap:4}}>
              {fieldSlots.map((sl,i)=>{const h=gt(sl.match.homeId),a=gt(sl.match.awayId);return(<div key={i} style={{fontSize:12,padding:"4px 8px",borderRadius:6,background:sl.match.played?"#f0fdf4":"#f8fafc",border:`1px solid ${C.border}`}}>
                <div style={{fontWeight:700,color:C.muted,marginBottom:2}}>{fmtTime(sl.startMin)}</div>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}><span style={{width:8,height:8,borderRadius:"50%",background:h?.color,display:"inline-block",flexShrink:0}}/><span style={{fontWeight:700,fontSize:12,wordBreak:"break-word"}}>{h?.name}</span></div>
                  <div style={{fontSize:10,color:C.muted,fontWeight:700,paddingLeft:12}}>vs.</div>
                  <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}><span style={{width:8,height:8,borderRadius:"50%",background:a?.color,display:"inline-block",flexShrink:0}}/><span style={{fontWeight:700,fontSize:12,wordBreak:"break-word"}}>{a?.name}</span></div>
                </div>
                {sl.match.played&&<div style={{fontSize:11,color:"#16a34a",fontWeight:700}}>{sl.match.homeScore}:{sl.match.awayScore} ✓</div>}
              </div>);})}
            </div>
          </div>);
        })}
      </div>}
      {fields===1&&<div style={{display:"flex",flexDirection:"column",gap:6}}>
        {buildSchedule().map((sl,i)=>{const h=gt(sl.match.homeId),a=gt(sl.match.awayId);return(<div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderRadius:8,background:sl.match.played?"#f0fdf4":C.card,border:`1.5px solid ${sl.match.played?"#22c55e":C.border}`,flexWrap:"wrap"}}>
          <span style={{fontSize:13,fontWeight:800,color:C.muted,minWidth:44}}>{fmtTime(sl.startMin)}</span>
          <div style={{display:"flex",alignItems:"center",gap:8,flex:1,justifyContent:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,flex:1,minWidth:0}}><div style={{width:10,height:10,borderRadius:"50%",background:h?.color,flexShrink:0}}/><span style={{fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h?.name}</span></div>
            {sl.match.played?<span style={{fontWeight:800,fontSize:15,color:C.text,flexShrink:0}}>{sl.match.homeScore}:{sl.match.awayScore}</span>:<span style={{color:C.muted,flexShrink:0}}>vs.</span>}
            <div style={{display:"flex",alignItems:"center",gap:6,flex:1,minWidth:0,justifyContent:"flex-end"}}><span style={{fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a?.name}</span><div style={{width:10,height:10,borderRadius:"50%",background:a?.color,flexShrink:0}}/></div>
          </div>
          <span style={{fontSize:12,color:C.muted}}>⏱ {t.matchDuration} Min</span>
        </div>);})}
      </div>}
    </div>}
    {tab==="uebersicht"&&<div>
      <div style={{background:"#f0f9ff",borderRadius:10,padding:"10px 14px",marginBottom:16,border:"1px solid #bae6fd",fontSize:13,color:"#0369a1"}}>
        Zeigt welche Teams gleichzeitig spielen und wie viele Kinder pro Feld aktiv sind. Weise optional Trainer den Feldern zu.
      </div>
      {/* Trainer-Zuweisung */}
      {coaches.length>0&&<div style={{marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Trainer-Zuweisung pro Feld</div>
        <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min(fields,3)},1fr)`,gap:8}}>
          {Array.from({length:fields},(_,fi)=>(
            <div key={fi} style={{padding:"8px 12px",borderRadius:8,background:TCOLORS[fi]+"18",border:`1.5px solid ${TCOLORS[fi]}44`}}>
              <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:6}}>⚽ Feld {fi+1}</div>
              <select value={coachAssign[fi]||""} onChange={e=>assignCoach(fi,e.target.value)} style={{width:"100%",padding:"5px 8px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,outline:"none",background:"white"}}>
                <option value="">– kein Trainer –</option>
                {coaches.filter(c=>c.active!==false).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>}
      {/* Zeitstrahl */}
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {buildSchedule().reduce((rows,sl)=>{
          const last=rows[rows.length-1];
          if(!last||last.startMin!==sl.startMin) rows.push({startMin:sl.startMin,round:sl.round??0,slots:[],idx:rows.length});
          rows[rows.length-1].slots.push(sl);
          return rows;
        },[]).map((row,ri,allRows)=>{
          const allTeamIds=[...new Set(row.slots.flatMap(sl=>[sl.match.homeId,sl.match.awayId]))];
          const allTeams=allTeamIds.map(gt).filter(Boolean);
          const kidCount=allTeams.reduce((s,tm)=>{
            const sz=t.teamSizes?.[tm.id]||tm.players?.length||t.defaultTeamSize||4;
            return s+sz;
          },0);
          const activeCoaches=row.slots.map((sl,i)=>coachAssign[sl.field-1]).filter(Boolean);
          const uniqueCoaches=[...new Set(activeCoaches)];
          return(<div key={ri}>
          <div style={{borderRadius:10,border:`1.5px solid ${C.border}`,overflow:"hidden",background:C.card}}>
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"#f8fafc",borderBottom:`1px solid ${C.border}`,flexWrap:"wrap"}}>
              <span style={{fontWeight:800,fontSize:14,color:C.text,minWidth:44}}>{fmtTime(row.startMin)}</span>
              <span style={{fontSize:12,color:C.muted}}>⏱ {t.matchDuration} Min</span>
              <div style={{display:"flex",gap:8,marginLeft:"auto",flexWrap:"wrap"}}>
                <span style={{fontSize:12,fontWeight:700,padding:"2px 10px",borderRadius:20,background:"#dbeafe",color:"#1d4ed8"}}>👥 {kidCount} Kinder aktiv</span>
                {uniqueCoaches.length>0&&<span style={{fontSize:12,fontWeight:700,padding:"2px 10px",borderRadius:20,background:"#dcfce7",color:"#15803d"}}>🧑‍🏫 {uniqueCoaches.map(id=>coaches.find(c=>c.id===id)?.name||"").join(", ")}</span>}
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min(row.slots.length,fields)},1fr)`,gap:0}}>
              {row.slots.map((sl,si)=>{
                const h=gt(sl.match.homeId),a=gt(sl.match.awayId);
                const coach=coachAssign[sl.field-1]?coaches.find(c=>c.id===coachAssign[sl.field-1]):null;
                const hSize=t.teamSizes?.[sl.match.homeId]||h?.players?.length||t.defaultTeamSize||4;
                const aSize=t.teamSizes?.[sl.match.awayId]||a?.players?.length||t.defaultTeamSize||4;
                return(<div key={si} style={{padding:"10px 12px",borderRight:si<row.slots.length-1?`1px solid ${C.border}`:"none"}}>
                  <div style={{fontSize:11,fontWeight:800,color:C.muted,marginBottom:6}}>⚽ Feld {sl.field}{coach?` · 🧑‍🏫 ${coach.name}`:""}</div>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:10,height:10,borderRadius:"50%",background:h?.color,flexShrink:0}}/><span style={{fontWeight:700,fontSize:13,color:C.text,flex:1}}>{h?.name}</span><span style={{fontSize:11,color:C.muted}}>{hSize}👦</span></div>
                    <div style={{fontSize:10,color:C.muted,fontWeight:700,paddingLeft:16}}>vs.</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:10,height:10,borderRadius:"50%",background:a?.color,flexShrink:0}}/><span style={{fontWeight:700,fontSize:13,color:C.text,flex:1}}>{a?.name}</span><span style={{fontSize:11,color:C.muted}}>{aSize}👦</span></div>
                  </div>
                  {sl.match.played&&<div style={{fontSize:11,color:"#16a34a",fontWeight:700,marginTop:6}}>{sl.match.homeScore}:{sl.match.awayScore} ✓</div>}
                </div>);
              })}
            </div>
          </div>
          {/* Pause editor between rounds */}
          {ri<allRows.length-1&&function(){
            const rnd=row.round;
            const pval=slotPauses[rnd];
            return <PauseEditor round={rnd} value={pval??pauseMin} defaultVal={pauseMin} isCustom={pval!==undefined&&pval!==pauseMin} onChange={setSlotPauses}/>;
          }()}
        </div>);
        })}
      </div>
    </div>}
    {tab==="table"&&<div>
      <div style={{background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr 1fr 2fr"}}>
          {["Team","Sp","S","U","N","Tore","Pkt"].map(h=><div key={h} style={{padding:"10px 12px",background:"#f8fafc",fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",borderBottom:`1px solid ${C.border}`}}>{h}</div>)}
          {standings.map((s,i)=>[
            <div key={`${s.id}n`} style={{padding:"12px",display:"flex",alignItems:"center",gap:8,borderBottom:`1px solid ${C.border}`}}><span style={{fontWeight:800,color:i===0?"#f59e0b":i===1?"#94a3b8":"#b45309",minWidth:20}}>{i+1}.</span><div style={{width:12,height:12,borderRadius:"50%",background:s.color,flexShrink:0}}/><span style={{fontWeight:700,color:C.text}}>{s.name}</span></div>,
            ...[s.pl,s.w,s.d,s.l,`${s.gf}:${s.ga}`].map((v,j)=><div key={`${s.id}v${j}`} style={{padding:"12px",textAlign:"center",fontSize:14,fontWeight:600,color:C.muted,borderBottom:`1px solid ${C.border}`}}>{v}</div>),
            <div key={`${s.id}p`} style={{padding:"12px",textAlign:"center",fontSize:16,fontWeight:900,color:C.primary,borderBottom:`1px solid ${C.border}`}}>{s.pts}</div>
          ])}
        </div>
      </div>
      <div style={{fontSize:12,color:C.muted,marginTop:8,textAlign:"center"}}>{played}/{t.matches.length} Spiele</div>
    </div>}
    </>)}
  </div>);
}

function TurnierPage({tournaments,onSaveTournament,onDeleteTournament,coaches=[],players=[],onSavePlayer,onlineUsers,currentUser,toast,onGoHome,onGoBack,initialOpenId,onClearInitialOpen}) {
  const [modal,setModal]=useState(null);
  const [open,setOpen]=useState(initialOpenId||null);
  useEffect(()=>{if(initialOpenId){setOpen(initialOpenId);onClearInitialOpen?.();}},[]); // eslint-disable-line
  const [selectMode,setSelectMode]=useState(false);
  const [selected,setSelected]=useState([]);
  if(open){const t=tournaments.find(x=>x.id===open);if(!t){setOpen(null);return null;}return<TournamentDetail tournament={t} onUpdate={onSaveTournament} onBack={()=>setOpen(null)} coaches={coaches} toast={toast} players={players} onSavePlayer={onSavePlayer}/>;}
  const toggleSel=id=>setSelected(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
  const exitSelectMode=()=>{setSelectMode(false);setSelected([]);};
  const printMultiple=()=>{
    const chosen=tournaments.filter(t=>selected.includes(t.id)).sort((a,b)=>new Date(a.date)-new Date(b.date));
    if(chosen.length===0)return;
    const css=`${PDF_CSS}
      .sec-title{font-size:16px;font-weight:900;margin:22px 0 12px;padding-top:14px;border-top:2px solid #e2e8f0}
      .tourn-title{font-size:20px;font-weight:900;margin:0 0 4px}
      .pagebreak{}
      @media print{.pagebreak{page-break-before:always}}`;
    const body=chosen.map((t,i)=>{
      const {meta,teamsHtml,zpHtml,ueHtml}=buildTournamentPdfSections(t,coaches);
      return`<div class="${i>0?"pagebreak":""}">
        <h1 class="tourn-title">🏆 ${escHtml(t.name)}</h1>
        <div class="meta">${meta}</div>
        <div class="sec-title" style="border-top:none;margin-top:0;padding-top:0">👥 Teams &amp; Spielplan pro Team</div>
        ${teamsHtml}
        <div class="sec-title">🗓 Zeitplan (chronologisch)</div>
        ${zpHtml}
        <div class="sec-title">📊 Übersicht (gleichzeitige Spiele)</div>
        ${ueHtml}
      </div>`;
    }).join("");
    const html=`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Turnierpläne</title><style>${css}</style></head><body>
      ${body}
      <div class="footer">Erstellt mit G-Jugend Coach App · ${new Date().toLocaleDateString("de-DE")}</div>
      ${PDF_SCRIPT}
    </body></html>`;
    openPdf(html,`Turnierplaene_${chosen.length}-Turniere_${todayISO()}.html`,toast);
    exitSelectMode();
  };
  return(<div>
    <PageHeader title="Turnier" sub={`${tournaments.length} Turniere`} onlineUsers={onlineUsers} currentUser={currentUser} onGoHome={onGoHome} onGoBack={onGoBack}/>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
      <Btn onClick={()=>setModal({type:"create"})}><Plus size={16}/> Neues Turnier</Btn>
      {tournaments.length>1&&(selectMode?
        <>
          <Btn variant="secondary" onClick={exitSelectMode}>Abbrechen</Btn>
          <Btn onClick={printMultiple} disabled={selected.length===0}>🖨️ PDF erstellen ({selected.length})</Btn>
        </>
        :<Btn variant="secondary" onClick={()=>setSelectMode(true)}>🖨️ Mehrere Turniere als PDF</Btn>
      )}
    </div>
    {tournaments.length===0?<Empty icon="🏆" title="Noch kein Turnier" sub="Plane ein Rundenturnier – intern oder mit externen Teams." onAdd={()=>setModal({type:"create"})} addLabel="Turnier erstellen"/>:
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
        {[...tournaments].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(t=>{
          const pl=t.matches.filter(m=>m.played).length,done=pl===t.matches.length,leader=done?calcStandings(t.teams,t.matches)[0]:null;
          const isSel=selected.includes(t.id);
          return(<div key={t.id} style={{background:C.card,borderRadius:12,border:`1.5px solid ${isSel?C.primary:done?"#22c55e":C.border}`,padding:"16px 18px",cursor:"pointer",position:"relative"}} onClick={()=>selectMode?toggleSel(t.id):setOpen(t.id)}>
            {selectMode&&<div style={{position:"absolute",top:12,right:12,width:20,height:20,borderRadius:5,border:`2px solid ${isSel?C.primary:C.border}`,background:isSel?C.primary:"white",display:"flex",alignItems:"center",justifyContent:"center"}}>{isSel&&<span style={{color:"white",fontSize:12,lineHeight:1}}>✓</span>}</div>}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}><div style={{fontWeight:800,fontSize:16,color:C.text,paddingRight:selectMode?26:0}}>{t.name}</div>{!selectMode&&<button onClick={e=>{e.stopPropagation();onDeleteTournament(t.id);}} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:4}}><Trash2 size={14}/></button>}</div>
            <div style={{fontSize:13,color:C.muted,marginBottom:10}}>{fmtDate(t.date)} · {t.teams.length} Teams · {t.matchDuration} Min/Spiel</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>{t.teams.map(tm=><span key={tm.id} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:12,fontWeight:700,padding:"2px 8px",borderRadius:20,background:"#f1f5f9",color:C.text}}><span style={{width:8,height:8,borderRadius:"50%",background:tm.color,display:"inline-block"}}/>{tm.name}</span>)}</div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}><div style={{fontSize:12,color:C.muted}}>{pl}/{t.matches.length} Spiele {done?"✅":""}</div>{leader&&<div style={{fontSize:12,fontWeight:700,color:C.primary}}>🥇 {leader.name}</div>}</div>
            <div style={{height:4,borderRadius:2,background:"#f1f5f9",marginTop:8,overflow:"hidden"}}><div style={{height:"100%",borderRadius:2,background:C.accent,width:`${t.matches.length?pl/t.matches.length*100:0}%`,transition:"width .3s"}}/></div>
          </div>);
        })}
      </div>}
    {modal?.type==="create"&&<Modal title="Neues Turnier" onClose={()=>setModal(null)} wide><TournamentForm onSave={t=>{onSaveTournament(t);setModal(null);}} onClose={()=>setModal(null)}/></Modal>}
  </div>);
}

// ── KASSE PAGE ────────────────────────────────────────────────────
const KASSE_CATS_EIN = ["Elternbeitrag","Vereinszuschuss","Turnier-Einnahme","Sponsoring","Sonstiges"];
const KASSE_CATS_AUS = ["Material","Turnierbeitrag","Ausrüstung","Verpflegung","Sonstiges"];

function KasseForm({entry,onSave,onClose}) {
  const [form,setForm]=useState({date:todayISO(),description:"",amount:"",type:"ein",category:"Sonstiges",...entry});
  const [err,setErr]=useState("");
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const cats=form.type==="ein"?KASSE_CATS_EIN:KASSE_CATS_AUS;
  const doSave=()=>{
    if(!form.description.trim()){setErr("Bitte eine Beschreibung eingeben.");return;}
    if(!form.amount||parseFloat(form.amount)<=0){setErr("Bitte einen gültigen Betrag eingeben.");return;}
    setErr("");
    onSave({...form,id:form.id||uid(),amount:parseFloat(form.amount)||0,createdAt:form.createdAt||now()});
  };
  return(<div>
    <div style={{display:"flex",gap:8,marginBottom:14}}>
      {[["ein","💰 Einnahme","#16a34a","#dcfce7"],["aus","💸 Ausgabe","#dc2626","#fee2e2"]].map(([k,l,col,bg])=>
        <button key={k} onClick={()=>{set("type",k);set("category","Sonstiges");}} style={{flex:1,padding:"10px",borderRadius:10,border:`2px solid ${form.type===k?col:C.border}`,background:form.type===k?bg:"white",color:form.type===k?col:C.muted,cursor:"pointer",fontWeight:800,fontSize:14,fontFamily:"inherit"}}>{l}</button>)}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      <Inp label="Datum" type="date" value={form.date} onChange={e=>set("date",e.target.value)} style={{marginBottom:0}}/>
      <div style={{marginBottom:14}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:.6}}>Betrag (€)</label><input type="number" min="0" step="0.01" value={form.amount} onChange={e=>set("amount",e.target.value)} placeholder="0,00" style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,outline:"none",boxSizing:"border-box"}}/></div>
    </div>
    <Inp label="Beschreibung *" value={form.description} onChange={e=>{set("description",e.target.value);setErr("");}} placeholder="z.B. Trikots, Turnieranmeldung..."/>
    <Sel label="Kategorie" value={form.category} onChange={e=>set("category",e.target.value)}>{cats.map(c=><option key={c} value={c}>{c}</option>)}</Sel>
    {err&&<div style={{color:"#dc2626",fontSize:13,fontWeight:600,marginBottom:8}}>⚠️ {err}</div>}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:16,borderTop:`1px solid ${C.border}`}}>
      <Btn onClick={onClose} variant="secondary">Abbrechen</Btn>
      <Btn onClick={doSave}>{entry?.id?"Speichern":"Eintragen"}</Btn>
    </div>
  </div>);
}

function KassePage({kassenbuch,onSave,onDelete,toast,readOnly=false,onlineUsers,currentUser,onGoHome,onGoBack}) {
  const [modal,setModal]=useState(null);
  const [filter,setFilter]=useState("");
  const sorted=[...kassenbuch].sort((a,b)=>new Date(b.date)-new Date(a.date)||(new Date(b.createdAt)-new Date(a.createdAt)));
  const filtered=filter?sorted.filter(k=>k.type===filter):sorted;
  const ein=kassenbuch.filter(k=>k.type==="ein").reduce((s,k)=>s+k.amount,0);
  const aus=kassenbuch.filter(k=>k.type==="aus").reduce((s,k)=>s+k.amount,0);
  const balance=ein-aus;
  const fmt=n=>n.toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2});
  const bubble=(bg,border,textColor,label,value,key)=>{
    const active=filter===key;
    return(<div onClick={()=>setFilter(active?"":key)} style={{background:active?bg:"white",borderRadius:12,padding:"14px 16px",border:`2px solid ${active?textColor:border}`,cursor:"pointer",transition:"all .15s",boxShadow:active?`0 0 0 3px ${border}`:"none"}}>
      <div style={{fontSize:10,fontWeight:800,color:textColor,textTransform:"uppercase",letterSpacing:.8,marginBottom:4,display:"flex",alignItems:"center",gap:4}}>
        {active&&<span style={{fontSize:9}}>✓</span>}{label}
      </div>
      <div style={{fontSize:18,fontWeight:900,color:textColor}}>{value}</div>
    </div>);
  };
  return(<div>
    <PageHeader title="Mannschaftskasse" sub={`${kassenbuch.length} Einträge${filter==="ein"?" · Einnahmen":filter==="aus"?" · Ausgaben":""}`} onlineUsers={onlineUsers} currentUser={currentUser} onGoHome={onGoHome} onGoBack={onGoBack}/>
    {!readOnly&&<div style={{marginBottom:16}}><Btn onClick={()=>setModal({type:"form",data:null})}><Plus size={16}/> Eintrag</Btn></div>}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:20}}>
      {bubble("#dcfce7","#86efac","#15803d","Einnahmen",`+${fmt(ein)} €`,"ein")}
      {bubble("#fee2e2","#fca5a5","#dc2626","Ausgaben",`-${fmt(aus)} €`,"aus")}
      <div onClick={()=>setFilter("")} style={{background:filter===""?(balance>=0?"#eff6ff":"#fef2f2"):"white",borderRadius:12,padding:"14px 16px",border:`2px solid ${filter===""?(balance>=0?"#93c5fd":"#fca5a5"):(balance>=0?"#93c5fd":"#fca5a5")}`,cursor:"pointer",transition:"all .15s",boxShadow:filter===""?`0 0 0 3px ${balance>=0?"#bfdbfe":"#fecaca"}`:"none"}}>
        <div style={{fontSize:10,fontWeight:800,color:balance>=0?"#1d4ed8":"#dc2626",textTransform:"uppercase",letterSpacing:.8,marginBottom:4,display:"flex",alignItems:"center",gap:4}}>
          {filter===""&&<span style={{fontSize:9}}>✓</span>}Kontostand
        </div>
        <div style={{fontSize:18,fontWeight:900,color:balance>=0?"#1d4ed8":"#dc2626"}}>{balance>=0?"+":""}{fmt(balance)} €</div>
      </div>
    </div>
    {kassenbuch.length===0?<Empty icon="💰" title="Noch kein Eintrag" sub="Buche Einnahmen und Ausgaben der Mannschaftskasse." onAdd={()=>setModal({type:"form",data:null})} addLabel="Ersten Eintrag erstellen"/>:
      filtered.length===0?<div style={{textAlign:"center",padding:"40px",color:C.muted,fontSize:14}}>Keine Einträge für diesen Filter.</div>:
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {filtered.map(k=><div key={k.id} style={{background:C.card,borderRadius:10,border:`1.5px solid ${C.border}`,padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:40,height:40,borderRadius:10,background:k.type==="ein"?"#dcfce7":"#fee2e2",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{k.type==="ein"?"💰":"💸"}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:14,color:C.text}}>{k.description}</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>{fmtDate(k.date)} · {k.category}</div>
          </div>
          <div style={{fontWeight:900,fontSize:16,color:k.type==="ein"?"#16a34a":"#dc2626",flexShrink:0}}>{k.type==="ein"?"+":"-"}{fmt(k.amount)} €</div>
          {!readOnly&&<div style={{display:"flex",gap:4,flexShrink:0}}>
            <button onClick={()=>setModal({type:"form",data:k})} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,padding:4}}><Edit2 size={14}/></button>
            <button onClick={()=>onDelete(k.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:4}}><Trash2 size={14}/></button>
          </div>}
        </div>)}
      </div>}
    {modal?.type==="form"&&<Modal title={modal.data?"Eintrag bearbeiten":"Neuer Eintrag"} onClose={()=>setModal(null)}><KasseForm entry={modal.data} onSave={e=>{onSave(e);setModal(null);toast("Eintrag gespeichert");}} onClose={()=>setModal(null)}/></Modal>}
  </div>);
}

// ── SETTINGS PAGE ─────────────────────────────────────────────────
function DebugExportPanel({toast}) {
  const [log,setLog]=useState("");
  const refresh=()=>setLog(window._getExportLog()||"(noch kein Export versucht)");
  const copyLog=()=>{
    const txt=window._getExportLog()||"(leer)";
    if(navigator.clipboard) navigator.clipboard.writeText(txt).then(()=>toast("Log kopiert ✓"));
    else { const ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);toast("Log kopiert ✓"); }
  };

  const runTest=(label,content,filename)=>{
    dbgLog(`=== ${label} ===`);
    dbgLog(`Dateigröße: ${content.length} Zeichen`);
    dbgLog(`showSaveFilePicker: ${!!window.showSaveFilePicker}`);
    // Test 1: Blob
    try {
      const blob = new Blob([content],{type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href=url; a.download=filename; a.style.display='none';
      document.body.appendChild(a); a.click();
      setTimeout(()=>{URL.revokeObjectURL(url);document.body.removeChild(a);},1000);
      dbgLog('Methode 1 (Blob+click): ausgelöst – prüfe Downloads-Ordner');
    } catch(e){ dbgLog(`Methode 1 Fehler: ${e.message}`); }
    // Test 2: data: URI
    try {
      const uri='data:application/json;charset=utf-8,'+encodeURIComponent(content);
      const a2=document.createElement('a');
      a2.href=uri; a2.download=filename+'_v2'; a2.style.display='none';
      document.body.appendChild(a2); a2.click();
      setTimeout(()=>document.body.removeChild(a2),500);
      dbgLog('Methode 2 (data:URI+click): ausgelöst');
    } catch(e){ dbgLog(`Methode 2 Fehler: ${e.message}`); }
    // Test 3: window.open
    try {
      const uri3='data:application/json;charset=utf-8,'+encodeURIComponent(content);
      const w=window.open(uri3,'_blank');
      dbgLog(`Methode 3 (window.open): ${w?'Fenster geöffnet':'geblockt (null)'}`);
    } catch(e){ dbgLog(`Methode 3 Fehler: ${e.message}`); }
    refresh();
  };

  return(<div>
    <div style={{fontSize:13,color:C.muted,marginBottom:12}}>Teste alle Download-Methoden direkt. Nach jedem Test: prüfe Downloads-Ordner auf neue Dateien.</div>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
      <Btn sm onClick={()=>runTest("KLEIN (20 Bytes)",'{"test":1}','debug_klein.json')}>🧪 Klein (20 B)</Btn>
      <Btn sm onClick={()=>runTest("GROSS (50 KB)",JSON.stringify({data:'x'.repeat(50000)}),'debug_gross.json')}>🧪 Groß (50 KB)</Btn>
      <Btn sm variant="secondary" onClick={refresh}>🔄 Aktualisieren</Btn>
      <Btn sm variant="secondary" onClick={copyLog}>📋 Log kopieren</Btn>
    </div>
    <div style={{fontSize:12,color:"#854d0e",background:"#fef9c3",borderRadius:8,padding:"8px 12px",marginBottom:10,border:"1px solid #fde047"}}>
      Nach jedem Test: Öffne Dateien-App → Downloads → schau ob debug_klein.json oder debug_gross.json da ist. Das zeigt welche Methode klappt.
    </div>
    {log&&<pre style={{background:"#0f172a",color:"#94a3b8",borderRadius:8,padding:"10px 12px",fontSize:11,lineHeight:1.6,overflowX:"auto",whiteSpace:"pre-wrap",wordBreak:"break-all",maxHeight:300,overflowY:"auto",fontFamily:"monospace"}}>{log}</pre>}
  </div>);
}

function AddCatForm({onAdd}) {
  const EMOJIS=["🌀","💡","🎪","🏃","🤸","🎭","🧩","⚡","🎈","🦁","🦊","🐬","🔴","🟠","🟡","🟢","🔵","🟣"];
  const [label,setLabel]=useState("");const [emoji,setEmoji]=useState("🌀");
  const add=()=>{if(!label.trim())return;const idx=Math.floor(Math.random()*6);const pal=CUSTOM_CAT_PALETTE[idx];onAdd({label:label.trim(),emoji,color:pal.color,bg:pal.bg,builtin:false});setLabel("");};
  return(<div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
    <select value={emoji} onChange={e=>setEmoji(e.target.value)} style={{padding:"8px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:16,background:"white",cursor:"pointer",outline:"none"}}>{EMOJIS.map(e=><option key={e} value={e}>{e}</option>)}</select>
    <input value={label} onChange={e=>setLabel(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()} placeholder="Kategoriename..." style={{flex:1,minWidth:120,padding:"8px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,outline:"none",fontFamily:"inherit"}}/>
    <Btn sm onClick={add}><Plus size={13}/> Hinzufügen</Btn>
  </div>);
}
// ── ACTIVITY LOG COMPONENT ────────────────────────────────────────
function ActivityLog() {
  const [entries,setEntries]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    if(!fbDb){setLoading(false);return;}
    // Load last 50 activity entries
    const load=async()=>{
      try {
        const q=query(collection(fbDb,"activity"),orderBy("ts","desc"),limit(50));
        const snap=await getDocs(q);
        setEntries(snap.docs.map(d=>({id:d.id,...d.data()})));
      } catch(e){console.warn("activity load",e);}
      setLoading(false);
    };
    load();
    // Live updates
    const q2=query(collection(fbDb,"activity"),orderBy("ts","desc"),limit(50));
    const unsub=onSnapshot(q2,snap=>{
      setEntries(snap.docs.map(d=>({id:d.id,...d.data()})));
    },()=>{});
    return unsub;
  },[]);

  const ACTION_LABELS={
    teams_saved:"👥 Teams gespeichert",
    session_saved:"📅 Training gespeichert",
    player_saved:"⚽ Spieler gespeichert",
    coach_saved:"🧑‍🏫 Trainer gespeichert",
    exercise_saved:"📚 Übung gespeichert",
    new_user:"👤 Neuer Nutzer registriert",
  };

  const fmtTs=ts=>{
    if(!ts) return "";
    const d=new Date(ts);
    const now=new Date();
    const diff=Math.floor((now-d)/1000);
    if(diff<60) return "gerade eben";
    if(diff<3600) return `vor ${Math.floor(diff/60)} Min`;
    if(diff<86400) return `vor ${Math.floor(diff/3600)} Std`;
    return d.toLocaleDateString("de-DE",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
  };

  if(loading) return <div style={{padding:"20px 0",textAlign:"center",color:C.muted}}>Lädt...</div>;
  if(!fbDb) return <div style={{padding:"20px 0",textAlign:"center",color:C.muted}}>Nicht verfügbar (kein Firebase)</div>;
  if(entries.length===0) return <div style={{padding:"20px 0",textAlign:"center",color:C.muted}}>Noch keine Aktivitäten</div>;

  // Group consecutive same-user same-action entries to spot repeated attempts
  const grouped=[];
  entries.forEach(e=>{
    const last=grouped[grouped.length-1];
    if(last&&last.uid===e.uid&&last.action===e.action&&last.detail===e.detail&&
       (new Date(last.ts)-new Date(e.ts))<300000) {
      last.count=(last.count||1)+1;
      last.firstTs=e.ts;
    } else {
      grouped.push({...e,count:1});
    }
  });

  return(<div style={{display:"flex",flexDirection:"column",gap:6}}>
    {grouped.map((e,i)=>(
      <div key={e.id||i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"8px 12px",borderRadius:8,background:e.count>2?"#fff7ed":C.card,border:`1px solid ${e.count>2?"#fed7aa":C.border}`}}>
        {e.photo
          ?<img src={e.photo} width={28} height={28} style={{borderRadius:"50%",flexShrink:0}}/>
          :<div style={{width:28,height:28,borderRadius:"50%",background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,color:C.primary,flexShrink:0}}>{(e.name||"?")[0].toUpperCase()}</div>}
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <span style={{fontWeight:700,fontSize:13,color:C.text}}>{e.name?.split(" ")[0]||"Unbekannt"}</span>
            <span style={{fontSize:12,color:C.muted}}>{ACTION_LABELS[e.action]||e.action}</span>
            {e.detail&&<span style={{fontSize:12,color:C.muted,fontStyle:"italic"}}>„{e.detail}"</span>}
            {e.count>1&&<span style={{fontSize:11,padding:"1px 7px",borderRadius:20,background:e.count>3?"#fef3c7":"#f1f5f9",color:e.count>3?"#92400e":C.muted,fontWeight:700}}>
              {e.count}× wiederholt{e.count>3?" ⚠️":""}
            </span>}
          </div>
          <div style={{fontSize:11,color:C.muted,marginTop:2}}>{fmtTs(e.ts)}</div>
        </div>
      </div>
    ))}
  </div>);
}

function UserNameEditor({u,isSelf,setUserName}) {
  const [editing,setEditing]=useState(false);
  const [nameVal,setNameVal]=useState(u.name||"");
  const save=()=>{
    if(nameVal.trim()) setUserName(u.uid,nameVal.trim());
    setEditing(false);
  };
  return(<div style={{flex:1,minWidth:0}}>
    {editing
      ?<div style={{display:"flex",gap:6,alignItems:"center"}}>
          <input value={nameVal} onChange={e=>setNameVal(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")save();if(e.key==="Escape")setEditing(false);}} autoFocus
            style={{flex:1,padding:"4px 8px",border:`1.5px solid ${C.primary}`,borderRadius:6,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
          <button onClick={save} style={{padding:"4px 8px",borderRadius:6,border:"none",background:C.primary,color:"white",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>✓</button>
          <button onClick={()=>setEditing(false)} style={{padding:"4px 8px",borderRadius:6,border:`1px solid ${C.border}`,background:"white",color:C.muted,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
        </div>
      :<div style={{display:"flex",alignItems:"center",gap:6}}>
          <div>
            <div style={{fontWeight:700,fontSize:14,color:C.text,display:"flex",alignItems:"center",gap:4}}>
              {u.name||<span style={{color:C.muted,fontStyle:"italic"}}>Kein Name</span>}
              {isSelf&&<span style={{fontSize:11,color:C.muted}}>(du)</span>}
              <button onClick={()=>setEditing(true)} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,padding:"0 2px",lineHeight:1}}><Edit2 size={11}/></button>
            </div>
            <div style={{fontSize:11,color:C.muted,marginTop:1}}>{u.email||u.uid.slice(0,12)}</div>
          </div>
        </div>}
  </div>);
}

// ── TEAM-VERWALTUNG (pro Gruppe) ───────────────────────────────────
function GroupManagementPanel({groupId, role, memberships, onSwitchGroup, toast, firebaseUser}) {
  const canManage = role==="admin"; // effektive Rolle berücksichtigt globalen Admin schon
  const [members,setMembers]=useState([]);
  const [inviteCode,setInviteCode]=useState(null);
  const [copied,setCopied]=useState(false);

  useEffect(()=>{
    if(!fbDb||!groupId) return;
    const unsub=onSnapshot(collection(fbDb,"groups",groupId,"members"),snap=>{
      setMembers(snap.docs.map(d=>d.data()).sort((a,b)=>(a.name||"").localeCompare(b.name||"")));
    },()=>{});
    return unsub;
  },[groupId]);
  useEffect(()=>{
    if(!fbDb||!groupId||!canManage){ setInviteCode(null); return; }
    const unsub=onSnapshot(doc(fbDb,"groups",groupId,"settings","invite"),snap=>{
      setInviteCode(snap.exists()?snap.data().code:null);
    },()=>{});
    return unsub;
  },[groupId,canManage]);
  const joinRequests=useJoinRequests(groupId, canManage);

  const copyCode=()=>{
    if(!inviteCode) return;
    navigator.clipboard?.writeText(inviteCode).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),1500); });
  };

  return(<div style={{marginBottom:28}}>
    <h2 style={{fontSize:16,fontWeight:800,color:C.text,marginBottom:14,paddingBottom:8,borderBottom:`2px solid ${C.accentL}`}}>👥 Team-Verwaltung</h2>

    {memberships&&memberships.length>1&&<div style={{marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Aktives Team wechseln</div>
      <select value={groupId||""} onChange={e=>onSwitchGroup(e.target.value)}
        style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:13,color:C.text,background:C.bg,outline:"none",fontFamily:"inherit"}}>
        {memberships.map(m=><option key={m.groupId} value={m.groupId}>{m.groupId}</option>)}
      </select>
    </div>}

    {!canManage&&<div style={{fontSize:13,color:C.muted}}>Nur der Team-Admin kann Mitglieder, Einladungscode und Beitrittswünsche verwalten.</div>}

    {canManage&&<>
      {inviteCode&&<div style={{marginBottom:16,padding:"14px 16px",background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`}}>
        <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>🔑 Einladungscode</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <div style={{flex:1,padding:"9px 12px",borderRadius:8,background:"#f8fafc",border:`1.5px solid ${C.border}`,fontSize:18,fontWeight:800,letterSpacing:3,textAlign:"center",color:C.primary}}>{inviteCode}</div>
          <button onClick={copyCode} style={{padding:"9px 14px",borderRadius:8,border:"none",background:copied?"#22c55e":C.primary,color:"white",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{copied?"Kopiert ✓":"Kopieren"}</button>
        </div>
        <div style={{fontSize:11,color:C.muted,marginTop:8}}>Wer diesen Code eingibt, tritt sofort als „Eltern" bei.</div>
      </div>}

      {joinRequests.length>0&&<div style={{marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>⏳ Offene Beitrittswünsche ({joinRequests.length})</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {joinRequests.map(r=><div key={r.uid} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,background:C.card,border:`1.5px solid ${C.border}`}}>
            {r.photo?<img src={r.photo} width={32} height={32} style={{borderRadius:"50%",flexShrink:0}}/>:<div style={{width:32,height:32,borderRadius:"50%",background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:C.primary,flexShrink:0}}>{(r.name||"?")[0].toUpperCase()}</div>}
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:13,color:C.text}}>{r.name||r.email}</div>
              <div style={{fontSize:11,color:C.muted}}>{r.email}</div>
            </div>
            <button onClick={()=>approveJoinRequest(groupId,r.uid,"eltern")} style={{padding:"6px 10px",borderRadius:8,border:"none",background:"#22c55e",color:"white",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>✓ Annehmen</button>
            <button onClick={()=>rejectJoinRequest(groupId,r.uid)} style={{padding:"6px 10px",borderRadius:8,border:"1px solid #fca5a5",background:"#fff5f5",color:"#ef4444",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
          </div>)}
        </div>
      </div>}

      <div>
        <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Team-Mitglieder ({members.length})</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {members.map(m=>{
            const r=USER_ROLES[m.role||"eltern"]||USER_ROLES.eltern;
            const isSelf=m.uid===firebaseUser?.uid;
            return(<div key={m.uid} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,background:C.card,border:`1.5px solid ${C.border}`}}>
              {m.photo?<img src={m.photo} width={32} height={32} style={{borderRadius:"50%",flexShrink:0}}/>:<div style={{width:32,height:32,borderRadius:"50%",background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:C.primary,flexShrink:0}}>{(m.name||"?")[0].toUpperCase()}</div>}
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:13,color:C.text}}>{m.name||m.email}{isSelf&&<span style={{fontSize:11,color:C.muted}}> (du)</span>}</div>
              </div>
              <select value={m.role||"eltern"} disabled={isSelf}
                onChange={e=>setDoc(doc(fbDb,"groups",groupId,"members",m.uid),{role:e.target.value},{merge:true})}
                style={{padding:"5px 10px",borderRadius:8,border:`1.5px solid ${r.color}`,background:r.bg,color:r.color,fontWeight:700,fontSize:12,cursor:isSelf?"default":"pointer",fontFamily:"inherit",outline:"none"}}>
                <option value="admin">👑 Admin</option>
                <option value="trainer">🧑‍🏫 Trainer</option>
                <option value="eltern">👪 Eltern</option>
              </select>
              {!isSelf&&<button title="Aus Team entfernen" onClick={()=>{if(window.confirm(`${m.name||m.email} aus dem Team entfernen?`))deleteDoc(doc(fbDb,"groups",groupId,"members",m.uid));}} style={{padding:"5px 8px",borderRadius:8,border:"1px solid #fca5a5",background:"#fff5f5",cursor:"pointer",color:"#ef4444",fontSize:12,flexShrink:0}}>🗑</button>}
            </div>);
          })}
        </div>
      </div>
    </>}
  </div>);
}

function SettingsPage({exercises,players,coaches,sessions,tournaments,kassenbuch,onImport,toast,apiKey,onSaveApiKey,customCats,onSaveCustomCats,firebaseUser,onLogout,onFullBackup,role,isGlobalAdmin,allUsers,setUserRole,setUserName,deleteUser,prefs={},onPrefChange,onlineUsers,currentGroupId,memberships,onSwitchGroup,onGoHome,onGoBack}) {
  const ref=useRef();const [mode,setMode]=useState("merge");const [ki,setKi]=useState(apiKey||"");const [kv,setKv]=useState(false);
  const doImport=async e=>{ const f=e.target.files?.[0];if(!f)return;try{if(f.name.endsWith(".csv")){const p=parseCsvPlayers(await readText(f));onImport({players:p},mode==="replace"?"replace_players":"merge_players");toast(`${p.length} Spieler importiert`);}else{const d=JSON.parse(await readText(f));
    const t=d.type||"unknown";
    if(!["full","exercises","team","sessions","tournaments","kassenbuch"].includes(t))throw new Error(`Unbekannter Typ: "${t}"`);
    if(t==="exercises"&&!Array.isArray(d.exercises))throw new Error("Feld 'exercises' fehlt");
    if(t==="team"&&!Array.isArray(d.players))throw new Error("Feld 'players' fehlt");
    if(t==="sessions"&&!Array.isArray(d.sessions))throw new Error("Feld 'sessions' fehlt");
    if(t==="full"&&(!Array.isArray(d.exercises)||!Array.isArray(d.players)))throw new Error("Backup unvollständig");
    const svgs=(d.exercises||[]).filter(ex=>ex.imageUrl?.startsWith("data:image/svg")).length;
    if(svgs>0)toast(`⚠️ ${svgs} Übung(en) mit SVG-Bild importiert`,"warn");
    onImport(d,mode);toast(`Import OK (${t})`);}}catch(er){toast("Fehler: "+er.message,"err");}e.target.value=""; };
  const EC=({icon,title,desc,sub,fn})=><div style={{background:C.card,borderRadius:10,border:`1.5px solid ${C.border}`,padding:"14px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><div><div style={{fontWeight:700,fontSize:14,color:C.text}}>{icon} {title}</div><div style={{fontSize:12,color:C.muted,marginTop:2}}>{desc}</div>{sub&&<div style={{fontSize:11,color:"#94a3b8",marginTop:1}}>{sub}</div>}</div><Btn sm onClick={fn}><Download size={13}/> Export</Btn></div>;
  const Sec=({title,ch})=><div style={{marginBottom:28}}><h2 style={{fontSize:16,fontWeight:800,color:C.text,marginBottom:14,paddingBottom:8,borderBottom:`2px solid ${C.accentL}`}}>{title}</h2>{ch}</div>;
  return(<div>
    <PageHeader title="Einstellungen" sub={`G-Jugend Coach · v${APP_VERSION}`} onlineUsers={onlineUsers} currentUser={firebaseUser} onGoHome={onGoHome} onGoBack={onGoBack}/>
    <GroupManagementPanel groupId={currentGroupId} role={role} memberships={memberships} onSwitchGroup={onSwitchGroup} toast={toast} firebaseUser={firebaseUser}/>
    {/* Simplified settings for trainer/eltern */}
    {(role==="trainer"||role==="eltern")&&<SimpleSettings role={role} apiKey={apiKey} onSaveApiKey={onSaveApiKey} prefs={prefs} onPrefChange={onPrefChange} firebaseUser={firebaseUser} onLogout={onLogout}/>}
    {/* Full settings for TRUE global admin only (technischer Betreiber) */}
    {isGlobalAdmin&&(()=>{
      const [stab,setStab]=useState("general");
      const stb=(k,l)=><button onClick={()=>setStab(k)} style={{padding:"7px 16px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit",background:stab===k?C.primary:"transparent",color:stab===k?"white":C.muted}}>{l}</button>;
      return(<div>
        <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:10,padding:4,marginBottom:16,width:"fit-content"}}>
          {stb("general","⚙️ Allgemein")}
          {can(role,"manageRoles")&&stb("users","👥 Nutzer")}
          {can(role,"seeActivity")&&stb("activity","📋 Aktivität")}
        </div>
        {stab==="activity"&&<ActivityLog/>}
        {stab==="users"&&<div>
          <div style={{marginBottom:12,fontSize:13,color:C.muted}}>Alle registrierten Nutzer und ihre Berechtigungen.</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {(allUsers||[]).map(u=>{
              const r=USER_ROLES[u.role||"pending"]||USER_ROLES.pending;
              const isSelf=u.uid===firebaseUser?.uid;
              return(<div key={u.uid} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,background:C.card,border:`1.5px solid ${C.border}`}}>
                {u.photo?<img src={u.photo} width={36} height={36} style={{borderRadius:"50%",flexShrink:0}}/>
                  :<div style={{width:36,height:36,borderRadius:"50%",background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:800,color:C.primary,flexShrink:0}}>{(u.name||"?")[0].toUpperCase()}</div>}
                <UserNameEditor u={u} isSelf={isSelf} setUserName={setUserName}/>
                <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                  <select value={u.role||"pending"} disabled={isSelf}
                    onChange={e=>setUserRole(u.uid,e.target.value)}
                    style={{padding:"5px 10px",borderRadius:8,border:`1.5px solid ${r.color}`,background:r.bg,color:r.color,fontWeight:700,fontSize:12,cursor:isSelf?"default":"pointer",fontFamily:"inherit",outline:"none"}}>
                    {Object.entries(USER_ROLES).map(([k,v])=><option key={k} value={k}>{v.emoji} {v.label}</option>)}
                  </select>
                  {!isSelf&&<button title="Sperren" onClick={()=>{if(window.confirm(`${u.name||u.email} sperren? Zugriff wird sofort entzogen.`))setUserRole(u.uid,"banned");}} style={{padding:"5px 8px",borderRadius:8,border:"1px solid #fca5a5",background:"#fff5f5",cursor:"pointer",color:"#ef4444",fontSize:12,flexShrink:0}}>🚫</button>}
                  {!isSelf&&<button title="Komplett löschen" onClick={()=>{if(window.confirm(`${u.name||u.email} komplett löschen? Der Nutzer kann sich erneut registrieren und landet dann auf "Ausstehend".`))deleteUser(u.uid);}} style={{padding:"5px 8px",borderRadius:8,border:"1px solid #e2e8f0",background:"#f8fafc",cursor:"pointer",color:"#64748b",fontSize:12,flexShrink:0}}>🗑</button>}
                </div>
              </div>);
            })}
          </div>
        </div>}
        {stab==="general"&&<div>
    {/* Dark Mode toggle for admin too */}
    <div style={{marginBottom:16,padding:"12px 16px",background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div><div style={{fontWeight:600,fontSize:14,color:C.text}}>🌙 Dark Mode</div><div style={{fontSize:12,color:C.muted}}>Dunkles Design (nur dieses Gerät)</div></div>
      <button onClick={()=>onPrefChange(!(prefs.darkMode||false))} style={{width:48,height:26,borderRadius:13,border:"none",cursor:"pointer",background:prefs.darkMode?C.primary:"#cbd5e1",position:"relative",transition:"background .2s",flexShrink:0}}>
        <div style={{width:20,height:20,borderRadius:"50%",background:"white",position:"absolute",top:3,left:prefs.darkMode?25:3,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.3)"}}/>
      </button>
    </div>
    {/* Firebase user info */}
    {firebaseUser&&<div style={{marginBottom:16,padding:"12px 14px",background:"#f0fdf4",borderRadius:12,border:"1.5px solid #bbf7d0",display:"flex",alignItems:"center",gap:12}}>
      {firebaseUser.photoURL&&<img src={firebaseUser.photoURL} width={36} height={36} style={{borderRadius:"50%"}} alt=""/>}
      <div style={{flex:1}}>
        <div style={{fontWeight:800,fontSize:14,color:"#166534"}}>☁️ Verbunden mit Google</div>
        <div style={{fontSize:12,color:"#15803d",marginTop:2}}>{firebaseUser.displayName||firebaseUser.email}</div>
        <div style={{fontSize:11,color:"#16a34a",marginTop:1}}>Daten werden automatisch mit allen Trainern synchronisiert</div>
      </div>
      <button onClick={onLogout} style={{padding:"5px 12px",borderRadius:8,border:"1px solid #bbf7d0",background:"white",color:"#166534",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Abmelden</button>
    </div>}
    <Sec title="🤖 Claude API" ch={<div style={{background:C.card,borderRadius:10,border:`1.5px solid ${C.border}`,padding:"16px 18px"}}>
      <div style={{fontSize:13,color:C.muted,marginBottom:10}}>API-Key von <a href="https://console.anthropic.com" target="_blank" style={{color:C.primary}}>console.anthropic.com</a> – wird nur lokal gespeichert.</div>
      <div style={{display:"flex",gap:8}}><input type={kv?"text":"password"} value={ki} onChange={e=>setKi(e.target.value)} placeholder="sk-ant-..." style={{flex:1,padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:14,outline:"none",fontFamily:"monospace"}}/><Btn sm variant="secondary" onClick={()=>setKv(v=>!v)}>{kv?"🙈":"👁️"}</Btn><Btn sm onClick={()=>{onSaveApiKey(ki.trim());toast(ki.trim()?"API-Key gespeichert":"API-Key entfernt");}}>Speichern</Btn></div>
      {apiKey&&<div style={{marginTop:8,fontSize:12,color:"#16a34a",fontWeight:600}}>✅ API-Key aktiv – KI-Funktionen verfügbar</div>}
    </div>}/>
    <Sec title="📤 Exportieren" ch={<div style={{display:"flex",flexDirection:"column",gap:10}}>
      <EC icon="💾" title="Vollständiges Backup" desc="Alle Daten inkl. Turniere & Kasse" sub={`${exercises.length} Übungen · ${players.length} Spieler · ${sessions.length} Trainings · ${tournaments.length} Turniere · ${kassenbuch.length} Kassenbucheinträge`} fn={onFullBackup}/>
      <EC icon="📚" title="Nur Übungen" desc="Bibliothek teilen" sub={`${exercises.length} Übungen`} fn={async()=>dlJson({version:APP_VERSION,exportDate:new Date().toISOString(),type:"exercises",exercises},`GJugend_Uebungen_${exercises.length}-Eintraege_${todayISO()}.json`,toast)}/>
      <EC icon="👥" title="Team" desc="Spieler & Trainer" sub={`${players.length} Spieler · ${coaches.length} Trainer`} fn={async()=>dlJson({version:APP_VERSION,exportDate:new Date().toISOString(),type:"team",players,coaches},`GJugend_Team_${players.length}-Spieler_${todayISO()}.json`,toast)}/>
      <EC icon="📊" title="Spieler (CSV)" desc="Für Excel & Google Sheets" sub={`${players.length} Spieler`} fn={async()=>dlCsv(players,["name","birthYear","strength","active","jersey","notes"],`GJugend_Spieler_${todayISO()}.csv`,toast)}/>
      <EC icon="📅" title="Training" desc="Alle Trainingseinheiten" sub={`${sessions.length} Einheiten`} fn={async()=>dlJson({version:APP_VERSION,exportDate:new Date().toISOString(),type:"sessions",sessions},`GJugend_Training_${sessions.length}-Einheiten_${todayISO()}.json`,toast)}/>
      <EC icon="🏆" title="Turniere" desc="Alle Turniere & Ergebnisse" sub={`${tournaments.length} Turniere`} fn={async()=>dlJson({version:APP_VERSION,exportDate:new Date().toISOString(),type:"tournaments",tournaments},`GJugend_Turniere_${tournaments.length}-Turniere_${todayISO()}.json`,toast)}/>
      <EC icon="💰" title="Kassenbuch" desc="Einnahmen & Ausgaben" sub={`${kassenbuch.length} Einträge`} fn={async()=>dlJson({version:APP_VERSION,exportDate:new Date().toISOString(),type:"kassenbuch",kassenbuch},`GJugend_Kassenbuch_${kassenbuch.length}-Eintraege_${todayISO()}.json`,toast)}/>
      <EC icon="📋" title="Kassenbuch (CSV)" desc="Für Excel & Steuer" sub={`${kassenbuch.length} Einträge`} fn={async()=>dlCsv(kassenbuch,["date","description","amount","type","category"],`GJugend_Kassenbuch_${todayISO()}.csv`,toast)}/>
    </div>}/>
    <Sec title="📥 Importieren" ch={<div style={{background:C.card,borderRadius:10,border:`1.5px solid ${C.border}`,padding:"16px 18px"}}>
      <div style={{marginBottom:12}}><label style={{display:"block",fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}>Modus</label><div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{[["merge","Zusammenführen"],["replace","Ersetzen ⚠️"]].map(([k,l])=><button key={k} onClick={()=>setMode(k)} style={{padding:"6px 14px",borderRadius:8,border:`2px solid ${mode===k?C.primary:C.border}`,background:mode===k?C.accentL:"white",color:mode===k?C.primary:C.muted,cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:"inherit"}}>{l}</button>)}</div></div>
      <div style={{background:"#f8fafc",borderRadius:8,padding:"10px 14px",marginBottom:12,fontSize:12,color:C.muted}}>Unterstützt: JSON Backup · Übungen · Team · Training · Turniere · Kassenbuch · Spieler-CSV</div>
      <Btn onClick={()=>ref.current.click()}><Upload size={14}/> Datei auswählen</Btn>
      <input ref={ref} type="file" accept=".json,.csv" onChange={doImport} style={{display:"none"}}/>
    </div>}/>
    <Sec title="🏷️ Eigene Kategorien" ch={<div>
      <div style={{fontSize:13,color:C.muted,marginBottom:12}}>Füge eigene Trainings-Kategorien hinzu. Sie erscheinen in der Bibliothek und bei der Planung.</div>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
        {(customCats||[]).map((cc,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,background:"#f8fafc",border:`1.5px solid ${C.border}`}}>
          <span style={{fontSize:18}}>{cc.emoji}</span>
          <span style={{fontWeight:700,fontSize:14,color:cc.color,flex:1}}>{cc.label}</span>
          <span style={{fontSize:11,padding:"2px 8px",borderRadius:20,background:cc.bg,color:cc.color,fontWeight:700}}>Vorschau</span>
          <button onClick={()=>onSaveCustomCats((customCats||[]).filter((_,j)=>j!==i))} style={{background:"none",border:"none",cursor:"pointer",color:"#ef4444",padding:4,fontSize:16}}>✕</button>
        </div>)}
      </div>
      <AddCatForm onAdd={cc=>onSaveCustomCats([...(customCats||[]),cc])}/>
    </div>}/>
    <Sec title="🐛 Export Debug" ch={<DebugExportPanel toast={toast}/>}/>
    <div style={{textAlign:"center",padding:"20px 0",color:"#cbd5e1",fontSize:12}}>G-Jugend Coach v{APP_VERSION} · Made with ⚽ for G-Jugend Hamburg</div>
        </div>}
      </div>);
    })()}
  </div>);
}

// ── SIMPLE SETTINGS (Trainer/Eltern) ──────────────────────────────
function SimpleSettings({role,apiKey,onSaveApiKey,prefs,onPrefChange,firebaseUser,onLogout}) {
  const [apiInput,setApiInput]=useState(apiKey||"");
  const [saved,setSaved]=useState(false);

  const saveKey=()=>{onSaveApiKey(apiInput);setSaved(true);setTimeout(()=>setSaved(false),2000);};

  return(<div style={{display:"flex",flexDirection:"column",gap:16}}>
    {/* Profile */}
    <div style={{padding:"14px 16px",background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`}}>
      <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:12}}>👤 Profil</div>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        {firebaseUser?.photoURL
          ?<img src={firebaseUser.photoURL} width={44} height={44} style={{borderRadius:"50%"}}/>
          :<div style={{width:44,height:44,borderRadius:"50%",background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:800,color:C.primary}}>{(firebaseUser?.displayName||"?")[0]}</div>}
        <div>
          <div style={{fontWeight:700,fontSize:15,color:C.text}}>{firebaseUser?.displayName||firebaseUser?.email}</div>
          <div style={{fontSize:12,color:C.muted}}>{firebaseUser?.email}</div>
          <div style={{fontSize:11,marginTop:2,padding:"1px 8px",borderRadius:20,background:USER_ROLES[role]?.bg,color:USER_ROLES[role]?.color,fontWeight:700,display:"inline-block"}}>{USER_ROLES[role]?.emoji} {USER_ROLES[role]?.label}</div>
        </div>
      </div>
    </div>

    {/* Dark Mode */}
    <div style={{padding:"14px 16px",background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`}}>
      <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:12}}>🎨 Darstellung</div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontWeight:600,fontSize:14,color:C.text}}>🌙 Dark Mode</div>
          <div style={{fontSize:12,color:C.muted}}>Dunkles Design</div>
        </div>
        <button onClick={()=>onPrefChange(!(prefs.darkMode||false))}
          style={{width:48,height:26,borderRadius:13,border:"none",cursor:"pointer",background:prefs.darkMode?C.primary:"#cbd5e1",position:"relative",transition:"background .2s",flexShrink:0}}>
          <div style={{width:20,height:20,borderRadius:"50%",background:"white",position:"absolute",top:3,left:prefs.darkMode?25:3,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.3)"}}/>
        </button>
      </div>
    </div>

    {/* API Key - only for trainer */}
    {role==="trainer"&&<div style={{padding:"14px 16px",background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`}}>
      <div style={{fontSize:12,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,marginBottom:12}}>🔑 KI API-Key</div>
      <div style={{fontSize:12,color:C.muted,marginBottom:10}}>Für KI-Trainingspläne (OpenAI). Wird nur auf diesem Gerät gespeichert.</div>
      <div style={{display:"flex",gap:8}}>
        <input value={apiInput} onChange={e=>setApiInput(e.target.value)} type="password" placeholder="sk-..."
          style={{flex:1,padding:"9px 12px",border:`1.5px solid ${C.border}`,borderRadius:8,fontSize:13,color:C.text,background:C.bg,outline:"none",fontFamily:"inherit"}}/>
        <button onClick={saveKey} style={{padding:"9px 16px",borderRadius:8,border:"none",background:saved?"#22c55e":C.primary,color:"white",fontWeight:700,cursor:"pointer",fontSize:13,fontFamily:"inherit",flexShrink:0}}>
          {saved?"✓ OK":"Speichern"}
        </button>
      </div>
    </div>}

    {/* Abmelden */}
    <div style={{padding:"14px 16px",background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`}}>
      <button onClick={onLogout} style={{width:"100%",padding:"10px 0",borderRadius:8,border:"1px solid #fca5a5",background:"#fff5f5",color:"#ef4444",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>
        🔓 Abmelden
      </button>
    </div>
  </div>);
}

// ── NAV ───────────────────────────────────────────────────────────
// ── BIRTHDAY HELPERS ──────────────────────────────────────────────
function getBirthdayInfo(players) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayMMDD = `${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
  const results = [];
  for (const p of players) {
    if (!p.birthDate) continue;
    const [,mm,dd] = p.birthDate.split("-"); // YYYY-MM-DD
    const mmdd = `${mm}-${dd}`;
    // Days from today (negative = past, 0 = today, positive = future)
    const bDay = new Date(today.getFullYear(), Number(mm)-1, Number(dd));
    let diff = Math.round((bDay - today) / 86400000);
    // If birthday already passed this year, check if it was in last 7 days
    if (diff < -7) { bDay.setFullYear(today.getFullYear()+1); diff = Math.round((bDay - today) / 86400000); }
    if (diff >= -7 && diff <= 14) {
      const age = today.getFullYear() - Number(p.birthDate.slice(0,4)) + (diff < 0 ? 0 : -1);
      results.push({player:p, diff, age: diff <= 0 ? age+1 : age, mmdd});
    }
  }
  return results.sort((a,b)=>a.diff-b.diff);
}

function BirthdayBanner({players}) {
  const infos = getBirthdayInfo(players.filter(p=>p.active!==false));
  if (!infos.length) return null;
  const [open,setOpen] = useState(true);
  if (!open) return (
    <div onClick={()=>setOpen(true)} style={{background:"#fef9c3",borderRadius:10,padding:"6px 14px",margin:"0 0 12px",border:"1px solid #fde047",cursor:"pointer",display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#854d0e",fontWeight:700}}>
      🎂 {infos.length} Geburtstag{infos.length>1?"e":""} in den nächsten 7 Tagen <span style={{marginLeft:"auto",color:C.muted}}>▼</span>
    </div>
  );
  return (
    <div style={{background:"#fef9c3",borderRadius:10,padding:"12px 14px",margin:"0 0 14px",border:"1.5px solid #fde047"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
        <span style={{fontWeight:800,fontSize:14,color:"#854d0e"}}>🎂 Geburtstage</span>
        <button onClick={()=>setOpen(false)} style={{background:"none",border:"none",cursor:"pointer",color:"#a16207",fontSize:16,lineHeight:1}}>▲</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {infos.map(({player:p,diff,age})=>{
          const isToday=diff===0;
          const wasPast=diff<0;
          const label=isToday?"🎉 Heute!"
            :diff===1?"Morgen"
            :diff===-1?"Gestern"
            :wasPast?`Vor ${Math.abs(diff)} Tagen`
            :`In ${diff} Tagen`;
          const col=isToday?"#15803d":wasPast?"#6b7280":"#854d0e";
          const bg=isToday?"#dcfce7":wasPast?"#f1f5f9":"#fffbeb";
          return(
            <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,background:bg,border:`1px solid ${isToday?"#86efac":wasPast?"#e2e8f0":"#fde047"}`}}>
              <span style={{fontSize:20}}>{isToday?"🎉":"🎂"}</span>
              <div style={{flex:1}}>
                <div style={{fontWeight:800,fontSize:14,color:C.text}}>{p.name} <span style={{fontSize:12,fontWeight:400,color:C.muted}}>wird {age}</span></div>
                <div style={{fontSize:12,color:C.muted}}>{p.birthDate?.slice(5).split("-").reverse().join(".")}</div>
              </div>
              <span style={{fontSize:12,fontWeight:700,color:col,padding:"2px 8px",borderRadius:20,background:col+"22"}}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── START / DASHBOARD PAGE ────────────────────────────────────────
function relDateLabel(dateStr) {
  if(!dateStr) return "";
  const d=new Date(dateStr+"T12:00:00");
  const t=new Date(); t.setHours(12,0,0,0);
  const diffDays=Math.round((d-t)/86400000);
  if(diffDays===0) return "Heute";
  if(diffDays===1) return "Morgen";
  if(diffDays<0) return d.toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit"});
  if(diffDays<7) return d.toLocaleDateString("de-DE",{weekday:"long"});
  return d.toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:d.getFullYear()!==t.getFullYear()?"numeric":undefined});
}

function StartTeaser({icon,title,sub,badge,onClick}) {
  return(<button onClick={onClick} style={{flex:"0 0 auto",width:130,background:C.card,borderRadius:14,border:`1.5px solid ${C.border}`,padding:"14px 12px",display:"flex",flexDirection:"column",gap:4,cursor:"pointer",textAlign:"left",fontFamily:"inherit",position:"relative"}}>
    {badge?<span style={{position:"absolute",top:8,right:8,background:"#ef4444",color:"white",fontSize:10,fontWeight:800,borderRadius:20,padding:"1px 6px",lineHeight:1.4}}>{badge}</span>:null}
    <span style={{fontSize:22}}>{icon}</span>
    <span style={{fontWeight:800,fontSize:13,color:C.text,lineHeight:1.2}}>{title}</span>
    <span style={{fontSize:11,color:C.muted,lineHeight:1.3}}>{sub}</span>
  </button>);
}

function NextCard({icon,label,title,sub,status,statusColor,onClick}) {
  return(<div onClick={onClick} style={{flex:"0 0 auto",width:196,background:C.card,borderRadius:14,border:`1.5px solid ${C.border}`,padding:"14px 16px",cursor:onClick?"pointer":"default",position:"relative"}}>
    {status&&<span style={{position:"absolute",top:10,right:10,fontSize:9,fontWeight:800,padding:"2px 7px",borderRadius:20,background:statusColor?.bg||"#f1f5f9",color:statusColor?.text||C.muted,whiteSpace:"nowrap"}}>{status}</span>}
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
      <div style={{width:32,height:32,borderRadius:9,background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{icon}</div>
      <div style={{fontSize:10,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6}}>{label}</div>
    </div>
    <div style={{fontWeight:800,fontSize:14,color:C.text,marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{title}</div>
    {sub&&<div style={{fontSize:12,color:C.muted}}>{sub}</div>}
  </div>);
}

function StatBox({icon,value,label}) {
  return(<div style={{background:C.card,border:`1.5px solid ${C.border}`,borderRadius:12,padding:"12px 10px",textAlign:"center"}}>
    <div style={{fontSize:17}}>{icon}</div>
    <div style={{fontWeight:900,fontSize:18,color:C.text,marginTop:2}}>{value}</div>
    <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:.4,marginTop:1}}>{label}</div>
  </div>);
}

function StartPage({players,coaches,sessions,tournaments,todos,meetings,teamsets,kassenbuch,exercises,role,currentUser,onlineUsers,onNavigate,onOpenLibraryCategory,onOpenOrgaItem,onOpenCalendarItem,onOpenTournament,onSaveExercise,onDeleteExercise,onGoBack}) {
  const [exModal,setExModal]=useState(null);
  const today=todayISO();
  const activePlayers=(players||[]).filter(p=>p.active);
  const nextSession=[...(sessions||[])].filter(s=>s.date>=today&&!s.isDraft).sort((a,b)=>a.date.localeCompare(b.date))[0];
  const openTodos=[...(todos||[])].filter(t=>!t.done).sort((a,b)=>{if(a.due&&b.due)return a.due.localeCompare(b.due);if(a.due)return -1;if(b.due)return 1;return 0;});
  const ein=(kassenbuch||[]).filter(k=>k.type==="ein").reduce((s,k)=>s+k.amount,0);
  const aus=(kassenbuch||[]).filter(k=>k.type==="aus").reduce((s,k)=>s+k.amount,0);
  const balance=ein-aus;
  const firstName=(currentUser?.displayName||currentUser?.email||"").split(/[ @]/)[0];
  const hour=new Date().getHours();
  const greeting=hour<11?"Guten Morgen":hour<18?"Hallo":"Guten Abend";

  const nextItems=[
    ...(sessions||[]).filter(s=>s.date>=today&&!s.isDraft).map(s=>({date:s.date,icon:"📅",label:"Training",title:relDateLabel(s.date),sub:[s.location,s.duration?`${s.duration} Min`:null].filter(Boolean).join(" · ")||undefined,status:isSessionPlanned(s)?"✅ Geplant":"🕒 Ungeplant",statusColor:isSessionPlanned(s)?{bg:"#dcfce7",text:"#16a34a"}:{bg:"#fef3c7",text:"#b45309"},onClick:()=>onOpenCalendarItem?onOpenCalendarItem({type:"training",id:s.id}):onNavigate("training")})),
    ...(tournaments||[]).filter(t=>t.date>=today).map(t=>({date:t.date,icon:"🏆",label:"Turnier",title:t.name||"Turnier",sub:relDateLabel(t.date),onClick:()=>onOpenTournament?onOpenTournament(t.id):onNavigate("turnier")})),
    ...(meetings||[]).filter(m=>m.date>=today).map(m=>({date:m.date,icon:"🧑‍🏫",label:"Trainertreff",title:m.title||"Trainertreff",sub:relDateLabel(m.date),onClick:()=>onOpenCalendarItem?onOpenCalendarItem({type:"meeting",id:m.id}):onNavigate("calendar")})),
  ].sort((a,b)=>a.date.localeCompare(b.date)).slice(0,10);

  const teasers=[
    can(role,"calendar")&&{icon:"🗓",title:"Termine",sub:"Alle Termine",onClick:()=>onNavigate("calendar")},
    can(role,"training")&&{icon:"📅",title:"Neues Training",sub:nextSession?relDateLabel(nextSession.date):"Neue Einheit",onClick:()=>onNavigate("training")},
    {icon:"👥",title:"Team",sub:`${activePlayers.length} Spieler`,onClick:()=>onNavigate("team")},
    can(role,"teamplaner")&&{icon:"🔀",title:"Teams losen",sub:`${(teamsets||[]).length} gespeichert`,onClick:()=>onNavigate("teamplaner")},
    can(role,"turnier")&&{icon:"🏆",title:"Turniere",sub:`${(tournaments||[]).length} geplant`,onClick:()=>onNavigate("turnier")},
    can(role,"orga")&&{icon:"📋",title:"To Dos",sub:openTodos.length?`${openTodos.length} offen`:"Alles erledigt",badge:openTodos.length||null,onClick:()=>onNavigate("orga")},
    can(role,"kasse")&&{icon:"💰",title:"Kasse",sub:`${balance>=0?"+":""}${balance.toFixed(2)} €`,onClick:()=>onNavigate("kasse")},
  ].filter(Boolean);

  const exByCat=key=>exercises.filter(e=>normCat(e.category)===key);
  const catRows=can(role,"library")?[
    {key:"aufwaermen",label:"Aufwärmen"},
    {key:"uebung",     label:"Übungen"},
    {key:"spielform",  label:"Spielformen"},
  ]:[];

  return(<div>
    <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:18}}>
      {onGoBack&&<button onClick={onGoBack} title="Zurück" style={{flexShrink:0,width:36,height:36,borderRadius:10,border:`1.5px solid ${C.border}`,background:C.card,color:C.text,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><ArrowLeft size={17}/></button>}
      <div>
        <div style={{fontSize:13,color:C.muted,fontWeight:600}}>{greeting}{firstName?`, ${firstName}`:""}</div>
        <h1 style={{margin:"2px 0 0",fontSize:24,fontWeight:900,color:C.text}}>⚽ Übersicht</h1>
      </div>
    </div>

    <div className="tm-hscroll" style={{display:"flex",gap:10,overflowX:"auto",marginBottom:24,paddingBottom:2}}>
      {teasers.map((tItem,i)=><StartTeaser key={i} {...tItem}/>)}
    </div>

    {nextItems.length>0&&<div style={{marginBottom:24}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:15,color:C.text}}>Als Nächstes</div>
        {can(role,"calendar")&&<button onClick={()=>onNavigate("calendar")} style={{background:"none",border:"none",color:C.primary,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Alle anzeigen →</button>}
      </div>
      <div className="tm-hscroll" style={{display:"flex",gap:10,overflowX:"auto",paddingBottom:2}}>
        {nextItems.map((it,i)=><NextCard key={i} {...it}/>)}
      </div>
    </div>}

    {can(role,"orga")&&openTodos.length>0&&<div style={{marginBottom:24}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:15,color:C.text}}>Offene Aufgaben</div>
        <button onClick={()=>onNavigate("orga")} style={{background:"none",border:"none",color:C.primary,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Alle anzeigen →</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {openTodos.slice(0,4).map(todo=>(
          <div key={todo.id} onClick={()=>onOpenOrgaItem?onOpenOrgaItem({tab:"todos",id:todo.id}):onNavigate("orga")} style={{display:"flex",alignItems:"center",gap:10,background:C.card,border:`1.5px solid ${C.border}`,borderRadius:10,padding:"10px 14px",cursor:"pointer"}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:todo.due&&todo.due<today?"#ef4444":C.accent,flexShrink:0}}/>
            <div style={{flex:1,minWidth:0,fontSize:14,fontWeight:600,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{todo.task}</div>
            {todo.due&&<div style={{fontSize:11,color:todo.due<today?"#ef4444":C.muted,fontWeight:700,flexShrink:0}}>{relDateLabel(todo.due)}</div>}
          </div>
        ))}
      </div>
    </div>}

    {catRows.map(({key,label})=><StartCatRow key={key} label={label} catInfo={BUILTIN_CATS[key]} exs={exByCat(key)} onSeeAll={()=>onOpenLibraryCategory(key)} onOpenEx={ex=>setExModal(ex)}/>)}

    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(84px,1fr))",gap:10}}>
      <StatBox icon="👦" value={activePlayers.length} label="Spieler aktiv"/>
      <StatBox icon="📚" value={(exercises||[]).length} label="Übungen"/>
      <StatBox icon="📅" value={(sessions||[]).length} label="Trainings"/>
      <StatBox icon="🏆" value={(tournaments||[]).length} label="Turniere"/>
    </div>

    {exModal&&<Modal title={exModal.title} onClose={()=>setExModal(null)} wide>
      <ExDetail exercise={exModal}
        onEdit={()=>{setExModal(null);onNavigate("library");}}
        onSave={x=>{onSaveExercise?.(x);setExModal(m=>m?{...m,...x}:m);}}
        onDelete={id=>{onDeleteExercise?.(id);setExModal(null);}}
        onClose={()=>setExModal(null)}/>
    </Modal>}
  </div>);
}

function ExerciseMiniCard({ex,catInfo,onClick}) {
  return(<div onClick={onClick} style={{flex:"0 0 auto",width:130,background:C.card,borderRadius:12,border:`1.5px solid ${C.border}`,overflow:"hidden",cursor:"pointer"}}>
    {ex.imageUrl
      ? <img src={ex.imageUrl} alt="" style={{width:"100%",height:78,objectFit:"cover",display:"block"}}/>
      : <div style={{width:"100%",height:78,background:catInfo.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26}}>{catInfo.emoji}</div>}
    <div style={{padding:"8px 10px"}}>
      <div style={{fontWeight:700,fontSize:12,color:C.text,lineHeight:1.25,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",minHeight:"2.4em"}}>{ex.title}</div>
      <div style={{fontSize:10,color:C.muted,marginTop:3}}>⏱ {ex.duration} Min{ex.rating>0?` · ${"★".repeat(ex.rating)}`:""}</div>
    </div>
  </div>);
}

function StartCatRow({label,catInfo,exs,onSeeAll,onOpenEx}) {
  if(!exs.length) return null;
  return(<div style={{marginBottom:24}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
      <div style={{fontWeight:800,fontSize:15,color:C.text}}>{catInfo.emoji} {label}</div>
      <button onClick={onSeeAll} style={{background:"none",border:"none",color:C.primary,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Alle anzeigen →</button>
    </div>
    <div className="tm-hscroll" style={{display:"flex",gap:10,overflowX:"auto",paddingBottom:2}}>
      {exs.slice(0,12).map(ex=><ExerciseMiniCard key={ex.id} ex={ex} catInfo={catInfo} onClick={()=>onOpenEx(ex)}/>)}
    </div>
  </div>);
}

function Nav({page,setPage,counts}) {
  const [menuOpen,setMenuOpen]=useState(false);

  const allItems=[
    {key:"start",    icon:Home,      label:"Start"},
    {key:"calendar", icon:Clock,     label:"Termine"},
    {key:"library",  icon:BookOpen,  label:"Bibliothek", count:counts.exercises},
    {key:"team",     icon:Users,     label:"Team",        count:counts.players},
    {key:"training", icon:CalendarDays,label:"Training",  count:counts.sessions},
    {key:"teamplaner",icon:Shuffle,  label:"Teams",       count:counts.teamsets},
    {key:"turnier",  icon:Trophy,    label:"Turnier",     count:counts.tournaments},
    {key:"kasse",    icon:Wallet,    label:"Kasse"},
    {key:"orga",     icon:ClipboardList,label:"To Dos",count:counts.openTodos},
    {key:"settings", icon:Settings,  label:"Einstellungen",alert:counts.pendingCount>0},
  ];
  const visible=allItems.filter(i=>can(counts.role,i.key)||(i.key==="settings"&&(counts.role==="trainer"||counts.role==="eltern")));
  const MAIN_KEYS=["start","calendar","training","teamplaner"];
  const mainItems=visible.filter(i=>MAIN_KEYS.includes(i.key));
  const moreItems=visible.filter(i=>!MAIN_KEYS.includes(i.key));
  const moreActive=moreItems.some(i=>i.key===page);
  const moreAlert=moreItems.some(i=>i.alert);

  // Gruppierung für das Hamburger-Menü (volle Übersicht aller Bereiche)
  const MENU_GROUPS=[
    {label:null,        keys:["start","calendar"]},
    {label:"Training",  keys:["library","training","teamplaner"]},
    {label:"Mannschaft",keys:["team","turnier"]},
    {label:"Verwaltung",keys:["kasse","orga"]},
    {label:"Sonstiges", keys:["settings"]},
  ];

  const navBtn=(item)=>{
    const active=page===item.key;
    const Icon=item.icon;
    return(<button key={item.key} onClick={()=>{setPage(item.key);setMenuOpen(false);}} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"10px 4px",border:"none",cursor:"pointer",background:"transparent",color:active?"#4ade80":"rgba(255,255,255,.5)",fontFamily:"inherit",position:"relative"}}>
      <Icon size={22} strokeWidth={active?2.5:1.8}/>
      {item.alert&&<span style={{position:"absolute",top:8,left:"50%",transform:"translateX(8px)",background:"#ef4444",width:7,height:7,borderRadius:"50%",display:"block"}}/>}
      <span style={{fontSize:10,fontWeight:700}}>{item.label}</span>
    </button>);
  };

  return(<>
    <style>{`.gn{position:fixed;left:0;top:0;bottom:0;width:200px;background:${C.nav};display:flex;flex-direction:column;z-index:100;padding:0 12px 20px}.gm{display:flex;margin-left:200px;padding:28px;max-width:1100px}.gb{display:none;position:fixed;bottom:0;left:0;right:0;background:${C.nav};z-index:100;border-top:1px solid rgba(255,255,255,.1)}@media(max-width:640px){.gn{display:none}.gb{display:flex;height:68px}.gm{margin-left:0!important;padding:16px;padding-bottom:88px}}@keyframes spin{to{transform:rotate(360deg)}}.tm-hscroll{scrollbar-width:none;-webkit-overflow-scrolling:touch}.tm-hscroll::-webkit-scrollbar{display:none}.tm-menu-items{scrollbar-width:none}.tm-menu-items::-webkit-scrollbar{display:none}`}</style>
    {/* Desktop sidebar */}
    <div className="gn">
      <div style={{padding:"24px 8px 20px",borderBottom:"1px solid rgba(255,255,255,.1)",marginBottom:12}}>
        <div style={{fontSize:11,color:"rgba(255,255,255,.4)",letterSpacing:2,fontWeight:700}}>G-JUGEND</div>
        <div style={{fontSize:18,fontWeight:900,color:"white",marginTop:2}}>⚽ Coach</div>
        <div style={{fontSize:10,color:"rgba(255,255,255,.3)",marginTop:2}}>v{APP_VERSION}</div>
      </div>
      {visible.map(({key,icon:Icon,label,count})=><button key={key} onClick={()=>setPage(key)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:10,border:"none",cursor:"pointer",marginBottom:4,width:"100%",textAlign:"left",fontFamily:"inherit",background:page===key?"rgba(34,197,94,.2)":"transparent",color:page===key?"#4ade80":"rgba(255,255,255,.6)"}}><Icon size={18} strokeWidth={page===key?2.5:1.8}/><span style={{fontSize:14,fontWeight:700,flex:1}}>{label}</span>{count!==undefined&&<span style={{fontSize:11,background:"rgba(255,255,255,.1)",borderRadius:20,padding:"1px 7px",color:"rgba(255,255,255,.5)"}}>{count}</span>}</button>)}
    </div>
    {/* Mobile bottom nav */}
    <div className="gb">
      {mainItems.map(navBtn)}
      {/* Hamburger-Menü-Button */}
      {moreItems.length>0&&<button onClick={()=>setMenuOpen(true)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"10px 4px",border:"none",cursor:"pointer",background:"transparent",color:moreActive||menuOpen?"#4ade80":"rgba(255,255,255,.5)",fontFamily:"inherit",position:"relative"}}>
        <Menu size={22} strokeWidth={1.8}/>
        {moreAlert&&!menuOpen&&<span style={{position:"absolute",top:8,left:"50%",transform:"translateX(8px)",background:"#ef4444",width:7,height:7,borderRadius:"50%",display:"block"}}/>}
        <span style={{fontSize:10,fontWeight:700}}>Menü</span>
      </button>}
    </div>
    {/* Hamburger-Menü: Overlay */}
    <div onClick={()=>setMenuOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:300,opacity:menuOpen?1:0,pointerEvents:menuOpen?"auto":"none",transition:"opacity .2s"}}/>
    {/* Hamburger-Menü: Panel (slide-in von links) */}
    <div style={{position:"fixed",top:0,left:0,bottom:0,width:"78%",maxWidth:300,background:"white",zIndex:301,transform:menuOpen?"translateX(0)":"translateX(-105%)",transition:"transform .25s ease",display:"flex",flexDirection:"column",boxShadow:"4px 0 32px rgba(0,0,0,.25)",paddingTop:"env(safe-area-inset-top)"}}>
      <div style={{padding:"20px 18px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:11,color:C.muted,letterSpacing:2,fontWeight:700}}>G-JUGEND</div>
          <div style={{fontSize:17,fontWeight:900,color:C.text,marginTop:2}}>⚽ Coach</div>
        </div>
        <button onClick={()=>setMenuOpen(false)} style={{background:"none",border:"none",cursor:"pointer",color:C.muted,padding:4,flexShrink:0}}><X size={22}/></button>
      </div>
      <div className="tm-menu-items" style={{flex:1,overflowY:"auto",padding:"6px 10px 20px"}}>
        {MENU_GROUPS.map((g,gi)=>{
          const items=g.keys.map(k=>visible.find(v=>v.key===k)).filter(Boolean);
          if(!items.length) return null;
          return(<div key={gi}>
            {g.label&&<div style={{fontSize:11,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:1,padding:"14px 10px 6px"}}>{g.label}</div>}
            {items.map(({key,icon:Icon,label,count,alert})=>{
              const active=page===key;
              return(<button key={key} onClick={()=>{setPage(key);setMenuOpen(false);}} style={{display:"flex",alignItems:"center",gap:12,width:"100%",padding:"11px 10px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left",background:active?C.accentL:"transparent",color:active?C.primary:C.text,position:"relative",marginBottom:2}}>
                <Icon size={19} strokeWidth={active?2.5:1.8}/>
                {alert&&<span style={{position:"absolute",top:8,left:30,background:"#ef4444",width:7,height:7,borderRadius:"50%"}}/>}
                <span style={{fontSize:14,fontWeight:700,flex:1}}>{label}</span>
                {count!==undefined&&count>0&&<span style={{fontSize:11,background:active?"white":"#f1f5f9",color:active?C.primary:C.muted,borderRadius:20,padding:"1px 8px",fontWeight:700}}>{count}</span>}
              </button>);
            })}
          </div>);
        })}
      </div>
      <div style={{padding:"10px 18px",borderTop:`1px solid ${C.border}`,fontSize:10,color:C.muted,flexShrink:0}}>v{APP_VERSION}</div>
    </div>
  </>);
}

// ── APP ───────────────────────────────────────────────────────────
// ── FIREBASE AUTH HOOK ────────────────────────────────────────────
function useFirebaseAuth() {
  const [user, setUser] = useState(undefined);
  const [onlineUsers, setOnlineUsers] = useState([]);

  useEffect(() => {
    if(!fbAuth) { setUser(null); return; }
    const unsub = onAuthStateChanged(fbAuth, u => {
      setUser(u ?? null);
      if(u) {
        setPresence(u, true);
        // Update presence on visibility change
        const onVis = () => setPresence(u, !document.hidden);
        document.addEventListener("visibilitychange", onVis);
        window.addEventListener("beforeunload", () => setPresence(u, false));
        return () => document.removeEventListener("visibilitychange", onVis);
      } else {
        setPresence(u, false);
      }
    });
    return unsub;
  }, []);

  // Subscribe to presence collection
  useEffect(() => {
    if(!fbDb) return;
    const unsub = onSnapshot(doc(fbDb,"presence","_dummy"), ()=>{}, ()=>{});
    // Listen to all presence docs
    const unsubPresence = onSnapshot(
      collection(fbDb,"presence"),
      snap => {
        const now = Date.now();
        const users = snap.docs
          .map(d => d.data())
          .filter(u => u.online && u.lastSeen && (now - new Date(u.lastSeen).getTime()) < 5*60*1000);
        setOnlineUsers(users);
      },
      () => {}
    );
    return unsubPresence;
  }, []);

  const login  = () => signInWithPopup(fbAuth, new GoogleAuthProvider()).catch(e=>console.warn("login",e));
  const loginEmail = async(email,password) => {
    try { await signInWithEmailAndPassword(fbAuth,email,password); return null; }
    catch(e) { return e.code; }
  };
  const registerEmail = async(email,password,name) => {
    try {
      const cred=await createUserWithEmailAndPassword(fbAuth,email,password);
      if(name) await updateProfile(cred.user,{displayName:name});
      return null;
    } catch(e) { return e.code; }
  };
  const resetPassword = async(email) => {
    try { await sendPasswordResetEmail(fbAuth,email); return null; }
    catch(e) { return e.code; }
  };
  const logout = () => { if(user) setPresence(user, false); signOut(fbAuth); };
  return { user, login, loginEmail, registerEmail, resetPassword, logout, onlineUsers };
}

// ── FIREBASE SYNC HOOK ────────────────────────────────────────────
// Syncs a named collection to/from Firestore in real-time.
// Falls back to local Dexie when offline or not logged in.
function useCloudStorage(key, def, user, groupId=DEFAULT_GROUP_ID) {
  const [data, setData]   = useState(def);
  const [ready, setReady] = useState(false);
  const localKey = "cloud_" + key;

  // Load from local cache first (instant)
  useEffect(() => {
    db.kv.get(localKey).then(row => {
      if (row?.value) setData(JSON.parse(row.value));
      setReady(true);
    }).catch(() => setReady(true));
  }, [localKey]);

  // Subscribe to Firestore when logged in — jetzt unter groups/{groupId}/shared/{key}
  useEffect(() => {
    if (!user || !groupId) return;
    if(!fbDb) return;
    const unsub = onSnapshot(doc(fbDb, "groups", groupId, "shared", key), snap => {
      if (snap.exists()) {
        const items = snap.data().items;
        setData(items);
        db.kv.put({ key: localKey, value: JSON.stringify(items) }).catch(() => {});
      }
    }, e => console.warn("onSnapshot", key, e));
    return unsub;
  }, [user, groupId, key, localKey]);

  const save = useCallback((nextOrFn) => {
    setData(prev => {
      const next = typeof nextOrFn === 'function' ? nextOrFn(prev) : nextOrFn;
      // Write locally
      db.kv.put({ key: localKey, value: JSON.stringify(next) }).catch(() => {});
      // Write to cloud if logged in
      if (user && groupId) fbWriteGroup(groupId, key, next);
      return next;
    });
  }, [user, groupId, key, localKey]);

  return [data, save, ready];
}

// ── PRESENCE BADGE ────────────────────────────────────────────────
function PageHeader({title, sub, onlineUsers, currentUser, onGoHome, onGoBack}) {
  const [showList,setShowList]=useState(false);
  const users=onlineUsers||[];
  return(
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16}}>
      <div style={{minWidth:0,display:"flex",alignItems:"flex-start",gap:10}}>
        {onGoBack&&<button onClick={onGoBack} title="Zurück" style={{flexShrink:0,width:36,height:36,borderRadius:10,border:`1.5px solid ${C.border}`,background:C.card,color:C.text,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><ArrowLeft size={17}/></button>}
        {onGoHome&&<button onClick={onGoHome} title="Zur Startseite" style={{flexShrink:0,width:36,height:36,borderRadius:10,border:`1.5px solid ${C.border}`,background:C.card,color:C.text,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><Home size={17}/></button>}
        <div style={{minWidth:0}}>
          <h1 style={{margin:0,fontSize:22,fontWeight:900,color:C.text}}>{title}</h1>
          {sub&&<div style={{fontSize:13,color:C.muted,marginTop:2}}>{sub}</div>}
        </div>
      </div>
      {users.length>0&&<div style={{position:"relative",flexShrink:0,marginLeft:12}}>
        <div style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer"}} onClick={()=>setShowList(s=>!s)}>
          <div style={{display:"flex"}}>
            {users.map((u,i)=>(
              <div key={u.uid} style={{position:"relative",width:30,height:30,borderRadius:"50%",overflow:"hidden",border:"2px solid white",background:"#e2e8f0",flexShrink:0,marginLeft:i===0?0:-8,zIndex:users.length-i}}>
                {u.photo?<img src={u.photo} width={30} height={30} style={{objectFit:"cover"}}/>
                  :<div style={{width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:"#475569",background:u.uid===currentUser?.uid?"#dcfce7":"#fef9c3"}}>{(u.name||"?")[0].toUpperCase()}</div>}
                <div style={{position:"absolute",bottom:0,right:0,width:8,height:8,borderRadius:"50%",background:"#22c55e",border:"1.5px solid white"}}/>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:"#16a34a",fontWeight:700,whiteSpace:"nowrap"}}>{users.length} online</div>
        </div>
        {showList&&<>
          <div style={{position:"fixed",inset:0,zIndex:9990}} onClick={()=>setShowList(false)}/>
          <div style={{position:"absolute",top:38,right:0,background:"white",borderRadius:10,boxShadow:"0 4px 20px rgba(0,0,0,.15)",padding:"8px 0",minWidth:160,zIndex:9991}}>
            <div style={{fontSize:10,fontWeight:800,color:C.muted,textTransform:"uppercase",letterSpacing:.6,padding:"4px 12px 6px"}}>Gerade online</div>
            {users.map(u=><div key={u.uid} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px"}}>
              {u.photo?<img src={u.photo} width={22} height={22} style={{borderRadius:"50%"}}/>
                :<div style={{width:22,height:22,borderRadius:"50%",background:"#dcfce7",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:"#16a34a"}}>{(u.name||"?")[0].toUpperCase()}</div>}
              <span style={{fontSize:13,fontWeight:600,color:C.text,flex:1}}>{u.name?.split(" ")[0]||u.uid.slice(0,8)}</span>
              {u.uid===currentUser?.uid&&<span style={{fontSize:10,color:C.muted}}>(du)</span>}
              <div style={{width:7,height:7,borderRadius:"50%",background:"#22c55e"}}/>
            </div>)}
          </div>
        </>}
      </div>}
    </div>
  );
}

// ── AUTH SCREEN ───────────────────────────────────────────────────
function AuthScreen({onGoogle,onEmail,onRegister,onReset}) {
  const [mode,setMode]=useState("login"); // login | register | reset
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [name,setName]=useState("");
  const [err,setErr]=useState("");
  const [info,setInfo]=useState("");
  const [loading,setLoading]=useState(false);

  const ERROR_MSGS={
    "auth/user-not-found":"Kein Konto mit dieser E-Mail gefunden",
    "auth/wrong-password":"Falsches Passwort",
    "auth/invalid-credential":"E-Mail oder Passwort falsch",
    "auth/email-already-in-use":"Diese E-Mail ist bereits registriert",
    "auth/weak-password":"Passwort muss mindestens 6 Zeichen haben",
    "auth/invalid-email":"Ungültige E-Mail-Adresse",
    "auth/too-many-requests":"Zu viele Versuche. Bitte kurz warten.",
  };

  const handle=async()=>{
    setErr("");setInfo("");setLoading(true);
    let errCode=null;
    if(mode==="login") errCode=await onEmail(email,password);
    else if(mode==="register") errCode=await onRegister(email,password,name);
    else if(mode==="reset"){
      errCode=await onReset(email);
      if(!errCode) setInfo("E-Mail zum Zurücksetzen wurde gesendet!");
    }
    if(errCode) setErr(ERROR_MSGS[errCode]||`Fehler: ${errCode}`);
    setLoading(false);
  };

  const inp=(val,set,type,ph,auto)=>(
    <input value={val} onChange={e=>set(e.target.value)} type={type} placeholder={ph}
      autoComplete={auto} onKeyDown={e=>e.key==="Enter"&&handle()}
      style={{width:"100%",padding:"12px 14px",border:`1.5px solid ${C.border}`,borderRadius:10,fontSize:15,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
  );

  return(<div style={{height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.bg,padding:24}}>
    <div style={{width:"100%",maxWidth:340,display:"flex",flexDirection:"column",gap:0}}>
      {/* Header */}
      <div style={{textAlign:"center",marginBottom:28}}>
        <div style={{fontSize:52,marginBottom:10}}>⚽</div>
        <div style={{fontWeight:900,fontSize:24,color:C.text}}>G-Jugend Coach</div>
        <div style={{fontSize:13,color:C.muted,marginTop:4}}>SC Sternschanze</div>
      </div>

      {/* Card */}
      <div style={{background:"white",borderRadius:16,padding:"24px 20px",boxShadow:"0 4px 24px rgba(0,0,0,.08)",display:"flex",flexDirection:"column",gap:12}}>
        {/* Mode tabs */}
        <div style={{display:"flex",gap:0,background:"#f1f5f9",borderRadius:10,padding:3,marginBottom:4}}>
          {[["login","Anmelden"],["register","Registrieren"]].map(([k,l])=>(
            <button key={k} onClick={()=>{setMode(k);setErr("");setInfo("");}} style={{flex:1,padding:"7px 0",borderRadius:8,border:"none",background:mode===k?"white":"transparent",color:mode===k?C.text:C.muted,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit",boxShadow:mode===k?"0 1px 4px rgba(0,0,0,.1)":"none"}}>{l}</button>
          ))}
        </div>

        {mode==="register"&&inp(name,setName,"text","Name (Anzeigename)","name")}
        {inp(email,setEmail,"email","E-Mail-Adresse","email")}
        {mode!=="reset"&&inp(password,setPassword,"password","Passwort","current-password")}

        {err&&<div style={{fontSize:12,color:"#ef4444",padding:"6px 10px",background:"#fff5f5",borderRadius:8,border:"1px solid #fca5a5"}}>{err}</div>}
        {info&&<div style={{fontSize:12,color:"#16a34a",padding:"6px 10px",background:"#f0fdf4",borderRadius:8,border:"1px solid #bbf7d0"}}>{info}</div>}

        <button onClick={handle} disabled={loading||!email||(mode!=="reset"&&!password)}
          style={{padding:"12px 0",borderRadius:10,border:"none",background:loading?C.muted:C.primary,color:"white",fontWeight:800,fontSize:15,cursor:loading?"default":"pointer",fontFamily:"inherit",width:"100%"}}>
          {loading?"...":{login:"Anmelden",register:"Registrieren",reset:"Link senden"}[mode]}
        </button>

        {mode==="login"&&<button onClick={()=>{setMode("reset");setErr("");setInfo("");}} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer",fontFamily:"inherit",textAlign:"center"}}>Passwort vergessen?</button>}
        {mode==="reset"&&<button onClick={()=>setMode("login")} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer",fontFamily:"inherit",textAlign:"center"}}>← Zurück zur Anmeldung</button>}

        {/* Divider */}
        <div style={{display:"flex",alignItems:"center",gap:8,margin:"4px 0"}}>
          <div style={{flex:1,height:1,background:C.border}}/>
          <span style={{fontSize:12,color:C.muted}}>oder</span>
          <div style={{flex:1,height:1,background:C.border}}/>
        </div>

        {/* Google */}
        <button onClick={onGoogle} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"11px 0",borderRadius:10,border:`1.5px solid ${C.border}`,background:"white",cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:14,width:"100%"}}>
          <img src="https://www.google.com/favicon.ico" width={17} height={17} alt="G"/>
          Mit Google anmelden
        </button>
      </div>

      <div style={{fontSize:11,color:C.muted,textAlign:"center",marginTop:16}}>Nur autorisierte Mitglieder haben Zugriff</div>
    </div>
  </div>);
}

// ── BACKUP BANNER ─────────────────────────────────────────────────
function BackupBanner({lastExportAt,onBackup}) {
  const [dismissed,setDismissed]=useState(false);
  if(dismissed) return null;
  const daysSince=lastExportAt
    ?Math.floor((Date.now()-new Date(lastExportAt).getTime())/86400000)
    :null;
  const needsBackup=daysSince===null||daysSince>=14;
  if(!needsBackup) return null;
  const msg=daysSince===null?"Noch kein Backup erstellt":`Letztes Backup vor ${daysSince} Tagen`;
  return(<div style={{position:"fixed",top:0,left:0,right:0,zIndex:9990,background:"#854d0e",color:"white",padding:"10px 16px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",boxShadow:"0 2px 8px rgba(0,0,0,.2)"}}>
    <span style={{fontSize:16}}>💾</span>
    <span style={{flex:1,fontSize:13,fontWeight:600}}>{msg} — Daten sichern empfohlen</span>
    <button onClick={()=>{onBackup();setDismissed(true);}} style={{padding:"5px 14px",borderRadius:20,border:"2px solid white",background:"transparent",color:"white",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>Jetzt Backup</button>
    <button onClick={()=>setDismissed(true)} style={{padding:"4px 8px",borderRadius:6,border:"none",background:"rgba(255,255,255,.2)",color:"white",fontWeight:700,fontSize:13,cursor:"pointer",lineHeight:1}}>✕</button>
  </div>);
}

// ── ONBOARDING: Team anlegen oder beitreten ────────────────────────
function GroupOnboarding({user, onLogout, toast}) {
  const [mode,setMode]=useState(null); // null | "create" | "join"
  const [joinTab,setJoinTab]=useState("code"); // "code" | "browse"
  const [name,setName]=useState("");
  const [code,setCode]=useState("");
  const [selectedGroupId,setSelectedGroupId]=useState("");
  const [busy,setBusy]=useState(false);
  const [requestedGroupId,setRequestedGroupId]=useState(()=>localStorage.getItem("pendingJoinRequest")||null);
  const allGroups=useAllGroups(user);

  // Prüfen, ob der eigene Beitrittswunsch noch offen ist (live)
  useEffect(()=>{
    if(!fbDb||!user||!requestedGroupId) return;
    const unsub=onSnapshot(doc(fbDb,"groups",requestedGroupId,"joinRequests",user.uid), snap=>{
      if(!snap.exists()){ setRequestedGroupId(null); localStorage.removeItem("pendingJoinRequest"); }
    },()=>{});
    return unsub;
  },[user,requestedGroupId]);

  const doCreate=async()=>{
    if(!name.trim()) return;
    setBusy(true);
    const r=await createGroup(user,name.trim());
    setBusy(false);
    if(r.ok) toast(`Team "${name.trim()}" angelegt ✓`);
    else toast("Fehler beim Anlegen: "+r.error,"err");
  };
  const doJoinCode=async()=>{
    if(!code.trim()) return;
    setBusy(true);
    const r=await joinGroupByCode(user,code.trim());
    setBusy(false);
    if(r.ok) toast("Team beigetreten ✓");
    else toast(r.error==="invalid-code"?"Code ungültig":"Fehler: "+r.error,"err");
  };
  const doRequestJoin=async()=>{
    if(!selectedGroupId) return;
    setBusy(true);
    const r=await requestToJoinGroup(user,selectedGroupId);
    setBusy(false);
    if(r.ok){ setRequestedGroupId(selectedGroupId); localStorage.setItem("pendingJoinRequest",selectedGroupId); toast("Beitrittswunsch gesendet ✓"); }
    else toast("Fehler: "+r.error,"err");
  };
  const cancelRequest=async()=>{
    await cancelJoinRequest(user,requestedGroupId);
    setRequestedGroupId(null); localStorage.removeItem("pendingJoinRequest");
  };

  const Shell=({children})=>(
    <div style={{height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.bg,padding:24}}>
      <div style={{width:"100%",maxWidth:420,background:C.card,borderRadius:16,border:`1.5px solid ${C.border}`,padding:28,boxShadow:"0 8px 30px rgba(0,0,0,.08)"}}>
        <div style={{textAlign:"center",marginBottom:20}}>
          <div style={{fontSize:40}}>⚽</div>
          <div style={{fontWeight:900,fontSize:20,color:C.text,marginTop:4}}>Willkommen, {user.displayName||user.email}!</div>
          <div style={{fontSize:13,color:C.muted,marginTop:4}}>Du bist noch in keinem Team.</div>
        </div>
        {children}
        <button onClick={onLogout} style={{marginTop:18,width:"100%",padding:"8px",borderRadius:10,border:"none",background:"transparent",color:C.muted,cursor:"pointer",fontFamily:"inherit",fontSize:12}}>Abmelden</button>
      </div>
    </div>
  );

  if(requestedGroupId){
    const g=allGroups.find(g=>g.id===requestedGroupId);
    return <Shell>
      <div style={{textAlign:"center",padding:"20px 0"}}>
        <div style={{fontSize:40}}>⏳</div>
        <div style={{fontWeight:800,fontSize:16,color:C.text,marginTop:8}}>Beitrittswunsch gesendet</div>
        <div style={{fontSize:13,color:C.muted,marginTop:6}}>Der Admin von {g?.name||"diesem Team"} muss deinen Beitritt noch bestätigen.</div>
        <button onClick={cancelRequest} style={{marginTop:16,padding:"8px 16px",borderRadius:10,border:`1.5px solid ${C.border}`,background:"white",cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:13}}>Zurückziehen</button>
      </div>
    </Shell>;
  }

  if(mode===null) return <Shell>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <button onClick={()=>setMode("create")} style={{padding:"14px",borderRadius:12,border:"none",background:C.primary,color:"white",fontWeight:800,fontSize:15,cursor:"pointer",fontFamily:"inherit"}}>➕ Neues Team anlegen</button>
      <button onClick={()=>setMode("join")} style={{padding:"14px",borderRadius:12,border:`1.5px solid ${C.border}`,background:"white",color:C.text,fontWeight:800,fontSize:15,cursor:"pointer",fontFamily:"inherit"}}>🔗 Team beitreten</button>
    </div>
  </Shell>;

  if(mode==="create") return <Shell>
    <button onClick={()=>setMode(null)} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:0,marginBottom:14,fontFamily:"inherit"}}>← Zurück</button>
    <div style={{fontWeight:800,fontSize:14,color:C.text,marginBottom:8}}>Name deines Teams</div>
    <input value={name} onChange={e=>setName(e.target.value)} placeholder="z.B. SC Sternschanze G-Jugend 2019"
      style={{width:"100%",padding:"10px 14px",border:`1.5px solid ${C.border}`,borderRadius:10,fontSize:14,color:C.text,background:C.bg,outline:"none",fontFamily:"inherit"}}/>
    <button onClick={doCreate} disabled={busy||!name.trim()} style={{marginTop:14,width:"100%",padding:"12px",borderRadius:10,border:"none",background:busy||!name.trim()?"#94a3b8":C.primary,color:"white",fontWeight:800,fontSize:14,cursor:busy||!name.trim()?"default":"pointer",fontFamily:"inherit"}}>{busy?"Wird angelegt...":"Team anlegen"}</button>
    <div style={{fontSize:11,color:C.muted,marginTop:10,textAlign:"center"}}>Du wirst automatisch Admin dieses Teams. Ein Einladungscode wird erzeugt.</div>
  </Shell>;

  // mode==="join"
  return <Shell>
    <button onClick={()=>setMode(null)} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:0,marginBottom:14,fontFamily:"inherit"}}>← Zurück</button>
    <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:10,padding:4,marginBottom:16}}>
      <button onClick={()=>setJoinTab("code")} style={{flex:1,padding:"7px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit",background:joinTab==="code"?C.primary:"transparent",color:joinTab==="code"?"white":C.muted}}>Code eingeben</button>
      <button onClick={()=>setJoinTab("browse")} style={{flex:1,padding:"7px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"inherit",background:joinTab==="browse"?C.primary:"transparent",color:joinTab==="browse"?"white":C.muted}}>Team wählen</button>
    </div>
    {joinTab==="code"?<div>
      <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="z.B. AB12CD" maxLength={8}
        style={{width:"100%",padding:"10px 14px",border:`1.5px solid ${C.border}`,borderRadius:10,fontSize:16,letterSpacing:2,textAlign:"center",color:C.text,background:C.bg,outline:"none",fontFamily:"inherit",textTransform:"uppercase"}}/>
      <button onClick={doJoinCode} disabled={busy||!code.trim()} style={{marginTop:14,width:"100%",padding:"12px",borderRadius:10,border:"none",background:busy||!code.trim()?"#94a3b8":C.primary,color:"white",fontWeight:800,fontSize:14,cursor:busy||!code.trim()?"default":"pointer",fontFamily:"inherit"}}>{busy?"Prüfe...":"Beitreten"}</button>
      <div style={{fontSize:11,color:C.muted,marginTop:10,textAlign:"center"}}>Den Code bekommst du von deinem Trainer. Sofortiger Beitritt als „Eltern".</div>
    </div>:<div>
      {allGroups.length===0?<div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"10px 0"}}>Noch keine Teams vorhanden.</div>:<>
        <select value={selectedGroupId} onChange={e=>setSelectedGroupId(e.target.value)}
          style={{width:"100%",padding:"10px 14px",border:`1.5px solid ${C.border}`,borderRadius:10,fontSize:14,color:C.text,background:C.bg,outline:"none",fontFamily:"inherit"}}>
          <option value="">— Team wählen —</option>
          {allGroups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button onClick={doRequestJoin} disabled={busy||!selectedGroupId} style={{marginTop:14,width:"100%",padding:"12px",borderRadius:10,border:"none",background:busy||!selectedGroupId?"#94a3b8":C.primary,color:"white",fontWeight:800,fontSize:14,cursor:busy||!selectedGroupId?"default":"pointer",fontFamily:"inherit"}}>{busy?"Sende...":"Beitritt anfragen"}</button>
        <div style={{fontSize:11,color:C.muted,marginTop:10,textAlign:"center"}}>Der Admin dieses Teams muss deinen Beitritt bestätigen.</div>
      </>}
    </div>}
  </Shell>;
}

export default function App() {
  const [page,setPage]=useState(()=>sessionStorage.getItem("gjPage")||"start");
  const [darkMode,setDarkMode]=useState(()=>{try{const _prefs=JSON.parse(localStorage.getItem("personal_guest")||"{}");return _prefs.darkMode||false;}catch{return false;}});
  useEffect(()=>sessionStorage.setItem("gjPage",page),[page]);
  // Zurück-Navigation: kleine Historie (max. 5) der zuletzt besuchten Seiten
  const [pageHistory,setPageHistory]=useState([]);
  const prevPageRef=useRef(page);
  const skipNextHistoryPushRef=useRef(false);
  useEffect(()=>{
    if(prevPageRef.current!==page){
      if(skipNextHistoryPushRef.current){
        skipNextHistoryPushRef.current=false;
      }else{
        setPageHistory(h=>[...h,prevPageRef.current].slice(-5));
      }
      prevPageRef.current=page;
    }
  },[page]);
  const goBack=()=>{
    setPageHistory(h=>{
      if(h.length===0)return h;
      const target=h[h.length-1];
      skipNextHistoryPushRef.current=true;
      setPage(target);
      return h.slice(0,-1);
    });
  };
  const [pendingSetup,setPendingSetup]=useState(null);
  const [pendingLibraryCat,setPendingLibraryCat]=useState(null);
  const [pendingOrgaTarget,setPendingOrgaTarget]=useState(null);
  const [pendingTurnierId,setPendingTurnierId]=useState(null);
  const [pendingCalendarTarget,setPendingCalendarTarget]=useState(null);
  const { user, login, loginEmail, registerEmail, resetPassword, logout, onlineUsers } = useFirebaseAuth();
  const { role: globalRole, allUsers, setUserRole, setUserName, deleteUser, pendingCount } = useRole(user);
  const isGlobalAdmin = globalRole==="admin";
  // Einmalige, idempotente Gruppen-Migration (legt Gruppe an + kopiert shared/*-Daten, falls noch nicht geschehen)
  useEffect(()=>{ if(user) ensureGroupMigrated(user); },[user]);
  // Gruppen, in denen der Nutzer Mitglied ist + aktuell ausgewählte Gruppe
  const memberships = useUserGroups(user);
  const [currentGroupId, setCurrentGroupIdRaw] = useState(()=>localStorage.getItem("currentGroupId")||null);
  const setCurrentGroupId = (gid) => { setCurrentGroupIdRaw(gid); if(gid) localStorage.setItem("currentGroupId",gid); else localStorage.removeItem("currentGroupId"); };
  useEffect(()=>{
    if(!memberships) return; // lädt noch
    const stillValid = currentGroupId && memberships.some(m=>m.groupId===currentGroupId);
    if(!stillValid && memberships.length>0) setCurrentGroupId(memberships[0].groupId);
    if(!stillValid && memberships.length===0) setCurrentGroupId(null);
  },[memberships]);
  const currentMembership = memberships?.find(m=>m.groupId===currentGroupId);
  // Effektive Rolle für Tab-/Aktions-Berechtigungen: globaler Admin ist überall admin,
  // sonst zählt die Rolle innerhalb der aktuell aktiven Gruppe.
  const role = isGlobalAdmin ? "admin" : (currentMembership?.role || null);
  const [prefs, setPrefs] = usePersonalSettings(user?.uid);
  // Offene Beitrittswünsche der aktuellen Gruppe (nur relevant für den Gruppen-Admin)
  const groupJoinRequests = useJoinRequests(currentGroupId, role==="admin");
  const prevJoinReqRef = React.useRef(groupJoinRequests.length);
  useEffect(()=>{
    if(role==="admin"&&groupJoinRequests.length>prevJoinReqRef.current){
      toast(`👤 Neuer Beitrittswunsch für dein Team!`,"warn");
    }
    prevJoinReqRef.current=groupJoinRequests.length;
  },[groupJoinRequests.length,role]);
  const toggleDark = (val) => { setPrefs({darkMode:val}); setDarkMode(val); applyTheme(val); };
  // Apply default page from prefs
  useEffect(()=>{ if(prefs.defaultPage&&!sessionStorage.getItem("gjPage")) setPage(prefs.defaultPage); },[prefs.defaultPage]);
  // Redirect if current page not allowed for role
  useEffect(()=>{
    if(role&&!can(role,page)){
      // trainer and eltern have access to simplified settings
      const hasAccess=can(role,page)||(page==="settings"&&(role==="trainer"||role==="eltern"));
      if(!hasAccess){
        const allowed=["start","calendar","library","team","training","teamplaner","turnier","kasse","orga","settings"].find(pg=>can(role,pg)||(pg==="settings"&&(role==="trainer"||role==="eltern")));
        if(allowed) setPage(allowed);
      }
    }
  },[role,page]);
  const [exercises,  setExercises,  er]=useCloudStorage("exercises",  [], user, currentGroupId);
  const [players,    setPlayers,    pr]=useCloudStorage("players",    [], user, currentGroupId);
  const [coaches,    setCoaches,    cr]=useCloudStorage("coaches",    [], user, currentGroupId);
  const [sessions,   setSessions,   sr]=useCloudStorage("sessions",   [], user, currentGroupId);
  const [tournaments,setTournaments,tr]=useCloudStorage("tournaments",[], user, currentGroupId);
  const [kassenbuch, setKassenbuch, kr]=useCloudStorage("kassenbuch", [], user, currentGroupId);
  const [todos,      setTodos,      tor]=useCloudStorage("todos",      [], user, currentGroupId);
  const [meetings,   setMeetings,   mr]=useCloudStorage("meetings",   [], user, currentGroupId);
  const [recurringSlots,setRecurringSlots,rsr]=useCloudStorage("recurringSlots",[], user, currentGroupId);
  const [apiKey,     setApiKey,     ar]=useStorage("apiKey",     "");
  const [lastExportAt,setLastExportAt]=useStorage("lastExportAt","");
  const [customCats, setCustomCats    ]=useCloudStorage("customCats", [], user);
  const [teamsets,   setTeamsets        ]=useCloudStorage("teamsets",   [], user);
  const saveTSets=x=>{
    setTeamsets(upsert(x));
    const name=typeof x==="object"&&!Array.isArray(x)?x.name||"Aufstellung":"Aufstellung";
    logActivity(user,"teams_saved",name);
  };
  // Sync CATS global whenever customCats changes
  useEffect(()=>{
    const merged={...BUILTIN_CATS};
    (customCats||[]).forEach((cc,i)=>{ merged['custom_'+i]={...cc}; });
    Object.keys(CATS).forEach(k=>{if(k.startsWith('custom_'))delete CATS[k];});
    Object.assign(CATS,merged);
  },[customCats]);
  const {toast,Toasts}=useToast();
  const doFullBackup=async()=>{await dlJson({version:APP_VERSION,exportDate:new Date().toISOString(),type:"full",exercises,players,coaches,sessions,tournaments,kassenbuch,teamsets,customCats,recurringSlots},`GJugend_Backup_alle-Daten_${todayISO()}.json`,toast);setLastExportAt(new Date().toISOString());};
  const [undoBuf,setUndoBuf]=useState(null);
  function showUndo(label,item,restoreFn){
    if(undoBuf?.t)clearTimeout(undoBuf.t);
    const t=setTimeout(()=>setUndoBuf(null),5000);
    setUndoBuf({label:`${label} gelöscht`,t,
      restore:()=>{clearTimeout(t);restoreFn();setUndoBuf(null);toast(`${label} wiederhergestellt`,"ok");}
    });
  }
  // Functional update helpers - prevent stale closure bugs
  const mergeArr=(inc)=>prev=>{ const m=Object.fromEntries(prev.map(e=>[e.id,e]));inc?.forEach(i=>{if(!m[i.id])m[i.id]=i;});return Object.values(m); };
  const upsert=(x)=>prev=>prev.find(e=>e.id===x.id)?prev.map(e=>e.id===x.id?x:e):[...prev,x];

  const saveEx=x=>{ setExercises(upsert(x));logActivity(user,"exercise_saved",x.title||"");toast('Übung gespeichert'); };
  const savePl=x=>{ setPlayers(upsert(x));logActivity(user,"player_saved",x.name||"");toast('Spieler gespeichert'); };
  const saveCo=x=>{ setCoaches(upsert(x));logActivity(user,"coach_saved",x.name||"");toast('Trainer gespeichert'); };
  const saveSe=x=>{ setSessions(upsert(x));logActivity(user,"session_saved",x.date||"");toast('Training gespeichert'); };
  const saveTo=x=>{ setTournaments(upsert(x)); };
  const saveKa=x=>{ setKassenbuch(upsert(x)); };
  const saveTodo=x=>{ setTodos(upsert(x)); };
  const saveMeeting=x=>{ setMeetings(upsert(x)); };
  const saveSlot=x=>{ setRecurringSlots(upsert(x)); };
  const generateSessions=(newSessions)=>{
    if(!newSessions||!newSessions.length){ toast("Keine neuen Trainings im Zeitraum (evtl. schon vorhanden)"); return; }
    setSessions(prev=>[...prev,...newSessions]);
    logActivity(user,"sessions_generated",`${newSessions.length} Termine`);
    toast(`${newSessions.length} Trainings erstellt`);
  };

  const normExCats=exs=>(exs||[]).map(e=>({...e,category:normCat(e.category)||"uebung"}));
  const doImport=(data,mode)=>{
    if(mode==='merge'){
      if(data.exercises)setExercises(mergeArr(normExCats(data.exercises)));
      if(data.players)setPlayers(mergeArr(data.players));
      if(data.coaches)setCoaches(mergeArr(data.coaches));
      if(data.sessions)setSessions(mergeArr(data.sessions));
      if(data.tournaments)setTournaments(mergeArr(data.tournaments));
      if(data.kassenbuch)setKassenbuch(mergeArr(data.kassenbuch));
      if(data.teamsets)setTeamsets(mergeArr(data.teamsets));
      if(data.customCats)setCustomCats(data.customCats);
      if(data.recurringSlots)setRecurringSlots(mergeArr(data.recurringSlots));
    } else if(mode==='replace'){
      if(data.exercises)setExercises(normExCats(data.exercises));
      if(data.players)setPlayers(data.players);
      if(data.coaches)setCoaches(data.coaches);
      if(data.sessions)setSessions(data.sessions);
      if(data.tournaments)setTournaments(data.tournaments);
      if(data.kassenbuch)setKassenbuch(data.kassenbuch);
      if(data.teamsets)setTeamsets(data.teamsets);
      if(data.customCats)setCustomCats(data.customCats);
      if(data.recurringSlots)setRecurringSlots(data.recurringSlots);
    } else if(mode==='merge_players') setPlayers(mergeArr(data.players));
    else if(mode==='replace_players') setPlayers(data.players||[]);
  };
  // Auth still loading
  if(user===undefined||!er||!pr||!cr||!sr||!tr||!kr||!tor||!mr||!ar) return <div style={{height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.bg}}><div style={{textAlign:"center",color:C.muted}}><div style={{fontSize:40,marginBottom:12}}>⚽</div><div style={{fontWeight:700}}>Lade...</div></div></div>;
  // Not logged in - show login screen
  if(!user) return <AuthScreen onGoogle={login} onEmail={loginEmail} onRegister={registerEmail} onReset={resetPassword}/>;
  // Globale Rolle / Gruppen-Mitgliedschaften laden
  if(globalRole===null||memberships===null) return <div style={{height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.bg}}><div style={{textAlign:"center",color:C.muted}}><div style={{fontSize:40,marginBottom:12}}>⏳</div><div style={{fontWeight:700}}>Lade Berechtigungen...</div><div style={{fontSize:12,marginTop:8}}>Falls dies länger dauert, bitte neu laden</div></div></div>;
  // In keiner Gruppe? → Onboarding (Team anlegen oder beitreten). Jeder eingeloggte Nutzer landet hier,
  // niemand wird mehr global blockiert.
  if(memberships.length===0||!currentGroupId) return <GroupOnboarding user={user} onLogout={logout} toast={toast}/>;
  return(<div style={{fontFamily:"system-ui,-apple-system,sans-serif",background:C.bg,minHeight:"100vh"}}>
    <style>{`*{box-sizing:border-box}body{margin:0}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px}`}</style>
    <Toasts/>
    <Nav page={page} setPage={setPage} counts={{exercises:exercises.length,players:players.filter(p=>p.active).length,sessions:sessions.length,tournaments:tournaments.length,teamsets:teamsets.length,openTodos:todos.filter(t=>!t.done).length||undefined,role,pendingCount:role==="admin"?groupJoinRequests.length:0}}/>
    <main className="gm" style={{display:"block"}}>
      {page==="start"    &&<StartPage players={players} coaches={coaches} sessions={sessions} tournaments={tournaments} todos={todos} meetings={meetings} teamsets={teamsets} kassenbuch={kassenbuch} exercises={exercises} role={role} currentUser={user} onlineUsers={onlineUsers} onNavigate={setPage} onOpenLibraryCategory={cat=>{setPendingLibraryCat(cat);setPage("library");}} onOpenOrgaItem={target=>{setPendingOrgaTarget(target);setPage("orga");}} onOpenCalendarItem={target=>{setPendingCalendarTarget(target);setPage("calendar");}} onOpenTournament={id=>{setPendingTurnierId(id);setPage("turnier");}} onSaveExercise={saveEx} onDeleteExercise={id=>{const i=exercises.find(e=>e.id===id);setExercises(prev=>prev.filter(e=>e.id!==id));showUndo("Übung",i,()=>setExercises(prev=>[i,...prev]));}} onGoBack={pageHistory.length>0?goBack:null}/>}
      {page==="library"  &&<LibraryPage  exercises={exercises} onSave={saveEx} onDelete={id=>{const i=exercises.find(e=>e.id===id);setExercises(prev=>prev.filter(e=>e.id!==id));showUndo("Übung",i,()=>setExercises(prev=>[i,...prev]));}} apiKey={apiKey} toast={toast} onlineUsers={onlineUsers} currentUser={user} initialCategory={pendingLibraryCat} onConsumeInitialCategory={()=>setPendingLibraryCat(null)} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null}/>}
      {page==="team"     &&<TeamPage     players={players} coaches={coaches} sessions={sessions} onSaveSession={saveSe} onSavePlayer={can(role,"editAnything")?savePl:null} onDeletePlayer={can(role,"editAnything")?id=>{const i=players.find(p=>p.id===id);setPlayers(prev=>prev.filter(p=>p.id!==id));showUndo("Spieler",i,()=>setPlayers(prev=>[i,...prev]));}:null} onSaveCoach={can(role,"editAnything")?saveCo:null} onDeleteCoach={can(role,"editAnything")?id=>{const i=coaches.find(c=>c.id===id);setCoaches(prev=>prev.filter(c=>c.id!==id));showUndo("Trainer",i,()=>setCoaches(prev=>[i,...prev]));}:null} toast={toast} showStrength={can(role,"seeStrength")} readOnly={!can(role,"editAnything")} onAddToTraining={can(role,"editAnything")?({playerIds,coachIds,kids,coachCount})=>{setPendingSetup({playerIds,coachIds,kids:kids||playerIds.length,coachCount:coachCount||1,date:todayISO(),location:"outdoor",focus:""});setPage("training");}:null} onlineUsers={onlineUsers} currentUser={user} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null}/>}
      {page==="orga"&&can(role,"orga")&&<OrgaPage todos={todos} onSaveTodo={saveTodo} onDeleteTodo={id=>{const i=todos.find(t=>t.id===id);setTodos(prev=>prev.filter(t=>t.id!==id));showUndo("Task",i,()=>setTodos(prev=>[i,...prev]));}} coaches={coaches} currentUser={user} toast={toast} showUndo={showUndo} readOnly={!can(role,"editAnything")} onlineUsers={onlineUsers} pendingTarget={pendingOrgaTarget} onClearPendingTarget={()=>setPendingOrgaTarget(null)} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null}/>}
      {page==="teamplaner"&&<TeamplanerPage players={players} teamsets={teamsets} onSaveTeamset={can(role,"editAnything")?saveTSets:null} onDeleteTeamset={can(role,"editAnything")?id=>{const i=teamsets.find(t=>t.id===id);setTeamsets(prev=>prev.filter(t=>t.id!==id));showUndo("Team-Aufstellung",i,()=>setTeamsets(prev=>[i,...prev]));}:null} readOnly={!can(role,"editAnything")} showStrength={can(role,"seeStrength")} toast={toast} onlineUsers={onlineUsers} currentUser={user} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null}/>}
      {page==="training" &&<TrainingPage sessions={sessions} players={players} coaches={coaches} exercises={exercises} onSaveSession={saveSe} onDeleteSession={id=>{const i=sessions.find(s=>s.id===id);setSessions(prev=>prev.filter(s=>s.id!==id));showUndo("Training",i,()=>setSessions(prev=>[i,...prev]));}} onSavePlayer={can(role,"editAnything")?savePl:null} apiKey={apiKey} toast={toast} onSaveExercise={saveEx} pendingSetup={pendingSetup} onClearPendingSetup={()=>setPendingSetup(null)} onlineUsers={onlineUsers} currentUser={user} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null} onGoToCalendar={()=>setPage("calendar")} recurringSlots={recurringSlots} onSaveSlot={saveSlot} onDeleteSlot={id=>{const i=recurringSlots.find(s=>s.id===id);setRecurringSlots(prev=>prev.filter(s=>s.id!==id));showUndo("Serientermin",i,()=>setRecurringSlots(prev=>[i,...prev]));}} onGenerateSessions={generateSessions}/>}
      {page==="turnier"  &&<TurnierPage  tournaments={tournaments} onSaveTournament={saveTo} onDeleteTournament={id=>{const i=tournaments.find(t=>t.id===id);setTournaments(prev=>prev.filter(t=>t.id!==id));showUndo("Turnier",i,()=>setTournaments(prev=>[i,...prev]));}} coaches={coaches} players={players} onSavePlayer={can(role,"editAnything")?savePl:null} onlineUsers={onlineUsers} currentUser={user} toast={toast} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null} initialOpenId={pendingTurnierId} onClearInitialOpen={()=>setPendingTurnierId(null)}/>}
      {page==="calendar" &&<CalendarPage sessions={sessions} meetings={meetings} tournaments={tournaments} players={players} coaches={coaches} exercises={exercises} onSaveSession={saveSe} onDeleteSession={id=>{const i=sessions.find(s=>s.id===id);setSessions(prev=>prev.filter(s=>s.id!==id));showUndo("Training",i,()=>setSessions(prev=>[i,...prev]));}} onSavePlayer={can(role,"editAnything")?savePl:null} onSaveMeeting={saveMeeting} onDeleteMeeting={id=>{const i=meetings.find(m=>m.id===id);setMeetings(prev=>prev.filter(m=>m.id!==id));showUndo("Trainertreff",i,()=>setMeetings(prev=>[i,...prev]));}} onSaveTournament={saveTo} onSaveExercise={saveEx} apiKey={apiKey} toast={toast} readOnly={!can(role,"editAnything")} onOpenTournament={id=>{setPendingTurnierId(id);setPage("turnier");}} pendingTarget={pendingCalendarTarget} onClearPendingTarget={()=>setPendingCalendarTarget(null)} onlineUsers={onlineUsers} currentUser={user} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null}/>}
      {page==="kasse"    &&can(role,"kasse")&&<KassePage kassenbuch={kassenbuch} onSave={can(role,"editKasse")?saveKa:null} onDelete={can(role,"editKasse")?id=>{const i=kassenbuch.find(k=>k.id===id);setKassenbuch(prev=>prev.filter(k=>k.id!==id));showUndo("Eintrag",i,()=>setKassenbuch(prev=>[i,...prev]));}:null} readOnly={!can(role,"editKasse")} toast={toast} onlineUsers={onlineUsers} currentUser={user} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null}/>}
      {(can(role,"settings")||role==="trainer"||role==="eltern")&&page==="settings"&&<SettingsPage exercises={exercises} players={players} coaches={coaches} sessions={sessions} tournaments={tournaments} kassenbuch={kassenbuch} onImport={doImport} toast={toast} apiKey={apiKey} onSaveApiKey={k=>setApiKey(k)} customCats={customCats} onSaveCustomCats={setCustomCats} firebaseUser={user} onLogout={logout} onFullBackup={doFullBackup} role={role} isGlobalAdmin={isGlobalAdmin} allUsers={allUsers} setUserRole={setUserRole} setUserName={setUserName} deleteUser={deleteUser} prefs={prefs} onPrefChange={toggleDark} onlineUsers={onlineUsers} currentGroupId={currentGroupId} memberships={memberships} onSwitchGroup={setCurrentGroupId} onGoHome={()=>setPage("start")} onGoBack={pageHistory.length>0?goBack:null}/>}
    </main>
    {undoBuf&&<div style={{position:"fixed",bottom:76,left:12,right:12,zIndex:9999,display:"flex",alignItems:"center",gap:10,background:"#1e293b",color:"white",borderRadius:12,padding:"12px 16px",boxShadow:"0 4px 24px rgba(0,0,0,.35)"}}>
      <span style={{fontSize:13,fontWeight:600,flex:1}}>{undoBuf.label}</span>
      <button onClick={undoBuf.restore} style={{background:"#3b82f6",color:"white",border:"none",borderRadius:8,padding:"6px 14px",fontSize:13,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap"}}>↩ Rückgängig</button>
      <button onClick={()=>{clearTimeout(undoBuf.t);setUndoBuf(null);}} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:18,lineHeight:1,padding:"0 2px"}}>✕</button>
    </div>}
  </div>);
}
