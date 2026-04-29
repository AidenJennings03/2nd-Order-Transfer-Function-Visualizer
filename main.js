'use strict';

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
  zeta: 0.5,
  omega0: 1.0,
  omegaSweep: 1.0,      // current sweep frequency
  phaseColorMode: false,
  showPoleLines: false,
  showPhaseAngles: false,
  showStepResponse: true,
  autoPlaying: false,
  animFrame: null,
};

// ─── Math helpers ────────────────────────────────────────────────────────────
function evalH(sigma, omega, zeta, omega0) {
  // H(s) = omega0^2 / (s^2 + 2*zeta*omega0*s + omega0^2),  s = sigma + j*omega
  const w02 = omega0 * omega0;
  // denominator: s^2 + 2z*w0*s + w0^2
  // Re(denom) = sigma^2 - omega^2 + 2*zeta*omega0*sigma + w02
  // Im(denom) = 2*sigma*omega + 2*zeta*omega0*omega
  const dr = sigma * sigma - omega * omega + 2 * zeta * omega0 * sigma + w02;
  const di = 2 * sigma * omega + 2 * zeta * omega0 * omega;
  const denom2 = dr * dr + di * di;
  if (denom2 === 0) return { mag: Infinity, phase: 0 };
  // H = w02 / (dr + j*di)  → mag = w02 / |denom|
  const mag = w02 / Math.sqrt(denom2);
  const phase = -Math.atan2(di, dr);  // angle of 1/(dr+j*di) = -atan2(di,dr)
  return { mag, phase };
}

function magDB(sigma, omega, zeta, omega0) {
  const { mag } = evalH(sigma, omega, zeta, omega0);
  if (!isFinite(mag) || mag === 0) return -60;
  return Math.max(-60, Math.min(40, 20 * Math.log10(mag)));
}

function poleLocations(zeta, omega0) {
  if (zeta < 1) {
    const wd = omega0 * Math.sqrt(1 - zeta * zeta);
    const sigma = -zeta * omega0;
    return [
      { sigma, omega: wd },
      { sigma, omega: -wd },
    ];
  } else if (zeta === 1) {
    return [{ sigma: -omega0, omega: 0 }];
  } else {
    const r = omega0 * Math.sqrt(zeta * zeta - 1);
    return [
      { sigma: -zeta * omega0 + r, omega: 0 },
      { sigma: -zeta * omega0 - r, omega: 0 },
    ];
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
function formatOmega(w) {
  const fmt = v => v < 1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1);
  if (w >= 1e9) return fmt(w / 1e9) + ' Grad/s';
  if (w >= 1e6) return fmt(w / 1e6) + ' Mrad/s';
  if (w >= 1e3) return fmt(w / 1e3) + ' krad/s';
  return fmt(w) + ' rad/s';
}

function poleScale(omega0) {
  if (omega0 >= 1e9) return { s: 1e9, unit: 'Grad/s' };
  if (omega0 >= 1e6) return { s: 1e6, unit: 'Mrad/s' };
  if (omega0 >= 1e3) return { s: 1e3, unit: 'krad/s' };
  return { s: 1, unit: 'rad/s' };
}

function stepTimeScale(tMaxSeconds) {
  if (tMaxSeconds < 1e-6) return { s: 1e9, unit: 'ns' };
  if (tMaxSeconds < 1e-3) return { s: 1e6, unit: 'μs' };
  if (tMaxSeconds < 1)    return { s: 1e3, unit: 'ms' };
  return { s: 1, unit: 's' };
}

// ─── Three.js setup ──────────────────────────────────────────────────────────
const GRID = 150;
const DB_MIN = -60, DB_MAX = 40;

let renderer, scene, camera, controls;
let surfaceMesh, jwAxisLine, sweepPoint, poleMarkers = [];
let poleDistLines = [], phaseAngleLines = [];
let colorBuffer;

function initThree() {
  const canvas = document.getElementById('three-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x0d0e14, 1);

  scene = new THREE.Scene();

  const container = document.getElementById('canvas-container');
  const w = container.clientWidth, h = container.clientHeight;
  camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 10000);
  camera.position.set(-1.25, -7, 4.5);
  camera.up.set(0, 0, 1);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Ambient + directional light
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const dl = new THREE.DirectionalLight(0xffffff, 0.8);
  dl.position.set(5, 5, 10);
  scene.add(dl);

  // Axes helper (thin lines)
  const axMat = new THREE.LineBasicMaterial({ color: 0x2a2d3e });
  const axGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-5, 0, 0), new THREE.Vector3(5, 0, 0),
  ]);
  scene.add(new THREE.Line(axGeo, axMat));

  buildSurface();
  buildJwAxisLine();
  buildSweepPoint();
  updatePoleMarkers();

  renderer.setSize(w, h);
  animate();

  window.addEventListener('resize', onResize);
}

