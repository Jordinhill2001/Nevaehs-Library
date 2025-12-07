// app-cloud.js
// Notes Bookshelf — Cloud-enabled version
// - uses IndexedDB as local cache + Firebase Firestore + Storage for cloud sync
// - image compression via canvas before upload
// - swipeable bookshelf pages
// - drag/drop reordering, edit, delete
// - options for thumbnail width, quality, autosync

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, addDoc, onSnapshot, query, where, getDocs, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js";

/* ---------- USER CONFIG: replace this with your Firebase project's settings ---------- */
// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAwP6Wg7TXNLE5KwmFGPFTH-scgDgImHRA",
  authDomain: "nevaehs-library.firebaseapp.com",
  projectId: "nevaehs-library",
  storageBucket: "nevaehs-library.firebasestorage.app",
  messagingSenderId: "923638298894",
  appId: "1:923638298894:web:c5ab668b528f8413b8bf5f",
  measurementId: "G-WPTM7S07Y1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
/* ------------------------------------------------------------------------------------- */

// initialize firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// Local DB constants (IndexedDB)
const DB_NAME = 'notesBookshelfDB';
const DB_VER = 2;
const STORE_NOTES = 'notes';
const STORE_META = 'meta';

let idb;
let currentBookshelfIndex = 0;   // index into local array of bookshelves (swipe pages)
let bookshelves = [];            // array of bookshelf meta {id, createdAt}
let localUser = null;

const MAX_SHELVES = 3;  // per page (visual rows)
const MAX_PER_SHELF = 10; // books per row

/* UI references */
const swipeContainer = document.getElementById('swipeContainer');
const themeSelect = document.getElementById('themeSelect');
const newNoteBtn = document.getElementById('newNoteBtn');
const prevShelfBtn = document.getElementById('prevShelfBtn');
const nextShelfBtn = document.getElementById('nextShelfBtn');
const optionsBtn = document.getElementById('optionsBtn');
const optionsModal = document.getElementById('optionsModal');
const optThumbWidth = document.getElementById('optThumbWidth');
const optQuality = document.getElementById('optQuality');
const optAutoNew = document.getElementById('optAutoNew');
const optSync = document.getElementById('optSync');
const saveOptionsBtn = document.getElementById('saveOptionsBtn');
const closeOptionsBtn = document.getElementById('closeOptionsBtn');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const noteTitle = document.getElementById('noteTitle');
const noteBody = document.getElementById('noteBody');
const imageInput = document.getElementById('imageInput');
const saveNoteBtn = document.getElementById('saveNoteBtn');
const cancelNoteBtn = document.getElementById('cancelNoteBtn');
const statusBar = document.getElementById('statusBar');
const authBtn = document.getElementById('authBtn');
const authModal = document.getElementById('authModal');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authSignInBtn = document.getElementById('authSignInBtn');
const authCloseBtn = document.getElementById('authCloseBtn');
const authMessage = document.getElementById('authMessage');
const modalMessage = document.getElementById('modalMessage');

let pendingEdit = null;   // {id, pos: {page, shelf, slot}} when editing an existing note
let pendingPos = null;    // target pos when creating new
let inMemoryImage = null; // File or Blob from input
let localOpts = loadOptions();

// --- IndexedDB helpers ------------------------------------------------
function openIDB(){
  return new Promise((resolve,reject)=>{
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(STORE_NOTES)){
        const ns = db.createObjectStore(STORE_NOTES, { keyPath: 'id', autoIncrement: true });
        ns.createIndex('bookshelf', 'bookshelf', { unique:false });
      }
      if(!db.objectStoreNames.contains(STORE_META)){
        db.createObjectStore(STORE_META, { keyPath: 'id', autoIncrement: true });
      }
    };
    rq.onsuccess = e => { idb = e.target.result; resolve(idb); };
    rq.onerror = e => reject(e.target.error);
  });
}

