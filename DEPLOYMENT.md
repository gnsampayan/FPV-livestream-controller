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

- Installs GStreamer, `python3-serial`, `pyserial`, `websocket-client`,
  `usb-modeswitch`, NetworkManager, ModemManager.
- Adds the `pi` user to the `dialout` group so the daemon can open
  `/dev/fpv-arduino`.
- Enables the Pi camera in `/boot/firmware/config.txt` (or
  `/boot/config.txt` on older OS).
- Installs the udev rule that creates the stable `/dev/fpv-arduino` symlink
  for the Nano.
- Copies the LTE and WiFi NetworkManager profiles into
  `/etc/NetworkManager/system-connections/`.
- Installs the systemd units: `fpv-video.service`, `fpv-control.service`,
  and `fpv-net-watchdog.timer`.

## Step 3 - Edit the two config values that matter

The services ship with placeholder values you must change.

### Control service

```bash
sudo systemctl edit --full fpv-control.service
```

Change:

- `CONTROL_SERVER=ws://100.x.x.x:3001` to your home server's Tailscale IP.
- `AUTH_TOKEN=changeme` to the token you set on the server.

Save and exit (Ctrl+X, Y, Enter in nano).

### Video service

```bash
sudo systemctl edit --full fpv-video.service
```

Change:

- `JANUS_HOST=100.x.x.x` to your server's Tailscale IP.

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
is what goes into `CONTROL_SERVER` and `JANUS_HOST` on the Pi.

### On the Pi

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Once both ends are up, verify from the Pi:

```bash
tailscale status
tailscale ping <server-tailscale-ip>
nc -zv  <server-tailscale-ip> 3001   # control-relay reachable?
```

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
sudo systemctl enable fpv-video fpv-control
sudo systemctl start  fpv-video fpv-control
```

## Step 7 - Verify it is running

```bash
systemctl status fpv-video fpv-control fpv-net-watchdog.timer
```

The first two should show `Active: active (running)`.

Tail the live log:

```bash
journalctl -u fpv-control -f
```

A healthy boot looks like:

```
Starting FPV Control Daemon
Serial: /dev/fpv-arduino @ 500000 baud
Opened serial port /dev/fpv-arduino
Connecting to ws://100.x.x.x:3001
WebSocket connected, authenticating...
Authentication successful
```

From here on, the services auto-start on every boot. **You never need to
launch anything manually from the terminal.** Power-cycle the Pi, drop it in
the RC car, and as soon as the LTE dongle registers with a tower it phones
home.

## When do I need to run something manually?

Only while debugging. To see raw output without systemd in the way:

```bash
sudo systemctl stop fpv-control

CONTROL_SERVER=ws://100.x.x.x:3001 AUTH_TOKEN=yourtoken \
    SERIAL_PORT=/dev/fpv-arduino SERIAL_BAUD=500000 \
    python3 /home/pi/fpv/control-daemon/control_daemon.py
```

Ctrl+C to stop, then hand control back to systemd:

```bash
sudo systemctl start fpv-control
```

The same trick works for the video pipeline - run
`/home/pi/fpv/video-stream.sh` directly with env overrides like
`VIDEO_BITRATE=500000 JANUS_HOST=100.x.x.x ./video-stream.sh`.

## Command cheat sheet

| Task                             | Command                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| Start everything                 | `sudo systemctl start fpv-video fpv-control`                    |
| Stop everything                  | `sudo systemctl stop fpv-video fpv-control`                     |
| Restart after config edit        | `sudo systemctl daemon-reload && sudo systemctl restart fpv-control` |
| Tail control logs                | `journalctl -u fpv-control -f`                                  |
| Tail video logs                  | `journalctl -u fpv-video -f`                                    |
| Tail LTE watchdog                | `journalctl -u fpv-net-watchdog -f`                             |
| Is the Arduino connected?        | `ls -l /dev/fpv-arduino`                                        |
| Is the LTE dongle up?            | `nmcli con show --active`                                       |
| What route does traffic take?    | `ip route get 1.1.1.1`                                          |
| CPU temperature + uptime         | `vcgencmd measure_temp; uptime`                                 |
| Reset LTE connection             | `sudo nmcli con down lte-usb && sudo nmcli con up lte-usb`      |

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
  not CPU-bound. Drop `VIDEO_BITRATE` to 500000 or `VIDEO_WIDTH/HEIGHT` to
  640x360 in `fpv-video.service` and restart. Keep an eye on
  `journalctl -u fpv-net-watchdog` - if it is bouncing the LTE interface
  often, your cellular signal is the real problem.
