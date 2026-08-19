# Camera Stream Agent (Windows / macOS)

Service agent that publishes IP cameras (RTSP) to Agora real-time channels with FFmpeg.
It pulls its configuration from the
[Camera Stream Backend](../backend), supervises one FFmpeg process per camera, auto-recovers
from failures with exponential backoff, captures periodic screenshots, and reports live
status via heartbeats.

Built with **Node.js + TypeScript + FFmpeg** and installed as a native OS service through a
platform abstraction (`src/platform/`): `WindowsPlatformService` (node-windows / Windows SCM)
or `MacOSPlatformService` (launchd / launchctl). The core agent is platform-independent —
it only ever depends on the `PlatformService` interface.

## Platform abstraction

All OS-specific behaviour is isolated behind `PlatformService` (`src/platform/types.ts`):

- **Service lifecycle** — install / uninstall / start / stop / restart / status
  (Windows: SCM via node-windows; macOS: LaunchDaemon via `launchctl`).
- **FFmpeg binary** — `FFMPEG_PATH` env var wins, then an OS-appropriate default; core
  code never hardcodes a binary name.
- **Process termination** — Windows force-kills the whole tree (`taskkill /T /F`);
  macOS uses a plain SIGKILL. `CameraProcessManager` and `ScreenshotService` accept a
  `killProcess` hook injected from the platform layer.
- **Paths** — `path.join()` everywhere; log and working directories come from the platform
  implementation (`logDir`, `rootDir`).

`createPlatformService(process.platform, …)` (`src/platform/index.ts`) picks the right
implementation and throws on unsupported platforms, so the same build runs on Windows and
macOS. The service CLI (`scripts/service.ts`) is a thin, platform-agnostic wrapper around
this factory.

## What it does

