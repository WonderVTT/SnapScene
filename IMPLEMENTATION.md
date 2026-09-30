# SnapScene – Integration Guide (for Claude Code / other modules)

SnapScene (module id `snapscene`, Foundry VTT **v12**) saves and restores snapshots of a Scene.
Use this file when another module or macro needs to **list** or **restore** SnapScene snapshots.

## What a snapshot contains

Snapshots are stored on the Scene itself, in `scene.flags.snapscene.snapshots[<snapshotId>]`.
Each one holds the full source data (`toObject()`) of every embedded document of these types:

| Type           | Notes                                                           |
|----------------|-----------------------------------------------------------------|
| `Wall`         | including door state `ds` (open/closed/locked)                  |
| `AmbientLight` | position, config, hidden, etc.                                  |
| `Tile`         |                                                                 |
| `Drawing`      |                                                                 |
| `Note`         |                                                                 |
| `AmbientSound` |                                                                 |
| `Region`       | including its `RegionBehavior`s                                 |
| `Token`        | position, visibility, and the ActorDelta of unlinked tokens. **Tokens of Player Character actors (actor type `character`) are excluded** |

It also holds the scene `environment` (darkness, global light…) and `weather`, and the **soundtrack**:
the playlist sounds that were playing (in any playlist) when the snapshot was taken.

Restoring makes the scene match the snapshot:
- documents created after the snapshot are **deleted**
- documents that still exist are **updated** to their snapshot values (tokens jump into place, with no animation)
- documents deleted after the snapshot are **re-created with their original ids**
- playlist sounds not in the snapshot are stopped, and the sounds in the snapshot are started from the beginning

Player tokens: tokens whose actor type is `character` ("Player Character" in dnd5e) are never saved, and a restore never
moves, changes, deletes or re-creates them. They stay exactly where they are.

Limits: linked actors (e.g. player characters) are not restored, only their tokens. Flags that other modules
added to a document *after* the snapshot are kept.

## Getting the API

```js
const snap = game.modules.get("snapscene")?.api;
if ( !snap ) return ui.notifications.warn("SnapScene is not active.");
```

The API is set during `init`, so it can be used from `setup`, `ready`, or later. A `snapsceneReady` hook fires on
`ready` and receives the API object.

**Every write operation (save/restore/rename/delete) needs a GM user** and throws otherwise.
If a player-side client needs a restore, send it to the GM over a socket, e.g. `game.socket`
with `"module.<your-module>"`, and have the active GM (`game.users.activeGM?.isSelf`) call the API.

## Scene argument

Every function's `scene` argument accepts a `Scene` document, a scene **id**, a **uuid** (`"Scene.abc123"`),
or a scene **name**. Leaving it out (`undefined`/`null`) uses the scene currently shown on the canvas (`canvas.scene`).

## Functions

### `listSnapshots(scene?) → SnapshotMeta[]`
Synchronous. Returns lightweight metadata only, newest first:

```js
{
  id: "Xk3...",            // snapshot id
  name: "Before the ambush",
  created: 1758900000000,  // ms timestamp
  createdBy: "userId",
  sceneId: "...", sceneName: "...",
  counts: { Wall: 42, AmbientLight: 5, Tile: 3, Drawing: 0, Note: 1, AmbientSound: 2, Region: 1, Token: 7 },
  soundtrack: [ { playlist: "Combat", sounds: ["Battle Theme"] } ]
}
```

### `restoreSnapshot(scene, idOrName, options?) → Promise<Report|null>`
Restores a snapshot. `idOrName` is a snapshot id, or a snapshot name (if several share the name, the newest wins).
It does **not** ask for confirmation, so add your own confirmation if needed.

Options (all optional):
- `types: string[]`: which embedded types to restore (default: all of the types listed above). Example: `["Wall", "AmbientLight"]`.
- `environment: boolean` (default `true`): restore darkness, environment and weather.
- `soundtrack: boolean` (default `true`): restore the playing playlist sounds.

Resolves to `{created, updated, deleted, errors: string[]}`. It resolves to `null` if a `snapscenePreRestore` hook
cancelled the restore. It throws if the snapshot is not found, the user is not a GM, or another restore is still running.
A failure on one document type is recorded in `errors` and the restore goes on with the next type.

### Other functions
- `getSnapshot(scene, idOrName) → object|null`: a deep copy of the full snapshot (`documents`, `scene`, `soundtrack`, …).
- `saveSnapshot(scene?, name?) → Promise<SnapshotMeta>`: takes a snapshot now. If no name is given, one is generated from the current date.
- `renameSnapshot(scene, idOrName, newName) → Promise<void>`
- `deleteSnapshot(scene, idOrName) → Promise<boolean>`
- `openSaveDialog(scene?)` / `openLoadDialog(scene?)`: open the same GM dialogs as the scene control buttons.
- `EMBEDDED_TYPES`: array of the captured document types, in restore order.

## Hooks

| Hook                    | Args                         | Notes                               |
|-------------------------|------------------------------|-------------------------------------|
| `snapsceneReady`        | `(api)`                      | fires once on `ready`               |
| `snapsceneSaved`        | `(scene, meta)`              |                                     |
| `snapscenePreRestore`   | `(scene, meta)`              | return `false` to cancel            |
| `snapsceneRestored`     | `(scene, meta, report)`      |                                     |
| `snapsceneDeleted`      | `(scene, meta)`              |                                     |

Every database operation SnapScene performs passes `{snapscene: true}` in its options. Your own
`preUpdateToken`/`updateWall`/… hooks can check `options.snapscene` to ignore changes made by a restore
(for example, to skip movement automation).

## Examples

```js
// Restore the snapshot named "Lights Out" on the scene currently shown
const api = game.modules.get("snapscene").api;
const report = await api.restoreSnapshot(null, "Lights Out");
console.log(report); // {created, updated, deleted, errors}

// Restore only the doors/walls and lights of the newest snapshot of a scene, without touching music
const [latest] = api.listSnapshots("Dungeon Level 1");
if ( latest ) await api.restoreSnapshot("Dungeon Level 1", latest.id, {
  types: ["Wall", "AmbientLight"], soundtrack: false, environment: false
});

// Let the GM choose a snapshot from a custom list
const choices = api.listSnapshots().map(s => `<option value="${s.id}">${s.name}</option>`).join("");
// ... build your own dialog, then: await api.restoreSnapshot(null, selectedId);

// React to restores
Hooks.on("snapsceneRestored", (scene, meta, report) => {
  if ( report.errors.length ) console.warn("SnapScene problems:", report.errors);
});
```

## Guidance for Claude Code

- Always get the API with `game.modules.get("snapscene")?.api` and handle the module being inactive.
  Do not read or write `flags.snapscene` directly, because the stored format may change (see `snapshot.format`).
- Check `game.user.isGM` before calling write functions.
- Declare the dependency in your `module.json` if needed:
  `"relationships": { "requires": [{ "id": "snapscene", "type": "module" }] }`, or use `"recommends"` for optional integration.
- The source is `scripts/snapscene.js`. The public API is set up in the `init` hook near the bottom of the file.