function onResize() {
  const container = document.getElementById('canvas-container');
  const w = container.clientWidth, h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ─── Surface ──────────────────────────────────────────────────────────────────
let surfaceGeo, surfaceMat;

function getSurfaceBounds() {
  // Returns normalized bounds (sigma/omega0, omega/omega0) — fixed world-space, ω₀-invariant.
  const { zeta } = state;
  let leftExtent = 3.0;
  if (zeta >= 1) {
    leftExtent = Math.max(3.0, zeta + Math.sqrt(zeta * zeta - 1) + 0.8);
  }
  return { sigMin: -leftExtent, sigMax: 0.5, omMin: -2.5, omMax: 2.5 };
}

function buildSurface() {
  if (surfaceMesh) { scene.remove(surfaceMesh); surfaceMesh.geometry.dispose(); surfaceMesh.material.dispose(); }

  const { sigMin, sigMax, omMin, omMax } = getSurfaceBounds();
  const N = GRID;
  const geo = new THREE.PlaneGeometry(1, 1, N - 1, N - 1);
  geo.rotateX(0); // will set positions manually

  const pos = geo.attributes.position;
  const count = pos.count;
  colorBuffer = new Float32Array(count * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colorBuffer, 3));

  // Map PlaneGeometry UV grid to (sigma, omega) coords
  computeSurfaceVertices(geo, sigMin, sigMax, omMin, omMax);

  surfaceMat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    shininess: 30,
    transparent: true,
    opacity: 0.92,
  });
  surfaceMesh = new THREE.Mesh(geo, surfaceMat);
  scene.add(surfaceMesh);

  buildJwAxisLine();
}

function computeSurfaceVertices(geo, sigMin, sigMax, omMin, omMax) {
  // sigMin/sigMax/omMin/omMax are in normalized coords (sigma/omega0).
  // World positions use these directly; evalH receives physical sigma = norm * omega0.
  const { zeta, omega0, phaseColorMode } = state;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const N = GRID;

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const idx = i * N + j;
      const normSigma = sigMin + (sigMax - sigMin) * (j / (N - 1));
      const normOmega = omMin + (omMax - omMin) * (i / (N - 1));
      // Physical values for H(s) — evalH needs actual rad/s
      const { mag, phase } = evalH(normSigma * omega0, normOmega * omega0, zeta, omega0);
      let db = isFinite(mag) && mag > 0 ? 20 * Math.log10(mag) : -60;
      db = Math.max(DB_MIN, Math.min(DB_MAX, db));

      const z = dbToZ(db);
      pos.setXYZ(idx, normSigma, normOmega, z);

      let t;
      if (phaseColorMode) {
        // color by phase: map [-pi, pi] -> [0,1]
        t = (phase + Math.PI) / (2 * Math.PI);
      } else {
        t = (db - DB_MIN) / (DB_MAX - DB_MIN);
      }
      const [r, g, b] = viridis(t);
      col.setXYZ(idx, r, g, b);
    }
  }

  pos.needsUpdate = true;
  col.needsUpdate = true;
  geo.computeVertexNormals();
}

