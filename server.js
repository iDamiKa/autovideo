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

// Parte el texto en l\u00edneas cortas para que nunca se salga de los bordes del
// video (drawtext no ajusta texto solo).
function partirEnLineas(texto, maxCaracteres) {
  const palabras = (texto || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lineas = [];
  let actual = "";
  for (const palabra of palabras) {
    const candidata = actual ? `${actual} ${palabra}` : palabra;
    if (candidata.length > maxCaracteres && actual) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = candidata;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

// Agrupa las l\u00edneas en bloques de m\u00e1ximo 2 (para que nunca se vea un muro de
// texto), y le da a cada bloque una ventana de tiempo proporcional a cu\u00e1ntas
// palabras tiene \u2014 as\u00ed el subt\u00edtulo cambia m\u00e1s o menos al ritmo de la voz,
// aunque Google TTS no nos d\u00e9 marcas de tiempo exactas por palabra.
function armarBloques(lineas, duracionEscena, maxLineasPorBloque = 2) {
  const bloques = [];
  for (let i = 0; i < lineas.length; i += maxLineasPorBloque) {
    bloques.push(lineas.slice(i, i + maxLineasPorBloque));
  }
  const palabrasPorBloque = bloques.map((b) => b.join(" ").split(" ").length);
  const totalPalabras = palabrasPorBloque.reduce((a, b) => a + b, 0) || 1;
  let acumulado = 0;
  return bloques.map((lineasBloque, idx) => {
    const inicio = (acumulado / totalPalabras) * duracionEscena;
    acumulado += palabrasPorBloque[idx];
    const fin = (acumulado / totalPalabras) * duracionEscena;
    return { lineas: lineasBloque, inicio, fin };
  });
}

// --- el render en sí ---------------------------------------------------------

const CROSSFADE = 0.6; // segundos de transición entre escenas: clásica, no exagerada

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

  // Subtítulo en bloques de máximo 2 líneas, cada uno visible solo durante su
  // ventana de tiempo (sincronizado a la voz), amarillo con borde negro. Cada
  // línea es su propio drawtext para que quede centrada de verdad: la versión
  // de FFmpeg de este contenedor no trae la opción "text_align".
  const lineas = partirEnLineas(escena.texto, 26);
  const bloques = armarBloques(lineas, dur, 2);
  const fontsize = 54;
  const lineHeight = fontsize + 18;
  const yBase = Math.round(ALTO * 0.56); // más al centro vertical, no pegado abajo

  const drawtexts = [];
  bloques.forEach((bloque, bi) => {
    bloque.lineas.forEach((linea, li) => {
      const archivoTexto = path.join(dirTmp, `texto${i}_${bi}_${li}.txt`);
      fs.writeFileSync(archivoTexto, linea);
      const rutaEscapada = archivoTexto.replace(/\\/g, "/").replace(/:/g, "\\:");
      const y = yBase + li * lineHeight;
      drawtexts.push(
        `drawtext=textfile='${rutaEscapada}':fontcolor=yellow:fontsize=${fontsize}:` +
          `borderw=6:bordercolor=black:x=(w-text_w)/2:y=${y}:` +
          `enable='between(t,${bloque.inicio.toFixed(2)},${bloque.fin.toFixed(2)})'`
      );
    });
  });

  await ejecutar("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagen,
    "-filter_complex",
    `[0:v]scale=${ANCHO * 2}:${ALTO * 2}:force_original_aspect_ratio=increase,` +
      `crop=${ANCHO * 2}:${ALTO * 2},${zoompan},${drawtexts.join(",")}[v]`,
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
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

    const sinMusica = path.join(dirTmp, "sin_musica.mp4");
    let duracionTotal;

    if (partes.length === 1) {
      // Una sola escena: no hay nada que fundir entre sí.
      duracionTotal = partes[0].dur;
      await ejecutar("ffmpeg", [
        "-y", "-i", partes[0].clip, "-i", partes[0].audio,
        "-map", "0:v", "-map", "1:a",
        "-c:v", "copy", "-c:a", "aac",
        sinMusica,
      ]);
    } else {
      // Encadena una transición cruzada (fundido clásico) entre cada escena y
      // la siguiente, tanto en video (xfade) como en el audio de voz
      // (acrossfade), para que no se note un corte seco de imagen a imagen.
      const inputs = [];
      partes.forEach((p) => inputs.push("-i", p.clip));
      partes.forEach((p) => inputs.push("-i", p.audio));
      const nEscenas = partes.length;

      let filtro = "";
      let vPrev = "0:v";
      let acumulado = partes[0].dur;
      for (let k = 1; k < nEscenas; k++) {
        const offset = (acumulado - CROSSFADE).toFixed(3);
        const vOut = k === nEscenas - 1 ? "vout" : `v0${k}`;
        filtro += `[${vPrev}][${k}:v]xfade=transition=fade:duration=${CROSSFADE}:offset=${offset}[${vOut}];`;
        vPrev = vOut;
        acumulado = acumulado + partes[k].dur - CROSSFADE;
      }
      duracionTotal = acumulado;

      let aPrev = `${nEscenas}:a`; // los inputs de audio empiezan después de los N de video
      for (let k = 1; k < nEscenas; k++) {
        const aOut = k === nEscenas - 1 ? "aout" : `a0${k}`;
        filtro += `[${aPrev}][${nEscenas + k}:a]acrossfade=d=${CROSSFADE}[${aOut}];`;
        aPrev = aOut;
      }

      // Color cálido suave + viñeta (look "vela/atardecer") y fundido de
      // entrada/salida del video completo.
      const fadeOutInicio = Math.max(0, duracionTotal - 0.8).toFixed(2);
      filtro += `[vout]eq=saturation=1.12:gamma_r=1.03:gamma_b=0.97,vignette=PI/6,fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOutInicio}:d=0.8[vfinal]`;

      await ejecutar("ffmpeg", [
        "-y",
        ...inputs,
        "-filter_complex", filtro,
        "-map", "[vfinal]",
        "-map", "[aout]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        sinMusica,
      ]);
    }

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
      `[1:a]volume=0.32[musicabaja];[0:a][musicabaja]amix=inputs=2:duration=first:dropout_transition=2[audio]`,
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

// --- montaje a partir de clips ya grabados (Google Flow) ---------------------
//
// Es un camino distinto al de /render: alla se parte de imagenes fijas y se les
// inventa movimiento; aca los clips ya vienen con su propio movimiento y
// duracion, y lo unico que hace falta es unirlos, ponerles el audio y quemar
// los subtitulos. Por eso no se reusa armarEscena(): nada de Ken Burns.

async function tieneAudio(archivo) {
  let salida = "";
  await new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      archivo,
    ]);
    proc.stdout.on("data", (d) => (salida += d.toString()));
    proc.on("close", () => resolve());
    proc.on("error", reject);
  });
  return salida.trim().length > 0;
}

