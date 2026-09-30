/**
 * SnapScene
 * Save and restore GM snapshots of a Scene.
 *
 * Snapshots are stored on the Scene document itself, in flags.snapscene.snapshots.<snapshotId>.
 * A public API is exposed at game.modules.get("snapscene").api (see IMPLEMENTATION.md).
 */

const MODULE_ID = "snapscene";
const FLAG_KEY = "snapshots";
const SNAPSHOT_FORMAT = 1;

/**
 * Embedded Scene documents captured in a snapshot, in the order they are restored.
 * Walls come first so doors are in place before tokens move; tokens come last.
 */
const EMBEDDED_TYPES = ["Wall", "AmbientLight", "Tile", "Drawing", "Note", "AmbientSound", "Region", "Token"];

/**
 * Actor types whose tokens are never saved or restored ("Player Character" in dnd5e).
 * Player tokens stay where they are when a snapshot is loaded.
 */
const EXCLUDED_ACTOR_TYPES = ["character"];

/** Scene-level fields captured in a snapshot. */
const SCENE_FIELDS = ["environment", "weather"];

/** Prevents two restores from running at the same time. */
let restoring = false;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const t = (key, data) => data ? game.i18n.format(`SNAPSCENE.${key}`, data) : game.i18n.localize(`SNAPSCENE.${key}`);

function assertGM() {
  if ( !game.user?.isGM ) throw new Error(`${MODULE_ID} | Only a GM can manage scene snapshots.`);
}

/**
 * Resolve a Scene from a Scene document, id, uuid, or name. Defaults to the currently viewed scene.
 * @param {Scene|string} [scene]
 * @returns {Scene}
 */
function resolveScene(scene) {
  if ( scene instanceof Scene ) return scene;
  let resolved = null;
  if ( scene === undefined || scene === null ) resolved = canvas.scene;
  else if ( typeof scene === "string" ) {
    resolved = game.scenes.get(scene) ?? game.scenes.getName(scene);
    if ( !resolved && scene.startsWith("Scene.") ) resolved = fromUuidSync(scene);
  }
  if ( !(resolved instanceof Scene) ) throw new Error(`${MODULE_ID} | Could not resolve scene "${scene}".`);
  return resolved;
}

function getStore(scene) {
  return scene.getFlag(MODULE_ID, FLAG_KEY) ?? {};
}

/** Lightweight description of a snapshot (no document data). */
function toMeta(snapshot, scene) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    created: snapshot.created,
    createdBy: snapshot.createdBy,
    sceneId: scene.id,
    sceneName: scene.name,
    counts: Object.fromEntries(EMBEDDED_TYPES.map(type => [type, snapshot.documents?.[type]?.length ?? 0])),
    soundtrack: (snapshot.soundtrack ?? []).map(p => ({
      playlist: p.name,
      sounds: p.sounds.map(s => s.name)
    }))
  };
}

/**
 * Find a snapshot on a scene by id, or by name if no id matches (most recent wins).
 * @returns {object|null}
 */
function findSnapshot(scene, idOrName) {
  const store = getStore(scene);
  if ( store[idOrName] ) return store[idOrName];
  const byName = Object.values(store)
    .filter(s => s.name === idOrName)
    .sort((a, b) => b.created - a.created);
  return byName[0] ?? null;
}

/**
 * Whether an embedded document is left out of snapshots (tokens of Player Character actors).
 * @param {string} type             Embedded document name
 * @param {object} data             Document or source data
 */
function isExcluded(type, data) {
  if ( type !== "Token" ) return false;
  const actorType = game.actors.get(data.actorId)?.type;
  return EXCLUDED_ACTOR_TYPES.includes(actorType);
}

function isEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Foundry v12 has no foundry.utils.escapeHTML (added in v13); use Handlebars' escaper. */
function escapeHTML(value) {
  return Handlebars.escapeExpression(String(value ?? ""));
}

function formatDate(ts) {
  return new Date(ts).toLocaleString();
}

/* -------------------------------------------- */
/*  Capture                                     */
/* -------------------------------------------- */

function captureSoundtrack() {
  return game.playlists
    .filter(p => p.sounds.some(s => s.playing))
    .map(p => ({
      _id: p.id,
      name: p.name,
      sounds: p.sounds.filter(s => s.playing).map(s => ({_id: s.id, name: s.name}))
    }));
}

