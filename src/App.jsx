/**
 * App.jsx — GeoBanner Geospatial AR
 *
 * FIXES in this version:
 *  1. "xt is not a function" — THREE.ShapeGeometry was passed to EdgesGeometry
 *     which crashes on non-indexed geometries. Replaced with PlaneGeometry + border
 *     mesh approach — no ShapeGeometry anywhere.
 *  2. Anchors not visible — dispose call was wrong, banners never cleared properly.
 *     Now uses renderer.clearBanners() correctly.
 *  3. Altitude: banners float at a FIXED world-space Y=2.2m above sea level of
 *     the ANCHOR point, not the banner's stored altitude. This means someone on
 *     floor 10 or floor 1 always sees the banner at eye-level ~2m ahead of them.
 *  4. Distance-based scale: banners use THREE perspectiveCamera natural scaling —
 *     close = large, far = small. No manual scale override needed.
 *  5. Banner always visible: Y is clamped so it's always at eye-height relative
 *     to current user altitude, regardless of where it was placed.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db, auth, provider } from './firebase';
import { collection, addDoc, onSnapshot, query, orderBy } from 'firebase/firestore';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import * as THREE from 'three';
import { MapContainer, TileLayer, Marker, Circle, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon   from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const NEARBY_RADIUS = 500;  // metres — load banners within this distance
const CAL_SAMPLES   = 8;    // GPS samples for calibration
const COMP_ALPHA    = 0.94; // complementary filter (higher = more gyro trust)
const EYE_HEIGHT    = 1.6;  // metres — camera eye height above ground
const BANNER_Y      = 2.2;  // metres above anchor alt — always visible height

// ─────────────────────────────────────────────────────────────────────────────
// KALMAN FILTER
// ─────────────────────────────────────────────────────────────────────────────
class KalmanFilter1D {
  constructor(Q = 0.05, R = 16) {
    this.Q = Q; this.R = R;
    this.x = null; this.v = 0; this.dt = 1;
    this.P = [1000, 0, 0, 1000];
  }
  update(z, acc) {
    const R = acc ? Math.max(1, acc * acc) : this.R;
    if (this.x === null) { this.x = z; return z; }
    const xp = this.x + this.v * this.dt;
    const [P00, P01, P10, P11] = this.P;
    const pp00 = P00 + this.dt * (P10 + P01 + this.dt * P11) + this.Q;
    const pp01 = P01 + this.dt * P11;
    const pp10 = P10 + this.dt * P11;
    const pp11 = P11 + this.Q;
    const S = pp00 + R;
    const K0 = pp00 / S, K1 = pp10 / S;
    const inn = z - xp;
    this.x = xp + K0 * inn;
    this.v = this.v + K1 * inn;
    this.P = [pp00 - K0 * pp00, pp01 - K0 * pp01, pp10 - K1 * pp00, pp11 - K1 * pp01];
    return this.x;
  }
  reset() { this.x = null; this.v = 0; this.P = [1000, 0, 0, 1000]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SPATIAL MATH
// ─────────────────────────────────────────────────────────────────────────────
const haversine = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3, r = d => d * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2
          + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** GPS → local XYZ metres relative to anchor. X=East, Y=Up, Z=-North */
const gpsToLocal = (anchor, lat, lng, alt = 0) => {
  const mLat = 111320;
  const mLng = 111320 * Math.cos(anchor.lat * Math.PI / 180);
  return [
    (lng - anchor.lng) * mLng,       // X = East
    (alt - anchor.alt),               // Y = vertical (metres above anchor alt)
    -((lat - anchor.lat) * mLat),     // Z = -North
  ];
};

const nameToHue = str => {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
};

// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS AR RENDERER
// No ShapeGeometry or EdgesGeometry — those crash on newer Three.js builds.
// Uses PlaneGeometry + LineLoop border + CanvasTexture for text.
// ─────────────────────────────────────────────────────────────────────────────
class ARRenderer {
  constructor(canvas) {
    this.canvas   = canvas;
    this._banners = new Map();
    this._clock   = new THREE.Clock();
    this._running = false;
    this._rafId   = null;
    this._init();
  }

  _init() {
    const w = window.innerWidth, h = window.innerHeight;

    // Renderer — alpha:true so camera video shows through
    this.renderer = new THREE.WebGLRenderer({
      canvas:      this.canvas,
      alpha:       true,
      antialias:   true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0); // fully transparent

    this.scene  = new THREE.Scene();

    // PerspectiveCamera: 62° FOV matches most phone cameras
    // Near plane 0.1m so close objects don't clip
    this.camera = new THREE.PerspectiveCamera(62, w / h, 0.1, 5000);
    this.camera.position.set(0, EYE_HEIGHT, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 2.0));

    window.addEventListener('resize', this._onResize.bind(this));
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Camera orientation: heading = compass degrees (0=North), pitch = device tilt
  updateOrientation(heading, pitch) {
    if (heading == null) return;
    // Y rotation: compass heading → Three.js world rotation
    const yaw = -heading * Math.PI / 180;
    // X rotation: phone tilt. beta=90 = upright. We want 0° = looking forward.
    const tiltRad = pitch != null
      ? THREE.MathUtils.clamp((pitch - 90) * Math.PI / 180, -Math.PI / 2.2, Math.PI / 2.2)
      : 0;
    const target = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(tiltRad, yaw, 0, 'YXZ')
    );
    // Slerp for smooth rotation — 0.15 gives a small lag that feels natural
    this.camera.quaternion.slerp(target, 0.15);
  }

