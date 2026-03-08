import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db, auth, provider } from './firebase';
import { collection, addDoc, onSnapshot } from 'firebase/firestore';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet';
import Webcam from 'react-webcam';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// 3D & AR Imports
import { Canvas } from '@react-three/fiber';
import { ARButton, XR } from '@react-three/xr';
import { Text } from '@react-three/drei';

// Fix Leaflet icons for Vite
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const VISIBILITY_RADIUS = 50; // Show banners within 50 meters

// Haversine distance for filtering what is nearby horizontally
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))); 
};

// Convert GPS and Altitude into 3D space coordinates (X, Y, Z in meters)
const getRelativePosition = (userLat, userLng, userAlt, targetLat, targetLng, targetAlt) => {
  // X = Left/Right (Longitude difference)
  const dx = (targetLng - userLng) * 111320 * Math.cos(userLat * Math.PI / 180);
  
  // Y = Up/Down (Altitude difference)
  const dy = (targetAlt || 0) - (userAlt || 0); 
  
  // Z = Forward/Backward (Latitude difference, WebXR uses negative Z for forward)
  const dz = (userLat - targetLat) * 111320; 
  
  return [dx, dy, dz]; 
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  
  // Navigation State
  const [activeTab, setActiveTab] = useState('capture'); // 'capture' | 'explore'
  const [exploreMode, setExploreMode] = useState('map'); // 'map' | 'ar'
  
  const [location, setLocation] = useState(null);
  const [banners, setBanners] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const webcamRef = useRef(null);

  // 1. Authentication Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // 2. GPS & Altitude Tracker
  useEffect(() => {
    if (!user) return;
    if (!('geolocation' in navigator)) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setLocation({ 
          lat: pos.coords.latitude, 
          lng: pos.coords.longitude,
          alt: pos.coords.altitude || 0 // Default to 0 if sensor is unavailable
        });
      },
      (err) => console.error("GPS Error:", err),
      { enableHighAccuracy: true, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [user]);

  // 3. Firestore Realtime Sync
  useEffect(() => {
    if (!user) return;
    const unsubscribe = onSnapshot(collection(db, "geoBanners"), (snapshot) => {
      const allBanners = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setBanners(allBanners);
    });
    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = async () => signOut(auth);

  // 4. Anchor Banner to Current Location & Altitude
  const captureAndAnchor = useCallback(async () => {
    if (!location || !user) return;
    setIsProcessing(true);

    try {
      await addDoc(collection(db, "geoBanners"), {
        uid: user.uid,
        name: user.displayName || "Unknown Explorer", 
        lat: location.lat,
        lng: location.lng,
        alt: location.alt, // Saves altitude to the database
        timestamp: new Date().toISOString()
      });
      // Switch to map automatically to view the newly dropped banner
      setActiveTab('explore');
      setExploreMode('map');
    } catch (error) {
      console.error("Error saving banner:", error);
    } finally {
      setIsProcessing(false);
    }
  }, [location, user]);

  // Only render banners that are within the 50m radius
  const visibleBanners = banners.filter(b => {
    if (!location) return false;
    return getDistance(location.lat, location.lng, b.lat, b.lng) <= VISIBILITY_RADIUS;
  });

  // --- UI RENDERERS ---

  if (authLoading) return <div className="h-screen bg-black text-white flex items-center justify-center font-bold">Loading GeoBanner...</div>;

  if (!user) {
    return (
      <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6">
        <h1 className="text-5xl font-black mb-8 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">GeoBanner</h1>
        <button onClick={handleLogin} className="w-full max-w-sm bg-white text-black font-bold py-4 rounded-full hover:bg-gray-200 transition">
          Sign in with Google
        </button>
      </div>
    );
  }

  if (!location) {
    return (
      <div className="h-screen bg-black flex flex-col items-center justify-center space-y-4">
        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-white font-semibold">Acquiring 3D GPS Lock...</p>
        <p className="text-gray-500 text-sm">Mapping Latitude, Longitude, and Altitude.</p>
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-gray-100 flex flex-col relative">
      
      {/* Top HUD */}
      <div className="absolute top-0 w-full p-4 z-20 flex justify-between pointer-events-none">
        <div className="bg-black/70 backdrop-blur text-white px-4 py-2 rounded-full text-sm font-semibold shadow pointer-events-auto">
          {user.displayName}
        </div>
        <button onClick={handleLogout} className="bg-red-500/90 backdrop-blur text-white px-4 py-2 rounded-full text-sm font-bold shadow pointer-events-auto hover:bg-red-600">
          Exit
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-grow relative z-0 overflow-hidden">
        
        {/* --- TAB 1: CAPTURE MODE --- */}
        {activeTab === 'capture' && (
          <div className="h-full w-full relative bg-black">
            <Webcam
              audio={false}
              ref={webcamRef}
              screenshotFormat="image/jpeg"
              videoConstraints={{ facingMode: "environment" }}
              className="w-full h-full object-cover"
            />
            
            {/* HUD Overlay for Camera */}
            <div className="absolute top-20 w-full flex justify-center pointer-events-none">
              <span className="bg-black/50 text-green-400 px-3 py-1 rounded-full text-xs font-mono backdrop-blur">
                Alt: {Math.round(location.alt)}m
              </span>
            </div>

            <div className="absolute bottom-24 w-full flex justify-center z-10">
              <button 
                onClick={captureAndAnchor}
                disabled={isProcessing}
                className="w-20 h-20 rounded-full border-4 border-white flex items-center justify-center hover:scale-105 active:scale-95 bg-transparent transition-all"
              >
                <div className={`w-16 h-16 rounded-full ${isProcessing ? 'bg-blue-500 animate-pulse' : 'bg-white'}`}></div>
              </button>
            </div>
          </div>
        )}

        {/* --- TAB 2: EXPLORE MODE --- */}
        {activeTab === 'explore' && (
          <div className="h-full w-full relative">
            
            {/* Map / AR Toggle Switch */}
            <div className="absolute top-20 w-full flex justify-center z-20 pointer-events-none">
              <div className="bg-white p-1 rounded-full shadow-lg flex pointer-events-auto">
                <button 
                  onClick={() => setExploreMode('map')} 
                  className={`px-6 py-2 rounded-full font-bold text-sm transition ${exploreMode === 'map' ? 'bg-black text-white' : 'text-gray-500 hover:bg-gray-100'}`}
                >
                  2D Map
                </button>
                <button 
                  onClick={() => setExploreMode('ar')} 
                  className={`px-6 py-2 rounded-full font-bold text-sm transition ${exploreMode === 'ar' ? 'bg-black text-white' : 'text-gray-500 hover:bg-gray-100'}`}
                >
                  3D AR
                </button>
              </div>
            </div>

            {/* 2D Map View */}
            {exploreMode === 'map' && (
              <MapContainer center={[location.lat, location.lng]} zoom={18} zoomControl={false} style={{ height: '100%', width: '100%' }}>
                <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                <Marker position={[location.lat, location.lng]} />
                <Circle center={[location.lat, location.lng]} radius={VISIBILITY_RADIUS} pathOptions={{ color: 'blue', fillColor: 'blue', fillOpacity: 0.1 }} />
                
                {visibleBanners.map((banner) => (
                  <Marker key={banner.id} position={[banner.lat, banner.lng]}>
                    <Popup className="font-bold text-center">
                      <span className="text-lg">{banner.name}</span><br/>
                      <span className="text-xs text-gray-500">Alt: {Math.round(banner.alt || 0)}m</span>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            )}

            {/* 3D AR View */}
            {exploreMode === 'ar' && (
              <div className="h-full w-full bg-gray-900 flex flex-col items-center justify-center relative">
                
                <div className="absolute bottom-32 z-30">
                  <ARButton className="bg-blue-600 text-white px-8 py-4 rounded-full font-bold shadow-xl hover:bg-blue-700 transition" />
                </div>
                
                <p className="text-gray-400 absolute mt-16 text-center px-6">
                  Click "Enter AR". Point your camera around to see nearby names floating exactly where they were anchored.
                </p>

                <Canvas>
                  <XR>
                    <ambientLight intensity={1} />
                    {visibleBanners.map((banner) => {
                      const [x, y, z] = getRelativePosition(
                        location.lat, location.lng, location.alt, 
                        banner.lat, banner.lng, banner.alt
                      );
                      
                      return (
                        <Text
                          key={banner.id}
                          position={[x, y, z]} 
                          fontSize={1.5}
                          color="white"
                          anchorX="center"
                          anchorY="middle"
                          outlineWidth={0.05}
                          outlineColor="black"
                        >
                          {banner.name}
                        </Text>
                      );
                    })}
                  </XR>
                </Canvas>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Navigation Bar */}
      <div className="bg-white border-t border-gray-200 flex justify-around items-center p-4 z-20 pb-safe">
        <button 
          onClick={() => setActiveTab('capture')} 
          className={`flex flex-col items-center gap-1 transition ${activeTab === 'capture' ? 'text-blue-600 scale-110' : 'text-gray-400 hover:text-gray-600'}`}
        >
          <span className="text-2xl">📷</span>
          <span className="text-xs font-bold">Capture</span>
        </button>
        <button 
          onClick={() => setActiveTab('explore')} 
          className={`flex flex-col items-center gap-1 transition ${activeTab === 'explore' ? 'text-blue-600 scale-110' : 'text-gray-400 hover:text-gray-600'}`}
        >
          <span className="text-2xl">🗺️</span>
          <span className="text-xs font-bold">Explore</span>
        </button>
      </div>

    </div>
  );
}