function idbRequestPromise(req){
  return new Promise((res, rej) => {
    req.onsuccess = ev => res(ev.target.result);
    req.onerror = ev => rej(ev.target.error);
  });
}

// --- Utilities: image resize/compress ---------------------------------
async function imageFileToCompressedBlob(file, maxWidth, quality=0.8){
  // Create an image element to draw into canvas (works for PNG/JPEG)
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try{
        const ratio = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        // Use toBlob to create compressed blob (webp/jpeg). Use 'image/png' if you need PNG lossless.
        canvas.toBlob((blob) => {
          resolve(blob);
        }, 'image/jpeg', quality);
      }catch(err){ reject(err); }
    };
    img.onerror = (e) => reject(e);
    // read file as data URL
    const reader = new FileReader();
    reader.onload = e => img.src = e.target.result;
    reader.onerror = e => reject(e);
    reader.readAsDataURL(file);
  });
}

// --- Bookshelf model helpers -----------------------------------------
async function loadLocalBookshelves(){
  // meta store holds list of bookshelf pages
  const tx = idb.transaction(STORE_META,'readonly');
  const store = tx.objectStore(STORE_META);
  const req = store.getAll();
  const items = await idbRequestPromise(req);
  if(!items || items.length===0){
    // create initial bookshelf
    const tx2 = idb.transaction(STORE_META,'readwrite');
    const store2 = tx2.objectStore(STORE_META);
    const nowId = await idbRequestPromise(store2.add({label:'bookshelf-1', createdAt:Date.now(), pageIndex:0}));
    bookshelves = [{id: nowId, label: 'bookshelf-1', pageIndex:0}];
    currentBookshelfIndex = 0;
    return bookshelves;
  } else {
    // sort by pageIndex
    bookshelves = items.slice().sort((a,b)=> (a.pageIndex||0)-(b.pageIndex||0));
    currentBookshelfIndex = 0;
    return bookshelves;
  }
}

async function createNewBookshelf(){
  const tx = idb.transaction(STORE_META,'readwrite');
  const store = tx.objectStore(STORE_META);
  const label = `bookshelf-${bookshelves.length+1}`;
  const id = await idbRequestPromise(store.add({label, createdAt: Date.now(), pageIndex: bookshelves.length}));
  bookshelves.push({id, label, pageIndex: bookshelves.length});
  currentBookshelfIndex = bookshelves.length-1;
  await renderAll();
}

// get notes for a bookshelf id
async function getNotesForBookshelf(bookshelfId){
  const tx = idb.transaction(STORE_NOTES,'readonly');
  const store = tx.objectStore(STORE_NOTES);
  const idx = store.index('bookshelf');
  const req = idx.getAll(IDBKeyRange.only(bookshelfId));
  const list = await idbRequestPromise(req);
  return list || [];
}

// add or update note locally
async function saveNoteLocal(note){
  const tx = idb.transaction(STORE_NOTES,'readwrite');
  const store = tx.objectStore(STORE_NOTES);
  if(note.id){
    await idbRequestPromise(store.put(note));
  } else {
    const id = await idbRequestPromise(store.add(note));
    note.id = id;
  }
  return note;
}

// delete note locally
async function deleteNoteLocal(id){
  const tx = idb.transaction(STORE_NOTES,'readwrite');
  const store = tx.objectStore(STORE_NOTES);
  await idbRequestPromise(store.delete(id));
}

// --- Cloud sync helpers (Firestore + Storage) -------------------------
function getUserBookshelfCollection(uid){
  return collection(db, `users/${uid}/bookshelves`);
}
function getUserNotesCollection(uid){
  return collection(db, `users/${uid}/notes`);
}

async function uploadImageToStorage(uid, noteId, blob){
  if(!blob) return null;
  const path = `users/${uid}/images/${noteId}-${Date.now()}.jpg`;
  const ref = storageRef(storage, path);
  const snap = await uploadBytes(ref, blob);
  const url = await getDownloadURL(ref);
  return {path, url};
}