// Deja cada clip en el mismo formato (1080x1920, 30fps, con pista de audio
// siempre presente aunque sea muda) y le quema su subtitulo. Sin esto, xfade
// falla apenas un clip viene con otra resolucion o sin audio -y los clips de
// Flow vienen de todo.
async function normalizarClip(dirTmp, i, escena) {
  const entrada = path.join(dirTmp, `clip_in${i}.mp4`);
  const salida = path.join(dirTmp, `clip${i}.mp4`);

  await descargar(escena.videoUrl, entrada);
  const dur = await duracionDe(entrada);
  const conAudio = await tieneAudio(entrada);

  const cadenaVideo = [
    `scale=${ANCHO}:${ALTO}:force_original_aspect_ratio=increase`,
    `crop=${ANCHO}:${ALTO}`,
    "fps=30",
  ];

  if (escena.texto && escena.texto.trim()) {
    const lineas = partirEnLineas(escena.texto, 26);
    const bloques = armarBloques(lineas, dur, 2);
    const fontsize = 54;
    const lineHeight = fontsize + 18;
    const yBase = Math.round(ALTO * 0.56);

    bloques.forEach((bloque, bi) => {
      bloque.lineas.forEach((linea, li) => {
        const archivoTexto = path.join(dirTmp, `txt${i}_${bi}_${li}.txt`);
        fs.writeFileSync(archivoTexto, linea);
        const rutaEscapada = archivoTexto.replace(/\\/g, "/").replace(/:/g, "\\:");
        cadenaVideo.push(
          `drawtext=textfile='${rutaEscapada}':fontcolor=yellow:fontsize=${fontsize}:` +
            `borderw=6:bordercolor=black:x=(w-text_w)/2:y=${yBase + li * lineHeight}:` +
            `enable='between(t,${bloque.inicio.toFixed(2)},${bloque.fin.toFixed(2)})'`
        );
      });
    });
  }

  const args = ["-y", "-i", entrada];
  if (!conAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }
  args.push(
    "-filter_complex", `[0:v]${cadenaVideo.join(",")}[v]`,
    "-map", "[v]",
    "-map", conAudio ? "0:a" : "1:a",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-t", String(dur),
    salida,
  );
  await ejecutar("ffmpeg", args);

  return { clip: salida, dur };
}

