// スマホ採寸 撮影ツール
// 動画 (MediaRecorder) と動きのセンサー (DeviceMotion) を同じ時計で記録し、
// 解析パイプライン (smartmeasure) がそのまま読める形で保存・共有する。
//   動画:   *.mp4 または *.webm (ブラウザが対応する形式)
//   センサー: *_imu.csv  列 t,ax,ay,az,gx,gy,gz  (t: 録画開始を 0 とした秒, 加速度 m/s^2 重力込み, 角速度 rad/s)
//   情報:   *_meta.json (端末・形式・サンプリング間隔など)
"use strict";

const APP_VERSION = "0.2.0";
const MAX_SECONDS = 40;            // 撮り忘れて止めない場合の上限
const LOW = 0.15, GOOD = 0.3;      // 動きの強さの目安 [m/s^2] (解析側の判定に合わせる)
const METER_FULL = 1.0;            // メーターの右端 [m/s^2]

const $ = (id) => document.getElementById(id);
const state = {
  stream: null, recorder: null, chunks: [], mime: "", ext: "mp4",
  samples: [],                     // [performance 時刻 ms, ax, ay, az, gx, gy, gz]
  interval: null, t0: null, tEnd: null, recording: false, timer: null, wakeLock: null,
  grav: null, lp: [0, 0, 0], lp2: [0, 0, 0], lastT: 0, energy: [], motionLog: [], lastMotionAt: 0,
  files: null,
};

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
}

// ---- センサー --------------------------------------------------------------------------
// DeviceMotionEvent.timeStamp は多くのブラウザで performance.now() と同じ時計。
// 古い実装では 1970 年基準の値が来るので、その場合は performance の時計に直す。
function eventTime(e) {
  const ts = e.timeStamp;
  if (!ts) return performance.now();
  if (ts > 1e12) return ts - performance.timeOrigin;
  return ts;
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a || a.x === null) return;
  const r = e.rotationRate || {};
  const d2r = Math.PI / 180;       // rotationRate は 度/秒 (仕様) → rad/秒
  const t = eventTime(e);
  // 実際のブラウザ (iPhone の Safari・Chrome, Android の Chrome) は alpha/beta/gamma を x/y/z 軸まわりの
  // 回転として返す (仕様の文面の alpha=z, beta=x, gamma=y とは違う)。実機 2 台の記録で確かめた
  const g = [r.alpha, r.beta, r.gamma].map((v) => (v === null || v === undefined ? NaN : v * d2r));
  state.samples.push([t, a.x, a.y, a.z, g[0], g[1], g[2]]);
  if (state.samples.length > 200000) state.samples.splice(0, 50000);
  if (e.interval) state.interval = e.interval;
  state.lastMotionAt = performance.now();
  updateMeter(t, [a.x, a.y, a.z]);
}

// 動きの強さ: 重力 (ゆっくり変わる成分) を引き、手ぶれより遅い成分 (約 1Hz 以下) の大きさを
// 直近 1.5 秒の RMS で表す。解析側の「運動加速度の大きさ (excitation)」に近い量になるよう、
// 解析と同程度の平滑化 (1Hz の 1 次低域通過を 2 段) をかける。
const lpAlpha = (fc, dt) => 1 - Math.exp(-2 * Math.PI * fc * dt);

function updateMeter(t, a) {
  if (!state.grav) { state.grav = a.slice(); state.lp2 = [0, 0, 0]; state.lastT = t; }
  const dt = Math.min(0.1, Math.max(0.005, (t - state.lastT) / 1000 || 1 / 60));
  state.lastT = t;
  const ag = lpAlpha(0.15, dt), a1 = lpAlpha(1.0, dt);
  for (let k = 0; k < 3; k++) {
    state.grav[k] += ag * (a[k] - state.grav[k]);
    state.lp[k] += a1 * ((a[k] - state.grav[k]) - state.lp[k]);
    state.lp2[k] += a1 * (state.lp[k] - state.lp2[k]);
  }
  const e2 = state.lp2[0] ** 2 + state.lp2[1] ** 2 + state.lp2[2] ** 2;
  state.energy.push([t, e2]);
  while (state.energy.length && t - state.energy[0][0] > 1500) state.energy.shift();
  const rms = Math.sqrt(state.energy.reduce((s, x) => s + x[1], 0) / state.energy.length);
  if (state.recording) state.motionLog.push([t, rms]);
  const fill = $("meter-fill");
  fill.style.width = Math.min(100, (rms / METER_FULL) * 100) + "%";
  fill.className = "meter-fill" + (rms >= GOOD ? " good" : rms >= LOW ? " mid" : "");
  $("meter-text").textContent = rms >= GOOD ? "良い" : rms >= LOW ? "もう少し" : "弱い";
  const guide = $("guide");
  if (state.recording) {
    guide.textContent = rms >= GOOD ? "その調子です。物の周りを回りながら続けてください"
      : "もう少し大きく、左右に小刻みに揺らしてください";
  }
}