async function deleteImageFromStorageByPath(path){
  if(!path) return;
  try{
    const ref = storageRef(storage, path);
    await deleteObject(ref);
  }catch(err){
    console.warn('delete storage failed', err);
  }
}

// save note to cloud: upload image first, then write note doc
async function saveNoteCloud(uid, note){
  const notesCol = getUserNotesCollection(uid);
  // If note has blob and no cloudImage, upload and set field
  let cloudImage = note.cloudImage || null;
  if(note.imageBlob){
    // compress again if needed
    const blob = note.imageBlob;
    const uploadInfo = await uploadImageToStorage(uid, note.id || 'temp', blob);
    cloudImage = uploadInfo; // {path, url}
    // remove heavy blob from cloud-synced doc
  }
  // Write metadata to Firestore
  const docRef = doc(notesCol, String(note.id || `${Date.now()}-${Math.random()}`));
  const docData = {
    id: note.id,
    title: note.title || '',
    body: note.body || '',
    bookshelf: note.bookshelf,
    pos: note.pos,
    createdAt: note.createdAt || Date.now(),
    updatedAt: Date.now(),
    cloudImage: cloudImage || null
  };
  await setDoc(docRef, docData);
  return docData;
}

// synchronize local DB to cloud (one-way push for entries missing cloud flag)
async function pushLocalToCloud(uid){
  const tx = idb.transaction(STORE_NOTES,'readonly');
  const store = tx.objectStore(STORE_NOTES);
  const req = store.getAll();
  const localNotes = await idbRequestPromise(req);
  for(const n of localNotes){
    // if this note already has field cloudSynced, skip
    if(n.cloudSynced) continue;
    // upload image if present
    let cloudImage = null;
    if(n.imageBlob){
      const c = await uploadImageToStorage(uid, n.id || Date.now(), n.imageBlob);
      cloudImage = c;
    }
    // write to cloud
    const notesCol = getUserNotesCollection(uid);
    const docRef = doc(notesCol, String(n.id || `${Date.now()}-${Math.random()}`));
    await setDoc(docRef, {
      id: n.id,
      title: n.title || '',
      body: n.body || '',
      bookshelf: n.bookshelf,
      pos: n.pos,
      createdAt: n.createdAt,
      updatedAt: Date.now(),
      cloudImage
    });
    // mark local as synced
    n.cloudSynced = true;
    await saveNoteLocal(n);
  }
}

// subscribe to cloud changes and mirror locally (real-time)
let cloudUnsub = null;
function listenCloudNotes(uid){
  // unsubscribe previous
  if(cloudUnsub) cloudUnsub();
  const notesCol = getUserNotesCollection(uid);
  // in production you'd scope to user's docs; here's a simple onSnapshot of the collection
  cloudUnsub = onSnapshot(notesCol, async (snapshot)=>{
    // iterate docs and upsert locally
    for(const docSnap of snapshot.docs){
      const data = docSnap.data();
      // upsert into local IDB by doc id if present
      // convert cloudImage to something minimal (path and url)
      const existingTx = idb.transaction(STORE_NOTES,'readonly');
      const store = existingTx.objectStore(STORE_NOTES);
      // try to find local note with same id
      const idxReq = store.get(Number(data.id));
      const existing = await idbRequestPromise(idxReq).catch(()=>null);
      const noteObj = {
        id: Number(data.id),
        title: data.title,
        body: data.body,
        bookshelf: data.bookshelf,
        pos: data.pos,
        createdAt: data.createdAt,
        cloudImage: data.cloudImage
      };
      // Save local; we don't store imageBlob for cloud-only items
      const tx2 = idb.transaction(STORE_NOTES,'readwrite');
      const store2 = tx2.objectStore(STORE_NOTES);
      await idbRequestPromise(store2.put(noteObj));
    }
    // re-render UI
    await renderAll();
  }, (err)=>{ console.warn('cloud snapshot error', err); });
}