function captureScene(scene) {
  const documents = {};
  for ( const type of EMBEDDED_TYPES ) {
    documents[type] = scene.getEmbeddedCollection(type)
      .filter(d => !isExcluded(type, d))
      .map(d => d.toObject());
  }
  const sceneData = {};
  for ( const field of SCENE_FIELDS ) {
    sceneData[field] = foundry.utils.deepClone(foundry.utils.getProperty(scene._source, field));
  }
  return {documents, scene: sceneData, soundtrack: captureSoundtrack()};
}

/* -------------------------------------------- */
/*  Restore                                     */
/* -------------------------------------------- */

/**
 * Make an embedded collection of a parent document match the snapshot data:
 * delete documents that did not exist, update changed ones, and re-create missing ones with their original ids.
 * @param {Document} parent
 * @param {string} type             Embedded document name
 * @param {object[]} snapDocs       Snapshot source data
 * @param {object} report           Accumulates counts and errors
 */
async function syncCollection(parent, type, snapDocs, report) {
  const collection = parent.getEmbeddedCollection(type);
  // Excluded documents (player tokens) are never touched, even if an older snapshot contains them
  snapDocs = snapDocs.filter(d => !isExcluded(type, d));
  const snapIds = new Set(snapDocs.map(d => d._id));
  const toDelete = collection.filter(d => !snapIds.has(d.id) && !isExcluded(type, d)).map(d => d.id);
  const toCreate = [];
  const toUpdate = [];
  const nested = [];

  for ( const snapDoc of snapDocs ) {
    const doc = collection.get(snapDoc._id);
    if ( !doc ) {
      toCreate.push(foundry.utils.deepClone(snapDoc));
      continue;
    }
    const current = doc.toObject();
    const target = foundry.utils.deepClone(snapDoc);

    // Region behaviors are an embedded collection of their own: sync them separately
    if ( type === "Region" ) {
      nested.push({doc, type: "RegionBehavior", docs: target.behaviors ?? []});
      delete target.behaviors;
      delete current.behaviors;
    }

    // Unlinked token actor data (hp, effects, items...) lives in the ActorDelta
    if ( type === "Token" ) {
      if ( !target.actorLink && doc.delta && !isEqual(current.delta, target.delta) ) {
        nested.push({doc, delta: target.delta});
      }
      delete target.delta;
      delete current.delta;
    }

    const diff = foundry.utils.diffObject(current, target);
    if ( !foundry.utils.isEmpty(diff) ) toUpdate.push({...diff, _id: snapDoc._id});
  }

  const options = {snapscene: true, animate: false};
  const label = `${parent.documentName}.${type}`;
  const attempt = async (what, fn) => {
    try { await fn(); }
    catch(err) {
      console.error(`${MODULE_ID} | Failed to ${what} ${label}`, err);
      report.errors.push(`${what} ${label}: ${err.message}`);
    }
  };

  if ( toDelete.length ) await attempt("delete", async () => {
    await parent.deleteEmbeddedDocuments(type, toDelete, options);
    report.deleted += toDelete.length;
  });
  if ( toUpdate.length ) await attempt("update", async () => {
    await parent.updateEmbeddedDocuments(type, toUpdate, options);
    report.updated += toUpdate.length;
  });
  if ( toCreate.length ) await attempt("create", async () => {
    await parent.createEmbeddedDocuments(type, toCreate, {...options, keepId: true});
    report.created += toCreate.length;
  });

  for ( const n of nested ) {
    if ( n.type ) await syncCollection(n.doc, n.type, n.docs, report);
    else if ( n.delta !== undefined ) await attempt("restore actor delta of", async () => {
      // Replace the whole delta, the same way ActorDelta#restore does
      const delta = {...(n.delta ?? {}), _id: n.doc.delta.id};
      await n.doc.delta.update(delta, {snapscene: true, recursive: false, diff: false});
      report.updated += 1;
    });
  }
}

