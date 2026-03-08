/**
 * ARRenderer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Three.js WebGL engine for rendering geospatially-anchored 3D banners.
 * Implements requirements #8 (Three.js) and #9 (stability under GPS fluctuation).
 *
 * Key stability strategy:
 *   • Banners are placed in a LOCAL coordinate space (metres from anchor).
 *   • The "world origin" is a calibrated anchor point, NOT raw GPS.
 *   • Banner positions are pre-computed and NEVER move — only the camera moves.
 *   • Camera position is updated from filtered GPS (Kalman), not raw GPS.
 *   • Banner Y is fixed; no altitude-based movement unless explicitly set.
 */

import * as THREE from 'three';

// ── Shader for the glow halo behind each banner ──────────────────────────────
const HALO_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const HALO_FRAG = `
  uniform vec3  uColor;
  uniform float uTime;
  varying vec2  vUv;
  void main() {
    vec2  c    = vUv - 0.5;
    float d    = length(c);
    float ring = smoothstep(0.5, 0.3, d) * smoothstep(0.0, 0.2, d);
    float pulse = 0.7 + 0.3 * sin(uTime * 2.0);
    gl_FragColor = vec4(uColor, ring * 0.35 * pulse);
  }
`;

export class ARRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas   = canvas;
    this.banners  = new Map();   // id → { mesh, group, anchor }
    this._clock   = new THREE.Clock();
    this._running = false;
    this._raf     = null;

    this._initThree();
    this._initLights();
    this._buildReticle();
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  _initThree() {
    const w = this.canvas.clientWidth  || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({
      canvas:    this.canvas,
      alpha:     true,          // transparent background — camera feed shows through
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0); // fully transparent

    this.scene  = new THREE.Scene();

    // Perspective camera matching a typical phone FOV
    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 5000);
    this.camera.position.set(0, 0, 0);

    // Handle resize
    window.addEventListener('resize', () => this._onResize());
  }

  _initLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 1.2);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight(0x88bbff, 0.8);
    dir.position.set(5, 10, 5);
    this.scene.add(dir);
  }

  /** Reticle shown during calibration scan */
  _buildReticle() {
    const geo  = new THREE.RingGeometry(0.12, 0.15, 32);
    const mat  = new THREE.MeshBasicMaterial({ color: 0x00ffcc, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
    this.reticle = new THREE.Mesh(geo, mat);
    this.reticle.rotation.x = -Math.PI / 2;
    this.reticle.visible    = false;
    this.scene.add(this.reticle);
  }

  // ── Banner management ────────────────────────────────────────────────────────

  /**
   * Add or update a banner in the 3D scene.
   * @param {object} banner  - { id, name, x, y, z, hue }
   *   x/y/z are LOCAL SPACE metres (pre-computed from GPS by SensorFusion)
   */
  addBanner(banner) {
    if (this.banners.has(banner.id)) this.removeBanner(banner.id);

    const group = new THREE.Group();
    group.position.set(banner.x, banner.y, banner.z);

    // ── Halo disc ──
    const haloGeo = new THREE.PlaneGeometry(2.4, 2.4);
    const haloMat = new THREE.ShaderMaterial({
      vertexShader:   HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent:    true,
      depthWrite:     false,
      uniforms: {
        uColor: { value: new THREE.Color().setHSL(banner.hue / 360, 0.9, 0.6) },
        uTime:  { value: 0 },
      },
    });
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    group.add(haloMesh);

    // ── Banner card (rounded rectangle) ──
    const cardGeo  = this._roundedRect(2.0, 0.7, 0.12);
    const cardMat  = new THREE.MeshStandardMaterial({
      color:       new THREE.Color().setHSL(banner.hue / 360, 0.6, 0.1),
      emissive:    new THREE.Color().setHSL(banner.hue / 360, 0.8, 0.05),
      transparent: true,
      opacity:     0.92,
    });
    const cardMesh = new THREE.Mesh(cardGeo, cardMat);
    cardMesh.position.z = 0.01;
    group.add(cardMesh);

    // ── Card border glow ──
    const edgeGeo  = new THREE.EdgesGeometry(cardGeo);
    const edgeMat  = new THREE.LineBasicMaterial({
      color:       new THREE.Color().setHSL(banner.hue / 360, 0.9, 0.55),
      transparent: true,
      opacity:     0.8,
    });
    const edgeMesh = new THREE.LineSegments(edgeGeo, edgeMat);
    edgeMesh.position.z = 0.015;
    group.add(edgeMesh);

    // ── Text (canvas texture) ──
    const textMesh = this._makeTextMesh(banner.name, banner.hue);
    textMesh.position.set(0, 0, 0.03);
    group.add(textMesh);

    // ── Vertical pole ──
    const poleGeo = new THREE.CylinderGeometry(0.01, 0.01, 1.5, 8);
    const poleMat = new THREE.MeshStandardMaterial({
      color:       new THREE.Color().setHSL(banner.hue / 360, 0.7, 0.4),
      transparent: true,
      opacity:     0.6,
    });
    const poleMesh = new THREE.Mesh(poleGeo, poleMat);
    poleMesh.position.y = -1.1;
    group.add(poleMesh);

    // ── Ground dot ──
    const dotGeo  = new THREE.CircleGeometry(0.15, 16);
    const dotMat  = new THREE.MeshBasicMaterial({
      color:       new THREE.Color().setHSL(banner.hue / 360, 0.9, 0.5),
      transparent: true,
      opacity:     0.5,
    });
    const dotMesh = new THREE.Mesh(dotGeo, dotMat);
    dotMesh.rotation.x = -Math.PI / 2;
    dotMesh.position.y = -1.86;
    group.add(dotMesh);

    this.scene.add(group);
    this.banners.set(banner.id, { group, haloMat, cardMesh, banner });
  }

  removeBanner(id) {
    const entry = this.banners.get(id);
    if (!entry) return;
    this.scene.remove(entry.group);
    entry.group.traverse(c => {
      c.geometry?.dispose();
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
      else c.material?.dispose();
    });
    this.banners.delete(id);
  }

  clearBanners() {
    [...this.banners.keys()].forEach(id => this.removeBanner(id));
  }

  // ── Camera control ──────────────────────────────────────────────────────────

  /**
   * Update camera from sensor fusion output.
   * heading: degrees 0–360 (true north)
   * The camera is ALWAYS at world origin; we rotate the scene around it.
   * This is the key stability trick — banners never move, only the camera rotates.
   */
  updateCamera({ heading, pitch = 0 }) {
    if (heading == null) return;

    // Convert compass heading to Three.js Y rotation
    // Three.js: +X = right, +Y = up, -Z = forward (north before any rotation)
    const yRad = -heading * Math.PI / 180;

    // Clamp pitch to reasonable range
    const pitchClamped = Math.max(-80, Math.min(80, pitch - 90));
    const xRad = pitchClamped * Math.PI / 180;

    // Apply to camera — smooth with quaternion slerp to avoid snapping
    const target = new THREE.Euler(xRad, yRad, 0, 'YXZ');
    const targetQ = new THREE.Quaternion().setFromEuler(target);
    this.camera.quaternion.slerp(targetQ, 0.25); // 0.25 = smooth tracking
  }

  /**
   * Update camera world position from Kalman-filtered GPS.
   * Only called when GPS update arrives, not every frame.
   */
  updateCameraPosition(x, y, z) {
    // Smooth position change to avoid sudden jumps
    this.camera.position.lerp(new THREE.Vector3(x, y, z), 0.3);
  }

  // ── Render loop ─────────────────────────────────────────────────────────────

  start() {
    this._running = true;
    this._loop();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _loop() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(() => this._loop());

    const t = this._clock.getElapsedTime();

    // Billboard — make each banner always face camera
    this.banners.forEach(({ group, haloMat }) => {
      // Update halo pulse uniform
      if (haloMat.uniforms) haloMat.uniforms.uTime.value = t;

      // Billboard: rotate group to face camera on Y axis only
      const dx = this.camera.position.x - group.position.x;
      const dz = this.camera.position.z - group.position.z;
      group.rotation.y = Math.atan2(dx, dz);
    });

    this.renderer.render(this.scene, this.camera);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  _roundedRect(w, h, r) {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + r, -h / 2);
    shape.lineTo( w / 2 - r, -h / 2);
    shape.quadraticCurveTo( w / 2, -h / 2,  w / 2, -h / 2 + r);
    shape.lineTo( w / 2,  h / 2 - r);
    shape.quadraticCurveTo( w / 2,  h / 2,  w / 2 - r,  h / 2);
    shape.lineTo(-w / 2 + r,  h / 2);
    shape.quadraticCurveTo(-w / 2,  h / 2, -w / 2,  h / 2 - r);
    shape.lineTo(-w / 2, -h / 2 + r);
    shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    return new THREE.ShapeGeometry(shape);
  }

  _makeTextMesh(text, hue) {
    const size   = 256;
    const canvas = document.createElement('canvas');
    canvas.width  = size * 4;
    canvas.height = size;
    const ctx    = canvas.getContext('2d');

    // Background: transparent
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Text
    ctx.font      = `bold ${size * 0.48}px "Syne", "DM Sans", sans-serif`;
    ctx.fillStyle = `hsl(${hue}, 85%, 82%)`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = `hsl(${hue}, 90%, 50%)`;
    ctx.shadowBlur   = 18;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const geo     = new THREE.PlaneGeometry(1.9, 0.6);
    const mat     = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    return new THREE.Mesh(geo, mat);
  }

  _onResize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setReticleVisible(v) { this.reticle.visible = v; }

  dispose() {
    this.stop();
    this.clearBanners();
    this.renderer.dispose();
  }
}