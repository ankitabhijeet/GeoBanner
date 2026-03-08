/**
 * SensorFusion.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Combines GPS, gyroscope, accelerometer, and magnetometer into a unified
 * stable pose estimate. Implements requirement #3.
 *
 * Architecture:
 *   GPS          → KalmanFilter → filtered position (updates ~1Hz)
 *   Gyroscope    → dead-reckoning between GPS fixes
 *   Magnetometer → compass heading (fused with gyro via complementary filter)
 *   Accelerometer → tilt-compensated heading
 *
 * The key insight: GPS updates are infrequent and noisy.
 * Between GPS fixes, we propagate position using gyro dead-reckoning,
 * which is fast and smooth. When GPS arrives, we correct the estimate.
 */

import { GeoKalmanFilter } from './KalmanFilter.js';

// Complementary filter coefficient: 0.98 = trust gyro 98%, mag 2% each frame
const COMP_ALPHA = 0.98;

export class SensorFusion extends EventTarget {
  constructor() {
    super();

    this.kalman   = new GeoKalmanFilter();
    this.position = null;   // { lat, lng, alt, accuracy }
    this.heading  = null;   // degrees 0–360, true north
    this.pitch    = 0;      // degrees, device tilt
    this.roll     = 0;
    this.tilt     = 0;      // simplified vertical tilt

    // Gyroscope state for dead-reckoning
    this._gyroHeading = null;
    this._magHeading  = null;
    this._lastGyroT   = null;

    // Calibration state
    this.calibrated   = false;
    this._calSamples  = [];
    this._calRequired = 12;  // samples needed

    // Watchers
    this._gpsWatchId   = null;
    this._listeners    = [];
    this._running      = false;
  }

