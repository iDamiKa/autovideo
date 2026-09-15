// Servicio de render de video: recibe imagenes + audios de voz por escena + una
// pista de musica, y devuelve un MP4 vertical armado con FFmpeg (Ken Burns, texto
// de subtitulo por escena, musica de fondo bajita). n8n le habla a esto por HTTP en
// vez de ejecutar FFmpeg el mismo, porque el contenedor de n8n es una imagen
// "hardened" sin gestor de paquetes: no hay forma de instalarle FFmpeg.
//
// Contrato de entrada (POST /render), todo por URL publica (nada de binarios en el
// body, para no complicar el paso por n8n):
//   {
//     "escenas": [ { "imagenUrl": "...", "audioUrl": "...", "texto": "..." }, ... ],
//     "musicaUrl": "...",           // opcional
//     "supabase": {                  // a donde subir el resultado
//       "url": "https://xxx.supabase.co",
//       "bucket": "videos",
//       "path": "sabiduria/2026-09-15-salmo23.mp4",
//       "serviceRoleKey": "..."
//     }
//   }
//
// Responde { "url": "https://.../videos/..." } con el video ya subido, o
// { "error": "..." } con código 4xx/5xx si algo falla.

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PUERTO = process.env.PORT || 3000;
const API_KEY = process.env.RENDER_API_KEY; // compartida con n8n, obligatoria
const ANCHO = 1080;
const ALTO = 1920;

// --- utilidades básicas -----------------------------------------------------

function descargar(url, destino) {
  return new Promise((resolve, reject) => {
    const cliente = url.startsWith("https") ? https : http;
    const archivo = fs.createWriteStream(destino);
    cliente
      .get(url, (res) => {
        if (res.statusCode >= 400) {
          reject(new Error(`Descarga falló (${res.statusCode}): ${url}`));
          return;
        }
        res.pipe(archivo);
        archivo.on("finish", () => archivo.close(resolve));
      })
      .on("error", reject);
  });
}

function ejecutar(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} salió con código ${code}\n${stderr.slice(-2000)}`));
    });
    proc.on("error", reject);
  });
}

async function duracionDe(archivo) {
  let salida = "";
  await new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      archivo,
    ]);
    proc.stdout.on("data", (d) => (salida += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffprobe falló"))));
    proc.on("error", reject);
  });
  return parseFloat(salida.trim());
}

// Escapa texto para el filtro drawtext de FFmpeg (comillas, dos puntos, saltos).
function escaparParaDrawtext(texto) {
  return texto
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/\n/g, " ")
    .slice(0, 220);
}

// --- el render en sí ---------------------------------------------------------

async function armarEscena(dirTmp, i, escena) {
  const imagen = path.join(dirTmp, `img${i}.jpg`);
  const audio = path.join(dirTmp, `voz${i}.mp3`);
  const clip = path.join(dirTmp, `escena${i}.mp4`);

  await descargar(escena.imagenUrl, imagen);
  await descargar(escena.audioUrl, audio);
  const dur = await duracionDe(audio);

  // Ken Burns: zoom lento y parejo durante toda la escena, empezando centrado.
  const fps = 30;
  const totalFrames = Math.max(1, Math.round(dur * fps));
  const zoompan =
    `zoompan=z='min(zoom+0.0008,1.15)':d=${totalFrames}:s=${ANCHO}x${ALTO}:fps=${fps}`;

  const textoEscapado = escaparParaDrawtext(escena.texto || "");
  const drawtext =
    `drawtext=text='${textoEscapado}':fontcolor=white:fontsize=46:` +
    `box=1:boxcolor=black@0.45:boxborderw=20:x=(w-text_w)/2:y=h-380:` +
    `line_spacing=8`;

  await ejecutar("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagen,
    "-i", audio,
    "-filter_complex",
    `[0:v]scale=${ANCHO * 2}:${ALTO * 2}:force_original_aspect_ratio=increase,` +
      `crop=${ANCHO * 2}:${ALTO * 2},${zoompan},${drawtext}[v]`,
    "-map", "[v]",
    "-map", "1:a",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-t", String(dur),
    clip,
  ]);

  return { clip, audio, dur };
}

async function armarVideo({ escenas, musicaUrl }) {
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  try {
    const partes = [];
    for (let i = 0; i < escenas.length; i++) {
      partes.push(await armarEscena(dirTmp, i, escenas[i]));
    }

    const duracionTotal = partes.reduce((a, p) => a + p.dur, 0);

    // Concatena los clips (ya traen su propio audio de voz).
    const listaConcat = path.join(dirTmp, "lista.txt");
    fs.writeFileSync(
      listaConcat,
      partes.map((p) => `file '${p.clip.replace(/'/g, "'\\''")}'`).join("\n")
    );
    const sinMusica = path.join(dirTmp, "sin_musica.mp4");
    await ejecutar("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listaConcat,
      "-c", "copy", sinMusica,
    ]);

    if (!musicaUrl) {
      return sinMusica;
    }

    // Música de fondo, bajita, recortada a la duración total, mezclada con la voz.
    const musica = path.join(dirTmp, "musica.mp3");
    await descargar(musicaUrl, musica);
    const final = path.join(dirTmp, "final.mp4");
    await ejecutar("ffmpeg", [
      "-y",
      "-i", sinMusica,
      "-stream_loop", "-1", "-i", musica,
      "-filter_complex",
      `[1:a]volume=0.12[musicabaja];[0:a][musicabaja]amix=inputs=2:duration=first:dropout_transition=2[audio]`,
      "-map", "0:v",
      "-map", "[audio]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-t", String(duracionTotal),
      final,
    ]);
    return final;
  } finally {
    // El archivo final se copia antes de limpiar; ver /render.
  }
}

async function subirASupabase(archivoLocal, supabase) {
  const buffer = fs.readFileSync(archivoLocal);
  const url = `${supabase.url}/storage/v1/object/${supabase.bucket}/${supabase.path}`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabase.serviceRoleKey}`,
          apikey: supabase.serviceRoleKey,
          "Content-Type": "video/mp4",
          "x-upsert": "true",
          "Content-Length": buffer.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          if (res.statusCode >= 400) reject(new Error(`Supabase upload ${res.statusCode}: ${data}`));
          else resolve(`${supabase.url}/storage/v1/object/public/${supabase.bucket}/${supabase.path}`);
        });
      }
    );
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

// --- HTTP --------------------------------------------------------------------

app.get("/salud", (_req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  if (!API_KEY || req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "no autorizado" });
  }

  const { escenas, musicaUrl, supabase } = req.body || {};
  if (!Array.isArray(escenas) || escenas.length === 0) {
    return res.status(400).json({ error: "faltan escenas" });
  }
  if (!supabase || !supabase.url || !supabase.bucket || !supabase.path || !supabase.serviceRoleKey) {
    return res.status(400).json({ error: "falta configuración de supabase para subir el resultado" });
  }

  try {
    const archivoFinal = await armarVideo({ escenas, musicaUrl });
    const urlPublica = await subirASupabase(archivoFinal, supabase);
    res.json({ url: urlPublica });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PUERTO, () => console.log(`Render service escuchando en :${PUERTO}`));
