// The weekly Wrapped: weeks in local time, what is recorded while songs play, the summary, and when it pops up
// (every Monday from 10:00, for the week just ended, once).
process.env.TZ = 'Europe/Paris'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
const STUBS = {
  '@/services/navidrome': 'navidrome.js',
  '@/services/storage': 'storage.js',
  '@/store/navidromeStore': 'navidromeStore.js',
  'react-native': 'react-native.js'
}
const OUT = path.join(bundle.OUT, 'wrapped.js')

const tests = []
const test = (name, fn) => tests.push([name, fn])
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

// A local time in Paris: at(2026, 10, 12, 10, 0) is Monday 12 October 2026, 10:00.
const at = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()
const song = (id, extra = {}) => ({ id, title: 'Titre ' + id, artist: 'Artiste ' + id, artistId: 'ar-' + id, album: 'Album ' + id, albumId: 'al-' + id, coverArt: 'al-' + id, duration: 200, ...extra })

let m
let clock = at(2026, 10, 7)
const realNow = Date.now
Date.now = () => clock

/** A fresh app: the bundle loaded again, with the storage (fake.prefs) as it was left. */
async function launch() {
  fake.appStateListeners = []
  delete require.cache[require.resolve(OUT)]
  m = require(OUT)
  m.useNavidromeStore.setState({ queue: [], queueIndex: 0, currentTime: 0, isPlaying: false, duration: 0 })
  m.startListeningLog()
  m.startWrappedSchedule()
  await tick()
}

/** Plays `track` from `from` to `to` seconds, one second at a time, the clock moving with it. */
function play(track, from, to, { jump = 1 } = {}) {
  const store = m.useNavidromeStore
  if (store.getState().queue[0]?.id !== track.id || store.getState().currentTime > from) {
    store.setState({ queue: [track], queueIndex: 0, currentTime: from, isPlaying: true, duration: track.duration })
  }
  store.setState({ isPlaying: true })
  for (let t = from + jump; t <= to; t += jump) {
    clock += jump * 1000
    store.setState({ currentTime: t })
  }
}

function stop() {
  m.useNavidromeStore.setState({ queue: [], queueIndex: 0, currentTime: 0, isPlaying: false })
}

function ledgerOf(weeks) {
  const ledger = {}
  for (const [week, songs] of Object.entries(weeks)) {
    ledger[week] = { week, days: [0, 0, 0, 0, 0, 0, 0], songs: {} }
    for (const [id, stat] of Object.entries(songs)) {
      const s = { ...song(id), seconds: 0, plays: 0, ...stat }
      ledger[week].songs[id] = s
      ledger[week].days[stat.day ?? 0] += s.seconds
    }
  }
  return ledger
}

// --- Weeks ---

test('a week runs from Monday 00:00 to Sunday 23:59, local time', () => {
  assert.strictEqual(m.weekKey(at(2026, 10, 12, 0, 0)), '2026-10-12')
  assert.strictEqual(m.weekKey(at(2026, 10, 11, 23, 59, 59)), '2026-10-05')
  assert.strictEqual(m.weekKey(at(2026, 10, 14)), '2026-10-12')
  assert.strictEqual(m.dayIndex(at(2026, 10, 12)), 0)
  assert.strictEqual(m.dayIndex(at(2026, 10, 18)), 6)
})

test('weeks across a change of clock stay whole', () => {
  // The clocks go back on Sunday 25 October 2026 in Paris, forward on Sunday 29 March.
  assert.strictEqual(m.weekKey(at(2026, 10, 25, 23, 30)), '2026-10-19')
  assert.strictEqual(m.shiftWeek('2026-10-19', 1), '2026-10-26')
  assert.strictEqual(m.shiftWeek('2026-03-30', -1), '2026-03-23')
  assert.strictEqual(m.weekKey(at(2026, 3, 29, 3, 30)), '2026-03-23')
  assert.strictEqual(m.weekStart('2026-10-26').getHours(), 0)
})

