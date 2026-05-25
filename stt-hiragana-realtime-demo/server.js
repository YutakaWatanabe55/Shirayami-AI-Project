import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3100);
const upload = multer({ dest: path.join(__dirname, "tmp") });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pythonBin =
  process.env.PYTHON_BIN ||
  path.resolve(__dirname, "..", ".venv-openwebui311", "Scripts", "python.exe");
const pythonExec = fsSync.existsSync(pythonBin) ? pythonBin : "python";
const workerScript = path.join(__dirname, "scripts", "run_realtime_worker.py");
const modelSize = String(process.env.WHISPER_MODEL_SIZE || "base");

class PythonWorker {
  constructor({ pythonPath, scriptPath, model }) {
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;
    this.model = model;
    this.proc = null;
    this.buffer = "";
    this.pending = new Map();
    this.readyInfo = null;
    this.readyPromise = this.start();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.pythonPath, [this.scriptPath, "--model-size", this.model], {
        cwd: __dirname,
        env: {
          ...process.env,
          PYTHONUTF8: "1",
        },
        windowsHide: true,
      });

      this.proc.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString();
        this.flushLines(resolve);
      });

      this.proc.stderr.on("data", (chunk) => {
        const line = chunk.toString().trim();
        if (line) {
          console.error(`[py-worker] ${line}`);
        }
      });

      this.proc.on("error", (err) => {
        reject(new Error(`Python worker起動失敗: ${err.message}`));
      });

      this.proc.on("close", (code) => {
        const err = new Error(`Python workerが終了しました (code=${code})`);
        for (const { reject: rej } of this.pending.values()) {
          rej(err);
        }
        this.pending.clear();
      });
    });
  }

  flushLines(resolveReady) {
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf("\n");

      if (!line) continue;

      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }

      if (payload.type === "ready") {
        this.readyInfo = payload;
        resolveReady?.(payload);
        continue;
      }

      const req = this.pending.get(payload.id);
      if (!req) continue;
      this.pending.delete(payload.id);

      if (payload.ok) {
        req.resolve(payload.result);
      } else {
        req.reject(new Error(payload.error || "Python worker error"));
      }
    }
  }

  async request(data) {
    await this.readyPromise;
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("Python workerが利用できません。");
    }

    const id = randomUUID();
    const payload = { ...data, id };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error(`Python worker送信失敗: ${err.message}`));
        }
      });
    });
  }
}

const worker = new PythonWorker({
  pythonPath: pythonExec,
  scriptPath: workerScript,
  model: modelSize,
});

const sessions = new Map();

function appendText(base, chunk) {
  if (!chunk) return base;
  if (!base) return chunk;
  return `${base} ${chunk}`;
}

function makeSession() {
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chunksReceived: 0,
    chunksProcessed: 0,
    chunksFailed: 0,
    pendingChunks: 0,
    queue: Promise.resolve(),
    realtime: {
      transcript: "",
      elapsedMsTotal: 0,
      latestElapsedMs: 0,
    },
    modes: {
      "2.1": { hiragana: "", elapsedMsTotal: 0, latestElapsedMs: 0 },
      "2.2": { hiragana: "", elapsedMsTotal: 0, latestElapsedMs: 0, latestDistanceTo21: 0 },
      "3.1": { hiragana: "", elapsedMsTotal: 0, latestElapsedMs: 0 },
    },
    isCumulativeInput: false,
    lastError: "",
    timeline: [],
  };
}

function getSession(id) {
  return sessions.get(id);
}