function updateSurface() {
  if (!surfaceMesh) return;
  const { sigMin, sigMax, omMin, omMax } = getSurfaceBounds();
  computeSurfaceVertices(surfaceMesh.geometry, sigMin, sigMax, omMin, omMax);
  buildJwAxisLine();
  updatePoleMarkers();
  updateSweepPoint();
  updateOverlayLines();
}

function dbToZ(db) {
  return (db - DB_MIN) / (DB_MAX - DB_MIN) * 3 - 0.5;
}

// ─── jω axis line ────────────────────────────────────────────────────────────
let jwLine;
function buildJwAxisLine() {
  if (jwLine) { scene.remove(jwLine); jwLine.geometry.dispose(); }

  const { zeta, omega0 } = state;
  const { omMin, omMax } = getSurfaceBounds();
  const NPTS = 400;
  const pts = [];
  for (let i = 0; i < NPTS; i++) {
    const normOmega = omMin + (omMax - omMin) * (i / (NPTS - 1));
    const db = magDB(0, normOmega * omega0, zeta, omega0);
    pts.push(new THREE.Vector3(0, normOmega, dbToZ(db) + 0.03));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0x00ffcc, linewidth: 2 });
  jwLine = new THREE.Line(geo, mat);
  scene.add(jwLine);
}

// ─── Sweep point ──────────────────────────────────────────────────────────────
let sweepSphere;
function buildSweepPoint() {
  const geo = new THREE.SphereGeometry(0.06, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  sweepSphere = new THREE.Mesh(geo, mat);
  scene.add(sweepSphere);
  updateSweepPoint();
}

function updateSweepPoint() {
  const { zeta, omega0, omegaSweep } = state;
  const db = magDB(0, omegaSweep, zeta, omega0);
  // World Y uses normalized coordinate omega/omega0
  sweepSphere.position.set(0, omegaSweep / omega0, dbToZ(db) + 0.07);

  updateOverlayLines();
}

// ─── Pole markers ─────────────────────────────────────────────────────────────
function updatePoleMarkers() {
  poleMarkers.forEach(m => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
  poleMarkers = [];

  const { zeta, omega0 } = state;
  const poles = poleLocations(zeta, omega0);
  const zTop = dbToZ(DB_MAX);
  const zBot = dbToZ(DB_MIN);
  poles.forEach(p => {
    // Normalize pole position to world space
    const nx = p.sigma / omega0;
    const ny = p.omega / omega0;

    const geo = new THREE.CylinderGeometry(0.03, 0.03, zTop - zBot, 8);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff4444 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(nx, ny, (zTop + zBot) / 2);
    scene.add(mesh);
    poleMarkers.push(mesh);

    const sgeo = new THREE.SphereGeometry(0.07, 16, 16);
    const smat = new THREE.MeshBasicMaterial({ color: 0xff8888 });
    const sphere = new THREE.Mesh(sgeo, smat);
    sphere.position.set(nx, ny, zTop + 0.05);
    scene.add(sphere);
    poleMarkers.push(sphere);
  });
}

// ─── Overlay lines (pole-distance & phase-angle) ─────────────────────────────
function updateOverlayLines() {
  // Remove old
  poleDistLines.forEach(l => { scene.remove(l); l.geometry.dispose(); l.material.dispose(); });
  poleDistLines = [];
  phaseAngleLines.forEach(l => { scene.remove(l); l.geometry.dispose(); l.material.dispose(); });
  phaseAngleLines = [];

  const { zeta, omega0, omegaSweep, showPoleLines, showPhaseAngles } = state;
  if (!showPoleLines && !showPhaseAngles) return;

  const poles = poleLocations(zeta, omega0);
  const db = magDB(0, omegaSweep, zeta, omega0);
  const normSweep = omegaSweep / omega0;
  const pSweep = new THREE.Vector3(0, normSweep, dbToZ(db) + 0.07);

  poles.forEach((p, idx) => {
    const nx = p.sigma / omega0;
    const ny = p.omega / omega0;
    const pPole = new THREE.Vector3(nx, ny, dbToZ(DB_MAX) + 0.05);

    if (showPoleLines) {
      const geo = new THREE.BufferGeometry().setFromPoints([pPole, pSweep]);
      const mat = new THREE.LineBasicMaterial({ color: idx === 0 ? 0xff8800 : 0xff00ff });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      poleDistLines.push(line);
    }

    if (showPhaseAngles) {
      const midY = (ny + normSweep) / 2;
      const arcPts = [
        new THREE.Vector3(nx, ny, pPole.z),
        new THREE.Vector3(nx / 2, midY, (pPole.z + pSweep.z) / 2),
        pSweep.clone(),
      ];
      const geo = new THREE.BufferGeometry().setFromPoints(arcPts);
      const mat = new THREE.LineBasicMaterial({ color: idx === 0 ? 0x00ccff : 0xcc00ff });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      phaseAngleLines.push(line);
    }
  });
}

// ─── Viridis colormap ─────────────────────────────────────────────────────────
function viridis(t) {
  t = Math.max(0, Math.min(1, t));
  // Approximate viridis with key stops
  const stops = [
    [0.267, 0.005, 0.329],
    [0.283, 0.141, 0.458],
    [0.254, 0.265, 0.530],
    [0.207, 0.372, 0.553],
    [0.164, 0.471, 0.558],
    [0.128, 0.567, 0.551],
    [0.135, 0.659, 0.518],
    [0.267, 0.749, 0.441],
    [0.478, 0.821, 0.318],
    [0.741, 0.873, 0.150],
    [0.993, 0.906, 0.144],
  ];
  const pos = t * (stops.length - 1);
  const lo = Math.floor(pos), hi = Math.min(stops.length - 1, lo + 1);
  const f = pos - lo;
  return [
    stops[lo][0] + f * (stops[hi][0] - stops[lo][0]),
    stops[lo][1] + f * (stops[hi][1] - stops[lo][1]),
    stops[lo][2] + f * (stops[hi][2] - stops[lo][2]),
  ];
}

// ─── Three.js render loop ─────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ─── Plotly Bode plots ────────────────────────────────────────────────────────
const NBODE = 500;

function logspace(start, stop, n) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push(Math.pow(10, start + (stop - start) * i / (n - 1)));
  }
  return arr;
}

