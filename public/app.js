const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const chunkMsEl = document.getElementById("chunkMs");
const hintTextEl = document.getElementById("hintText");

const realtimeTranscriptEl = document.getElementById("realtimeTranscript");
const h21El = document.getElementById("h21");
const h22El = document.getElementById("h22");
const h31El = document.getElementById("h31");
const timingEl = document.getElementById("timing");
const statusEl = document.getElementById("status");

let mediaRecorder;
let mediaStream;
let sessionId = "";
let seq = 1;
let inflight = 0;
let pollTimer;
let isStopping = false;
let cumulativeChunks = [];

function setIdle() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function setRecording() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
}

function mediaMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const c of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(c)) return c;
  }
  return "";
}

async function createSession() {
  const res = await fetch("/api/session/start", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "session作成に失敗しました。");
  }
  return data;
}

async function uploadChunk(blob, chunkSeq) {
  if (!sessionId) return;

  const form = new FormData();
  form.append("audio", blob, `chunk-${chunkSeq}.webm`);
  form.append("seq", String(chunkSeq));
  form.append("hintText", hintTextEl.value.trim());
  form.append("cumulative", "1");

  inflight += 1;
  try {
    const res = await fetch(`/api/session/${sessionId}/chunk`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "chunk送信エラー");
  } finally {
    inflight = Math.max(0, inflight - 1);
  }
}

function renderStatus(data) {
  realtimeTranscriptEl.textContent = data.realtime.transcript || "";
  h21El.textContent = data.modes["2.1"].hiragana || "";
  h22El.textContent = data.modes["2.2"].hiragana || "";
  h31El.textContent = data.modes["3.1"].hiragana || "";

  timingEl.textContent = [
    `chunk processed: ${data.chunks.processed}`,
    `STT realtime avg/latest (ms): ${data.realtime.avgElapsedMs} / ${data.realtime.latestElapsedMs}`,
    `2.1 avg/latest (ms): ${data.modes["2.1"].avgElapsedMs} / ${data.modes["2.1"].latestElapsedMs}`,
    `2.2 avg/latest (ms): ${data.modes["2.2"].avgElapsedMs} / ${data.modes["2.2"].latestElapsedMs}`,
    `3.1 avg/latest (ms): ${data.modes["3.1"].avgElapsedMs} / ${data.modes["3.1"].latestElapsedMs}`,
    `2.2 と 2.1 の直近編集距離: ${data.modes["2.2"].latestDistanceTo21}`,
  ].join("\n");

  statusEl.textContent = JSON.stringify(
    {
      sessionId: data.sessionId,
      chunks: data.chunks,
      worker: data.worker,
      inflightUploads: inflight,
      lastError: data.lastError,
    },
    null,
    2,
  );
}

async function pollStatus() {
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/session/${sessionId}/status`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "status取得失敗");
    renderStatus(data);

    const done = isStopping && inflight === 0 && data.chunks.pending === 0;
    if (done) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      setIdle();
      isStopping = false;
    }
  } catch (err) {
    statusEl.textContent = String(err.message || err);
  }
}

startBtn.addEventListener("click", async () => {
  try {
    const created = await createSession();
    sessionId = created.sessionId;
    seq = 1;
    inflight = 0;
    isStopping = false;
    cumulativeChunks = [];

    realtimeTranscriptEl.textContent = "録音準備中...";
    h21El.textContent = "処理待ち";
    h22El.textContent = "処理待ち";
    h31El.textContent = "処理待ち";
    timingEl.textContent = "計測開始";
    statusEl.textContent = JSON.stringify(created, null, 2);

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("このブラウザは録音に対応していません。");
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = mediaMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);

    mediaRecorder.ondataavailable = async (e) => {
      if (!e.data || e.data.size === 0) return;
      cumulativeChunks.push(e.data);
      const cumulativeBlob = new Blob(cumulativeChunks, { type: e.data.type || "audio/webm" });
      const currentSeq = seq;
      seq += 1;
      await uploadChunk(cumulativeBlob, currentSeq);
    };

    mediaRecorder.onstop = () => {
      mediaStream?.getTracks().forEach((t) => t.stop());
      mediaStream = undefined;
      isStopping = true;
    };

    const chunkMs = Number(chunkMsEl.value || "1500");
    mediaRecorder.start(chunkMs);
    setRecording();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 700);
    await pollStatus();
  } catch (err) {
    statusEl.textContent = String(err.message || err);
    setIdle();
  }
});

stopBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  stopBtn.disabled = true;
});

setIdle();
