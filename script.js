/* ====================================================================
   AIRDRAW — Gesture Controlled Drawing Studio
   Single-file, modular vanilla JS. Sections:
     1. Utilities
     2. Global state / config
     3. Drawing engine (brushes, strokes, undo/redo, export)
     4. Color system (HSV wheel, presets, recents)
     5. Gesture recognition (landmark geometry -> gesture classification)
     6. Hand tracking (MediaPipe wiring, camera)
     7. UI controller (toolbar, panels, HUD, settings, shortcuts)
     8. Fallback pointer/touch drawing
     9. Boot
   ==================================================================== */

/* -------------------------------------------------------------------
   1. UTILITIES
   ------------------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist2D = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
const nowMs = () => performance.now();

function hexToRgb(hex){
  hex = hex.replace('#','');
  if(hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
  const num = parseInt(hex, 16);
  return { r:(num>>16)&255, g:(num>>8)&255, b:num&255 };
}
function rgbToHex(r,g,b){
  return '#' + [r,g,b].map(v => clamp(Math.round(v),0,255).toString(16).padStart(2,'0')).join('');
}
function hsvToRgb(h,s,v){
  h = h/360; let r,g,b;
  const i = Math.floor(h*6);
  const f = h*6 - i;
  const p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
  switch(i % 6){
    case 0: r=v;g=t;b=p; break;
    case 1: r=q;g=v;b=p; break;
    case 2: r=p;g=v;b=t; break;
    case 3: r=p;g=q;b=v; break;
    case 4: r=t;g=p;b=v; break;
    case 5: r=v;g=p;b=q; break;
  }
  return { r:r*255, g:g*255, b:b*255 };
}
function toast(msg, kind='info'){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  if(kind==='warn') el.style.borderColor = 'var(--ember)';
  if(kind==='ok') el.style.borderColor = 'var(--green)';
  $('#toastStack').appendChild(el);
  setTimeout(()=> el.remove(), 2600);
}

/* -------------------------------------------------------------------
   2. GLOBAL STATE / CONFIG
   ------------------------------------------------------------------- */
const STATE = {
  running: false,
  paused: false,
  cameraOn: true,
  mirror: true,
  theme: 'dark',
  fps: 0,
  frameTimes: [],
  handCount: 0,
  trackingConfidence: 0,

  // drawing
  brush: 'pencil',
  color: { r:79, g:232, b:255 },
  opacity: 1,
  size: 10,
  hardness: 70,
  flow: 100,
  smoothing: 0.4,

  // gesture
  gestureSensitivity: 1,
  currentGesture: 'none',
  cursorVisible: true,
  drawing: false,
  lastPoint: null,
  smoothedPoint: null,
  lastMoveTime: 0,

  // hold timers
  palmHoldStart: null,
  palmCleared: false,
  palmPaused: false,

  // recent colors
  recentColors: [],
};

const BRUSHES = [
  { id:'pencil',    label:'Pencil',    icon:'✏️' },
  { id:'marker',    label:'Marker',    icon:'🖊️' },
  { id:'airbrush',  label:'Air Brush', icon:'💨' },
  { id:'paint',     label:'Paint',     icon:'🖌️' },
  { id:'watercolor',label:'Water',     icon:'🎨' },
  { id:'calligraphy',label:'Calli',    icon:'✒️' },
  { id:'neon',      label:'Neon',      icon:'💡' },
  { id:'chalk',     label:'Chalk',     icon:'🧱' },
  { id:'spray',     label:'Spray',     icon:'🌫️' },
  { id:'highlighter',label:'Highlight',icon:'🖍️' },
];

const PRESET_COLORS = [
  '#ffffff','#e7eef5','#8fa2b3','#0a0d12',
  '#ff5757','#ff7a59','#ffa726','#ffd54f',
  '#fff176','#c6ff4f','#5ef2a3','#4fd6a3',
  '#4fe8ff','#4fb3ff','#6f8bff','#8b6fff',
  '#b78bff','#e08bff','#ff8bd6','#ff6f9e',
  '#a05a2c','#c98a4b','#7a5230','#4a3222',
  '#ff0044','#00e5ff','#ffee00','#8a00ff',
  '#00ff88','#ff00aa','#3355ff','#ffffff'
];

/* -------------------------------------------------------------------
   3. DRAWING ENGINE
   ------------------------------------------------------------------- */
const drawCanvas = $('#drawCanvas');
const dctx = drawCanvas.getContext('2d', { willReadFrequently:true });
const overlayCanvas = $('#overlayCanvas');
const octx = overlayCanvas.getContext('2d');

function resizeCanvases(){
  const rect = $('#stageInner').getBoundingClientRect();
  [drawCanvas, overlayCanvas].forEach(c => {
    const prev = document.createElement('canvas');
    prev.width = c.width; prev.height = c.height;
    prev.getContext('2d').drawImage(c, 0, 0);
    c.width = rect.width; c.height = rect.height;
    c.getContext('2d').drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, rect.width, rect.height);
  });
}
window.addEventListener('resize', resizeCanvases);