// --- UI rendering and interactions ----------------------------------
function applyTheme(theme){
  if(theme==='wood'){
    document.documentElement.style.setProperty('--bg','#f0e6d6');
    document.documentElement.style.setProperty('--shelf','#b07a3f');
    document.documentElement.style.setProperty('--book','#f7d7a3');
    document.documentElement.style.setProperty('--text','#2d1f12');
  } else if(theme==='modern'){
    document.documentElement.style.setProperty('--bg','#f7f9fc');
    document.documentElement.style.setProperty('--shelf','#d0d7e6');
    document.documentElement.style.setProperty('--book','#ffffff');
    document.documentElement.style.setProperty('--text','#222');
  } else if(theme==='dark'){
    document.documentElement.style.setProperty('--bg','#0f1720');
    document.documentElement.style.setProperty('--shelf','#334155');
    document.documentElement.style.setProperty('--book','#0b1220');
    document.documentElement.style.setProperty('--text','#e2e8f0');
  }
}

themeSelect.addEventListener('change', (e) => {
  applyTheme(e.target.value);
  localStorage.setItem('ns_theme', e.target.value);
});

// render all pages
async function renderAll(){
  swipeContainer.innerHTML = '';
  // ensure local bookshelves exist
  if(bookshelves.length===0){
    await createNewBookshelf();
  }
  for(let p=0;p<bookshelves.length;p++){
    const shelfMeta = bookshelves[p];
    const pageEl = document.createElement('div');
    pageEl.className = 'bookshelf-page';
    pageEl.dataset.pageIndex = p;
    pageEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
                          <strong>${shelfMeta.label}</strong>
                          <small>${new Date(shelfMeta.createdAt).toLocaleString()}</small>
                        </div>`;
    // build up to MAX_SHELVES rows (visual)
    for(let s=0;s<MAX_SHELVES;s++){
      const shelfEl = document.createElement('section');
      shelfEl.className = 'shelf';
      shelfEl.dataset.shelf = s;
      shelfEl.innerHTML = `<div class="shelf-back" style="background: var(--shelf);"></div>
        <div class="books-row" id="books-row-${p}-${s}"></div>`;
      pageEl.appendChild(shelfEl);
    }
    swipeContainer.appendChild(pageEl);
    // populate notes for this bookshelf.id
    const notes = await getNotesForBookshelf(shelfMeta.id);
    for(let s=0;s<MAX_SHELVES;s++){
      const row = pageEl.querySelector(`#books-row-${p}-${s}`);
      for(let slot=0;slot<MAX_PER_SHELF;slot++){
        const note = notes.find(n => n.pos && n.pos.shelf===s && n.pos.slot===slot);
        const book = document.createElement('div');
        book.className = 'book';
        book.draggable = true;
        book.dataset.page = p;
        book.dataset.shelf = s;
        book.dataset.slot = slot;
        if(!note){
          book.classList.add('empty');
          book.innerHTML = `<span>Add</span>`;
          book.onclick = ()=> openModalAtPosition(p, s, slot);
        } else {
          // image: if local blob exists show blob, else if cloudImage.url show that
          if(note.imageBlob){
            const img = document.createElement('img');
            img.src = URL.createObjectURL(note.imageBlob);
            book.appendChild(img);
          } else if(note.cloudImage && note.cloudImage.url){
            const img = document.createElement('img');
            img.src = note.cloudImage.url;
            book.appendChild(img);
          }
          const t = document.createElement('span');
          t.className='title';
          t.textContent = note.title || (note.body||'Note').slice(0,60);
          book.appendChild(t);
          book.addEventListener('click', ()=> openNoteViewer(note));
          // right-click or long-press? For simplicity add context menu: edit/delete
          book.addEventListener('contextmenu', (ev)=> {
            ev.preventDefault();
            openContextMenu(note, ev.clientX, ev.clientY);
          });
        }

        // drag handlers for reordering
        book.addEventListener('dragstart', (e)=>{
          e.dataTransfer.setData('text/plain', JSON.stringify({fromPage:p, fromShelf:s, fromSlot:slot}));
          book.classList.add('dragging');
        });
        book.addEventListener('dragend', (e)=> book.classList.remove('dragging'));

        // allow drop on placeholder books
        book.addEventListener('dragover', (e)=> e.preventDefault());
        book.addEventListener('drop', async (e)=>{
          e.preventDefault();
          const payload = JSON.parse(e.dataTransfer.getData('text/plain'));
          const toPage = p, toShelf = s, toSlot = slot;
          await handleMove(payload, {toPage,toShelf,toSlot});
        });

        row.appendChild(book);
      }
    }
  }

  // scroll to currentBookshelfIndex
  const pages = [...swipeContainer.querySelectorAll('.bookshelf-page')];
  const target = pages[currentBookshelfIndex] || pages[0];
  if(target) target.scrollIntoView({behavior:'smooth', inline:'center'});
  updateStatusBar();
}