test('the week reads as dates in French', () => {
  assert.strictEqual(m.weekLabel('2026-10-05'), '5 – 11 octobre')
  assert.strictEqual(m.weekLabel('2026-09-28'), '28 septembre – 4 octobre')
  assert.strictEqual(m.weekLabel('2025-12-29'), '29 décembre 2025 – 4 janvier 2026')
  assert.strictEqual(m.durationLabel(0), "moins d'une minute")
  assert.strictEqual(m.durationLabel(45), '45 min')
  assert.strictEqual(m.durationLabel(742), '12 h 22 min')
  assert.strictEqual(m.durationLabel(120), '2 h')
})

// --- The summary ---

test('top songs: the most played first, then the most heard; a song only skipped through is not one', () => {
  const ledger = ledgerOf({
    '2026-10-05': {
      a: { plays: 3, seconds: 500 },
      b: { plays: 5, seconds: 400 },
      c: { plays: 3, seconds: 900 },
      skipped: { plays: 0, seconds: 2000 }
    }
  })
  const wrapped = m.summarize(ledger, '2026-10-05')
  assert.deepStrictEqual(wrapped.topSongs.map((s) => s.id), ['b', 'c', 'a'])
  assert.strictEqual(wrapped.plays, 11)
  assert.strictEqual(wrapped.minutes, Math.round(3800 / 60))
})

test('top artists: by time heard, songs of one artist together, with the picture of their most heard song', () => {
  const ledger = ledgerOf({
    '2026-10-05': {
      x1: { plays: 1, seconds: 300, artist: 'Xena', artistId: 'ar-x', coverArt: 'cover-x1' },
      x2: { plays: 1, seconds: 600, artist: 'Xena', artistId: 'ar-x', coverArt: 'cover-x2' },
      y: { plays: 4, seconds: 800, artist: 'Yann', artistId: 'ar-y' },
      z: { plays: 0, seconds: 20, artist: 'Zoé', artistId: 'ar-z' },
      w: { plays: 1, seconds: 100, artist: 'Wil', artistId: undefined },
      w2: { plays: 1, seconds: 100, artist: ' wil ', artistId: undefined }
    }
  })
  const wrapped = m.summarize(ledger, '2026-10-05')
  assert.deepStrictEqual(wrapped.topArtists.map((a) => [a.name, a.seconds, a.plays]), [
    ['Xena', 900, 2],
    ['Yann', 800, 4],
    ['Wil', 200, 2]
  ])
  assert.strictEqual(wrapped.topArtists[0].coverArt, 'cover-x2')
  assert.strictEqual(wrapped.artistCount, 3, 'Zoé, heard 20 s, is not counted')
})

test('top albums, listening streak, active days, and share card formatting', () => {
  const ledger = ledgerOf({
    '2026-09-21': { s0: { plays: 2, seconds: 600 } },
    '2026-09-28': { s1: { plays: 3, seconds: 900 } },
    '2026-10-05': {
      a1: { plays: 2, seconds: 400, album: 'Discovery', albumId: 'al-disc', artist: 'Daft Punk', day: 0 },
      a2: { plays: 3, seconds: 500, album: 'Discovery', albumId: 'al-disc', artist: 'Daft Punk', day: 2 },
      b1: { plays: 1, seconds: 350, album: 'Homework', albumId: 'al-hw', artist: 'Daft Punk', day: 5 }
    }
  })
  const wrapped = m.summarize(ledger, '2026-10-05')
  assert.strictEqual(wrapped.streakWeeks, 3)
  assert.strictEqual(wrapped.activeDays, 3)
  assert.strictEqual(wrapped.albumCount, 2)
  assert.deepStrictEqual(wrapped.topAlbums.map((al) => [al.name, al.seconds, al.plays]), [
    ['Discovery', 900, 5],
    ['Homework', 350, 1]
  ])
  const shareText = m.formatWrappedShare(wrapped)
  assert.ok(shareText.includes('5 – 11 octobre'))
  assert.ok(shareText.includes('3 semaines consécutives'))
  assert.ok(shareText.includes('Album n°1 : Discovery'))
})