  // ── PUBLIC API ──────────────────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    this._startGPS();
    await this._startOrientation();
  }

  stop() {
    this._running = false;
    if (this._gpsWatchId) navigator.geolocation.clearWatch(this._gpsWatchId);
    this._listeners.forEach(([ev, fn, tgt]) => tgt.removeEventListener(ev, fn, true));
    this._listeners = [];
  }

  /** Begin calibration phase — collects GPS samples and checks sensor variance */
  startCalibration() {
    this.calibrated  = false;
    this._calSamples = [];
    this.kalman.reset();
    this.dispatchEvent(new CustomEvent('calibrationStart'));
  }

  get calibrationProgress() {
    return Math.min(1, this._calSamples.length / this._calRequired);
  }

  // ── GPS ─────────────────────────────────────────────────────────────────────

  _startGPS() {
    if (!navigator.geolocation) return;

    const onPos = ({ coords, timestamp }) => {
      const raw = {
        lat:      coords.latitude,
        lng:      coords.longitude,
        alt:      coords.altitude      ?? 0,
        accuracy: coords.accuracy,
        ts:       timestamp,
      };

      // Run through Kalman filter
      const filtered = this.kalman.update(raw);
      this.position  = { ...filtered, accuracy: raw.accuracy, ts: timestamp };

      // Calibration sample collection
      if (!this.calibrated) {
        this._addCalSample(filtered);
      }

      this.dispatchEvent(new CustomEvent('position', { detail: this.position }));
    };

    const onErr = (err) => {
      this.dispatchEvent(new CustomEvent('gpsError', { detail: err }));
    };

    this._gpsWatchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    });
  }

  _addCalSample(pos) {
    this._calSamples.push(pos);
    this.dispatchEvent(new CustomEvent('calibrationProgress', {
      detail: { progress: this.calibrationProgress, count: this._calSamples.length }
    }));

    if (this._calSamples.length >= this._calRequired) {
      this._finishCalibration();
    }
  }

  _finishCalibration() {
    // Compute centroid of calibration samples (removes outliers via Kalman warmup)
    const n   = this._calSamples.length;
    const lat = this._calSamples.reduce((s, p) => s + p.lat, 0) / n;
    const lng = this._calSamples.reduce((s, p) => s + p.lng, 0) / n;
    const alt = this._calSamples.reduce((s, p) => s + p.alt, 0) / n;

    // Compute spatial variance — tells us how "settled" the GPS is
    const varLat = this._calSamples.reduce((s, p) => s + (p.lat - lat) ** 2, 0) / n;
    const varLng = this._calSamples.reduce((s, p) => s + (p.lng - lng) ** 2, 0) / n;
    const stdM   = Math.sqrt(varLat + varLng) * 111320; // approx metres

    this.calibrated   = true;
    this._anchorPos   = { lat, lng, alt }; // reference point for local XYZ

    this.dispatchEvent(new CustomEvent('calibrationDone', {
      detail: { anchor: this._anchorPos, stdMetres: stdM }
    }));
  }

  // ── ORIENTATION (gyro + mag + accel) ─────────────────────────────────────

  async _startOrientation() {
    // Request iOS 13+ permission
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          this.dispatchEvent(new CustomEvent('permissionDenied', { detail: 'orientation' }));
          return;
        }
      } catch {
        this.dispatchEvent(new CustomEvent('permissionDenied', { detail: 'orientation' }));
        return;
      }
    }

    const onAbsOrientation = (e) => this._handleOrientation(e, true);
    const onOrientation    = (e) => this._handleOrientation(e, false);

    window.addEventListener('deviceorientationabsolute', onAbsOrientation, true);
    window.addEventListener('deviceorientation',         onOrientation,    true);

    this._listeners.push(
      ['deviceorientationabsolute', onAbsOrientation, window],
      ['deviceorientation',         onOrientation,    window],
    );
  }

  _handleOrientation(e, isAbsolute) {
    // ── Magnetometer / compass heading ──
    // webkitCompassHeading: iOS native compass (degrees from true north, 0–360)
    // alpha: rotation around Z-axis. For absolute events, this IS true heading
    let magH = null;
    if (e.webkitCompassHeading != null) {
      magH = e.webkitCompassHeading;
    } else if (isAbsolute && e.alpha != null) {
      magH = (360 - e.alpha + 360) % 360;
    } else if (e.alpha != null) {
      // Relative — less reliable but usable
      magH = (360 - e.alpha + 360) % 360;
    }

    if (magH !== null) this._magHeading = magH;

    // ── Tilt ──
    this.pitch = e.beta  ?? 0;   // -180 to 180, 0 = horizontal face-up
    this.roll  = e.gamma ?? 0;   // -90 to 90

    // Simplified "how vertical is the phone" — used for AR label height
    // beta=90 = phone upright like a camera, beta=0 = flat on table
    this.tilt = e.beta ?? 90;

    // ── Complementary filter: fuse gyro (if available) with magnetometer ──
    // If we only have magnetometer, use it directly but low-pass smooth it
    if (this._gyroHeading === null) {
      this._gyroHeading = this._magHeading ?? 0;
    }

    if (this._magHeading !== null) {
      // Shortest-path angle blend to avoid 359°→1° wrapping artifacts
      let diff = this._magHeading - this._gyroHeading;
      if (diff >  180) diff -= 360;
      if (diff < -180) diff += 360;

      // Complementary: heavily trust gyro (smooth), nudge toward mag (accurate)
      this._gyroHeading = (this._gyroHeading + (1 - COMP_ALPHA) * diff + 360) % 360;
    }

    this.heading = this._gyroHeading;

    this.dispatchEvent(new CustomEvent('orientation', {
      detail: { heading: this.heading, pitch: this.pitch, roll: this.roll, tilt: this.tilt }
    }));
  }

  // ── UTILITIES ──────────────────────────────────────────────────────────────

  /**
   * Convert a GPS anchor to local XYZ metres relative to current user position.
   * X = East, Y = Up, Z = -North (OpenGL convention)
   */
  gpsToLocal(anchorLat, anchorLng, anchorAlt = 0) {
    if (!this.position) return [0, 0, 0];
    const { lat, lng, alt } = this.position;
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
    const x =  (anchorLng - lng) * metersPerDegLng;
    const y  = (anchorAlt - alt);
    const z  = -((anchorLat - lat) * metersPerDegLat); // -Z = north
    return [x, y, z];
  }

  /**
   * Haversine distance in metres
   */
  static distance(lat1, lon1, lat2, lon2) {
    const R = 6371e3, r = d => d * Math.PI / 180;
    const a = Math.sin(r(lat2 - lat1) / 2) ** 2
            + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Bearing from user to target (degrees, 0 = North)
   */
  static bearing(lat1, lon1, lat2, lon2) {
    const r  = d => d * Math.PI / 180;
    const dL = r(lon2 - lon1);
    const x  = Math.sin(dL) * Math.cos(r(lat2));
    const y  = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(dL);
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
  }
}