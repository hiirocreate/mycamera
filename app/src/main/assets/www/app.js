/* =========================================================
   MyCamera - カメラアプリ本体ロジック
   ・カメラ映像をリアルタイムでフィルター処理してcanvasに描画
   ・写真: canvasのフレームをそのままJPEGとして保存
   ・動画: canvas.captureStream()（フィルター適用済み）+ 音声トラックを
           MediaRecorderで録画して保存
   ・保存は Android 側の AndroidBridge（MediaStore）を使用。ネット接続は一切使わない
   ========================================================= */

// ---- フィルター定義 -----------------------------------------------------
// css: Canvas 2D の ctx.filter にそのまま渡す文字列（CSS filter構文と同じ）
const FILTERS = [
  { id: 'normal',    label: 'ノーマル', css: 'none' },
  { id: 'food',      label: '食べ物',   css: 'saturate(1.55) contrast(1.12) brightness(1.06) hue-rotate(-4deg)' },
  { id: 'night',     label: '夜景',     css: 'brightness(1.35) contrast(1.25) saturate(1.15)' },
  { id: 'portrait',  label: '人物',     css: 'brightness(1.08) contrast(0.95) saturate(1.12)' },
  { id: 'landscape', label: '風景',     css: 'saturate(1.4) contrast(1.15)' },
  { id: 'vivid',     label: '鮮やか',   css: 'saturate(1.75) contrast(1.15)' },
  { id: 'mono',      label: 'モノクロ', css: 'grayscale(1) contrast(1.1)' },
  { id: 'retro',     label: 'レトロ',   css: 'sepia(0.45) saturate(1.3) contrast(0.95) brightness(1.05) hue-rotate(-8deg)' },
];

// ---- 解像度定義 -----------------------------------------------------
const RESOLUTIONS = [
  { label: '4K',     w: 3840, h: 2160 },
  { label: '2K',     w: 2560, h: 1440 },
  { label: 'フルHD', w: 1920, h: 1080 },
  { label: 'HD',     w: 1280, h: 720 },
];

// ---- 状態 -----------------------------------------------------
const state = {
  facing: 'environment',       // 'environment' = 背面, 'user' = 前面
  resolutionIndex: 2,          // デフォルト フルHD
  filterId: 'normal',
  muted: loadMuted(),          // シャッター音のミュート状態（前回設定を保持）
  mode: 'photo',               // 'photo' | 'video'
  recording: false,
  stream: null,
  mediaRecorder: null,
  recordedChunks: [],
  recTimerHandle: null,
  recStartTime: 0,
};

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const flashEl = $('flash');
const messageEl = $('message');
const soundToggleBtn = $('soundToggle');
const resolutionSelect = $('resolutionSelect');
const switchCameraBtn = $('switchCamera');
const filterStrip = $('filterStrip');
const shutterBtn = $('shutterBtn');
const photoModeBtn = $('photoModeBtn');
const videoModeBtn = $('videoModeBtn');
const recIndicator = $('recIndicator');
const recTimer = $('recTimer');

// ---- 効果音 -----------------------------------------------------
const sndShutter = new Audio('assets/shutter.wav');
const sndRecStart = new Audio('assets/rec_start.wav');
const sndRecStop = new Audio('assets/rec_stop.wav');

function playSound(a) {
  if (state.muted) return; // ミュート中は一切鳴らさない
  try {
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch (e) { /* 無視 */ }
}

function loadMuted() {
  try {
    return localStorage.getItem('mycamera_muted') === '1';
  } catch (e) {
    return false;
  }
}
function saveMuted() {
  try { localStorage.setItem('mycamera_muted', state.muted ? '1' : '0'); } catch (e) {}
}

function updateSoundButton() {
  soundToggleBtn.textContent = state.muted ? '🔕' : '🔔';
  soundToggleBtn.classList.toggle('muted', state.muted);
  soundToggleBtn.title = state.muted ? 'シャッター音: オフ（静かな場所向け）' : 'シャッター音: オン';
}

soundToggleBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  saveMuted();
  updateSoundButton();
});

// ---- UI 構築 -----------------------------------------------------
function buildFilterStrip() {
  filterStrip.innerHTML = '';
  FILTERS.forEach((f) => {
    const chip = document.createElement('button');
    chip.className = 'filterChip' + (f.id === state.filterId ? ' active' : '');
    chip.textContent = f.label;
    chip.addEventListener('click', () => {
      state.filterId = f.id;
      [...filterStrip.children].forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });
    filterStrip.appendChild(chip);
  });
}

function buildResolutionSelect() {
  resolutionSelect.innerHTML = '';
  RESOLUTIONS.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = r.label;
    resolutionSelect.appendChild(opt);
  });
  resolutionSelect.value = String(state.resolutionIndex);
  resolutionSelect.addEventListener('change', () => {
    state.resolutionIndex = Number(resolutionSelect.value);
    startCamera();
  });
}