// ---- Undo / redo stack (snapshot based) ----
const HistoryEngine = {
  stack: [],
  index: -1,
  max: 30,
  pushSnapshot(){
    const data = drawCanvas.toDataURL('image/png');
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(data);
    if(this.stack.length > this.max) this.stack.shift();
    this.index = this.stack.length - 1;
  },
  restore(idx){
    if(idx < 0 || idx >= this.stack.length) return;
    const img = new Image();
    img.onload = () => {
      dctx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
      dctx.drawImage(img, 0, 0, drawCanvas.width, drawCanvas.height);
    };
    img.src = this.stack[idx];
  },
  undo(){
    if(this.index <= 0){ toast('Nothing to undo'); return; }
    this.index--;
    this.restore(this.index);
    toast('Undo');
  },
  redo(){
    if(this.index >= this.stack.length - 1){ toast('Nothing to redo'); return; }
    this.index++;
    this.restore(this.index);
    toast('Redo');
  }
};

const DrawEngine = {
  activeStroke: false,
  points: [],
  lastTime: 0,

  colorStr(alphaMul = 1){
    const { r,g,b } = STATE.color;
    return `rgba(${r|0},${g|0},${b|0},${clamp(STATE.opacity * alphaMul,0,1)})`;
  },

  begin(x, y){
    this.activeStroke = true;
    this.points = [{x,y,t:nowMs()}];
    STATE.smoothedPoint = {x,y};
  },

  move(x, y){
    if(!this.activeStroke) return;
    // exponential smoothing based on smoothing setting
    const s = STATE.smoothing;
    const prev = STATE.smoothedPoint || {x,y};
    const smx = lerp(x, prev.x, s);
    const smy = lerp(y, prev.y, s);
    STATE.smoothedPoint = { x: smx, y: smy };

    const last = this.points[this.points.length - 1];
    const t = nowMs();
    const dt = Math.max(1, t - last.t);
    const speed = dist2D(last.x, last.y, smx, smy) / dt; // px/ms

    this.strokeSegment(last.x, last.y, smx, smy, speed);
    this.points.push({ x: smx, y: smy, t });
    if(this.points.length > 400) this.points.shift();
  },

  end(){
    if(!this.activeStroke) return;
    this.activeStroke = false;
    HistoryEngine.pushSnapshot();
    scheduleAutosave();
  },

  eraseAt(x, y, radius){
    dctx.save();
    dctx.globalCompositeOperation = 'destination-out';
    dctx.beginPath();
    dctx.arc(x, y, radius, 0, Math.PI*2);
    dctx.fill();
    dctx.restore();
  },

  // velocity-based pressure simulation: faster = thinner
  pressureFactor(speed){
    const f = clamp(1.15 - speed * 6, 0.35, 1.25);
    return f;
  },

  strokeSegment(x0, y0, x1, y1, speed){
    const ctx = dctx; // draw directly to the visible canvas so strokes appear live
    const size = STATE.size * this.pressureFactor(speed);
    const hardness = STATE.hardness / 100;
    const flow = STATE.flow / 100;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch(STATE.brush){
      case 'pencil': {
        ctx.globalAlpha = flow;
        ctx.strokeStyle = this.colorStr(0.9);
        ctx.lineWidth = Math.max(1, size * 0.35);
        ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
        break;
      }
      case 'marker': {
        ctx.globalAlpha = flow * 0.85;
        ctx.strokeStyle = this.colorStr(0.8);
        ctx.lineWidth = size * 1.4;
        ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
        break;
      }
      case 'airbrush': {
        const n = Math.max(2, Math.floor(size * 0.6));
        for(let i=0;i<n;i++){
          const rr = Math.random() * size * 0.9;
          const ang = Math.random() * Math.PI * 2;
          const px = x1 + Math.cos(ang)*rr, py = y1 + Math.sin(ang)*rr;
          ctx.globalAlpha = flow * 0.12 * Math.random();
          ctx.fillStyle = this.colorStr(1);
          ctx.beginPath(); ctx.arc(px, py, Math.max(0.6, size*0.06), 0, Math.PI*2); ctx.fill();
        }
        break;
      }
      case 'paint': {
        ctx.globalAlpha = flow * (0.55 + hardness*0.3);
        ctx.strokeStyle = this.colorStr(1);
        ctx.lineWidth = size * (1 + Math.sin(nowMs()*0.02)*0.06);
        ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
        break;
      }
      case 'watercolor': {
        ctx.globalAlpha = flow * 0.06;
        ctx.fillStyle = this.colorStr(1);
        for(let i=0;i<3;i++){
          const jitter = size * 0.5;
          ctx.beginPath();
          ctx.arc(x1 + (Math.random()-0.5)*jitter, y1 + (Math.random()-0.5)*jitter, size*(0.7+Math.random()*0.5), 0, Math.PI*2);
          ctx.fill();
        }
        break;
      }
      case 'calligraphy': {
        const angle = Math.atan2(y1-y0, x1-x0) + Math.PI/4;
        const w = size * 1.1, h = size * 0.35;
        ctx.globalAlpha = flow;
        ctx.fillStyle = this.colorStr(0.95);
        ctx.save();
        ctx.translate(x1,y1); ctx.rotate(angle);
        ctx.beginPath(); ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI*2); ctx.fill();
        ctx.restore();
        break;
      }
      case 'neon': {
        ctx.globalAlpha = flow;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = size * 0.35;
        ctx.shadowBlur = size * 2.2;
        ctx.shadowColor = this.colorStr(1);
        ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = flow * 0.5;
        ctx.strokeStyle = this.colorStr(1);
        ctx.lineWidth = size;
        ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
        break;
      }
      case 'chalk': {
        const steps = Math.max(2, Math.floor(dist2D(x0,y0,x1,y1)/2) + 4);
        for(let i=0;i<steps;i++){
          const t = i/steps;
          const px = lerp(x0,x1,t) + (Math.random()-0.5)*size*0.4;
          const py = lerp(y0,y1,t) + (Math.random()-0.5)*size*0.4;
          ctx.globalAlpha = flow * (0.25 + Math.random()*0.35);
          ctx.fillStyle = this.colorStr(1);
          ctx.beginPath(); ctx.arc(px,py, size*0.12*Math.random()+size*0.05, 0, Math.PI*2); ctx.fill();
        }
        break;
      }
      case 'spray': {
        const n = Math.max(3, Math.floor(size * 1.2));
        for(let i=0;i<n;i++){
          const rr = Math.random() * size * 1.6;
          const ang = Math.random() * Math.PI * 2;
          const px = x1 + Math.cos(ang)*rr, py = y1 + Math.sin(ang)*rr;
          ctx.globalAlpha = flow * 0.5 * Math.random();
          ctx.fillStyle = this.colorStr(1);
          ctx.fillRect(px, py, 1.4, 1.4);
        }
        break;
      }
      case 'highlighter': {
        ctx.globalAlpha = flow * 0.35;
        ctx.strokeStyle = this.colorStr(1);
        ctx.lineWidth = size * 2.2;
        ctx.lineCap = 'square';
        ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
        break;
      }
      default: break;
    }
    ctx.globalAlpha = 1;
  },

  clearAll(pushHistory = true){
    dctx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
    if(pushHistory) HistoryEngine.pushSnapshot();
  },

  exportImage(format='png'){
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    let source = drawCanvas;
    if(format === 'jpeg'){
      // flatten onto solid background for JPEG (no transparency support)
      const tmp = document.createElement('canvas');
      tmp.width = drawCanvas.width; tmp.height = drawCanvas.height;
      const tctx = tmp.getContext('2d');
      tctx.fillStyle = STATE.theme === 'light' ? '#ffffff' : '#0a0d12';
      tctx.fillRect(0,0,tmp.width, tmp.height);
      tctx.drawImage(drawCanvas, 0, 0);
      source = tmp;
    }
    const url = source.toDataURL(mime, 0.95);
    const a = $('#downloadLink');
    a.href = url;
    a.download = `airdraw-${Date.now()}.${format === 'jpeg' ? 'jpg' : 'png'}`;
    a.click();
    toast('Image saved', 'ok');
  }
};

