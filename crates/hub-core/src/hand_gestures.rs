//! Hand gestures for the car mode, read from the points MediaPipe's hand landmarker finds in each camera frame (the
//! phone's Kotlin shim sends them).
//!
//! Port of `mobile/src/services/gestureRecognizer.ts`, held to the same tests on the same real hands
//! (`mobile/tests/fixtures/mediapipe-hands.json`).
//!
//! The 21 points of a hand: 0 the wrist; 1-4 the thumb (base to tip); 5-8 the index (knuckle, two joints, tip); 9-12
//! the middle finger; 13-16 the ring finger; 17-20 the little finger. x and y go from 0 to 1 across the picture, which
//! is upright and mirrored: x grows towards the driver's right, y downwards.
//!
//! - PINCH (thumb and index tips together, held 200 ms): play / pause. Once per pinch: the fingers must open again.
//! - WAVE_RIGHT / WAVE_LEFT (an open hand crosses part of the picture within half a second): next / previous song.
//! - PALM_UP / PALM_DOWN (an open hand sweeps up or down within half a second): volume up / down, one step a sweep.
//!   A movement, not a place: a hand resting high or low in the picture (on the wheel, waiting) is nothing.
//! - THUMB_UP (thumb up, other fingers folded, held 400 ms): like the song. Once per gesture.
//!
//! Distances that describe the hand's shape are counted in hand sizes (wrist to the middle finger's knuckle), so a
//! hand close to the camera and one at arm's length look the same.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Gesture {
    Pinch,
    WaveRight,
    WaveLeft,
    PalmUp,
    PalmDown,
    ThumbUp,
}

impl Gesture {
    pub const ALL: [Self; 6] = [
        Self::Pinch,
        Self::WaveRight,
        Self::WaveLeft,
        Self::PalmUp,
        Self::PalmDown,
        Self::ThumbUp,
    ];