// ---- カメラ ---------------------------------------------------------------------------
function pickMime() {
  const cands = [
    ["video/mp4;codecs=avc1", "mp4"], ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"], ["video/webm;codecs=vp8", "webm"], ["video/webm", "webm"],
  ];
  if (typeof MediaRecorder === "undefined") return null;
  for (const [m, ext] of cands) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return [m, ext];
  return ["", "mp4"];
}

async function begin() {
  const err = $("start-error");
  err.hidden = true;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.textContent = "このブラウザではカメラを使えません。Safari（iPhone）または Chrome（Android）で、https のアドレスを開いてください。アプリ内ブラウザ（LINE など）では動かないことがあります。";
    err.hidden = false;
    return;
  }
  // iPhone などでは、ボタンを押した直後にセンサー利用の許可を求める必要がある。
  // 許可されなくても動画だけは撮れるので、警告を出して続ける
  state.motionDenied = false;
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    try {
      state.motionDenied = (await DeviceMotionEvent.requestPermission()) !== "granted";
    } catch (_) {
      state.motionDenied = true;
    }
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
  } catch (e) {
    err.textContent = "カメラを使えませんでした。ブラウザの設定でカメラの利用を許可してから、もう一度お試しください。";
    err.hidden = false;
    return;
  }
  const v = $("preview");
  v.srcObject = state.stream;
  try { await v.play(); } catch (_) { /* 自動再生が止められても録画はできる */ }
  window.addEventListener("devicemotion", onMotion);
  show("screen-capture");
  setTimeout(() => {
    const ok = performance.now() - state.lastMotionAt < 1500;
    const w = $("sensor-warning");
    if (!ok) {
      w.textContent = state.motionDenied
        ? "動きのセンサーの利用が許可されていません。動画だけで記録します（大きさの精度が下がります）。ページを開き直して「許可」を選ぶと使えます。"
        : "センサーの値が届いていません。ブラウザの設定で「モーションと画面の向き」へのアクセスを許可してください。動画だけで記録することもできます。";
    }
    w.hidden = ok;
  }, 2000);
}

async function startRecording() {
  const pick = pickMime();
  if (!pick) { alertBox("このブラウザは録画に対応していません。"); return; }
  [state.mime, state.ext] = pick;
  state.chunks = [];
  state.motionLog = [];
  const opts = { videoBitsPerSecond: 8_000_000 };
  if (state.mime) opts.mimeType = state.mime;
  const rec = new MediaRecorder(state.stream, opts);
  state.recorder = rec;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
  rec.onstart = () => { state.t0 = performance.now(); };
  rec.onstop = finish;
  state.t0 = performance.now();    // onstart で上書き (より録画開始に近い時刻)
  rec.start(1000);
  state.recording = true;
  $("btn-record").classList.add("on");
  $("btn-record").setAttribute("aria-label", "録画を停止");
  $("rec-pill").classList.add("on");
  state.timer = setInterval(() => {
    const s = (performance.now() - state.t0) / 1000;
    $("elapsed").textContent = s.toFixed(1) + " 秒";
    if (s >= MAX_SECONDS) stopRecording();
  }, 100);
  try { state.wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) { state.wakeLock = null; }
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  state.tEnd = performance.now();
  clearInterval(state.timer);
  $("btn-record").classList.remove("on");
  $("btn-record").setAttribute("aria-label", "録画を開始");
  $("rec-pill").classList.remove("on");
  try { state.wakeLock?.release(); } catch (_) { /* なし */ }
  state.recorder.stop();
}

// ---- 保存 ----------------------------------------------------------------------------
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildImuCsv() {
  // 録画の前後 1 秒を含める (解析側で時刻ずれを探すため)
  const t0 = state.t0, lo = t0 - 1000, hi = state.tEnd + 1000;
  const rows = ["t,ax,ay,az,gx,gy,gz"];
  let n = 0;
  for (const s of state.samples) {
    if (s[0] < lo || s[0] > hi) continue;
    if (s.slice(1).some((v) => !Number.isFinite(v))) continue;
    rows.push([((s[0] - t0) / 1000).toFixed(5), ...s.slice(1).map((v) => v.toFixed(6))].join(","));
    n++;
  }
  return { csv: rows.join("\n") + "\n", n };
}

function summarize(n) {
  const dur = (state.tEnd - state.t0) / 1000;
  const inRec = state.samples.filter((s) => s[0] >= state.t0 && s[0] <= state.tEnd);
  const rate = inRec.length > 1 ? (inRec.length - 1) / ((inRec[inRec.length - 1][0] - inRec[0][0]) / 1000) : 0;
  const ms = state.motionLog.map((x) => x[1]).sort((a, b) => a - b);
  const med = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
  const goodShare = ms.length ? ms.filter((x) => x >= LOW).length / ms.length : 0;
  return { dur, rate, med, goodShare, n };
}