// autosave (throttled localStorage snapshot)
let autosaveTimer = null;
function scheduleAutosave(){
  if(!$('#autosaveToggle').classList.contains('on')) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(()=>{
    try{ localStorage.setItem('airdraw_autosave', drawCanvas.toDataURL('image/png')); }catch(e){}
  }, 1200);
}
function restoreAutosave(){
  try{
    const data = localStorage.getItem('airdraw_autosave');
    if(data){
      const img = new Image();
      img.onload = () => { dctx.drawImage(img, 0, 0, drawCanvas.width, drawCanvas.height); HistoryEngine.pushSnapshot(); };
      img.src = data;
    } else {
      HistoryEngine.pushSnapshot();
    }
  }catch(e){ HistoryEngine.pushSnapshot(); }
}

/* -------------------------------------------------------------------
   4. COLOR SYSTEM
   ------------------------------------------------------------------- */
function setColor(hex, addRecent = true){
  const { r,g,b } = hexToRgb(hex);
  STATE.color = { r,g,b };
  document.documentElement.style.setProperty('--current-color', hex);
  $('#colorSwatch').style.background = hex;
  $('#sizePreviewDot').style.background = hex;
  $('#hexInput').value = hex;
  $('#rInput').value = r; $('#gInput').value = g; $('#bInput').value = b;
  if(addRecent) addRecentColor(hex);
}
function addRecentColor(hex){
  STATE.recentColors = [hex, ...STATE.recentColors.filter(c=>c!==hex)].slice(0,10);
  renderRecentColors();
}
function renderRecentColors(){
  const row = $('#recentRow');
  row.innerHTML = '';
  STATE.recentColors.forEach(hex => {
    const el = document.createElement('button');
    el.className = 'preset';
    el.style.background = hex;
    el.addEventListener('click', ()=> setColor(hex));
    row.appendChild(el);
  });
}
function renderPresetGrid(){
  const grid = $('#presetGrid');
  grid.innerHTML = '';
  PRESET_COLORS.forEach(hex => {
    const el = document.createElement('button');
    el.className = 'preset';
    el.style.background = hex;
    el.addEventListener('click', ()=> setColor(hex));
    grid.appendChild(el);
  });
}
function drawHsvWheel(){
  const c = $('#hsvWheel');
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, cx = w/2, cy = h/2, radius = w/2 - 2;
  const img = ctx.createImageData(w,h);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const dx = x-cx, dy = y-cy;
      const r = Math.sqrt(dx*dx+dy*dy);
      const idx = (y*w+x)*4;
      if(r <= radius){
        let ang = Math.atan2(dy,dx) * 180/Math.PI; if(ang<0) ang += 360;
        const sat = clamp(r/radius, 0, 1);
        const { r:rr, g:gg, b:bb } = hsvToRgb(ang, sat, 1);
        img.data[idx]=rr; img.data[idx+1]=gg; img.data[idx+2]=bb; img.data[idx+3]=255;
      } else {
        img.data[idx+3] = 0;
      }
    }
  }
  ctx.putImageData(img,0,0);
}
function initColorSystem(){
  renderPresetGrid();
  drawHsvWheel();
  const wheel = $('#hsvWheel');
  const wctx = wheel.getContext('2d');

  function pickAt(clientX, clientY){
    const rect = wheel.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const px = Math.floor(x * wheel.width / rect.width);
    const py = Math.floor(y * wheel.height / rect.height);
    const pixel = wctx.getImageData(clamp(px,0,wheel.width-1), clamp(py,0,wheel.height-1), 1, 1).data;
    if(pixel[3] === 0) return;
    setColor(rgbToHex(pixel[0], pixel[1], pixel[2]));
  }
  let picking = false;
  wheel.addEventListener('mousedown', e => { picking = true; pickAt(e.clientX, e.clientY); });
  window.addEventListener('mousemove', e => { if(picking) pickAt(e.clientX, e.clientY); });
  window.addEventListener('mouseup', () => picking = false);
  wheel.addEventListener('touchstart', e => { picking=true; pickAt(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
  wheel.addEventListener('touchmove', e => { if(picking) pickAt(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
  wheel.addEventListener('touchend', () => picking=false);

  $('#hexInput').addEventListener('change', e => {
    let v = e.target.value.trim();
    if(!v.startsWith('#')) v = '#'+v;
    if(/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v);
    else toast('Invalid hex value', 'warn');
  });
  ['rInput','gInput','bInput'].forEach(id => {
    $('#'+id).addEventListener('change', () => {
      const r = clamp(+$('#rInput').value,0,255), g = clamp(+$('#gInput').value,0,255), b = clamp(+$('#bInput').value,0,255);
      setColor(rgbToHex(r,g,b));
    });
  });

  setColor('#4fe8ff', false);
}

/* -------------------------------------------------------------------
   5. GESTURE RECOGNITION
   Landmark indices (MediaPipe Hands, 21 points):
   0 wrist, 4 thumb tip, 8 index tip, 12 middle tip, 16 ring tip, 20 pinky tip
   PIP joints: 6 index, 10 middle, 14 ring, 18 pinky ; thumb IP: 3, MCP: 2
   ------------------------------------------------------------------- */
const GESTURE_META = {
  draw:        { icon:'☝️', name:'Drawing',        hint:'Index finger extended' },
  move:        { icon:'✌️', name:'Move (no draw)',  hint:'Index + middle extended' },
  eraser:      { icon:'✊', name:'Eraser',          hint:'Fist closed' },
  openpalm:    { icon:'🖐️', name:'Open palm',       hint:'Hold 2s to clear · 3s to pause' },
  thumbsup:    { icon:'👍', name:'Undo',            hint:'Thumbs up' },
  thumbsdown:  { icon:'👎', name:'Redo',            hint:'Thumbs down' },
  pinch:       { icon:'🤏', name:'Resizing brush',  hint:'Curl index, pinch thumb & index' },
  ok:          { icon:'👌', name:'Color palette',   hint:'OK sign' },
  rock:        { icon:'🤟', name:'Saving image',    hint:'Rock sign' },
  none:        { icon:'✋', name:'No hand detected', hint:'Show your hand to the camera' },
};

function fingerExtended(lm, tipIdx, pipIdx, wristIdx=0){
  // Extended if tip is farther from wrist than pip (robust to hand rotation)
  const tip = lm[tipIdx], pip = lm[pipIdx], wrist = lm[wristIdx];
  return dist2D(tip.x,tip.y,wrist.x,wrist.y) > dist2D(pip.x,pip.y,wrist.x,wrist.y) * 1.06;
}

function classifyHand(lm, handedness){
  const wrist = lm[0];
  const indexUp = fingerExtended(lm, 8, 6);
  const middleUp = fingerExtended(lm, 12, 10);
  const ringUp = fingerExtended(lm, 16, 14);
  const pinkyUp = fingerExtended(lm, 20, 18);
  const thumbTip = lm[4], thumbIp = lm[3], thumbMcp = lm[2];
  const thumbOut = dist2D(thumbTip.x,thumbTip.y, lm[5].x, lm[5].y) > dist2D(thumbMcp.x,thumbMcp.y, lm[5].x, lm[5].y) * 1.15;

  const pinchDist = dist2D(thumbTip.x, thumbTip.y, lm[8].x, lm[8].y);
  const handSpan = dist2D(wrist.x, wrist.y, lm[9].x, lm[9].y) || 0.001;
  const pinchRatio = pinchDist / handSpan;

  const extendedCount = [indexUp, middleUp, ringUp, pinkyUp].filter(Boolean).length;

  // Rock sign: index + pinky extended, middle+ring curled
  if(indexUp && pinkyUp && !middleUp && !ringUp){
    return { gesture:'rock', pinchRatio };
  }

  // OK sign: thumb+index pinched close, other three extended
  if(pinchRatio < 0.35 && middleUp && ringUp && pinkyUp){
    return { gesture:'ok', pinchRatio };
  }

  // Thumbs up / down: thumb extended, all 4 fingers curled, use vertical thumb direction
  if(!indexUp && !middleUp && !ringUp && !pinkyUp && thumbOut){
    const thumbVertical = thumbTip.y - wrist.y;
    if(thumbVertical < -0.08) return { gesture:'thumbsup', pinchRatio };
    if(thumbVertical > 0.08) return { gesture:'thumbsdown', pinchRatio };
  }

  // Pinch resize: thumb+index close, index NOT fully extended (distinguishes
  // a deliberate pinch pose from the "draw" pose, which also brings thumb and
  // index close together naturally and was previously misfiring as a resize)
  if(pinchRatio < 0.4 && !indexUp && !middleUp && !ringUp && !pinkyUp){
    return { gesture:'pinch', pinchRatio };
  }

  // Open palm: all four fingers extended and thumb out
  if(extendedCount === 4 && thumbOut){
    return { gesture:'openpalm', pinchRatio };
  }

  // Fist: nothing extended
  if(extendedCount === 0 && !thumbOut){
    return { gesture:'eraser', pinchRatio };
  }

  // Index + middle only -> move
  if(indexUp && middleUp && !ringUp && !pinkyUp){
    return { gesture:'move', pinchRatio };
  }

  // Index only -> draw
  if(indexUp && !middleUp && !ringUp && !pinkyUp){
    return { gesture:'draw', pinchRatio };
  }

  return { gesture:'none', pinchRatio };
}

/* -------------------------------------------------------------------
   6. HAND TRACKING (MediaPipe wiring)
   ------------------------------------------------------------------- */
let hands = null;
let camera = null;
const videoEl = $('#webcam');

function setupHands(){
  hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });
  hands.setOptions({
    maxNumHands: +$('#maxHandsSelect').value,
    modelComplexity: 1,
    minDetectionConfidence: +$('#detConfSlider').value,
    minTrackingConfidence: +$('#trackConfSlider').value,
  });
  hands.onResults(onHandsResults);
}

function applySettingsToHands(){
  if(!hands) return;
  hands.setOptions({
    maxNumHands: +$('#maxHandsSelect').value,
    modelComplexity: 1,
    minDetectionConfidence: +$('#detConfSlider').value,
    minTrackingConfidence: +$('#trackConfSlider').value,
  });
}

async function startCamera(){
  const [w,h] = $('#resSelect').value.split('x').map(Number);
  const fps = +$('#fpsSelect').value;
  try{
    camera = new Camera(videoEl, {
      onFrame: async () => {
        if(STATE.paused) return;
        await hands.send({ image: videoEl });
      },
      width: w, height: h,
    });
    await camera.start();
    STATE.cameraOn = true;
    $('#camOff').classList.remove('show');
    drawCanvas.classList.toggle('no-mirror', !STATE.mirror);
    hideVeil();
  }catch(err){
    console.error(err);
    STATE.cameraOn = false;
    $('#camOff').classList.add('show');
    hideVeil();
    toast('Camera unavailable — draw with mouse/touch instead', 'warn');
  }
}
function stopCamera(){
  if(camera){ camera.stop(); }
  STATE.cameraOn = false;
  $('#camOff').classList.add('show');
  // mouse/touch fallback draws in raw canvas coordinates, so suspend the
  // mirror transform while the camera is off to keep clicks and paint aligned
  STATE.mirrorBeforeCameraOff = STATE.mirror;
  drawCanvas.classList.add('no-mirror');
}

function hideVeil(){ $('#veil').classList.add('hide'); }

// --- FPS tracking ---
function tickFps(){
  const t = nowMs();
  STATE.frameTimes.push(t);
  STATE.frameTimes = STATE.frameTimes.filter(ts => t - ts < 1000);
  STATE.fps = STATE.frameTimes.length;
}

// --- landmark skeleton connections for overlay drawing ---
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];

let gestureHoldStart = null;
let lastGestureForHold = null;

function onHandsResults(results){
  tickFps();
  const w = overlayCanvas.width, h = overlayCanvas.height;
  octx.clearRect(0,0,w,h);

  const handList = results.multiHandLandmarks || [];
  STATE.handCount = handList.length;
  $('#statHands').textContent = STATE.handCount;
  $('#statFps').innerHTML = `<span class="dot ${STATE.handCount>0?'live':'warn'}"></span>${STATE.fps}`;

  if(handList.length === 0){
    setGestureUI('none', 0);
    STATE.drawing && DrawEngine.end();
    STATE.drawing = false;
    resetHold();
    return;
  }

  // Use the first detected hand as the primary control hand
  const lm = handList[0];
  const handedness = results.multiHandedness ? results.multiHandedness[0].label : 'Right';
  const confidence = results.multiHandedness ? results.multiHandedness[0].score : 0.8;
  STATE.trackingConfidence = confidence;

  const { gesture, pinchRatio } = classifyHand(lm, handedness);

  // draw skeleton + landmarks on overlay
  drawSkeleton(lm, w, h, gesture);

  // fingertip (index) position in canvas space
  const tip = lm[8];
  const cx = tip.x * w;
  const cy = tip.y * h;

  handleGesture(gesture, cx, cy, pinchRatio, lm, w, h);

  // draw cursor
  if(STATE.cursorVisible) drawCursor(cx, cy, gesture);

  // secondary hand -> allow two-hand support: mirror gesture detection but no separate action wired
  // (kept lightweight; primary hand drives drawing to avoid conflicting strokes)
}

function drawSkeleton(lm, w, h, gesture){
  const color = gesture === 'draw' ? '#4fe8ff' : gesture === 'eraser' ? '#ff7a59' : '#b78bff';
  octx.strokeStyle = color;
  octx.lineWidth = 2;
  octx.shadowBlur = 8;
  octx.shadowColor = color;
  octx.beginPath();
  HAND_CONNECTIONS.forEach(([a,b]) => {
    octx.moveTo(lm[a].x*w, lm[a].y*h);
    octx.lineTo(lm[b].x*w, lm[b].y*h);
  });
  octx.stroke();
  octx.shadowBlur = 0;
  lm.forEach((p,i) => {
    octx.fillStyle = i===8 ? '#ffffff' : color;
    octx.beginPath();
    octx.arc(p.x*w, p.y*h, i===8?4:2.4, 0, Math.PI*2);
    octx.fill();
  });
}

function drawCursor(x, y, gesture){
  const meta = GESTURE_META[gesture] || GESTURE_META.none;
  octx.save();
  octx.translate(x,y);
  const pulse = 1 + Math.sin(nowMs()*0.008)*0.08;
  octx.beginPath();
  octx.arc(0,0, (STATE.size/2 + 6) * pulse, 0, Math.PI*2);
  octx.strokeStyle = gesture === 'draw' ? rgbaFromState(0.9) : 'rgba(255,255,255,0.5)';
  octx.lineWidth = 2;
  octx.stroke();
  if(gesture === 'draw'){
    octx.beginPath();
    octx.arc(0,0, STATE.size/2, 0, Math.PI*2);
    octx.fillStyle = rgbaFromState(0.35);
    octx.fill();
  }
  octx.restore();
}
function rgbaFromState(a){
  const { r,g,b } = STATE.color;
  return `rgba(${r|0},${g|0},${b|0},${a})`;
}

function resetHold(){
  STATE.palmHoldStart = null;
  STATE.palmCleared = false;
  STATE.palmPaused = false;
  $('#holdRing').style.display = 'none';
}

let lastActionGesture = null;
let actionCooldown = 0;

function handleGesture(gesture, cx, cy, pinchRatio, lm, w, h){
  setGestureUI(gesture, STATE.trackingConfidence);

  const t = nowMs();

  // reset palm hold timers whenever we're not in openpalm
  if(gesture !== 'openpalm'){
    resetHold();
  }

  switch(gesture){
    case 'draw': {
      if(!STATE.drawing){ DrawEngine.begin(cx, cy); STATE.drawing = true; }
      else DrawEngine.move(cx, cy);
      break;
    }
    case 'eraser': {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      DrawEngine.eraseAt(cx, cy, STATE.size * 1.6);
      break;
    }
    case 'move': {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      break;
    }
    case 'pinch': {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      const targetSize = clamp(pinchRatio * 220 * STATE.gestureSensitivity, 2, 80);
      // exponential smoothing avoids the size number flickering on tiny landmark jitter
      const smoothedSize = lerp(targetSize, STATE.size, 0.65);
      setBrushSize(smoothedSize);
      break;
    }
    case 'openpalm': {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      if(STATE.palmHoldStart === null) STATE.palmHoldStart = t;
      const elapsed = (t - STATE.palmHoldStart) / 1000;
      $('#holdRing').style.display = 'block';
      const frac = clamp(elapsed / 3, 0, 1);
      const dash = 56.5;
      $('#holdRingFg').setAttribute('stroke-dashoffset', String(dash * (1-frac)));
      if(elapsed >= 2 && !STATE.palmCleared){
        STATE.palmCleared = true;
        DrawEngine.clearAll();
        toast('Canvas cleared', 'ok');
      }
      if(elapsed >= 3 && !STATE.palmPaused){
        STATE.palmPaused = true;
        togglePause(true);
        toast('Tracking paused — show palm briefly to resume manually or press Space', 'warn');
      }
      break;
    }
    case 'thumbsup': {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      debounceAction('thumbsup', () => HistoryEngine.undo());
      break;
    }
    case 'thumbsdown': {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      debounceAction('thumbsdown', () => HistoryEngine.redo());
      break;
    }
    case 'ok': {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      debounceAction('ok', () => toggleColorPanel(true));
      break;
    }
    case 'rock': {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      debounceAction('rock', () => DrawEngine.exportImage($('#exportFormatSelect').value));
      break;
    }
    default: {
      if(STATE.drawing){ DrawEngine.end(); STATE.drawing = false; }
      break;
    }
  }
}

// prevents an action (undo/redo/save/palette) from firing every single frame
// while a gesture is held — fires once, then waits for gesture to change or cooldown to pass
function debounceAction(tag, fn){
  const t = nowMs();
  if(lastActionGesture === tag && t - actionCooldown < 900) return;
  lastActionGesture = tag;
  actionCooldown = t;
  fn();
}

function setGestureUI(gesture, confidence){
  if(STATE.currentGesture !== gesture){
    STATE.currentGesture = gesture;
    $('#gestureIcon').classList.add('pulse');
    setTimeout(()=> $('#gestureIcon').classList.remove('pulse'), 180);
  }
  const meta = GESTURE_META[gesture] || GESTURE_META.none;
  $('#gestureIcon').textContent = meta.icon;
  $('#gestureName').textContent = meta.name;
  $('#gestureHint').textContent = meta.hint;
  $('#confBar').style.width = `${clamp(confidence*100,0,100)}%`;
}

/* -------------------------------------------------------------------
   7. UI CONTROLLER
   ------------------------------------------------------------------- */
function buildBrushRail(){
  const rail = $('#brushRail');
  rail.innerHTML = '';
  BRUSHES.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'brush-btn' + (b.id === STATE.brush ? ' active' : '');
    btn.innerHTML = `${b.icon}<span class="lbl">${b.label}</span>`;
    btn.title = b.label;
    btn.addEventListener('click', () => selectBrush(b.id));
    rail.appendChild(btn);
  });
}
function selectBrush(id){
  STATE.brush = id;
  $('#statBrush').textContent = BRUSHES.find(b=>b.id===id).label;
  $$('.brush-btn').forEach((el,i) => el.classList.toggle('active', BRUSHES[i].id === id));
}

function setBrushSize(v){
  STATE.size = clamp(v, 1, 80);
  $('#sizeSlider').value = Math.round(STATE.size);
  $('#sizeVal').textContent = Math.round(STATE.size);
  const dotSize = clamp(STATE.size, 4, 34);
  $('#sizePreviewDot').style.width = dotSize+'px';
  $('#sizePreviewDot').style.height = dotSize+'px';
}

function toggleColorPanel(force){
  const panel = $('#colorPanel');
  const open = force !== undefined ? force : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  if(open) $('#settingsPanel').classList.remove('open');
}
function toggleSettingsPanel(force){
  const panel = $('#settingsPanel');
  const open = force !== undefined ? force : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  if(open) $('#colorPanel').classList.remove('open');
}

function togglePause(force){
  STATE.paused = force !== undefined ? force : !STATE.paused;
  $('#btnPause').classList.toggle('active', STATE.paused);
  if(STATE.paused){
    toast('Tracking paused', 'warn');
  } else {
    toast('Tracking resumed', 'ok');
    resetHold();
  }
}

function toggleMirror(force){
  STATE.mirror = force !== undefined ? force : !STATE.mirror;
  videoEl.classList.toggle('no-mirror', !STATE.mirror);
  overlayCanvas.classList.toggle('no-mirror', !STATE.mirror);
  // keep the drawing canvas mirrored the same way, so strokes land where the
  // visible (mirrored) cursor/fingertip actually is, not on the opposite side
  drawCanvas.classList.toggle('no-mirror', !STATE.mirror);
  $('#btnMirror').classList.toggle('active', STATE.mirror);
  $('#mirrorToggle').classList.toggle('on', STATE.mirror);
}

function setTheme(theme){
  STATE.theme = theme;
  document.body.setAttribute('data-theme', theme);
}

function bindUI(){
  // brush size
  $('#sizeSlider').addEventListener('input', e => setBrushSize(+e.target.value));
  // opacity (both sliders kept in sync)
  const syncOpacity = (v) => {
    STATE.opacity = v/100;
    $('#opacitySlider').value = v;
    $('#opacitySlider2').value = v;
  };
  $('#opacitySlider').addEventListener('input', e => syncOpacity(+e.target.value));
  $('#opacitySlider2').addEventListener('input', e => syncOpacity(+e.target.value));

  // color swatch open
  $('#colorSwatch').addEventListener('click', () => toggleColorPanel());
  $('#closeColorPanel').addEventListener('click', () => toggleColorPanel(false));

  // settings
  $('#settingsToggle').addEventListener('click', () => toggleSettingsPanel());
  $('#closeSettingsPanel').addEventListener('click', () => toggleSettingsPanel(false));

  // legend
  $('#legendToggle').addEventListener('click', () => { $('#legendPanel').classList.toggle('open'); $('#tipsPanel').classList.remove('open'); });
  // tips
  $('#tipsToggle').addEventListener('click', () => { $('#tipsPanel').classList.toggle('open'); $('#legendPanel').classList.remove('open'); });

  // theme
  $('#themeToggle').addEventListener('click', () => setTheme(STATE.theme === 'dark' ? 'light' : 'dark'));

  // toolbar
  $('#btnUndo').addEventListener('click', () => HistoryEngine.undo());
  $('#btnRedo').addEventListener('click', () => HistoryEngine.redo());
  $('#btnClear').addEventListener('click', () => { DrawEngine.clearAll(); toast('Canvas cleared'); });
  $('#btnSave').addEventListener('click', () => DrawEngine.exportImage($('#exportFormatSelect').value));
  $('#btnFullscreen').addEventListener('click', toggleFullscreen);
  $('#btnMirror').addEventListener('click', () => toggleMirror());
  $('#mirrorToggle').addEventListener('click', () => toggleMirror());
  $('#btnPause').addEventListener('click', () => togglePause());
  $('#btnCamera').addEventListener('click', async () => {
    if(STATE.cameraOn){ stopCamera(); $('#btnCamera').classList.remove('active'); }
    else { $('#veil').classList.remove('hide'); await startCamera(); $('#btnCamera').classList.add('active'); }
  });
  $('#camOffEnable').addEventListener('click', async () => {
    $('#veil').classList.remove('hide');
    await startCamera();
  });

  // settings panel fields
  $('#detConfSlider').addEventListener('input', e => { $('#detConfVal').textContent = (+e.target.value).toFixed(2); applySettingsToHands(); });
  $('#trackConfSlider').addEventListener('input', e => { $('#trackConfVal').textContent = (+e.target.value).toFixed(2); applySettingsToHands(); });
  $('#maxHandsSelect').addEventListener('change', applySettingsToHands);
  $('#gestSensSlider').addEventListener('input', e => { STATE.gestureSensitivity = +e.target.value; $('#gestSensVal').textContent = STATE.gestureSensitivity.toFixed(2); });
  $('#smoothSlider').addEventListener('input', e => { STATE.smoothing = +e.target.value; $('#smoothVal').textContent = STATE.smoothing.toFixed(2); });
  $('#hardnessSlider').addEventListener('input', e => { STATE.hardness = +e.target.value; $('#hardnessVal').textContent = STATE.hardness; });
  $('#flowSlider').addEventListener('input', e => { STATE.flow = +e.target.value; $('#flowVal').textContent = STATE.flow; });
  $('#cursorToggle').addEventListener('click', e => { STATE.cursorVisible = !STATE.cursorVisible; e.target.classList.toggle('on', STATE.cursorVisible); });
  $('#autosaveToggle').addEventListener('click', e => e.target.classList.toggle('on'));
  $('#resSelect').addEventListener('change', restartCameraIfOn);
  $('#fpsSelect').addEventListener('change', restartCameraIfOn);

  // keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if(meta && e.key.toLowerCase() === 'z'){ e.preventDefault(); e.shiftKey ? HistoryEngine.redo() : HistoryEngine.undo(); }
    else if(meta && e.key.toLowerCase() === 'y'){ e.preventDefault(); HistoryEngine.redo(); }
    else if(meta && e.key.toLowerCase() === 's'){ e.preventDefault(); DrawEngine.exportImage($('#exportFormatSelect').value); }
    else if(e.key.toLowerCase() === 'f' && !meta){ toggleFullscreen(); }
    else if(e.key.toLowerCase() === 'm' && !meta){ toggleMirror(); }
    else if(e.key === ' '){ e.preventDefault(); togglePause(); }
    else if(e.key.toLowerCase() === 'c' && !meta){ DrawEngine.clearAll(); toast('Canvas cleared'); }
  });
}

