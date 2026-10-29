/*
 * FPV RC Controller - Arduino Nano (ATmega328P)
 *
 * Acts as a serial slave that receives 10-byte control frames from the
 * Raspberry Pi over USB-CDC and drives four PWM outputs:
 *   - D9  throttle / ESC
 *   - D10 steering servo
 *   - D5  camera yaw servo
 *   - D6  camera pitch servo
 *
 * Frame format (little-endian, 10 bytes):
 *   [0]    magic 0xA5
 *   [1-2]  int16 throttle  (-1000..+1000)
 *   [3-4]  int16 steering  (-1000..+1000)
 *   [5-6]  int16 cam_yaw   (-1000..+1000)
 *   [7-8]  int16 cam_pitch (-1000..+1000)
 *   [9]    XOR checksum of bytes [0..8]
 *
 * After each applied frame the Nano writes a 3-byte status reply back
 * over serial so the Pi can surface link health in telemetry:
 *   [0]    magic 0x5A
 *   [1]    uint8  frames_since_boot & 0xFF
 *   [2]    uint8  flags (bit 0 = failsafe_active)
 *
 * If no valid frame arrives within FAILSAFE_MS the outputs recenter and
 * the throttle is set to stop. This is a second safety layer that runs
 * even if the Pi daemon hangs.
 */

#include <Servo.h>

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

// Baud must match SERIAL_BAUD in the Pi daemon. 500000 is reliable on the
// CH340/FT232 Nano variants; fall back to 115200 if you see framing errors.
static const uint32_t SERIAL_BAUD = 500000UL;

// Pin assignments (all must be PWM-capable on the ATmega328P).
static const uint8_t PIN_THROTTLE  = 9;
static const uint8_t PIN_STEERING  = 10;
static const uint8_t PIN_CAM_YAW   = 5;
static const uint8_t PIN_CAM_PITCH = 6;

// Per-channel pulse-width calibration in microseconds.
// Edit these to match your ESC and servos; they do not need to be symmetric.
#define THROTTLE_MIN_US   1000   // full reverse (or stop for uni-directional ESC)
#define THROTTLE_CTR_US   1500   // stop / neutral
#define THROTTLE_MAX_US   2000   // full forward
#define THROTTLE_INVERT   0

#define STEERING_MIN_US   1000
#define STEERING_CTR_US   1500
#define STEERING_MAX_US   2000
#define STEERING_INVERT   0

#define CAM_YAW_MIN_US    1000
#define CAM_YAW_CTR_US    1500
#define CAM_YAW_MAX_US    2000
#define CAM_YAW_INVERT    0

#define CAM_PITCH_MIN_US  1000
#define CAM_PITCH_CTR_US  1500
#define CAM_PITCH_MAX_US  2000
#define CAM_PITCH_INVERT  0

// Safety
static const uint16_t FAILSAFE_MS = 300;   // recenter if no valid frame for this long

// Protocol constants
static const uint8_t  FRAME_MAGIC  = 0xA5;
static const uint8_t  STATUS_MAGIC = 0x5A;
static const uint8_t  FRAME_SIZE   = 10;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

static Servo throttleServo;
static Servo steeringServo;
static Servo camYawServo;
static Servo camPitchServo;

// Self-resyncing byte buffer: we keep the last FRAME_SIZE bytes and try to
// decode whenever the oldest byte is the magic. If the checksum fails we
// slide forward one byte and try again - no explicit state machine needed.
static uint8_t  rxBuf[FRAME_SIZE];
static uint8_t  rxLen = 0;

static uint32_t lastValidFrameMs = 0;
static uint8_t  framesSinceBoot = 0;
static bool     failsafeActive  = true;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Map a signed -1000..+1000 channel value to its pulse-width range, honoring
// an optional invert flag and asymmetric min/ctr/max calibration.
static uint16_t channelToPulse(int16_t value,
                               uint16_t minUs,
                               uint16_t ctrUs,
                               uint16_t maxUs,
                               uint8_t invert) {
  if (value > 1000)  value = 1000;
  if (value < -1000) value = -1000;
  if (invert) value = -value;

  int32_t pulse;
  if (value >= 0) {
    pulse = (int32_t)ctrUs + ((int32_t)(maxUs - ctrUs) * value) / 1000;
  } else {
    pulse = (int32_t)ctrUs + ((int32_t)(ctrUs - minUs) * value) / 1000;
  }
  if (pulse < minUs) pulse = minUs;
  if (pulse > maxUs) pulse = maxUs;
  return (uint16_t)pulse;
}