async function restoreSoundtrack(soundtrack, report) {
  const wantedByPlaylist = new Map((soundtrack ?? []).map(p => [p._id, new Set(p.sounds.map(s => s._id))]));

  // Warn about playlists or sounds that no longer exist
  for ( const p of soundtrack ?? [] ) {
    const playlist = game.playlists.get(p._id);
    if ( !playlist ) { report.errors.push(t("MissingPlaylist", {name: p.name})); continue; }
    for ( const s of p.sounds ) {
      if ( !playlist.sounds.has(s._id) ) report.errors.push(t("MissingSound", {name: s.name, playlist: p.name}));
    }
  }

  // Stop playlists first, then start the ones that should play, to avoid overlapping audio
  const stops = [];
  const starts = [];
  for ( const playlist of game.playlists ) {
    const wanted = wantedByPlaylist.get(playlist.id) ?? new Set();
    const sounds = [];
    for ( const sound of playlist.sounds ) {
      const shouldPlay = wanted.has(sound.id);
      if ( sound.playing !== shouldPlay ) sounds.push({_id: sound.id, playing: shouldPlay, pausedTime: null});
    }
    const playing = playlist.sounds.some(s => wanted.has(s.id));
    if ( !sounds.length && (playlist.playing === playing) ) continue;
    (playing ? starts : stops).push([playlist, {playing, sounds}]);
  }
  for ( const [playlist, update] of [...stops, ...starts] ) {
    try { await playlist.update(update, {snapscene: true}); }
    catch(err) {
      console.error(`${MODULE_ID} | Failed to update playlist ${playlist.name}`, err);
      report.errors.push(`Playlist ${playlist.name}: ${err.message}`);
    }
  }
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * List snapshots saved for a scene, newest first.
 * @param {Scene|string} [scene]   Scene, id, uuid, or name. Defaults to the viewed scene.
 * @returns {object[]}             Snapshot metadata (no document data)
 */
function listSnapshots(scene) {
  scene = resolveScene(scene);
  return Object.values(getStore(scene))
    .filter(s => s?.id)
    .sort((a, b) => b.created - a.created)
    .map(s => toMeta(s, scene));
}

/**
 * Get the full data of a snapshot.
 * @param {Scene|string} scene
 * @param {string} idOrName
 * @returns {object|null}
 */
function getSnapshot(scene, idOrName) {
  scene = resolveScene(scene);
  const snap = findSnapshot(scene, idOrName);
  return snap ? foundry.utils.deepClone(snap) : null;
}

/**
 * Save a snapshot of the current state of a scene.
 * @param {Scene|string} [scene]
 * @param {string} [name]
 * @returns {Promise<object>}      Metadata of the saved snapshot
 */
async function saveSnapshot(scene, name) {
  assertGM();
  scene = resolveScene(scene);
  const id = foundry.utils.randomID();
  const snapshot = {
    id,
    name: name?.trim() || t("DefaultName", {date: formatDate(Date.now())}),
    created: Date.now(),
    createdBy: game.user.id,
    format: SNAPSHOT_FORMAT,
    coreVersion: game.version,
    ...captureScene(scene)
  };
  await scene.update({[`flags.${MODULE_ID}.${FLAG_KEY}.${id}`]: snapshot}, {snapscene: true});
  const meta = toMeta(snapshot, scene);
  Hooks.callAll("snapsceneSaved", scene, meta);
  return meta;
}

/**
 * Restore a snapshot onto its scene.
 * @param {Scene|string} scene
 * @param {string} idOrName                   Snapshot id, or name (the newest snapshot with that name)
 * @param {object} [options]
 * @param {string[]} [options.types]          Embedded document types to restore (default: all captured types)
 * @param {boolean} [options.environment=true] Restore scene darkness / environment / weather
 * @param {boolean} [options.soundtrack=true] Restore which playlist sounds are playing
 * @returns {Promise<{created:number, updated:number, deleted:number, errors:string[]}>}
 */
async function restoreSnapshot(scene, idOrName, {types = EMBEDDED_TYPES, environment = true, soundtrack = true} = {}) {
  assertGM();
  scene = resolveScene(scene);
  const snapshot = findSnapshot(scene, idOrName);
  if ( !snapshot ) throw new Error(`${MODULE_ID} | Snapshot "${idOrName}" not found on scene "${scene.name}".`);
  if ( restoring ) throw new Error(`${MODULE_ID} | A snapshot restore is already in progress.`);

  const meta = toMeta(snapshot, scene);
  if ( Hooks.call("snapscenePreRestore", scene, meta) === false ) return null;

  restoring = true;
  const report = {created: 0, updated: 0, deleted: 0, errors: []};
  try {
    const data = foundry.utils.deepClone(snapshot);
    for ( const type of EMBEDDED_TYPES ) {
      if ( !types.includes(type) || !data.documents?.[type] ) continue;
      await syncCollection(scene, type, data.documents[type], report);
    }

    if ( environment && data.scene ) {
      const current = {};
      for ( const field of SCENE_FIELDS ) current[field] = foundry.utils.getProperty(scene._source, field);
      const diff = foundry.utils.diffObject(current, data.scene);
      if ( !foundry.utils.isEmpty(diff) ) {
        try { await scene.update(diff, {snapscene: true}); }
        catch(err) {
          console.error(`${MODULE_ID} | Failed to restore scene environment`, err);
          report.errors.push(`Scene environment: ${err.message}`);
        }
      }
    }

    if ( soundtrack ) await restoreSoundtrack(data.soundtrack, report);
  }
  finally {
    restoring = false;
  }

  Hooks.callAll("snapsceneRestored", scene, meta, report);
  return report;
}

/**
 * Rename a snapshot.
 * @param {Scene|string} scene
 * @param {string} idOrName
 * @param {string} name
 */
async function renameSnapshot(scene, idOrName, name) {
  assertGM();
  scene = resolveScene(scene);
  const snap = findSnapshot(scene, idOrName);
  if ( !snap ) throw new Error(`${MODULE_ID} | Snapshot "${idOrName}" not found.`);
  await scene.update({[`flags.${MODULE_ID}.${FLAG_KEY}.${snap.id}.name`]: name}, {snapscene: true});
}

/**
 * Delete a snapshot.
 * @param {Scene|string} scene
 * @param {string} idOrName
 * @returns {Promise<boolean>}   Whether a snapshot was deleted
 */
async function deleteSnapshot(scene, idOrName) {
  assertGM();
  scene = resolveScene(scene);
  const snap = findSnapshot(scene, idOrName);
  if ( !snap ) return false;
  await scene.update({[`flags.${MODULE_ID}.${FLAG_KEY}.-=${snap.id}`]: null}, {snapscene: true});
  Hooks.callAll("snapsceneDeleted", scene, toMeta(snap, scene));
  return true;
}

/* -------------------------------------------- */
/*  User Interface                              */
/* -------------------------------------------- */

function summarizeReport(report) {
  const msg = t("Restored", report);
  if ( report.errors.length ) {
    ui.notifications.warn(`${msg} ${t("RestoredWithErrors", {count: report.errors.length})}`);
  }
  else ui.notifications.info(msg);
}

async function openSaveDialog(scene) {
  if ( !game.user.isGM ) return;
  scene = resolveScene(scene);
  const defaultName = t("DefaultName", {date: formatDate(Date.now())});
  const content = `
    <form class="snapscene-save">
      <p>${t("SaveHint", {scene: escapeHTML(scene.name)})}</p>
      <div class="form-group">
        <label>${t("SnapshotName")}</label>
        <input type="text" name="name" value="${escapeHTML(defaultName)}" autofocus>
      </div>
    </form>`;
  const name = await Dialog.prompt({
    title: t("SaveTitle"),
    content,
    label: t("SaveConfirm"),
    rejectClose: false,
    callback: html => html[0].querySelector("input[name=name]").value,
    render: html => html[0].querySelector("input[name=name]")?.select(),
    options: {classes: ["dialog", "snapscene-dialog"]}
  });
  if ( name === null || name === undefined ) return;
  try {
    const meta = await saveSnapshot(scene, name);
    ui.notifications.info(t("Saved", {name: meta.name}));
  }
  catch(err) {
    console.error(err);
    ui.notifications.error(err.message);
  }
}

function renderSnapshotList(snapshots) {
  if ( !snapshots.length ) return `<p class="snapscene-empty">${t("NoSnapshots")}</p>`;
  const rows = snapshots.map((s, i) => {
    const counts = [
      ["Token", "fa-user"], ["AmbientLight", "fa-lightbulb"], ["Tile", "fa-cubes"],
      ["Wall", "fa-block-brick"], ["Region", "fa-draw-polygon"], ["AmbientSound", "fa-volume-high"]
    ].map(([type, icon]) => `<span title="${type}"><i class="fa-solid ${icon}"></i> ${s.counts[type]}</span>`).join("");
    const music = s.soundtrack.flatMap(p => p.sounds).join(", ");
    return `
      <li class="snapscene-row">
        <label>
          <input type="radio" name="snapshot" value="${s.id}" ${i === 0 ? "checked" : ""}>
          <span class="snapscene-info">
            <strong>${escapeHTML(s.name)}</strong>
            <span class="snapscene-date">${formatDate(s.created)}</span>
            <span class="snapscene-counts">${counts}</span>
            ${music ? `<span class="snapscene-music"><i class="fa-solid fa-music"></i> ${escapeHTML(music)}</span>` : ""}
          </span>
        </label>
      </li>`;
  }).join("");
  return `<ol class="snapscene-list">${rows}</ol>`;
}

async function openLoadDialog(scene) {
  if ( !game.user.isGM ) return;
  scene = resolveScene(scene);
  const snapshots = listSnapshots(scene);
  const selected = html => html[0].querySelector("input[name=snapshot]:checked")?.value;

  const buttons = {};
  if ( snapshots.length ) {
    buttons.load = {
      icon: '<i class="fa-solid fa-clock-rotate-left"></i>',
      label: t("LoadConfirm"),
      callback: html => confirmRestore(scene, selected(html))
    };
    buttons.delete = {
      icon: '<i class="fa-solid fa-trash"></i>',
      label: t("Delete"),
      callback: html => confirmDelete(scene, selected(html))
    };
  }
  buttons.cancel = {icon: '<i class="fa-solid fa-xmark"></i>', label: t("Cancel")};

  new Dialog({
    title: t("LoadTitle", {scene: scene.name}),
    content: `<form class="snapscene-load">${renderSnapshotList(snapshots)}</form>`,
    buttons,
    default: snapshots.length ? "load" : "cancel"
  }, {classes: ["dialog", "snapscene-dialog"], width: 460, resizable: true}).render(true);
}

async function confirmRestore(scene, id) {
  const snap = id && findSnapshot(scene, id);
  if ( !snap ) return;
  const ok = await Dialog.confirm({
    title: t("RestoreTitle"),
    content: `<p>${t("RestoreConfirm", {name: escapeHTML(snap.name), date: formatDate(snap.created)})}</p>`,
    defaultYes: false,
    rejectClose: false
  });
  if ( !ok ) return;
  try {
    ui.notifications.info(t("Restoring", {name: snap.name}));
    const report = await restoreSnapshot(scene, id);
    if ( report ) summarizeReport(report);
  }
  catch(err) {
    console.error(err);
    ui.notifications.error(err.message);
  }
}

async function confirmDelete(scene, id) {
  const snap = id && findSnapshot(scene, id);
  if ( !snap ) return;
  const ok = await Dialog.confirm({
    title: t("DeleteTitle"),
    content: `<p>${t("DeleteConfirm", {name: escapeHTML(snap.name)})}</p>`,
    defaultYes: false,
    rejectClose: false
  });
  if ( ok ) {
    await deleteSnapshot(scene, id);
    ui.notifications.info(t("Deleted", {name: snap.name}));
  }
  return openLoadDialog(scene);
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  /** An empty canvas layer so the SnapScene control can be selected in the left toolbar. */
  class SnapSceneLayer extends InteractionLayer {
    static get layerOptions() {
      return foundry.utils.mergeObject(super.layerOptions, {name: MODULE_ID, zIndex: 0});
    }
  }
  CONFIG.Canvas.layers[MODULE_ID] = {layerClass: SnapSceneLayer, group: "interface"};

  game.modules.get(MODULE_ID).api = {
    listSnapshots,
    getSnapshot,
    saveSnapshot,
    restoreSnapshot,
    renameSnapshot,
    deleteSnapshot,
    openSaveDialog,
    openLoadDialog,
    EMBEDDED_TYPES: [...EMBEDDED_TYPES]
  };
});

Hooks.on("getSceneControlButtons", controls => {
  if ( !game.user?.isGM ) return;
  controls.push({
    name: MODULE_ID,
    title: "SNAPSCENE.ControlTitle",
    icon: "fa-solid fa-floppy-disk",
    layer: MODULE_ID,
    visible: game.user.isGM,
    tools: [
      {
        name: "save",
        title: "SNAPSCENE.Save",
        icon: "fa-solid fa-camera",
        button: true,
        onClick: () => openSaveDialog()
      },
      {
        name: "load",
        title: "SNAPSCENE.Load",
        icon: "fa-solid fa-folder-open",
        button: true,
        onClick: () => openLoadDialog()
      }
    ]
  });
});

Hooks.once("ready", () => {
  Hooks.callAll("snapsceneReady", game.modules.get(MODULE_ID).api);
});