function computeBodeData(zeta, omega0) {
  const wmin = omega0 * 0.05, wmax = omega0 * 50;
  const freqs = logspace(Math.log10(wmin), Math.log10(wmax), NBODE);

  const magExact = [], phaseExact = [], magAsymp = [], phaseAsymp = [];

  freqs.forEach(w => {
    const { mag, phase } = evalH(0, w, zeta, omega0);
    const db = mag > 0 ? 20 * Math.log10(mag) : -120;
    magExact.push(db);
    phaseExact.push(phase * 180 / Math.PI);

    // Asymptotic: piecewise linear in dB
    // low freq: 0 dB, high freq: -40 dB/dec from omega0
    let asymDb;
    if (w < omega0) {
      asymDb = 0;
    } else {
      asymDb = -40 * Math.log10(w / omega0);
    }
    magAsymp.push(asymDb);

    // Asymptotic phase
    let asymPhase;
    const ratio = w / omega0;
    if (ratio < 0.1) asymPhase = 0;
    else if (ratio > 10) asymPhase = -180;
    else asymPhase = -90 * (1 + Math.log10(ratio) / 1);
    phaseAsymp.push(asymPhase);
  });

  return { freqs, magExact, phaseExact, magAsymp, phaseAsymp };
}

const plotlyLayout = (title, yaxis) => ({
  paper_bgcolor: '#0d0e14',
  plot_bgcolor: '#13151f',
  font: { family: 'SF Mono, Fira Code, monospace', size: 11, color: '#e0e4f0' },
  title: { text: title, font: { size: 12 }, x: 0.02, xanchor: 'left' },
  margin: { l: 52, r: 14, t: 30, b: 32 },
  xaxis: {
    type: 'log', color: '#6b7090', gridcolor: '#1e2030',
    showgrid: true, zeroline: false,
    title: { text: 'ω (rad/s)', font: { size: 10 } },
  },
  yaxis: {
    ...yaxis, color: '#6b7090', gridcolor: '#1e2030',
    showgrid: true, zeroline: true, zerolinecolor: '#2a2d3e',
  },
  showlegend: true,
  legend: { bgcolor: 'rgba(0,0,0,0)', font: { size: 10 } },
});

