# Deployment Guide

End-to-end instructions for getting the FPV stack running on a Raspberry Pi
with an Arduino Nano and an EIOTCLUB 4G LTE USB dongle. The Pi side runs as
systemd services that start on boot - you do not need to launch anything from
the terminal by hand once setup is done.

## Contents

- [Before you touch the Pi](#before-you-touch-the-pi)
- [Step 1 - Get the code onto the Pi](#step-1---get-the-code-onto-the-pi)
- [Step 2 - Run the setup script](#step-2---run-the-setup-script)
- [Step 3 - Edit the two config values that matter](#step-3---edit-the-two-config-values-that-matter)
- [Step 4 - Install Tailscale](#step-4---install-tailscale)
- [Step 5 - Flash the Arduino](#step-5---flash-the-arduino)
- [Step 6 - Plug everything in, start services](#step-6---plug-everything-in-start-services)
- [Step 7 - Verify it is running](#step-7---verify-it-is-running)
- [When do I need to run something manually?](#when-do-i-need-to-run-something-manually)
- [Command cheat sheet](#command-cheat-sheet)
- [Measuring latency](#measuring-latency)
- [Soak test](#soak-test)
- [Gotchas](#gotchas)

## Before you touch the Pi

1. **Flash Raspberry Pi OS (64-bit, Bookworm or Bullseye)** with Raspberry Pi
   Imager. Pre-configure SSH and WiFi during imaging so you can get in
   remotely.
2. **Boot the Pi, get it on your network**, and confirm you can SSH in:
   ```bash
   ssh pi@raspberrypi.local
   ```
   (or use its IP address)

## Step 1 - Get the code onto the Pi

Two options, pick one.

### Option A: copy from your PC (one-shot)

From PowerShell on your Windows desktop, in the project folder:

```powershell
scp -r pi pi@raspberrypi.local:~/fpv
```

That leaves the contents of the `pi/` folder at `~/fpv` on the Pi.

### Option B: git clone (recommended if you plan to iterate)

Push this project to GitHub/GitLab/Gitea, then on the Pi:

```bash
sudo apt install -y git
git clone https://github.com/you/your-repo.git ~/fpv-repo
cp -r ~/fpv-repo/pi ~/fpv
```

## Step 2 - Run the setup script

SSH into the Pi and run it **once**:

```bash
cd ~/fpv
sudo ./setup.sh
```

See [`pi/setup.sh`](pi/setup.sh). It:

- Installs `rpicam-apps` (hardware H.264 encoder), GStreamer, `python3-serial`,
  `usb-modeswitch`, NetworkManager and `iw`. (ModemManager is deliberately not
  installed: the HiLink dongle does not need it.)
- Adds the `pi` user to the `dialout` and `audio` groups.
- Configures `/boot/firmware/config.txt` (or `/boot/config.txt` on older OS)
  for the libcamera stack: `dtoverlay=ov5647`, `gpu_mem=128`,
  `dtoverlay=disable-bt`, and it disables a legacy `start_x=1` line, which
  conflicts with libcamera. Set `FPV_CAMERA_OVERLAY=` (empty) for v2/v3/HQ
  cameras to use auto-detect instead.
- Applies system tuning: kernel tunables, RAM-only journald, swap off, the
  `sch_cake` module, unused services disabled, `fpv-tune.service` at boot
  (performance governor, USB autosuspend off, Wi-Fi power save off, HDMI off).
- Installs the udev rule that creates the stable `/dev/fpv-arduino` symlink
  for the Nano.
- Copies the LTE and WiFi NetworkManager profiles into
  `/etc/NetworkManager/system-connections/` (existing profiles are kept) and
  installs the CAKE/DSCP dispatcher script plus `/etc/default/fpv-network`.
- Installs the systemd units: `fpv-video`, `fpv-control`, `fpv-audio-tx`,
  `fpv-audio-rx`, `fpv-tune`, `fpv-link-manager` (replaces the old
  `fpv-net-watchdog.timer`), and the optional `fpv-bitrate-governor`.
- Detects USB audio devices and stores stable ALSA card ids in `fpv.env`.

Useful environment variables: `FPV_WIFI_COUNTRY=US` (regulatory domain),
`FPV_SKIP_UPGRADE=1` (skip the slow `apt upgrade`).

## Step 3 - Edit the config values that matter

All Pi settings live in one file that every FPV service loads:

```bash
nano ~/fpv/fpv.env
```

Set:

- `JANUS_HOST` and `CONTROL_RELAY_HOST` to your home server's Tailscale IP.
- `CONTROL_RELAY_PORT` if you changed `UDP_PORT` on the server (default `3002`).
- `AUTH_TOKEN` to the token you set as `CONTROL_AUTH_TOKEN` on the server.
- `VIDEO_PRESET` to `latency`, `balanced` or `quality`.

Then reload: `sudo systemctl daemon-reload`.

### Traffic shaping

```bash
sudo nano /etc/default/fpv-network
```

Set `FPV_LTE_UPLINK_KBIT` and `FPV_WIFI_UPLINK_KBIT` to roughly 85-90% of your
measured uplink speed. This is what keeps control and audio latency low when the
video briefly exceeds the real uplink rate. Re-apply by replugging the dongle or
`sudo nmcli con down lte-usb && sudo nmcli con up lte-usb`.

### WiFi fallback (optional, for bench testing)

```bash
sudo nano /etc/NetworkManager/system-connections/wifi-fallback.nmconnection
# set ssid and psk to your home WiFi
sudo chmod 600 /etc/NetworkManager/system-connections/wifi-fallback.nmconnection
sudo nmcli connection reload
```

## Step 4 - Install Tailscale (on BOTH ends)

Not strictly required, but effectively mandatory if you want the Pi
reachable over LTE - carriers put you behind CGNAT so the server has no
routable path to the Pi without it. Tailscale must be installed on both
the server and the Pi, signed into the **same Tailscale account**, so they
end up on the same tailnet.

### On the server (do this first)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4   # write this 100.x.x.x IP down - you need it in Step 3 above
```

Follow the URL it prints to authenticate. The 100.x.x.x address it prints
is what goes into `CONTROL_RELAY_HOST` and `JANUS_HOST` on the Pi.

### On the Pi

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Once both ends are up, verify from the Pi:

```bash
tailscale status
tailscale ping <server-tailscale-ip>
```

The control link is UDP (port 3002), so `nc -zv` is not a reliable test. The
real check is the daemon log in Step 7: once the relay answers, the browser
shows "PI" connected and a control RTT.

### Tailscale vs kernel WireGuard (optional)

On a Pi 3, Tailscale runs WireGuard in userspace and spends CPU on every
packet. To see whether that matters for your stream, run the benchmark once per
VPN (server: `iperf3 -s`, Pi: below) and compare loss, jitter and CPU:

```bash
~/fpv/scripts/fpv-vpn-bench.sh <server-vpn-ip> 3 30
```

Switch to kernel WireGuard only if the Tailscale CPU cost is significant for
your preset.

## Step 5 - Flash the Arduino

This step is done on your **desktop**, not the Pi.

1. Install the Arduino IDE.
2. Tools -> Board -> Arduino Nano.
3. Tools -> Processor -> **ATmega328P (Old Bootloader)** for clone Nanos, or
   plain **ATmega328P** for genuine Arduino-brand Nanos.
4. Open [`arduino/rc-controller/rc-controller.ino`](arduino/rc-controller/rc-controller.ino)
   and click Upload.

See [`arduino/README.md`](arduino/README.md) for the pin map, wiring, the
"separate BEC for servos" power warning, and bench-test snippet.

## Step 6 - Plug everything in, start services

On the Pi:

```bash
# 1. Plug the Arduino Nano into any Pi USB port. Verify the udev symlink:
ls -l /dev/fpv-arduino
# Should show: /dev/fpv-arduino -> ttyUSB0 (or ttyACM0)

# 2. Plug the EIOTCLUB LTE dongle in. Verify the interface came up:
ip -br addr | grep -E 'usb0|eth1'
# Should show an IP that is NOT 192.168.x.x (the carrier assigned it)

# 3. Reboot once so group membership (dialout) takes effect:
sudo reboot
```

After the reboot:

```bash
sudo systemctl enable fpv-video fpv-control fpv-audio-tx fpv-audio-rx
sudo systemctl start  fpv-video fpv-control fpv-audio-tx fpv-audio-rx
```

## Step 7 - Verify it is running

```bash
systemctl status fpv-video fpv-control fpv-audio-tx fpv-audio-rx fpv-link-manager
fpv-diag
```

The services should show `Active: active (running)`. `fpv-diag` prints per-core
load, temperature and throttle flags, which core each FPV process runs on, the
active qdisc (look for `cake`), Wi-Fi link quality and recent warnings.

Tail the live log:

```bash
journalctl -u fpv-control -f
```

A healthy boot looks like:

```
Starting FPV control daemon
Relay:  100.x.x.x:3002 (UDP)
Serial: /dev/fpv-arduino @ 500000 baud
UDP link ready, relay address 100.x.x.x:3002
Opened serial port /dev/fpv-arduino
```

On the server, `docker compose logs control-relay` shows
`Pi endpoint <ip>:<port>` and `Pi link up` within a second. A repeating
"Rejected N datagram(s)" line on the Pi means `AUTH_TOKEN` differs from the
server's `CONTROL_AUTH_TOKEN`.

From here on, the services auto-start on every boot. **You never need to
launch anything manually from the terminal.** Power-cycle the Pi, drop it in
the RC car, and as soon as the LTE dongle registers with a tower it phones
home.

## When do I need to run something manually?

Only while debugging. To see raw output without systemd in the way:

```bash
sudo systemctl stop fpv-control

CONTROL_RELAY_HOST=100.x.x.x AUTH_TOKEN=yourtoken \
    SERIAL_PORT=/dev/fpv-arduino SERIAL_BAUD=500000 \
    python3 /home/pi/fpv/control-daemon/control_daemon.py
```

Ctrl+C to stop, then hand control back to systemd:

```bash
sudo systemctl start fpv-control
```

The same trick works for the video pipeline - run
`/home/pi/fpv/video-stream.sh` directly with env overrides like
`VIDEO_PRESET=balanced VIDEO_BITRATE=1500000 JANUS_HOST=100.x.x.x ./video-stream.sh`
(stop `fpv-video` first so the camera is free).

## Command cheat sheet

| Task                             | Command                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| Start everything                 | `sudo systemctl start fpv-video fpv-control fpv-audio-tx fpv-audio-rx` |
| Stop everything                  | `sudo systemctl stop fpv-video fpv-control fpv-audio-tx fpv-audio-rx`  |
| Restart after config edit        | `sudo systemctl daemon-reload && sudo systemctl restart fpv-video fpv-control fpv-audio-tx fpv-audio-rx` |
| Health snapshot                  | `fpv-diag` (or `fpv-diag --watch`)                              |
| Tail control logs                | `journalctl -u fpv-control -f`                                  |
| Tail video logs                  | `journalctl -u fpv-video -f`                                    |
| Tail link manager                | `journalctl -u fpv-link-manager -f`                             |
| Re-detect USB audio devices      | `~/fpv/scripts/fpv-audio-detect.sh --write`                     |
| Enable thermal bitrate governor  | `sudo systemctl enable --now fpv-bitrate-governor`              |
| Is the Arduino connected?        | `ls -l /dev/fpv-arduino`                                        |
| Is the LTE dongle up?            | `nmcli con show --active`                                       |
| What route does traffic take?    | `ip route get 1.1.1.1`                                          |
| CPU temperature + uptime         | `vcgencmd measure_temp; uptime`                                 |
| Reset LTE connection             | `sudo nmcli con down lte-usb && sudo nmcli con up lte-usb`      |

## Measuring latency

Take a baseline before changing anything, and repeat after each change so you
know what actually helped.

### Video: glass-to-glass

1. On a monitor, open a stopwatch that shows milliseconds (any "online
   stopwatch" page works; use a 60 Hz or faster display).
2. Point the car's camera at that monitor so the stopwatch is in view.
3. Open the control page in a browser **next to** the same monitor, so both the
   real stopwatch and its video copy are visible in one photo.
4. Take a photo (or screenshot with a phone camera at 1/1000 s or faster). The
   difference between the two clock readings is the glass-to-glass latency.
5. Repeat at least 10 times and note the median and the worst case.

Do this on the home Wi-Fi first (shows the pipeline cost), then over LTE (adds
the network).

### Controls: round-trip time

The control link measures itself. The relay pings the Pi 4 times a second and
the Pi echoes each timestamp, so the "Control RTT" readout in the UI footer and
status panel is live, even when nobody is driving. It is relay-to-Pi-to-relay
time; add your browser-to-server delay for the full path. For a reference
point, ping the server from your browser's network.

### Audio: mouth-to-ear

Clap next to the car's microphone while recording both the clap and the
browser's speaker output on a phone's video; step through the recording frame
by frame to compare. For the browser-to-car direction, press push-to-talk, tap
the mic, and record the car's speaker.

### CPU, temperature and scheduling

`fpv-diag --watch` while streaming. Healthy targets on the Pi 3: each core
below about 70%, no `THROTTLED-NOW` flag, FPV processes on their assigned cores
(`psr` column: control 1, audio 2, video 3).

## Soak test

Run for at least 30 minutes with everything active (video, audio both ways,
and controls driven continuously from a gamepad), once on LTE and once on
Wi-Fi:

1. Watch `fpv-diag --watch` for throttling, rising temperature, or a core
   pinned at 100%.
2. Confirm the video stays smooth and Control RTT stays stable.
3. Unplug and replug the Arduino: the daemon should log the serial error,
   keep running, and reconnect within a second or two. The car must stop
   (failsafe) while it is gone.
4. Stop the relay (`docker compose stop control-relay`) while driving: the
   car must stop within about a quarter of a second (deadman), and recover on
   its own when the relay returns.
5. Unplug the LTE dongle with Wi-Fi configured: `journalctl -u
   fpv-link-manager -f` should show a switch to Wi-Fi within ~6 seconds, and
   a switch back after the dongle returns.

## Gotchas

- **`/dev/fpv-arduino` does not appear:** The udev rule matches the CH340
  clone chip (`1a86:7523`) and the FTDI chip (`0403:6001`). If your Nano is
  something else, find the VID:PID with `lsusb` and add a matching line to
  [`pi/udev/99-fpv-arduino.rules`](pi/udev/99-fpv-arduino.rules), then
  `sudo udevadm control --reload && sudo udevadm trigger`.
- **"Permission denied" opening the serial port:** The `pi` user must be in
  the `dialout` group, and group membership only takes effect after a fresh
  login (or a reboot). `id pi` should list `dialout`.
- **Browser sees the car as offline:** Check that the Pi's Tailscale IP is
  reachable from the server (`tailscale ping <pi-ip>`), and that
  `AUTH_TOKEN` matches on both ends.
- **Servo twitching / brownouts:** Servos and the ESC must be powered from
  a separate BEC, not the Pi 5V rail and not the Nano 5V rail. Common
  ground between the servo power, the Nano, and the Pi is still required.
- **CH340 at 500 kbaud is unreliable:** Drop `SERIAL_BAUD` to `115200` in
  the service file **and** in
  [`arduino/rc-controller/rc-controller.ino`](arduino/rc-controller/rc-controller.ino)
  (the `SERIAL_BAUD` constant at the top). Reflash the Nano.
- **Video is laggy but control is fine:** You are probably network-bound,
  not CPU-bound (the encoder runs on the GPU). Lower `VIDEO_BITRATE` or use
  `VIDEO_PRESET=latency` in `~/fpv/fpv.env` and restart `fpv-video`. Make sure
  `FPV_LTE_UPLINK_KBIT` in `/etc/default/fpv-network` is set from a real
  measurement. Keep an eye on `journalctl -u fpv-link-manager` - if it is
  switching links or bouncing the LTE interface often, your cellular signal is
  the real problem.
- **`rpicam-vid` finds no camera:** The OV5647 (Camera Module v1) needs
  `dtoverlay=ov5647`, and there must be no active `start_x=1` line in
  `config.txt` (the legacy stack and libcamera conflict). `setup.sh` handles
  both; reboot afterwards.
- **No control, but video works:** Control uses UDP port `3002` to the relay
  (published in `docker-compose.yml`). Allow it through the server firewall
  for your Tailscale interface, and use the same IP in `CONTROL_RELAY_HOST`
  that the server will answer from.
- **Audio device not found after reboot:** Re-run
  `~/fpv/scripts/fpv-audio-detect.sh --write` to store stable card ids and
  restart the audio services.
