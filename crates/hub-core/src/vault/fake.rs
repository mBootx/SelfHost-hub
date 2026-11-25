//! An in-memory FileBrowser for the vault's tests: folders and files, with the answers the real one gives (404 for a
//! missing path, 409 for something that already exists), plus failure injection and a record of everything it is
//! asked. Port of `mobile/tests/vault/fake.js`.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};

use serde_json::Value;

use super::{ClientError, VaultClient, VaultItem};

pub(super) const MODIFIED: &str = "2026-09-15T10:00:00Z";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Node {
    Dir(BTreeMap<String, Node>),
    File { size: u64, modified: String },
}

impl Node {
    /// A tree written as JSON, `{ "folder": { "file.jpg": 1200 } }`: numbers are file sizes.
    pub(super) fn build(tree: &Value) -> Self {
        let mut children = BTreeMap::new();
        if let Value::Object(map) = tree {
            for (name, value) in map {
                let child = match value {
                    Value::Number(size) => Self::File {
                        size: size.as_u64().unwrap_or(0),
                        modified: MODIFIED.to_owned(),
                    },
                    other => Self::build(other),
                };
                children.insert(name.clone(), child);
            }
        }
        Self::Dir(children)
    }

    pub(super) fn size(&self) -> Option<u64> {
        match self {
            Self::File { size, .. } => Some(*size),
            Self::Dir(_) => None,
        }
    }

    fn children_mut(&mut self) -> Option<&mut BTreeMap<String, Node>> {
        match self {
            Self::Dir(children) => Some(children),
            Self::File { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Op {
    List,
    Remove,
    Rename,
    CreateFolder,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Call {
    pub op: Op,
    pub path: String,
    /// Where a rename goes.
    pub to: Option<String>,
}

pub(super) struct Fake {
    root: Mutex<Node>,
    calls: Mutex<Vec<Call>>,
    failures: Mutex<HashMap<(Op, String), u16>>,
    in_flight: AtomicUsize,
    peak: AtomicUsize,
}

fn parts(path: &str) -> Vec<&str> {
    path.split('/').filter(|part| !part.is_empty()).collect()
}

fn find<'n>(node: &'n Node, parts: &[&str]) -> Option<&'n Node> {
    let mut node = node;
    for part in parts {
        match node {
            Node::Dir(children) => node = children.get(*part)?,
            Node::File { .. } => return None,
        }
    }
    Some(node)
}

fn find_mut<'n>(node: &'n mut Node, parts: &[&str]) -> Option<&'n mut Node> {
    let mut node = node;
    for part in parts {
        node = node.children_mut()?.get_mut(*part)?;
    }
    Some(node)
}

fn error(message: &str, status: u16) -> ClientError {
    ClientError::new(status, message)
}

/// Answers "not yet" once, so calls that start together are in flight together.
struct YieldOnce(bool);

impl Future for YieldOnce {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            Poll::Ready(())
        } else {
            self.0 = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

impl Fake {
    pub(super) fn new(tree: &Value) -> Self {
        Self {
            root: Mutex::new(Node::build(tree)),
            calls: Mutex::new(Vec::new()),
            failures: Mutex::new(HashMap::new()),
            in_flight: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        }
    }

    /// Makes every `op` on exactly `path` fail with `status`.
    pub(super) fn fail(&self, op: Op, path: &str, status: u16) {
        self.failures
            .lock()
            .unwrap()
            .insert((op, path.to_owned()), status);
    }

    fn failure(&self, op: Op, path: &str) -> Option<u16> {
        self.failures
            .lock()
            .unwrap()
            .get(&(op, path.to_owned()))
            .copied()
    }

    fn record(&self, op: Op, path: &str, to: Option<&str>) {
        self.calls.lock().unwrap().push(Call {
            op,
            path: path.to_owned(),
            to: to.map(str::to_owned),
        });
    }

    pub(super) fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    pub(super) fn count(&self, op: Op) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.op == op)
            .count()
    }

