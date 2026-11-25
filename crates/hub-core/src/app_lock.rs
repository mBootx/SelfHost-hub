//! The app lock: a PIN or a pattern, hashed; pauses after wrong codes that moving the date cannot cut short; and
//! locking again when the app comes back after being away.
//!
//! Port of `mobile/src/services/appLock.ts` and the rules of `mobile/src/store/appLockStore.ts`. The hash and the
//! saved JSON are the same as the TypeScript app's, so a lock set before the rewrite still opens after it.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Hashing rounds: makes guessing slower if the stored hash ever leaked (it sits in an encrypted store already).
const ROUNDS: usize = 2000;
/// A hand-off to a system screen only skips the lock if the user is back within this time.
const EXTERNAL_MAX_MS: u64 = 3 * 60 * 1000;
/// Wrong codes allowed before a pause, and the first pause; it doubles each time after that.
const ATTEMPTS_PER_LOCKOUT: u32 = 5;
const FIRST_LOCKOUT_MS: u64 = 30_000;
const MAX_LOCKOUT_MS: u64 = 15 * 60 * 1000;

/// The delays offered before the app locks again.
pub const LOCK_DELAYS: [(&str, u64); 4] = [
    ("Immédiatement", 0),
    ("1 min", 60_000),
    ("5 min", 5 * 60_000),
    ("15 min", 15 * 60_000),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LockMethod {
    #[default]
    None,
    Pin,
    Pattern,
}

impl LockMethod {
    fn wire(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Pin => "pin",
            Self::Pattern => "pattern",
        }
    }

    fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("pin") => Self::Pin,
            Some("pattern") => Self::Pattern,
            _ => Self::None,
        }
    }
}

/// The device's own clock, which setting the date cannot move: ms since it started, and which start it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceClock {
    pub elapsed: u64,
    pub boot: i64,
}

