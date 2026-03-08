/**
 * KalmanFilter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 1D Kalman filter for smoothing GPS coordinates and sensor readings.
 *
 * State vector: [position, velocity]
 * Measurement: position (from GPS)
 *
 * This is the core of requirement #6 — sensor fusion / filtering to reduce
 * GPS noise and object jitter.
 */

export class KalmanFilter1D {
  /**
   * @param {object} opts
   * @param {number} opts.R  - Measurement noise covariance (GPS accuracy, metres²). Default 9 (±3m GPS)
   * @param {number} opts.Q  - Process noise covariance (how fast position can change). Default 0.1
   * @param {number} opts.dt - Time step seconds. Default 1
   */
  constructor({ R = 9, Q = 0.1, dt = 1 } = {}) {
    this.R  = R;   // measurement noise
    this.Q  = Q;   // process noise
    this.dt = dt;

    // State: [position, velocity]
    this.x = null;   // will be initialised on first measurement
    this.v = 0;      // velocity estimate

    // Error covariance matrix (2x2 flattened: [P00, P01, P10, P11])
    this.P = [1000, 0, 0, 1000];

    // State-transition matrix F = [[1, dt], [0, 1]]
    // Measurement matrix H = [1, 0]
  }

  /** Feed a raw GPS measurement. Returns smoothed position. */
  update(measurement, accuracy) {
    // Adapt measurement noise to reported GPS accuracy (metres)
    const R = accuracy ? accuracy * accuracy : this.R;

    if (this.x === null) {
      // First measurement — initialise state directly
      this.x = measurement;
      return measurement;
    }

    // ── PREDICT ──
    // x_pred = F * x = [x + v*dt, v]
    const x_pred = this.x + this.v * this.dt;
    const v_pred = this.v;

    // P_pred = F*P*F' + Q*I
    const [P00, P01, P10, P11] = this.P;
    const pp00 = P00 + this.dt * P10 + this.dt * P01 + this.dt * this.dt * P11 + this.Q;
    const pp01 = P01 + this.dt * P11;
    const pp10 = P10 + this.dt * P11;
    const pp11 = P11 + this.Q;

    // ── UPDATE ──
    // Innovation: y = measurement - H*x_pred = measurement - x_pred
    const y = measurement - x_pred;

    // Innovation covariance: S = H*P_pred*H' + R = pp00 + R
    const S = pp00 + R;

    // Kalman gain: K = P_pred*H' / S → K = [pp00/S, pp10/S]
    const K0 = pp00 / S;
    const K1 = pp10 / S;

    // Updated state
    this.x = x_pred + K0 * y;
    this.v = v_pred + K1 * y;

    // Updated covariance: P = (I - K*H) * P_pred
    this.P = [
      pp00 - K0 * pp00, pp01 - K0 * pp01,
      pp10 - K1 * pp00, pp11 - K1 * pp01,
    ];

    return this.x;
  }

  reset() {
    this.x = null;
    this.v = 0;
    this.P = [1000, 0, 0, 1000];
  }
}

/**
 * GeoKalmanFilter
 * Wraps two KalmanFilter1D instances (lat + lng) and handles
 * coordinate-space consistency.
 */
export class GeoKalmanFilter {
  constructor() {
    // Tighter process noise = more smoothing, slower to react to real movement
    this.lat = new KalmanFilter1D({ Q: 0.05, R: 16 });
    this.lng = new KalmanFilter1D({ Q: 0.05, R: 16 });
    this.alt = new KalmanFilter1D({ Q: 0.1,  R: 25 });
    this._samples = 0;
    this._lastTime = null;
  }

  /**
   * @param {{ lat, lng, alt, accuracy }} pos
   * @returns {{ lat, lng, alt }}  filtered position
   */
  update({ lat, lng, alt = 0, accuracy = 5 }) {
    const now = Date.now();
    if (this._lastTime) {
      const dt = (now - this._lastTime) / 1000;
      this.lat.dt = dt;
      this.lng.dt = dt;
      this.alt.dt = dt;
    }
    this._lastTime = now;
    this._samples++;

    return {
      lat:      this.lat.update(lat, accuracy),
      lng:      this.lng.update(lng, accuracy),
      alt:      this.alt.update(alt, accuracy * 2), // altitude is always noisier
      samples:  this._samples,
    };
  }

  get isWarmedUp() { return this._samples >= 8; }

  reset() {
    this.lat.reset();
    this.lng.reset();
    this.alt.reset();
    this._samples = 0;
    this._lastTime = null;
  }
}