test('the days, the busiest one, and the change from the week before', () => {
  const ledger = ledgerOf({
    '2026-09-28': { p: { plays: 2, seconds: 3000 } },
    '2026-10-05': { a: { plays: 2, seconds: 1200, day: 3 }, b: { plays: 1, seconds: 2400, day: 5 } }
  })
  const wrapped = m.summarize(ledger, '2026-10-05')
  assert.deepStrictEqual(wrapped.days, [0, 0, 0, 20, 0, 40, 0])
  assert.strictEqual(wrapped.busiestDay, 5)
  assert.strictEqual(wrapped.previousMinutes, 50)
  assert.strictEqual(m.changeLabel(wrapped.minutes, wrapped.previousMinutes), "+20 % par rapport à la semaine d'avant")
  assert.strictEqual(m.changeLabel(30, 60), "−50 % par rapport à la semaine d'avant")
  assert.strictEqual(m.changeLabel(30, null), null)
  assert.strictEqual(m.summarize(ledger, '2026-10-12'), null)
})

// --- When it pops up ---

test('it is due from Monday 10:00, for the week just ended, until it has been shown', () => {
  const ledger = ledgerOf({ '2026-10-05': { a: { plays: 3, seconds: 900 } } })
  assert.strictEqual(m.dueWeek(ledger, at(2026, 10, 12, 9, 59), null), null)
  assert.strictEqual(m.dueWeek(ledger, at(2026, 10, 12, 10, 0), null), '2026-10-05')
  assert.strictEqual(m.dueWeek(ledger, at(2026, 10, 14, 8, 0), null), '2026-10-05', 'missed on Monday: still shown on Wednesday')
  assert.strictEqual(m.dueWeek(ledger, at(2026, 10, 12, 18, 0), '2026-10-05'), null)
  assert.strictEqual(m.dueWeek(ledger, at(2026, 10, 19, 11, 0), '2026-10-05'), null, 'the next week had no listening')
  assert.strictEqual(m.dueWeek(ledgerOf({ '2026-10-05': { a: { plays: 1, seconds: 200 } } }), at(2026, 10, 12, 11, 0), null), null, 'under five minutes')
})

// --- Recording ---

test('what is heard while playing is counted; pauses, seeks and going back are not', async () => {
  clock = at(2026, 10, 7, 20, 0)
  const a = song('a')
  play(a, 0, 40)
  m.useNavidromeStore.setState({ isPlaying: false })
  play(a, 40, 40) // paused then resumed: nothing in between
  m.useNavidromeStore.setState({ currentTime: 120 }) // a seek
  play(a, 120, 130)
  m.useNavidromeStore.setState({ currentTime: 20 }) // back
  stop()
  await tick()
  const week = m.useListeningStore.getState().weeks['2026-10-05']
  assert.strictEqual(week.songs.a.seconds, 50)
  assert.strictEqual(week.days[2], 50, 'on Wednesday')
})

test('dragging the seek bar while paused is not listening', async () => {
  clock = at(2026, 10, 7, 21, 0)
  const scrub = song('scrub', { duration: 300 })
  m.useNavidromeStore.setState({ queue: [scrub], queueIndex: 0, currentTime: 0, isPlaying: false, duration: 300 })
  for (let t = 2; t <= 60; t += 2) {
    clock += 300
    m.useNavidromeStore.setState({ currentTime: t })
  }
  stop()
  await tick()
  const week = m.useListeningStore.getState().weeks['2026-10-05']
  assert.strictEqual(week.songs.scrub, undefined)
})

test('a play counts at half the song, once, and again when it starts over', async () => {
  clock = at(2026, 10, 8, 9, 0)
  const b = song('b', { duration: 100 })
  play(b, 0, 49)
  await tick()
  assert.strictEqual(m.useListeningStore.getState().weeks['2026-10-05'].songs.b.plays, 0)
  play(b, 49, 99)
  await tick()
  assert.strictEqual(m.useListeningStore.getState().weeks['2026-10-05'].songs.b.plays, 1)
  // Repeat-one: back to the start.
  m.useNavidromeStore.setState({ currentTime: 0 })
  play(b, 0, 60)
  stop()
  await tick()
  assert.strictEqual(m.useListeningStore.getState().weeks['2026-10-05'].songs.b.plays, 2)
})

