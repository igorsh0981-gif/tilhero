import { concatChunks, level, MAX_RECORD_MS, toWav } from "./wav";

/**
 * The microphone for «Произнести» (APP-VOICE-04: asked for only when the learner taps «Записать», never at start, never
 * in a loop after a refusal). Web Audio, not MediaRecorder: iOS records AAC there, which the short REST of Azure does
 * not take (PLAN «Произношение»). The samples stay in memory; stop() turns them into a 16 kHz mono WAV Blob and drops
 * them; the tracks are stopped and the AudioContext closed — the system mic indicator goes off.
 *
 * startRecording() must be called synchronously in the tap handler: iOS creates and resumes an AudioContext only in a
 * user gesture.
 */

export type RecorderFailure = "unsupported" | "denied" | "no_device" | "failed";

export class RecorderError extends Error {
  readonly reason: RecorderFailure;
  constructor(reason: RecorderFailure, message = reason) {
    super(message);
    this.name = "RecorderError";
    this.reason = reason;
  }
}

export interface RecordedAudio {
  wav: Blob;
  durationMs: number;
  bytes: number;
  /** 16 kHz samples written (the 0,5 s minimum is checked on them, as the BFF does) */
  samples: number;
}

export interface Recording {
  /** stop and encode (idempotent: a second call gets the same result) */
  stop(): Promise<RecordedAudio>;
  /** stop and throw the samples away */
  cancel(): void;
}

type Ctor = typeof AudioContext;

function audioContextCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** The device can record at all (a secure context with getUserMedia and Web Audio). */
export function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function" && !!audioContextCtor();
}

/** getUserMedia refusal → why (the learner gets the matching instruction). */
export function failureOf(e: unknown): RecorderFailure {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "no_device";
  return "failed";
}

export async function startRecording(o: { onLevel?: (v: number) => void; onAutoStop?: (r: RecordedAudio) => void; maxMs?: number } = {}): Promise<Recording> {
  const maxMs = o.maxMs ?? MAX_RECORD_MS;
  const Ctx = audioContextCtor();
  if (!Ctx || !canRecord()) throw new RecorderError("unsupported");
  // in the gesture: the context first (iOS), then the permission prompt
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    throw new RecorderError("unsupported");
  }
  const resumed = ctx.resume().catch(() => undefined);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (e) {
    void ctx.close().catch(() => undefined);
    throw new RecorderError(failureOf(e));
  }
  await resumed;

  const rate = ctx.sampleRate;
  const limit = Math.floor((rate * maxMs) / 1000);
  let chunks: Float32Array[] = [];
  let samples = 0;
  let done: Promise<RecordedAudio> | null = null;
  let closed = false;

  // the graph: any failure here must release the microphone (tracks stopped, context closed) and say why
  let source: MediaStreamAudioSourceNode;
  let proc: ScriptProcessorNode;
  let mute: GainNode;
  try {
    source = ctx.createMediaStreamSource(stream);
    // one input channel: Web Audio mixes a stereo microphone down to mono
    proc = ctx.createScriptProcessor(4096, 1, 1);
    mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
  } catch {
    for (const t of stream.getTracks()) t.stop();
    void ctx.close().catch(() => undefined);
    throw new RecorderError("failed");
  }

  const release = () => {
    if (closed) return;
    closed = true;
    proc.onaudioprocess = null;
    try {
      source.disconnect();
      proc.disconnect();
      mute.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const t of stream.getTracks()) t.stop();
    void ctx.close().catch(() => undefined);
  };

  const finish = (): Promise<RecordedAudio> => {
    if (done) return done;
    release();
    const all = concatChunks(chunks);
    chunks = [];
    done = Promise.resolve(toWav(all, rate, maxMs));
    return done;
  };

  proc.onaudioprocess = (e) => {
    if (closed) return;
    const data = e.inputBuffer.getChannelData(0);
    const take = Math.min(data.length, limit - samples);
    if (take > 0) {
      chunks.push(new Float32Array(data.subarray(0, take)));
      samples += take;
    }
    o.onLevel?.(level(data));
    if (samples >= limit) void finish().then((r) => o.onAutoStop?.(r));
  };

  return {
    stop: finish,
    cancel: () => {
      chunks = [];
      release();
    },
  };
}
