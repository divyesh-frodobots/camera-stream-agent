# Camera Stream Agent (Windows)

This program runs on a **Windows PC** next to your IP cameras. It takes each camera’s live feed and sends it to Agora so people can watch it in a browser.

You do **not** need to edit secret files, talk to a server, or know programming.

You **do** need:

- This folder (`windows-camera-agent`) on the PC
- The camera addresses (RTSP URLs) from your cameras
- The Agora publish links (RTMP URLs) that the event admin sent you

---

## What you will do

1. Install two programs on Windows (Node.js and FFmpeg) — once.
2. Start this agent.
3. Open a page on **this same PC**: http://127.0.0.1:3456
4. Paste each camera’s RTSP URL and the matching RTMP URL, then click **Save** and **Start**.

That page only works on this PC. Other people cannot open it from the internet.

You do **not** enter an App ID, channel name, or token. The agent publishes to channel `offroad_cam_1` unless the event admin asked you to change `AGORA_CHANNEL` in `.env`.

---

## What the event admin sends you

Keep these private. Do not put them in email screenshots or share them widely.

| Item | What it looks like | Where you paste it |
| --- | --- | --- |
| Camera RTSP URL | `rtsp://192.168.…:554/…` | Control page, **RTSP URL** |
| Agora RTMP URL | `rtmp://rtls-ingress-….agoramdn.com/live/…` | Control page, **RTMP URL** |

Use **one RTMP URL per camera**. Camera 1 and Camera 2 must not share the same RTMP link.

You should **never** receive an “App Certificate” or “Customer Secret”. If someone sends those, do not put them on this PC.

---

## One-time setup on Windows

Use **PowerShell**. Click Start, type `PowerShell`, open **Windows PowerShell**.

### 1. Install Node.js

```powershell
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
```

Close PowerShell and open a **new** window, then check:

```powershell
node -v
npm -v
```

You should see version numbers (Node should be 20 or higher).

### 2. Install FFmpeg

```powershell
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
```

Close PowerShell and open a **new** window, then check:

```powershell
ffmpeg -version
```

You should see FFmpeg version text. If Windows says it cannot find `ffmpeg`, log out and log in (or reboot) and try again.

### 3. Put this folder on the PC

Copy the whole `windows-camera-agent` folder, for example to:

`C:\camera-agent\windows-camera-agent`

In PowerShell:

```powershell
cd C:\camera-agent\windows-camera-agent
npm install
```

Wait until it finishes with no red errors.

You do **not** need a `.env` file for normal camera publishing.

---

## Start the agent (every time, unless you install the service)

In PowerShell:

```powershell
cd C:\camera-agent\windows-camera-agent
npm run dev
```

Leave this window **open**. Do not close it while cameras should stay live.

In your browser on the **same PC**, open:

**http://127.0.0.1:3456**

If the page does not load, the agent is not running, or something else is using port 3456. Stop the other program or tell the admin.

To stop the agent later, click the PowerShell window and press **Ctrl+C**.

---

## Add cameras on the control page

You can run **1 to 6** cameras.

For each camera you want live:

1. Type a name (optional), for example `Front`.
2. Paste the **RTSP URL** (the camera).
3. Paste the **RTMP URL** (the Agora link from the admin).
4. Click **Save configuration**.
5. Click **Start** on that row, or **Start all**.

What the status means:

| Status | Meaning |
| --- | --- |
| Not configured | RTSP or RTMP is still empty |
| Stopped | Saved, but not sending |
| Starting | Connecting |
| Live | Sending to Agora |
| Reconnecting / Error | Camera or network problem — click **Restart** |

**Start** / **Stop** / **Restart** affect only that camera. The others keep running.

After you save once, the PC remembers the URLs in `data\cameras.json`. Next time you start the agent, cameras that were left **enabled** start by themselves.

If a camera shows **Live** but the stream still looks old or frozen: click **Restart** on that row.

---

## Keep it running overnight (Windows service)

Use this when the PC should keep streaming after you log off or after a reboot.

1. Start menu → type `PowerShell` → right-click **Windows PowerShell** → **Run as administrator**
2. Run:

```powershell
cd C:\camera-agent\windows-camera-agent
npm run build
npm run service:install
```

The Windows service name is `CameraStreamAgent`. It starts when Windows boots.

Useful commands (still in an Administrator PowerShell, from the agent folder):

```powershell
npm run service:status
npm run service:stop
npm run service:start
npm run service:restart
npm run service:uninstall
```

Do **not** run `npm run dev` at the same time as the service. Use one or the other.

Logs are in the `logs` folder inside `windows-camera-agent`.

---

## If something goes wrong

**The web page will not open**

- Confirm PowerShell is still running `npm run dev`, or the service is running
- Confirm you opened http://127.0.0.1:3456 on **this** PC, not a phone

**Status stays Starting, then Error**

- Camera and PC must be on the same network
- On this PC, try opening the camera’s web page (many cameras use `http://192.168.…`)
- Check the RTSP URL (user, password, IP, port)
- Keep a phone-as-camera app on screen with the screen awake

**Status is Live but the stream is missing or minutes late**

- Click **Restart** on that camera
- Confirm you used that camera’s own RTMP URL (not another camera’s)

**“ffmpeg” not found**

- FFmpeg is not installed, or PowerShell was not reopened after install
- Run `ffmpeg -version` in a new PowerShell

**Two copies fighting**

- Only one of: `npm run dev` **or** the Windows service
- Only one RTMP URL per camera

---

## For developers

This same folder can still talk to the camera backend (`BACKEND_URL` + `AGENT_API_KEY`) or use a one-camera `.env` (`STREAM_URL` + `RTMP_PUBLISH_URL`). If `data\cameras.json` exists, **file mode wins**: the Windows UI is used and the backend is not called.

```powershell
npm run typecheck
npm test
```

Optional encode settings (only if you ship a `.env`): `LOCAL_VIDEO_WIDTH`, `LOCAL_VIDEO_HEIGHT`, `LOCAL_VIDEO_FPS`, `LOCAL_VIDEO_BITRATE_KBPS`, `LOCAL_VIDEO_TRANSCODE`, `LOCAL_AUDIO_ENABLED`. Channel defaults to `offroad_cam_1`; override with `AGORA_CHANNEL`. See `.env.example`.

Service internals, macOS install, and the full environment table live in git history and `.env.example`. Event operators do not need them.