test('a long song counts after 4 minutes; a very short one never does', async () => {
  clock = at(2026, 10, 8, 10, 0)
  play(song('long', { duration: 1200 }), 0, 240)
  play(song('jingle', { duration: 20 }), 0, 20)
  stop()
  await tick()
  const songs = m.useListeningStore.getState().weeks['2026-10-05'].songs
  assert.strictEqual(songs.long.plays, 1)
  assert.strictEqual(songs.jingle.plays, 0)
  assert.strictEqual(songs.jingle.seconds, 20)
})

test('listening across Sunday midnight is split between the two weeks', async () => {
  // Each heard second is filed at the moment its tick arrives: the 30 before midnight, then the 30 after.
  clock = at(2026, 10, 11, 23, 59, 29)
  play(song('midnight', { duration: 300 }), 0, 60)
  stop()
  await tick()
  const weeks = m.useListeningStore.getState().weeks
  assert.strictEqual(weeks['2026-10-05'].songs.midnight.seconds, 30)
  assert.strictEqual(weeks['2026-10-05'].days[6], 30)
  assert.strictEqual(weeks['2026-10-12'].songs.midnight.seconds, 30)
  assert.strictEqual(weeks['2026-10-12'].days[0], 30)
})

test('each week is saved on its own, with a list of them, and read back after a restart', async () => {
  assert.deepStrictEqual(fake.prefs['listening.weeks'], ['2026-10-05', '2026-10-12'])
  assert.ok(fake.prefs['listening.week.2026-10-05'].songs.a)
  const before = m.useListeningStore.getState().weeks['2026-10-05'].songs.a.seconds
  await launch()
  assert.strictEqual(m.useListeningStore.getState().weeks['2026-10-05'].songs.a.seconds, before)
})

test('what is heard before the saved weeks are read back is added to them', async () => {
  fake.appStateListeners = []
  delete require.cache[require.resolve(OUT)]
  m = require(OUT)
  m.useNavidromeStore.setState({ queue: [], queueIndex: 0, currentTime: 0, isPlaying: false, duration: 0 })
  const saved = fake.prefs['listening.week.2026-10-12'].songs.midnight.seconds
  clock = at(2026, 10, 12, 8, 0)
  m.startListeningLog() // starts reading; the songs below are heard in the meantime
  play(song('midnight', { duration: 300 }), 100, 110)
  stop()
  await tick()
  assert.strictEqual(m.useListeningStore.getState().weeks['2026-10-12'].songs.midnight.seconds, saved + 10)
  assert.strictEqual(fake.prefs['listening.week.2026-10-12'].songs.midnight.seconds, saved + 10)
  m.startWrappedSchedule()
  await tick()
})

test('heard seconds are saved every 30 seconds, and when the app goes to the background', async () => {
  clock = at(2026, 10, 12, 8, 30)
  const c = song('c', { duration: 600 })
  play(c, 0, 10)
  await tick()
  assert.strictEqual(fake.prefs['listening.week.2026-10-12'].songs.c, undefined, 'not after 10 s')
  play(c, 10, 31)
  await tick()
  assert.ok(fake.prefs['listening.week.2026-10-12'].songs.c.seconds >= 30)
  play(c, 31, 40)
  require('./stubs/react-native').__emitAppState('background')
  await tick()
  assert.strictEqual(fake.prefs['listening.week.2026-10-12'].songs.c.seconds, 40)
  stop()
})

test('weeks older than a year are forgotten, on the phone too', async () => {
  const kept = m.shiftWeek('2026-10-12', -52)
  fake.prefs['listening.weeks'] = [kept, '2026-10-05', '2026-10-12']
  fake.prefs['listening.week.' + kept] = ledgerOf({ [kept]: { k: { plays: 1, seconds: 100 } } })[kept]
  await launch()
  assert.ok(m.useListeningStore.getState().weeks[kept], 'a year ago is still kept, for the year recap')
  const old = m.shiftWeek('2026-10-12', -60)
  fake.prefs['listening.weeks'] = [old, '2026-10-05', '2026-10-12']
  fake.prefs['listening.week.' + old] = ledgerOf({ [old]: { o: { plays: 1, seconds: 100 } } })[old]
  await launch()
  assert.strictEqual(m.useListeningStore.getState().weeks[old], undefined)
  assert.strictEqual(fake.prefs['listening.week.' + old], undefined)
  assert.ok(!fake.prefs['listening.weeks'].includes(old))
})

