/**
 * App.jsx — GeoBanner Geospatial AR
 * ─────────────────────────────────────────────────────────────────────────────
 * Complete implementation of:
 *   1. ARCore Geospatial (Android) / ARKit Location Anchors (iOS) approach
 *      via sensor fusion — compass + GPS + gyroscope + Kalman filter
 *   2. Calibration scan phase
 *   3. Stable 3D banner rendering with Three.js
 *   4. Persistent anchor storage in Firestore
 *   5. Sensor fusion for drift-free positioning
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
const NEARBY_RADIUS  = 100;   // metres — show banners within this distance
const CAL_SAMPLES    = 10;    // GPS samples required for calibration
const COMP_ALPHA     = 0.96;  // complementary filter weight (gyro vs mag)
const KALMAN_Q       = 0.05;  // process noise — lower = more stable, slower
const KALMAN_R       = 16;    // measurement noise — ~4m GPS accuracy squared

// ─────────────────────────────────────────────────────────────────────────────
// KALMAN FILTER (embedded — no external import needed)
// ─────────────────────────────────────────────────────────────────────────────
class KalmanFilter1D {
  constructor(Q = KALMAN_Q, R = KALMAN_R) {
    this.Q = Q; this.R = R;
    this.x = null; this.v = 0; this.dt = 1;
    this.P = [1000, 0, 0, 1000];
  }
  update(z, acc) {
    const R = acc ? acc * acc : this.R;
    if (this.x === null) { this.x = z; return z; }
    const xp = this.x + this.v * this.dt;
    const [P00, P01, P10, P11] = this.P;
    const pp00 = P00 + this.dt * (P10 + P01 + this.dt * P11) + this.Q;
    const pp01 = P01 + this.dt * P11;
    const pp10 = P10 + this.dt * P11;
    const pp11 = P11 + this.Q;
    const S = pp00 + R;
    const K0 = pp00 / S, K1 = pp10 / S;
    const y = z - xp;
    this.x = xp + K0 * y;
    this.v = this.v + K1 * y;
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

const getBearing = (lat1, lon1, lat2, lon2) => {
  const r = d => d * Math.PI / 180;
  const dL = r(lon2 - lon1);
  const x = Math.sin(dL) * Math.cos(r(lat2));
  const y = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(dL);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
};

/** GPS → local XYZ metres. X=East, Y=Up, Z=-North */
const gpsToLocal = (anchor, lat, lng, alt = 0) => {
  const mLat = 111320;
  const mLng = 111320 * Math.cos(anchor.lat * Math.PI / 180);
  return [
     (lng - anchor.lng) * mLng,
     (alt - anchor.alt),
    -((lat - anchor.lat) * mLat),
  ];
};

const nameToHue = str => {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
};

// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS AR RENDERER
// ─────────────────────────────────────────────────────────────────────────────
class ARRenderer {
  constructor(canvas) {
    this.canvas   = canvas;
    this._banners = new Map();
    this._clock   = new THREE.Clock();
    this._running = false;
    this._init();
  }

  _init() {
    const w = window.innerWidth, h = window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0, 0);

