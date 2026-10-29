# FPV Video Streaming System

Low-latency FPV video streaming from Raspberry Pi to browser with WebRTC, plus real-time RC car control over WebSocket.

## Architecture

```
┌───────────────────────────────┐     ┌──────────────────────────────┐     ┌──────────────┐
│        Raspberry Pi 3         │     │         Home Server          │     │   Browser    │
│          (On the Car)         │     │          (Ubuntu)            │     │              │
├───────────────────────────────┤     ├──────────────────────────────┤     ├──────────────┤
│                               │ RTP │ ┌──────────────────────────┐ │WebRTC│ ┌──────────┐│
│  ┌──────────┐                 │─────►│   Janus WebRTC Gateway   │─┼────►│ │  Video   ││
│  │  Camera  │                 │ UDP │ │                          │ │     │ │  Player  ││
│  │  OV5647  │─► gstreamer ────│:5004│ └──────────────────────────┘ │     │ └──────────┘│
│  └──────────┘                 │     │                              │     │             │
│                               │ WS  │ ┌──────────────────────────┐ │ WS  │ ┌──────────┐│
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

- **Low-Latency Video**: WebRTC streaming via Janus Gateway (~150-400ms glass-to-glass)
- **Real-Time Control**: WebSocket-based control with 50Hz update rate
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
- Raspberry Pi 3B/3B+ (Pi 4 also supported)
- Pi Camera Module v1 (OV5647) or v2
- Raspberry Pi OS Bullseye or Bookworm
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

# Build and start services
docker-compose up -d

# Check status
docker-compose ps
docker-compose logs -f
```

The server will be available at `http://localhost` (or your server IP).

### 3. Build the Web Frontend

```bash
cd web

# Install dependencies
npm install

# For development
npm run dev

# For production build
npm run build
# Built files go to web/dist/ which nginx serves
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

# Run setup script (installs GStreamer, pyserial, NetworkManager,
# the udev rule for /dev/fpv-arduino, LTE NM profile, and systemd units)
cd ~/fpv
sudo ./setup.sh
```

**Configure the services:**