const plotlyConfig = { responsive: true, displayModeBar: false };

let bodeInitialized = false;

function initBodePlots() {
  const { zeta, omega0, omegaSweep } = state;
  const d = computeBodeData(zeta, omega0);
  const vlineShape = (x, color) => ({
    type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1,
    line: { color, width: 1, dash: 'dot' },
  });

  const { wd, wr, Mp, shapes_mag, shapes_phase, annotations_mag } = getDerivedParams(zeta, omega0);

  // Sweep vertical line
  const sweepShapeMag = { ...vlineShape(omegaSweep, '#ffff00'), name: 'sweep' };
  const sweepShapePhase = { ...vlineShape(omegaSweep, '#ffff00'), name: 'sweep' };

  const magTraces = [
    { x: d.freqs, y: d.magExact, name: 'Exact', line: { color: '#00ffcc', width: 2 }, type: 'scatter', mode: 'lines' },
    { x: d.freqs, y: d.magAsymp, name: 'Asymptote', line: { color: '#7b61ff', width: 1, dash: 'dash' }, type: 'scatter', mode: 'lines' },
  ];
  const phaseTraces = [
    { x: d.freqs, y: d.phaseExact, name: 'Exact', line: { color: '#00ccff', width: 2 }, type: 'scatter', mode: 'lines' },
    { x: d.freqs, y: d.phaseAsymp, name: 'Asymptote', line: { color: '#ff6b6b', width: 1, dash: 'dash' }, type: 'scatter', mode: 'lines' },
  ];

  const magLayout = {
    ...plotlyLayout('Magnitude (dB)', { title: { text: '|H(jω)| dB', font: { size: 10 } } }),
    shapes: [...shapes_mag, sweepShapeMag],
    annotations: annotations_mag,
  };
  const phaseLayout = {
    ...plotlyLayout('Phase (deg)', { title: { text: '∠H(jω) °', font: { size: 10 } }, range: [-200, 20] }),
    shapes: [...shapes_phase, sweepShapePhase],
  };

  Plotly.newPlot('plot-magnitude', magTraces, magLayout, plotlyConfig);
  Plotly.newPlot('plot-phase', phaseTraces, phaseLayout, plotlyConfig);

  bodeInitialized = true;
}

