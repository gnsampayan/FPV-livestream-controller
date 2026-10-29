# FPV Video Streaming System

Low-latency FPV video streaming from Raspberry Pi to browser with WebRTC, plus real-time RC car control (browser WebSocket to a relay, then authenticated UDP to the Pi). The Pi side is tuned for the Raspberry Pi 3 B v1.2: hardware H.264 encoding, dedicated CPU cores, and a shaped uplink.

## Architecture

```
┌───────────────────────────────┐     ┌──────────────────────────────┐     ┌──────────────┐
│        Raspberry Pi 3         │     │         Home Server          │     │   Browser    │
│          (On the Car)         │     │          (Ubuntu)            │     │              │
├───────────────────────────────┤     ├──────────────────────────────┤     ├──────────────┤
│                               │ RTP │ ┌──────────────────────────┐ │WebRTC│ ┌──────────┐│
│  ┌──────────┐                 │─────►│   Janus WebRTC Gateway   │─┼────►│ │  Video   ││
│  │  Camera  │                 │ UDP │ │                          │ │     │ │  Player  ││
│  │  OV5647  │─► HW H.264 ─────│:5004│ └──────────────────────────┘ │     │ └──────────┘│
│  └──────────┘                 │     │                              │     │             │
│                               │ UDP │ ┌──────────────────────────┐ │ WS  │ ┌──────────┐│
│  ┌──────────┐   USB-CDC       │◄───►│ │  Control Relay (Node.js) │◄┼────►│ │  USB     ││
│  │ control  │◄─ 10-byte ──► [Nano]──┼─┤                          │ │     │ │ Gamepad  ││
│  │ _daemon  │  500kbaud       │     │ └──────────────────────────┘ │     │ └──────────┘│
│  └──────────┘                 │     │                              │     │             │
│                ┌─── PWM ─────►│ Throttle / Steering / Cam yaw / Cam pitch                │
│                                │   │ ┌──────────────────────────┐ │HTTPS│              │
│     EIOTCLUB 4G LTE (usb0)    │     │ │  Nginx reverse proxy     │─┼────►│              │
│                               │     │ └──────────────────────────┘ │     │              │
└───────────────────────────────┘     └──────────────────────────────┘     └──────────────┘
        ▲                                        ▲
        │                                        │
        └─────────── Tailscale VPN ──────────────┘
                     (over LTE or WiFi)
```

All microsecond-accurate PWM timing runs on the Arduino Nano. The Pi only
shuttles binary control frames over USB serial and streams video.

## Features

