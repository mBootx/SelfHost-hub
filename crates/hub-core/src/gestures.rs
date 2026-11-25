//! The arithmetic of touch gestures: a list reordered by dragging, the mini player's swipe, and zooming a picture.
//!
//! Port of `mobile/src/services/dragMath.ts` and `zoomMath.ts`.

use std::collections::HashMap;

/// Which slot a row dragged from `start` is over once its top has moved by `offset` pixels.
pub fn slot_at(start: usize, offset: f64, row_height: f64, count: usize) -> usize {
    let slot = (start as f64 + offset / row_height).round();
    slot.clamp(0.0, count.saturating_sub(1) as f64) as usize
}

/// The slot of every row once row `key` has moved to `to`: those in between close the gap it left. `None` when
/// nothing moves.
pub fn move_slot(
    positions: &HashMap<String, usize>,
    key: &str,
    to: usize,
) -> Option<HashMap<String, usize>> {
    let from = *positions.get(key)?;
    if from == to {
        return None;
    }
    Some(
        positions
            .iter()
            .map(|(k, &p)| {
                let slot = if k == key {
                    to
                } else if from < to && p > from && p <= to {
                    p - 1
                } else if from > to && p >= to && p < from {
                    p + 1
                } else {
                    p
                };
                (k.clone(), slot)
            })
            .collect(),
    )
}

/// How fast a list scrolls on its own (pixels a frame, negative upwards) with the finger at `y` in a list whose top
/// is at `top` and which is `height` high: nothing in the middle, faster the closer to an edge.
pub fn edge_speed(y: f64, top: f64, height: f64, zone: f64, max: f64) -> f64 {
    if height <= 0.0 {
        return 0.0;
    }
    let from_top = y - top;
    let from_bottom = top + height - y;
    if from_top < zone {
        return -(max * ((zone - from_top) / zone).min(1.0)).ceil();
    }
    if from_bottom < zone {
        return (max * ((zone - from_bottom) / zone).min(1.0)).ceil();
    }
    0.0
}

/// [`edge_speed`] with the app's zone (72 px) and top speed (14 px a frame).
pub fn default_edge_speed(y: f64, top: f64, height: f64) -> f64 {
    edge_speed(y, top, height, 72.0, 14.0)
}