    /// The most listings that were in flight at once.
    pub(super) fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }

    pub(super) fn find(&self, path: &str) -> Option<Node> {
        find(&self.root.lock().unwrap(), &parts(path)).cloned()
    }

    /// Puts `node` at `path`, replacing what is there; the parent folder must exist.
    pub(super) fn set(&self, path: &str, node: Node) {
        let parts = parts(path);
        let (name, parent) = parts.split_last().expect("a path below the root");
        let mut root = self.root.lock().unwrap();
        let parent = find_mut(&mut root, parent)
            .and_then(Node::children_mut)
            .expect("parent folder");
        parent.insert((*name).to_owned(), node);
    }

    /// Every path in the tree, as "/a/b/c.jpg" (folders end with a slash).
    pub(super) fn dump(&self) -> Vec<String> {
        fn walk(node: &Node, prefix: &str, out: &mut Vec<String>) {
            if let Node::Dir(children) = node {
                for (name, child) in children {
                    let path = format!("{prefix}/{name}");
                    let is_dir = matches!(child, Node::Dir(_));
                    out.push(if is_dir {
                        format!("{path}/")
                    } else {
                        path.clone()
                    });
                    walk(child, &path, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root.lock().unwrap(), "", &mut out);
        out
    }

    fn list_now(&self, path: &str) -> Result<Vec<VaultItem>, ClientError> {
        if let Some(status) = self.failure(Op::List, path) {
            return Err(error("list failed", status));
        }
        let root = self.root.lock().unwrap();
        match find(&root, &parts(path)) {
            None => Err(error("not found", 404)),
            Some(Node::File { .. }) => Err(error("not a folder", 400)),
            Some(Node::Dir(children)) => Ok(children
                .iter()
                .map(|(name, child)| match child {
                    Node::Dir(_) => VaultItem {
                        name: name.clone(),
                        is_dir: true,
                        ..VaultItem::default()
                    },
                    Node::File { size, modified } => VaultItem {
                        name: name.clone(),
                        size: *size,
                        modified: modified.clone(),
                        ..VaultItem::default()
                    },
                })
                .collect()),
        }
    }
}

impl VaultClient for Fake {
    async fn list(&self, path: &str) -> Result<Vec<VaultItem>, ClientError> {
        self.record(Op::List, path, None);
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        YieldOnce(false).await;
        let result = self.list_now(path);
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        result
    }

    async fn remove(&self, path: &str) -> Result<(), ClientError> {
        self.record(Op::Remove, path, None);
        if let Some(status) = self.failure(Op::Remove, path) {
            return Err(error("remove failed", status));
        }
        let parts = parts(path);
        let Some((name, parent)) = parts.split_last() else {
            return Err(error("not found", 404));
        };
        let mut root = self.root.lock().unwrap();
        let removed = find_mut(&mut root, parent)
            .and_then(Node::children_mut)
            .and_then(|children| children.remove(*name));
        match removed {
            Some(_) => Ok(()),
            None => Err(error("not found", 404)),
        }
    }

    async fn rename(&self, path: &str, new_path: &str) -> Result<(), ClientError> {
        self.record(Op::Rename, path, Some(new_path));
        if let Some(status) = self.failure(Op::Rename, path) {
            return Err(error("rename failed", status));
        }
        let (from, to) = (parts(path), parts(new_path));
        let mut root = self.root.lock().unwrap();
        if find(&root, &from).is_none() {
            return Err(error("not found", 404));
        }
        let (Some((from_name, from_parent)), Some((to_name, to_parent))) =
            (from.split_last(), to.split_last())
        else {
            return Err(error("not found", 404));
        };
        match find(&root, to_parent) {
            Some(Node::Dir(children)) if children.contains_key(*to_name) => {
                return Err(error("exists", 409));
            }
            Some(Node::Dir(_)) => {}
            _ => return Err(error("parent missing", 404)),
        }
        let source = find_mut(&mut root, from_parent)
            .and_then(Node::children_mut)
            .and_then(|children| children.remove(*from_name))
            .ok_or_else(|| error("not found", 404))?;
        if let Some(children) = find_mut(&mut root, to_parent).and_then(Node::children_mut) {
            children.insert((*to_name).to_owned(), source);
        }
        Ok(())
    }

    async fn create_folder(&self, path: &str) -> Result<(), ClientError> {
        self.record(Op::CreateFolder, path, None);
        let parts = parts(path);
        let Some((name, parent)) = parts.split_last() else {
            return Err(error("exists", 409));
        };
        let mut root = self.root.lock().unwrap();
        let Some(children) = find_mut(&mut root, parent).and_then(Node::children_mut) else {
            return Err(error("parent missing", 404));
        };
        if children.contains_key(*name) {
            return Err(error("exists", 409));
        }
        children.insert((*name).to_owned(), Node::Dir(BTreeMap::new()));
        Ok(())
    }
}