function getDerivedParams(zeta, omega0) {
  const wd = zeta < 1 ? omega0 * Math.sqrt(1 - zeta * zeta) : null;
  const wr = zeta < 1 / Math.SQRT2 ? omega0 * Math.sqrt(1 - 2 * zeta * zeta) : null;
  const Mp = zeta < 1 ? 1 / (2 * zeta * Math.sqrt(1 - zeta * zeta)) : null;
  const MpDb = Mp ? 20 * Math.log10(Mp) : null;

  const vline = (x, color, dash = 'dot') => ({
    type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1,
    line: { color, width: 1, dash },
  });

  const shapes_mag = [vline(omega0, '#ff8800', 'dashdot')];
  const shapes_phase = [vline(omega0, '#ff8800', 'dashdot')];
  const annotations_mag = [{
    x: Math.log10(omega0), xref: 'x', y: 1, yref: 'paper',
    text: 'ω₀', showarrow: false, font: { color: '#ff8800', size: 10 },
    xanchor: 'left', yanchor: 'top',
  }];

  if (wd) {
    shapes_mag.push(vline(wd, '#aa00ff'));
    shapes_phase.push(vline(wd, '#aa00ff'));
    annotations_mag.push({
      x: Math.log10(wd), xref: 'x', y: 0.85, yref: 'paper',
      text: 'ωd', showarrow: false, font: { color: '#aa00ff', size: 10 },
      xanchor: 'left', yanchor: 'top',
    });
  }
  if (wr && MpDb !== null) {
    shapes_mag.push(vline(wr, '#ff4488'));
    shapes_phase.push(vline(wr, '#ff4488'));
    annotations_mag.push({
      x: Math.log10(wr), xref: 'x', y: 0.7, yref: 'paper',
      text: `ωr, Mp=${MpDb.toFixed(1)}dB`, showarrow: false,
      font: { color: '#ff4488', size: 10 }, xanchor: 'left', yanchor: 'top',
    });
  }

  return { wd, wr, Mp, MpDb, shapes_mag, shapes_phase, annotations_mag };
}

function updateBodePlots() {
  if (!bodeInitialized) { initBodePlots(); return; }
  const { zeta, omega0, omegaSweep } = state;
  const d = computeBodeData(zeta, omega0);
  const { shapes_mag, shapes_phase, annotations_mag } = getDerivedParams(zeta, omega0);
  const sweepShape = x => ({
    type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1,
    line: { color: '#ffff00', width: 1.5, dash: 'dot' },
  });

  Plotly.update('plot-magnitude',
    { x: [d.freqs, d.freqs], y: [d.magExact, d.magAsymp] },
    { shapes: [...shapes_mag, sweepShape(omegaSweep)], annotations: annotations_mag }
  );
  Plotly.update('plot-phase',
    { x: [d.freqs, d.freqs], y: [d.phaseExact, d.phaseAsymp] },
    { shapes: [...shapes_phase, sweepShape(omegaSweep)] }
  );
}

// ─── Step response ────────────────────────────────────────────────────────────
let stepInitialized = false;

function computeStepResponse(zeta, omega0) {
  const tMaxRaw = 12 / (zeta * omega0 + 0.01);
  const { s: tScale, unit: tUnit } = stepTimeScale(tMaxRaw);
  const N = 600;
  const dt = tMaxRaw / N;
  const t = [], y = [];
  for (let i = 0; i <= N; i++) {
    const ti = i * dt;
    t.push(ti * tScale);
    let yi;
    if (zeta < 1) {
      const wd = omega0 * Math.sqrt(1 - zeta * zeta);
      yi = 1 - Math.exp(-zeta * omega0 * ti) * (Math.cos(wd * ti) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * ti));
    } else if (Math.abs(zeta - 1) < 1e-6) {
      yi = 1 - Math.exp(-omega0 * ti) * (1 + omega0 * ti);
    } else {
      const r = omega0 * Math.sqrt(zeta * zeta - 1);
      const s1 = -zeta * omega0 + r, s2 = -zeta * omega0 - r;
      yi = 1 + (s2 / (s1 - s2)) * Math.exp(s1 * ti) - (s1 / (s1 - s2)) * Math.exp(s2 * ti);
      if (!isFinite(yi)) yi = 1;
    }
    y.push(yi);
  }
  return { t, y, tUnit };
}

