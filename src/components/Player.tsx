// @ts-nocheck -- dense audio/canvas indexing
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

type Track = { name: string; url: string; folder: string; size: number; kbps?: number; approx?: boolean };
type Station = { name: string; url: string; tag: string; favicon?: string; kbps?: number };

const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Hip Hop": [6, 5, 3, 1, -1, -1, 1, 2, 3, 3],
  Rock: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5],
  Sertanejo: [3, 2, 1, 0, 1, 3, 4, 3, 2, 1],
  Pop: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  Vocal: [-2, -2, -1, 1, 4, 5, 4, 2, 0, -1],
};
const LOCAIS: Station[] = [
  { name: "94 FM Dourados", url: "https://stream.radiosms.com.br/radio/8000/radio", tag: "Locais" },
  { name: "Massa FM 90.3 - Dourados", url: "https://massafmdourados.brasilstream.com.br/hls/massafmdourados/index.m3u8", tag: "Locais" },
  { name: "Grande FM 92.1 - Dourados", url: "https://9867.brasilstream.com.br/stream", tag: "Locais" },
  { name: "Ilha FM 107.1 - Paraná", url: "https://casthttps.suaradionanet.net/13325/stream", tag: "Locais" },
  { name: "Coração FM 95.7 - Itaporã", url: "http://wz1.dnip.com.br/coracaohd/coracaohd.stream/playlist.m3u8", tag: "Locais" },
];
const PARAGUAI: Station[] = [
  { name: "E40 Estación 40 91.1 - Assunção", url: "https://rds3.desdeparaguay.net/transestacion40/transestacion40/playlist.m3u8", tag: "Paraguai" },
  { name: "Amambay 100.5 - Pedro Juan", url: "http://cp9.serverse.com:7221/stream", tag: "Paraguai" },
  { name: "Tropicalia 93.9 - Assunção", url: "https://rds3.desdeparaguay.net/movtropicalia/movtropicalia.stream/playlist.m3u8", tag: "Paraguai" },
  { name: "FM Popular 103.1 - Assunção", url: "https://rds3.desdeparaguay.net/transpopular/transpopular/playlist.m3u8", tag: "Paraguai" },
  { name: "Vibras 92.7 - Assunção", url: "https://rds3.desdeparaguay.net/movvibras/movvibras.stream/playlist.m3u8", tag: "Paraguai" },
  { name: "Monumental 1080 AM - Assunção", url: "https://mdstrm.com/audio/62d81ca6a459e4082203c95b/icecast.audio", tag: "Paraguai" },
  { name: "ABC Cardinal 730 AM - Assunção", url: "http://sc.abc.com.py:8000/stream", tag: "Paraguai" },
  { name: "Pop 93.3 - Assunção", url: "http://rps1.radiopop.com.py:8000/stream", tag: "Paraguai" },
];
const API = "https://de1.api.radio-browser.info/json/stations";
const SEARCHES: { label: string; q: string }[] = [
  { label: "Locais", q: "byname/94 fm dourados" },
  { label: "Hip Hop", q: "bytag/hiphop" },
  { label: "Rock", q: "bytag/rock" },
  { label: "Sertanejo", q: "bytag/sertanejo" },
];

type Graph = {
  ctx: AudioContext; gain: GainNode; bass: BiquadFilterNode; eq: BiquadFilterNode[];
  aL: AnalyserNode; aR: AnalyserNode; spec: AnalyserNode;
};

// Lê o bitrate real do cabeçalho do 1º frame MPEG Layer III. Retorna undefined se for VBR/ilegível.
async function mp3Bitrate(f: File): Promise<number | undefined> {
  try {
    const h = new Uint8Array(await f.slice(0, 10).arrayBuffer());
    let off = 0;
    if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) off = 10 + (((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f));
    const b = new Uint8Array(await f.slice(off, off + 4096).arrayBuffer());
    const V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    for (let i = 0; i + 4 < b.length; i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, br = b[i + 2] >> 4, sr = (b[i + 2] >> 2) & 3;
      if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) continue;
      const tag = String.fromCharCode(...b.slice(i + 4, i + 44));
      if (tag.includes("Xing") || tag.includes("VBRI")) return undefined; // VBR: usa média
      return (ver === 3 ? V1 : V2)[br];
    }
  } catch {}
  return undefined;
}