- **Low-Latency Video**: WebRTC streaming via Janus Gateway. The Pi's
  VideoCore IV hardware encoder does the H.264 work, so the CPU cores stay free.
  Measure your own glass-to-glass number with the procedure in
  [`DEPLOYMENT.md`](DEPLOYMENT.md#measuring-latency).
- **Real-Time Control**: 50 Hz control. Browser to relay over WebSocket, relay to
  Pi over HMAC-authenticated UDP (no TCP head-of-line blocking), written to the
  Arduino the moment each datagram arrives
- **Safety Features**: 250ms deadman timeout, auto-stop on tab blur
- **4G/LTE Support**: Works over cellular via Tailscale VPN (CGNAT-friendly)
- **Modern UI**: React-based control center with virtual joysticks and telemetry

## Prerequisites

### Home Server
- Ubuntu 20.04+ or Debian 11+
- Docker and Docker Compose
- Node.js 18+ (for development)
- Public IP or ability to port forward (ports 80/443)

### Raspberry Pi
- Raspberry Pi 3 B v1.2 (the target board; 3B+ and Pi 4 also work)
- Pi Camera Module v1 (OV5647) or v2
- Raspberry Pi OS Bullseye or Bookworm (Bookworm recommended: `rpicam-apps`)
- Arduino Nano (ATmega328P) attached via USB for PWM generation
- EIOTCLUB 4G LTE USB WiFi 6 Dongle (HiLink/RNDIS) or home WiFi
- Four standard hobby servos / ESC, powered by a **separate** BEC (not the Pi 5V rail)

## Quick Start

### 1. Set Up Tailscale (Recommended)

Tailscale creates a secure mesh VPN between your Pi and server, working through CGNAT:

**On both Home Server and Raspberry Pi:**

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Authenticate (follow the URL to log in)
sudo tailscale up

# Get your Tailscale IP
tailscale ip -4
# Example output: 100.64.0.1
```

Note your Tailscale IPs:
- Server: `100.x.x.x` (SERVER_TAILSCALE_IP)
- Pi: `100.y.y.y` (PI_TAILSCALE_IP)

### 2. Deploy Home Server

```bash
# Clone/copy the project to your server
cd server

# Create environment file
cp .env.example .env
# Edit .env and set CONTROL_AUTH_TOKEN (the host-side name; compose maps it
# into the control-relay container as AUTH_TOKEN), plus SERVER_DOMAIN and
# LETSENCRYPT_EMAIL if you plan to enable HTTPS.

# Build and start services (builds the relay, audiobridge sidecar and the
# nginx image that contains the web app)
docker compose up -d --build

# Check status
docker compose ps
docker compose logs -f
```

The server will be available at `http://localhost` (or your server IP).

In production, pushes to `main` build these images in GitHub Actions and
deploy them automatically; see [CI/CD](DEPLOYMENT.md#cicd-automatic-deploys-to-the-server).

### 3. Web Frontend (development)

The production web build is baked into the nginx image (see
[`server/nginx/Dockerfile`](server/nginx/Dockerfile)), so you only need Node
locally for development:

```bash
cd web

# Install dependencies
npm install

# Development server with hot reload
npm run dev

# Type-check and production build (output in web/dist/, used only for checks)
npm run build
```

### 4. Flash the Arduino Nano

Upload [`arduino/rc-controller/rc-controller.ino`](arduino/rc-controller/rc-controller.ino)
to the Nano with the Arduino IDE or `arduino-cli`. See [`arduino/README.md`](arduino/README.md)
for the pin map, calibration constants, and flashing notes (most clone Nanos
need the **"ATmega328P (Old Bootloader)"** board variant).

### 5. Set Up Raspberry Pi

```bash
# Copy the pi/ folder to your Raspberry Pi
scp -r pi/ pi@raspberrypi.local:~/fpv/

# SSH into Pi
ssh pi@raspberrypi.local

# Run setup script (installs rpicam-apps, GStreamer, pyserial, NetworkManager,
# the udev rule for /dev/fpv-arduino, LTE NM profile, systemd units, and the
# low-latency system tuning: CAKE shaping, RAM-only logs, no swap, Bluetooth off)
cd ~/fpv
sudo FPV_WIFI_COUNTRY=US ./setup.sh   # use your own two-letter country code
```

**Configure the services** (one file, loaded by every FPV service):

```bash
nano ~/fpv/fpv.env
# JANUS_HOST=<server tailscale ip>
# CONTROL_RELAY_HOST=<server tailscale ip>   (UDP port 3002 by default)
# AUTH_TOKEN=<same as CONTROL_AUTH_TOKEN in server/.env>
# VIDEO_PRESET=latency            (or balanced / quality)

# Tell the traffic shaper your real uplink speeds
sudo nano /etc/default/fpv-network

# Edit WiFi fallback (optional, for bench debug)
sudo nano /etc/NetworkManager/system-connections/wifi-fallback.nmconnection
sudo chmod 600 /etc/NetworkManager/system-connections/wifi-fallback.nmconnection
sudo nmcli connection reload

# Plug in the Nano (must appear as /dev/fpv-arduino):
ls -l /dev/fpv-arduino

# Plug in the EIOTCLUB LTE dongle (must DHCP on usb0 or eth1):
ip -br addr | grep -E 'usb0|eth1'

# Reboot once (camera overlay, Bluetooth-off and group changes), then start everything
sudo systemctl daemon-reload
sudo systemctl enable fpv-video fpv-control fpv-audio-tx fpv-audio-rx
sudo systemctl start  fpv-video fpv-control fpv-audio-tx fpv-audio-rx

# Check status
systemctl status fpv-video fpv-control fpv-link-manager
journalctl -u fpv-control -f
fpv-diag   # per-core load, temperature, scheduling and link health
```

### 6. Connect and Drive!

1. Plug a USB controller into your desktop and open your browser to the
   secure URL served by the home server (`https://your-server-domain`).
2. Click "Connect to Stream" to start video.
3. Gamepad axes drive throttle, steering, and the camera gimbal; the
   browser sends `{steer, throttle, brake, camYaw, camPitch}` at ~50 Hz,
   which the server relays to the Pi, which relays to the Arduino.

## Configuration

### Server Configuration

**Host-side variables** (set in `server/.env`, template in `server/.env.example`):
- `CONTROL_AUTH_TOKEN`: Auth token for control WebSocket. Compose maps this
  onto the control-relay container as `AUTH_TOKEN` - don't be surprised that
  the two names differ; the host var is the one you set, the container var
  is what the Node.js code reads.
- `SERVER_DOMAIN`: Public FQDN for nginx and certbot. Leave the default for
  HTTP-only local dev.
- `LETSENCRYPT_EMAIL`: Email Let's Encrypt uses for expiry notices.

**Janus Configuration** (`server/janus/janus.plugin.streaming.jcfg`):
- `videoport`: UDP port for RTP video (default: 5004)
- `videopt`: RTP payload type (default: 96)

### Pi Configuration

All Pi settings live in `~/fpv/fpv.env` (template:
[`pi/fpv.env.example`](pi/fpv.env.example)). Values there override the defaults in
the systemd units and scripts. After editing:
`sudo systemctl daemon-reload && sudo systemctl restart fpv-video fpv-control fpv-audio-tx fpv-audio-rx`.

**Video Stream:**
- `JANUS_HOST`: Server's Tailscale IP
- `VIDEO_PRESET`: `latency` (640x480@60, 1.2 Mbps, default), `balanced`
  (1280x720@30, 2 Mbps) or `quality` (1920x1080@30, 3.5 Mbps)
- `VIDEO_WIDTH/HEIGHT/FRAMERATE/BITRATE`, `KEYFRAME_INTERVAL`: override the preset
- `VIDEO_EXPOSURE` (default `sport`), `VIDEO_AWB`, `VIDEO_SHUTTER_US`,
  `VIDEO_SENSOR_MODE`, `VIDEO_EXTRA_ARGS`: camera tuning
- `RTP_MTU`: RTP packet MTU (default: 1200, safe for cellular)
- `CAMERA_STACK`: `auto` | `rpicam` | `raspivid` | `software`

**Audio:**
- `MIC_DEVICE` / `SPK_DEVICE`: ALSA devices by card id (set by
  `scripts/fpv-audio-detect.sh --write`)
- `OPUS_FRAME_SIZE` (default 10 ms), `JITTER_LATENCY_MS` (default 40 ms)

**Control Daemon:**
- `CONTROL_RELAY_HOST` / `CONTROL_RELAY_PORT`: relay UDP endpoint (port `3002`)
- `AUTH_TOKEN`: Must match the server's token (also the HMAC key for datagrams)
- `SERIAL_PORT`: Arduino device node (default: `/dev/fpv-arduino`)
- `SERIAL_BAUD`: Baud rate (default: `500000`, fall back to `115200` if unstable)

**Network shaping** (`/etc/default/fpv-network`): uplink caps in kbit/s for LTE,
Wi-Fi and Ethernet, plus link-manager probe settings.

### Arduino Channel Configuration

All PWM is generated by the Arduino Nano, not the Pi. The four channels and
their pin assignments live at the top of
[`arduino/rc-controller/rc-controller.ino`](arduino/rc-controller/rc-controller.ino):

| Channel        | Nano pin |
| -------------- | -------- |
| Throttle / ESC | D9       |
| Steering       | D10      |
| Camera yaw     | D5       |
| Camera pitch   | D6       |

Per-servo end-stops (`*_MIN_US`, `*_CTR_US`, `*_MAX_US`) and invert flags are
exposed as `#define`s in the sketch so calibration doesn't touch the daemon.

## Wiring Diagram

```
Raspberry Pi 3                 Arduino Nano                   Servos / ESC
─────────────                  ────────────                   ─────────────
USB port     ─── USB cable ──► USB port
                                D9  ───────────────────────►  ESC signal
                                D10 ───────────────────────►  Steering servo signal
                                D5  ───────────────────────►  Cam yaw servo signal
                                D6  ───────────────────────►  Cam pitch servo signal
GND          ────────────────► GND ───────────────────────►  Common servo / ESC ground
                                                          ▲
                        ┌── Separate BEC/battery 5-6V ────┘
                        │   (powers the servo + ESC V+ rail)

Rule of thumb: servo signals share ground with the Nano and the Pi, but
                their +5V power must come from a dedicated BEC, not the Pi.
```

## LTE Dongle (EIOTCLUB)

The EIOTCLUB 4G LTE USB WiFi 6 Dongle is a HiLink/RNDIS device: it performs
its own PDP dialing and presents itself to Linux as a USB Ethernet adapter
(`usb0` or `eth1`) that just needs DHCP. There is no `pppd`/`wvdial`/`qmicli`
step.

[`pi/network/lte-usb.nmconnection`](pi/network/lte-usb.nmconnection) ships a
NetworkManager profile with `autoconnect-priority=100` so LTE is preferred
whenever the dongle is present, and
[`pi/scripts/link-manager.sh`](pi/scripts/link-manager.sh) (the
`fpv-link-manager` service) pings through LTE and Wi-Fi separately every 2 s.
If LTE fails 3 probes in a row and Wi-Fi is healthy, it demotes the LTE default
route so Wi-Fi takes over within about 6 s, and promotes LTE back after 5 good
probes. With no Wi-Fi to fall back to, it bounces the dongle if it wedges on a
tower handoff.

Tailscale is still recommended on top of LTE — most carriers put you behind
CGNAT, so the server won't have a routable public address to the Pi without it.

## Troubleshooting

### Video Issues

**No video in browser:**
1. Check the camera is detected: `rpicam-hello --list-cameras`. If it is not,
   check `dtoverlay=ov5647` in `/boot/firmware/config.txt` and that there is no
   active `start_x=1` line (the legacy stack conflicts with libcamera).
2. Test camera + hardware encoder locally: `rpicam-vid -t 5000 -o test.h264`
3. Check the stream is sending: `journalctl -u fpv-video -f`
4. Verify Janus is receiving: Check Janus logs in Docker

**High latency:**
- Run `fpv-diag` on the Pi: check per-core load, throttle flags and the qdisc
- Use `VIDEO_PRESET=latency` (640x480@60)
- Set `FPV_LTE_UPLINK_KBIT` in `/etc/default/fpv-network` to ~85-90% of the real uplink
- Lower `VIDEO_BITRATE`

### Control Issues

**Controls not responding:**
1. `sudo systemctl status fpv-control` — daemon running?
2. `ls -l /dev/fpv-arduino` — udev symlink present? If not, check
   `lsusb` for the Nano and confirm its VID/PID matches
   [`pi/udev/99-fpv-arduino.rules`](pi/udev/99-fpv-arduino.rules).
3. `journalctl -u fpv-control -f` — look for "Serial write failed" or
   "Could not open /dev/fpv-arduino".
4. Check the WebSocket connection in browser DevTools.
5. Verify `AUTH_TOKEN` matches on both Pi and server (the daemon logs
   "Rejected N datagram(s)" when the HMAC key differs).
6. Verify UDP port `3002` is published on the server (`docker compose ps`) and
   not blocked by a firewall, and that `CONTROL_RELAY_HOST` is the same IP the
   server answers from (use the Tailscale IP on both sides).
7. Browser telemetry panel shows `arduino.failsafeActive=true`? The Nano is
   not receiving valid frames — suspect cable, baud mismatch, or a bad
   checksum implementation if you edited the protocol.

**Servo jitter:**
- Ensure a **separate** BEC powers the servo rail; sharing the Pi 5V causes
  brownouts that look like jitter.
- Common ground between the servo power, the Nano, and the Pi is mandatory.
- If jitter persists, drop `SERIAL_BAUD` to `115200` — some CH340 clones are
  unreliable at 500 kbaud.

### Network Issues

**Can't connect over 4G:**
1. Verify Tailscale is connected: `tailscale status`
2. Check Tailscale IPs are correct in configs
3. Try pinging: `ping 100.x.x.x` (server's Tailscale IP)

## TLS (Let's Encrypt)

Once your server has a public FQDN and ports 80 and 443 are reachable from the
internet, turn on HTTPS with the bundled bootstrap script:

```bash
cd server

# 1. Fill in SERVER_DOMAIN and LETSENCRYPT_EMAIL in .env (see .env.example).
# 2. Make sure DNS for SERVER_DOMAIN points at this host.
# 3. Run the one-shot bootstrap:
chmod +x scripts/init-tls.sh
./scripts/init-tls.sh
```

What it does:

1. Drops a 1-day self-signed cert into the `letsencrypt` named volume so
   nginx can boot with the TLS config enabled.
2. Starts nginx (port 80 serves the ACME HTTP-01 challenge under
   `/.well-known/acme-challenge/` and redirects everything else to HTTPS).
3. Asks certbot to issue the real cert via the webroot plugin, then reloads
   nginx so the new cert is served immediately.
4. Brings up the `certbot` sidecar service, which runs
   `certbot renew --webroot` every 12 hours. Nginx reloads every 6 hours, so
   renewed certs are picked up without manual intervention.

Re-running `init-tls.sh` after a successful bootstrap is safe - it simply
triggers a `certbot renew` check.

For local or private-network development leave `SERVER_DOMAIN` set to
`localhost` (the default) and skip the script; nginx still listens on port 80
so `http://localhost` continues to work.

## Security Recommendations

1. **Use HTTPS**: Run `./server/scripts/init-tls.sh` for production (see TLS
   section above).
2. **Strong Auth Token**: Generate a random token: `openssl rand -hex 32`
3. **Firewall**: Only expose necessary ports (80/443). Keep UDP `3002` (Pi
   control link) and the RTP ingest ports `5004`/`5006` reachable only over
   Tailscale, not the public internet. Control datagrams are HMAC-authenticated
   but not encrypted; the VPN provides confidentiality.
4. **Physical Kill Switch**: Add a hardware emergency stop
5. **Rate Limiting**: Nginx config includes rate limiting

## Project Structure

```
├── server/                 # Home server components
│   ├── docker-compose.yml  # Container orchestration (nginx, janus, control-relay, certbot)
│   ├── .env.example        # Template for CONTROL_AUTH_TOKEN / SERVER_DOMAIN / LETSENCRYPT_EMAIL
│   ├── janus/              # Janus WebRTC Gateway config
│   ├── control-relay/      # Node.js relay: browser WebSocket <-> Pi UDP (HMAC)
│   ├── nginx/              # nginx.conf + templates/default.conf.template (envsubst-driven)
│   └── scripts/            # init-tls.sh (Let's Encrypt bootstrap)
├── web/                    # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── hooks/          # React hooks
│   │   └── types/          # TypeScript definitions
│   └── package.json
├── pi/                     # Raspberry Pi side
│   ├── video-stream.sh     # rpicam-vid hardware H.264 -> RTP (presets)
│   ├── audio-stream-tx.sh  # Pi mic -> Opus -> Janus
│   ├── audio-receive.sh    # Janus AudioBridge -> Pi speaker
│   ├── fpv.env.example     # All Pi settings (installed as ~/fpv/fpv.env)
│   ├── control-daemon/     # Python UDP -> serial daemon (+ pytest tests)
│   ├── systemd/            # fpv-video / -control / -audio-* / -tune / -link-manager units
│   ├── network/            # NM profiles, CAKE/DSCP dispatcher, uplink caps
│   ├── system/             # sysctl + journald tuning
│   ├── scripts/            # link-manager, fpv-diag, fpv-tune, audio detect, benchmarks
│   ├── udev/               # /dev/fpv-arduino symlink rule
│   └── setup.sh            # Pi provisioning script
├── arduino/                # Arduino Nano firmware
│   ├── rc-controller/      # rc-controller.ino (PWM generator + failsafe)
│   └── README.md
└── README.md
```

## Performance Tuning

### Low-latency checklist (already wired into defaults)

- **Arduino owns PWM timing** — 1 µs resolution via `Servo.writeMicroseconds()`,
  immune to Linux scheduler jitter on the Pi.
- **Binary serial protocol** — 10-byte magic+XOR frame at 500 kbaud, 50 Hz
  (500 B/s total, sub-millisecond transit).
- **Hardware H.264 encoder** — `rpicam-vid` drives the VideoCore IV encoder, so
  encoding costs almost no CPU. A 30-frame GOP (0.5 s at 60 fps) bounds
  packet-loss recovery, and `--flush` hands every frame to the pipe at once.
- **High frame rate preset** — 640x480@60 cuts capture-to-encode delay in half
  compared to 30 fps.
- **Control over UDP** — a lost packet is superseded by the next one instead of
  stalling later commands (TCP head-of-line blocking). Each datagram is written
  to the Arduino the instant it arrives; no polling tick.
- **Core plan** — core 0 kernel/interrupts, core 1 control daemon (SCHED_FIFO),
  core 2 audio (SCHED_FIFO), core 3 video. No `CPUQuota` (cgroup throttling
  causes periodic stalls).
- **CAKE uplink shaping + DSCP** — control and audio (EF) are sent ahead of
  video, and queueing happens in the Pi instead of inside the LTE modem.
- **Opus 10 ms frames + 40 ms jitter buffer** with FEC and packet-loss
  concealment.
- **Browser playout hints** — `jitterBufferTarget = 0` for video.
- **Fast LTE/Wi-Fi failover** — 6 s detection instead of 90+ s.
- **RTP `mtu=1200`** stays under typical cellular MTU and avoids
  fragmentation.

### Pi 3 B v1.2 Limits (hardware, not software)

- The hardware encoder is rated for 1080p30; for LTE, 640x480@60 or 720p30
  are the practical choices.
- Wi-Fi is 2.4 GHz 802.11n only and shares one USB 2.0 hub with Ethernet, the
  LTE dongle and USB audio. Keep total traffic modest (the default preset is
  well inside it).
- Thermals: without a heatsink the SoC soft-throttles near 80 °C.
  The UI shows "PI THROTTLED" when the firmware reports throttling or
  undervoltage. The optional `fpv-bitrate-governor` service lowers the bitrate
  automatically while throttled.

## License

MIT License - See LICENSE file for details.

## Contributing

Contributions welcome! Please open an issue or PR.