async function restartCameraIfOn(){
  if(!STATE.cameraOn) return;
  stopCamera();
  await startCamera();
}

function toggleFullscreen(){
  if(!document.fullscreenElement){
    document.documentElement.requestFullscreen().catch(()=>{});
  } else {
    document.exitFullscreen().catch(()=>{});
  }
}

/* -------------------------------------------------------------------
   8. FALLBACK POINTER / TOUCH DRAWING
   Lets desktop mouse or mobile touch draw directly when camera is off
   or on devices without a webcam.
   ------------------------------------------------------------------- */
function bindPointerFallback(){
  let active = false;
  const toCanvasXY = (e) => {
    const rect = drawCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (drawCanvas.width / rect.width),
      y: (clientY - rect.top) * (drawCanvas.height / rect.height)
    };
  };
  const start = (e) => {
    if(STATE.cameraOn) return; // camera-driven drawing takes priority when active
    active = true;
    const {x,y} = toCanvasXY(e);
    DrawEngine.begin(x,y);
  };
  const move = (e) => {
    if(!active) return;
    const {x,y} = toCanvasXY(e);
    DrawEngine.move(x,y);
  };
  const end = () => {
    if(!active) return;
    active = false;
    DrawEngine.end();
  };
  drawCanvas.addEventListener('mousedown', start);
  drawCanvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  drawCanvas.addEventListener('touchstart', start, {passive:true});
  drawCanvas.addEventListener('touchmove', move, {passive:true});
  drawCanvas.addEventListener('touchend', end);
}

/* -------------------------------------------------------------------
   9. BOOT
   ------------------------------------------------------------------- */
async function boot(){
  resizeCanvases();
  buildBrushRail();
  initColorSystem();
  bindUI();
  bindPointerFallback();
  toggleMirror(true);
  setBrushSize(10);

  try{
    setupHands();
    await startCamera();
  }catch(err){
    console.error(err);
    hideVeil();
    $('#camOff').classList.add('show');
    toast('Hand tracking failed to load — draw with mouse/touch instead', 'warn');
  }

  restoreAutosave();
  toast('Show your hand to the camera to begin drawing');
}

window.addEventListener('DOMContentLoaded', boot);