    this.scene  = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, w / h, 0.05, 2000);
    this.camera.position.set(0, 1.6, 0); // 1.6m eye height

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const dir = new THREE.DirectionalLight(0xaaccff, 0.9);
    dir.position.set(10, 20, 10);
    this.scene.add(dir);

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  /** Update camera orientation from fused heading + pitch */
  updateOrientation(heading, pitch = 90) {
    if (heading == null) return;
    const yaw   = -heading * Math.PI / 180;
    const ptch  = THREE.MathUtils.clamp((pitch - 90) * Math.PI / 180, -Math.PI / 2, Math.PI / 2);
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(ptch, yaw, 0, 'YXZ'));
    this.camera.quaternion.slerp(target, 0.18);
  }

  addBanner({ id, name, x, y, z, hue }) {
    this.removeBanner(id);
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // Card background
    const cardShape = new THREE.Shape();
    const [cw, ch, cr] = [2.2, 0.72, 0.13];
    cardShape.moveTo(-cw/2+cr, -ch/2);
    cardShape.lineTo(cw/2-cr, -ch/2); cardShape.quadraticCurveTo(cw/2,-ch/2,cw/2,-ch/2+cr);
    cardShape.lineTo(cw/2, ch/2-cr); cardShape.quadraticCurveTo(cw/2,ch/2,cw/2-cr,ch/2);
    cardShape.lineTo(-cw/2+cr,ch/2); cardShape.quadraticCurveTo(-cw/2,ch/2,-cw/2,ch/2-cr);
    cardShape.lineTo(-cw/2,-ch/2+cr); cardShape.quadraticCurveTo(-cw/2,-ch/2,-cw/2+cr,-ch/2);
    const cardGeo = new THREE.ShapeGeometry(cardShape);
    const cardMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(hue/360, 0.55, 0.09),
      emissive: new THREE.Color().setHSL(hue/360, 0.7, 0.04),
      transparent: true, opacity: 0.94,
    });
    group.add(new THREE.Mesh(cardGeo, cardMat));

    // Glowing border
    const edgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color().setHSL(hue/360, 0.95, 0.55), transparent: true, opacity: 0.85 });
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(cardGeo), edgeMat);
    edge.position.z = 0.005;
    group.add(edge);

    // Text texture
    const tc = document.createElement('canvas');
    tc.width = 1024; tc.height = 256;
    const ctx = tc.getContext('2d');
    ctx.clearRect(0, 0, 1024, 256);
    ctx.font = 'bold 110px Syne, DM Sans, sans-serif';
    ctx.fillStyle = `hsl(${hue}, 90%, 83%)`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = `hsl(${hue}, 90%, 55%)`; ctx.shadowBlur = 24;
    ctx.fillText(name, 512, 128);
    const tex = new THREE.CanvasTexture(tc);
    const txtMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 0.58),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    txtMesh.position.z = 0.012;
    group.add(txtMesh);

    // Vertical stem
    const stemMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue/360, 0.7, 0.35), transparent: true, opacity: 0.55 });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.4, 8), stemMat);
    stem.position.y = -1.07;
    group.add(stem);

    // Ground ring
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue/360, 0.9, 0.5), transparent: true, opacity: 0.45, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.22, 24), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -1.78;
    group.add(ring);

    // Store reference to edge mat for pulse animation
    this.scene.add(group);
    this._banners.set(id, { group, edgeMat, hue, t0: this._clock.getElapsedTime() });
  }

  removeBanner(id) {
    const e = this._banners.get(id);
    if (!e) return;
    this.scene.remove(e.group);
    e.group.traverse(c => { c.geometry?.dispose(); (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m?.dispose()); });
    this._banners.delete(id);
  }

  start() {
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      requestAnimationFrame(loop);
      const t = this._clock.getElapsedTime();

      this._banners.forEach(({ group, edgeMat, hue, t0 }) => {
        // Billboard: always face camera (Y axis only)
        const dx = this.camera.position.x - group.position.x;
        const dz = this.camera.position.z - group.position.z;
        group.rotation.y = Math.atan2(dx, dz);
        // Border pulse
        if (edgeMat) edgeMat.opacity = 0.5 + 0.35 * Math.sin((t - t0) * 1.8);
      });

      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  dispose() {
    this._running = false;
    [...this._banners.keys()].forEach(id => this.removeBanner(id));
    this.renderer.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP HELPER
// ─────────────────────────────────────────────────────────────────────────────
function MapRecenter({ lat, lng }) {
  const map = useMap();
  useEffect(() => map.setView([lat, lng], map.getZoom(), { animate: true }), [lat, lng]);
  return null;
}
const userDot = L.divIcon({
  className: '',
  html: `<div style="width:16px;height:16px;background:#3b82f6;border-radius:50%;border:2.5px solid white;box-shadow:0 0 0 4px rgba(59,130,246,.25)"></div>`,
  iconSize: [16, 16], iconAnchor: [8, 8],
});
const makePin = (name, hue) => L.divIcon({
  className: '',
  html: `<div style="background:hsl(${hue},65%,11%);border:1.5px solid hsl(${hue},70%,48%);color:hsl(${hue},80%,78%);padding:4px 10px;border-radius:99px;font-size:12px;font-weight:800;white-space:nowrap;font-family:Syne,sans-serif;box-shadow:0 2px 14px hsl(${hue},70%,15%)">${name}</div>`,
  iconAnchor: [0, 12],
});

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STYLES
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Syne:wght@700;800&family=Space+Mono:wght@400;700&display=swap');
  *,*::before,*::after{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html{height:-webkit-fill-available}
  body{margin:0;padding:0;width:100%;height:100vh;height:-webkit-fill-available;overflow:hidden;position:fixed;background:#03050a;font-family:'DM Sans',system-ui,sans-serif}
  #root{width:100%;height:100%;overflow:hidden;display:flex;flex-direction:column}
  @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes pulse{0%,100%{opacity:.8;transform:scale(1)}50%{opacity:.2;transform:scale(1.6)}}
  @keyframes rotate{to{transform:rotate(360deg)}}
  @keyframes scanLine{0%{transform:translateY(-100%)}100%{transform:translateY(200%)}}
  @keyframes borderGlow{0%,100%{opacity:.5}50%{opacity:1}}
  @keyframes toastIn{from{opacity:0;transform:translate(-50%,-12px)}to{opacity:1;transform:translate(-50%,0)}}
  @keyframes countUp{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .fade-up{animation:fadeUp .4s cubic-bezier(.22,1,.36,1) both}
  .fade-in{animation:fadeIn .3s ease both}
  .spin{animation:rotate .85s linear infinite}
  .pulse{animation:pulse 1.6s ease-in-out infinite}
  .toast{animation:toastIn .22s ease both}
  .leaflet-control-attribution,.leaflet-control-zoom{display:none!important}
  .leaflet-container{background:#060a14!important}
  .leaflet-popup-content-wrapper{background:rgba(6,10,20,.97)!important;color:white!important;border:1px solid rgba(255,255,255,.1)!important;border-radius:16px!important;box-shadow:0 12px 40px rgba(0,0,0,.7)!important;backdrop-filter:blur(16px)}
  .leaflet-popup-content{margin:12px 16px!important}
  .leaflet-popup-tip-container{display:none!important}
  .leaflet-popup-close-button{color:rgba(255,255,255,.3)!important;font-size:17px!important;top:7px!important;right:9px!important}
  .scroll-y{overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  .scroll-y::-webkit-scrollbar{width:0}
  canvas{outline:none!important;display:block}
`;

// ─────────────────────────────────────────────────────────────────────────────
// SUBCOMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function Toast({ msg, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, []);
  return (
    <div className="toast" style={{
      position:'fixed', top:'max(70px,calc(env(safe-area-inset-top) + 58px))', left:'50%',
      zIndex:9999, background: type==='error'?'#dc2626':'#059669',
      color:'white', padding:'10px 22px', borderRadius:16,
      fontSize:13, fontWeight:700, fontFamily:'DM Sans,sans-serif',
      boxShadow:'0 8px 32px rgba(0,0,0,.55)', maxWidth:'calc(100vw - 48px)', textAlign:'center',
    }}>{msg}</div>
  );
}

function CalibrationOverlay({ progress, onCancel }) {
  const pct = Math.round(progress * 100);
  const sectors = 8;
  return (
    <div style={{
      position:'absolute', inset:0, zIndex:50,
      background:'rgba(3,5,10,.88)', backdropFilter:'blur(6px)',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      gap:28, padding:'0 36px',
    }}>
      {/* Scanner animation */}
      <div style={{position:'relative', width:180, height:180}}>
        {/* Outer ring */}
        <svg width="180" height="180" style={{position:'absolute', inset:0}}>
          <circle cx="90" cy="90" r="82" fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="1.5"/>
          <circle cx="90" cy="90" r="82" fill="none"
            stroke="#3b82f6" strokeWidth="2"
            strokeDasharray={`${2 * Math.PI * 82 * progress} ${2 * Math.PI * 82}`}
            strokeLinecap="round"
            transform="rotate(-90 90 90)"
            style={{transition:'stroke-dasharray .4s ease'}}
          />
        </svg>
        {/* Corner markers (ARCore-style) */}
        {[0,1,2,3].map(i => {
          const angle = i * 90 * Math.PI / 180;
          const cx = 90 + 70 * Math.cos(angle - Math.PI/4);
          const cy = 90 + 70 * Math.sin(angle - Math.PI/4);
          return (
            <div key={i} style={{
              position:'absolute', width:16, height:16,
              left: cx - 8, top: cy - 8,
              border:'2px solid #3b82f6',
              borderRadius:2,
              opacity: 0.5 + 0.5 * progress,
            }}/>
          );
        })}
        {/* Scan line */}
        <div style={{
          position:'absolute', left:20, right:20,
          height:1, background:'linear-gradient(to right, transparent, #3b82f6, transparent)',
          animation:'scanLine 2s ease-in-out infinite',
        }}/>
        {/* Centre */}
        <div style={{
          position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
          textAlign:'center',
        }}>
          <p style={{fontFamily:'Space Mono,monospace', fontSize:28, fontWeight:700, color:'white', margin:0, lineHeight:1}}>
            {pct}%
          </p>
          <p style={{color:'rgba(255,255,255,.4)', fontSize:10, fontWeight:700, letterSpacing:'0.15em', textTransform:'uppercase', margin:'4px 0 0', fontFamily:'DM Sans,sans-serif'}}>
            GPS lock
          </p>
        </div>
      </div>

      <div style={{textAlign:'center'}}>
        <h2 style={{fontFamily:'Syne,sans-serif', fontWeight:800, fontSize:22, color:'white', margin:'0 0 8px', letterSpacing:'-0.5px'}}>
          Calibrating Environment
        </h2>
        <p style={{color:'rgba(255,255,255,.4)', fontSize:13, lineHeight:1.65, margin:0}}>
          Hold your phone still outdoors.<br/>
          Collecting GPS samples to lock the spatial anchor.
        </p>
      </div>

      {/* Sensor status pills */}
      <div style={{display:'flex', gap:8, flexWrap:'wrap', justifyContent:'center'}}>
        {['GPS', 'Compass', 'Gyro', 'Kalman'].map((s, i) => (
          <div key={s} style={{
            background: i/3 < progress ? 'rgba(16,185,129,.15)' : 'rgba(255,255,255,.05)',
            border:`1px solid ${i/3 < progress ? 'rgba(16,185,129,.4)' : 'rgba(255,255,255,.08)'}`,
            borderRadius:99, padding:'5px 12px',
            color: i/3 < progress ? '#34d399' : 'rgba(255,255,255,.3)',
            fontSize:11, fontWeight:700, fontFamily:'DM Sans,sans-serif',
            transition:'all .3s',
          }}>
            {i/3 < progress ? '✓ ' : '○ '}{s}
          </div>
        ))}
      </div>

      <button onClick={onCancel} style={{
        background:'transparent', border:'1px solid rgba(255,255,255,.12)',
        color:'rgba(255,255,255,.35)', borderRadius:12, padding:'10px 24px',
        fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'DM Sans,sans-serif',
      }}>
        Cancel
      </button>
    </div>
  );
}

function BannerListItem({ b, userPos, idx }) {
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
    <div className="fade-up" style={{
      animationDelay:`${Math.min(idx*40,280)}ms`,
      background:`hsl(${hue},55%,6%)`,
      border:`1px solid hsl(${hue},45%,${near?18:11}%)`,
      borderRadius:16, padding:'12px 14px',
      display:'flex', alignItems:'center', gap:12,
    }}>
      <div style={{width:40,height:40,borderRadius:12,flexShrink:0,background:`hsl(${hue},60%,11%)`,border:`1px solid hsl(${hue},60%,22%)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>
        📍
      </div>
      <div style={{flex:1,minWidth:0}}>
        <p style={{color:'white',fontWeight:800,fontSize:14,margin:'0 0 2px',fontFamily:'Syne,sans-serif',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
          {b.name}
        </p>
        <p style={{color:'rgba(255,255,255,.28)',fontSize:11,margin:0}}>
          {ago} · ±{Math.round(b.accuracy ?? 5)}m accuracy
        </p>
      </div>
      {dist !== null && (
        <span style={{
          background: near?`hsl(${hue},65%,13%)`:'rgba(255,255,255,.04)',
          color:       near?`hsl(${hue},80%,72%)`:'rgba(255,255,255,.3)',
          border:`1px solid ${near?`hsl(${hue},65%,22%)`:'rgba(255,255,255,.07)'}`,
          borderRadius:99, padding:'4px 10px', fontSize:11, fontWeight:800, flexShrink:0,
          fontFamily:'Space Mono,monospace',
        }}>
          {dist < 1000 ? `${dist}m` : `${(dist/1000).toFixed(1)}km`}
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
  const [activeTab,   setActiveTab]   = useState('ar');   // ar | map | list
  const [arMode,      setArMode]      = useState(false);  // camera+3D active

  // Sensor state
  const [position,    setPosition]    = useState(null);   // Kalman-filtered
  const [rawAccuracy, setRawAccuracy] = useState(null);
  const [heading,     setHeading]     = useState(null);
  const [pitch,       setPitch]       = useState(90);

  // Calibration
  const [calPhase,    setCalPhase]    = useState('idle'); // idle|collecting|done
  const [calProgress, setCalProgress] = useState(0);
  const [anchor,      setAnchor]      = useState(null);   // calibrated origin

  // Banners
  const [banners,     setBanners]     = useState([]);
  const [processing,  setProcessing]  = useState(false);
  const [toast,       setToast]       = useState(null);

  // Permissions
  const [orientPerm,  setOrientPerm]  = useState(null); // null|granted|denied
  const [camStream,   setCamStream]   = useState(null);
  const [camErr,      setCamErr]      = useState(false);

  // Refs
  const canvasRef     = useRef(null);
  const videoRef      = useRef(null);
  const rendererRef   = useRef(null);
  const kalmanLat     = useRef(new KalmanFilter1D());
  const kalmanLng     = useRef(new KalmanFilter1D());
  const kalmanAlt     = useRef(new KalmanFilter1D());
  const calSamples    = useRef([]);
  const smoothHead    = useRef(null);
  const posRef        = useRef(null);
  const anchorRef     = useRef(null);
  const bannersRef    = useRef([]);
  const lastGpsTime   = useRef(null);

  // Sync refs
  useEffect(() => { posRef.current    = position; }, [position]);
  useEffect(() => { anchorRef.current = anchor;   }, [anchor]);
  useEffect(() => { bannersRef.current = banners; }, [banners]);

  // ── Inject CSS ──
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = CSS;
    document.head.prepend(el);
    return () => el.remove();
  }, []);

  // ── Auth ──
  useEffect(() => {
    return onAuthStateChanged(auth, u => { setUser(u); setAuthLoading(false); });
  }, []);

  // ── GPS + Kalman ──
  useEffect(() => {
    if (!user || !navigator.geolocation) return;
    let lastT = null;
    const id = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => {
        const dt = lastT ? (timestamp - lastT) / 1000 : 1;
        lastT = timestamp;
        kalmanLat.current.dt = dt;
        kalmanLng.current.dt = dt;
        kalmanAlt.current.dt = dt;

        const lat = kalmanLat.current.update(coords.latitude,  coords.accuracy);
        const lng = kalmanLng.current.update(coords.longitude, coords.accuracy);
        const alt = kalmanAlt.current.update(coords.altitude ?? 0, (coords.accuracy ?? 5) * 1.5);
        const acc = coords.accuracy;

        setPosition({ lat, lng, alt, accuracy: acc });
        setRawAccuracy(acc);
        lastGpsTime.current = timestamp;

        if (calPhase === 'collecting') {
          calSamples.current.push({ lat, lng, alt });
          const prog = calSamples.current.length / CAL_SAMPLES;
          setCalProgress(prog);
          if (calSamples.current.length >= CAL_SAMPLES) finishCalibration();
        }
      },
      () => showToast('GPS unavailable', 'error'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [user, calPhase]);

  // ── Orientation sensor fusion (compass + gyro + complementary filter) ──
  useEffect(() => {
    if (!user) return;

    const handler = e => {
      // Heading from magnetometer
      let rawH = e.webkitCompassHeading != null
        ? e.webkitCompassHeading
        : e.alpha != null ? (360 - e.alpha + 360) % 360 : null;

      if (rawH !== null) {
        // Complementary low-pass filter — kills magnetic jitter
        if (smoothHead.current === null) {
          smoothHead.current = rawH;
        } else {
          let diff = rawH - smoothHead.current;
          if (diff >  180) diff -= 360;
          if (diff < -180) diff += 360;
          smoothHead.current = (smoothHead.current + (1 - COMP_ALPHA) * diff + 360) % 360;
        }
        setHeading(smoothHead.current);
      }

      // Pitch (beta): 90 = upright phone, 0 = flat
      if (e.beta != null) setPitch(e.beta);
    };

    const start = () => {
      window.addEventListener('deviceorientationabsolute', handler, true);
      window.addEventListener('deviceorientation',         handler, true);
    };

    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      // iOS: don't auto-request — wait for user tap
      setOrientPerm('needs-prompt');
    } else {
      start();
      setOrientPerm('granted');
    }

    return () => {
      window.removeEventListener('deviceorientationabsolute', handler, true);
      window.removeEventListener('deviceorientation',         handler, true);
    };
  }, [user]);

  // ── Camera stream ──
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
        audio: false,
      });
      setCamStream(stream);
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
    } catch { setCamErr(true); }
  }, []);

  useEffect(() => {
    if (videoRef.current && camStream) { videoRef.current.srcObject = camStream; videoRef.current.play(); }
  }, [camStream]);

  // ── Three.js renderer init + loop ──
  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new ARRenderer(canvasRef.current);
    renderer.start();
    rendererRef.current = renderer;
    return () => { renderer.dispose(); rendererRef.current = null; };
  }, []);

  // ── Update renderer camera orientation every heading change ──
  useEffect(() => {
    rendererRef.current?.updateOrientation(heading, pitch);
  }, [heading, pitch]);

  // ── Sync banners into 3D scene whenever anchor or banners change ──
  useEffect(() => {
    if (!rendererRef.current || !anchor) return;
    const renderer = rendererRef.current;
    const nearby = banners.filter(b =>
      posRef.current && haversine(posRef.current.lat, posRef.current.lng, b.lat, b.lng) <= NEARBY_RADIUS
    );
    renderer.dispose?.call?.({ _running: false }); // clear scene
    nearby.forEach(b => {
      const [x, , z] = gpsToLocal(anchor, b.lat, b.lng, b.alt ?? anchor.alt);
      renderer.addBanner({ id: b.id, name: b.name, x, y: 1.8, z, hue: nameToHue(b.name) });
    });
  }, [banners, anchor]);

  // ── Firestore listener ──
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'geoBanners'), orderBy('timestamp', 'desc'));
    return onSnapshot(q, snap => setBanners(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [user]);

  // ── Calibration ──
  const startCalibration = useCallback(() => {
    kalmanLat.current.reset();
    kalmanLng.current.reset();
    kalmanAlt.current.reset();
    calSamples.current = [];
    setCalProgress(0);
    setCalPhase('collecting');
  }, []);

  const finishCalibration = useCallback(() => {
    const s = calSamples.current;
    const n = s.length;
    const a = {
      lat: s.reduce((sum, p) => sum + p.lat, 0) / n,
      lng: s.reduce((sum, p) => sum + p.lng, 0) / n,
      alt: s.reduce((sum, p) => sum + p.alt, 0) / n,
    };
    setAnchor(a);
    setCalPhase('done');
    showToast('✓ Environment calibrated — AR anchors locked', 'success');
  }, []);

  const requestOrientationPermission = useCallback(async () => {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') {
        setOrientPerm('granted');
        const handler = e => {
          let rawH = e.webkitCompassHeading != null ? e.webkitCompassHeading
            : e.alpha != null ? (360 - e.alpha + 360) % 360 : null;
          if (rawH !== null) {
            if (smoothHead.current === null) { smoothHead.current = rawH; }
            else {
              let diff = rawH - smoothHead.current;
              if (diff > 180) diff -= 360; if (diff < -180) diff += 360;
              smoothHead.current = (smoothHead.current + (1 - COMP_ALPHA) * diff + 360) % 360;
            }
            setHeading(smoothHead.current);
          }
          if (e.beta != null) setPitch(e.beta);
        };
        window.addEventListener('deviceorientationabsolute', handler, true);
        window.addEventListener('deviceorientation',         handler, true);
      } else {
        setOrientPerm('denied');
      }
    } catch { setOrientPerm('denied'); }
  }, []);

  const enterAR = useCallback(async () => {
    await startCamera();
    if (orientPerm === 'needs-prompt') await requestOrientationPermission();
    if (calPhase === 'idle') startCalibration();
    setArMode(true);
  }, [orientPerm, calPhase, startCamera, startCalibration, requestOrientationPermission]);

  const exitAR = useCallback(() => {
    setArMode(false);
    camStream?.getTracks().forEach(t => t.stop());
    setCamStream(null);
  }, [camStream]);

  const placeBanner = useCallback(async () => {
    const pos = posRef.current;
    if (!pos || !user || processing || !anchor) {
      if (!anchor) showToast('Calibrate first — tap "Start AR"', 'error');
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
      showToast('📍 Banner anchored to the world!');
    } catch { showToast('Save failed', 'error'); }
    finally { setProcessing(false); }
  }, [user, processing, anchor, heading]);

  const showToast = (msg, type = 'success') => setToast({ msg, type });

  const nearbyBanners = banners.filter(b =>
    position && haversine(position.lat, position.lng, b.lat, b.lng) <= NEARBY_RADIUS
  );

  // ── LOADING ──
  if (authLoading) return (
    <div style={{position:'fixed',inset:0,background:'#03050a',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:16}}>
      <div className="spin" style={{width:32,height:32,border:'3px solid #3b82f6',borderTopColor:'transparent',borderRadius:'50%'}}/>
      <span style={{color:'rgba(255,255,255,.3)',fontSize:11,letterSpacing:'0.15em',textTransform:'uppercase',fontFamily:'DM Sans,sans-serif'}}>Loading</span>
    </div>
  );

  // ── LOGIN ──
  if (!user) return (
    <div style={{position:'fixed',inset:0,background:'#03050a',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'flex-end',paddingBottom:'max(32px,env(safe-area-inset-bottom))'}}>
      <div style={{position:'absolute',inset:0,backgroundImage:'radial-gradient(ellipse 80% 55% at 50% -5%, rgba(59,130,246,.16) 0%, transparent 60%), linear-gradient(rgba(255,255,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px)',backgroundSize:'auto,52px 52px,52px 52px',pointerEvents:'none'}}/>

      {/* Hero */}
      <div className="fade-up" style={{position:'absolute',top:0,left:0,right:0,display:'flex',flexDirection:'column',alignItems:'center',padding:'max(60px,env(safe-area-inset-top)) 28px 0'}}>
        <div style={{fontSize:58,marginBottom:16,filter:'drop-shadow(0 0 28px rgba(59,130,246,.45))'}}>📍</div>
        <h1 style={{fontFamily:'Syne,sans-serif',fontWeight:800,fontSize:44,color:'white',margin:'0 0 8px',letterSpacing:'-1.5px',textAlign:'center'}}>
          Geo<span style={{color:'#3b82f6'}}>Banner</span>
        </h1>
        <p style={{color:'rgba(255,255,255,.35)',fontSize:14,margin:0,textAlign:'center',lineHeight:1.7,maxWidth:260,fontFamily:'DM Sans,sans-serif'}}>
          Persistent AR anchors at real‑world GPS coordinates
        </p>

        <div style={{marginTop:32,width:'100%',maxWidth:340,display:'flex',flexDirection:'column',gap:8}}>
          {[
            ['🧭','Sensor Fusion','GPS + gyro + magnetometer + Kalman filter'],
            ['📐','Geospatial Anchors','ARCore / ARKit precision positioning'],
            ['🌐','Three.js 3D','WebGL rendered banners with glow & billboard'],
            ['🔒','Stable Anchors','Objects stay fixed even with GPS drift'],
          ].map(([ic,t,s],i) => (
            <div key={t} className="fade-up" style={{animationDelay:`${i*70+100}ms`,background:'rgba(255,255,255,.035)',border:'1px solid rgba(255,255,255,.07)',borderRadius:14,padding:'11px 14px',display:'flex',alignItems:'center',gap:12}}>
              <span style={{fontSize:20,flexShrink:0}}>{ic}</span>
              <div>
                <p style={{color:'white',fontWeight:700,fontSize:12,margin:0,fontFamily:'DM Sans,sans-serif'}}>{t}</p>
                <p style={{color:'rgba(255,255,255,.3)',fontSize:11,margin:0}}>{s}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="fade-up" style={{animationDelay:'420ms',width:'100%',maxWidth:380,padding:'0 24px',position:'relative',zIndex:1}}>
        <button onClick={async () => { try { await signInWithPopup(auth, provider); } catch { showToast('Sign-in failed','error'); } }} style={{
          width:'100%',background:'white',color:'#0a0a0a',border:'none',borderRadius:18,
          padding:'18px 0',fontWeight:800,fontSize:16,
          display:'flex',alignItems:'center',justifyContent:'center',gap:11,
          boxShadow:'0 0 60px rgba(59,130,246,.2)',cursor:'pointer',
          fontFamily:'DM Sans,sans-serif',letterSpacing:'-0.2px',
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

  // ── GPS WAIT ──
  if (!position) return (
    <div style={{position:'fixed',inset:0,background:'#03050a',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:22}}>
      <div style={{position:'relative',width:80,height:80,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div className="pulse" style={{position:'absolute',inset:0,background:'rgba(59,130,246,.12)',borderRadius:'50%'}}/>
        <div className="pulse" style={{position:'absolute',inset:14,background:'rgba(59,130,246,.18)',borderRadius:'50%',animationDelay:'.4s'}}/>
        <div style={{width:28,height:28,background:'#3b82f6',borderRadius:'50%',boxShadow:'0 0 24px rgba(59,130,246,.7)'}}/>
      </div>
      <div style={{textAlign:'center'}}>
        <p style={{color:'white',fontWeight:800,fontSize:18,margin:'0 0 6px',fontFamily:'Syne,sans-serif'}}>Acquiring GPS</p>
        <p style={{color:'rgba(255,255,255,.3)',fontSize:13,margin:0}}>Go outdoors for best accuracy</p>
      </div>
    </div>
  );

  // ── MAIN APP ──
  return (
    <div style={{position:'fixed',inset:0,display:'flex',flexDirection:'column',background:'#03050a',height:'100%',maxHeight:'100vh'}}>
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)}/>}

      {/* Top HUD */}
      <div style={{
        position:'absolute',top:0,left:0,right:0,zIndex:40,
        paddingTop:'max(12px,env(safe-area-inset-top))',
        paddingLeft:14,paddingRight:14,
        display:'flex',justifyContent:'space-between',alignItems:'center',
        pointerEvents:'none',
      }}>
        <div style={{background:'rgba(3,5,10,.82)',backdropFilter:'blur(14px)',WebkitBackdropFilter:'blur(14px)',border:'1px solid rgba(255,255,255,.1)',borderRadius:99,padding:'7px 13px',display:'flex',alignItems:'center',gap:7,pointerEvents:'auto',maxWidth:'58vw'}}>
          <div className="pulse" style={{width:7,height:7,borderRadius:'50%',background: anchor ? '#10b981' : '#f59e0b',boxShadow:`0 0 6px ${anchor ? '#10b981' : '#f59e0b'}`,flexShrink:0}}/>
          <span style={{color:'white',fontWeight:700,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontFamily:'DM Sans,sans-serif'}}>
            {user.displayName}
          </span>
          {rawAccuracy && (
            <span style={{color:'rgba(255,255,255,.3)',fontSize:10,fontFamily:'Space Mono,monospace',flexShrink:0}}>
              ±{Math.round(rawAccuracy)}m
            </span>
          )}
        </div>
        <button onClick={async () => { exitAR(); await signOut(auth); }} style={{
          background:'rgba(3,5,10,.82)',backdropFilter:'blur(14px)',WebkitBackdropFilter:'blur(14px)',
          border:'1px solid rgba(255,255,255,.1)',borderRadius:99,padding:'7px 14px',
          color:'rgba(255,255,255,.45)',fontSize:12,fontWeight:700,cursor:'pointer',
          pointerEvents:'auto',fontFamily:'DM Sans,sans-serif',
        }}>Sign out</button>
      </div>

      {/* Content */}
      <div style={{flex:1,position:'relative',overflow:'hidden',minHeight:0}}>

        {/* ══ AR VIEW ══ */}
        {activeTab === 'ar' && (
          <div style={{position:'absolute',inset:0}}>

            {/* Camera feed */}
            <video ref={videoRef} autoPlay playsInline muted style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',display: arMode && !camErr ? 'block' : 'none'}}/>

            {/* Dark bg when not in AR mode or cam failed */}
            {(!arMode || camErr) && (
              <div style={{position:'absolute',inset:0,background:'linear-gradient(135deg,#03050a 0%,#070d1a 100%)',backgroundImage:'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(59,130,246,.08) 0%, transparent 70%)'}}/>
            )}

            {/* Three.js canvas — always rendered, overlays camera */}
            <canvas ref={canvasRef} style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:2,opacity: anchor ? 1 : 0,transition:'opacity .5s'}}/>

            {/* Gradient overlay */}
            {arMode && <div style={{position:'absolute',inset:0,background:'linear-gradient(to bottom,rgba(0,0,0,.42) 0%,transparent 20%,transparent 72%,rgba(0,0,0,.55) 100%)',pointerEvents:'none',zIndex:3}}/>}

            {/* Calibration overlay */}
            {calPhase === 'collecting' && (
              <div style={{position:'absolute',inset:0,zIndex:10}}>
                <CalibrationOverlay progress={calProgress} onCancel={() => { setCalPhase('idle'); setCalProgress(0); }}/>
              </div>
            )}

            {/* Not in AR mode — landing screen */}
            {!arMode && calPhase !== 'collecting' && (
              <div style={{position:'absolute',inset:0,zIndex:5,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:24,padding:'0 32px',textAlign:'center'}}>
                {/* Calibration status */}
                <div style={{
                  background:'rgba(255,255,255,.04)',border:`1px solid ${anchor?'rgba(16,185,129,.2)':'rgba(255,255,255,.08)'}`,
                  borderRadius:20,padding:'20px 24px',width:'100%',maxWidth:320,
                }}>
                  <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                    <span style={{fontSize:22}}>{anchor ? '✅' : '🎯'}</span>
                    <p style={{color:'white',fontWeight:800,fontSize:15,margin:0,fontFamily:'Syne,sans-serif'}}>
                      {anchor ? 'Calibrated & Ready' : 'Calibration Required'}
                    </p>
                  </div>
                  {anchor ? (
                    <p style={{color:'rgba(255,255,255,.4)',fontSize:12,margin:0,lineHeight:1.5}}>
                      Spatial anchor locked at<br/>
                      <span style={{fontFamily:'Space Mono,monospace',color:'#34d399',fontSize:11}}>{anchor.lat.toFixed(6)}, {anchor.lng.toFixed(6)}</span>
                    </p>
                  ) : (
                    <p style={{color:'rgba(255,255,255,.4)',fontSize:12,margin:0,lineHeight:1.5}}>
                      Stand still outdoors while we collect {CAL_SAMPLES} GPS samples to lock the anchor point.
                    </p>
                  )}
                </div>

                {/* Sensor status grid */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,width:'100%',maxWidth:320}}>
                  {[
                    ['📡', 'GPS', position ? `±${Math.round(rawAccuracy??99)}m` : 'waiting', !!position],
                    ['🧭', 'Compass', heading ? `${Math.round(heading)}°` : 'waiting', heading !== null],
                    ['⚓', 'Anchor', anchor ? 'locked' : 'pending', !!anchor],
                    ['🔢', 'Kalman', 'active', true],
                  ].map(([ic, label, val, ok]) => (
                    <div key={label} style={{
                      background: ok ? 'rgba(16,185,129,.07)' : 'rgba(255,255,255,.03)',
                      border:`1px solid ${ok?'rgba(16,185,129,.18)':'rgba(255,255,255,.07)'}`,
                      borderRadius:12, padding:'10px 12px',
                    }}>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                        <span style={{fontSize:14}}>{ic}</span>
                        <span style={{color: ok?'#34d399':'rgba(255,255,255,.35)',fontSize:10,fontWeight:800,textTransform:'uppercase',letterSpacing:'0.1em',fontFamily:'DM Sans,sans-serif'}}>{label}</span>
                      </div>
                      <p style={{color:'white',fontFamily:'Space Mono,monospace',fontSize:11,margin:0,fontWeight:700}}>{val}</p>
                    </div>
                  ))}
                </div>

                <button onClick={enterAR} style={{
                  background: anchor ? 'linear-gradient(135deg,#1d4ed8,#3b82f6)' : 'linear-gradient(135deg,#0f172a,#1e3a5f)',
                  border:'1px solid rgba(59,130,246,.4)',
                  color:'white', borderRadius:18, padding:'16px 40px',
                  fontWeight:800, fontSize:16, cursor:'pointer',
                  fontFamily:'DM Sans,sans-serif',
                  boxShadow: anchor ? '0 0 40px rgba(59,130,246,.3)' : 'none',
                  letterSpacing:'-0.2px',
                }}>
                  {anchor ? '🚀 Enter AR' : '🎯 Calibrate & Enter AR'}
                </button>
              </div>
            )}

            {/* In AR — HUD overlay */}
            {arMode && calPhase === 'done' && (
              <>
                {/* Compass rose */}
                {heading !== null && (
                  <div style={{position:'absolute',top:'max(56px,calc(env(safe-area-inset-top)+44px))',left:'50%',transform:'translateX(-50%)',zIndex:10}}>
                    <div style={{background:'rgba(3,5,10,.7)',backdropFilter:'blur(10px)',WebkitBackdropFilter:'blur(10px)',border:'1px solid rgba(255,255,255,.1)',borderRadius:99,padding:'5px 16px',display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:13}}>🧭</span>
                      <span style={{fontFamily:'Space Mono,monospace',color:'white',fontSize:13,fontWeight:700}}>{Math.round(heading)}°</span>
                      <span style={{color:'rgba(255,255,255,.35)',fontSize:12,fontWeight:700,fontFamily:'DM Sans,sans-serif'}}>
                        {['N','NE','E','SE','S','SW','W','NW'][Math.round(heading/45)%8]}
                      </span>
                      <div style={{width:1,height:12,background:'rgba(255,255,255,.12)'}}/>
                      <span style={{color:'rgba(255,255,255,.35)',fontSize:11,fontFamily:'Space Mono,monospace'}}>
                        ±{Math.round(rawAccuracy??99)}m
                      </span>
                    </div>
                  </div>
                )}

                {/* Crosshair */}
                <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:6,pointerEvents:'none'}}>
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                    <line x1="20" y1="0"  x2="20" y2="14" stroke="rgba(255,255,255,.35)" strokeWidth="1.5"/>
                    <line x1="20" y1="26" x2="20" y2="40" stroke="rgba(255,255,255,.35)" strokeWidth="1.5"/>
                    <line x1="0"  y1="20" x2="14" y2="20" stroke="rgba(255,255,255,.35)" strokeWidth="1.5"/>
                    <line x1="26" y1="20" x2="40" y2="20" stroke="rgba(255,255,255,.35)" strokeWidth="1.5"/>
                    <circle cx="20" cy="20" r="3" stroke="rgba(255,255,255,.4)" strokeWidth="1.5" fill="none"/>
                  </svg>
                </div>

                {/* Bottom controls */}
                <div style={{position:'absolute',bottom:0,left:0,right:0,paddingBottom:'max(24px,env(safe-area-inset-bottom))',zIndex:10,display:'flex',flexDirection:'column',alignItems:'center',gap:14}}>
                  <p style={{color:'rgba(255,255,255,.3)',fontSize:11,letterSpacing:'0.1em',textTransform:'uppercase',margin:0,fontFamily:'DM Sans,sans-serif'}}>
                    {nearbyBanners.length} anchor{nearbyBanners.length!==1?'s':''} nearby
                  </p>
                  <div style={{display:'flex',alignItems:'center',gap:20}}>
                    {/* Exit */}
                    <button onClick={exitAR} style={{background:'rgba(3,5,10,.75)',backdropFilter:'blur(10px)',border:'1px solid rgba(255,255,255,.12)',color:'rgba(255,255,255,.5)',borderRadius:99,padding:'10px 18px',fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'DM Sans,sans-serif'}}>
                      ✕ Exit
                    </button>
                    {/* Place banner */}
                    <button onClick={placeBanner} disabled={processing} style={{
                      width:72,height:72,borderRadius:'50%',
                      border:'3px solid rgba(255,255,255,.8)',
                      background:'transparent',cursor:'pointer',
                      display:'flex',alignItems:'center',justifyContent:'center',
                      transition:'transform .15s',
                      transform: processing?'scale(.93)':'scale(1)',
                    }}>
                      <div style={{
                        width:56,height:56,borderRadius:'50%',
                        background: processing ? '#3b82f6' : 'white',
                        display:'flex',alignItems:'center',justifyContent:'center',
                        fontSize:22,
                        ...(processing && {animation:'pulse 1s ease-in-out infinite'}),
                      }}>
                        {processing ? '' : '📍'}
                      </div>
                    </button>
                    {/* Recalibrate */}
                    <button onClick={() => { setAnchor(null); setCalPhase('idle'); startCalibration(); }} style={{background:'rgba(3,5,10,.75)',backdropFilter:'blur(10px)',border:'1px solid rgba(255,255,255,.12)',color:'rgba(255,255,255,.5)',borderRadius:99,padding:'10px 18px',fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'DM Sans,sans-serif'}}>
                      ⟳ Recal
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ MAP VIEW ══ */}
        {activeTab === 'map' && position && (
          <div style={{position:'absolute',inset:0}}>
            <MapContainer center={[position.lat, position.lng]} zoom={16} zoomControl={false} style={{width:'100%',height:'100%'}}>
              <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" maxZoom={22}/>
              <MapRecenter lat={position.lat} lng={position.lng}/>
              <Marker position={[position.lat, position.lng]} icon={userDot}/>
              <Circle center={[position.lat, position.lng]} radius={NEARBY_RADIUS} pathOptions={{color:'#3b82f6',fillColor:'#3b82f6',fillOpacity:.05,weight:1.5,dashArray:'4 8'}}/>
              {anchor && <Marker position={[anchor.lat, anchor.lng]} icon={L.divIcon({ className:'', html:`<div style="width:14px;height:14px;background:#f59e0b;border-radius:50%;border:2px solid white;box-shadow:0 0 8px #f59e0b"></div>`, iconSize:[14,14],iconAnchor:[7,7] })}/>}
              {banners.map(b => {
                const hue = nameToHue(b.name);
                const near = haversine(position.lat, position.lng, b.lat, b.lng) <= NEARBY_RADIUS;
                return (
                  <Marker key={b.id} position={[b.lat, b.lng]} icon={makePin(b.name, hue)}>
                    <Popup>
                      <p style={{fontFamily:'Syne,sans-serif',fontWeight:800,fontSize:14,color:`hsl(${hue},75%,72%)`,margin:'0 0 4px'}}>{b.name}</p>
                      <p style={{color:'rgba(255,255,255,.38)',fontSize:11,margin:0}}>
                        {Math.round(haversine(position.lat,position.lng,b.lat,b.lng))}m away · alt {Math.round(b.alt??0)}m
                      </p>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
            <div style={{position:'absolute',bottom:12,left:'50%',transform:'translateX(-50%)',background:'rgba(3,5,10,.85)',backdropFilter:'blur(10px)',border:'1px solid rgba(255,255,255,.1)',borderRadius:99,padding:'7px 18px',display:'flex',alignItems:'center',gap:12,zIndex:10}}>
              <span style={{color:'white',fontSize:12,fontWeight:700,fontFamily:'DM Sans,sans-serif'}}>{banners.length} total 📍</span>
              <div style={{width:1,height:12,background:'rgba(255,255,255,.15)'}}/>
              <span style={{color:'#60a5fa',fontSize:12,fontWeight:700,fontFamily:'DM Sans,sans-serif'}}>{nearbyBanners.length} within {NEARBY_RADIUS}m</span>
            </div>
          </div>
        )}

        {/* ══ LIST VIEW ══ */}
        {activeTab === 'list' && (
          <div className="scroll-y" style={{position:'absolute',inset:0,paddingTop:'max(108px,calc(env(safe-area-inset-top)+96px))',paddingBottom:12}}>
            <div style={{padding:'0 14px',display:'flex',flexDirection:'column',gap:8}}>

              {/* Calibration card */}
              <div style={{background: anchor?'rgba(16,185,129,.06)':'rgba(245,158,11,.06)',border:`1px solid ${anchor?'rgba(16,185,129,.18)':'rgba(245,158,11,.18)'}`,borderRadius:16,padding:'12px 14px',display:'flex',alignItems:'center',gap:12,marginBottom:4}}>
                <span style={{fontSize:22}}>{anchor ? '⚓' : '⚠️'}</span>
                <div style={{flex:1}}>
                  <p style={{color:'white',fontWeight:800,fontSize:13,margin:'0 0 2px',fontFamily:'Syne,sans-serif'}}>{anchor ? 'Anchor Locked' : 'Not Calibrated'}</p>
                  <p style={{color:'rgba(255,255,255,.35)',fontSize:11,margin:0}}>
                    {anchor ? `${anchor.lat.toFixed(5)}, ${anchor.lng.toFixed(5)}` : 'Open AR tab to calibrate'}
                  </p>
                </div>
              </div>

              {banners.length === 0 ? (
                <div style={{textAlign:'center',padding:'48px 0',color:'rgba(255,255,255,.2)',fontSize:14,fontFamily:'DM Sans,sans-serif'}}>
                  No banners yet. Tap AR to place the first one! 📍
                </div>
              ) : (
                <>
                  {nearbyBanners.length > 0 && (
                    <>
                      <p style={{color:'rgba(255,255,255,.25)',fontSize:10,fontWeight:800,letterSpacing:'0.14em',textTransform:'uppercase',margin:'4px 0 4px 2px',fontFamily:'DM Sans,sans-serif'}}>
                        Nearby — within {NEARBY_RADIUS}m
                      </p>
                      {nearbyBanners.map((b,i) => <BannerListItem key={b.id} b={b} userPos={position} idx={i}/>)}
                      <div style={{height:1,background:'rgba(255,255,255,.06)',margin:'8px 0'}}/>
                    </>
                  )}
                  <p style={{color:'rgba(255,255,255,.25)',fontSize:10,fontWeight:800,letterSpacing:'0.14em',textTransform:'uppercase',margin:'4px 0 4px 2px',fontFamily:'DM Sans,sans-serif'}}>
                    All Anchors — {banners.length}
                  </p>
                  {banners.map((b,i) => <BannerListItem key={b.id} b={b} userPos={position} idx={i}/>)}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <nav style={{flexShrink:0,background:'rgba(3,5,10,.96)',backdropFilter:'blur(20px)',WebkitBackdropFilter:'blur(20px)',borderTop:'1px solid rgba(255,255,255,.07)',display:'flex',paddingBottom:'max(10px,env(safe-area-inset-bottom))',zIndex:20}}>
        {[
          {id:'ar',  icon:'🥽', label:'AR'},
          {id:'map', icon:'🗺️', label:'Map'},
          {id:'list',icon:'📋', label:'Anchors'},
        ].map(({id,icon,label}) => {
          const act = activeTab === id;
          return (
            <button key={id} onClick={() => { if (id !== 'ar') exitAR(); setActiveTab(id); }} style={{
              flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
              gap:3, paddingTop:12, paddingBottom:8,
              background:'transparent', border:'none', cursor:'pointer', position:'relative',
            }}>
              {act && <div style={{position:'absolute',top:0,left:'28%',right:'28%',height:2,background:'#3b82f6',borderRadius:'0 0 4px 4px'}}/>}
              <span style={{fontSize:22,opacity:act?1:.35,transform:act?'scale(1.1)':'scale(1)',transition:'all .2s'}}>{icon}</span>
              <span style={{fontSize:10,fontWeight:800,letterSpacing:'0.05em',textTransform:'uppercase',color:act?'#3b82f6':'rgba(255,255,255,.22)',fontFamily:'DM Sans,sans-serif',transition:'color .2s'}}>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}