async function finish() {
  const blob = new Blob(state.chunks, { type: state.mime || "video/mp4" });
  const base = "smartmeasure_" + stamp();
  const { csv, n } = buildImuCsv();
  const sum = summarize(n);
  const track = state.stream.getVideoTracks()[0];
  const settings = track && track.getSettings ? track.getSettings() : {};
  const meta = {
    app: "smartmeasure-capture", app_version: APP_VERSION, created_at: new Date().toISOString(),
    user_agent: navigator.userAgent,
    video: { file: `${base}.${state.ext}`, mime: blob.type, bytes: blob.size, width: settings.width, height: settings.height,
             frame_rate: settings.frameRate, duration_s: sum.dur },
    imu: { file: `${base}_imu.csv`, samples: n, rate_hz: sum.rate, interval_ms: state.interval,
           columns: "t[s, 0 = 録画開始], ax ay az [m/s^2, 重力込み], gx gy gz [rad/s]",
           frame: "W3C DeviceMotion の端末座標 (x 右, y 上, z 画面の手前)。gx,gy,gz = rotationRate の alpha,beta,gamma (x,y,z 軸まわり)" },
    screen_orientation: (screen.orientation && screen.orientation.type) || String(window.orientation ?? ""),
    motion: { median_rms: sum.med, share_above_low: sum.goodShare, low: LOW, good: GOOD },
  };
  const json = JSON.stringify(meta, null, 2);
  const files = [
    // 共有できる種類は MIME の完全一致で判定されるため (Android の Chrome)、codecs などの付記は外す
    new File([blob], meta.video.file, { type: blob.type.split(";")[0] || "video/mp4" }),
    new File([csv], meta.imu.file, { type: "text/csv" }),
    new File([json], `${base}_meta.json`, { type: "application/json" }),
  ];
  state.files = files;
  // Android の Chrome は .json を共有できない (共有できる種類が決まっている) ので、共有用は .txt にする
  state.shareFiles = shareable(files) ? files
    : [files[0], files[1], new File([json], `${base}_meta.txt`, { type: "text/plain" })];
  if (!shareable(state.shareFiles)) state.shareFiles = shareable(files.slice(0, 2)) ? files.slice(0, 2) : null;
  renderResult(sum, settings, blob, files);
}

function fmtBytes(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB"; }

function renderResult(sum, settings, blob, files) {
  const ok = sum.n > 50 && sum.goodShare >= 0.6;
  const v = $("verdict");
  v.className = "verdict " + (ok ? "good" : "warn");
  v.textContent = sum.n <= 50
    ? "センサーの記録がほとんどありません。センサーの利用を許可して撮り直してください。"
    : ok ? "解析に使えます。下のボタンからファイルを送ってください。"
      : "動きが少なめでした。端末を左右に小刻みに揺らして撮り直すと、精度が上がります（このまま送ることもできます）。";
  $("r-duration").textContent = sum.dur.toFixed(1) + " 秒";
  $("r-video").textContent = `${settings.width || "?"}×${settings.height || "?"}・${blob.type.split(";")[0] || "?"}・${fmtBytes(blob.size)}`;
  $("r-imu").textContent = `${sum.n} 件（約 ${sum.rate.toFixed(0)} 回/秒）`;
  $("r-motion").textContent = `中央値 ${sum.med.toFixed(2)} m/s²（目安 ${GOOD} 以上）`;
  const ul = $("file-list");
  ul.replaceChildren();
  for (const f of files) {
    const li = document.createElement("li");
    const a = document.createElement("span"); a.textContent = f.name;
    const b = document.createElement("span"); b.textContent = fmtBytes(f.size);
    li.append(a, b);
    ul.append(li);
  }
  $("btn-share").hidden = !state.shareFiles;
  $("share-hint").hidden = !state.shareFiles;
  show("screen-result");
}

function shareable(files) {
  try {
    return !!(navigator.canShare && navigator.canShare({ files }));
  } catch (e) {
    return false;
  }
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function shareAll() {
  const err = $("share-error");
  err.hidden = true;
  try {
    // text を付けると、iPhone で「ファイルに保存」したときに文面が .txt として一緒に保存されるので付けない
    await navigator.share({ files: state.shareFiles, title: "スマホ採寸の記録" });
  } catch (e) {
    if (e && e.name === "AbortError") return;
    err.textContent = "共有できませんでした。「動画を保存」「センサー記録を保存」で個別に保存してください。";
    err.hidden = false;
  }
}

function alertBox(msg) {
  const w = $("sensor-warning");
  w.textContent = msg; w.hidden = false;
}

function reset() {
  state.samples = state.samples.slice(-600);
  state.files = null;
  state.shareFiles = null;
  $("elapsed").textContent = "0.0 秒";
  $("guide").textContent = "端末を左右に小さく揺らしながら、物の周りを回ってください";
  show("screen-capture");
}

$("btn-begin").addEventListener("click", begin);
$("btn-record").addEventListener("click", () => (state.recording ? stopRecording() : startRecording()));
$("btn-share").addEventListener("click", shareAll);
$("btn-save-video").addEventListener("click", () => download(state.files[0]));
$("btn-save-imu").addEventListener("click", () => download(state.files[1]));
$("btn-save-meta").addEventListener("click", () => download(state.files[2]));
$("btn-again").addEventListener("click", reset);