// open modal to create note at a specific page/shelf/slot
function openModalAtPosition(page, shelf, slot){
  pendingPos = {page, shelf, slot};
  pendingEdit = null;
  noteTitle.value = '';
  noteBody.value = '';
  imageInput.value = '';
  inMemoryImage = null;
  modalTitle.textContent = 'Create Note';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden','false');
}

// open note for viewing/editing
async function openNoteViewer(note){
  // For now reuse modal as edit dialog that can delete
  pendingEdit = note;
  pendingPos = null;
  noteTitle.value = note.title || '';
  noteBody.value = note.body || '';
  modalTitle.textContent = 'Edit Note';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden','false');
  modalMessage.textContent = note.cloudImage ? 'This note is cloud-backed' : '';
}

// context menu (simple prompt-based)
function openContextMenu(note, x, y){
  const choice = confirm('Edit this note? OK = Edit, Cancel = Delete');
  if(choice){
    openNoteViewer(note);
  } else {
    if(confirm('Delete note? This will remove it locally (and in cloud if enabled).')){
      deleteNote(note);
    }
  }
}

// handle drag/drop move between slots
async function handleMove(from, to){
  // locate source note local
  const pageMeta = bookshelves[from.fromPage];
  const targetMeta = bookshelves[to.toPage];
  if(!pageMeta || !targetMeta) return;
  // find note in local DB at source pos
  const notes = await getNotesForBookshelf(pageMeta.id);
  const note = notes.find(n => n.pos && n.pos.shelf===from.fromShelf && n.pos.slot===from.fromSlot);
  if(!note){
    alert('No note to move');
    return;
  }
  // move pos and bookshelf if crossing pages
  note.pos = {shelf: to.toShelf, slot: to.toSlot};
  note.bookshelf = targetMeta.id;
  await saveNoteLocal(note);
  // Optionally push to cloud
  if(localOpts.sync && localUser){
    await saveNoteCloud(localUser.uid, note);
  }
  await renderAll();
}