// --- The popup ---

test('on Monday it opens by itself at 10:00, on the week just ended, once', async () => {
  fake.prefs = {}
  clock = at(2026, 10, 14, 20, 0)
  await launch()
  play(song('fav', { duration: 300 }), 0, 300)
  play(song('fav2', { duration: 300 }), 0, 300)
  stop()
  clock = at(2026, 10, 19, 9, 59)
  m.useWrappedStore.getState().check()
  assert.strictEqual(m.useWrappedStore.getState().week, null, 'not before 10:00')
  clock = at(2026, 10, 19, 10, 0)
  m.useWrappedStore.getState().check()
  assert.strictEqual(m.useWrappedStore.getState().week, '2026-10-12')
  // Browsing back a week while it is open: the next minute's check leaves it there.
  m.useWrappedStore.getState().show('2026-10-05')
  clock = at(2026, 10, 19, 10, 1)
  m.useWrappedStore.getState().check()
  assert.strictEqual(m.useWrappedStore.getState().week, '2026-10-05')
  m.useWrappedStore.getState().close()
  assert.strictEqual(fake.prefs['wrapped.lastShown'], '2026-10-12')
  m.useWrappedStore.getState().check()
  assert.strictEqual(m.useWrappedStore.getState().week, null, 'shown once')
  await launch()
  m.useWrappedStore.getState().check()
  assert.strictEqual(m.useWrappedStore.getState().week, null, 'not again after a restart')
})

test('missed on Monday, it opens the first time the app comes back to the front', async () => {
  fake.prefs = {}
  clock = at(2026, 10, 21, 20, 0)
  await launch()
  play(song('wed', { duration: 600 }), 0, 400)
  stop()
  clock = at(2026, 10, 27, 15, 0) // Tuesday: the app was not opened on Monday
  require('./stubs/react-native').__emitAppState('active')
  assert.strictEqual(m.useWrappedStore.getState().week, '2026-10-19')
})

test('from Settings it opens on the last week that ended, at any time, and that does not use up the popup', async () => {
  fake.prefs = {}
  clock = at(2026, 11, 4, 20, 0)
  await launch()
  play(song('s', { duration: 600 }), 0, 400)
  stop()
  // The same week, still under way: Settings opens it.
  m.useWrappedStore.getState().open()
  assert.strictEqual(m.useWrappedStore.getState().week, '2026-11-02')
  m.useWrappedStore.getState().close()
  assert.strictEqual(fake.prefs['wrapped.lastShown'], undefined)
  // The next Monday at 10:00 it still pops up.
  clock = at(2026, 11, 9, 10, 5)
  m.useWrappedStore.getState().check()
  assert.strictEqual(m.useWrappedStore.getState().week, '2026-11-02')
})

test('opened from Settings while it is due, it counts as seen', async () => {
  m.useWrappedStore.getState().close()
  fake.prefs['wrapped.lastShown'] = null
  m.useWrappedStore.setState({ lastShown: null })
  clock = at(2026, 11, 9, 11, 0)
  m.useWrappedStore.getState().open()
  assert.strictEqual(m.useWrappedStore.getState().week, '2026-11-02')
  m.useWrappedStore.getState().show('2026-11-09')
  m.useWrappedStore.getState().close()
  assert.strictEqual(fake.prefs['wrapped.lastShown'], '2026-11-02')
  m.useWrappedStore.getState().check()
  assert.strictEqual(m.useWrappedStore.getState().week, null)
})

test('the weeks one can browse run from the first recorded to the current one', () => {
  const ledger = ledgerOf({ '2026-09-14': { a: { plays: 1, seconds: 100 } }, '2026-10-05': { b: { plays: 1, seconds: 100 } } })
  assert.deepStrictEqual(m.weekRange(ledger, at(2026, 10, 14)), { first: '2026-09-14', last: '2026-10-12' })
  assert.deepStrictEqual(m.weekRange({}, at(2026, 10, 14)), { first: '2026-10-12', last: '2026-10-12' })
  assert.strictEqual(m.latestWeek(ledger, at(2026, 10, 14)), '2026-10-05')
  assert.strictEqual(m.latestWeek(ledger, at(2026, 10, 21)), '2026-10-19', 'the week before is empty: the one under way')
})

