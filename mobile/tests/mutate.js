// Mutation check: breaks a module one way at a time and confirms its tests notice. A mutant that survives
// means a behaviour nobody tests. Usage: node tests/mutate.js vault
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const SERVICES = path.join(__dirname, '..', 'src', 'services')
const OUT = path.join(__dirname, '.out', 'mutants')
const NL = String.fromCharCode(10)

/** [what is broken, text to find (exactly once), text to put instead] */
const TARGETS = {
  vault: {
    source: path.join(SERVICES, 'photoVault.ts'),
    env: 'VAULT_SRC',
    command: ['tests/vault/run.js'],
    mutants: [
      ['the bin is read as part of the gallery', '!(depth === 1 && item.name === TRASH_FOLDER)', 'true'],
      ['a deleted photo is removed instead of moved', 'await client.rename(from, destination)', 'await client.remove(from)'],
      ['a name taken in the bin is overwritten', 'const target = freeName(name, names)', 'const target = name'],
      ['restoring accepts any path', "if (below.length < 2 || !DAY_FOLDER.test(below[0]) || !(isPhotoName(name) || isVideoName(name))) throw forbidden(\"Ce fichier n'est pas dans la corbeille\")", ''],
      ['purge is early by one day', 'age < options.olderThanDays', 'age <= options.olderThanDays'],
      ['emptying touches anything in the bin', '!entry.isDir || !DAY_FOLDER.test(entry.name) || !validName(entry.name)', 'false'],
      ['a photo already in the bin can be binned again', "if (top === tops[0] && relative[0] === TRASH_FOLDER) throw forbidden('Ce fichier est déjà dans la corbeille')", ''],
      ['an album folder is taken for a year', '!isYearFolder(folders[0])', 'true'],
      ['reading goes one level too deep', 'const MAX_DEPTH = 4', 'const MAX_DEPTH = 5'],
      ['reading stops one level short', 'const MAX_DEPTH = 4', 'const MAX_DEPTH = 3'],
      ['an album named like a year is not renamed', "/^[0-9]{4}$/.test(name) || name.toLowerCase() === TRASH_FOLDER.toLowerCase() ? `${name} (album)` : name", 'name'],
      ['a lost session does not stop the bin run', "report.failed.push({ path, message: error.message })\n      if (isFatal(error)) stopped = error\n    }\n    options.onEach?.(index + 1, paths.length)\n  }\n  return report\n}\n\n/** What is in the account's bin", "report.failed.push({ path, message: error.message })\n    }\n    options.onEach?.(index + 1, paths.length)\n  }\n  return report\n}\n\n/** What is in the account's bin"],
      ['videos are left out of the gallery', '} else if (isPhotoName(item.name) || isVideoName(item.name)) {\n        scan.photos.push', '} else if (isPhotoName(item.name)) {\n        scan.photos.push'],
      ['a restored photo goes to the wrong place', 'joinPath([...segmentsOf(top), ...below.slice(1, -1)])', 'joinPath([...segmentsOf(top)])'],
      ['the bin keeps no album folder', 'joinPath([...binDay, ...relative.slice(0, -1)])', 'joinPath([...binDay, ...relative.slice(-3, -1)])']
    ]
  }
}