// Save note (create or edit)
saveNoteBtn.addEventListener('click', async ()=>{
  let title = noteTitle.value.trim();
  let body = noteBody.value.trim();

  // process any chosen imageFile
  let imageBlob = null;
  const file = (imageInput.files && imageInput.files[0]) || inMemoryImage;
  if(file){
    try{
      imageBlob = await imageFileToCompressedBlob(file, Number(localOpts.thumbWidth), Number(localOpts.quality));
    }catch(err){ console.warn('compress failed', err); imageBlob = file; }
  }

  if(pendingEdit){
    // update existing
    pendingEdit.title = title;
    pendingEdit.body = body;
    if(imageBlob) pendingEdit.imageBlob = imageBlob;
    pendingEdit.updatedAt = Date.now();
    await saveNoteLocal(pendingEdit);
    if(localOpts.sync && localUser){
      await saveNoteCloud(localUser.uid, pendingEdit);
    }
  } else {
    // create new note at pendingPos
    let targetPage = pendingPos ? pendingPos.page : currentBookshelfIndex;
    let targetShelf = pendingPos ? pendingPos.shelf : 0;
    let targetSlot = pendingPos ? pendingPos.slot : null;

    // ensure bookshelf exists
    if(!bookshelves[targetPage]){
      await createNewBookshelf();
      targetPage = bookshelves.length-1;
    }
    const bookshelfId = bookshelves[targetPage].id;
    // find first empty slot if slot is null
    if(targetSlot === null){
      const notes = await getNotesForBookshelf(bookshelfId);
      let found = false;
      for(let s=0;s<MAX_SHELVES && !found;s++){
        for(let slot=0;slot<MAX_PER_SHELF;slot++){
          const exists = notes.some(n => n.pos && n.pos.shelf===s && n.pos.slot===slot);
          if(!exists){ targetShelf=s; targetSlot=slot; found=true; break; }
        }
      }
      if(!found){
        // bookshelf full
        if(localOpts.autoNew){
          await createNewBookshelf();
          targetPage = bookshelves.length-1;
          targetShelf = 0;
          targetSlot = 0;
        } else {
          alert('Bookshelf is full. Enable auto-create or free up space.');
          return;
        }
      }
    }

    const noteObj = {
      title,
      body,
      imageBlob,
      bookshelf: bookshelfId,
      pos: {shelf: targetShelf, slot: targetSlot},
      createdAt: Date.now()
    };
    const saved = await saveNoteLocal(noteObj);
    // push to cloud optionally
    if(localOpts.sync && localUser){
      await saveNoteCloud(localUser.uid, saved);
    }
    // if the page is full and autoNew is on, create new page
    const notesNow = await getNotesForBookshelf(bookshelfId);
    const fullCapacity = MAX_SHELVES*MAX_PER_SHELF;
    if(notesNow.length >= fullCapacity && localOpts.autoNew){
      await createNewBookshelf();
    }
  }

  closeModal();
  await renderAll();
});

// Cancel modal
cancelNoteBtn.addEventListener('click', ()=> closeModal());
function closeModal(){
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden','true');
  pendingEdit = null;
  pendingPos = null;
  inMemoryImage = null;
  modalMessage.textContent = '';
}

// image input preview set
imageInput.addEventListener('change', (e)=>{
  if(e.target.files && e.target.files[0]) inMemoryImage = e.target.files[0];
  modalMessage.textContent = inMemoryImage ? `Selected: ${inMemoryImage.name}` : '';
});

// delete note
async function deleteNote(note){
  if(!note || !note.id) return;
  // delete image from storage if cloudImage exists
  if(note.cloudImage && note.cloudImage.path && localUser){
    await deleteImageFromStorageByPath(note.cloudImage.path);
  }
  await deleteNoteLocal(note.id);
  if(localOpts.sync && localUser){
    const notesCol = getUserNotesCollection(localUser.uid);
    const docRef = doc(notesCol, String(note.id));
    await deleteDoc(docRef).catch(()=>{});
  }
  await renderAll();
}

// Options modal handlers
optionsBtn.addEventListener('click', ()=> {
  optionsModal.classList.remove('hidden'); optionsModal.setAttribute('aria-hidden','false');
  optThumbWidth.value = localOpts.thumbWidth;
  optQuality.value = localOpts.quality;
  optAutoNew.checked = localOpts.autoNew;
  optSync.checked = localOpts.sync;
});
saveOptionsBtn.addEventListener('click', ()=>{
  localOpts.thumbWidth = Number(optThumbWidth.value);
  localOpts.quality = Number(optQuality.value);
  localOpts.autoNew = Boolean(optAutoNew.checked);
  localOpts.sync = Boolean(optSync.checked);
  saveOptions(localOpts);
  optionsModal.classList.add('hidden');
  alert('Options saved');
});
closeOptionsBtn.addEventListener('click', ()=> { optionsModal.classList.add('hidden'); });