export function Player() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hlsRef = useRef<any>(null);
  const graph = useRef<Graph | null>(null);
  const corsOk = useRef(true); // false = elemento atual toca sem Web Audio (stream sem CORS)
  const playToken = useRef(0); // ignora respostas async de plays antigos
  const [audioKey, setAudioKey] = useState(0);
  const [err, setErr] = useState("");
  const [liveKbps, setLiveKbps] = useState(0);
  const [dark, setDark] = useState(true);
  const [tab, setTab] = useState<"music" | "radio">("music");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [folder, setFolder] = useState("Todas");
  const [idx, setIdx] = useState(-1);
  const [station, setStation] = useState<Station | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [rTag, setRTag] = useState("Locais");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ c: 0, d: 0 });
  const [showCfg, setShowCfg] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [gainDb, setGainDb] = useState(0);
  const [bassDb, setBassDb] = useState(0);
  const [eq, setEq] = useState<number[]>([...PRESETS.Flat]);
  const [vuStyle, setVuStyle] = useState<"stereo" | "spectrum">("stereo");
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);

  // load settings
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("bks") || "{}");
      if (s.dark !== undefined) setDark(s.dark);
      if (s.volume !== undefined) setVolume(s.volume);
      if (s.gainDb !== undefined) setGainDb(s.gainDb);
      if (s.bassDb !== undefined) setBassDb(s.bassDb);
      if (s.eq) setEq(s.eq);
      if (s.vuStyle) setVuStyle(s.vuStyle);
    } catch {}
  }, []);
  useEffect(() => {
    localStorage.setItem("bks", JSON.stringify({ dark, volume, gainDb, bassDb, eq, vuStyle }));
    document.documentElement.classList.toggle("dark", dark);
  }, [dark, volume, gainDb, bassDb, eq, vuStyle]);

  // radios
  useEffect(() => {
    Promise.all(
      SEARCHES.map((s) =>
        fetch(`${API}/${encodeURIComponent(s.q.split("/")[0])}/${encodeURIComponent(s.q.split("/")[1])}?hidebroken=true&order=votes&reverse=true&limit=${s.label === "Locais" ? 6 : 20}`)
          .then((r) => r.json())
          .then((list: any[]) => list.map((x) => ({ name: x.name.trim(), url: x.url_resolved, tag: s.label, favicon: x.favicon, kbps: x.bitrate || undefined })))
          .catch(() => [] as Station[]),
      ),
    ).then((all) => {
      const merged = new Map<string, Station>();
      for (const s of [...LOCAIS, ...PARAGUAI, ...all.flat()]) {
        if (!s.url) continue;
        const p = merged.get(s.url);
        if (!p) merged.set(s.url, { ...s });
        else if (!p.kbps && s.kbps) p.kbps = s.kbps;
      }
      setStations([...merged.values()]);
    });
  }, []);

  function ensureGraph() {
    if (graph.current || !audioRef.current || !corsOk.current) return graph.current;
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(audioRef.current);
    const gain = ctx.createGain();
    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf"; bass.frequency.value = 120;
    const eqN = EQ_FREQS.map((f) => {
      const b = ctx.createBiquadFilter(); b.type = "peaking"; b.frequency.value = f; b.Q.value = 1.1; return b;
    });
    const spl = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(); const aR = ctx.createAnalyser(); const spec = ctx.createAnalyser();
    aL.fftSize = aR.fftSize = 1024; spec.fftSize = 128; spec.smoothingTimeConstant = 0.75;
    let n: AudioNode = src.connect(gain).connect(bass);
    eqN.forEach((b) => (n = n.connect(b)));
    n.connect(ctx.destination); n.connect(spec); n.connect(spl);
    spl.connect(aL, 0); spl.connect(aR, 1);
    graph.current = { ctx, gain, bass, eq: eqN, aL, aR, spec };
    return graph.current;
  }

  // apply audio settings
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    const g = graph.current; if (!g) return;
    g.gain.gain.value = Math.pow(10, gainDb / 20);
    g.bass.gain.value = bassDb;
    g.eq.forEach((b, i) => (b.gain.value = eq[i]));
  }, [volume, gainDb, bassDb, eq, playing]);

  // VU drawing
  useEffect(() => {
    let raf = 0;
    const peaks = [0, 0];
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvasRef.current; if (!c) return;
      const x = c.getContext("2d")!;
      const W = (c.width = c.clientWidth * 2), H = (c.height = c.clientHeight * 2);
      const cs = getComputedStyle(document.documentElement);
      const off = cs.getPropertyValue("--led-off");
      const prim = cs.getPropertyValue("--primary");
      x.clearRect(0, 0, W, H);
      const g = graph.current;
      const colorAt = (t: number) => (t > 0.85 ? "oklch(0.65 0.25 25)" : t > 0.65 ? "oklch(0.85 0.18 90)" : prim);
      if (vuStyle === "stereo") {
        const LBL = ["-20","-16","-12","-10","-8","-7","-6","-5","-4","-3","-2","-1","0","+1","+2","+3"];
        const segs = 16; const top = 40; const bot = 40; const sh = (H - top - bot) / segs;
        const green = "oklch(0.88 0.24 135)", yel = "oklch(0.75 0.15 95)", red = "oklch(0.62 0.22 25)";
        const col = (i: number) => (i >= 13 ? red : i >= 11 ? yel : green);
        const dim = (c: string) => c.replace(")", " / 0.18)");
        const lv = [g?.aL, g?.aR].map((a, ch) => {
          let lvl = 0;
          if (a && playing) {
            const d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d);
            let s = 0; for (const v of d) s += v * v;
            const db = 20 * Math.log10(Math.sqrt(s / d.length) + 1e-6);
            lvl = Math.max(0, Math.min(1, (db + 42) / 40));
          }
          peaks[ch] = Math.max(lvl, peaks[ch] - 0.008);
          return lvl;
        });
        x.font = `${Math.round(sh * 0.5)}px Rajdhani`; x.textBaseline = "middle";
        const bw = W * 0.2, pw = W * 0.025;
        const cols = [{ bx: W * 0.17, px: W * 0.39, lx: W * 0.11, al: "right" as const }, { bx: W * 0.63, px: W * 0.585, lx: W * 0.89, al: "left" as const }];
        cols.forEach((c, ch) => {
          for (let i = 0; i < segs; i++) {
            const y = H - bot - (i + 1) * sh + 3;
            const on = i / segs < lv[ch]; const pk = Math.floor(peaks[ch] * segs) === i && peaks[ch] > 0.02;
            x.shadowBlur = on || pk ? 12 : 0; x.shadowColor = col(i);
            x.fillStyle = on ? col(i) : dim(col(i));
            x.fillRect(c.bx, y, bw, sh - 6);
            x.fillStyle = on || pk ? col(i) : dim(col(i));
            x.fillRect(c.px, y, pw, sh - 6);
            x.shadowBlur = 0; x.fillStyle = "oklch(0.75 0.02 300)"; x.textAlign = c.al;
            x.fillText(LBL[i], c.lx, y + sh / 2 - 3);
          }
          x.fillStyle = red; x.textAlign = "center"; x.font = `bold ${Math.round(sh * 0.7)}px Orbitron`;
          x.fillText("dB", c.bx + bw / 2, top / 2);
          x.fillStyle = "oklch(0.95 0 0)"; x.fillText(ch ? "R" : "L", c.bx + bw / 2, H - bot / 2);
          x.font = `${Math.round(sh * 0.5)}px Rajdhani`;
        });
        const pmax = Math.max(peaks[0], peaks[1]);
        for (let i = 0; i < segs; i++) {
          const y = H - bot - (i + 1) * sh + 3; const on = i / segs < pmax;
          x.fillStyle = on ? col(i) : dim(col(i)); x.fillRect(W * 0.47, y + sh * 0.2, sh * 0.35, sh * 0.35);
          x.fillStyle = "oklch(0.65 0.02 300)"; x.textAlign = "left"; x.fillText(String(i + 1), W * 0.5, y + sh / 2 - 3);
        }
        x.textAlign = "center"; x.fillStyle = "oklch(0.75 0.02 300)"; x.font = `bold ${Math.round(sh * 0.45)}px Orbitron`;
        x.fillText("MAX.", W / 2, top / 2); x.fillText("PEAK", W / 2, H - bot / 2);
      } else {
        const a = g?.spec; const bins = 24; const rows = 14;
        const d = new Uint8Array(64); if (a && playing) a.getByteFrequencyData(d);
        const bw = W / bins; const rh = H / rows;
        for (let b = 0; b < bins; b++) {
          const v = d[Math.floor((b / bins) * 48)] / 255;
          for (let r = 0; r < rows; r++) {
            const t = r / rows; const on = t < v;
            x.fillStyle = on ? colorAt(t) : off;
            x.shadowBlur = on ? 10 : 0; x.shadowColor = colorAt(t);
            x.beginPath(); x.roundRect(b * bw + 2, H - (r + 1) * rh + 2, bw - 4, rh - 4, 3); x.fill();
          }
        }
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [vuStyle, playing]);

  const visible = folder === "Todas" ? tracks : tracks.filter((t) => t.folder === folder);
  const folders = ["Todas", ...Array.from(new Set(tracks.map((t) => t.folder)))];

  // Um <audio> só pode virar MediaElementSource uma vez, e stream sem CORS vira mudo
  // dentro do Web Audio. Por isso trocamos o elemento por um novo (key) quando precisa.
  function freshAudio() {
    hlsRef.current?.destroy(); hlsRef.current = null;
    graph.current?.ctx.close().catch(() => {}); graph.current = null;
    flushSync(() => { setAudioKey((k) => k + 1); setPlaying(false); });
    const a = audioRef.current!;
    a.volume = volume;
    return a;
  }
  async function playUrl(url: string, radio: boolean) {
    const token = ++playToken.current;
    setErr(""); setLiveKbps(0);
    let a = audioRef.current!;
    if (!corsOk.current) { corsOk.current = true; a = freshAudio(); }
    hlsRef.current?.destroy(); hlsRef.current = null;
    a.pause(); a.removeAttribute("src"); a.load();
    a.crossOrigin = "anonymous";
    if (/\.m3u8($|\?)/i.test(url)) {
      // HLS (E40, Tropicalia…): hls.js ou suporte nativo do Safari
      if (a.canPlayType("application/vnd.apple.mpegurl")) {
        a.src = url;
      } else {
        const Hls = (await import("hls.js")).default;
        if (token !== playToken.current) return;
        if (Hls.isSupported()) {
          const h = new Hls({ enableWorker: true });
          hlsRef.current = h;
          h.on(Hls.Events.LEVEL_SWITCHED, (_e: any, d: any) => { const b = h.levels?.[d.level]?.bitrate; if (b) setLiveKbps(Math.round(b / 1000)); });
          h.loadSource(url); h.attachMedia(a);
        } else a.src = url;
      }
      const g = ensureGraph(); await g?.ctx.resume();
      if (token !== playToken.current) return;
      await a.play().catch(() => { if (token === playToken.current) setErr("Não foi possível tocar esta rádio."); });
      return;
    }
    a.src = url;
    const g = ensureGraph(); await g?.ctx.resume();
    try { await a.play(); } catch {
      if (token !== playToken.current) return;
      if (radio) { // stream sem CORS: toca sem Web Audio (VU/EQ off), senão o áudio sairia mudo
        corsOk.current = false;
        a = freshAudio();
        a.removeAttribute("crossorigin"); a.src = url;
        await a.play().catch(() => { if (token === playToken.current) setErr("Não foi possível tocar esta rádio."); });
      } else setErr("Não foi possível tocar este arquivo.");
    }
  }
  function playTrack(i: number) {
    if (!tracks[i]) return; setStation(null); setIdx(i); playUrl(tracks[i].url, false);
  }
  function playStation(s: Station) { setIdx(-1); setStation(s); playUrl(s.url, true); }
  function next(dir = 1) {
    if (station) {
      const list = stations.filter((s) => s.tag === station.tag);
      const i = list.findIndex((s) => s.url === station.url);
      if (list.length) playStation(list[(i + dir + list.length) % list.length]);
      return;
    }
    if (!tracks.length) return;
    const ids = visible.map((t) => tracks.indexOf(t));
    const pos = ids.indexOf(idx);
    const n = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[(pos + dir + ids.length) % ids.length];
    playTrack(n);
  }
  async function toggle() {
    const a = audioRef.current!;
    if (!a.src) { if (tab === "radio" && stations[0]) playStation(stations.filter(s=>s.tag===rTag)[0] ?? stations[0]); else playTrack(tracks.indexOf(visible[0])); return; }
    await graph.current?.ctx.resume();
    a.paused ? a.play() : a.pause();
  }
  function onFiles(files: FileList | null) {
    if (!files) return;
    const picked = Array.from(files).filter((f) => f.type.startsWith("audio") || /\.(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(f.name));
    const list: Track[] = picked.map((f) => {
      const p = (f as any).webkitRelativePath?.split("/") ?? [];
      return { name: f.name.replace(/\.[^.]+$/, ""), url: URL.createObjectURL(f), folder: p.length > 1 ? p[p.length - 2] : "Arquivos", size: f.size };
    });
    setTracks((t) => [...t, ...list]);
    picked.forEach((f, i) => {
      if (!/\.mp3$/i.test(f.name) && f.type !== "audio/mpeg") return;
      mp3Bitrate(f).then((k) => { if (k) setTracks((l) => l.map((x) => (x.url === list[i].url ? { ...x, kbps: k, approx: false } : x))); });
    });
  }

  const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
  const title = station?.name ?? tracks[idx]?.name ?? "Nenhuma faixa";
  const sub = station ? `📻 ${station.tag}` : tracks[idx]?.folder ?? "Escolha uma música ou rádio";
  const curKbps = station ? station.kbps || liveKbps : tracks[idx]?.kbps;
  const kbpsLabel = station ? `${curKbps || "--"} kbps` : curKbps ? `${tracks[idx]?.approx ? "~" : ""}${curKbps} kbps` : "";
  const btn = "grid place-items-center rounded-full bg-secondary text-secondary-foreground active:scale-95 transition";

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col gap-3 p-3 pb-6">
      <audio key={audioKey} ref={audioRef} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => (repeat ? audioRef.current?.play() : next())}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration; const t = tracks[idx];
          if (station || !t || t.kbps || !t.size || !Number.isFinite(d) || d <= 0) return;
          const k = Math.round((t.size * 8) / d / 1000);
          setTracks((l) => l.map((x) => (x.url === t.url && !x.kbps ? { ...x, kbps: k, approx: true } : x)));
        }}
        onTimeUpdate={(e) => setTime({ c: e.currentTarget.currentTime, d: e.currentTarget.duration })} />

      <header className="flex items-center justify-between">
        <h1 className="font-display text-xl font-black tracking-widest text-primary">BKS<span className="text-foreground">PLAYER</span></h1>
        <div className="flex gap-2">
          <button className={`${btn} h-9 w-9`} onClick={() => setDark(!dark)} aria-label="Tema">{dark ? "☀️" : "🌙"}</button>
          <button className={`${btn} h-9 w-9`} onClick={() => setShowCfg(true)} aria-label="Configurações">⚙️</button>
        </div>
      </header>

      <section className="rounded-2xl border bg-card p-3 shadow-glow">
        <div className="mb-1 flex justify-between font-display text-[10px] text-muted-foreground">
          <span>{vuStyle === "stereo" ? "L / R" : "SPECTRUM"}</span>
          <button onClick={() => setVuStyle(vuStyle === "stereo" ? "spectrum" : "stereo")} className="text-primary">TROCAR VU</button>
        </div>
        <div className="rounded-xl bg-background p-2">
          <div className="text-center font-display text-[10px] tracking-[0.3em] text-muted-foreground">STEREO LEVEL METER <span className="text-primary">/ 01</span></div>
          <canvas ref={canvasRef} className={`w-full ${vuStyle === "stereo" ? "h-72" : "h-32"}`} />
          <div className="flex justify-center gap-4 font-display text-[9px] text-muted-foreground"><span>🟢 SIGNAL</span><span>🟡 PEAK</span><span>🔴 CLIP</span></div>
        </div>

        <div className="mt-3 truncate font-display text-sm font-bold">{title}</div>
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-sm text-muted-foreground">{sub}</div>
          {kbpsLabel && <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 font-display text-[10px] font-bold text-primary">{kbpsLabel}</span>}
        </div>
        {err && <div className="text-sm text-red-500">{err}</div>}
        <input type="range" className="range-primary mt-2 w-full" min={0} max={time.d || 0} step={0.1} value={time.c}
          disabled={!!station} onChange={(e) => (audioRef.current!.currentTime = +e.target.value)} />
        <div className="flex justify-between font-display text-[10px] text-muted-foreground">
          <span>{fmt(time.c)}</span><span>{station ? "AO VIVO" : fmt(time.d)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button className={`${btn} h-10 w-10 ${shuffle ? "text-primary" : ""}`} onClick={() => setShuffle(!shuffle)}>🔀</button>
          <button className={`${btn} h-12 w-12 text-lg`} onClick={() => next(-1)}>⏮</button>
          <button className="grid h-16 w-16 place-items-center rounded-full bg-gradient-primary text-2xl text-primary-foreground shadow-glow active:scale-95" onClick={toggle}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className={`${btn} h-12 w-12 text-lg`} onClick={() => next(1)}>⏭</button>
          <button className={`${btn} h-10 w-10 ${repeat ? "text-primary" : ""}`} onClick={() => setRepeat(!repeat)}>🔁</button>
        </div>
        <div className="mt-3 flex items-center gap-2 text-sm">🔈
          <input type="range" className="range-primary w-full" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(+e.target.value)} />🔊
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2 rounded-full bg-muted p-1 font-display text-xs">
        {(["music", "radio"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full py-2 ${tab === t ? "bg-gradient-primary text-primary-foreground" : "text-muted-foreground"}`}>
            {t === "music" ? "🎵 MÚSICAS" : "📻 RÁDIOS"}
          </button>
        ))}
      </div>

      {tab === "music" ? (
        <section className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="cursor-pointer rounded-xl bg-gradient-primary py-2 text-center font-bold text-primary-foreground">📁 Pasta
              {/* @ts-expect-error webkitdirectory */}
              <input type="file" webkitdirectory="" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            </label>
            <label className="cursor-pointer rounded-xl bg-secondary py-2 text-center font-bold">🎶 Arquivos
              <input type="file" accept="audio/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            </label>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {folders.map((f) => (
              <button key={f} onClick={() => setFolder(f)} className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${folder === f ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{f}</button>
            ))}
          </div>
          <ul className="flex flex-col gap-1">
            {visible.length === 0 && <li className="py-8 text-center text-muted-foreground">Adicione uma pasta de músicas</li>}
            {visible.map((t) => {
              const i = tracks.indexOf(t);
              return (
                <li key={t.url}><button onClick={() => playTrack(i)} className={`w-full truncate rounded-xl px-3 py-2 text-left ${i === idx ? "bg-accent text-accent-foreground" : "bg-card"}`}>
                  {i === idx && playing ? "▶ " : ""}{t.name}</button></li>
              );
            })}
          </ul>
        </section>
      ) : (
        <section className="flex flex-col gap-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {["Locais", "Paraguai", "Hip Hop", "Rock", "Sertanejo"].map((f) => (
              <button key={f} onClick={() => setRTag(f)} className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${rTag === f ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{f}</button>
            ))}
          </div>
          <ul className="flex flex-col gap-1">
            {stations.length === 0 && <li className="py-8 text-center text-muted-foreground">Carregando rádios…</li>}
            {stations.filter((s) => s.tag === rTag).map((s) => (
              <li key={s.url}><button onClick={() => playStation(s)} className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left ${station?.url === s.url ? "bg-accent text-accent-foreground" : "bg-card"}`}>
                {s.favicon ? <img src={s.favicon} alt="" className="h-7 w-7 rounded object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span>📻</span>}
                <span className="truncate">{s.name}</span>{s.kbps ? <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{s.kbps}k</span> : null}</button></li>
            ))}
          </ul>
        </section>
      )}

      {showCfg && (
        <div className="fixed inset-0 z-50 flex items-end bg-background/70 backdrop-blur" onClick={() => setShowCfg(false)}>
          <div className="mx-auto max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl border bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display font-bold text-primary">ÁUDIO</h2>
              <button onClick={() => setShowCfg(false)} className={`${btn} h-8 w-8`}>✕</button>
            </div>
            <Slider label={`Ganho ${gainDb > 0 ? "+" : ""}${gainDb} dB`} min={-12} max={12} v={gainDb} set={setGainDb} />
            <Slider label={`Bass Boost ${bassDb} dB`} min={0} max={18} v={bassDb} set={setBassDb} />
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.keys(PRESETS).map((p) => (
                <button key={p} onClick={() => setEq([...PRESETS[p as keyof typeof PRESETS]])} className="rounded-full bg-muted px-3 py-1 text-sm">{p}</button>
              ))}
            </div>
            <div className="mt-4 flex h-48 justify-between">
              {EQ_FREQS.map((f, i) => (
                <div key={f} className="flex flex-col items-center gap-1">
                  <span className="font-display text-[9px]">{eq[i] > 0 ? "+" : ""}{eq[i]}</span>
                  <input type="range" min={-12} max={12} value={eq[i]} className="h-36 accent-primary [writing-mode:vertical-lr] [direction:rtl]"
                    onChange={(e) => setEq(eq.map((x, j) => (j === i ? +e.target.value : x)))} />
                  <span className="text-[9px] text-muted-foreground">{f >= 1000 ? `${f / 1000}k` : f}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <button onClick={() => setDark(!dark)} className="rounded-xl bg-muted py-2">Modo {dark ? "Branco" : "Black"}</button>
              <button onClick={() => { setEq([...PRESETS.Flat]); setGainDb(0); setBassDb(0); }} className="rounded-xl bg-muted py-2">Resetar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Slider({ label, min, max, v, set }: { label: string; min: number; max: number; v: number; set: (n: number) => void }) {
  return (
    <label className="mt-2 block text-sm font-semibold">{label}
      <input type="range" className="range-primary w-full" min={min} max={max} value={v} onChange={(e) => set(+e.target.value)} />
    </label>
  );
}
