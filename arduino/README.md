# FPV RC Controller - Arduino Nano

Arduino Nano sketch that receives control frames from the Raspberry Pi over
USB-CDC serial and drives four PWM channels: throttle/ESC, steering servo,
camera yaw servo, and camera pitch servo.

The Pi daemon ([../pi/control-daemon/control_daemon.py](../pi/control-daemon/control_daemon.py))
talks to this sketch; the browser and server never touch the Arduino directly.

## Why the Arduino?

The Pi is not a hard real-time platform. Putting PWM generation on an AVR gives
every servo a microsecond-stable pulse train that is immune to Linux scheduler
jitter, GC pauses, or the daemon restarting. It also adds a second failsafe
layer: if the Pi stops sending frames, the Arduino recenters everything on its
own after 300 ms.

## Hardware

- Board: Arduino Nano (ATmega328P, 16 MHz). Clone Nanos with the CH340 USB
  chip work; FTDI variants also work.
- Servos: standard hobby servos that accept 50 Hz / 1000-2000 us pulses.
- ESC: any brushed or brushless ESC with standard 50 Hz servo input.

### Pin map

| Nano pin | Channel        | Signal to connect    |
| -------- | -------------- | -------------------- |
| D9       | Throttle / ESC | ESC signal wire      |
| D10      | Steering       | Steering servo sig   |
| D5       | Camera yaw     | Cam yaw servo sig    |
| D6       | Camera pitch   | Cam pitch servo sig  |
| GND      | Common ground  | ESC + servo grounds  |

### Power - read this twice

> **Do not power servos or the ESC from the Nano 5V rail or from the Pi 5V
> rail.** Servos can spike multiple amps on movement and will brown-out either
> board, usually at the worst possible moment.

Use a dedicated BEC (Battery Eliminator Circuit) or a separate 5-6 V pack to
power the servo/ESC rail. Tie that supply's ground to the Nano GND and the Pi
GND so the signal references match; leave the 5 V rails separate.

```
 Battery +  ----- BEC +5V ----+----> Servos + ESC V+
                              |
 Battery -  ----- BEC GND ----+----> Servos + ESC GND ---+
                                                         |
                                            Nano GND ----+----- Pi GND
                                         (Nano powered by Pi USB)
```

## Pi to Nano connection

Plug the Nano into any free Raspberry Pi USB port with a standard USB-A to
mini/micro USB cable (whichever the Nano variant uses). The Pi powers the
Nano over 5 V USB, and the same cable carries the control frames.

The udev rule in [../pi/udev/99-fpv-arduino.rules](../pi/udev/99-fpv-arduino.rules)
exposes the device as `/dev/fpv-arduino` regardless of enumeration order. The
rule matches the CH340 VID/PID `1a86:7523` by default. If your Nano uses an
FTDI chip (`0403:6001`) or a different bridge, look up the values with:

```bash
lsusb | grep -i -E 'ch340|ftdi|silicon|arduino'
# then check: ATTRS{idVendor} and ATTRS{idProduct}
```

and update the rule accordingly.

## Serial protocol

Stream-based, so every frame is self-delimited by a magic byte and a one-byte
XOR checksum. Baud defaults to 500000.

### Pi -> Nano control frame (10 bytes, little-endian)

| Offset | Type  | Field     | Range          |
| ------ | ----- | --------- | -------------- |
| 0      | u8    | magic     | `0xA5`         |
| 1-2    | i16   | throttle  | -1000..+1000   |
| 3-4    | i16   | steering  | -1000..+1000   |
| 5-6    | i16   | cam_yaw   | -1000..+1000   |
| 7-8    | i16   | cam_pitch | -1000..+1000   |
| 9      | u8    | xor       | XOR of [0..8]  |

Channel values are mapped to pulse widths using the `*_MIN_US` / `*_CTR_US` /
`*_MAX_US` / `*_INVERT` constants at the top of `rc-controller.ino`. Tune
end-stops there, not in the daemon.

### Nano -> Pi status reply (3 bytes)

Sent after each successfully applied frame.

| Offset | Type | Field               |
| ------ | ---- | ------------------- |
| 0      | u8   | magic `0x5A`        |
| 1      | u8   | frames_since_boot (rolls over at 256) |
| 2      | u8   | flags (bit 0 = failsafe active) |

## Failsafe

If the Nano receives no valid frame for `FAILSAFE_MS` (300 ms by default), it
centers steering and both camera servos and commands the throttle to stop.
`failsafeActive` clears the moment a valid frame is decoded again. The Pi
daemon has its own deadman at 250 ms; the Arduino value is deliberately
slightly longer so the Pi is always the first to notice.

## Flashing

### Arduino IDE

1. Tools -> Board -> Arduino AVR Boards -> Arduino Nano.
2. Tools -> Processor -> "ATmega328P" for genuine boards, or
   **"ATmega328P (Old Bootloader)"** for most clone Nanos (this is the common
   cause of `avrdude: stk500_getsync()` upload failures).
3. Tools -> Port -> whichever COM/tty the Nano enumerated on.
4. Open `arduino/rc-controller/rc-controller.ino` and press Upload.

### arduino-cli

```bash
arduino-cli core install arduino:avr
arduino-cli compile --fqbn arduino:avr:nano:cpu=atmega328old arduino/rc-controller
arduino-cli upload  --fqbn arduino:avr:nano:cpu=atmega328old -p /dev/ttyUSB0 arduino/rc-controller
```

Use `cpu=atmega328` (no `old`) if you have a genuine new-bootloader Nano.

## Bench-test without the Pi

A quick way to confirm the sketch is alive is to send a neutral frame from any
machine with Python and pyserial:

```python
import serial, struct
s = serial.Serial('/dev/ttyUSB0', 500000)
payload = struct.pack('<Bhhhh', 0xA5, 0, 0, 0, 0)
frame = payload + bytes([0xA5 ^ 0 ^ 0 ^ 0 ^ 0 ^ 0 ^ 0 ^ 0 ^ 0])
s.write(frame)
print(s.read(3).hex())   # should print "5a <count> 00"
```

If you slowly ramp the `throttle` argument from 0 to 500 you should see the ESC
channel move smoothly. Keep the wheels off the ground.