function initStepPlot() {
  const { zeta, omega0 } = state;
  const { t, y, tUnit } = computeStepResponse(zeta, omega0);
  const traces = [
    { x: t, y, name: 'Step response', line: { color: '#ff8800', width: 2 }, type: 'scatter', mode: 'lines' },
    { x: [t[t.length - 1]], y: [1], mode: 'lines', name: 'Final value', line: { color: '#6b7090', dash: 'dot', width: 1 }, showlegend: false },
  ];
  const layout = {
    paper_bgcolor: '#0d0e14', plot_bgcolor: '#13151f',
    font: { family: 'SF Mono, Fira Code, monospace', size: 11, color: '#e0e4f0' },
    title: { text: 'Step Response', font: { size: 12 }, x: 0.02, xanchor: 'left' },
    margin: { l: 52, r: 14, t: 30, b: 32 },
    xaxis: { title: { text: `Time (${tUnit})`, font: { size: 10 } }, color: '#6b7090', gridcolor: '#1e2030', showgrid: true },
    yaxis: { title: { text: 'y(t)', font: { size: 10 } }, color: '#6b7090', gridcolor: '#1e2030', showgrid: true, zeroline: true, zerolinecolor: '#2a2d3e' },
    showlegend: false,
    shapes: [{
      type: 'line', x0: 0, x1: t[t.length - 1], y0: 1, y1: 1,
      line: { color: '#2a2d3e', width: 1, dash: 'dot' },
    }],
  };
  Plotly.newPlot('plot-step', traces, layout, plotlyConfig);
  stepInitialized = true;
}

function updateStepPlot() {
  if (!state.showStepResponse) {
    document.getElementById('plot-step').style.display = 'none';
    return;
  }
  document.getElementById('plot-step').style.display = '';
  if (!stepInitialized) { initStepPlot(); return; }
  const { zeta, omega0 } = state;
  const { t, y, tUnit } = computeStepResponse(zeta, omega0);
  Plotly.update('plot-step', { x: [t], y: [y] }, {
    'xaxis.title.text': `Time (${tUnit})`,
    shapes: [{
      type: 'line', x0: 0, x1: t[t.length - 1], y0: 1, y1: 1,
      line: { color: '#2a2d3e', width: 1, dash: 'dot' },
    }],
  });
}

// ─── Readouts ─────────────────────────────────────────────────────────────────
function updateReadouts() {
  const { zeta, omega0 } = state;
  document.getElementById('zeta-readout').textContent = zeta.toFixed(3);
  document.getElementById('omega0-readout').textContent = formatOmega(omega0);
  document.getElementById('omega-sweep-readout').textContent = formatOmega(state.omegaSweep);

  const poles = poleLocations(zeta, omega0);
  const { s, unit } = poleScale(omega0);
  const poleStr = poles.map(p => {
    const re = (p.sigma / s).toFixed(3);
    if (Math.abs(p.omega) < 1e-9) return `${re} ${unit}`;
    return `${re} ± j${(Math.abs(p.omega) / s).toFixed(3)} ${unit}`;
  }).join(', ');
  document.getElementById('pole-readout').textContent = poleStr;

  const Q = 1 / (2 * zeta);
  document.getElementById('q-readout').textContent = Q.toFixed(3);

  if (zeta < 1) {
    const Mp = 1 / (2 * zeta * Math.sqrt(1 - zeta * zeta));
    const MpDb = 20 * Math.log10(Mp);
    document.getElementById('mp-readout').textContent = MpDb.toFixed(2);
  } else {
    document.getElementById('mp-readout').textContent = 'N/A';
  }
}

// ─── Sweep slider mapping ──────────────────────────────────────────────────────
function sweepSliderToOmega(val) {
  // val in [0,1] → omega in [0.1*omega0, 10*omega0] log scale
  const { omega0 } = state;
  return omega0 * Math.pow(10, -1 + 2 * val);  // 0.1 to 10 * omega0
}