pub fn hash_secret(secret: &str, salt: &str) -> String {
    let hex = |text: &str| -> String {
        Sha256::digest(text.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    let mut hash = hex(&format!("{salt}:{secret}"));
    for _ in 1..ROUNDS {
        hash = hex(&format!("{hash}{salt}"));
    }
    hash
}

/// Pattern dots are numbered 0-8, left to right and top to bottom.
pub fn encode_pattern(dots: &[u8]) -> String {
    dots.iter().map(u8::to_string).collect::<Vec<_>>().join("-")
}

/// 32 random hex digits, then the time in hex.
pub fn random_salt(now_ms: u64) -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system's random generator is unavailable");
    let digits: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{digits}{now_ms:x}")
}

/// How long a lockout still has to run. It is measured on the device clock when the device has not restarted since
/// it began, so moving the date forward does not end it; after a restart, or without that clock, it falls back to
/// the date. A restart needs the device's own unlock, which is the real barrier.
pub fn lockout_remaining(
    until_wall: u64,
    until_elapsed: u64,
    boot: i64,
    wall_now: u64,
    clock: Option<DeviceClock>,
) -> u64 {
    match clock {
        Some(c) if until_elapsed > 0 && boot != -1 && boot == c.boot => {
            until_elapsed.saturating_sub(c.elapsed)
        }
        _ => until_wall.saturating_sub(wall_now),
    }
}

/// The pause after `failed` wrong codes: none, except every fifth, 30 s doubling up to 15 min.
pub fn lockout_for(failed: u32) -> u64 {
    if failed == 0 || !failed.is_multiple_of(ATTEMPTS_PER_LOCKOUT) {
        return 0;
    }
    let round = failed / ATTEMPTS_PER_LOCKOUT - 1;
    FIRST_LOCKOUT_MS
        .saturating_mul(1u64 << round.min(20))
        .min(MAX_LOCKOUT_MS)
}

/// Whether a hand-off to a system screen (file picker, share sheet) came back soon enough not to lock.
pub fn external_trip_still_short(away_ms: u64) -> bool {
    away_ms < EXTERNAL_MAX_MS
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LockConfig {
    pub method: LockMethod,
    pub salt: String,
    pub hash: String,
    /// PIN length, so the pad can check as soon as the last digit is typed.
    pub pin_length: usize,
    pub fingerprint: bool,
    /// How long the app may stay in the background before it locks.
    pub delay_ms: u64,
}

impl LockConfig {
    /// The JSON saved under `appLock_config` in the secure store.
    pub fn to_json(&self) -> Value {
        json!({
            "method": self.method.wire(), "salt": self.salt, "hash": self.hash,
            "pinLength": self.pin_length, "fingerprint": self.fingerprint, "delayMs": self.delay_ms
        })
    }

    /// The saved config, missing fields taking their defaults (as the TypeScript app read it).
    pub fn from_json(value: &Value) -> Self {
        let text = |k: &str| {
            value
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        Self {
            method: LockMethod::from_wire(value.get("method").and_then(Value::as_str)),
            salt: text("salt"),
            hash: text("hash"),
            pin_length: value.get("pinLength").and_then(Value::as_u64).unwrap_or(0) as usize,
            fingerprint: value
                .get("fingerprint")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            delay_ms: value.get("delayMs").and_then(Value::as_u64).unwrap_or(0),
        }
    }
}

/// The wrong codes so far and the pause they caused, saved under `appLock_attempts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attempts {
    pub failed: u32,
    /// Epoch ms until which no code is accepted (what the screen counts down to).
    pub lockout_until: u64,
    /// The same moment on the device clock; 0 when there is none.
    pub lockout_elapsed_until: u64,
    /// Which start of the device that clock belongs to; -1 when none.
    pub lockout_boot: i64,
}

impl Default for Attempts {
    fn default() -> Self {
        Self {
            failed: 0,
            lockout_until: 0,
            lockout_elapsed_until: 0,
            lockout_boot: -1,
        }
    }
}

impl Attempts {
    pub fn to_json(&self) -> Value {
        json!({
            "failedAttempts": self.failed, "lockoutUntil": self.lockout_until,
            "lockoutElapsedUntil": self.lockout_elapsed_until, "lockoutBoot": self.lockout_boot
        })
    }

    pub fn from_json(value: &Value) -> Self {
        let number = |k: &str| value.get(k).and_then(Value::as_f64);
        Self {
            failed: number("failedAttempts").unwrap_or(0.0).max(0.0) as u32,
            lockout_until: number("lockoutUntil").unwrap_or(0.0).max(0.0) as u64,
            lockout_elapsed_until: number("lockoutElapsedUntil").unwrap_or(0.0).max(0.0) as u64,
            lockout_boot: number("lockoutBoot").map_or(-1, |b| b as i64),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockResult {
    Ok,
    Wrong,
    LockedOut,
}

/// A PIN (digits) or a pattern (dot numbers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Secret {
    Pin(String),
    Pattern(Vec<u8>),
}

impl Secret {
    fn plain(&self) -> String {
        match self {
            Self::Pin(digits) => digits.clone(),
            Self::Pattern(dots) => encode_pattern(dots),
        }
    }
}

/// The lock's state. Every method that changes what is saved says so: the app then writes [`LockConfig::to_json`]
/// or [`Attempts::to_json`] (deleting the entry for no lock or no failures).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AppLock {
    pub config: LockConfig,
    pub attempts: Attempts,
    pub locked: bool,
    /// When the app went to the background, and whether that trip was expected (a system screen).
    away: Option<(u64, bool)>,
}

impl AppLock {
    /// What was saved: locked at start whenever a lock is set.
    pub fn load(config: LockConfig, attempts: Attempts) -> Self {
        let locked = config.method != LockMethod::None;
        Self {
            config,
            attempts,
            locked,
            away: None,
        }
    }

    pub fn is_set(&self) -> bool {
        self.config.method != LockMethod::None
    }

    /// How long no code is accepted any more. Also moves what the screen counts down to when someone moved the
    /// date forward, so it counts from what is really left.
    pub fn lockout_left(&mut self, wall_now: u64, clock: Option<DeviceClock>) -> u64 {
        let a = self.attempts;
        let left = lockout_remaining(
            a.lockout_until,
            a.lockout_elapsed_until,
            a.lockout_boot,
            wall_now,
            clock,
        );
        if left > 0 && wall_now >= a.lockout_until {
            self.attempts.lockout_until = wall_now + left;
        }
        left
    }

    /// Checks a code, counting a wrong one (the attempts change: save them).
    pub fn check(
        &mut self,
        secret: &Secret,
        wall_now: u64,
        clock: Option<DeviceClock>,
    ) -> UnlockResult {
        if self.lockout_left(wall_now, clock) > 0 {
            return UnlockResult::LockedOut;
        }
        if hash_secret(&secret.plain(), &self.config.salt) != self.config.hash {
            return self.record_failure(wall_now, clock);
        }
        self.attempts = Attempts::default();
        UnlockResult::Ok
    }

    /// Unlocks with a code.
    pub fn try_unlock(
        &mut self,
        secret: &Secret,
        wall_now: u64,
        clock: Option<DeviceClock>,
    ) -> UnlockResult {
        let result = self.check(secret, wall_now, clock);
        if result == UnlockResult::Ok {
            self.locked = false;
        }
        result
    }

    /// Unlocks after the fingerprint was accepted.
    pub fn unlock_with_fingerprint(&mut self) {
        self.attempts = Attempts::default();
        self.locked = false;
    }

    /// A forgotten code: the saved password of a service account unlocks and turns the lock off.
    pub fn recover(
        &mut self,
        password: &str,
        saved_passwords: &[&str],
        wall_now: u64,
        clock: Option<DeviceClock>,
    ) -> UnlockResult {
        if self.lockout_left(wall_now, clock) > 0 {
            return UnlockResult::LockedOut;
        }
        if password.is_empty() || !saved_passwords.contains(&password) {
            return self.record_failure(wall_now, clock);
        }
        self.attempts = Attempts::default();
        self.disable();
        UnlockResult::Ok
    }

    fn record_failure(&mut self, wall_now: u64, clock: Option<DeviceClock>) -> UnlockResult {
        self.attempts.failed += 1;
        let pause = lockout_for(self.attempts.failed);
        if pause > 0 {
            self.attempts.lockout_until = wall_now + pause;
            self.attempts.lockout_elapsed_until = clock.map_or(0, |c| c.elapsed + pause);
            self.attempts.lockout_boot = clock.map_or(-1, |c| c.boot);
        }
        UnlockResult::Wrong
    }

    /// Sets a new PIN or pattern (the config changes: save it). `salt` from [`random_salt`].
    pub fn set_secret(&mut self, secret: &Secret, salt: String) {
        let plain = secret.plain();
        self.config.method = match secret {
            Secret::Pin(_) => LockMethod::Pin,
            Secret::Pattern(_) => LockMethod::Pattern,
        };
        self.config.hash = hash_secret(&plain, &salt);
        self.config.salt = salt;
        self.config.pin_length = if self.config.method == LockMethod::Pin {
            plain.chars().count()
        } else {
            0
        };
        self.locked = false;
    }

    pub fn disable(&mut self) {
        self.config = LockConfig::default();
        self.locked = false;
    }

    pub fn lock(&mut self) {
        if self.is_set() {
            self.locked = true;
        }
    }

    /// The app went to the background; `expected` when it was handing off to a system screen.
    pub fn on_background(&mut self, wall_now: u64, expected: bool) {
        self.away = Some((wall_now, expected));
    }

    /// The app is back: locks when it was away longer than the chosen delay (a short expected trip excepted).
    pub fn on_foreground(&mut self, wall_now: u64) {
        let Some((since, expected)) = self.away.take() else {
            return;
        };
        if !self.is_set() || self.locked {
            return;
        }
        let away = wall_now.saturating_sub(since);
        if expected && external_trip_still_short(away) {
            return;
        }
        if away >= self.config.delay_ms {
            self.locked = true;
        }
    }
}

// Ported from mobile/tests/applock.test.js, with hashes checked against .NET's SHA-256.
#[cfg(test)]
mod tests {
    use super::*;

    const SALT: &str = "0123456789abcdef0123456789abcdef18f2b3c4d5e";

    #[test]
    fn the_hash_is_the_one_the_typescript_app_stored() {
        assert_eq!(
            hash_secret("1234", SALT),
            "6cc8de395cc1ee1ef48e7238227a6342d6e1ee932f6ec22ad84c6692a588146e"
        );
        assert_eq!(
            hash_secret(&encode_pattern(&[0, 4, 8, 5]), SALT),
            "6e587862da342b2a05edfe1deb02caf05a0cf586c1b3df8d6ab39a5b9f93d056"
        );
        assert_eq!(encode_pattern(&[0, 4, 8, 5]), "0-4-8-5");
    }

    struct Phone {
        wall: u64,
        clock: Option<DeviceClock>,
        lock: AppLock,
    }

    impl Phone {
        fn new(clock: Option<DeviceClock>) -> Self {
            let mut lock = AppLock::default();
            lock.set_secret(&Secret::Pin("1234".into()), SALT.into());
            lock.lock();
            Self {
                wall: 1_800_000_000_000,
                clock,
                lock,
            }
        }

        fn check(&mut self, code: &str) -> UnlockResult {
            self.lock
                .check(&Secret::Pin(code.into()), self.wall, self.clock)
        }

        fn wrong(&mut self, count: usize) -> UnlockResult {
            (0..count).map(|_| self.check("0000")).last().unwrap()
        }

        fn tick(&mut self, ms: u64) {
            self.wall += ms;
            if let Some(c) = &mut self.clock {
                c.elapsed += ms;
            }
        }

        /// The app starts again, reading what was saved.
        fn relaunch(&mut self) {
            let config = LockConfig::from_json(&self.lock.config.to_json());
            let attempts = Attempts::from_json(&self.lock.attempts.to_json());
            self.lock = AppLock::load(config, attempts);
        }
    }

    const CLOCK: Option<DeviceClock> = Some(DeviceClock {
        elapsed: 5000,
        boot: 7,
    });

    #[test]
    fn five_wrong_codes_pause_and_the_right_one_is_refused_during_the_pause() {
        let mut phone = Phone::new(CLOCK);
        assert_eq!(phone.wrong(4), UnlockResult::Wrong);
        assert_eq!(
            phone.wrong(1),
            UnlockResult::Wrong,
            "the fifth is still just wrong; the pause starts after it"
        );
        assert_eq!(phone.check("1234"), UnlockResult::LockedOut);
        assert!(phone.lock.attempts.lockout_until > phone.wall);
    }

    #[test]
    fn moving_the_date_forward_does_not_end_the_pause() {
        let mut phone = Phone::new(CLOCK);
        phone.wrong(5);
        let until = phone.lock.attempts.lockout_until;
        phone.wall += 10 * 60_000;
        assert!(phone.wall > until);
        assert_eq!(
            phone.check("1234"),
            UnlockResult::LockedOut,
            "by the device's own clock it is not over"
        );
        assert!(
            phone.lock.attempts.lockout_until > phone.wall,
            "the countdown restarts from what is really left"
        );
    }

    #[test]
    fn the_pause_ends_when_the_device_clock_has_run_it_out() {
        let mut phone = Phone::new(CLOCK);
        phone.wrong(5);
        phone.clock = Some(DeviceClock {
            elapsed: 5000 + 29_000,
            boot: 7,
        });
        assert_eq!(phone.check("1234"), UnlockResult::LockedOut);
        phone.clock = Some(DeviceClock {
            elapsed: 5000 + 31_000,
            boot: 7,
        });
        assert_eq!(phone.check("1234"), UnlockResult::Ok);
        assert_eq!(phone.lock.attempts.failed, 0);
    }

    #[test]
    fn the_pause_survives_closing_the_app() {
        let mut phone = Phone::new(CLOCK);
        phone.wrong(5);
        phone.tick(5000);
        phone.relaunch();
        assert!(phone.lock.locked);
        assert_eq!(phone.lock.attempts.failed, 5);
        assert_eq!(phone.check("1234"), UnlockResult::LockedOut);
        phone.wall += 60 * 60_000;
        assert_eq!(
            phone.check("1234"),
            UnlockResult::LockedOut,
            "an hour on the date, nothing on the device clock"
        );
    }

    #[test]
    fn after_a_restart_of_the_device_the_date_decides() {
        let mut phone = Phone::new(CLOCK);
        phone.wrong(5);
        phone.clock = Some(DeviceClock {
            elapsed: 300,
            boot: 8,
        });
        phone.relaunch();
        assert_eq!(phone.check("1234"), UnlockResult::LockedOut);
        phone.wall += 31_000;
        assert_eq!(phone.check("1234"), UnlockResult::Ok);
    }

    #[test]
    fn without_a_device_clock_the_date_decides() {
        let mut phone = Phone::new(None);
        phone.wrong(5);
        assert_eq!(phone.check("1234"), UnlockResult::LockedOut);
        phone.wall += 31_000;
        assert_eq!(phone.check("1234"), UnlockResult::Ok);
    }

    #[test]
    fn pauses_double_up_to_fifteen_minutes() {
        assert_eq!(
            [0, 4, 5, 6, 10, 15, 20].map(lockout_for),
            [0, 0, 30_000, 0, 60_000, 120_000, 240_000]
        );
        assert_eq!(lockout_for(50), 15 * 60_000);
        assert_eq!(lockout_for(5000), 15 * 60_000);
    }

    #[test]
    fn a_pattern_unlocks_and_a_forgotten_code_is_recovered_with_a_saved_password() {
        let mut lock = AppLock::default();
        lock.set_secret(&Secret::Pattern(vec![0, 4, 8]), SALT.into());
        assert_eq!(lock.config.pin_length, 0);
        lock.lock();
        assert_eq!(
            lock.try_unlock(&Secret::Pattern(vec![0, 4, 7]), 0, None),
            UnlockResult::Wrong
        );
        assert!(lock.locked);
        assert_eq!(
            lock.try_unlock(&Secret::Pattern(vec![0, 4, 8]), 0, None),
            UnlockResult::Ok
        );
        assert!(!lock.locked);
        lock.lock();
        assert_eq!(lock.recover("", &["nav"], 0, None), UnlockResult::Wrong);
        assert_eq!(
            lock.recover("nav", &["nav", "fb"], 0, None),
            UnlockResult::Ok
        );
        assert!(
            !lock.is_set() && !lock.locked,
            "recovering turns the lock off"
        );
    }

    #[test]
    fn the_app_locks_again_after_the_delay_but_not_after_a_short_expected_trip() {
        let mut lock = AppLock::default();
        lock.set_secret(&Secret::Pin("1234".into()), SALT.into());
        lock.config.delay_ms = 60_000;
        lock.on_background(0, false);
        lock.on_foreground(30_000);
        assert!(!lock.locked, "back within the delay");
        lock.on_background(0, false);
        lock.on_foreground(61_000);
        assert!(lock.locked);
        lock.unlock_with_fingerprint();
        lock.config.delay_ms = 0;
        lock.on_background(0, true);
        lock.on_foreground(2 * 60_000);
        assert!(!lock.locked, "a file picker came back within three minutes");
        lock.on_background(0, true);
        lock.on_foreground(4 * 60_000);
        assert!(lock.locked, "a long trip, even an expected one, locks");
    }

    #[test]
    fn the_saved_json_is_read_as_the_typescript_app_wrote_it() {
        let config = LockConfig::from_json(
            &json!({ "method": "pin", "salt": "s", "hash": "h", "pinLength": 4 }),
        );
        assert_eq!(
            (
                config.method,
                config.pin_length,
                config.fingerprint,
                config.delay_ms
            ),
            (LockMethod::Pin, 4, false, 0)
        );
        let attempts = Attempts::from_json(&json!({ "failedAttempts": 5, "lockoutUntil": 1.8e12 }));
        assert_eq!((attempts.failed, attempts.lockout_boot), (5, -1));
        assert!(!AppLock::load(LockConfig::default(), Attempts::default()).locked);
        assert!(random_salt(255).ends_with("ff") && random_salt(0).len() == 33);
    }
}