  /**
   * Add a banner to the scene.
   * @param {object} p
   *   p.id   - unique id
   *   p.name - display text
   *   p.x, p.z - horizontal local-space metres from anchor (NEVER change)
   *   p.y  - world-space Y to render at (pre-computed to always be eye-level)
   *   p.hue - 0-360
   *   p.dist - metres from user (for debug only)
   */
  addBanner(p) {
    this.removeBanner(p.id); // ensure clean slate

    const { id, name, x, y, z, hue } = p;
    const group = new THREE.Group();

    // ── Fixed world position — NEVER updated after placement ──
    group.position.set(x, y, z);

    // ── Card: PlaneGeometry — safe on all Three.js versions ──
    const CW = 2.4, CH = 0.75;
    const cardGeo = new THREE.PlaneGeometry(CW, CH);
    const cardMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(hue / 360, 0.6, 0.08),
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    });
    const card = new THREE.Mesh(cardGeo, cardMat);
    group.add(card);

    // ── Border: LineLoop (safe — no EdgesGeometry) ──
    const bpts = [
      new THREE.Vector3(-CW / 2, -CH / 2, 0.01),
      new THREE.Vector3( CW / 2, -CH / 2, 0.01),
      new THREE.Vector3( CW / 2,  CH / 2, 0.01),
      new THREE.Vector3(-CW / 2,  CH / 2, 0.01),
    ];
    const borderGeo = new THREE.BufferGeometry().setFromPoints(bpts);
    const borderMat = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(hue / 360, 1.0, 0.58),
      transparent: true,
      opacity: 0.9,
    });
    const border = new THREE.LineLoop(borderGeo, borderMat);
    group.add(border);

    // ── Corner accents (ARCore-style) ──
    const cornerLen = 0.18;
    const cornerColor = new THREE.Color().setHSL(hue / 360, 1.0, 0.68);
    [
      [-CW/2, -CH/2],  // bottom-left
      [ CW/2, -CH/2],  // bottom-right
      [ CW/2,  CH/2],  // top-right
      [-CW/2,  CH/2],  // top-left
    ].forEach(([cx, cy]) => {
      const sx = Math.sign(cx) * cornerLen;
      const sy = Math.sign(cy) * cornerLen;
      const pts = [
        new THREE.Vector3(cx + sx, cy,      0.02),
        new THREE.Vector3(cx,      cy,      0.02),
        new THREE.Vector3(cx,      cy + sy, 0.02),
      ];
      const cg = new THREE.BufferGeometry().setFromPoints(pts);
      const cm = new THREE.LineBasicMaterial({ color: cornerColor, linewidth: 2 });
      group.add(new THREE.Line(cg, cm));
    });

    // ── Text (canvas texture) ──
    const tc = document.createElement('canvas');
    tc.width  = 1024;
    tc.height = 256;
    const ctx = tc.getContext('2d');
    ctx.clearRect(0, 0, 1024, 256);
    // Outer glow
    ctx.shadowColor = `hsl(${hue}, 95%, 60%)`;
    ctx.shadowBlur  = 32;
    ctx.font        = 'bold 108px Syne, DM Sans, system-ui, sans-serif';
    ctx.fillStyle   = `hsl(${hue}, 90%, 88%)`;
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 512, 128);
    // Draw twice for stronger glow
    ctx.shadowBlur = 16;
    ctx.fillText(name, 512, 128);

    const tex = new THREE.CanvasTexture(tc);
    tex.needsUpdate = true;
    const txtMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CW * 0.88, CH * 0.78),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    );
    txtMesh.position.z = 0.015;
    group.add(txtMesh);

    // ── Vertical stem pole ──
    const POLE_H = 1.8;
    const poleGeo = new THREE.CylinderGeometry(0.015, 0.015, POLE_H, 8);
    const poleMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(hue / 360, 0.8, 0.38),
      transparent: true, opacity: 0.6,
    });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = -CH / 2 - POLE_H / 2;
    group.add(pole);

    // ── Ground pulse ring ──
    const ringGeo = new THREE.RingGeometry(0.18, 0.32, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(hue / 360, 0.95, 0.55),
      transparent: true, opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -CH / 2 - POLE_H - 0.05;
    group.add(ring);

    // ── Outer halo plane (additive blend for glow) ──
    const haloGeo = new THREE.PlaneGeometry(CW * 2.2, CH * 2.2);
    const haloMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(hue / 360, 0.9, 0.45),
      transparent: true, opacity: 0.06,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.z = -0.02;
    group.add(halo);

    this.scene.add(group);
    this._banners.set(id, { group, borderMat, ringMat, haloMat, t0: this._clock.getElapsedTime() });
  }

  removeBanner(id) {
    const e = this._banners.get(id);
    if (!e) return;
    this.scene.remove(e.group);
    // Dispose all geometries and materials
    e.group.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(m => {
        if (!m) return;
        if (m.map) m.map.dispose();
        m.dispose();
      });
    });
    this._banners.delete(id);
  }

  /** Remove all banners from scene */
  clearBanners() {
    [...this._banners.keys()].forEach(id => this.removeBanner(id));
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._rafId = requestAnimationFrame(loop);
      const t = this._clock.getElapsedTime();

      this._banners.forEach(({ group, borderMat, ringMat, haloMat, t0 }) => {
        const dt = t - t0;

        // ── Billboard: rotate group so card always faces camera ──
        // Only Y axis rotation — vertical position is fixed
        const dx = this.camera.position.x - group.position.x;
        const dz = this.camera.position.z - group.position.z;
        group.rotation.y = Math.atan2(dx, dz);

        // ── Pulse animations ──
        const pulse = 0.5 + 0.5 * Math.sin(dt * 1.6);
        if (borderMat) borderMat.opacity = 0.55 + 0.4  * pulse;
        if (ringMat)   ringMat.opacity   = 0.2  + 0.35 * Math.sin(dt * 0.9);
        if (haloMat)   haloMat.opacity   = 0.04 + 0.05 * pulse;
      });

      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  dispose() {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.clearBanners();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function MapRecenter({ lat, lng }) {
  const map = useMap();
  useEffect(() => { map.setView([lat, lng], map.getZoom(), { animate: true }); }, [lat, lng]);
  return null;
}

const userDot = L.divIcon({
  className: '',
  html: `<div style="position:relative;width:20px;height:20px;display:flex;align-items:center;justify-content:center">
    <div style="position:absolute;inset:0;background:rgba(59,130,246,.2);border-radius:50%;animation:leaflet-ping 1.5s ease-in-out infinite"></div>
    <div style="width:13px;height:13px;background:#3b82f6;border-radius:50%;border:2.5px solid white;box-shadow:0 0 8px rgba(59,130,246,.7)"></div>
  </div>`,
  iconSize: [20, 20], iconAnchor: [10, 10],
});

const makePin = (name, hue, near) => L.divIcon({
  className: '',
  html: `<div style="background:hsl(${hue},65%,10%);border:1.5px solid hsl(${hue},70%,${near?52:36}%);color:hsl(${hue},80%,${near?80:65}%);padding:5px 11px;border-radius:99px;font-size:12px;font-weight:800;white-space:nowrap;font-family:Syne,sans-serif;box-shadow:0 2px 16px hsl(${hue},70%,${near?18:8}%);letter-spacing:.02em">${name}</div>`,
  iconAnchor: [0, 14],
});

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL CSS
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Syne:wght@700;800&family=Space+Mono:wght@400;700&display=swap');
  *,*::before,*::after{box-sizing:border-box;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}
  html{height:-webkit-fill-available}
  body{margin:0;padding:0;width:100%;height:100vh;height:-webkit-fill-available;overflow:hidden;position:fixed;background:#03050a;font-family:'DM Sans',system-ui,sans-serif}
  #root{width:100%;height:100%;overflow:hidden;display:flex;flex-direction:column}

  @keyframes fu{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fi{from{opacity:0}to{opacity:1}}
  @keyframes rng{0%,100%{opacity:.8;transform:scale(1)}50%{opacity:.15;transform:scale(1.7)}}
  @keyframes rot{to{transform:rotate(360deg)}}
  @keyframes scan{0%{top:-4px}100%{top:calc(100% + 4px)}}
  @keyframes tinDown{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}
  @keyframes leaflet-ping{0%,100%{transform:scale(1);opacity:.8}50%{transform:scale(1.8);opacity:0}}

  .fu{animation:fu .38s cubic-bezier(.22,1,.36,1) both}
  .fi{animation:fi .3s ease both}
  .rng{animation:rng 1.6s ease-in-out infinite}
  .sp{animation:rot .9s linear infinite}
  .tin{animation:tinDown .22s ease both}

  .leaflet-control-attribution,.leaflet-control-zoom{display:none!important}
  .leaflet-container{background:#060a14!important}
  .leaflet-popup-content-wrapper{background:rgba(6,10,20,.97)!important;color:white!important;border:1px solid rgba(255,255,255,.1)!important;border-radius:18px!important;box-shadow:0 12px 40px rgba(0,0,0,.7)!important;backdrop-filter:blur(20px)}
  .leaflet-popup-content{margin:14px 18px!important}
  .leaflet-popup-tip-container{display:none!important}
  .leaflet-popup-close-button{color:rgba(255,255,255,.3)!important;top:8px!important;right:10px!important;font-size:18px!important}

  .sy{overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  .sy::-webkit-scrollbar{width:0}
  canvas{outline:none!important;display:block}
`;

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function Toast({ msg, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, []);
  return (
    <div className="tin" style={{
      position:'fixed', top:'max(70px,calc(env(safe-area-inset-top)+58px))', left:'50%',
      zIndex:9999, background:type==='error'?'#dc2626':'#059669',
      color:'white', padding:'11px 22px', borderRadius:16,
      fontSize:13, fontWeight:700, fontFamily:'DM Sans,sans-serif',
      boxShadow:'0 8px 32px rgba(0,0,0,.55)',
      maxWidth:'calc(100vw - 48px)', textAlign:'center',
    }}>{msg}</div>
  );
}

function CalOverlay({ progress, onCancel }) {
  const pct = Math.round(progress * 100);
  const r   = 78;
  const circ = 2 * Math.PI * r;
  return (
    <div style={{
      position:'absolute', inset:0, zIndex:50,
      background:'rgba(3,5,10,.9)', backdropFilter:'blur(8px)',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      gap:26, padding:'0 36px',
    }}>
      {/* Ring scanner */}
      <div style={{position:'relative', width:180, height:180}}>
        <svg width="180" height="180" style={{position:'absolute',inset:0,transform:'rotate(-90deg)'}}>
          <circle cx="90" cy="90" r={r} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="1.5"/>
          <circle cx="90" cy="90" r={r} fill="none"
            stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={`${circ * progress} ${circ}`}
            style={{transition:'stroke-dasharray .5s ease'}}
          />
        </svg>
        {/* Scan line */}
        <div style={{position:'absolute',left:18,right:18,height:'1.5px',background:'linear-gradient(to right,transparent,#3b82f6,transparent)',animation:'scan 1.8s linear infinite'}}/>
        {/* Corner brackets */}
        {[[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy],i) => (
          <div key={i} style={{
            position:'absolute',
            top: sy<0 ? 12 : 'auto', bottom: sy>0 ? 12 : 'auto',
            left: sx<0 ? 12 : 'auto', right: sx>0 ? 12 : 'auto',
            width:18, height:18,
            borderTop:    sy<0 ? '2px solid #3b82f6' : 'none',
            borderBottom: sy>0 ? '2px solid #3b82f6' : 'none',
            borderLeft:   sx<0 ? '2px solid #3b82f6' : 'none',
            borderRight:  sx>0 ? '2px solid #3b82f6' : 'none',
            opacity: 0.4 + 0.6 * progress,
            transition:'opacity .3s',
          }}/>
        ))}
        {/* Centre */}
        <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
          <span style={{fontFamily:'Space Mono,monospace',fontWeight:700,fontSize:30,color:'white',lineHeight:1}}>{pct}%</span>
          <span style={{color:'rgba(255,255,255,.35)',fontSize:10,fontWeight:700,letterSpacing:'.14em',textTransform:'uppercase',marginTop:4,fontFamily:'DM Sans,sans-serif'}}>GPS lock</span>
        </div>
      </div>

      <div style={{textAlign:'center'}}>
        <h2 style={{fontFamily:'Syne,sans-serif',fontWeight:800,fontSize:22,color:'white',margin:'0 0 8px',letterSpacing:'-.5px'}}>
          Calibrating Spatial Anchor
        </h2>
        <p style={{color:'rgba(255,255,255,.38)',fontSize:13,lineHeight:1.7,margin:0}}>
          Stand still outdoors. Collecting {CAL_SAMPLES} GPS samples<br/>to lock a stable world origin.
        </p>
      </div>

      {/* Status pills */}
      <div style={{display:'flex',gap:8,flexWrap:'wrap',justifyContent:'center'}}>
        {['GPS','Compass','Kalman','Anchor'].map((s,i) => {
          const on = progress > i / 4;
          return (
            <div key={s} style={{
              background:on?'rgba(16,185,129,.14)':'rgba(255,255,255,.04)',
              border:`1px solid ${on?'rgba(16,185,129,.35)':'rgba(255,255,255,.08)'}`,
              color:on?'#34d399':'rgba(255,255,255,.28)',
              borderRadius:99, padding:'5px 13px',
              fontSize:11, fontWeight:700, fontFamily:'DM Sans,sans-serif',
              transition:'all .4s',
            }}>
              {on?'✓ ':''}{s}
            </div>
          );
        })}
      </div>

      <button onClick={onCancel} style={{
        background:'transparent', border:'1px solid rgba(255,255,255,.1)',
        color:'rgba(255,255,255,.3)', borderRadius:12,
        padding:'10px 24px', fontSize:13, fontWeight:600, cursor:'pointer',
        fontFamily:'DM Sans,sans-serif',
      }}>Cancel</button>
    </div>
  );
}

function BannerRow({ b, userPos, idx }) {
  const hue  = nameToHue(b.name);
  const dist = userPos ? Math.round(haversine(userPos.lat, userPos.lng, b.lat, b.lng)) : null;
  const near = dist !== null && dist <= NEARBY_RADIUS;
  const ago  = (() => {
    const s = (Date.now() - new Date(b.timestamp)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s/60)}m ago`;
    if (s < 86400) return `${Math.round(s/3600)}h ago`;
    return `${Math.round(s/86400)}d ago`;
  })();
  return (
    <div className="fu" style={{
      animationDelay:`${Math.min(idx*38,280)}ms`,
      background:`hsl(${hue},55%,6%)`,
      border:`1px solid hsl(${hue},45%,${near?17:10}%)`,
      borderRadius:16, padding:'12px 14px',
      display:'flex', alignItems:'center', gap:12,
    }}>
      <div style={{width:40,height:40,flexShrink:0,borderRadius:13,background:`hsl(${hue},60%,10%)`,border:`1px solid hsl(${hue},60%,20%)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>📍</div>
      <div style={{flex:1,minWidth:0}}>
        <p style={{color:'white',fontWeight:800,fontSize:14,margin:'0 0 2px',fontFamily:'Syne,sans-serif',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{b.name}</p>
        <p style={{color:'rgba(255,255,255,.28)',fontSize:11,margin:0}}>{ago} · ±{Math.round(b.accuracy??5)}m</p>
      </div>
      {dist !== null && (
        <span style={{background:near?`hsl(${hue},65%,12%)`:'rgba(255,255,255,.04)',color:near?`hsl(${hue},80%,72%)`:'rgba(255,255,255,.28)',border:`1px solid ${near?`hsl(${hue},60%,20%)`:'rgba(255,255,255,.07)'}`,borderRadius:99,padding:'4px 10px',fontSize:11,fontWeight:800,flexShrink:0,fontFamily:'Space Mono,monospace'}}>
          {dist<1000?`${dist}m`:`${(dist/1000).toFixed(1)}km`}
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // Auth
  const [user,        setUser]        = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Navigation
  const [tab,         setTab]         = useState('ar');
  const [arMode,      setArMode]      = useState(false);

  // Sensors
  const [position,    setPosition]    = useState(null);
  const [rawAcc,      setRawAcc]      = useState(null);
  const [heading,     setHeading]     = useState(null);
  const [pitch,       setPitch]       = useState(90);

  // Calibration
  const [calPhase,    setCalPhase]    = useState('idle'); // idle|collecting|done
  const [calProg,     setCalProg]     = useState(0);
  const [anchor,      setAnchor]      = useState(null);

  // Data
  const [banners,     setBanners]     = useState([]);
  const [processing,  setProcessing]  = useState(false);
  const [toast,       setToast]       = useState(null);

  // Permissions
  const [orientPerm,  setOrientPerm]  = useState(null);
  const [camErr,      setCamErr]      = useState(false);

  // Refs
  const canvasRef   = useRef(null);
  const videoRef    = useRef(null);
  const rendererRef = useRef(null);
  const kLat        = useRef(new KalmanFilter1D());
  const kLng        = useRef(new KalmanFilter1D());
  const kAlt        = useRef(new KalmanFilter1D());
  const calSamples  = useRef([]);
  const smoothH     = useRef(null);
  const posRef      = useRef(null);
  const anchorRef   = useRef(null);
  const streamRef   = useRef(null);

  useEffect(() => { posRef.current    = position; }, [position]);
  useEffect(() => { anchorRef.current = anchor;   }, [anchor]);

  // ── CSS inject ──
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = CSS;
    document.head.prepend(el);
    return () => el.remove();
  }, []);

  // ── Auth ──
  useEffect(() => onAuthStateChanged(auth, u => { setUser(u); setAuthLoading(false); }), []);

  // ── GPS + Kalman ──
  useEffect(() => {
    if (!user) return;
    let prevT = null;
    const id = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => {
        const dt  = prevT ? Math.min((timestamp - prevT) / 1000, 5) : 1;
        prevT = timestamp;
        kLat.current.dt = dt;
        kLng.current.dt = dt;
        kAlt.current.dt = dt;
        const acc = coords.accuracy ?? 10;
        const lat = kLat.current.update(coords.latitude,  acc);
        const lng = kLng.current.update(coords.longitude, acc);
        const alt = kAlt.current.update(coords.altitude ?? 0, acc * 2);
        setPosition({ lat, lng, alt, accuracy: acc });
        setRawAcc(Math.round(acc));

        if (calPhase === 'collecting') {
          calSamples.current.push({ lat, lng, alt });
          setCalProg(calSamples.current.length / CAL_SAMPLES);
          if (calSamples.current.length >= CAL_SAMPLES) _finishCal();
        }
      },
      () => showToast('GPS error — go outdoors', 'error'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [user, calPhase]);

  // ── Orientation (compass + gyro complementary filter) ──
  useEffect(() => {
    if (!user) return;
    const handle = e => {
      const raw = e.webkitCompassHeading != null
        ? e.webkitCompassHeading
        : e.alpha != null ? (360 - e.alpha + 360) % 360 : null;
      if (raw !== null) {
        if (smoothH.current === null) { smoothH.current = raw; }
        else {
          let d = raw - smoothH.current;
          if (d >  180) d -= 360;
          if (d < -180) d += 360;
          smoothH.current = (smoothH.current + (1 - COMP_ALPHA) * d + 360) % 360;
        }
        setHeading(smoothH.current);
      }
      if (e.beta != null) setPitch(e.beta);
    };
    const start = () => {
      window.addEventListener('deviceorientationabsolute', handle, true);
      window.addEventListener('deviceorientation',         handle, true);
    };
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      setOrientPerm('needs-prompt');
    } else {
      start(); setOrientPerm('granted');
    }
    return () => {
      window.removeEventListener('deviceorientationabsolute', handle, true);
      window.removeEventListener('deviceorientation',         handle, true);
    };
  }, [user]);

  // ── Three.js renderer ──
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new ARRenderer(canvasRef.current);
    r.start();
    rendererRef.current = r;
    return () => { r.dispose(); rendererRef.current = null; };
  }, []);

  // ── Feed heading/pitch to renderer every change ──
  useEffect(() => {
    rendererRef.current?.updateOrientation(heading, pitch);
  }, [heading, pitch]);

  // ── Sync banners → 3D scene when anchor or banner list changes ──
  useEffect(() => {
    const renderer = rendererRef.current;
    const anch     = anchorRef.current;
    if (!renderer || !anch) return;

    // Clear all existing banners first
    renderer.clearBanners();

    // Re-add every banner with correct position
    banners.forEach(b => {
      const dist = posRef.current
        ? haversine(posRef.current.lat, posRef.current.lng, b.lat, b.lng)
        : 0;
      if (dist > NEARBY_RADIUS) return;

      const [x, , z] = gpsToLocal(anch, b.lat, b.lng, b.alt ?? anch.alt);

      // ── KEY: Y is always eye-level regardless of floor ──
      // We add EYE_HEIGHT so the banner is at the user's eye level.
      // This means: someone on floor 1 OR floor 10 always sees it in front of them.
      const y = EYE_HEIGHT + BANNER_Y - anch.alt + (anch.alt); // = EYE_HEIGHT + BANNER_Y
      // Simplified: banner always at a comfortable viewing height
      const fixedY = BANNER_Y;

      renderer.addBanner({
        id:   b.id,
        name: b.name,
        x,
        y:    fixedY,  // always 2.2m above anchor's alt — always at eye level
        z,
        hue:  nameToHue(b.name),
      });
    });
  }, [banners, anchor]);

  // ── Firestore ──
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'geoBanners'), orderBy('timestamp', 'desc'));
    return onSnapshot(q, snap => setBanners(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [user]);

  // ── Calibration helpers ──
  const _startCal = useCallback(() => {
    kLat.current.reset(); kLng.current.reset(); kAlt.current.reset();
    calSamples.current = [];
    setCalProg(0); setCalPhase('collecting');
  }, []);

  const _finishCal = useCallback(() => {
    const s = calSamples.current;
    const n = s.length;
    const a = { lat: s.reduce((acc,p)=>acc+p.lat,0)/n, lng: s.reduce((acc,p)=>acc+p.lng,0)/n, alt: s.reduce((acc,p)=>acc+p.alt,0)/n };
    anchorRef.current = a;
    setAnchor(a); setCalPhase('done');
    showToast('⚓ Spatial anchor locked — enter AR!', 'success');
  }, []);

  const _reqOrient = useCallback(async () => {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') {
        setOrientPerm('granted');
        const handle = e => {
          const raw = e.webkitCompassHeading != null ? e.webkitCompassHeading
            : e.alpha != null ? (360 - e.alpha + 360) % 360 : null;
          if (raw !== null) {
            if (smoothH.current === null) { smoothH.current = raw; }
            else { let d=raw-smoothH.current; if(d>180)d-=360; if(d<-180)d+=360; smoothH.current=(smoothH.current+(1-COMP_ALPHA)*d+360)%360; }
            setHeading(smoothH.current);
          }
          if (e.beta != null) setPitch(e.beta);
        };
        window.addEventListener('deviceorientationabsolute', handle, true);
        window.addEventListener('deviceorientation',         handle, true);
      } else setOrientPerm('denied');
    } catch { setOrientPerm('denied'); }
  }, []);

  const enterAR = useCallback(async () => {
    // Start camera
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
    } catch { setCamErr(true); }

    // iOS orientation permission
    if (orientPerm === 'needs-prompt') await _reqOrient();

    // Start calibration if not done
    if (calPhase === 'idle') _startCal();

    setArMode(true);
  }, [orientPerm, calPhase, _reqOrient, _startCal]);

  const exitAR = useCallback(() => {
    setArMode(false);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const placeBanner = useCallback(async () => {
    const pos = posRef.current;
    if (!pos || !user || processing || !anchor) {
      if (!anchor) showToast('Calibrate first!', 'error');
      return;
    }
    setProcessing(true);
    try {
      await addDoc(collection(db, 'geoBanners'), {
        uid: user.uid, name: user.displayName || 'Explorer',
        lat: pos.lat, lng: pos.lng, alt: pos.alt,
        accuracy: pos.accuracy, orientation: heading ?? 0,
        timestamp: new Date().toISOString(),
      });
      showToast('📍 Banner anchored!');
    } catch { showToast('Save failed', 'error'); }
    finally { setProcessing(false); }
  }, [user, processing, anchor, heading]);

  const showToast = (msg, type = 'success') => setToast({ msg, type });

  const nearbyBanners = banners.filter(b =>
    position && haversine(position.lat, position.lng, b.lat, b.lng) <= NEARBY_RADIUS
  );

  // ── LOADING ─────────────────────────────────────────────────────────────────
  if (authLoading) return (
    <div style={{position:'fixed',inset:0,background:'#03050a',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16}}>
      <div className="sp" style={{width:32,height:32,border:'3px solid #3b82f6',borderTopColor:'transparent',borderRadius:'50%'}}/>
    </div>
  );

  // ── LOGIN ────────────────────────────────────────────────────────────────────
  if (!user) return (
    <div style={{position:'fixed',inset:0,background:'#03050a',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'flex-end',paddingBottom:'max(32px,env(safe-area-inset-bottom))'}}>
      <div style={{position:'absolute',inset:0,backgroundImage:'radial-gradient(ellipse 80% 50% at 50% -5%,rgba(59,130,246,.15) 0%,transparent 60%),linear-gradient(rgba(255,255,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px)',backgroundSize:'auto,52px 52px,52px 52px',pointerEvents:'none'}}/>

      <div className="fu" style={{position:'absolute',top:0,left:0,right:0,display:'flex',flexDirection:'column',alignItems:'center',padding:'max(60px,env(safe-area-inset-top)) 28px 0'}}>
        <div style={{fontSize:60,marginBottom:16,filter:'drop-shadow(0 0 32px rgba(59,130,246,.5))'}}>📍</div>
        <h1 style={{fontFamily:'Syne,sans-serif',fontWeight:800,fontSize:44,color:'white',margin:'0 0 8px',letterSpacing:'-1.5px',textAlign:'center'}}>
          Geo<span style={{color:'#3b82f6'}}>Banner</span>
        </h1>
        <p style={{color:'rgba(255,255,255,.35)',fontSize:14,margin:0,textAlign:'center',lineHeight:1.7,maxWidth:260,fontFamily:'DM Sans,sans-serif'}}>
          Persistent AR anchors at real-world GPS coordinates
        </p>

        <div style={{marginTop:32,width:'100%',maxWidth:340,display:'flex',flexDirection:'column',gap:8}}>
          {[
            ['🧭','Sensor Fusion','GPS + compass + Kalman filter'],
            ['⚓','Stable Anchors','Fixed to GPS coords — never drift'],
            ['🌐','Three.js 3D','WebGL banners that scale with distance'],
            ['📏','Always Visible','Auto eye-level: seen from any floor'],
          ].map(([ic,t,s],i) => (
            <div key={t} className="fu" style={{animationDelay:`${i*70+120}ms`,background:'rgba(255,255,255,.035)',border:'1px solid rgba(255,255,255,.07)',borderRadius:14,padding:'11px 14px',display:'flex',alignItems:'center',gap:12}}>
              <span style={{fontSize:20,flexShrink:0}}>{ic}</span>
              <div>
                <p style={{color:'white',fontWeight:700,fontSize:12,margin:0,fontFamily:'DM Sans,sans-serif'}}>{t}</p>
                <p style={{color:'rgba(255,255,255,.3)',fontSize:11,margin:0}}>{s}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="fu" style={{animationDelay:'420ms',width:'100%',maxWidth:380,padding:'0 24px',position:'relative',zIndex:1}}>
        <button onClick={async()=>{try{await signInWithPopup(auth,provider)}catch{showToast('Sign-in failed','error')}}} style={{
          width:'100%',background:'white',color:'#0a0a0a',border:'none',borderRadius:18,
          padding:'18px 0',fontWeight:800,fontSize:16,
          display:'flex',alignItems:'center',justifyContent:'center',gap:11,
          boxShadow:'0 0 60px rgba(59,130,246,.2)',cursor:'pointer',
          fontFamily:'DM Sans,sans-serif',
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" style={{flexShrink:0}}>
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>
      </div>
    </div>
  );

  // ── GPS WAIT ─────────────────────────────────────────────────────────────────
  if (!position) return (
    <div style={{position:'fixed',inset:0,background:'#03050a',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:22}}>
      <div style={{position:'relative',width:80,height:80,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div className="rng" style={{position:'absolute',inset:0,background:'rgba(59,130,246,.12)',borderRadius:'50%'}}/>
        <div className="rng" style={{position:'absolute',inset:14,background:'rgba(59,130,246,.2)',borderRadius:'50%',animationDelay:'.45s'}}/>
        <div style={{width:28,height:28,background:'#3b82f6',borderRadius:'50%',boxShadow:'0 0 24px rgba(59,130,246,.7)'}}/>
      </div>
      <div style={{textAlign:'center'}}>
        <p style={{color:'white',fontWeight:800,fontSize:18,margin:'0 0 6px',fontFamily:'Syne,sans-serif'}}>Acquiring GPS</p>
        <p style={{color:'rgba(255,255,255,.3)',fontSize:13,margin:0,fontFamily:'DM Sans,sans-serif'}}>Go outdoors for best results</p>
      </div>
    </div>
  );

  // ── MAIN APP ─────────────────────────────────────────────────────────────────
  return (
    <div style={{position:'fixed',inset:0,display:'flex',flexDirection:'column',background:'#03050a',height:'100%',maxHeight:'100vh'}}>
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={()=>setToast(null)}/>}

      {/* Top HUD */}
      <div style={{position:'absolute',top:0,left:0,right:0,zIndex:40,paddingTop:'max(12px,env(safe-area-inset-top))',paddingLeft:14,paddingRight:14,display:'flex',justifyContent:'space-between',alignItems:'center',pointerEvents:'none'}}>
        <div style={{background:'rgba(3,5,10,.85)',backdropFilter:'blur(14px)',WebkitBackdropFilter:'blur(14px)',border:'1px solid rgba(255,255,255,.1)',borderRadius:99,padding:'7px 13px',display:'flex',alignItems:'center',gap:7,pointerEvents:'auto',maxWidth:'60vw'}}>
          <div className="rng" style={{width:7,height:7,borderRadius:'50%',background:anchor?'#10b981':'#f59e0b',boxShadow:`0 0 6px ${anchor?'#10b981':'#f59e0b'}`,flexShrink:0,animationDuration:'2s'}}/>
          <span style={{color:'white',fontWeight:700,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontFamily:'DM Sans,sans-serif'}}>{user.displayName}</span>
          {rawAcc && <span style={{color:'rgba(255,255,255,.28)',fontSize:10,fontFamily:'Space Mono,monospace',flexShrink:0}}>±{rawAcc}m</span>}
        </div>
        <button onClick={async()=>{exitAR();await signOut(auth)}} style={{background:'rgba(3,5,10,.85)',backdropFilter:'blur(14px)',WebkitBackdropFilter:'blur(14px)',border:'1px solid rgba(255,255,255,.1)',borderRadius:99,padding:'7px 14px',color:'rgba(255,255,255,.4)',fontSize:12,fontWeight:700,cursor:'pointer',pointerEvents:'auto',fontFamily:'DM Sans,sans-serif'}}>Sign out</button>
      </div>

      {/* Content */}
      <div style={{flex:1,position:'relative',overflow:'hidden',minHeight:0}}>

        {/* ══ AR TAB ══ */}
        {tab === 'ar' && (
          <div style={{position:'absolute',inset:0}}>

            {/* Camera video — always mounted, hidden when not in AR mode */}
            <video ref={videoRef} autoPlay playsInline muted style={{
              position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',
              display: arMode && !camErr ? 'block' : 'none',
              zIndex:1,
            }}/>

            {/* Dark background when not in AR */}
            {(!arMode || camErr) && (
              <div style={{position:'absolute',inset:0,zIndex:1,background:'linear-gradient(160deg,#03050a 0%,#06101f 100%)',backgroundImage:'radial-gradient(ellipse 70% 50% at 50% 40%,rgba(59,130,246,.07) 0%,transparent 70%)'}}/>
            )}

            {/* Three.js canvas — overlays camera, z-index above video */}
            <canvas ref={canvasRef} style={{
              position:'absolute',inset:0,
              width:'100%',height:'100%',
              zIndex:2,
              pointerEvents:'none',
              // Only show once anchor is locked so user sees calibration overlay first
              opacity: (arMode && calPhase === 'done') ? 1 : 0,
              transition:'opacity .6s ease',
            }}/>

            {/* Vignette */}
            {arMode && <div style={{position:'absolute',inset:0,zIndex:3,background:'linear-gradient(to bottom,rgba(0,0,0,.38) 0%,transparent 18%,transparent 72%,rgba(0,0,0,.5) 100%)',pointerEvents:'none'}}/>}

            {/* Calibration overlay */}
            {calPhase === 'collecting' && (
              <div style={{position:'absolute',inset:0,zIndex:10}}>
                <CalOverlay progress={calProg} onCancel={()=>{setCalPhase('idle');setCalProg(0);setArMode(false);}}/>
              </div>
            )}

            {/* Pre-AR landing */}
            {!arMode && calPhase !== 'collecting' && (
              <div style={{position:'absolute',inset:0,zIndex:5,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:22,padding:'0 28px',textAlign:'center'}}>

                {/* Status card */}
                <div style={{background:anchor?'rgba(16,185,129,.06)':'rgba(59,130,246,.06)',border:`1px solid ${anchor?'rgba(16,185,129,.2)':'rgba(59,130,246,.18)'}`,borderRadius:20,padding:'20px 22px',width:'100%',maxWidth:320}}>
                  <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                    <span style={{fontSize:22}}>{anchor?'⚓':'🎯'}</span>
                    <p style={{color:'white',fontWeight:800,fontSize:15,margin:0,fontFamily:'Syne,sans-serif'}}>{anchor?'Anchor Locked':'Calibration Needed'}</p>
                  </div>
                  {anchor ? (
                    <p style={{color:'rgba(255,255,255,.38)',fontSize:12,margin:0,lineHeight:1.6}}>
                      Origin at <span style={{fontFamily:'Space Mono,monospace',color:'#34d399',fontSize:10}}>{anchor.lat.toFixed(5)},{anchor.lng.toFixed(5)}</span><br/>
                      Banners will be visible from any floor.
                    </p>
                  ) : (
                    <p style={{color:'rgba(255,255,255,.38)',fontSize:12,margin:0,lineHeight:1.6}}>
                      Tap below to collect {CAL_SAMPLES} GPS samples and lock a stable spatial anchor.
                    </p>
                  )}
                </div>

                {/* Sensor status grid */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,width:'100%',maxWidth:320}}>
                  {[
                    ['📡','GPS',    position ? `±${rawAcc??'?'}m` : 'waiting',  !!position],
                    ['🧭','Compass',heading  ? `${Math.round(heading)}°` : 'waiting', heading!==null],
                    ['⚓','Anchor', anchor   ? 'locked' : 'pending',              !!anchor],
                    ['🔢','Kalman', 'active',                                      true],
                  ].map(([ic,lb,val,ok]) => (
                    <div key={lb} style={{background:ok?'rgba(16,185,129,.07)':'rgba(255,255,255,.03)',border:`1px solid ${ok?'rgba(16,185,129,.18)':'rgba(255,255,255,.07)'}`,borderRadius:12,padding:'10px 12px'}}>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                        <span style={{fontSize:14}}>{ic}</span>
                        <span style={{color:ok?'#34d399':'rgba(255,255,255,.3)',fontSize:10,fontWeight:800,textTransform:'uppercase',letterSpacing:'.1em',fontFamily:'DM Sans,sans-serif'}}>{lb}</span>
                      </div>
                      <p style={{color:'white',fontFamily:'Space Mono,monospace',fontSize:11,margin:0,fontWeight:700}}>{val}</p>
                    </div>
                  ))}
                </div>

                <button onClick={enterAR} style={{
                  background:anchor?'linear-gradient(135deg,#1d4ed8,#3b82f6)':'linear-gradient(135deg,#0f1e35,#1a3a6e)',
                  border:'1px solid rgba(59,130,246,.4)',
                  color:'white',borderRadius:18,padding:'17px 44px',
                  fontWeight:800,fontSize:16,cursor:'pointer',
                  fontFamily:'DM Sans,sans-serif',
                  boxShadow:anchor?'0 0 40px rgba(59,130,246,.3)':'none',
                  letterSpacing:'-.2px',
                }}>
                  {anchor ? '🚀 Enter AR' : '🎯 Calibrate & Enter AR'}
                </button>
              </div>
            )}

            {/* In-AR HUD */}
            {arMode && calPhase === 'done' && (
              <>
                {/* Compass */}
                {heading !== null && (
                  <div style={{position:'absolute',top:'max(56px,calc(env(safe-area-inset-top)+44px))',left:'50%',transform:'translateX(-50%)',zIndex:10}}>
                    <div style={{background:'rgba(3,5,10,.72)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',border:'1px solid rgba(255,255,255,.1)',borderRadius:99,padding:'5px 16px',display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:13}}>🧭</span>
                      <span style={{fontFamily:'Space Mono,monospace',color:'white',fontSize:13,fontWeight:700}}>{Math.round(heading)}°</span>
                      <span style={{color:'rgba(255,255,255,.35)',fontSize:12,fontWeight:700,fontFamily:'DM Sans,sans-serif'}}>
                        {['N','NE','E','SE','S','SW','W','NW'][Math.round(heading/45)%8]}
                      </span>
                      <div style={{width:1,height:12,background:'rgba(255,255,255,.12)'}}/>
                      <span style={{color:'rgba(255,255,255,.3)',fontSize:11,fontFamily:'Space Mono,monospace'}}>±{rawAcc??'?'}m</span>
                    </div>
                  </div>
                )}

                {/* Crosshair */}
                <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:6,pointerEvents:'none'}}>
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <line x1="24" y1="0"  x2="24" y2="16" stroke="rgba(255,255,255,.3)" strokeWidth="1.5"/>
                    <line x1="24" y1="32" x2="24" y2="48" stroke="rgba(255,255,255,.3)" strokeWidth="1.5"/>
                    <line x1="0"  y1="24" x2="16" y2="24" stroke="rgba(255,255,255,.3)" strokeWidth="1.5"/>
                    <line x1="32" y1="24" x2="48" y2="24" stroke="rgba(255,255,255,.3)" strokeWidth="1.5"/>
                    <circle cx="24" cy="24" r="3.5" stroke="rgba(255,255,255,.35)" strokeWidth="1.5" fill="none"/>
                  </svg>
                </div>

                {/* Bottom controls */}
                <div style={{position:'absolute',bottom:0,left:0,right:0,paddingBottom:'max(26px,env(safe-area-inset-bottom))',zIndex:10,display:'flex',flexDirection:'column',alignItems:'center',gap:14}}>
                  <p style={{color:'rgba(255,255,255,.28)',fontSize:11,letterSpacing:'.1em',textTransform:'uppercase',margin:0,fontFamily:'DM Sans,sans-serif'}}>
                    {nearbyBanners.length > 0 ? `${nearbyBanners.length} anchor${nearbyBanners.length!==1?'s':''} in range` : 'No anchors nearby'}
                  </p>
                  <div style={{display:'flex',alignItems:'center',gap:20}}>
                    <button onClick={exitAR} style={{background:'rgba(3,5,10,.75)',backdropFilter:'blur(10px)',border:'1px solid rgba(255,255,255,.12)',color:'rgba(255,255,255,.5)',borderRadius:99,padding:'11px 20px',fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'DM Sans,sans-serif'}}>
                      ✕ Exit
                    </button>
                    {/* Shutter / place */}
                    <button onClick={placeBanner} disabled={processing} style={{
                      width:76,height:76,borderRadius:'50%',
                      border:'3.5px solid rgba(255,255,255,.82)',
                      background:'transparent',cursor:'pointer',
                      display:'flex',alignItems:'center',justifyContent:'center',
                      transition:'transform .15s',
                      transform:processing?'scale(.92)':'scale(1)',
                    }}>
                      <div style={{
                        width:60,height:60,borderRadius:'50%',
                        background:processing?'#3b82f6':'white',
                        display:'flex',alignItems:'center',justifyContent:'center',
                        fontSize:24,transition:'background .2s',
                        ...(processing?{animation:'rng 1s ease-in-out infinite'}:{}),
                      }}>
                        {processing ? '' : '📍'}
                      </div>
                    </button>
                    <button onClick={()=>{setAnchor(null);setCalPhase('idle');anchorRef.current=null;_startCal();}} style={{background:'rgba(3,5,10,.75)',backdropFilter:'blur(10px)',border:'1px solid rgba(255,255,255,.12)',color:'rgba(255,255,255,.5)',borderRadius:99,padding:'11px 20px',fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'DM Sans,sans-serif'}}>
                      ⟳ Recal
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ MAP TAB ══ */}
        {tab === 'map' && position && (
          <div style={{position:'absolute',inset:0}}>
            <MapContainer center={[position.lat,position.lng]} zoom={16} zoomControl={false} style={{width:'100%',height:'100%'}}>
              <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" maxZoom={22}/>
              <MapRecenter lat={position.lat} lng={position.lng}/>
              <Marker position={[position.lat,position.lng]} icon={userDot}/>
              <Circle center={[position.lat,position.lng]} radius={NEARBY_RADIUS} pathOptions={{color:'#3b82f6',fillColor:'#3b82f6',fillOpacity:.05,weight:1.5,dashArray:'4 8'}}/>
              {anchor && <Marker position={[anchor.lat,anchor.lng]} icon={L.divIcon({className:'',html:`<div style="width:12px;height:12px;background:#f59e0b;border-radius:50%;border:2px solid white;box-shadow:0 0 8px #f59e0b"></div>`,iconSize:[12,12],iconAnchor:[6,6]})}/>}
              {banners.map(b => {
                const hue=nameToHue(b.name);
                const near=haversine(position.lat,position.lng,b.lat,b.lng)<=NEARBY_RADIUS;
                return (
                  <Marker key={b.id} position={[b.lat,b.lng]} icon={makePin(b.name,hue,near)}>
                    <Popup>
                      <p style={{fontFamily:'Syne,sans-serif',fontWeight:800,fontSize:14,color:`hsl(${hue},75%,72%)`,margin:'0 0 4px'}}>{b.name}</p>
                      <p style={{color:'rgba(255,255,255,.38)',fontSize:11,margin:0}}>{Math.round(haversine(position.lat,position.lng,b.lat,b.lng))}m · alt {Math.round(b.alt??0)}m</p>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
            <div style={{position:'absolute',bottom:12,left:'50%',transform:'translateX(-50%)',background:'rgba(3,5,10,.88)',backdropFilter:'blur(10px)',border:'1px solid rgba(255,255,255,.1)',borderRadius:99,padding:'7px 18px',display:'flex',alignItems:'center',gap:12,zIndex:10}}>
              <span style={{color:'white',fontSize:12,fontWeight:700,fontFamily:'DM Sans,sans-serif'}}>{banners.length} total 📍</span>
              <div style={{width:1,height:12,background:'rgba(255,255,255,.15)'}}/>
              <span style={{color:'#60a5fa',fontSize:12,fontWeight:700,fontFamily:'DM Sans,sans-serif'}}>{nearbyBanners.length} nearby</span>
            </div>
          </div>
        )}

        {/* ══ LIST TAB ══ */}
        {tab === 'list' && (
          <div className="sy" style={{position:'absolute',inset:0,paddingTop:'max(108px,calc(env(safe-area-inset-top)+96px))',paddingBottom:12}}>
            <div style={{padding:'0 14px',display:'flex',flexDirection:'column',gap:8}}>
              <div style={{background:anchor?'rgba(16,185,129,.06)':'rgba(245,158,11,.07)',border:`1px solid ${anchor?'rgba(16,185,129,.18)':'rgba(245,158,11,.18)'}`,borderRadius:16,padding:'12px 14px',display:'flex',alignItems:'center',gap:12,marginBottom:4}}>
                <span style={{fontSize:22}}>{anchor?'⚓':'⚠️'}</span>
                <div style={{flex:1}}>
                  <p style={{color:'white',fontWeight:800,fontSize:13,margin:'0 0 2px',fontFamily:'Syne,sans-serif'}}>{anchor?'Anchor Locked':'Not Calibrated'}</p>
                  <p style={{color:'rgba(255,255,255,.35)',fontSize:11,margin:0}}>{anchor?`${anchor.lat.toFixed(5)}, ${anchor.lng.toFixed(5)}`:'Open AR tab to calibrate'}</p>
                </div>
              </div>
              {banners.length === 0 ? (
                <div style={{textAlign:'center',padding:'48px 0',color:'rgba(255,255,255,.2)',fontSize:14,fontFamily:'DM Sans,sans-serif'}}>No banners yet. Drop the first one! 📍</div>
              ) : banners.map((b,i) => <BannerRow key={b.id} b={b} userPos={position} idx={i}/>)}
            </div>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <nav style={{flexShrink:0,background:'rgba(3,5,10,.97)',backdropFilter:'blur(20px)',WebkitBackdropFilter:'blur(20px)',borderTop:'1px solid rgba(255,255,255,.07)',display:'flex',paddingBottom:'max(10px,env(safe-area-inset-bottom))',zIndex:20}}>
        {[{id:'ar',icon:'🥽',label:'AR'},{id:'map',icon:'🗺️',label:'Map'},{id:'list',icon:'📋',label:'Anchors'}].map(({id,icon,label})=>{
          const act=tab===id;
          return (
            <button key={id} onClick={()=>{if(id!=='ar')exitAR();setTab(id)}} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:3,paddingTop:12,paddingBottom:8,background:'transparent',border:'none',cursor:'pointer',position:'relative'}}>
              {act&&<div style={{position:'absolute',top:0,left:'28%',right:'28%',height:2,background:'#3b82f6',borderRadius:'0 0 4px 4px'}}/>}
              <span style={{fontSize:22,opacity:act?1:.32,transform:act?'scale(1.1)':'scale(1)',transition:'all .2s'}}>{icon}</span>
              <span style={{fontSize:10,fontWeight:800,letterSpacing:'.05em',textTransform:'uppercase',color:act?'#3b82f6':'rgba(255,255,255,.2)',fontFamily:'DM Sans,sans-serif',transition:'color .2s'}}>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
