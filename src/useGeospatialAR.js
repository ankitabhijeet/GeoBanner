/**
 * useGeospatialAR.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Central React hook that wires SensorFusion, Kalman filtering, Firestore,
 * and ARRenderer together into clean state.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { SensorFusion } from '../sensors/SensorFusion.js';
import { ARRenderer    } from '../ar/ARRenderer.js';
import { db, auth      } from '../firebase.js';
import { collection, addDoc, onSnapshot, query, orderBy } from 'firebase/firestore';

const PLACE_RADIUS = 150; // metres — load banners within this radius

export function useGeospatialAR(canvasRef) {
  // ── State ──
  const [phase,       setPhase]       = useState('init');       // init | calibrating | ready | ar
  const [calProgress, setCalProgress] = useState(0);
  const [position,    setPosition]    = useState(null);         // filtered GPS
  const [heading,     setHeading]     = useState(null);
  const [banners,     setBanners]     = useState([]);
  const [nearbyCount, setNearbyCount] = useState(0);
  const [accuracy,    setAccuracy]    = useState(null);
  const [sensorErr,   setSensorErr]   = useState(null);

  // ── Refs (stable across renders) ──
  const fusionRef   = useRef(null);
  const rendererRef = useRef(null);
  const positionRef = useRef(null);  // always-current copy of position

  // ── Boot sensor fusion ───────────────────────────────────────────────────
  useEffect(() => {
    const fusion = new SensorFusion();
    fusionRef.current = fusion;

    fusion.addEventListener('position', (e) => {
      const pos = e.detail;
      setPosition(pos);
      setAccuracy(pos.accuracy);
      positionRef.current = pos;

      // Update renderer camera position relative to calibrated anchor
      if (rendererRef.current && fusion._anchorPos) {
        const [x, y, z] = fusion.gpsToLocal(
          fusion._anchorPos.lat, fusion._anchorPos.lng, fusion._anchorPos.alt
        );
        // Camera is offset from anchor by current filtered position delta
        const dx = (pos.lat - fusion._anchorPos.lat) * 111320;
        const dz = -((pos.lng - fusion._anchorPos.lng) * 111320 * Math.cos(pos.lat * Math.PI / 180));
        rendererRef.current.updateCameraPosition(dx, 0, dz);
      }
    });

    fusion.addEventListener('orientation', (e) => {
      const { heading, pitch } = e.detail;
      setHeading(heading);
      if (rendererRef.current) {
        rendererRef.current.updateCamera({ heading, pitch });
      }
    });

    fusion.addEventListener('calibrationStart', () => setPhase('calibrating'));

    fusion.addEventListener('calibrationProgress', (e) => {
      setCalProgress(e.detail.progress);
    });

    fusion.addEventListener('calibrationDone', (e) => {
      setPhase('ready');
    });

    fusion.addEventListener('permissionDenied', (e) => {
      setSensorErr(`${e.detail} permission denied`);
    });

    fusion.addEventListener('gpsError', (e) => {
      setSensorErr('GPS unavailable');
    });

    fusion.start();
    setPhase('init');

    return () => { fusion.stop(); fusionRef.current = null; };
  }, []);

  // ── Boot Three.js renderer ───────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new ARRenderer(canvasRef.current);
    renderer.start();
    rendererRef.current = renderer;
    return () => { renderer.dispose(); rendererRef.current = null; };
  }, [canvasRef]);

  // ── Firestore banner listener ────────────────────────────────────────────
  useEffect(() => {
    const q = query(collection(db, 'geoBanners'), orderBy('timestamp', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setBanners(all);
    });
    return unsub;
  }, []);

  // ── Sync banners into 3D scene when position or banners change ───────────
  useEffect(() => {
    if (!rendererRef.current || !position || !fusionRef.current?.calibrated) return;

    const fusion   = fusionRef.current;
    const renderer = rendererRef.current;
    const nearby   = [];

    banners.forEach(b => {
      const dist = SensorFusion.distance(position.lat, position.lng, b.lat, b.lng);
      if (dist > PLACE_RADIUS) {
        renderer.removeBanner(b.id);
        return;
      }
      nearby.push(b);

      // Compute local XYZ relative to calibrated anchor
      const [x, y, z] = worldToLocal(
        fusion._anchorPos,
        b.lat, b.lng, b.alt ?? 0
      );

      // Banner always floats 1.8m above its anchor point
      renderer.addBanner({
        id:   b.id,
        name: b.name,
        x,
        y: y + 1.8,   // eye-level above ground anchor
        z,
        hue:  nameToHue(b.name),
      });
    });

    setNearbyCount(nearby.length);
  }, [banners, position]);

  // ── Public actions ────────────────────────────────────────────────────────

  const startCalibration = useCallback(() => {
    if (fusionRef.current) fusionRef.current.startCalibration();
  }, []);

  const placeBanner = useCallback(async (user) => {
    const pos = positionRef.current;
    if (!pos || !user) return;
    await addDoc(collection(db, 'geoBanners'), {
      uid:         user.uid,
      name:        user.displayName || 'Explorer',
      lat:         pos.lat,
      lng:         pos.lng,
      alt:         pos.alt,
      accuracy:    pos.accuracy,
      orientation: heading ?? 0,
      timestamp:   new Date().toISOString(),
    });
  }, [heading]);

  return {
    phase, calProgress, position, heading, banners, nearbyCount,
    accuracy, sensorErr, startCalibration, placeBanner,
    fusion: fusionRef,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function worldToLocal(anchor, lat, lng, alt) {
  if (!anchor) return [0, 0, 0];
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(anchor.lat * Math.PI / 180);
  const x =  (lng - anchor.lng) * metersPerDegLng;
  const y  = alt - anchor.alt;
  const z  = -((lat - anchor.lat) * metersPerDegLat);
  return [x, y, z];
}

function nameToHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}