TARGETS.backup = {
  source: path.join(SERVICES, 'cameraBackup.ts'),
  env: 'BACKUP_SRC',
  command: ['tests/backup-albums.test.js'],
  mutants: [
    ['charging-only is never checked', 'if (settings.chargingOnly && !anyway && !isCharging()) {', 'if (false) {'],
    ['a build that cannot tell blocks the backup', 'return SelfHostNative?.isCharging?.() ?? true', 'return SelfHostNative?.isCharging?.() ?? false'],
    ['"send anyway" does not bypass the charger', 'settings.chargingOnly && !anyway', 'settings.chargingOnly'],
    ['an album goes into the camera folder', 'folder: (client) => `${backupRoot(client)}/${albumFolderName(album.title)}`', 'folder: (client) => backupRoot(client)'],
    ['albums share the camera journal', 'journalKey: `${JOURNAL_KEY}.album.${album.id}`', 'journalKey: JOURNAL_KEY'],
    ['the camera is not sent first', 'return [CAMERA, ...albums.map(albumSource)]', 'return [...albums.map(albumSource), CAMERA]'],
    ['the uploaded total forgets the albums', 'uploadedTotal += view.uploaded', 'uploadedTotal += 0'],
    ['progress forgets the sources before', 'done: ctx.done + index', 'done: index'],
    ['an unreadable album stops the run', 'if (source === CAMERA) throw err', 'throw err'],
    ['a new album gets no journal', 'await startJournal(albumSource(album), includeExisting, Date.now())', ''],
    ['a removed album keeps its journal', "await storage.savePref(albumSource({ id, title: '' }).journalKey, null)", ''],
    ['turning the backup on leaves the albums where they were', 'for (const source of sourcesOf(useCameraBackupStore.getState().settings.albums)) await startJournal(source, includeExisting, now)', 'await startJournal(CAMERA, includeExisting, now)'],
    ['an album can be added twice', 'if (store.settings.albums.some((known) => known.id === album.id)) return', ''],
    ['the camera is listed among the other albums', "album.title !== 'Camera'", 'true'],
    ['audio files count in an album', 'return all.filter((a) => a.mediaType === MediaType.IMAGE || a.mediaType === MediaType.VIDEO).length' + NL + '}' + NL + NL + '/** Adds an album', 'return all.length' + NL + '}' + NL + NL + '/** Adds an album'],
    ['a new album is not waited for behind a running backup', 'await running' + NL + '  await runCameraBackup()' + NL + '}' + NL + NL + '/** The phone', 'await runCameraBackup()' + NL + '}' + NL + NL + '/** The phone']
  ]
}

TARGETS.engine = {
  source: path.join(SERVICES, 'playbackEngine.ts'),
  env: 'ENGINE_SRC',
  command: ['tests/engine.test.js'],
  mutants: [
    ['the loudness factor is ignored', 'return this.volume * this.gains[index]', 'return this.volume'],
    ['the crossfade levels are swapped', 'this.level(fromIndex), this.level(toIndex))', 'this.level(toIndex), this.level(fromIndex))'],
    ['the next track is still prepared while stopping after this one', 'if (this.stopAfterTrack || !this.next', 'if (!this.next'],
    ['the track end does not stop playback', 'if (this.stopAfterTrack) {' + NL + '      // The track', 'if (false) {' + NL + '      // The track'],
    ['a gapless hop ignores the new track loudness factor', 'other.volume = this.level(otherIndex)' + NL + '      this.finished[otherIndex] = false', 'other.volume = this.volume' + NL + '      this.finished[otherIndex] = false'],
    ['a preloaded track does not get its factor', 'this.gains[otherIndex] = next.gain ?? 1' + NL + '    deck.pause()', 'deck.pause()'],
    ['the end of a fade restores the plain volume', 'this.decks[this.active].volume = this.level(this.active)' + NL + '  }' + NL + NL + '  private onActiveEnded', 'this.decks[this.active].volume = this.volume' + NL + '  }' + NL + NL + '  private onActiveEnded'],
    ['the fallback fade ignores the outgoing level', 'this.decks[fade.from].volume = this.level(fade.from) * Math.cos', 'this.decks[fade.from].volume = this.volume * Math.cos'],
    ['an announced factor is not passed on to a preloaded track', 'if (next && this.trackIds[otherIndex] === next.id) this.gains[otherIndex] = next.gain ?? 1', ''],
    ['stopping applies to every later track too', 'this.stopAfterTrack = false' + NL + '      this.wantPlaying = false', 'this.wantPlaying = false']
  ]
}

const name = process.argv[2]
const target = TARGETS[name]
if (!target) {
  console.log('usage: node tests/mutate.js <' + Object.keys(TARGETS).join('|') + '>')
  process.exit(2)
}

fs.mkdirSync(OUT, { recursive: true })
const original = fs.readFileSync(target.source, 'utf8')
let survived = 0
let index = 0
for (const [what, find, replace] of target.mutants) {
  index++
  const at = original.split(find).length - 1
  if (at !== 1) {
    console.log('BAD  #' + index + ' ' + what + ' (the text to break appears ' + at + ' times)')
    survived++
    continue
  }
  const file = path.join(OUT, name + '-' + index + path.extname(target.source))
  fs.writeFileSync(file, original.replace(find, () => replace))
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', ...target.command)], {
    env: { ...process.env, [target.env]: file },
    encoding: 'utf8',
    timeout: 120000
  })
  if (run.status === 0) {
    survived++
    console.log('LIVE #' + index + ' ' + what)
  } else {
    console.log('dead #' + index + ' ' + what)
  }
}
console.log(survived ? survived + ' of ' + target.mutants.length + ' mutants survived' : 'all ' + target.mutants.length + ' mutants were caught')
process.exit(survived ? 1 : 0)