    fn index(self) -> usize {
        Self::ALL.iter().position(|g| *g == self).unwrap_or(0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HandObservation {
    /// How sure the landmarker is about the hand, 0 to 1.
    pub score: f64,
    /// 21 points, x, y, z each (63 numbers).
    pub points: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HandFrame {
    /// Milliseconds, on a clock that only goes forward.
    pub t: f64,
    /// The picture's size: x and y are fractions of different lengths, which the hand's shape must not depend on.
    pub width: f64,
    pub height: f64,
    pub hands: Vec<HandObservation>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    /// The gap between the thumb's and the index's tips under which they pinch, in hand sizes.
    pub pinch_distance: f64,
    /// How far the wrist must cross the picture for a wave, as a share of its width.
    pub swipe_min_distance: f64,
    /// The share of a wave's frames in which the hand must be seen (a hand that just came in is not a wave).
    pub swipe_confidence: f64,
}

pub const DEFAULT_THRESHOLDS: Thresholds = Thresholds {
    pinch_distance: 0.3,
    swipe_min_distance: 0.3,
    swipe_confidence: 0.7,
};
pub const DEFAULT_SENSITIVITY: f64 = 0.5;

/// The thresholds for a sensitivity from 0 (strict: wide gestures only) to 1 (loose: small ones do). The middle
/// gives the defaults.
pub fn thresholds_for(sensitivity: f64) -> Thresholds {
    let s = if sensitivity.is_finite() {
        sensitivity
    } else {
        DEFAULT_SENSITIVITY
    }
    .clamp(0.0, 1.0);
    let factor = 0.6 + 0.8 * s;
    let round = |n: f64| (n * 1000.0 + 0.5).floor() / 1000.0;
    Thresholds {
        pinch_distance: round(DEFAULT_THRESHOLDS.pinch_distance * factor),
        swipe_min_distance: round(DEFAULT_THRESHOLDS.swipe_min_distance / factor),
        swipe_confidence: round(
            (DEFAULT_THRESHOLDS.swipe_confidence - 0.3 * (s - 0.5)).clamp(0.5, 0.85),
        ),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecognizerOptions {
    pub thresholds: Thresholds,
    /// Gestures turned off in the settings never fire, indexed like [`Gesture::ALL`].
    pub enabled: [bool; 6],
}

impl Default for RecognizerOptions {
    fn default() -> Self {
        Self {
            thresholds: DEFAULT_THRESHOLDS,
            enabled: [true; 6],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GestureEvent {
    pub gesture: Gesture,
    /// 0 to 1: how sure the landmarker was of the hand, and for a wave how steadily it was seen.
    pub confidence: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandPose {
    Pinch,
    ThumbUp,
    OpenPalm,
    Other,
}

/// What the recognizer makes of the hand right now, for the test mode.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RecognizerState {
    pub present: bool,
    pub pose: Option<HandPose>,
    /// The thumb-to-index gap in hand sizes.
    pub pinch_gap: Option<f64>,
    /// Where the wrist is, 0 to 1.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub score: f64,
}

// --- Timing ---

/// Below this the landmarker is guessing (a steering wheel, a sleeve): the hand is ignored.
pub const MIN_SCORE: f64 = 0.6;
/// Points are averaged over this many frames, which steadies the jitter of a hand held still.
const SMOOTHING_FRAMES: usize = 5;
/// A hand unseen for longer is gone: whatever it was doing starts over.
const LOST_AFTER_MS: f64 = 300.0;
const PINCH_HOLD_MS: f64 = 200.0;
/// The fingers must open past the pinch gap times this, for this long, before the next pinch counts.
const PINCH_RELEASE: f64 = 1.6;
const RELEASE_MS: f64 = 100.0;
const THUMB_HOLD_MS: f64 = 400.0;
/// The thumb must be down this long before the next thumb up counts: the smoothing stretches a thumb lost for two
/// frames into some 170 ms without one, which must not like the song a second time.
const THUMB_RELEASE_MS: f64 = 300.0;
const WAVE_WINDOW_MS: f64 = 500.0;
/// A wave that went one way locks the other way out for this long: bringing the hand back is not a wave back.
const OPPOSITE_WAVE_LOCK_MS: f64 = 1200.0;
/// Of the frames of a wave or a sweep, this share must show an open hand: hands gripping a wheel are not waving.
const OPEN_SHARE: f64 = 0.6;
/// A sweep up or down needs this share of the distance a wave needs.
const VERTICAL_SHARE: f64 = 0.8;
/// After a gesture nothing else fires for this long (the hand is still finishing the first one).
const COOLDOWN_MS: f64 = 600.0;

// --- The hand's shape ---

const WRIST: usize = 0;
const THUMB_MCP: usize = 2;
const THUMB_TIP: usize = 4;
const INDEX_MCP: usize = 5;
const INDEX_TIP: usize = 8;
const MIDDLE_MCP: usize = 9;
const FINGERS: [(usize, usize); 4] = [(5, 8), (9, 12), (13, 16), (17, 20)];
/// A finger whose tip is farther from the wrist than its knuckle by this much is stretched out...
const EXTENDED: f64 = 1.5;
/// ...and one whose tip comes back under this is folded.
const FOLDED: f64 = 1.15;
/// What tells a pinch from a fist, which also brings the thumb's tip against the index: an index under this is
/// curled into a fist...
const PINCH_MIN_REACH: f64 = 0.97;
/// ...and so is one under this when the three other fingers are all folded too (a grip on a wheel).
const GRIP_REACH: f64 = 1.1;
const OTHERS_FOLDED: f64 = 1.0;

type Point = (f64, f64);

/// Point i, with x scaled so that x and y are the same length (both in picture heights).
fn point(points: &[f64], i: usize, aspect: f64) -> Point {
    (points[i * 3] * aspect, points[i * 3 + 1])
}

fn distance(a: Point, b: Point) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

fn nonzero(v: f64) -> f64 {
    if v == 0.0 { 1e-6 } else { v }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub pose: HandPose,
    pub pinch_gap: f64,
    /// At least three fingers stretched out, whichever way the hand points: what a wave or a sweep is made with.
    pub open: bool,
}

/// What a hand is doing, from its (smoothed) points.
pub fn hand_shape(points: &[f64], aspect: f64, pinch_distance: f64) -> Shape {
    let p = |i: usize| point(points, i, aspect);
    let wrist = p(WRIST);
    let size = nonzero(distance(wrist, p(MIDDLE_MCP)));
    let reach: Vec<f64> = FINGERS
        .iter()
        .map(|&(knuckle, tip)| distance(wrist, p(tip)) / nonzero(distance(wrist, p(knuckle))))
        .collect();
    let extended = reach.iter().filter(|r| **r > EXTENDED).count();
    let folded = reach.iter().filter(|r| **r < FOLDED).count();
    let pinch_gap = distance(p(THUMB_TIP), p(INDEX_TIP)) / size;
    let open = extended >= 3;

    // A fist also brings the thumb's tip against the index: in a pinch the index reaches out to meet it, or bends over.
    let index_reach = reach[0];
    let others_folded = reach[1..].iter().all(|r| *r < OTHERS_FOLDED);
    let fist = index_reach < PINCH_MIN_REACH || (others_folded && index_reach < GRIP_REACH);
    if pinch_gap < pinch_distance && !fist {
        return Shape {
            pose: HandPose::Pinch,
            pinch_gap,
            open,
        };
    }

    let thumb_tip = p(THUMB_TIP);
    let thumb_base = p(THUMB_MCP);
    let thumb_length = nonzero(distance(thumb_base, thumb_tip));
    let thumb_upward = (thumb_base.1 - thumb_tip.1) / thumb_length;
    let thumb_out = distance(thumb_tip, p(INDEX_MCP)) / size;
    let thumb_above_fingers = FINGERS.iter().all(|&(_, tip)| p(tip).1 > thumb_tip.1);
    if folded == 4 && thumb_out > 0.6 && thumb_upward > 0.7 && thumb_above_fingers {
        return Shape {
            pose: HandPose::ThumbUp,
            pinch_gap,
            open,
        };
    }

    // Fingers up: the middle finger's tip well above the wrist.
    let fingers_up = (wrist.1 - p(12).1) / size > 1.2;
    if extended == 4 && fingers_up {
        return Shape {
            pose: HandPose::OpenPalm,
            pinch_gap,
            open,
        };
    }
    Shape {
        pose: HandPose::Other,
        pinch_gap,
        open,
    }
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    t: f64,
    present: bool,
    /// The wrist as seen in this frame: a wave is judged on it, smoothing would only make it late.
    x: f64,
    y: f64,
    open: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Right,
    Left,
    Up,
    Down,
}

/// Follows one hand through the camera frames and says when it made a gesture.
#[derive(Debug, Clone)]
pub struct GestureRecognizer {
    options: RecognizerOptions,
    recent: Vec<Vec<f64>>,
    scores: Vec<f64>,
    last_seen_at: f64,
    last_wrist: Option<Point>,
    history: Vec<Sample>,
    current: RecognizerState,
    blocked_until: f64,
    right_locked_until: f64,
    left_locked_until: f64,
    up_locked_until: f64,
    down_locked_until: f64,
    pinch_since: Option<f64>,
    pinch_armed: bool,
    release_since: Option<f64>,
    thumb_since: Option<f64>,
    thumb_off_since: Option<f64>,
    thumb_armed: bool,
}

impl GestureRecognizer {
    pub fn new(options: RecognizerOptions) -> Self {
        Self {
            options,
            recent: Vec::new(),
            scores: Vec::new(),
            last_seen_at: f64::NEG_INFINITY,
            last_wrist: None,
            history: Vec::new(),
            current: RecognizerState::default(),
            blocked_until: f64::NEG_INFINITY,
            right_locked_until: f64::NEG_INFINITY,
            left_locked_until: f64::NEG_INFINITY,
            up_locked_until: f64::NEG_INFINITY,
            down_locked_until: f64::NEG_INFINITY,
            pinch_since: None,
            pinch_armed: true,
            release_since: None,
            thumb_since: None,
            thumb_off_since: None,
            thumb_armed: true,
        }
    }

    pub fn set_options(&mut self, options: RecognizerOptions) {
        self.options = options;
    }

    /// What it makes of the hand right now.
    pub fn state(&self) -> RecognizerState {
        self.current
    }

    /// Forgets everything (the camera stopped, the car mode was left).
    pub fn reset(&mut self) {
        *self = Self::new(self.options.clone());
    }

    fn forget_poses(&mut self) {
        self.pinch_since = None;
        self.release_since = None;
        self.thumb_since = None;
        self.thumb_off_since = None;
    }

    /// The hand to follow: the one nearest where the followed hand was, or else the biggest (nearest the camera).
    fn choose<'a>(&self, frame: &'a HandFrame, aspect: f64) -> Option<&'a HandObservation> {
        let candidates: Vec<&HandObservation> = frame
            .hands
            .iter()
            .filter(|h| h.score >= MIN_SCORE && h.points.len() >= 63)
            .collect();
        let first = *candidates.first()?;
        if let Some(from) = self.last_wrist
            && frame.t - self.last_seen_at <= LOST_AFTER_MS
        {
            let near = |h: &HandObservation| distance(point(&h.points, WRIST, aspect), from);
            return Some(
                candidates
                    .into_iter()
                    .fold(first, |best, h| if near(h) < near(best) { h } else { best }),
            );
        }
        let size = |h: &HandObservation| {
            distance(
                point(&h.points, WRIST, aspect),
                point(&h.points, MIDDLE_MCP, aspect),
            )
        };
        Some(
            candidates
                .into_iter()
                .fold(first, |best, h| if size(h) > size(best) { h } else { best }),
        )
    }

    fn fire(&mut self, gesture: Gesture, t: f64, confidence: f64) -> Option<GestureEvent> {
        if !self.options.enabled[gesture.index()] {
            return None;
        }
        self.blocked_until = t + COOLDOWN_MS;
        Some(GestureEvent {
            gesture,
            confidence: (confidence.clamp(0.0, 1.0) * 100.0 + 0.5).floor() / 100.0,
        })
    }

    fn trim_history(&mut self, t: f64) {
        let keep_from = self
            .history
            .iter()
            .position(|s| s.t >= t - WAVE_WINDOW_MS)
            .unwrap_or(self.history.len());
        self.history.drain(..keep_from);
    }

    /// One camera frame in; at most one gesture out.
    pub fn push(&mut self, frame: &HandFrame) -> Option<GestureEvent> {
        let t = frame.t;
        let aspect = if frame.width > 0.0 && frame.height > 0.0 {
            frame.width / frame.height
        } else {
            1.0
        };
        let Some(hand) = self.choose(frame, aspect) else {
            self.history.push(Sample {
                t,
                present: false,
                x: 0.0,
                y: 0.0,
                open: false,
            });
            self.trim_history(t);
            if t - self.last_seen_at > LOST_AFTER_MS {
                // Gone: the next hand starts afresh, and may pinch or give a thumb again.
                self.recent.clear();
                self.scores.clear();
                self.last_wrist = None;
                self.pinch_armed = true;
                self.thumb_armed = true;
                self.forget_poses();
            }
            self.current = RecognizerState::default();
            return None;
        };

        if t - self.last_seen_at > LOST_AFTER_MS {
            self.recent.clear();
            self.scores.clear();
        }
        self.last_seen_at = t;
        self.last_wrist = Some(point(&hand.points, WRIST, aspect));
        self.recent.push(hand.points.clone());
        self.scores.push(hand.score);
        if self.recent.len() > SMOOTHING_FRAMES {
            self.recent.remove(0);
        }
        if self.scores.len() > SMOOTHING_FRAMES {
            self.scores.remove(0);
        }
        let smoothed = average(&self.recent);
        let score = self.scores.iter().sum::<f64>() / self.scores.len() as f64;

        let Thresholds {
            pinch_distance,
            swipe_min_distance,
            swipe_confidence,
        } = self.options.thresholds;
        let shape = hand_shape(&smoothed, aspect, pinch_distance);
        let (x, y) = (smoothed[WRIST * 3], smoothed[WRIST * 3 + 1]);
        self.history.push(Sample {
            t,
            present: true,
            x: hand.points[WRIST * 3],
            y: hand.points[WRIST * 3 + 1],
            open: shape.open,
        });
        self.trim_history(t);
        self.current = RecognizerState {
            present: true,
            pose: Some(shape.pose),
            pinch_gap: Some(shape.pinch_gap),
            x: Some(x),
            y: Some(y),
            score,
        };

        // Re-arming happens whatever else is going on, so a gesture held through the cooldown still has to end first.
        if shape.pose == HandPose::Pinch {
            self.release_since = None;
            self.pinch_since.get_or_insert(t);
        } else if shape.pinch_gap > pinch_distance * PINCH_RELEASE {
            self.pinch_since = None;
            let since = *self.release_since.get_or_insert(t);
            if t - since >= RELEASE_MS {
                self.pinch_armed = true;
            }
        } else {
            // Loosened a little, not opened: the pinch goes on (its hold too), and does not count as a new one.
            self.release_since = None;
        }
        if shape.pose == HandPose::ThumbUp {
            self.thumb_off_since = None;
            self.thumb_since.get_or_insert(t);
        } else {
            self.thumb_since = None;
            let since = *self.thumb_off_since.get_or_insert(t);
            if t - since >= THUMB_RELEASE_MS {
                self.thumb_armed = true;
            }
        }
        if t < self.blocked_until {
            return None;
        }

        // A wave or a sweep: the wrist crossed far enough within the window, seen in enough frames, the hand open.
        if let Some((direction, seen)) = self.sweep_in(aspect, swipe_min_distance, swipe_confidence)
        {
            let lock = match direction {
                Direction::Right => self.right_locked_until,
                Direction::Left => self.left_locked_until,
                Direction::Up => self.up_locked_until,
                Direction::Down => self.down_locked_until,
            };
            if t >= lock {
                // Bringing the hand back is not a movement the other way.
                match direction {
                    Direction::Right => self.left_locked_until = t + OPPOSITE_WAVE_LOCK_MS,
                    Direction::Left => self.right_locked_until = t + OPPOSITE_WAVE_LOCK_MS,
                    Direction::Up => self.down_locked_until = t + OPPOSITE_WAVE_LOCK_MS,
                    Direction::Down => self.up_locked_until = t + OPPOSITE_WAVE_LOCK_MS,
                }
                let last = *self.history.last().expect("this frame was just added");
                self.history = vec![last];
                self.forget_poses();
                let gesture = match direction {
                    Direction::Right => Gesture::WaveRight,
                    Direction::Left => Gesture::WaveLeft,
                    Direction::Up => Gesture::PalmUp,
                    Direction::Down => Gesture::PalmDown,
                };
                return self.fire(gesture, t, score.min(seen));
            }
        }

        if let Some(since) = self.pinch_since
            && self.pinch_armed
            && t - since >= PINCH_HOLD_MS
        {
            self.pinch_armed = false;
            return self.fire(Gesture::Pinch, t, score);
        }
        if let Some(since) = self.thumb_since
            && self.thumb_armed
            && t - since >= THUMB_HOLD_MS
        {
            self.thumb_armed = false;
            return self.fire(Gesture::ThumbUp, t, score);
        }
        None
    }

    fn sweep_in(&self, aspect: f64, min_distance: f64, min_seen: f64) -> Option<(Direction, f64)> {
        if self.history.len() < 3 {
            return None;
        }
        let present: Vec<&Sample> = self.history.iter().filter(|s| s.present).collect();
        let seen = present.len() as f64 / self.history.len() as f64;
        if seen < min_seen {
            return None;
        }
        // Hands gripping or turning a wheel, a fist, a pointing finger: only an open hand waves.
        if (present.iter().filter(|s| s.open).count() as f64) / (present.len() as f64) < OPEN_SHARE
        {
            return None;
        }
        let now = *self.history.last()?;
        if !now.present {
            return None;
        }
        let (mut left, mut right, mut top, mut bottom): (
            Option<&Sample>,
            Option<&Sample>,
            Option<&Sample>,
            Option<&Sample>,
        ) = (None, None, None, None);
        for s in &present {
            if left.is_none_or(|l| s.x < l.x) {
                left = Some(s);
            }
            if right.is_none_or(|r| s.x > r.x) {
                right = Some(s);
            }
            if top.is_none_or(|tp| s.y < tp.y) {
                top = Some(s);
            }
            if bottom.is_none_or(|b| s.y > b.y) {
                bottom = Some(s);
            }
        }
        // Mostly sideways: a hand raised or lowered across the picture is not a wave.
        if let Some(l) = left
            && now.x - l.x >= min_distance
            && (now.y - l.y).abs() < (now.x - l.x) * 0.7
        {
            return Some((Direction::Right, seen));
        }
        if let Some(r) = right
            && r.x - now.x >= min_distance
            && (now.y - r.y).abs() < (r.x - now.x) * 0.7
        {
            return Some((Direction::Left, seen));
        }
        // And mostly up or down for the volume (x counted in picture heights, as the hand's shape is).
        let rise = min_distance * VERTICAL_SHARE;
        if let Some(b) = bottom
            && b.y - now.y >= rise
            && (now.x - b.x).abs() * aspect < (b.y - now.y) * 0.7
        {
            return Some((Direction::Up, seen));
        }
        if let Some(tp) = top
            && now.y - tp.y >= rise
            && (now.x - tp.x).abs() * aspect < (now.y - tp.y) * 0.7
        {
            return Some((Direction::Down, seen));
        }
        None
    }
}

fn average(frames: &[Vec<f64>]) -> Vec<f64> {
    let mut out = vec![0.0; frames[0].len()];
    for frame in frames {
        for (i, v) in out.iter_mut().enumerate() {
            *v += frame.get(i).copied().unwrap_or(0.0);
        }
    }
    let n = frames.len() as f64;
    out.into_iter().map(|v| v / n).collect()
}

// Ported from mobile/tests/gestures.test.js, on the same real hands.
#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const FIXTURE: &str = include_str!("../../../mobile/tests/fixtures/mediapipe-hands.json");
    const STEP: f64 = 1000.0 / 24.0;

    fn fixture(name: &str) -> Vec<(f64, f64)> {
        let all: Value = serde_json::from_str(FIXTURE).unwrap();
        all["hands"][name]["points"]
            .as_array()
            .unwrap_or_else(|| panic!("no hand {name}"))
            .iter()
            .map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap()))
            .collect()
    }

    #[derive(Clone, Copy)]
    struct At {
        x: Option<f64>,
        y: Option<f64>,
        scale: f64,
        aspect: f64,
    }

    const ANYWHERE: At = At {
        x: None,
        y: None,
        scale: 1.0,
        aspect: 1.0,
    };

    fn at(x: f64, y: f64, scale: f64) -> At {
        At {
            x: Some(x),
            y: Some(y),
            scale,
            aspect: 1.0,
        }
    }

    /// A fixture hand as the landmarker sends it (63 numbers), its wrist moved and its size scaled.
    fn hand(name: &str, o: At) -> Vec<f64> {
        let points = fixture(name);
        let (wx, wy) = points[0];
        let (ox, oy) = (o.x.unwrap_or(wx), o.y.unwrap_or(wy));
        points
            .iter()
            .flat_map(|&(px, py)| {
                [
                    ox + (px - wx) * o.scale / o.aspect,
                    oy + (py - wy) * o.scale,
                    0.0,
                ]
            })
            .collect()
    }

    /// A fixture hand turned about its wrist (degrees, clockwise on screen), in a picture of the given shape.
    fn turned(name: &str, degrees: f64, aspect: f64) -> Vec<f64> {
        let points = fixture(name);
        let (wx, wy) = points[0];
        let a = degrees.to_radians();
        points
            .iter()
            .flat_map(|&(x, y)| {
                let (dx, dy) = (x - wx, y - wy);
                [
                    wx + (dx * a.cos() - dy * a.sin()) / aspect,
                    wy + dx * a.sin() + dy * a.cos(),
                    0.0,
                ]
            })
            .collect()
    }

    fn shifted(points: &[f64], dx: f64, dy: f64) -> Vec<f64> {
        points
            .iter()
            .enumerate()
            .map(|(i, v)| match i % 3 {
                0 => v + dx,
                1 => v + dy,
                _ => *v,
            })
            .collect()
    }

    fn get(p: &[f64], i: usize) -> (f64, f64) {
        (p[i * 3], p[i * 3 + 1])
    }

    fn set(p: &mut [f64], i: usize, (x, y): (f64, f64)) {
        p[i * 3] = x;
        p[i * 3 + 1] = y;
    }

    fn lerp(a: (f64, f64), b: (f64, f64), k: f64) -> (f64, f64) {
        (a.0 + (b.0 - a.0) * k, a.1 + (b.1 - a.1) * k)
    }

    /// The open right hand, its index bent over to meet the thumb: a pinch.
    fn pinch_points(o: At) -> Vec<f64> {
        let mut p = hand("openRightUp", o);
        let (thumb, knuckle) = (get(&p, 4), get(&p, 5));
        set(&mut p, 8, (thumb.0 + 0.01, thumb.1 - 0.01));
        set(&mut p, 7, lerp(knuckle, thumb, 0.75));
        set(&mut p, 6, lerp(knuckle, thumb, 0.4));
        p
    }

    /// The open hand with thumb and index tips together `reach` index-knuckle-distances from the wrist.
    fn pinch_reaching(reach: f64, o: At) -> Vec<f64> {
        let mut p = hand("openRightUp", o);
        let (wrist, knuckle) = (get(&p, 0), get(&p, 5));
        let length = (knuckle.0 - wrist.0).hypot(knuckle.1 - wrist.1);
        let unit = (
            (knuckle.0 - wrist.0) / length,
            (knuckle.1 - wrist.1) / length,
        );
        let meet = (
            wrist.0 + unit.0 * length * reach,
            wrist.1 + unit.1 * length * reach,
        );
        let thumb_base = get(&p, 2);
        set(&mut p, 4, (meet.0 - 0.004, meet.1));
        let thumb_tip = get(&p, 4);
        set(&mut p, 3, lerp(thumb_base, thumb_tip, 0.55));
        set(&mut p, 8, (meet.0 + 0.004, meet.1));
        set(&mut p, 7, lerp(knuckle, meet, 0.7));
        set(&mut p, 6, lerp(knuckle, meet, 0.35));
        p
    }

    /// The real fist, its index lifted to `reach` and the thumb following its tip.
    fn grip_with_index(reach: f64) -> Vec<f64> {
        let mut p = hand("fist", ANYWHERE);
        let (wrist, knuckle, tip) = (get(&p, 0), get(&p, 5), get(&p, 8));
        let was = (tip.0 - wrist.0).hypot(tip.1 - wrist.1);
        let want = (knuckle.0 - wrist.0).hypot(knuckle.1 - wrist.1) * reach;
        let scale = want / was;
        for i in [6, 7, 8] {
            let q = get(&p, i);
            set(
                &mut p,
                i,
                (
                    wrist.0 + (q.0 - wrist.0) * scale,
                    wrist.1 + (q.1 - wrist.1) * scale,
                ),
            );
        }
        let index_tip = get(&p, 8);
        set(&mut p, 4, (index_tip.0 - 0.004, index_tip.1));
        p
    }

    /// The Park–Miller generator the TypeScript tests use: -0.5 to 0.5.
    struct Lcg(f64);

    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = (self.0 * 16807.0) % 2_147_483_647.0;
            self.0 / 2_147_483_647.0 - 0.5
        }
    }

    fn with_noise(points: &[f64], amount: f64, seed: f64) -> Vec<f64> {
        let mut random = Lcg(seed);
        points
            .iter()
            .enumerate()
            .map(|(i, v)| {
                if i % 3 == 2 {
                    *v
                } else {
                    v + random.next() * 2.0 * amount
                }
            })
            .collect()
    }

    const SPOT: At = At {
        x: Some(0.5),
        y: Some(0.62),
        scale: 0.4,
        aspect: 1.0,
    };

    fn open() -> Vec<f64> {
        hand("openRightUp", SPOT)
    }

    fn pinch() -> Vec<f64> {
        pinch_points(SPOT)
    }

    fn recognizer() -> GestureRecognizer {
        GestureRecognizer::new(RecognizerOptions::default())
    }

    type Frames = Vec<Vec<Vec<f64>>>;

    struct Play {
        start: f64,
        score: f64,
        width: f64,
        height: f64,
    }

    const PLAY: Play = Play {
        start: 0.0,
        score: 0.95,
        width: 640.0,
        height: 640.0,
    };

    /// Feeds the frames (each a list of hands' points) and returns the gestures with the time each fired.
    fn play_with(rec: &mut GestureRecognizer, frames: &Frames, o: Play) -> Vec<(Gesture, i64)> {
        let mut events = Vec::new();
        for (i, hands) in frames.iter().enumerate() {
            let t = o.start + i as f64 * STEP;
            let frame = HandFrame {
                t,
                width: o.width,
                height: o.height,
                hands: hands
                    .iter()
                    .map(|p| HandObservation {
                        score: o.score,
                        points: p.clone(),
                    })
                    .collect(),
            };
            if let Some(event) = rec.push(&frame) {
                events.push((event.gesture, (t + 0.5).floor() as i64));
            }
        }
        events
    }

    fn play(rec: &mut GestureRecognizer, frames: &Frames) -> Vec<(Gesture, i64)> {
        play_with(rec, frames, PLAY)
    }

    fn names(events: &[(Gesture, i64)]) -> Vec<Gesture> {
        events.iter().map(|e| e.0).collect()
    }

    fn repeat_for(ms: f64, hands: Vec<Vec<f64>>) -> Frames {
        vec![hands; (ms / STEP).round() as usize]
    }

    fn cat(parts: Vec<Frames>) -> Frames {
        parts.into_iter().flatten().collect()
    }

    /// The open hand's wrist moving from y0 to y1 over `ms`, at x.
    fn rise(y0: f64, y1: f64, ms: f64, name: &str) -> Frames {
        let n = ((ms / STEP).round() as usize).max(2);
        (0..n)
            .map(|i| {
                vec![hand(
                    name,
                    at(0.5, y0 + (y1 - y0) * i as f64 / (n - 1) as f64, 0.4),
                )]
            })
            .collect()
    }

    /// The open hand's wrist moving from x0 to x1 over `ms`, at height y.
    fn sweep_at(x0: f64, x1: f64, ms: f64, y: f64, name: &str, scale: f64) -> Frames {
        let n = ((ms / STEP).round() as usize).max(2);
        (0..n)
            .map(|i| {
                vec![hand(
                    name,
                    at(x0 + (x1 - x0) * i as f64 / (n - 1) as f64, y, scale),
                )]
            })
            .collect()
    }

    fn sweep(x0: f64, x1: f64, ms: f64) -> Frames {
        sweep_at(x0, x1, ms, 0.75, "openRightUp", 0.5)
    }

    fn pose(points: &[f64], aspect: f64) -> HandPose {
        hand_shape(points, aspect, DEFAULT_THRESHOLDS.pinch_distance).pose
    }

    use Gesture::*;
    use HandPose as P;

    // --- The hand's shape, on the real hands ---

    #[test]
    fn real_hands_a_thumb_up_is_one_a_fist_pointing_finger_and_victory_are_nothing() {
        assert_eq!(pose(&hand("thumbUp", ANYWHERE), 1.0), P::ThumbUp);
        for name in ["fist", "pointingUp", "victory", "pointingUpRotated"] {
            assert_eq!(pose(&hand(name, ANYWHERE), 1.0), P::Other, "{name}");
        }
    }

    #[test]
    fn real_hands_an_open_hand_up_is_an_open_palm_down_or_sideways_it_is_not() {
        assert_eq!(pose(&hand("openLeftUp", ANYWHERE), 1.0), P::OpenPalm);
        assert_eq!(pose(&hand("openRightUp", ANYWHERE), 1.0), P::OpenPalm);
        for name in [
            "openLeftDown",
            "openRightDown",
            "openRightUpRotated",
            "openRightDownRotated",
        ] {
            assert_eq!(pose(&hand(name, ANYWHERE), 1.0), P::Other, "{name}");
        }
        assert_ne!(
            pose(&hand("thumbUpRotated", ANYWHERE), 1.0),
            P::ThumbUp,
            "a thumb sideways"
        );
    }

    #[test]
    fn a_thumb_up_a_little_tilted_is_still_one_leaning_far_over_it_is_not() {
        assert_eq!(pose(&turned("thumbUp", -10.0, 1.0), 1.0), P::ThumbUp);
        assert_eq!(pose(&turned("thumbUp", 20.0, 1.0), 1.0), P::ThumbUp);
        let leaning = turned("thumbUp", -30.0, 1.0);
        assert!(
            [8, 12, 16, 20]
                .iter()
                .all(|i| leaning[i * 3 + 1] > leaning[4 * 3 + 1])
        );
        assert_ne!(pose(&leaning, 1.0), P::ThumbUp);
    }

    #[test]
    fn a_finger_gun_is_no_like() {
        let mut gun = hand("thumbUp", ANYWHERE);
        let (w, k) = (get(&gun, 0), get(&gun, 5));
        for (i, s) in [(6, 0.35), (7, 0.65), (8, 0.9)] {
            set(&mut gun, i, (k.0 + (k.0 - w.0) * s, k.1 + (k.1 - w.1) * s));
        }
        assert_ne!(pose(&gun, 1.0), P::ThumbUp);
    }

    #[test]
    fn a_fist_brings_the_thumb_against_the_index_too_but_only_a_real_pinch_is_one() {
        let fist = hand_shape(
            &hand("fist", ANYWHERE),
            1.0,
            DEFAULT_THRESHOLDS.pinch_distance,
        );
        assert!(
            fist.pinch_gap < DEFAULT_THRESHOLDS.pinch_distance,
            "{}",
            fist.pinch_gap
        );
        assert_ne!(fist.pose, P::Pinch);
        assert_eq!(pose(&pinch_points(ANYWHERE), 1.0), P::Pinch);
    }

    #[test]
    fn the_shape_does_not_depend_on_size_place_or_picture_shape() {
        for (name, expected) in [
            ("thumbUp", P::ThumbUp),
            ("openRightUp", P::OpenPalm),
            ("fist", P::Other),
        ] {
            assert_eq!(
                pose(&hand(name, at(0.3, 0.6, 0.4)), 1.0),
                expected,
                "{name} small"
            );
            for aspect in [4.0 / 3.0, 3.0 / 4.0] {
                let o = At {
                    x: Some(0.5),
                    y: Some(0.5),
                    scale: 1.0,
                    aspect,
                };
                assert_eq!(pose(&hand(name, o), aspect), expected, "{name} in {aspect}");
            }
        }
        assert_eq!(pose(&pinch_points(at(0.6, 0.7, 0.35)), 1.0), P::Pinch);
    }

    #[test]
    fn a_slightly_tilted_thumb_up_reads_the_same_in_portrait_and_wide_pictures() {
        for degrees in [-12.0, -10.0, -8.0, 25.0] {
            for aspect in [3.0 / 4.0, 16.0 / 9.0] {
                assert_eq!(pose(&turned("thumbUp", degrees, 1.0), 1.0), P::ThumbUp);
                assert_eq!(
                    pose(&turned("thumbUp", degrees, aspect), aspect),
                    P::ThumbUp,
                    "{degrees}° in {aspect}"
                );
            }
        }
        assert_eq!(
            pose(&turned("thumbUp", -14.0, 16.0 / 9.0), 16.0 / 9.0),
            P::Other
        );
    }

    #[test]
    fn the_thumb_index_gap_measures_the_same_in_a_wide_picture() {
        let gap = |aspect: f64| {
            let o = At {
                x: Some(0.5),
                y: Some(0.5),
                scale: 1.0,
                aspect,
            };
            hand_shape(&hand("openRightUp", o), aspect, 0.3).pinch_gap
        };
        let square = gap(1.0);
        for aspect in [4.0 / 3.0, 16.0 / 9.0, 3.0 / 4.0] {
            assert!((gap(aspect) - square).abs() < 0.01 * square, "{aspect}");
        }
    }

    // --- Pinch ---

    #[test]
    fn a_pinch_held_200_ms_fires_once_however_long_it_is_held() {
        let events = play(
            &mut recognizer(),
            &cat(vec![
                repeat_for(300.0, vec![open()]),
                repeat_for(3000.0, vec![pinch()]),
            ]),
        );
        assert_eq!(names(&events), [Pinch]);
        let after = events[0].1 - 300;
        assert!(
            (200..=400).contains(&after),
            "fired {after} ms into the pinch"
        );
    }

    #[test]
    fn a_pinch_too_short_does_nothing_and_opening_then_pinching_again_counts_again() {
        let short = cat(vec![
            repeat_for(300.0, vec![open()]),
            repeat_for(100.0, vec![pinch()]),
            repeat_for(600.0, vec![open()]),
        ]);
        assert!(play(&mut recognizer(), &short).is_empty());
        let twice = cat(vec![
            repeat_for(500.0, vec![open()]),
            repeat_for(600.0, vec![pinch()]),
            repeat_for(500.0, vec![open()]),
            repeat_for(600.0, vec![pinch()]),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &twice)), [Pinch, Pinch]);
    }

    #[test]
    fn fingers_that_only_loosen_a_little_are_still_the_same_pinch() {
        let mut loose = pinch();
        loose[8 * 3] += 0.055;
        let gap = hand_shape(&loose, 1.0, 0.3).pinch_gap;
        assert!(gap > 0.3 && gap < 0.3 * 1.6, "{gap}");
        let frames = cat(vec![
            repeat_for(300.0, vec![open()]),
            repeat_for(500.0, vec![pinch()]),
            repeat_for(400.0, vec![loose]),
            repeat_for(500.0, vec![pinch()]),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &frames)), [Pinch]);
    }