static void writeChannels(int16_t throttle,
                          int16_t steering,
                          int16_t camYaw,
                          int16_t camPitch) {
  throttleServo.writeMicroseconds(
      channelToPulse(throttle, THROTTLE_MIN_US, THROTTLE_CTR_US, THROTTLE_MAX_US, THROTTLE_INVERT));
  steeringServo.writeMicroseconds(
      channelToPulse(steering, STEERING_MIN_US, STEERING_CTR_US, STEERING_MAX_US, STEERING_INVERT));
  camYawServo.writeMicroseconds(
      channelToPulse(camYaw, CAM_YAW_MIN_US, CAM_YAW_CTR_US, CAM_YAW_MAX_US, CAM_YAW_INVERT));
  camPitchServo.writeMicroseconds(
      channelToPulse(camPitch, CAM_PITCH_MIN_US, CAM_PITCH_CTR_US, CAM_PITCH_MAX_US, CAM_PITCH_INVERT));
}

static void applySafeState() {
  throttleServo.writeMicroseconds(THROTTLE_CTR_US);
  steeringServo.writeMicroseconds(STEERING_CTR_US);
  camYawServo.writeMicroseconds(CAM_YAW_CTR_US);
  camPitchServo.writeMicroseconds(CAM_PITCH_CTR_US);
}

static void sendStatus() {
  uint8_t reply[3];
  reply[0] = STATUS_MAGIC;
  reply[1] = framesSinceBoot;
  reply[2] = failsafeActive ? 0x01 : 0x00;
  Serial.write(reply, sizeof(reply));
}

// Decode the 10 bytes currently in rxBuf. Returns true on a good frame.
static bool tryDecodeFrame() {
  if (rxBuf[0] != FRAME_MAGIC) return false;

  uint8_t xorSum = 0;
  for (uint8_t i = 0; i < FRAME_SIZE - 1; i++) xorSum ^= rxBuf[i];
  if (xorSum != rxBuf[FRAME_SIZE - 1]) return false;

  int16_t throttle = (int16_t)(rxBuf[1] | ((uint16_t)rxBuf[2] << 8));
  int16_t steering = (int16_t)(rxBuf[3] | ((uint16_t)rxBuf[4] << 8));
  int16_t camYaw   = (int16_t)(rxBuf[5] | ((uint16_t)rxBuf[6] << 8));
  int16_t camPitch = (int16_t)(rxBuf[7] | ((uint16_t)rxBuf[8] << 8));

  writeChannels(throttle, steering, camYaw, camPitch);
  lastValidFrameMs = millis();
  framesSinceBoot++;
  failsafeActive = false;
  return true;
}

// Slide the buffer one byte to the left so we can re-check for magic.
static void slideBufferOne() {
  for (uint8_t i = 1; i < rxLen; i++) rxBuf[i - 1] = rxBuf[i];
  rxLen--;
}

// -----------------------------------------------------------------------------
// Arduino lifecycle
// -----------------------------------------------------------------------------

void setup() {
  Serial.begin(SERIAL_BAUD);

  throttleServo.attach(PIN_THROTTLE,  THROTTLE_MIN_US, THROTTLE_MAX_US);
  steeringServo.attach(PIN_STEERING,  STEERING_MIN_US, STEERING_MAX_US);
  camYawServo.attach(PIN_CAM_YAW,     CAM_YAW_MIN_US,  CAM_YAW_MAX_US);
  camPitchServo.attach(PIN_CAM_PITCH, CAM_PITCH_MIN_US, CAM_PITCH_MAX_US);

  applySafeState();
  lastValidFrameMs = millis();
}

void loop() {
  while (Serial.available() > 0) {
    if (rxLen < FRAME_SIZE) {
      rxBuf[rxLen++] = (uint8_t)Serial.read();
    } else {
      slideBufferOne();
      rxBuf[rxLen++] = (uint8_t)Serial.read();
    }

    if (rxLen == FRAME_SIZE) {
      if (tryDecodeFrame()) {
        rxLen = 0;
        sendStatus();
      } else {
        slideBufferOne();
      }
    }
  }

  if (!failsafeActive && (millis() - lastValidFrameMs) > FAILSAFE_MS) {
    failsafeActive = true;
    applySafeState();
  }
}