// --- Periods ---

test('days, weeks, months and years: their bounds, the next and previous ones, their names', () => {
  assert.deepStrictEqual(m.periodOf('day', '2026-11-24'), { kind: 'day', start: '2026-11-24', end: '2026-11-25' })
  assert.deepStrictEqual(m.periodOf('week', '2026-11-26'), { kind: 'week', start: '2026-11-23', end: '2026-11-30' })
  assert.deepStrictEqual(m.periodOf('month', '2026-02-14'), { kind: 'month', start: '2026-02-01', end: '2026-03-01' })
  assert.deepStrictEqual(m.periodOf('year', '2026-06-01'), { kind: 'year', start: '2026-01-01', end: '2027-01-01' })
  assert.deepStrictEqual(m.shiftPeriod(m.periodOf('month', '2026-12-10'), 1), { kind: 'month', start: '2027-01-01', end: '2027-02-01' })
  assert.deepStrictEqual(m.shiftPeriod(m.periodOf('day', '2026-10-25'), 1).start, '2026-10-26', 'across the clock change')
  assert.deepStrictEqual(m.customPeriod('2026-11-17', '2026-11-03'), { kind: 'custom', start: '2026-11-03', end: '2026-11-18' })
  assert.deepStrictEqual(m.shiftPeriod(m.customPeriod('2026-11-03', '2026-11-17'), -1), { kind: 'custom', start: '2026-10-19', end: '2026-11-03' })
  const now = at(2026, 11, 25)
  assert.strictEqual(m.periodLabel(m.periodOf('day', '2026-11-25'), now), "Aujourd'hui")
  assert.strictEqual(m.periodLabel(m.periodOf('day', '2026-11-24'), now), 'Hier')
  assert.strictEqual(m.periodLabel(m.periodOf('day', '2026-11-17'), now), 'mardi 17 novembre')
  assert.strictEqual(m.periodLabel(m.periodOf('month', '2026-11-17'), now), 'novembre 2026')
  assert.strictEqual(m.periodLabel(m.customPeriod('2026-11-03', '2026-11-17'), now), '3 – 17 novembre')
  assert.strictEqual(m.changeLabel(30, 60, 'la veille'), '−50 % par rapport à la veille')
})

test('a day keeps its hours and its songs; a week cut by a span counts only its days inside', async () => {
  fake.prefs = {}
  clock = at(2026, 11, 16, 8, 0) // Monday
  await launch()
  play(song('mon', { duration: 300 }), 0, 300)
  clock = at(2026, 11, 18, 21, 0) // Wednesday evening
  play(song('wed', { duration: 300 }), 0, 300)
  stop()
  await tick()
  const weeks = m.useListeningStore.getState().weeks
  const week = weeks['2026-11-16']
  assert.strictEqual(week.hours[0][8], 300)
  assert.strictEqual(week.hours[2][21], 300)
  assert.deepStrictEqual(week.daySongs[2].wed, { s: 300, p: 1 })

  const wednesday = m.summarizePeriod(weeks, m.periodOf('day', '2026-11-18'), at(2026, 11, 25))
  assert.strictEqual(wednesday.minutes, 5)
  assert.deepStrictEqual(wednesday.topSongs.map((s) => s.id), ['wed'])
  assert.strictEqual(wednesday.buckets.length, 24)
  assert.strictEqual(wednesday.busiest, 21)
  assert.strictEqual(wednesday.partial, false)

  const span = m.summarizePeriod(weeks, m.customPeriod('2026-11-17', '2026-11-20'), at(2026, 11, 25))
  assert.deepStrictEqual(span.topSongs.map((s) => s.id), ['wed'], 'Monday is outside the span')
  assert.strictEqual(span.buckets.length, 4)
  assert.deepStrictEqual(span.buckets[1].drill, m.periodOf('day', '2026-11-18'))
})