- **Config-driven**: polls `GET /api/camera-agent/config` every `CONFIG_REFRESH_SECONDS`.
  Cameras added/updated/removed on the backend are started, restarted, or stopped
  automatically (restart only touches the affected camera's process). Set `STREAM_URL`
  (and `RTMP_PUBLISH_URL`) in `.env` to skip that API and stream a single local camera.
  `npm run pull-local-config` fills those URLs plus a 7-day Agora viewer token from the
  backend in one shot.
- **Streams with FFmpeg**: reads the RTSP camera and publishes to
  `rtmp://…/live/<streamKey>` on the Agora ingest gateway. `transcodeEnabled` cameras get
  a libx264 re-encode; otherwise the stream is copied (`-c copy`) straight through.
  RTSP connection is protected by `-rtsp_transport tcp` and a connect timeout.
- **Self-healing**: if FFmpeg exits or the stream stalls, the process is restarted with
  exponential backoff (`RESTART_BASE_DELAY_SECONDS` → `RESTART_MAX_DELAY_SECONDS`, reset
  after `HEALTHY_RESET_SECONDS` of clean running). Stall detection uses FFmpeg's
  `-progress pipe:1` output — if no progress for `FFMPEG_HEALTH_TIMEOUT_SECONDS`, the
  process is killed and restarted.
- **Screenshots**: a lightweight FFmpeg capture process (`-vf fps=1 -update 1`) grabs one
  JPEG per camera and overwrites the same local file — only the **latest** frame is kept,
  never a video-rate stream. An upload loop POSTs the newest frame to the backend at
  `SCREENSHOT_INTERVAL_SECONDS` (uploads are skipped when the frame is unchanged, and a
  dead capture process is restarted on the next cycle).
- **Heartbeats**: reports per-camera status (`STARTING` / `STREAMING` / `STOPPED`),
  restart counts, and the last error so the backend marks agents offline when they vanish.
- **Graceful shutdown**: FFmpeg is told to quit via stdin (`q`), force-killed after
  `FFMPEG_KILL_TIMEOUT_MS`.

## Prerequisites

- Windows 10/11 or macOS 12+ (any OS works for development/testing)
- Node.js 20+ (developed on 24)
- [FFmpeg](https://ffmpeg.org/download.html) on `PATH` (or set `FFMPEG_PATH`)
- A provisioned agent + camera in the backend (see backend README, "Onboarding a camera + agent")

## Quick start (development)

```bash
npm install
cp .env.example .env        # set BACKEND_URL and AGENT_API_KEY
npm run dev                 # tsx src/index.ts
```

The agent logs to stdout/stderr in development. In production it runs as a native OS
service (see below) and writes to log files.

## Local stream + Agora viewer (no backend after snapshot)

Use this to confirm the camera is publishing to Agora without polling the backend.

1. Backend running; agent created; at least one camera assigned with a stream key.
2. Set `BACKEND_URL` and `AGENT_API_KEY` in `.env`.
3. `npm run pull-local-config` — writes `STREAM_URL`, `RTMP_PUBLISH_URL`, `AGORA_APP_ID`,
   `AGORA_CHANNEL`, `AGORA_RTC_TOKEN`, and `AGORA_RTC_TOKEN_EXPIRES_AT` (about 7 days).
4. `npm run dev` — agent streams RTSP to Agora and does not call `GET /api/camera-agent/config`.
5. `npm run viewer` — open `http://127.0.0.1:3456` (loopback only). The page joins Agora
   with the cached subscriber token; it does not call the camera backend. The Agora Web SDK
   is served from the local `agora-rtc-sdk-ng` install (`/agora-rtc-sdk.js`), so no CDN is
   needed — run `npm install` if the page reports the SDK did not load.
6. Before the token or stream key expires, run `pull-local-config` again (backend must be up).

The Agora App Certificate never leaves the backend and is not stored on the agent.

## Setup on a fresh Windows machine

All commands run in **PowerShell**. Steps 1–2 install software; step 3 onward deploys and
runs the agent.

1. **Install Node.js** (winget):
   ```powershell
   winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
   ```
   Reopen PowerShell so `node`/`npm` are on `PATH`, then verify:
   ```powershell
   node --version
   npm --version
   ```

2. **Install FFmpeg** (winget):
   ```powershell
   winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
   ```
   Reopen PowerShell and verify:
   ```powershell
   ffmpeg -version
   ```

3. **Copy the `windows-camera-agent` folder onto the machine** and install dependencies:
   ```powershell
   cd C:\path\to\windows-camera-agent
   npm ci
   ```

4. **Configure**:
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
   Set at minimum `BACKEND_URL` and `AGENT_API_KEY` (returned once when the agent is created
   in the backend). Optionally set `FFMPEG_PATH` if FFmpeg is not on `PATH`.

5. **Run for testing (foreground, no service)**:
   ```powershell
   npm run dev
   ```
   Watch for `agent is running` and per-camera `STREAMING` logs. Press `Ctrl+C` to stop.

6. **Run as a Windows service (production)** — open an **elevated PowerShell** (Run as
   administrator), then:
   ```powershell
   cd C:\path\to\windows-camera-agent
   npm run build
   npm run service:install
   npm run service:status   # verify it reports "running"
   ```
   The service auto-starts on boot, auto-restarts on crash (`maxRetries: 5`, grow 1.5),
   and writes logs to `logs\`. To stop or remove:
   ```powershell
   npm run service:stop
   npm run service:uninstall
   ```

## Setup on a fresh macOS machine

All commands run in **Terminal** (steps 3–5 may prompt for sudo). Steps 1–2 install
software; step 3 onward deploys and runs the agent.

1. **Install Node.js** (Homebrew) — if you don't have Homebrew, install it from
   https://brew.sh first:
   ```bash
   brew install node
   node --version
   npm --version
   ```

2. **Install FFmpeg**:
   ```bash
   brew install ffmpeg
   ffmpeg -version
   ```

3. **Copy the `windows-camera-agent` folder onto the machine** and install dependencies:
   ```bash
   cd /path/to/windows-camera-agent
   npm ci
   ```

4. **Configure**:
   ```bash
   cp .env.example .env
   nano .env
   ```
   Set at minimum `BACKEND_URL` and `AGENT_API_KEY` (returned once when the agent is created
   in the backend). Optionally set `FFMPEG_PATH` if FFmpeg is not on `PATH`.

5. **Run for testing (foreground, no service)**:
   ```bash
   npm run dev
   ```
   Watch for `agent is running` and per-camera `STREAMING` logs. Press `Ctrl+C` to stop.

6. **Run as a macOS service (production)** — the script elevates itself with sudo when
   needed:
   ```bash
   cd /path/to/windows-camera-agent
   npm run build
   npm run service:install
   npm run service:status   # verify it reports the service is loaded
   ```
   The LaunchDaemon auto-starts on boot and auto-restarts on crash (`KeepAlive`), with logs
   in `logs/`. To stop or remove:
   ```bash
   npm run service:stop
   npm run service:uninstall
   ```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `production` | `development`/`test` relaxes validation for local runs |
| `LOG_LEVEL` | `info` | pino log level |
| `BACKEND_URL` | `http://localhost:3000` | Backend base URL |
| `AGENT_ID` | — | Optional explicit agent id (normally derived from the API key lookup) |
| `AGENT_API_KEY` | — | **Required unless `STREAM_URL` is set.** Returned once when the agent is created in the backend |
| `STREAM_URL` | — | Optional camera RTSP URL. When set, the agent does **not** call `GET /api/camera-agent/config` |
| `RTMP_PUBLISH_URL` | — | Required when `STREAM_URL` is set. Agora RTMP ingest URL (`rtmp://…/live/<streamKey>`) |
| `AGORA_APP_ID` | — | Written by `pull-local-config`. Public App ID for the local viewer |
| `AGORA_CHANNEL` | — | Written by `pull-local-config`. Agora channel bound to the stream key |
| `AGORA_RTC_TOKEN` / `AGORA_RTC_TOKEN_EXPIRES_AT` | — | Written by `pull-local-config`. 7-day subscriber token for `npm run viewer` |
| `AGORA_VIEWER_PORT` | `3456` | Local viewer HTTP port (`127.0.0.1` only) |
| `FFMPEG_PATH` | `ffmpeg` | Path to the FFmpeg binary |
| `HEARTBEAT_INTERVAL_SECONDS` | `15` | Heartbeat cadence (min 5) |
| `CONFIG_REFRESH_SECONDS` | `30` | Config poll cadence (min 5) |
| `SCREENSHOT_INTERVAL_SECONDS` | `1` | Screenshot capture/upload cadence |
| `SCREENSHOT_DIR` | `./data/screenshots` | Local screenshot cache |
| `RESTART_BASE_DELAY_SECONDS` | `5` | First restart backoff |
| `RESTART_MAX_DELAY_SECONDS` | `60` | Backoff ceiling |
| `HEALTHY_RESET_SECONDS` | `300` | Backoff resets after this long without failure |
| `FFMPEG_HEALTH_TIMEOUT_SECONDS` | `45` | Max silence from FFmpeg progress before kill+restart |
| `FFMPEG_KILL_TIMEOUT_MS` | `10000` | Grace period between `q` and `SIGKILL` |
| `FFMPEG_START_TIMEOUT_MS` | `60000` | Max time allowed to reach `STREAMING` |
| `REQUEST_TIMEOUT_MS` | `15000` | HTTP timeout to the backend |
| `HTTP_RETRY_BASE_MS` / `HTTP_RETRY_MAX_MS` | `1000` / `30000` | Backend HTTP retry/backoff |
| `RTSP_TIMEOUT_MICROS` | `15000000` | FFmpeg `-timeout` for the RTSP connection |
| `FFMPEG_PROBESIZE` / `FFMPEG_ANALYZEDURATION` | `1000000` | FFmpeg input probing limits |

## Run as a production service

One command set works on both platforms (`scripts/service.ts` dispatches on the OS):

```bash
npm run build                  # compile to dist/ (required once per deploy)
npm run service:install        # register + start (Windows: elevated shell; macOS: sudo)
npm run service:status
npm run service:start
npm run service:stop
npm run service:restart
npm run service:uninstall
```

Both services start automatically on machine boot and restart the agent if it crashes.
Development mode (`npm run dev`) stays available at any time — the service and a dev run
can coexist, though not both at once (ports/FFmpeg are per-camera so both would stream).

### Windows (node-windows → Windows SCM)

- Service name: **`CameraStreamAgent`** (auto-start, `startMode: automatic`).
- Crash recovery: SCM restart with `maxRetries: 5`, `wait: 5s`, growth factor 1.5.
- Logs: `logs\` next to the agent folder (`out.log` / `err.log` per service run).
- Install/uninstall require an **elevated PowerShell** (Run as administrator).

### macOS (launchd LaunchDaemon)

- Label: **`com.camerastream.agent`**; plist at `/Library/LaunchDaemons/com.camerastream.agent.plist`.
- Runs `node dist/index.js` with the working directory set to the agent folder, so `.env`
  resolves the same way as in development.
- Crash recovery: `KeepAlive` (launchd relaunches it, throttled to once per 10s).
- Logs: `logs/camera-stream-agent.out.log` and `logs/camera-stream-agent.err.log` inside
  the agent folder.
- The Node binary path is resolved at install time (`which node`) and baked into the plist —
  if you move/remove Node afterwards, reinstall the service.
- Install/uninstall/start/stop/restart require root; the script re-invokes itself with sudo.

## Troubleshooting

### Service status

```powershell
# Windows — is the service installed/running?
npm run service:status
Get-Service CameraStreamAgent | Format-List Status,Name,StartType
sc.exe query CameraStreamAgent

# Windows — failure recovery configuration
sc.exe qfailure CameraStreamAgent
```

```bash
# macOS — is the LaunchDaemon loaded?
npm run service:status
launchctl print system/com.camerastream.agent | head -40

# macOS — loaded jobs matching the agent
launchctl list | grep camerastream
```

### Logs

```powershell
# Windows — node-windows service logs live in logs\ (agent folder)
Get-Content C:\path\to\windows-camera-agent\logs\out.log -Tail 100
Get-Content C:\path\to\windows-camera-agent\logs\err.log -Tail 100
```

```bash
# macOS — LaunchDaemon stdout/stderr files
tail -n 100 /path/to/windows-camera-agent/logs/camera-stream-agent.out.log
tail -n 100 /path/to/windows-camera-agent/logs/camera-stream-agent.err.log

# macOS — unified system log for the agent process
log show --last 1h --predicate 'process == "node"' --style compact
```

Set `LOG_LEVEL=debug` in `.env` and restart the service to see per-camera FFmpeg args.

### FFmpeg processes

```powershell
# Windows — one ffmpeg per camera + one screenshot capture per camera
Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" |
  Select-Object ProcessId, CommandLine | Format-List
tasklist | findstr ffmpeg
```

```bash
# macOS
ps aux | grep -i ffmpeg | grep -v grep
pgrep -fl ffmpeg
```

A stopped camera shows no streaming FFmpeg; an active one has a process whose command line
contains `-f flv rtmp://…/live/<streamKey>`.

### Stopping / restarting the service

```powershell
# Windows (elevated)
npm run service:stop        # or: Stop-Service CameraStreamAgent
npm run service:restart     # or: Restart-Service CameraStreamAgent
```

```bash
# macOS
npm run service:stop        # boots the job out (KeepAlive will NOT relaunch it)
npm run service:start       # re-bootstraps it
npm run service:restart     # kickstart -k: kill + relaunch in place
```

If the agent appears stuck, stop the service, verify no FFmpeg processes remain, then start
it again.

## How a camera flows through the agent

1. **Config refresh** → `ConfigService` downloads the config and diffs it against the
   previous snapshot (signature includes camera settings *and* the stream key).
2. **Apply diff** → `Orchestrator` starts new cameras, stops removed ones (which also stops
   their screenshot capture), and restarts changed ones.
3. **Process supervision** → `CameraProcessManager` spawns FFmpeg, parses its progress,
   watches for stalls, and re-schedules restarts with backoff. Each camera is independent.
4. **Screenshots** → `ScreenshotService` runs one `-vf fps=1 -update 1` FFmpeg per camera
   and uploads each JPEG; uploads are queued so a slow backend never blocks capture.
5. **Heartbeat** → `HeartbeatService` posts per-camera state and restart counts.

On startup, if the backend is unreachable the agent retries with backoff and stays up until
it can fetch its first config.

## Reliability & 24x7 operation

| Concern | Behaviour |
| --- | --- |
| FFmpeg crash | Every camera is supervised by `CameraProcessManager`; an exit always schedules a restart (backoff). |
| Exponential backoff | `RESTART_BASE_DELAY_SECONDS` → doubled per attempt → `RESTART_MAX_DELAY_SECONDS`; resets after `HEALTHY_RESET_SECONDS` of clean streaming. |
| RTSP / RTMP reconnect | Connection loss makes FFmpeg exit (or the start/stall check kills it) and the backoff loop relaunches it from scratch. |
| Backend outage | `fetchConfig`/heartbeat/screenshot HTTP calls retry with exponential backoff (`HTTP_RETRY_*`, 5 attempts, 4xx never retried). A failed config refresh keeps the current config — **healthy FFmpeg processes are never killed**. |
| Heartbeat | Posted every `HEARTBEAT_INTERVAL_SECONDS` with per-camera `status`/`pid`/`restartCount`; the backend marks agents offline when they go silent. |
| Config refresh | Polled every `CONFIG_REFRESH_SECONDS`; diffs are applied by the orchestrator. |
| Stream-key refresh | The backend renewal job rotates keys before expiry and bumps `configVersion`; the signature change restarts **only** that camera. |
| Restart isolation | A died/changed/removed camera affects only its own process; other cameras keep streaming untouched. |
| Graceful shutdown | `SIGINT`/`SIGTERM` stop screenshots, then send `q` to each FFmpeg stdin (clean FLV flush), SIGKILL after `FFMPEG_KILL_TIMEOUT_MS`. |
| Windows reboot | The service installs with `startMode: automatic` and SCM failure recovery (`maxRetries: 5`, grow 1.5) — it comes back on boot and survives crashes. |
| macOS reboot | The LaunchDaemon (`/Library/LaunchDaemons`) starts at boot via `RunAtLoad`, before any user logs in; `KeepAlive` relaunches it on crash. |

## Security notes

- The API key authenticates every request; it is never logged.
- RTSP credentials and stream keys are only stored in memory — the agent does not persist
  secrets to disk. Use the backend's `SCREENSHOT_DIR` / log paths on an encrypted volume.
- FFmpeg is always launched with an argument array (no shell interpolation), and RTMP/RTSP
  secrets are masked in logs.

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run (100 tests: ffmpeg args, backoff, log parsing, config diff, orchestrator, HTTP retry, heartbeat, process manager restart scenarios, screenshots, platform services, local viewer snapshot)
```

Tests run against a fake FFmpeg child process and a stub HTTP backend — no FFmpeg or
network needed.

## Troubleshooting: runtime issues

- **`spawn ffmpeg ENOENT`** → `FFMPEG_PATH` is wrong or FFmpeg isn't installed.
- **`config refresh cycle failed`** → check `BACKEND_URL`, `AGENT_API_KEY`, and backend
  availability (`curl -s http://<host>:3000/health`).
- **Camera stuck `STARTING` then `STOPPED`, restartCount climbing** → the RTSP source is
  unreachable or the stream key expired; check the camera's `lastError` in the heartbeat
  or run FFmpeg manually with the exact args from the log at `debug` level.
- **Stream not visible to viewers** → confirm `AGORA_REGION` matches your project, the
  stream key was created (`POST /api/cameras/:id/rotate-stream-key`), and that the RTMP URL
  in the config uses the same gateway region.