```bash
# Edit video service - set your server's Tailscale IP
sudo systemctl edit --full fpv-video.service
# Change JANUS_HOST=100.x.x.x to your server's Tailscale IP

# Edit control service - set server IP and auth token
sudo systemctl edit --full fpv-control.service
# Change CONTROL_SERVER=ws://100.x.x.x:3001
# Change AUTH_TOKEN to match your server's token
# (SERIAL_PORT=/dev/fpv-arduino is already correct)

# Edit WiFi fallback (optional, for bench debug)
sudo nano /etc/NetworkManager/system-connections/wifi-fallback.nmconnection
sudo chmod 600 /etc/NetworkManager/system-connections/wifi-fallback.nmconnection
sudo nmcli connection reload

# Plug in the Nano (must appear as /dev/fpv-arduino):
ls -l /dev/fpv-arduino

# Plug in the EIOTCLUB LTE dongle (must DHCP on usb0 or eth1):
ip -br addr | grep -E 'usb0|eth1'

# Start everything
sudo systemctl daemon-reload
sudo systemctl enable fpv-video fpv-control
sudo systemctl start  fpv-video fpv-control

# Check status
systemctl status fpv-video fpv-control fpv-net-watchdog.timer
journalctl -u fpv-control -f
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

**Video Stream** (`/etc/systemd/system/fpv-video.service`):
- `JANUS_HOST`: Server's Tailscale IP
- `VIDEO_WIDTH/HEIGHT`: Resolution (default: 960x540, tuned for LTE)
- `VIDEO_FRAMERATE`: FPS (default: 25)
- `VIDEO_BITRATE`: Bitrate in bps (default: 1000000 CBR)
- `KEYFRAME_INTERVAL`: I-frame period in frames (default: 15)
- `RTP_MTU`: RTP packet MTU (default: 1200, safe for cellular)
- `CAMERA_STACK`: `auto` | `libcamera` | `v4l2` | `software`

**Control Daemon** (`/etc/systemd/system/fpv-control.service`):
- `CONTROL_SERVER`: WebSocket URL of control relay
- `AUTH_TOKEN`: Must match server's token
- `SERIAL_PORT`: Arduino device node (default: `/dev/fpv-arduino`)
- `SERIAL_BAUD`: Baud rate (default: `500000`, fall back to `115200` if unstable)

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
[`pi/scripts/net-watchdog.sh`](pi/scripts/net-watchdog.sh) (wired up via the
`fpv-net-watchdog.timer` unit) pings the internet every 30 s and bounces the
interface if the dongle wedges on a tower handoff.

Tailscale is still recommended on top of LTE — most carriers put you behind
CGNAT, so the server won't have a routable public address to the Pi without it.

## Troubleshooting

### Video Issues

**No video in browser:**
1. Check Pi camera is enabled: `vcgencmd get_camera`
2. Test camera locally: `rpicam-vid -t 5000 -o test.h264`
3. Check GStreamer is sending: `journalctl -u fpv-video -f`
4. Verify Janus is receiving: Check Janus logs in Docker

**High latency:**
- Reduce resolution to 640x480
- Lower bitrate to 1000000
- Increase keyframe interval

### Control Issues

**Controls not responding:**
1. `sudo systemctl status fpv-control` — daemon running?
2. `ls -l /dev/fpv-arduino` — udev symlink present? If not, check
   `lsusb` for the Nano and confirm its VID/PID matches
   [`pi/udev/99-fpv-arduino.rules`](pi/udev/99-fpv-arduino.rules).
3. `journalctl -u fpv-control -f` — look for "Serial write failed" or
   "Could not open /dev/fpv-arduino".
4. Check WebSocket connection in browser DevTools.
5. Verify `AUTH_TOKEN` matches on both Pi and server.
6. Browser telemetry panel shows `arduino.failsafeActive=true`? The Nano is
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
3. **Firewall**: Only expose necessary ports (80/443)
4. **Physical Kill Switch**: Add a hardware emergency stop
5. **Rate Limiting**: Nginx config includes rate limiting

## Project Structure

```
├── server/                 # Home server components
│   ├── docker-compose.yml  # Container orchestration (nginx, janus, control-relay, certbot)
│   ├── .env.example        # Template for CONTROL_AUTH_TOKEN / SERVER_DOMAIN / LETSENCRYPT_EMAIL
│   ├── janus/              # Janus WebRTC Gateway config
│   ├── control-relay/      # Node.js WebSocket relay
│   ├── nginx/              # nginx.conf + templates/default.conf.template (envsubst-driven)
│   └── scripts/            # init-tls.sh (Let's Encrypt bootstrap)
├── web/                    # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── hooks/          # React hooks
│   │   └── types/          # TypeScript definitions
│   └── package.json
├── pi/                     # Raspberry Pi side
│   ├── video-stream.sh     # GStreamer pipeline (LTE-tuned)
│   ├── control-daemon/     # Python serial/websocket daemon
│   ├── systemd/            # fpv-video / fpv-control / net-watchdog units
│   ├── network/            # NetworkManager profiles (LTE, wifi fallback)
│   ├── scripts/            # net-watchdog.sh
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
- **Control daemon** runs with `Nice=-10` and realtime IO class.
- **H.264 hardware encoder** (`v4l2h264enc`) with CBR rate control and a
  15-frame GOP so packet-loss recovery is ≤ ~0.6 s at 25 fps.
- **RTP `mtu=1200`** stays under typical cellular MTU and avoids
  fragmentation.
- **`queue leaky=downstream max-buffers=1`** on both sides of the encoder —
  if the uplink stalls, the pipeline drops the oldest frame instead of
  growing latency.
- **NetworkManager `autoconnect-priority`** pins the default route to LTE so
  Tailscale/Janus always take the shortest path to the server.

### Pi 3 Limitations

The Pi 3's hardware H.264 encoder has limits:
- Max reliable: 1080p25 or 720p30
- Default: 960x540 @ 25 fps, 1.0 Mbps (reliable over LTE)
- Use the hardware encoder (`v4l2h264enc`), not software (`x264enc`)

## License

MIT License - See LICENSE file for details.

## Contributing

Contributions welcome! Please open an issue or PR.


