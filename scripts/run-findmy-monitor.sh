#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/nanoclaw"
GROUP="telegram_main"
GROUP_DIR="$ROOT/groups/$GROUP"
IPC_DIR="$ROOT/data/ipc/$GROUP"
CONTAINER_NAME="nanoclaw-findmy-monitor"
IMAGE="nanoclaw-agent:latest"

mkdir -p "$GROUP_DIR" "$IPC_DIR/messages" "$IPC_DIR/input" "$IPC_DIR/tasks"
mkdir -p "$GROUP_DIR/agent-browser-profile"
chmod 0777 "$GROUP_DIR" "$GROUP_DIR/agent-browser-profile" "$IPC_DIR" "$IPC_DIR/messages" "$IPC_DIR/input" "$IPC_DIR/tasks"
rm -f "$GROUP_DIR/agent-browser-profile/SingletonLock" "$GROUP_DIR/agent-browser-profile/SingletonCookie" "$GROUP_DIR/agent-browser-profile/SingletonSocket"

exec docker run \
  --name "$CONTAINER_NAME" \
  --rm \
  -e TZ="Europe/Madrid" \
  -e AGENT_BROWSER_PROFILE="/workspace/group/agent-browser-profile" \
  -e AGENT_BROWSER_SESSION="findmy-monitor" \
  -v "$GROUP_DIR:/workspace/group" \
  -v "$IPC_DIR:/workspace/ipc" \
  --entrypoint node \
  "$IMAGE" \
  /workspace/group/findmy-monitor.mjs
