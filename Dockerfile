# syntax=docker/dockerfile:1
# SelfHost Hub server. Build from the repo root:  docker build -t selfhost-hub-server .

FROM rust:1-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# The workspace lists apps/desktop too, so every member manifest must be present; only the server is built.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps ./apps
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release -p selfhost-hub-server --locked \
    && cp target/release/selfhost-hub-server /selfhost-hub-server \
    && mkdir /data-skel

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /selfhost-hub-server /selfhost-hub-server
# An empty /data owned by the runtime user (uid 65532), so a fresh named volume is writable.
COPY --from=builder --chown=65532:65532 /data-skel /data
ENV DATA_DIR=/data PORT=51823
EXPOSE 51823
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/selfhost-hub-server", "--healthcheck"]
ENTRYPOINT ["/selfhost-hub-server"]