    #[test]
    fn a_pinch_with_the_index_bent_over_counts_too() {
        for reach in [1.0, 1.05, 1.15, 1.3, 1.5] {
            assert_eq!(
                pose(&pinch_reaching(reach, SPOT), 1.0),
                P::Pinch,
                "reach {reach}"
            );
            let frames = cat(vec![
                repeat_for(300.0, vec![open()]),
                repeat_for(600.0, vec![pinch_reaching(reach, SPOT)]),
            ]);
            assert_eq!(
                names(&play(&mut recognizer(), &frames)),
                [Pinch],
                "reach {reach}"
            );
        }
    }

    #[test]
    fn a_closed_hand_is_no_pinch_however_close_the_thumb_is() {
        for reach in [0.9, 1.0, 1.05] {
            let grip = grip_with_index(reach);
            let shape = hand_shape(&grip, 1.0, 0.3);
            assert!(
                shape.pinch_gap < 0.3,
                "the thumb is on the index: {}",
                shape.pinch_gap
            );
            assert_ne!(shape.pose, P::Pinch, "reach {reach}");
        }
        assert_eq!(pose(&grip_with_index(1.25), 1.0), P::Pinch);
        assert!(
            play(
                &mut recognizer(),
                &repeat_for(3000.0, vec![hand("fist", ANYWHERE)])
            )
            .is_empty(),
            "a fist never plays"
        );
    }