// prev/next shelf
prevShelfBtn.addEventListener('click', ()=> {
  currentBookshelfIndex = Math.max(0, currentBookshelfIndex-1);
  renderAll();
});
nextShelfBtn.addEventListener('click', ()=> {
  currentBookshelfIndex = Math.min(bookshelves.length-1, currentBookshelfIndex+1);
  renderAll();
});

// new note opens modal for new note at current page
newNoteBtn.addEventListener('click', ()=> openModalAtPosition(currentBookshelfIndex, 0, null));

// status bar update
function updateStatusBar(msg){
  statusBar.textContent = msg || `${bookshelves.length} bookshelf(s) • Page ${currentBookshelfIndex+1}/${bookshelves.length} • ${localUser ? 'Signed in' : 'Offline/Local only'}`;
}

// --- Authentication UI & handlers -----------------------------------
authBtn.addEventListener('click', ()=> {
  authModal.classList.remove('hidden'); authModal.setAttribute('aria-hidden','false');
});
authCloseBtn.addEventListener('click', ()=> { authModal.classList.add('hidden'); });
authSignInBtn.addEventListener('click', async ()=>{
  const email = authEmail.value;
  const pw = authPassword.value;
  if(!email || !pw) { authMessage.textContent = 'Email & password required'; return; }
  try{
    // Try sign in, otherwise register
    let userCred;
    try { userCred = await signInWithEmailAndPassword(auth, email, pw); } catch(err) {
      // if user not found, create
      if(err.code && err.code.includes('user-not-found')){
        userCred = await createUserWithEmailAndPassword(auth, email, pw);
      } else throw err;
    }
    authModal.classList.add('hidden');
    authMessage.textContent = '';
  }catch(err){
    authMessage.textContent = 'Auth error: ' + (err.message || err.code);
  }
});

// react to auth state
onAuthStateChanged(auth, async (user) => {
  localUser = user;
  if(user){
    authBtn.textContent = 'Sign out';
    authBtn.onclick = async ()=> { await signOut(auth); localUser=null; authBtn.textContent='Sign in'; authBtn.onclick=()=>{ authModal.classList.remove('hidden'); }; };
    // start cloud listeners & push local changes
    if(localOpts.sync){
      listenCloudNotes(user.uid);
      await pushLocalToCloud(user.uid);
    }
  } else {
    authBtn.textContent = 'Sign in';
    authBtn.onclick = ()=> { authModal.classList.remove('hidden'); };
    // stop cloud listener
    if(cloudUnsub) { cloudUnsub(); cloudUnsub = null; }
  }
  updateStatusBar();
});

// --- Startup ---------------------------------------------------------
async function init(){
  try{
    await openIDB();
    await loadLocalBookshelves();
    // apply theme
    const t = localStorage.getItem('ns_theme') || 'wood';
    themeSelect.value = t; applyTheme(t);
    await renderAll();
    window.addEventListener('online', ()=> updateStatusBar());
    window.addEventListener('offline', ()=> updateStatusBar('Offline'));
    updateStatusBar();
  }catch(err){
    console.error('init error', err);
    alert('Initialization error: ' + err.message);
  }
}

init();

/* ------------- Options persistence -------------- */
function loadOptions(){
  const raw = localStorage.getItem('ns_opts');
  if(!raw){
    const defaultOpts = {thumbWidth:150, quality:0.8, autoNew:true, sync:true};
    localStorage.setItem('ns_opts', JSON.stringify(defaultOpts));
    return defaultOpts;
  }
  return JSON.parse(raw);
}
function saveOptions(o){
  localStorage.setItem('ns_opts', JSON.stringify(o));
  localOpts = o;
}