// ─── Controls wiring ──────────────────────────────────────────────────────────
function initControls() {
  // Zeta slider (log scale)
  const zetaSlider = document.getElementById('zeta-slider');
  zetaSlider.addEventListener('input', () => {
    state.zeta = Math.exp(parseFloat(zetaSlider.value));
    onParamsChanged();
  });

  // Omega0 slider (log scale)
  const omega0Slider = document.getElementById('omega0-slider');
  omega0Slider.addEventListener('input', () => {
    state.omega0 = Math.exp(parseFloat(omega0Slider.value));
    // Keep sweep frequency relative
    const sweepSlider = document.getElementById('omega-sweep-slider');
    state.omegaSweep = sweepSliderToOmega(parseFloat(sweepSlider.value));
    onParamsChanged();
  });

  // Omega sweep slider
  const sweepSlider = document.getElementById('omega-sweep-slider');
  sweepSlider.addEventListener('input', () => {
    state.omegaSweep = sweepSliderToOmega(parseFloat(sweepSlider.value));
    updateSweepPoint();
    updateBodePlots();
    updateReadouts();
  });

  // Auto-play
  const playBtn = document.getElementById('btn-autoplay');
  playBtn.addEventListener('click', () => {
    state.autoPlaying = !state.autoPlaying;
    playBtn.textContent = state.autoPlaying ? '⏹ Stop' : '▶ Play';
    playBtn.classList.toggle('active', state.autoPlaying);
    if (state.autoPlaying) startAutoPlay();
  });

  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const z = parseFloat(btn.dataset.zeta);
      const w = parseFloat(btn.dataset.omega);
      setPreset(z, w);
    });
  });

  // Overlay toggles
  document.getElementById('toggle-pole-lines').addEventListener('change', e => {
    state.showPoleLines = e.target.checked;
    updateOverlayLines();
  });
  document.getElementById('toggle-phase-angles').addEventListener('change', e => {
    state.showPhaseAngles = e.target.checked;
    updateOverlayLines();
  });
  document.getElementById('toggle-phase-color').addEventListener('change', e => {
    state.phaseColorMode = e.target.checked;
    updateSurface();
  });
  document.getElementById('toggle-step-response').addEventListener('change', e => {
    state.showStepResponse = e.target.checked;
    updateStepPlot();
  });
  document.getElementById('btn-reset-camera').addEventListener('click', resetCamera);
}

function resetCamera() {
  // Bounds are now fixed (normalized), independent of ω₀
  const { sigMin, sigMax, omMin, omMax } = getSurfaceBounds();
  const cx = (sigMin + sigMax) / 2;
  const span = Math.max(sigMax - sigMin, omMax - omMin);
  camera.position.set(cx, omMin - span * 0.85, span * 0.65);
  camera.up.set(0, 0, 1);
  controls.target.set(cx, 0, dbToZ(-10));
  controls.update();
}

function setPreset(zeta, omega0) {
  state.zeta = zeta;
  state.omega0 = omega0;

  document.getElementById('zeta-slider').value = Math.log(zeta);
  document.getElementById('omega0-slider').value = Math.log(omega0);

  onParamsChanged();
  // Reset camera after surface rebuild on next frame
  requestAnimationFrame(resetCamera);
}

let updatePending = false;
function onParamsChanged() {
  if (updatePending) return;
  updatePending = true;
  requestAnimationFrame(() => {
    updatePending = false;
    buildSurface();        // rebuilds mesh with new scale
    updatePoleMarkers();
    updateSweepPoint();
    updateBodePlots();
    updateStepPlot();
    updateReadouts();
  });
}

// ─── Auto-play ────────────────────────────────────────────────────────────────
let autoPlayT = 0;
function startAutoPlay() {
  let last = null;
  function tick(ts) {
    if (!state.autoPlaying) return;
    if (last === null) last = ts;
    const dt = (ts - last) / 1000;
    last = ts;
    autoPlayT = (autoPlayT + dt * 0.2) % 1;  // ~5s loop

    const sweepSlider = document.getElementById('omega-sweep-slider');
    sweepSlider.value = autoPlayT;
    state.omegaSweep = sweepSliderToOmega(autoPlayT);
    updateSweepPoint();
    updateBodePlots();
    updateReadouts();

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  // Set initial sweep
  state.omegaSweep = sweepSliderToOmega(0.5);

  initThree();
  initControls();
  initBodePlots();
  initStepPlot();
  updateReadouts();
  updatePoleMarkers();
  updateSweepPoint();
}

window.addEventListener('load', init);