test('a week charts its days, a year its months, and a bar opens its day or month', () => {
  const weeks = m.useListeningStore.getState().weeks
  const week = m.summarizePeriod(weeks, m.periodOf('week', '2026-11-18'), at(2026, 11, 25))
  assert.deepStrictEqual(week.buckets.map((b) => Math.round(b.seconds)), [300, 0, 300, 0, 0, 0, 0])
  assert.deepStrictEqual(week.buckets.map((b) => b.short), ['L', 'M', 'M', 'J', 'V', 'S', 'D'])
  assert.strictEqual(week.dailyAverage, 1, '10 minutes over 7 days')
  const year = m.summarizePeriod(weeks, m.periodOf('year', '2026-11-18'), at(2026, 11, 25))
  assert.strictEqual(year.buckets.length, 12)
  assert.strictEqual(year.busiest, 10)
  assert.deepStrictEqual(year.buckets[10].drill, m.periodOf('month', '2026-11-01'))
  assert.strictEqual(year.buckets[11].future, true)
})

test('a day listened to before days kept their songs: the minutes count, the songs are flagged as partial', () => {
  const ledger = ledgerOf({ '2026-10-05': { old: { plays: 2, seconds: 600, day: 1 } } })
  const day = m.summarizePeriod(ledger, m.periodOf('day', '2026-10-06'), at(2026, 11, 25))
  assert.strictEqual(day.minutes, 10)
  assert.strictEqual(day.topSongs.length, 0)
  assert.strictEqual(day.partial, true)
  const week = m.summarizePeriod(ledger, m.periodOf('week', '2026-10-06'), at(2026, 11, 25))
  assert.deepStrictEqual(week.topSongs.map((s) => s.id), ['old'], 'a whole week knows its songs')
  assert.strictEqual(week.partial, false)
})

test('drilling into a bar remembers where it came from; a tab or the arrows forget it', () => {
  const store = m.useWrappedStore
  store.getState().showPeriod(m.periodOf('year', '2026-11-18'))
  store.getState().drill(m.periodOf('month', '2026-11-01'))
  store.getState().drill(m.periodOf('day', '2026-11-18'))
  assert.strictEqual(store.getState().trail.length, 2)
  store.getState().back()
  assert.deepStrictEqual(store.getState().period, m.periodOf('month', '2026-11-01'))
  store.getState().showPeriod(m.periodOf('week', '2026-11-18'))
  assert.strictEqual(store.getState().trail.length, 0)
  assert.strictEqual(store.getState().week, '2026-11-16')
  store.getState().close()
  assert.strictEqual(store.getState().period, null)
})

// --- Weeks shared through the hub server ---

test('changed weeks are marked to upload, and an upload only clears the change it sent', async () => {
  clock = at(2026, 10, 14, 9, 0)
  const d = song('d', { duration: 100 })
  play(d, 0, 60)
  stop()
  await tick()
  const first = m.takeDirtyWeeks(8)
  assert.ok(first.weeks['2026-10-12'], 'the week heard in is to upload')
  assert.deepStrictEqual(fake.prefs['listening.dirty'].includes('2026-10-12'), true)
  // Heard again while the upload is on its way.
  play(d, 0, 20)
  stop()
  await tick()
  m.ackDirtyWeeks(Object.keys(first.weeks), first.versions)
  assert.ok(m.takeDirtyWeeks(8).weeks['2026-10-12'], 'changed since: still to upload')
  const second = m.takeDirtyWeeks(8)
  m.ackDirtyWeeks(Object.keys(second.weeks), second.versions)
  assert.deepStrictEqual(Object.keys(m.takeDirtyWeeks(8).weeks), [])
  assert.deepStrictEqual(fake.prefs['listening.dirty'], [])
  assert.ok(Object.keys(m.takeDirtyWeeks(1).weeks).length <= 1, 'at most the number asked for')
})

