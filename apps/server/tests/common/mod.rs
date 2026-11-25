//! An in-process SSH server (russh) standing in for the host: public key auth, a fake shell that echoes.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use russh::keys::{PrivateKey, PublicKey};
use russh::server::{self, Auth, Msg, Server as _, Session, VerifiedPublicKey};
use russh::{Channel, ChannelId, Pty};
use selfhost_hub_server::shell::generate_key;
use tokio::net::TcpListener;

/// What the fake host saw.
#[derive(Default, Debug)]
pub struct Seen {
    pub user: Option<String>,
    pub term: Option<String>,
    pub size: Option<(u32, u32)>,
    pub resizes: Vec<(u32, u32)>,
    pub logins: usize,
}

#[derive(Clone)]
struct Host {
    authorized: PublicKey,
    seen: Arc<Mutex<Seen>>,
}

impl server::Server for Host {
    type Handler = Self;

    fn new_client(&mut self, _: Option<SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for Host {
    type Error = russh::Error;

    async fn auth_publickey(&mut self, user: &str, key: VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
        if key.public_key.key_data() == self.authorized.key_data() {
            let mut s = self.seen.lock().unwrap();
            s.user = Some(user.to_string());
            s.logins += 1;
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        cols: u32,
        rows: u32,
        _px: u32,
        _py: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let mut s = self.seen.lock().unwrap();
        s.term = Some(term.to_string());
        s.size = Some((cols, rows));
        session.channel_success(channel)
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"READY\r\n".to_vec())
    }

    async fn window_change_request(&mut self, channel: ChannelId, cols: u32, rows: u32, _px: u32, _py: u32, session: &mut Session) -> Result<(), Self::Error> {
        self.seen.lock().unwrap().resizes.push((cols, rows));
        session.data(channel, format!("SIZE {cols}x{rows}\r\n").into_bytes())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        if data == b"exit\r" {
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            return session.close(channel);
        }
        let mut out = b"echo:".to_vec();
        out.extend_from_slice(data);
        session.data(channel, out)
    }
}

/// A host on 127.0.0.1 that lets `authorized` in. Returns its address, its host key and what it saw.
pub async fn start_ssh(authorized: &PublicKey) -> (SocketAddr, PublicKey, Arc<Mutex<Seen>>) {
    start_ssh_with_key(authorized, generate_key()).await
}

pub async fn start_ssh_with_key(authorized: &PublicKey, host_key: PrivateKey) -> (SocketAddr, PublicKey, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mut host = Host { authorized: authorized.clone(), seen: seen.clone() };
    let public = host_key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: std::time::Duration::from_millis(0),
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let running = host.run_on_socket(config, &listener);
        let _ = running.await;
    });
    (addr, public, seen)
}