    #[test]
    fn a_hand_hidden_for_a_frame_or_two_is_still_the_same_pinch() {
        for held in [250.0, 700.0] {
            let frames = cat(vec![
                repeat_for(300.0, vec![open()]),
                repeat_for(held, vec![pinch()]),
                vec![vec![], vec![]],
                repeat_for(1500.0, vec![pinch()]),
            ]);
            assert_eq!(
                names(&play(&mut recognizer(), &frames)),
                [Pinch],
                "hidden after {held} ms"
            );
        }
    }

    #[test]
    fn a_pinch_lost_one_frame_in_four_still_counts() {
        let mut loose = pinch();
        loose[8 * 3] += 0.055;
        let n = (2000.0 / STEP).round() as usize;
        let mut frames = repeat_for(300.0, vec![open()]);
        frames.extend((0..n).map(|i| vec![if i % 4 == 3 { loose.clone() } else { pinch() }]));
        assert_eq!(names(&play(&mut recognizer(), &frames)), [Pinch]);
    }

    #[test]
    fn a_hand_that_left_and_came_back_may_pinch_again_without_opening() {
        let frames = cat(vec![
            repeat_for(600.0, vec![pinch()]),
            repeat_for(500.0, vec![]),
            repeat_for(600.0, vec![pinch()]),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &frames)), [Pinch, Pinch]);
    }

    // --- Thumb up ---

    #[test]
    fn a_thumb_up_held_400_ms_likes_once() {
        let frames = cat(vec![
            repeat_for(300.0, vec![hand("fist", ANYWHERE)]),
            repeat_for(3000.0, vec![hand("thumbUp", ANYWHERE)]),
        ]);
        let events = play(&mut recognizer(), &frames);
        assert_eq!(names(&events), [ThumbUp]);
        let after = events[0].1 - 300;
        assert!((400..=600).contains(&after), "fired {after} ms in");
    }

    #[test]
    fn a_flickering_thumb_is_not_a_second_like_a_lowered_and_raised_one_is() {
        for flicker in 1..=3 {
            let frames = cat(vec![
                repeat_for(800.0, vec![hand("thumbUp", ANYWHERE)]),
                vec![vec![hand("fist", ANYWHERE)]; flicker],
                repeat_for(1200.0, vec![hand("thumbUp", ANYWHERE)]),
            ]);
            assert_eq!(
                names(&play(&mut recognizer(), &frames)),
                [ThumbUp],
                "{flicker} frame(s)"
            );
        }
        let frames = cat(vec![
            repeat_for(800.0, vec![hand("thumbUp", ANYWHERE)]),
            repeat_for(400.0, vec![hand("fist", ANYWHERE)]),
            repeat_for(800.0, vec![hand("thumbUp", ANYWHERE)]),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &frames)), [ThumbUp, ThumbUp]);
        assert!(
            play(
                &mut recognizer(),
                &repeat_for(2000.0, vec![hand("thumbUpRotated", ANYWHERE)])
            )
            .is_empty()
        );
    }

    // --- Waves ---

    #[test]
    fn crossing_to_the_right_is_next_within_half_a_second_and_to_the_left_previous() {
        let frames = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.25, 0.75, 0.5))]),
            sweep(0.25, 0.75, 350.0),
        ]);
        let events = play(&mut recognizer(), &frames);
        assert_eq!(names(&events), [WaveRight]);
        assert!(events[0].1 - 300 <= 500);
        let frames = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.75, 0.75, 0.5))]),
            sweep(0.75, 0.25, 350.0),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &frames)), [WaveLeft]);
    }

    #[test]
    fn bringing_the_hand_back_is_not_a_wave_back_a_second_wave_the_same_way_is() {
        let start = vec![hand("openRightUp", at(0.25, 0.75, 0.5))];
        let frames = cat(vec![
            repeat_for(300.0, start.clone()),
            sweep(0.25, 0.75, 350.0),
            sweep(0.75, 0.25, 400.0),
            repeat_for(500.0, start.clone()),
            sweep(0.25, 0.75, 350.0),
        ]);
        assert_eq!(
            names(&play(&mut recognizer(), &frames)),
            [WaveRight, WaveRight]
        );
        let quick = cat(vec![
            repeat_for(300.0, start.clone()),
            sweep(0.25, 0.75, 300.0),
            sweep(0.75, 0.25, 300.0),
            repeat_for(150.0, start),
            sweep(0.25, 0.75, 300.0),
        ]);
        let events = play(&mut recognizer(), &quick);
        assert_eq!(names(&events), [WaveRight, WaveRight]);
        assert!(events[1].1 - events[0].1 < 1200);
    }

    #[test]
    fn a_wave_out_of_the_picture_counts_grips_drifts_short_moves_and_newcomers_do_not() {
        let out = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.35, 0.75, 0.5))]),
            sweep(0.35, 0.7, 250.0),
            repeat_for(500.0, vec![]),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &out)), [WaveRight]);
        assert!(
            play(
                &mut recognizer(),
                &sweep_at(0.2, 0.8, 350.0, 0.75, "fist", 0.5)
            )
            .is_empty()
        );
        assert!(
            play(
                &mut recognizer(),
                &sweep_at(0.8, 0.2, 350.0, 0.75, "pointingUp", 0.5)
            )
            .is_empty()
        );
        assert!(
            play(
                &mut recognizer(),
                &sweep_at(0.2, 0.8, 350.0, 0.75, "thumbUp", 0.5)
            )
            .is_empty()
        );
        assert!(
            play(&mut recognizer(), &sweep(0.2, 0.8, 2500.0)).is_empty(),
            "a slow drift"
        );
        let short = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.4, 0.75, 0.5))]),
            sweep(0.4, 0.55, 200.0),
        ]);
        assert!(play(&mut recognizer(), &short).is_empty());
        let newcomer = cat(vec![repeat_for(400.0, vec![]), sweep(0.3, 0.8, 130.0)]);
        assert!(play(&mut recognizer(), &newcomer).is_empty());
    }

    #[test]
    fn a_diagonal_move_is_neither_a_wave_nor_a_volume_change() {
        let n = (350.0 / STEP).round() as usize;
        let mut frames = repeat_for(300.0, vec![hand("openRightUp", at(0.3, 0.9, 0.4))]);
        frames.extend((0..n).map(|i| {
            let k = i as f64 / (n - 1) as f64;
            vec![hand("openRightUp", at(0.3 + 0.35 * k, 0.9 - 0.4 * k, 0.4))]
        }));
        assert!(play(&mut recognizer(), &frames).is_empty());
    }

    // --- Volume ---

    #[test]
    fn an_open_hand_swept_up_or_down_changes_the_volume_once() {
        let up = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.5, 0.85, 0.4))]),
            rise(0.85, 0.4, 400.0, "openRightUp"),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &up)), [PalmUp]);
        let down = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.5, 0.2, 0.4))]),
            rise(0.2, 0.7, 400.0, "openRightUp"),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &down)), [PalmDown]);
        let held = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.5, 0.85, 0.4))]),
            rise(0.85, 0.3, 450.0, "openRightUp"),
            repeat_for(800.0, vec![hand("openRightUp", at(0.5, 0.3, 0.4))]),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &held)), [PalmUp]);
    }

    #[test]
    fn an_open_hand_resting_high_or_low_does_nothing() {
        for y in [0.1, 0.3, 0.5, 0.8, 0.95] {
            assert!(
                play(
                    &mut recognizer(),
                    &repeat_for(6000.0, vec![hand("openRightUp", at(0.5, y, 0.4))])
                )
                .is_empty(),
                "{y}"
            );
        }
    }

    #[test]
    fn bringing_the_hand_back_after_a_volume_change_is_not_one_the_other_way() {
        let frames = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.5, 0.85, 0.4))]),
            rise(0.85, 0.35, 400.0, "openRightUp"),
            repeat_for(150.0, vec![hand("openRightUp", at(0.5, 0.35, 0.4))]),
            rise(0.35, 0.85, 500.0, "openRightUp"),
            repeat_for(100.0, vec![hand("openRightUp", at(0.5, 0.85, 0.4))]),
            rise(0.85, 0.35, 400.0, "openRightUp"),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &frames)), [PalmUp, PalmUp]);
    }

    #[test]
    fn a_slow_rise_a_short_one_or_a_raised_fist_is_not_a_volume_change() {
        assert!(play(&mut recognizer(), &rise(0.9, 0.2, 3000.0, "openRightUp")).is_empty());
        let short = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.5, 0.6, 0.4))]),
            rise(0.6, 0.5, 200.0, "openRightUp"),
        ]);
        assert!(play(&mut recognizer(), &short).is_empty());
        let fist = cat(vec![
            repeat_for(300.0, vec![hand("fist", at(0.5, 0.85, 0.4))]),
            rise(0.85, 0.3, 400.0, "fist"),
        ]);
        assert!(play(&mut recognizer(), &fist).is_empty());
    }

    #[test]
    fn waves_and_volume_sweeps_are_never_taken_for_each_other() {
        let waiting = cat(vec![
            repeat_for(1500.0, vec![hand("openRightUp", at(0.25, 0.72, 0.4))]),
            sweep_at(0.25, 0.75, 350.0, 0.72, "openRightUp", 0.4),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &waiting)), [WaveRight]);
        let wave = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.25, 0.6, 0.4))]),
            sweep_at(0.25, 0.8, 350.0, 0.6, "openRightUp", 0.4),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &wave)), [WaveRight]);
        let up = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.5, 0.85, 0.4))]),
            rise(0.85, 0.35, 350.0, "openRightUp"),
        ]);
        assert_eq!(names(&play(&mut recognizer(), &up)), [PalmUp]);
    }

    #[test]
    fn a_hand_shaking_on_a_bumpy_road_changes_nothing_and_jitter_in_a_pinch_is_smoothed() {
        let steady = hand("openRightUp", at(0.5, 0.3, 0.4));
        let mut random = Lcg(11.0);
        let n = (3000.0 / STEP).round() as usize;
        let bumpy: Frames = (0..n)
            .map(|_| vec![shifted(&steady, random.next() * 0.07, random.next() * 0.07)])
            .collect();
        assert!(play(&mut recognizer(), &bumpy).is_empty());
        let still = pinch_points(at(0.5, 0.7, 0.4));
        let n = (1500.0 / STEP).round() as usize;
        let shaky: Frames = (0..n)
            .map(|i| vec![with_noise(&still, 0.006, (i + 7) as f64)])
            .collect();
        assert_eq!(names(&play(&mut recognizer(), &shaky)), [Pinch]);
    }

    // --- Doubtful hands, two hands ---

    #[test]
    fn a_hand_the_landmarker_is_unsure_of_is_ignored() {
        let frames = repeat_for(2000.0, vec![pinch_points(ANYWHERE)]);
        assert!(play_with(&mut recognizer(), &frames, Play { score: 0.5, ..PLAY }).is_empty());
        assert_eq!(
            names(&play_with(
                &mut recognizer(),
                &frames,
                Play { score: 0.6, ..PLAY }
            )),
            [Pinch]
        );
    }

    #[test]
    fn a_passenger_hand_does_not_take_over_from_the_driver() {
        let driver = pinch_points(at(0.3, 0.8, 0.4));
        let n = (1200.0 / STEP).round() as usize;
        let start = repeat_for(300.0, vec![hand("openRightUp", at(0.3, 0.8, 0.4))]);
        let mut waving = start.clone();
        waving.extend((0..n).map(|i| {
            vec![
                driver.clone(),
                hand(
                    "openRightUp",
                    at(0.5 + 0.4 * (i as f64 / 8.0).min(1.0), 0.5, 0.3),
                ),
            ]
        }));
        assert_eq!(names(&play(&mut recognizer(), &waving)), [Pinch]);
        let mut leaning = start;
        leaning.extend((0..n).map(|i| {
            vec![
                hand(
                    "openRightUp",
                    at(0.45 + 0.45 * (i as f64 / 8.0).min(1.0), 0.55, 0.6),
                ),
                driver.clone(),
            ]
        }));
        assert_eq!(
            names(&play(&mut recognizer(), &leaning)),
            [Pinch],
            "nor a bigger hand coming in later"
        );
    }

    // --- Settings ---

    #[test]
    fn a_gesture_turned_off_never_fires_the_others_still_do() {
        let mut enabled = [true; 6];
        enabled[Pinch.index()] = false;
        let mut rec = GestureRecognizer::new(RecognizerOptions {
            thresholds: DEFAULT_THRESHOLDS,
            enabled,
        });
        let frames = cat(vec![
            repeat_for(800.0, vec![pinch_points(ANYWHERE)]),
            repeat_for(500.0, vec![]),
            repeat_for(800.0, vec![hand("thumbUp", ANYWHERE)]),
        ]);
        assert_eq!(names(&play(&mut rec, &frames)), [ThumbUp]);
    }

    #[test]
    fn just_after_a_gesture_nothing_fires_a_held_one_fires_after_the_pause() {
        let frames = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.25, 0.75, 0.5))]),
            sweep(0.25, 0.75, 350.0),
            repeat_for(1500.0, vec![pinch_points(at(0.75, 0.75, 0.5))]),
        ]);
        let events = play(&mut recognizer(), &frames);
        assert_eq!(names(&events), [WaveRight, Pinch]);
        assert!(events[1].1 - events[0].1 >= 600);
    }

    #[test]
    fn the_sensitivity_moves_every_threshold_the_same_way() {
        assert_eq!(thresholds_for(0.5), DEFAULT_THRESHOLDS);
        let (loose, strict) = (thresholds_for(1.0), thresholds_for(0.0));
        assert!(loose.pinch_distance > strict.pinch_distance);
        assert!(loose.swipe_min_distance < strict.swipe_min_distance);
        assert!(loose.swipe_confidence < strict.swipe_confidence);
        assert_eq!(thresholds_for(7.0), loose);
        assert_eq!(thresholds_for(-3.0), strict);
        assert_eq!(thresholds_for(f64::NAN), DEFAULT_THRESHOLDS);
        let frames = cat(vec![
            repeat_for(300.0, vec![hand("openRightUp", at(0.35, 0.75, 0.5))]),
            sweep(0.35, 0.6, 300.0),
            repeat_for(200.0, vec![hand("openRightUp", at(0.6, 0.75, 0.5))]),
        ]);
        assert!(play(&mut recognizer(), &frames).is_empty());
        let mut loose_rec = GestureRecognizer::new(RecognizerOptions {
            thresholds: loose,
            ..Default::default()
        });
        assert_eq!(
            names(&play(&mut loose_rec, &frames)),
            [WaveRight],
            "a looser sensitivity takes a shorter wave"
        );
    }

    #[test]
    fn reset_forgets_the_hand_and_the_state_says_where_it_is() {
        let mut rec = recognizer();
        play(&mut rec, &repeat_for(150.0, vec![pinch_points(ANYWHERE)]));
        rec.reset();
        assert!(!rec.state().present);
        assert!(
            play_with(
                &mut rec,
                &repeat_for(150.0, vec![pinch_points(ANYWHERE)]),
                Play {
                    start: 200.0,
                    ..PLAY
                }
            )
            .is_empty()
        );
        rec.reset();
        play_with(
            &mut rec,
            &vec![vec![hand("openRightUp", ANYWHERE)]],
            Play {
                start: 400.0,
                ..PLAY
            },
        );
        assert_eq!(rec.state().pose, Some(P::OpenPalm));

        let mut rec = recognizer();
        play(
            &mut rec,
            &repeat_for(
                300.0,
                vec![hand(
                    "thumbUp",
                    At {
                        x: Some(0.4),
                        y: Some(0.6),
                        scale: 1.0,
                        aspect: 1.0,
                    },
                )],
            ),
        );
        let seen = rec.state();
        assert!(seen.present);
        assert_eq!(seen.pose, Some(P::ThumbUp));
        assert!((seen.x.unwrap() - 0.4).abs() < 0.01 && (seen.y.unwrap() - 0.6).abs() < 0.01);
        play_with(
            &mut rec,
            &repeat_for(100.0, vec![]),
            Play {
                start: 400.0,
                ..PLAY
            },
        );
        assert!(!rec.state().present);
    }
}