test('other devices are added to what is shown, kept apart, and forgotten on request', async () => {
  const key = '2026-10-05'
  const own = m.totalSeconds(m.useListeningStore.getState().weeks[key])
  const ownSaved = JSON.stringify(fake.prefs['listening.week.' + key])
  const log = ledgerOf({ [key]: { z: { plays: 2, seconds: 100 } } })[key]
  const older = ledgerOf({ '2026-09-28': { y: { plays: 1, seconds: 50 } } })['2026-09-28']
  const kept = m.applyOtherEntries([
    { deviceId: 'pc', deviceName: 'PC', platform: 'desktop', week: key, log, rev: 5 },
    { deviceId: 'pc', deviceName: 'PC', platform: 'desktop', week: '2026-09-28', log: older, rev: 6 },
    { deviceId: 'bad', week: 'not-a-week', log: {} },
    null
  ])
  assert.strictEqual(kept, true)
  const state = m.useListeningStore.getState()
  assert.strictEqual(m.totalSeconds(state.weeks[key]), own + 100)
  assert.ok(state.weeks[key].songs.z && state.weeks['2026-09-28'].songs.y, 'the other device\'s songs and weeks show')
  assert.deepStrictEqual(state.devices.map((d) => d.deviceName), ['PC'])
  assert.strictEqual(JSON.stringify(fake.prefs['listening.week.' + key]), ownSaved, 'this phone\'s own week is saved untouched')
  assert.ok(fake.prefs['listening.others'].pc, 'the other devices are saved')

  // The merged view is a copy: what a screen does to it cannot reach the ledgers.
  state.weeks[key].days[0] += 1000
  assert.strictEqual(m.totalSeconds(m.useListeningStore.getState().weeks[key]), own + 1100)
  play(song('e', { duration: 100 }), 0, 10)
  stop()
  await tick()
  assert.strictEqual(m.totalSeconds(m.useListeningStore.getState().weeks['2026-10-12']) > 0, true)

  // A week replaces the one the same device sent before, it is not added to it.
  m.applyOtherEntries([{ deviceId: 'pc', deviceName: 'PC', platform: 'desktop', week: key, log, rev: 7 }])
  assert.strictEqual(m.totalSeconds(m.useListeningStore.getState().weeks[key]), own + 100)

  await launch()
  assert.strictEqual(m.totalSeconds(m.useListeningStore.getState().weeks[key]), own + 100, 'kept after a restart')
  assert.strictEqual(m.useListeningStore.getState().devices.length, 1)

  m.clearOtherDevices()
  assert.strictEqual(m.totalSeconds(m.useListeningStore.getState().weeks[key]), own)
  assert.strictEqual(m.useListeningStore.getState().weeks['2026-09-28'], undefined)
  assert.deepStrictEqual(m.useListeningStore.getState().devices, [])
  assert.strictEqual(fake.prefs['listening.others'], undefined)
  assert.ok(m.takeDirtyWeeks(100).weeks[key], 'every week of this phone is to upload to the next server')
})

test('the other devices\' weeks are pruned like the phone\'s own', async () => {
  const old = m.shiftWeek(m.weekKey(clock), -60)
  const log = ledgerOf({ [old]: { o: { plays: 1, seconds: 100 } } })[old]
  m.applyOtherEntries([{ deviceId: 'tablet', deviceName: 'Tablette', platform: 'mobile', week: old, log, rev: 1 }])
  assert.strictEqual(m.useListeningStore.getState().weeks[old], undefined)
  assert.deepStrictEqual(m.useListeningStore.getState().devices, [])
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'wrapped.ts')
  fs.writeFileSync(
    entry,
    [
      "export * from '@/services/wrapped'",
      "export { startListeningLog, useListeningStore, flushListening, takeDirtyWeeks, ackDirtyWeeks, applyOtherEntries, clearOtherDevices } from '@/services/listeningLog'",
      "export { startWrappedSchedule, useWrappedStore } from '@/store/wrappedStore'",
      "export { useNavidromeStore } from '@/store/navidromeStore'"
    ].join(NL) + NL
  )
  await bundle(entry, STUBS, OUT)
  fake.prefs = {}
  await launch()
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 7).join(NL + '     '))
    }
  }
  Date.now = realNow
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' wrapped tests passed')
  process.exit(failed ? 1 : 0)
})()