/// Keys for rows whose items may repeat (the same song twice in a queue): the id, and which time it appears.
pub fn occurrence_keys(ids: &[&str]) -> Vec<String> {
    let mut seen: HashMap<&str, usize> = HashMap::new();
    ids.iter()
        .map(|id| {
            let n = seen.entry(id).or_insert(0);
            let key = format!("{id}#{n}");
            *n += 1;
            key
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Next,
    Previous,
}

/// A swipe across the mini player: far or fast enough to the left is the next song, to the right the one before.
pub fn swipe_skip(translation_x: f64, velocity_x: f64) -> Option<Skip> {
    if translation_x < -70.0 || (translation_x < -24.0 && velocity_x < -700.0) {
        Some(Skip::Next)
    } else if translation_x > 70.0 || (translation_x > 24.0 && velocity_x > 700.0) {
        Some(Skip::Previous)
    } else {
        None
    }
}

// --- Zooming a picture. Positions are measured from the centre of the box the picture is shown in; a picture drawn
// with translate(offset) then scale(s) puts the content point p (from the same centre) at offset + s * p. ---

pub const MIN_SCALE: f64 = 1.0;
pub const MAX_SCALE: f64 = 5.0;
/// What a double tap zooms to.
pub const DOUBLE_TAP_SCALE: f64 = 2.5;
/// Below this, the picture counts as not zoomed (the pager may scroll again).
pub const ZOOMED_THRESHOLD: f64 = 1.02;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

impl View {
    pub const FIT: Self = Self {
        scale: 1.0,
        x: 0.0,
        y: 0.0,
    };
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    // "+ 0.0" turns a negative zero (a clamp to a zero-wide range) into a plain zero.
    value.max(low).min(high) + 0.0
}

/// How a picture of the `natural` size is laid out when fitted whole into `boxed` ("contain"). Unknown size: the
/// box itself.
pub fn fit_size(natural: Option<Size>, boxed: Size) -> Size {
    match natural {
        Some(n) if n.width > 0.0 && n.height > 0.0 => {
            let ratio = (boxed.width / n.width).min(boxed.height / n.height);
            Size {
                width: n.width * ratio,
                height: n.height * ratio,
            }
        }
        _ => boxed,
    }
}

/// How far the content may be moved from the centre, either way, on one axis, before the box shows a gap.
pub fn max_offset(content: f64, scale: f64, boxed: f64) -> f64 {
    ((content * scale - boxed) / 2.0).max(0.0)
}

/// The offset that carries the content point that was under `start` (scale `from`, at `offset`) to `now` once the
/// scale is `to`: zooming around where the fingers began, and following them as they move.
pub fn offset_after_zoom(start: f64, now: f64, offset: f64, from: f64, to: f64) -> f64 {
    if from.is_nan() || from <= 0.0 {
        return 0.0;
    }
    now - (to / from) * (start - offset)
}

/// The scale a double tap goes to: zoomed in, back to fit; fit, in.
pub fn double_tap_scale(scale: f64) -> f64 {
    if scale > ZOOMED_THRESHOLD {
        MIN_SCALE
    } else {
        DOUBLE_TAP_SCALE
    }
}

/// The view after a pinch: `start` is the view when the pinch began, `factor` how much the fingers have spread
/// since, `from` the middle of the fingers then and `now` now. The scale stays within bounds, the picture in the box.
pub fn pinch_to(
    start: View,
    factor: f64,
    from: Point,
    now: Point,
    shown: Size,
    boxed: Size,
) -> View {
    let scale = clamp(start.scale * factor, MIN_SCALE, MAX_SCALE);
    let x = offset_after_zoom(from.x, now.x, start.x, start.scale, scale);
    let y = offset_after_zoom(from.y, now.y, start.y, start.scale, scale);
    let limit_x = max_offset(shown.width, scale, boxed.width);
    let limit_y = max_offset(shown.height, scale, boxed.height);
    View {
        scale,
        x: clamp(x, -limit_x, limit_x),
        y: clamp(y, -limit_y, limit_y),
    }
}

/// The view after dragging by (dx, dy) from `start`.
pub fn pan_to(start: View, dx: f64, dy: f64, shown: Size, boxed: Size) -> View {
    let limit_x = max_offset(shown.width, start.scale, boxed.width);
    let limit_y = max_offset(shown.height, start.scale, boxed.height);
    View {
        scale: start.scale,
        x: clamp(start.x + dx, -limit_x, limit_x),
        y: clamp(start.y + dy, -limit_y, limit_y),
    }
}

/// The view a double tap at (tap_x, tap_y) goes to.
pub fn double_tap_to(current: View, tap_x: f64, tap_y: f64, shown: Size, boxed: Size) -> View {
    let scale = double_tap_scale(current.scale);
    if scale == MIN_SCALE {
        return View::FIT;
    }
    let tap = Point { x: tap_x, y: tap_y };
    pinch_to(current, scale / current.scale, tap, tap, shown, boxed)
}

// Ported from mobile/tests/downloads.test.js (the drag part) and mobile/tests/zoom.test.js.
#[cfg(test)]
mod tests {
    use super::*;

    const BOX: Size = Size {
        width: 400.0,
        height: 800.0,
    };

    fn near(a: f64, b: f64, what: &str) {
        assert!((a - b).abs() < 1e-9, "{what} {a} vs {b}");
    }

    fn slots(list: &[(&str, usize)]) -> HashMap<String, usize> {
        list.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
    }

    #[test]
    fn a_dragged_row_is_over_the_slot_its_move_reaches_never_past_the_ends() {
        assert_eq!(slot_at(2, 0.0, 60.0, 10), 2);
        assert_eq!(slot_at(2, 89.0, 60.0, 10), 3);
        assert_eq!(slot_at(2, 91.0, 60.0, 10), 4);
        assert_eq!(slot_at(2, -500.0, 60.0, 10), 0);
        assert_eq!(slot_at(2, 5000.0, 60.0, 10), 9);
    }

    #[test]
    fn the_rows_in_between_close_the_gap_a_dragged_row_leaves() {
        let start = slots(&[("a", 0), ("b", 1), ("c", 2), ("d", 3)]);
        assert_eq!(
            move_slot(&start, "a", 2),
            Some(slots(&[("a", 2), ("b", 0), ("c", 1), ("d", 3)]))
        );
        assert_eq!(
            move_slot(&start, "d", 1),
            Some(slots(&[("a", 0), ("b", 2), ("c", 3), ("d", 1)]))
        );
        assert_eq!(move_slot(&start, "b", 1), None, "no move");
        let mut moved: Vec<usize> = move_slot(&start, "c", 0).unwrap().into_values().collect();
        moved.sort_unstable();
        assert_eq!(moved, [0, 1, 2, 3], "still one row per slot");
    }

    #[test]
    fn the_list_scrolls_on_its_own_near_its_edges_faster_closer_to_them() {
        assert_eq!(default_edge_speed(400.0, 100.0, 600.0), 0.0);
        assert!(default_edge_speed(110.0, 100.0, 600.0) < 0.0);
        assert!(default_edge_speed(690.0, 100.0, 600.0) > 0.0);
        assert!(
            default_edge_speed(101.0, 100.0, 600.0).abs()
                >= default_edge_speed(150.0, 100.0, 600.0).abs()
        );
        assert_eq!(default_edge_speed(10.0, 0.0, 0.0), 0.0);
    }

    #[test]
    fn the_same_song_twice_keeps_two_keys() {
        assert_eq!(occurrence_keys(&["a", "b", "a"]), ["a#0", "b#0", "a#1"]);
    }

    #[test]
    fn a_swipe_skips_when_it_is_long_or_quick_enough() {
        assert_eq!(swipe_skip(-80.0, 0.0), Some(Skip::Next));
        assert_eq!(swipe_skip(80.0, 0.0), Some(Skip::Previous));
        assert_eq!(swipe_skip(-30.0, -900.0), Some(Skip::Next));
        assert_eq!(swipe_skip(-30.0, -100.0), None);
        assert_eq!(swipe_skip(10.0, 2000.0), None);
    }

    #[test]
    fn a_picture_is_fitted_whole_and_an_unknown_size_takes_the_box() {
        assert_eq!(
            fit_size(
                Some(Size {
                    width: 4000.0,
                    height: 3000.0
                }),
                BOX
            ),
            Size {
                width: 400.0,
                height: 300.0
            }
        );
        assert_eq!(
            fit_size(
                Some(Size {
                    width: 1000.0,
                    height: 4000.0
                }),
                BOX
            ),
            Size {
                width: 200.0,
                height: 800.0
            }
        );
        assert_eq!(fit_size(None, BOX), BOX);
        assert_eq!(
            fit_size(
                Some(Size {
                    width: 0.0,
                    height: 10.0
                }),
                BOX
            ),
            BOX
        );
    }

    #[test]
    fn the_point_under_the_fingers_stays_there_while_zooming() {
        let start = View::FIT;
        for (fx, fy, factor) in [
            (100.0, -200.0, 2.0),
            (-150.0, 300.0, 3.0),
            (0.0, 0.0, 1.7),
            (190.0, 390.0, 2.2),
        ] {
            let f = Point { x: fx, y: fy };
            let view = pinch_to(start, factor, f, f, BOX, BOX);
            near(view.x + view.scale * fx, fx, "x");
            near(view.y + view.scale * fy, fy, "y");
        }
    }

    #[test]
    fn the_picture_follows_the_fingers_as_they_move() {
        let start = View {
            scale: 2.0,
            x: 0.0,
            y: 0.0,
        };
        let view = pinch_to(
            start,
            1.5,
            Point { x: 100.0, y: 100.0 },
            Point { x: 130.0, y: 90.0 },
            BOX,
            BOX,
        );
        near(view.x + view.scale * 50.0, 130.0, "x follows");
        near(view.y + view.scale * 50.0, 90.0, "y follows");
        let drag = pinch_to(
            start,
            1.0,
            Point { x: 100.0, y: 100.0 },
            Point { x: 130.0, y: 90.0 },
            BOX,
            BOX,
        );
        assert_eq!((drag.x, drag.y), (30.0, -10.0));
    }

    #[test]
    fn the_scale_stays_between_fit_and_five_times() {
        let o = Point { x: 0.0, y: 0.0 };
        assert_eq!(pinch_to(View::FIT, 0.3, o, o, BOX, BOX).scale, 1.0);
        assert_eq!(pinch_to(View::FIT, 40.0, o, o, BOX, BOX).scale, 5.0);
        assert_eq!(
            pinch_to(
                View {
                    scale: 4.0,
                    x: 0.0,
                    y: 0.0
                },
                2.0,
                o,
                o,
                BOX,
                BOX
            )
            .scale,
            5.0
        );
        assert_eq!(
            pinch_to(
                View {
                    scale: 2.0,
                    x: 0.0,
                    y: 0.0
                },
                0.1,
                o,
                o,
                BOX,
                BOX
            )
            .scale,
            1.0
        );
    }

    #[test]
    fn the_picture_can_never_be_dragged_so_far_that_a_gap_shows() {
        let shown = Size {
            width: 400.0,
            height: 300.0,
        };
        let dragged = pan_to(
            View {
                scale: 2.0,
                x: 0.0,
                y: 0.0,
            },
            5000.0,
            -5000.0,
            shown,
            BOX,
        );
        assert_eq!((dragged.x, dragged.y), (200.0, 0.0));
        let back = pan_to(
            View {
                scale: 2.0,
                x: 200.0,
                y: 0.0,
            },
            -5000.0,
            5000.0,
            shown,
            BOX,
        );
        assert_eq!((back.x, back.y), (-200.0, 0.0));
        let small = pan_to(View::FIT, 50.0, 50.0, shown, BOX);
        assert_eq!((small.x, small.y), (0.0, 0.0));
        assert!(small.y.is_sign_positive(), "no negative zero");
    }

    #[test]
    fn zooming_out_recentres_a_picture_that_no_longer_fills_the_box() {
        let f = Point { x: 150.0, y: 250.0 };
        let zoomed = pinch_to(View::FIT, 3.0, f, f, BOX, BOX);
        assert!(zoomed.x != 0.0 || zoomed.y != 0.0);
        let out = pinch_to(zoomed, 1.0 / 3.0, f, f, BOX, BOX);
        near(out.scale, 1.0, "scale");
        near(out.x, 0.0, "x");
        near(out.y, 0.0, "y");
    }

    #[test]
    fn a_double_tap_zooms_in_on_the_spot_and_a_second_one_goes_back() {
        let zoomed = double_tap_to(View::FIT, 100.0, 200.0, BOX, BOX);
        assert_eq!(zoomed.scale, DOUBLE_TAP_SCALE);
        near(zoomed.x + zoomed.scale * 100.0, 100.0, "x under the tap");
        near(zoomed.y + zoomed.scale * 200.0, 200.0, "y under the tap");
        assert_eq!(double_tap_to(zoomed, 0.0, 0.0, BOX, BOX), View::FIT);
        assert_eq!(double_tap_scale(1.01), DOUBLE_TAP_SCALE);
        assert_eq!(double_tap_scale(1.5), 1.0);
    }

    #[test]
    fn a_double_tap_near_the_edge_keeps_the_picture_inside_the_box() {
        let shown = Size {
            width: 400.0,
            height: 300.0,
        };
        let view = double_tap_to(View::FIT, 195.0, 0.0, shown, BOX);
        assert!(view.x.abs() <= max_offset(shown.width, view.scale, BOX.width) + 1e-9);
    }

    #[test]
    fn bad_input_does_not_produce_nan() {
        assert_eq!(offset_after_zoom(10.0, 10.0, 5.0, 0.0, 2.0), 0.0);
        let o = Point { x: 0.0, y: 0.0 };
        let view = pinch_to(View::FIT, 1.0, o, o, fit_size(None, BOX), BOX);
        assert!(view.x.is_finite() && view.y.is_finite() && view.scale.is_finite());
    }
}
