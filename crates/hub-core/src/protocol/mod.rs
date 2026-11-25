//! Wire formats shared with the apps that are not yet ported. Each one must stay byte-compatible with its
//! TypeScript or Kotlin original until both ends are Rust.

pub mod downtify;
pub mod link;
pub mod setup;
pub mod update;

use serde_json::{Map, Value};

/// Lenient readers for JSON that arrives from another device: nothing in it is trusted to be well formed.
/// They follow Gson's `JsonPrimitive` conversions, which the Kotlin watch app uses, so both read a message alike.
pub(crate) trait Lenient {
    /// A string, or a number or boolean in its text form; `None` for null, arrays, objects and missing fields.
    fn string(&self, name: &str) -> Option<String>;
    /// An integer, from a number (truncated) or a string holding one.
    fn int(&self, name: &str) -> Option<i64>;
    /// A real JSON boolean, otherwise `default`.
    fn bool_or(&self, name: &str, default: bool) -> bool;
    /// A finite number, from a number or a string holding one, otherwise `default`.
    fn f64_or(&self, name: &str, default: f64) -> f64;
}

impl Lenient for Map<String, Value> {
    fn string(&self, name: &str) -> Option<String> {
        match self.get(name)? {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }

    fn int(&self, name: &str) -> Option<i64> {
        match self.get(name)? {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.trunc() as i64)),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    fn bool_or(&self, name: &str, default: bool) -> bool {
        match self.get(name) {
            Some(Value::Bool(b)) => *b,
            _ => default,
        }
    }

    fn f64_or(&self, name: &str, default: f64) -> f64 {
        let value = match self.get(name) {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => s.trim().parse().ok(),
            _ => None,
        };
        value.filter(|v| v.is_finite()).unwrap_or(default)
    }
}