switchCameraBtn.addEventListener('click', () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  startCamera();
});

photoModeBtn.addEventListener('click', () => setMode('photo'));
videoModeBtn.addEventListener('click', () => setMode('video'));

function setMode(mode) {
  if (state.recording) return; // 録画中はモード切替不可
  state.mode = mode;
  photoModeBtn.classList.toggle('active', mode === 'photo');
  videoModeBtn.classList.toggle('active', mode === 'video');
  document.body.classList.toggle('videoMode', mode === 'video');
}

shutterBtn.addEventListener('click', () => {
  if (state.mode === 'photo') {
    takePhoto();
  } else {
    if (state.recording) stopRecording(); else startRecording();
  }
});

// ---- カメラ起動 -----------------------------------------------------
async function startCamera() {
  showMessage('');
  // 既存のストリームを停止
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  const res = RESOLUTIONS[state.resolutionIndex];
  const constraints = {
    audio: true,
    video: {
      facingMode: state.facing,
      width: { ideal: res.w },
      height: { ideal: res.h },
    },
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    resizeCanvasToVideo();
    canvas.style.transform = state.facing === 'user' ? 'scaleX(-1)' : 'none';
  } catch (err) {
    showMessage(
      'カメラを起動できませんでした。\n' +
      'アプリの設定からカメラ・マイクの権限を許可してください。\n' +
      '(' + (err && err.message ? err.message : err) + ')'
    );
  }
}

function resizeCanvasToVideo() {
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;
}

function showMessage(text) {
  if (!text) {
    messageEl.classList.add('hidden');
    messageEl.textContent = '';
    return;
  }
  messageEl.textContent = text;
  messageEl.classList.remove('hidden');
}

// ---- 描画ループ（ここでフィルターを適用） -----------------------------------------------------
function drawLoop() {
  if (video.readyState >= 2 && video.videoWidth > 0) {
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      resizeCanvasToVideo();
    }
    const f = FILTERS.find((x) => x.id === state.filterId) || FILTERS[0];
    ctx.filter = f.css;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(drawLoop);
}

// ---- 写真撮影 -----------------------------------------------------
function takePhoto() {
  if (!video.videoWidth) return;
  playSound(sndShutter);
  flashEl.classList.add('on');
  setTimeout(() => flashEl.classList.remove('on'), 120);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  if (window.AndroidBridge && window.AndroidBridge.saveImage) {
    window.AndroidBridge.saveImage(dataUrl);
  } else {
    downloadFallback(dataUrl, 'photo.jpg');
  }
}

// ---- 動画撮影 -----------------------------------------------------
function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function startRecording() {
  if (!state.stream) return;
  const canvasStream = canvas.captureStream(30); // フィルター適用後の映像
  const audioTracks = state.stream.getAudioTracks();
  const combined = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioTracks,
  ]);

  const mimeType = pickMimeType();
  const options = mimeType ? { mimeType } : undefined;

  try {
    state.mediaRecorder = new MediaRecorder(combined, options);
  } catch (e) {
    showMessage('この端末では動画録画に対応していません。');
    return;
  }
  state.recordedChunks = [];

  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
  };

  state.mediaRecorder.onstop = () => {
    const blob = new Blob(state.recordedChunks, { type: mimeType || 'video/webm' });
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      if (window.AndroidBridge && window.AndroidBridge.saveVideo) {
        window.AndroidBridge.saveVideo(dataUrl, mimeType || 'video/webm');
      } else {
        downloadFallback(dataUrl, 'video.webm');
      }
    };
    reader.readAsDataURL(blob);
  };

  state.mediaRecorder.start();
  state.recording = true;
  playSound(sndRecStart);
  document.body.classList.add('recording');
  recIndicator.classList.remove('hidden');
  state.recStartTime = Date.now();
  state.recTimerHandle = setInterval(updateRecTimer, 500);
  updateRecTimer();
}

function stopRecording() {
  if (state.mediaRecorder && state.recording) {
    state.mediaRecorder.stop();
  }
  state.recording = false;
  playSound(sndRecStop);
  document.body.classList.remove('recording');
  recIndicator.classList.add('hidden');
  if (state.recTimerHandle) {
    clearInterval(state.recTimerHandle);
    state.recTimerHandle = null;
  }
}

function updateRecTimer() {
  const elapsed = Math.floor((Date.now() - state.recStartTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  recTimer.textContent = `${mm}:${ss}`;
}

// ---- ブラウザ単体テスト用フォールバック（Androidアプリ内では使われない） ----
function downloadFallback(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- 初期化 -----------------------------------------------------
function init() {
  buildFilterStrip();
  buildResolutionSelect();
  updateSoundButton();
  setMode('photo');
  drawLoop();
  startCamera();
}

document.addEventListener('DOMContentLoaded', init);