async function montarDesdeClips({ escenas, vozUrl, musicaUrl }) {
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "montaje-"));

  const partes = [];
  for (let i = 0; i < escenas.length; i++) {
    partes.push(await normalizarClip(dirTmp, i, escenas[i]));
  }

  // Cuando hay voz en off, el audio propio de los clips estorba (ambiente,
  // respiraciones del modelo): se descarta y manda la narracion.
  const conVoz = Boolean(vozUrl);
  const unido = path.join(dirTmp, "unido.mp4");
  let duracionVideo;

  if (partes.length === 1) {
    duracionVideo = partes[0].dur;
    const fadeOut = Math.max(0, duracionVideo - 0.8).toFixed(2);
    const args = ["-y", "-i", partes[0].clip,
      "-filter_complex",
      `[0:v]eq=saturation=1.12:gamma_r=1.03:gamma_b=0.97,vignette=PI/6,` +
        `fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOut}:d=0.8[vfinal]`,
      "-map", "[vfinal]"];
    if (!conVoz) args.push("-map", "0:a", "-c:a", "aac");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", unido);
    await ejecutar("ffmpeg", args);
  } else {
    const inputs = [];
    partes.forEach((p) => inputs.push("-i", p.clip));
    const n = partes.length;

    let filtro = "";
    let vPrev = "0:v";
    let acumulado = partes[0].dur;
    for (let k = 1; k < n; k++) {
      const offset = (acumulado - CROSSFADE).toFixed(3);
      const vOut = k === n - 1 ? "vout" : `v0${k}`;
      filtro += `[${vPrev}][${k}:v]xfade=transition=fade:duration=${CROSSFADE}:offset=${offset}[${vOut}];`;
      vPrev = vOut;
      acumulado = acumulado + partes[k].dur - CROSSFADE;
    }
    duracionVideo = acumulado;

    if (!conVoz) {
      let aPrev = "0:a";
      for (let k = 1; k < n; k++) {
        const aOut = k === n - 1 ? "aout" : `a0${k}`;
        filtro += `[${aPrev}][${k}:a]acrossfade=d=${CROSSFADE}[${aOut}];`;
        aPrev = aOut;
      }
    }

    const fadeOut = Math.max(0, duracionVideo - 0.8).toFixed(2);
    filtro += `[vout]eq=saturation=1.12:gamma_r=1.03:gamma_b=0.97,vignette=PI/6,` +
      `fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOut}:d=0.8[vfinal]`;

    const args = ["-y", ...inputs, "-filter_complex", filtro, "-map", "[vfinal]"];
    if (!conVoz) args.push("-map", "[aout]", "-c:a", "aac");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", unido);
    await ejecutar("ffmpeg", args);
  }

  let actual = unido;
  let duracionTotal = duracionVideo;

  if (conVoz) {
    const voz = path.join(dirTmp, "voz.mp3");
    await descargar(vozUrl, voz);
    const durVoz = await duracionDe(voz);
    const conVozArchivo = path.join(dirTmp, "con_voz.mp4");

    // Si la narracion dura mas que el video, se congela el ultimo fotograma en
    // vez de cortar la voz a media frase.
    const sobra = durVoz - duracionVideo;
    const filtroVideo = sobra > 0.1
      ? `[0:v]tpad=stop_mode=clone:stop_duration=${sobra.toFixed(2)}[v]`
      : `[0:v]null[v]`;
    duracionTotal = Math.max(duracionVideo, durVoz);

    await ejecutar("ffmpeg", [
      "-y", "-i", unido, "-i", voz,
      "-filter_complex", filtroVideo,
      "-map", "[v]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-t", String(duracionTotal),
      conVozArchivo,
    ]);
    actual = conVozArchivo;
  }

  if (!musicaUrl) return actual;

  const musica = path.join(dirTmp, "musica.mp3");
  await descargar(musicaUrl, musica);
  const final = path.join(dirTmp, "final.mp4");
  await ejecutar("ffmpeg", [
    "-y",
    "-i", actual,
    "-stream_loop", "-1", "-i", musica,
    "-filter_complex",
    `[1:a]volume=0.32[musicabaja];[0:a][musicabaja]amix=inputs=2:duration=first:dropout_transition=2[audio]`,
    "-map", "0:v",
    "-map", "[audio]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-t", String(duracionTotal),
    final,
  ]);
  return final;
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

// Montaje de clips ya grabados (Google Flow): une escenas con transicion, les
// pone la voz en off -o respeta el audio de los propios clips si no hay-, mezcla
// musica de fondo y quema subtitulos.
//
//   {
//     "escenas": [ { "videoUrl": "...", "texto": "subtitulo" }, ... ],
//     "vozUrl": "...",     // opcional: si viene, se ignora el audio de los clips
//     "musicaUrl": "...",  // opcional
//     "supabase": { ... }
//   }
app.post("/montar", async (req, res) => {
  if (!API_KEY || req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "no autorizado" });
  }

  const { escenas, vozUrl, musicaUrl, supabase } = req.body || {};
  if (!Array.isArray(escenas) || escenas.length === 0) {
    return res.status(400).json({ error: "faltan escenas" });
  }
  if (escenas.some((e) => !e || !e.videoUrl)) {
    return res.status(400).json({ error: "cada escena necesita su videoUrl" });
  }
  if (!supabase || !supabase.url || !supabase.bucket || !supabase.path || !supabase.serviceRoleKey) {
    return res.status(400).json({ error: "falta configuración de supabase para subir el resultado" });
  }

  try {
    const archivoFinal = await montarDesdeClips({ escenas, vozUrl, musicaUrl });
    const urlPublica = await subirASupabase(archivoFinal, supabase);
    res.json({ url: urlPublica });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PUERTO, () => console.log(`Render service escuchando en :${PUERTO}`));
