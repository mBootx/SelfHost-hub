//! The SSH bridge against an in-process russh server.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::start_ssh;
use selfhost_hub_server::db::Db;
use selfhost_hub_server::shell::{ShellConfig, ShellError, SshShell, fingerprint, generate_key};

fn cfg(addr: std::net::SocketAddr) -> ShellConfig {
    ShellConfig { host: addr.ip().to_string(), port: addr.port(), user: "tester".into() }
}

async fn read_until(shell: &mut SshShell, needle: &str) -> String {
    let mut got = String::new();
    while !got.contains(needle) {
        let chunk = tokio::time::timeout(Duration::from_secs(10), shell.read()).await.expect("timed out").expect("shell closed early");
        got.push_str(&String::from_utf8_lossy(&chunk));
    }
    got
}

#[tokio::test]
async fn pty_input_output_resize_and_close() {
    let key = generate_key();
    let (addr, host_public, seen) = start_ssh(key.public_key()).await;
    let db = Db::open_in_memory().unwrap();
    let c = cfg(addr);
    let mut shell = SshShell::connect(&c, Arc::new(key), &db, 100, 30).await.unwrap();

    read_until(&mut shell, "READY").await;
    shell.write(b"hello").await.unwrap();
    read_until(&mut shell, "echo:hello").await;
    shell.resize(132, 43).await.unwrap();
    read_until(&mut shell, "SIZE 132x43").await;
    {
        let s = seen.lock().unwrap();
        assert_eq!(s.user.as_deref(), Some("tester"));
        assert_eq!(s.term.as_deref(), Some("xterm-256color"));
        assert_eq!(s.size, Some((100, 30)));
        assert_eq!(s.resizes, vec![(132, 43)]);
    }
    // First use pinned the host key.
    assert_eq!(db.hostkey_get(&c.target()).unwrap(), Some(fingerprint(&host_public)));

    // The host closes the shell: read() ends.
    shell.write(b"exit\r").await.unwrap();
    let end = tokio::time::timeout(Duration::from_secs(10), async {
        while shell.read().await.is_some() {}
    })
    .await;
    assert!(end.is_ok(), "the shell did not close");
    shell.close().await;
}

#[tokio::test]
async fn client_can_hang_up() {
    let key = generate_key();
    let (addr, _, _) = start_ssh(key.public_key()).await;
    let db = Db::open_in_memory().unwrap();
    let mut shell = SshShell::connect(&cfg(addr), Arc::new(key), &db, 80, 24).await.unwrap();
    read_until(&mut shell, "READY").await;
    tokio::time::timeout(Duration::from_secs(10), shell.close()).await.expect("close hangs");
}

#[tokio::test]
async fn host_key_is_pinned_and_a_mismatch_is_refused() {
    let key = generate_key();
    let (addr, host_public, seen) = start_ssh(key.public_key()).await;
    let db = Db::open_in_memory().unwrap();
    let c = cfg(addr);

    // Same key on every connection: fine.
    for _ in 0..2 {
        let mut s = SshShell::connect(&c, Arc::new(key.clone()), &db, 80, 24).await.unwrap();
        read_until(&mut s, "READY").await;
        s.close().await;
    }
    assert_eq!(seen.lock().unwrap().logins, 2);

    // The host now presents another key than the pinned one: refused before any authentication.
    db.hostkey_clear().unwrap();
    db.hostkey_pin(&c.target(), "SHA256:somebodyElse").unwrap();
    let err = SshShell::connect(&c, Arc::new(key.clone()), &db, 80, 24).await.err().expect("must refuse");
    match &err {
        ShellError::HostKeyMismatch { pinned, presented } => {
            assert_eq!(pinned, "SHA256:somebodyElse");
            assert_eq!(presented, &fingerprint(&host_public));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(err.code(), "hostkey-mismatch");
    assert!(err.to_string().contains("--reset-shell-hostkey"));
    assert_eq!(seen.lock().unwrap().logins, 2, "no login was attempted");
    assert_eq!(db.hostkey_get(&c.target()).unwrap().as_deref(), Some("SHA256:somebodyElse"), "the pin is not overwritten");

    // After the reset the new key is pinned and works.
    db.hostkey_clear().unwrap();
    let mut s = SshShell::connect(&c, Arc::new(key), &db, 80, 24).await.unwrap();
    read_until(&mut s, "READY").await;
    s.close().await;
    assert_eq!(db.hostkey_get(&c.target()).unwrap(), Some(fingerprint(&host_public)));
}

#[tokio::test]
async fn an_unauthorized_key_is_refused() {
    let authorized = generate_key();
    let (addr, _, _) = start_ssh(authorized.public_key()).await;
    let db = Db::open_in_memory().unwrap();
    let err = SshShell::connect(&cfg(addr), Arc::new(generate_key()), &db, 80, 24).await.err().expect("must refuse");
    assert_eq!(err, ShellError::AuthFailed);
}

#[tokio::test]
async fn an_unreachable_host_is_reported() {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    let db = Db::open_in_memory().unwrap();
    let err = SshShell::connect(&cfg(addr), Arc::new(generate_key()), &db, 80, 24).await.err().expect("must fail");
    assert_eq!(err.code(), "ssh-unreachable", "{err:?}");
}