async function processChunk(session, audioPath, seq, hintText) {
  const now = Date.now();
  const started = performance.now();
  try {
    const result = await worker.request({
      audio: audioPath,
      hint_text: hintText || "",
    });

    if (session.isCumulativeInput) {
      session.realtime.transcript = result.realtime.transcript || "";
    } else {
      session.realtime.transcript = appendText(session.realtime.transcript, result.realtime.transcript);
    }
    session.realtime.elapsedMsTotal += result.realtime.elapsed_ms;
    session.realtime.latestElapsedMs = result.realtime.elapsed_ms;

    for (const key of ["2.1", "2.2", "3.1"]) {
      const m = result.modes[key];
      if (session.isCumulativeInput) {
        session.modes[key].hiragana = m.hiragana || "";
      } else {
        session.modes[key].hiragana = appendText(session.modes[key].hiragana, m.hiragana);
      }
      session.modes[key].elapsedMsTotal += m.elapsed_ms;
      session.modes[key].latestElapsedMs = m.elapsed_ms;
      if (key === "2.2") {
        session.modes[key].latestDistanceTo21 = m.distance_to_21 || 0;
      }
    }

    session.chunksProcessed += 1;
    session.timeline.push({
      seq,
      at: now,
      realtimeMs: result.realtime.elapsed_ms,
      mode21Ms: result.modes["2.1"].elapsed_ms,
      mode22Ms: result.modes["2.2"].elapsed_ms,
      mode31Ms: result.modes["3.1"].elapsed_ms,
      totalMs: result.total_elapsed_ms,
      wallMs: Math.round(performance.now() - started),
    });

    if (session.timeline.length > 120) {
      session.timeline.shift();
    }
    session.updatedAt = Date.now();
  } catch (err) {
    session.chunksFailed += 1;
    session.lastError = err.message;
    session.updatedAt = Date.now();
  } finally {
    session.pendingChunks = Math.max(0, session.pendingChunks - 1);
    await fs.unlink(audioPath).catch(() => {});
  }
}

function avg(total, count) {
  if (!count) return 0;
  return Number((total / count).toFixed(1));
}

function summarizeSession(session) {
  const count = session.chunksProcessed;
  return {
    sessionId: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    chunks: {
      received: session.chunksReceived,
      processed: session.chunksProcessed,
      failed: session.chunksFailed,
      pending: session.pendingChunks,
    },
    realtime: {
      transcript: session.realtime.transcript,
      latestElapsedMs: session.realtime.latestElapsedMs,
      avgElapsedMs: avg(session.realtime.elapsedMsTotal, count),
    },
    modes: {
      "2.1": {
        hiragana: session.modes["2.1"].hiragana,
        latestElapsedMs: session.modes["2.1"].latestElapsedMs,
        avgElapsedMs: avg(session.modes["2.1"].elapsedMsTotal, count),
      },
      "2.2": {
        hiragana: session.modes["2.2"].hiragana,
        latestElapsedMs: session.modes["2.2"].latestElapsedMs,
        avgElapsedMs: avg(session.modes["2.2"].elapsedMsTotal, count),
        latestDistanceTo21: session.modes["2.2"].latestDistanceTo21,
      },
      "3.1": {
        hiragana: session.modes["3.1"].hiragana,
        latestElapsedMs: session.modes["3.1"].latestElapsedMs,
        avgElapsedMs: avg(session.modes["3.1"].elapsedMsTotal, count),
      },
    },
    timeline: session.timeline,
    lastError: session.lastError,
    worker: worker.readyInfo,
  };
}

app.post("/api/session/start", async (req, res) => {
  await worker.readyPromise;
  const session = makeSession();
  sessions.set(session.id, session);
  res.json({ sessionId: session.id, worker: worker.readyInfo });
});

app.post("/api/session/:id/chunk", upload.single("audio"), async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(404).json({ error: "sessionが存在しません。" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "audioファイルがありません。" });
    return;
  }

  const seq = Number(req.body.seq || session.chunksReceived + 1);
  const hintText = String(req.body.hintText || "");
  const cumulative = String(req.body.cumulative || "0") === "1";

  session.chunksReceived += 1;
  session.pendingChunks += 1;
  session.isCumulativeInput = cumulative;
  session.updatedAt = Date.now();

  session.queue = session.queue.then(() => processChunk(session, req.file.path, seq, hintText));

  res.json({ ok: true, acceptedSeq: seq, pendingChunks: session.pendingChunks });
});

app.get("/api/session/:id/status", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "sessionが存在しません。" });
    return;
  }
  res.json(summarizeSession(session));
});

app.post("/api/session/:id/end", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "sessionが存在しません。" });
    return;
  }
  res.json({ ok: true, summary: summarizeSession(session) });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    const idleMs = now - session.updatedAt;
    if (idleMs > 1000 * 60 * 30) {
      sessions.delete(id);
    }
  }
}, 1000 * 60);

app.listen(port, () => {
  console.log(`STT realtime demo: http://localhost:${port}`);
});
