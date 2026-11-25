import { useState, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

/* ---- Sesion ----
   Supabase guarda la sesion y renueva el token solo, asi que el vendedor
   abre el app y ya esta dentro. Encima de eso se le exige entrar de nuevo
   cada 15 dias, y se recuerda su nombre para que solo tenga que poner el
   codigo. */
const DIAS_SESION = 15;

/* El codigo que teclea el usuario son 4 digitos. Supabase Auth exige un
   minimo de 6 caracteres, asi que se le pega este sufijo antes de mandarlo.
   El usuario nunca lo ve ni lo escribe. */
const LARGO_CODIGO = 4;
const SUFIJO = "::rv-marey";
const aPassword = (codigo) => codigo + SUFIJO;
const K_USUARIO = "rv.usuario";
const K_DESDE = "rv.desde";

const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const borrar = (k) => { try { localStorage.removeItem(k); } catch {} };

/* ---- Datos nuevos de la visita ----
   canal: como entro la venta. "visita" es la visita normal al negocio.
   La orden se parte en dos: orden_entregado (lo que el vendedor dejo de su
   camioneta) y orden_pedido (lo que tiene que salir de Marey, con su motivo).
   orden_monto sigue siendo el total. Las visitas viejas no tienen el desglose. */
const K_BORRADOR = "rv.borrador";
const MOTIVOS = { sin_mercancia: "No tenía la mercancía completa", orden_grande: "La orden es muy grande" };
const CANALES = { telefono: "Teléfono", whatsapp: "WhatsApp", email: "Email" };
const TIPOS_ACT = { oficina: "Marey oficina", restock: "Restock de camioneta", entrega: "Entrega", otro: "Otro" };
const esVisita = (v) => !v.canal || v.canal === "visita";
const entregado = (v) => Number(v.orden_entregado || 0);
const pedido = (v) => Number(v.orden_pedido || 0);
const conDesglose = (v) => !!v.hubo_orden && (v.orden_entregado != null || v.orden_pedido != null);

/* ---- Fotos del borrador ----
   Si el vendedor cierra la app a mitad de una visita, el formulario se guarda
   en localStorage y las fotos (que son muy pesadas para eso) en IndexedDB.
   Si el telefono no deja, la visita se recupera igual pero sin las fotos. */
function abrirDBFotos() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("rv-borrador", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("fotos");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function opFotos(modo, fn) {
  const db = await abrirDBFotos();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction("fotos", modo);
      const rq = fn(tx.objectStore("fotos"));
      tx.oncomplete = () => res(rq?.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function guardarFotosBorrador(uid, fotos) {
  try {
    const limpias = fotos.map(({ blob, antes, ahora, tomada_at }) => ({ blob, antes, ahora, tomada_at }));
    await opFotos("readwrite", (s) => s.put(limpias, uid));
  } catch {}
}
async function leerFotosBorrador(uid) {
  try {
    const v = await opFotos("readonly", (s) => s.get(uid));
    return (v || []).map((f) => ({ ...f, url: URL.createObjectURL(f.blob) }));
  } catch { return []; }
}
async function borrarFotosBorrador(uid) {
  try { await opFotos("readwrite", (s) => s.delete(uid)); } catch {}
}

function sesionVencida() {
  const desde = Number(leer(K_DESDE) || 0);
  if (!desde) return false;
  return Date.now() - desde > DIAS_SESION * 86400000;
}

async function salir({ olvidarNombre = false } = {}) {
  borrar(K_DESDE);
  if (olvidarNombre) borrar(K_USUARIO);
  // Cerrar sesion no puede depender de la red: si el servidor no contesta,
  // igual se limpia la sesion local y el usuario sale.
  try { await supabase.auth.signOut({ scope: "local" }); } catch {}
  try { await supabase.auth.signOut(); } catch {}
}

const DOW = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const sumar = (vs) => ({
  ordenado: vs.reduce((a, v) => a + Number(v.orden_monto || 0), 0),
  cobrado: vs.reduce((a, v) => a + Number(v.cobro_monto || 0), 0),
});

const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2 });
const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Puerto_Rico" });

function rango(preset) {
  const t = new Date(hoy() + "T12:00:00");
  const iso = (d) => d.toLocaleDateString("en-CA");
  if (preset === "hoy") return [iso(t), iso(t)];
  if (preset === "semana") {
    const l = new Date(t); l.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    return [iso(l), iso(t)];
  }
  if (preset === "mes") return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(t)];
  return [iso(t), iso(t)];
}

const fold = (s) =>
  [...(s || "")].map((c) => c.normalize("NFD")[0].toLowerCase()).join("");

/* -------- Compresion de fotos antes de subir --------
   Un iPhone tira 3-5 MB por foto. Esto la baja a ~200-400 KB,
   que es lo que hace la diferencia subiendo desde un pueblo con mala senal. */
const MAX_LADO = 1280;
const CALIDAD = 0.7;

function comprimir(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const escala = Math.min(1, MAX_LADO / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * escala);
      c.height = Math.round(img.height * escala);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, c.width, c.height);
      // Sello de fecha y hora quemado en la foto (hora de Puerto Rico)
      const sello = new Date().toLocaleString("es-PR", {
        timeZone: "America/Puerto_Rico", day: "2-digit", month: "2-digit",
        year: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const fs = Math.max(16, Math.round(c.width * 0.035));
      const pad = Math.round(fs * 0.5);
      ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, Arial, sans-serif`;
      ctx.textBaseline = "alphabetic";
      const tw = ctx.measureText(sello).width;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, c.height - fs - pad * 2, tw + pad * 2, fs + pad * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(sello, pad, c.height - pad - Math.round(fs * 0.15));
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("no se pudo comprimir"))),
        "image/jpeg", CALIDAD);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("imagen invalida")); };
    img.src = url;
  });
}

const kb = (n) => (n < 1024 * 1024 ? Math.round(n / 1024) + " KB"
                                   : (n / 1048576).toFixed(1) + " MB");

const MAX_FOTOS = 3;

function IconCamara({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 8.5A1.5 1.5 0 014.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5v-9z" />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}

// Encabezado numerado de cada paso del formulario
function Paso({ n, titulo }) {
  return (
    <div className="flex items-center gap-2 mt-5 mb-1">
      <span className="w-7 h-7 shrink-0 rounded-full bg-slate-900 text-white text-sm font-bold grid place-items-center">
        {n}
      </span>
      <span className="text-sm font-bold uppercase tracking-wide text-slate-500">{titulo}</span>
    </div>
  );
}

function Fotos({ fotos, setFotos }) {
  const [msg, setMsg] = useState("");

  async function anadir(e) {
    const files = [...e.target.files].slice(0, MAX_FOTOS - fotos.length);
    e.target.value = "";
    if (!files.length) return;
    setMsg("Procesando...");
    const nuevas = [];
    for (const f of files) {
      try {
        const blob = await comprimir(f);
        nuevas.push({
          blob, url: URL.createObjectURL(blob),
          antes: f.size, ahora: blob.size,
          tomada_at: new Date().toISOString(),
        });
      } catch (err) { setMsg("Una foto no se pudo procesar."); }
    }
    setFotos([...fotos, ...nuevas]);
    setMsg("");
  }

  function quitar(i) {
    URL.revokeObjectURL(fotos[i].url);
    setFotos(fotos.filter((_, k) => k !== i));
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-lg text-slate-800">Fotos</span>
        <span className="text-xs text-slate-400">obligatoria · al menos 1 · hasta {MAX_FOTOS}</span>
      </div>

      <p className="text-xs text-slate-500 mb-3">
        Toma al menos una foto de la tienda. Cada foto queda con la fecha y hora marcadas.
      </p>

      {fotos.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          {fotos.map((f, i) => (
            <div key={i} className="relative">
              <img src={f.url} alt={`Foto ${i + 1}`}
                className="w-full h-24 object-cover rounded-lg border border-slate-200" />
              <button onClick={() => quitar(i)} aria-label="Quitar foto"
                className="absolute -top-2 -right-2 bg-slate-900 text-white rounded-full w-6 h-6 grid place-items-center">
                <IconX className="w-3 h-3" />
              </button>
              <div className="text-[10px] text-slate-400 mt-1 text-center">
                {kb(f.antes)} a {kb(f.ahora)}
              </div>
            </div>
          ))}
        </div>
      )}

      {fotos.length < MAX_FOTOS && (
        <label className="flex items-center justify-center gap-2 border border-dashed border-slate-300
          rounded-lg py-3 text-slate-600 font-medium cursor-pointer hover:bg-slate-50">
          <IconCamara className="w-5 h-5" />
          {fotos.length ? `Tomar otra (${fotos.length + 1} de ${MAX_FOTOS})` : "Tomar foto"}
          <input type="file" accept="image/*" capture="environment"
            onChange={anadir} className="hidden" />
        </label>
      )}

      {msg && <p className="text-xs text-slate-500 mt-2">{msg}</p>}
      <p className="text-xs text-slate-400 mt-2">
        Se guarda la ubicación de cada foto. Se borran solas a los 120 días.
      </p>
    </div>
  );
}

function Combo({ label, valor, onChange, opciones, placeholder, disabled, vacio }) {
  const [q, setQ] = useState("");
  const [abierto, setAbierto] = useState(false);
  const sel = opciones.find((o) => String(o.id) === String(valor));

  const res = useMemo(() => {
    const toks = fold(q).split(/\s+/).filter(Boolean);
    if (!toks.length) return opciones;
    const out = [];
    for (const o of opciones) {
      const f = fold(o.nombre);
      let peor = 0, ok = true;
      for (const t of toks) {
        const i = f.indexOf(t);
        if (i < 0) { ok = false; break; }
        // 0 = empieza igual, 1 = empieza una palabra, 2 = va por el medio
        const r = i === 0 ? 0 : f[i - 1] === " " ? 1 : 2;
        if (r > peor) peor = r;
      }
      if (ok) out.push({ o, r: peor, i: f.indexOf(toks[0]) });
    }
    out.sort((a, b) => a.r - b.r || a.i - b.i || a.o.nombre.localeCompare(b.o.nombre));
    return out.map((x) => x.o);
  }, [q, opciones]);

  const marcar = (texto) => {
    const t = fold(q).split(/\s+/).filter(Boolean)[0];
    if (!t) return texto;
    const i = fold(texto).indexOf(t);
    if (i < 0) return texto;
    return (
      <>
        {texto.slice(0, i)}
        <mark className="bg-amber-200 text-slate-900 rounded px-0.5">{texto.slice(i, i + t.length)}</mark>
        {texto.slice(i + t.length)}
      </>
    );
  };

  function escoger(o) { onChange(o.id); setQ(""); setAbierto(false); }

  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-2">{label}</label>
      <div className="relative">
        <input
          disabled={disabled}
          value={abierto ? q : sel ? sel.nombre : ""}
          placeholder={disabled ? vacio : placeholder}
          onChange={(e) => { setQ(e.target.value); setAbierto(true); }}
          onFocus={() => { setQ(""); setAbierto(true); }}
          onBlur={() => setTimeout(() => setAbierto(false), 120)}
          className="w-full border border-slate-300 rounded-lg px-4 py-3 bg-white text-lg
            disabled:bg-slate-100 disabled:text-slate-400 disabled:placeholder-slate-400" />

        {sel && !abierto && !disabled && (
          <button onMouseDown={(e) => { e.preventDefault(); onChange(""); setQ(""); }}
            aria-label="Borrar seleccion"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 p-1">
            <IconX className="w-4 h-4" />
          </button>
        )}

        {abierto && !disabled && (
          <div className="absolute z-30 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
            {res.length === 0 && (
              <div className="px-4 py-3 text-slate-500 text-sm">
                Nada con "{q.trim()}". Prueba con menos letras.
              </div>
            )}
            {res.slice(0, 60).map((o) => (
              <button key={o.id} onMouseDown={(e) => { e.preventDefault(); escoger(o); }}
                className="w-full text-left px-4 py-3 hover:bg-slate-50 border-b border-slate-100 last:border-0">
                <div className="text-slate-900">{marcar(o.nombre)}</div>
                {o.sub && <div className="text-xs text-slate-500 mt-0.5">{o.sub}</div>}
              </button>
            ))}
            {res.length > 60 && (
              <div className="px-4 py-2 text-xs text-slate-400 bg-slate-50">
                {res.length - 60} mas. Sigue escribiendo para filtrar.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function IconCheck({ className }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

function IconX({ className }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

function IconChevron({ className }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7 4l7 6-7 6" />
    </svg>
  );
}

/* ---------------------------------------------------------- LOGIN */
function Login({ motivo }) {
  const [gente, setGente] = useState([]);
  const [quien, setQuien] = useState(leer(K_USUARIO) || "");
  const [cambiando, setCambiando] = useState(false);
  const [codigo, setCodigo] = useState("");
  const [err, setErr] = useState("");
  const [aviso, setAviso] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.rpc("usuarios_activos").then(({ data }) => setGente(data || []));
  }, []);

  async function entrar() {
    if (!quien) return setErr("Escoge tu nombre.");
    if (codigo.length !== LARGO_CODIGO) return setErr(`El código tiene ${LARGO_CODIGO} dígitos.`);
    setBusy(true); setErr(""); setAviso("");

    const { data: email } = await supabase.rpc("email_de", { p_nombre: quien });
    if (!email) { setBusy(false); return setErr("Usuario no encontrado."); }

    const { error } = await supabase.auth.signInWithPassword({ email, password: aPassword(codigo) });
    setBusy(false);
    if (error) { setCodigo(""); return setErr("Código incorrecto."); }
    guardar(K_USUARIO, quien);
    guardar(K_DESDE, String(Date.now()));
  }

  async function restablecer() {
    if (!quien) return setErr("Escoge tu nombre primero.");
    setBusy(true); setErr("");
    const { data: email } = await supabase.rpc("email_de", { p_nombre: quien });
    if (!email) { setBusy(false); return setErr("Usuario no encontrado."); }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    setBusy(false);
    if (error) return setErr("No se pudo enviar el correo.");
    const [u, dom] = email.split("@");
    setAviso(`Te mandamos un enlace a ${u.slice(0, 2)}***@${dom}. Ábrelo y pon tu código nuevo.`);
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-7">

        {/* PANTALLA 1: escoger el nombre */}
        {(!quien || cambiando) && (
          <>
            <h1 className="text-xl font-bold text-slate-900">Registro de visitas</h1>
            <p className="text-slate-500 mt-1 mb-5 text-sm">¿Quién eres?</p>

            {motivo && (
              <div className="bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-sm text-amber-900 mb-4">
                {motivo}
              </div>
            )}

            <div className="space-y-2">
              {gente.map((g) => (
                <button key={g.nombre}
                  onClick={() => { setQuien(g.nombre); setCambiando(false); setCodigo(""); setErr(""); setAviso(""); }}
                  className="w-full text-left rounded-lg border border-slate-300 bg-white text-slate-800 px-4 py-3.5 font-semibold active:bg-slate-100">
                  {g.nombre}
                </button>
              ))}
              {gente.length === 0 && <p className="text-sm text-slate-400">Cargando usuarios...</p>}
            </div>
            <p className="text-[10px] text-slate-300 text-center mt-5">v3.7</p>
          </>
        )}

        {/* PANTALLA 2: poner el código */}
        {quien && !cambiando && (
          <>
            <button onClick={() => { setCambiando(true); setQuien(""); setCodigo(""); setErr(""); setAviso(""); }}
              className="text-sm text-slate-500 mb-5 flex items-center gap-1">
              <span className="text-lg leading-none">&#8249;</span> Volver
            </button>

            <h1 className="text-2xl font-bold text-slate-900">Hola, {quien}</h1>
            <p className="text-slate-500 mt-1 mb-6 text-sm">Pon tu código para entrar.</p>

            {motivo && (
              <div className="bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-sm text-amber-900 mb-4">
                {motivo}
              </div>
            )}

            <input type="password" inputMode="numeric" autoComplete="current-password"
              autoFocus maxLength={LARGO_CODIGO} placeholder="Código"
              className="w-full border border-slate-300 rounded-lg px-4 py-4 text-2xl tracking-[0.5em] text-center mb-4"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && entrar()} />

            <button onClick={entrar} disabled={busy}
              className="w-full bg-slate-900 text-white rounded-lg py-3.5 font-semibold disabled:opacity-50">
              {busy ? "Entrando..." : "Entrar"}
            </button>

            <button onClick={restablecer} disabled={busy}
              className="w-full text-sm text-slate-500 underline mt-4">
              Olvidé mi código
            </button>
          </>
        )}

        {err && <p className="text-red-600 text-sm mt-3">{err}</p>}
        {aviso && <p className="text-emerald-700 text-sm mt-3">{aviso}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------- CODIGO NUEVO */
// Se muestra cuando el usuario abre el enlace del correo de restablecer.
function CodigoNuevo({ onListo }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function guardar() {
    if (a.length !== LARGO_CODIGO) return setErr(`El código debe tener ${LARGO_CODIGO} dígitos.`);
    if (a !== b) return setErr("Los dos códigos no son iguales.");
    setBusy(true); setErr("");
    const { error } = await supabase.auth.updateUser({ password: aPassword(a) });
    setBusy(false);
    if (error) return setErr("No se pudo guardar: " + error.message);
    onListo();
  }

  const campo = "w-full border border-slate-300 rounded-lg px-4 py-3 text-lg tracking-widest text-center mb-3";

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-7">
        <h1 className="text-xl font-bold text-slate-900">Pon tu código nuevo</h1>
        <p className="text-slate-500 mt-1 mb-5 text-sm">Cuatro dígitos. Es el que vas a usar para entrar.</p>
        <input type="password" inputMode="numeric" maxLength={LARGO_CODIGO} placeholder="Código nuevo"
          className={campo} value={a} onChange={(e) => setA(e.target.value.replace(/\D/g, ""))} />
        <input type="password" inputMode="numeric" maxLength={LARGO_CODIGO} placeholder="Repítelo"
          className={campo} value={b} onChange={(e) => setB(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && guardar()} />
        {err && <p className="text-red-600 text-sm mb-3">{err}</p>}
        <button onClick={guardar} disabled={busy}
          className="w-full bg-slate-900 text-white rounded-lg py-3 font-semibold disabled:opacity-50">
          {busy ? "Guardando..." : "Guardar código"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------- NUEVA VISITA */
const VACIO = { canal: "telefono", pueblo_id: "", cliente_id: "", estado_cuenta_ok: false, creditos_ok: false,
  gondola_ok: false, hubo_orden: null, orden_entregado: "", orden_pedido: "", pedido_motivo: "",
  hubo_cobro: null, cobro_monto: "", notas: "" };

function Reloj({ desde }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [desde]);
  const s = desde ? Math.floor((Date.now() - desde) / 1000) : 0;
  return <span className="tabular-nums">{String(Math.floor(s / 60)).padStart(2, "0")}:{String(s % 60).padStart(2, "0")}</span>;
}

// Check y SiNo viven FUERA de NuevaVisita a proposito: si se definen adentro,
// React los recrea con cada tecla y el input pierde el foco (el teclado del
// celular se cierra al escribir el monto).
function Check({ titulo, ok, onToggle }) {
  return (
    <button onClick={onToggle}
      className={`w-full flex items-center gap-3 rounded-xl border p-4 text-left transition-colors
        ${ok ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-white"}`}>
      <span className={`w-8 h-8 shrink-0 rounded-lg grid place-items-center
        ${ok ? "bg-emerald-600 text-white" : "bg-slate-100 border border-slate-300"}`}>
        {ok && <IconCheck className="w-5 h-5" />}
      </span>
      <span className={`font-semibold text-lg ${ok ? "text-emerald-900" : "text-slate-700"}`}>{titulo}</span>
      <span className="ml-auto text-xs text-slate-400 font-medium">requerido</span>
    </button>
  );
}

// El monto vive en estado LOCAL del campo: teclear no repinta el formulario
// completo, asi el teclado del celular jamas pierde el foco. El valor sube
// al formulario en cada cambio, pero el input se controla a si mismo.
function CampoMonto({ inicial, onCambio, ph }) {
  const [v, setV] = useState(inicial ?? "");
  return (
    <input type="text" inputMode="decimal" autoComplete="off"
      className="w-full mt-3 border border-slate-300 rounded-lg px-3 py-3 text-lg bg-white"
      placeholder={ph} value={v}
      onChange={(e) => {
        const limpio = e.target.value.replace(/[^0-9.]/g, "");
        setV(limpio);
        onCambio(limpio);
      }} />
  );
}

function SiNo({ titulo, valor, montoValor, onSi, onNo, onMonto, on, btn, ph }) {
  const v = valor;
  return (
    <div className={`rounded-xl border p-4 ${v === true ? on : v === false ? "border-slate-300 bg-slate-50" : "border-slate-200 bg-white"}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-lg text-slate-800">{titulo}</span>
        <div className="flex gap-2 shrink-0">
          <button onClick={onSi}
            className={`px-5 py-2 rounded-lg font-bold ${v === true ? btn : "bg-slate-100 text-slate-500"}`}>Sí</button>
          <button onClick={onNo}
            className={`px-5 py-2 rounded-lg font-bold ${v === false ? "bg-slate-700 text-white" : "bg-slate-100 text-slate-500"}`}>No</button>
        </div>
      </div>
      {v === true && (
        <CampoMonto inicial={montoValor} onCambio={onMonto} ph={ph} />
      )}
    </div>
  );
}

/* ---------------------------------------------- RESUMEN DE HOY (Inicio) */
function HoyResumen({ user, tick }) {
  const [vs, setVs] = useState(null);
  const [acts, setActs] = useState([]);
  useEffect(() => {
    supabase.from("v_visitas")
      .select("id,cliente,pueblo,segundos,hubo_orden,orden_monto,hubo_cobro,cobro_monto,created_at,canal,orden_entregado,orden_pedido,pedido_motivo")
      .eq("fecha", hoy()).eq("vendedor_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setVs(data || []));
    supabase.from("v_actividades").select("id,tipo,notas,created_at")
      .eq("fecha", hoy()).eq("vendedor_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setActs(data || []));
  }, [user.id, tick]);

  if (vs === null) return <p className="text-sm text-slate-400 text-center">Cargando el día…</p>;
  const t = sumar(vs);
  const vis = vs.filter(esVisita);
  const nOrden = vis.filter((v) => v.hubo_orden).length;
  const nCobro = vis.filter((v) => !v.hubo_orden && v.hubo_cobro).length;
  const nSolo = vis.length - nOrden - nCobro;
  const hora = (iso) => new Date(iso).toLocaleTimeString("es-PR",
    { hour: "numeric", minute: "2-digit", timeZone: "America/Puerto_Rico" });
  const lbl = "text-xs font-semibold text-slate-600 uppercase tracking-wider";

  return (
    <>
      <div className={lbl}>Hoy</div>
      <div className="grid grid-cols-3 gap-2">
        {[[vis.length, "Visitas"], [money(t.ordenado), "Ordenado"], [money(t.cobrado), "Cobrado"]].map(([v, l]) => (
          <div key={l} className="bg-white rounded-xl border border-slate-200 p-3 min-w-0">
            <div className="text-lg font-bold text-slate-900 truncate" style={{ fontFamily: "var(--font-display)" }}>{v}</div>
            <div className="text-xs text-slate-500">{l}</div>
          </div>
        ))}
      </div>

      {vis.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="font-bold text-slate-900">
            {vis.length} {vis.length === 1 ? "visita" : "visitas"}: {nOrden + nCobro} con resultado, {nSolo} solo visita
          </div>
          <Barra partes={[[nOrden, "#7c3aed"], [nCobro, "#2563eb"], [nSolo, "#cbd5e1"]]} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
            <span>{nOrden} con orden</span><span>{nCobro} solo cobro</span><span>{nSolo} solo visita</span>
          </div>
        </div>
      )}

      <div className={lbl}>Registrado hoy</div>
      {vs.length === 0 && acts.length === 0 ? (
        <p className="text-sm text-slate-500 bg-white rounded-xl border border-slate-200 p-4 text-center">
          Todavía no hay nada registrado hoy.
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {vs.map((v) => (
            <div key={v.id} className="px-4 py-3 flex justify-between items-center gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-slate-900 truncate">{v.cliente}</div>
                <div className="text-sm text-slate-500">
                  {v.pueblo} · {hora(v.created_at)}
                  {esVisita(v)
                    ? (v.segundos != null && ` · ${Math.max(1, Math.round(v.segundos / 60))} min`)
                    : ` · venta por ${(CANALES[v.canal] || v.canal).toLowerCase()}`}
                </div>
                {conDesglose(v) && (
                  <div className="text-xs text-slate-500 mt-0.5">
                    {entregado(v) > 0 && `${money(entregado(v))} entregado`}
                    {entregado(v) > 0 && pedido(v) > 0 && " · "}
                    {pedido(v) > 0 && `${money(pedido(v))} pedido a Marey`}
                  </div>
                )}
              </div>
              <div className="shrink-0 flex flex-col items-end gap-1">
                {v.hubo_orden && <span className="bg-violet-100 text-violet-800 text-xs font-bold px-2 py-0.5 rounded-full">Orden</span>}
                {v.hubo_cobro && <span className="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-0.5 rounded-full">Cobro</span>}
                {!v.hubo_orden && !v.hubo_cobro && <span className="bg-slate-100 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full">Solo visita</span>}
              </div>
            </div>
          ))}
          {acts.map((a) => (
            <div key={a.id} className="px-4 py-3 flex justify-between items-center gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-slate-900 truncate">{TIPOS_ACT[a.tipo] || a.tipo}</div>
                <div className="text-sm text-slate-500 truncate">{hora(a.created_at)}{a.notas ? ` · ${a.notas}` : ""}</div>
              </div>
              <span className="shrink-0 bg-slate-100 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full">Actividad</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------- ICONOS DE LAS TABS */
function IconTab({ k }) {
  const p = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
  if (k === "nueva") return <svg {...p}><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>;
  if (k === "visitas") return <svg {...p}><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" /><circle cx="12" cy="10" r="2.5" /></svg>;
  if (k === "stats") return <svg {...p}><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></svg>;
  if (k === "gastos") return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></svg>;
  return <svg {...p}><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>;
}

// La orden partida en dos: lo que el vendedor entrego de su camioneta (factura)
// y el pedido que tiene que salir de Marey. Vive FUERA del formulario por la
// misma razon que Check y SiNo: para que el teclado no pierda el foco.
function OrdenBloque({ f, setF, simple }) {
  const v = f.hubo_orden;
  const total = (Number(f.orden_entregado) || 0) + (Number(f.orden_pedido) || 0);
  const set = (k, val) => setF((p) => ({ ...p, [k]: val }));
  return (
    <div className={`rounded-xl border p-4 ${v === true ? "border-violet-300 bg-violet-50" : v === false ? "border-slate-300 bg-slate-50" : "border-slate-200 bg-white"}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-lg text-slate-800">Generó orden</span>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => set("hubo_orden", true)}
            className={`px-5 py-2 rounded-lg font-bold ${v === true ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-500"}`}>Sí</button>
          <button onClick={() => setF((p) => ({ ...p, hubo_orden: false, orden_entregado: "", orden_pedido: "", pedido_motivo: "" }))}
            className={`px-5 py-2 rounded-lg font-bold ${v === false ? "bg-slate-700 text-white" : "bg-slate-100 text-slate-500"}`}>No</button>
        </div>
      </div>
      {v === true && simple && (
        <div className="mt-4">
          <div className="font-semibold text-slate-800">Monto de la orden</div>
          <p className="text-sm text-slate-500">Lo que ordenó el cliente.</p>
          <CampoMonto inicial={f.orden_entregado} onCambio={(x) => set("orden_entregado", x)} ph="Monto de la orden" />
        </div>
      )}
      {v === true && !simple && (
        <div className="mt-4 space-y-4">
          <div>
            <div className="font-semibold text-slate-800">Entregué de mi camioneta</div>
            <p className="text-sm text-slate-500">Lo que facturaste y dejaste hoy. Déjalo vacío si no entregaste nada.</p>
            <CampoMonto inicial={f.orden_entregado} onCambio={(x) => set("orden_entregado", x)} ph="Monto entregado" />
          </div>
          <div>
            <div className="font-semibold text-slate-800">Pedido para que salga de Marey</div>
            <p className="text-sm text-slate-500">Lo que no tenías. Marey decide cómo lo envía. Déjalo vacío si no hubo.</p>
            <CampoMonto inicial={f.orden_pedido} onCambio={(x) => setF((p) => ({ ...p, orden_pedido: x, pedido_motivo: Number(x) ? p.pedido_motivo : "" }))} ph="Monto del pedido" />
          </div>
          {Number(f.orden_pedido) > 0 && (
            <div>
              <div className="font-semibold text-slate-800 mb-2">¿Por qué va por Marey?</div>
              <div className="space-y-2">
                {Object.entries(MOTIVOS).map(([k, l]) => (
                  <button key={k} onClick={() => set("pedido_motivo", k)}
                    className={`w-full rounded-lg py-3 px-3 font-semibold border ${f.pedido_motivo === k ? "bg-violet-600 border-violet-600 text-white" : "bg-white border-slate-300 text-slate-700"}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          )}
          {total > 0 && <div className="font-semibold text-slate-900">Total de la orden: {money(total)}</div>}
        </div>
      )}
    </div>
  );
}

// Las mismas reglas de orden y cobro para la visita y para la venta sin visita
function faltaOrdenCobro(f, simple) {
  if (f.hubo_orden === null) return "Contesta si generó orden.";
  if (simple) {
    if (f.hubo_orden && !Number(f.orden_entregado)) return "Pon el monto de la orden.";
  } else {
    if (f.hubo_orden && !Number(f.orden_entregado) && !Number(f.orden_pedido)) return "Pon el monto de la orden.";
    if (f.hubo_orden && Number(f.orden_pedido) > 0 && !f.pedido_motivo) return "Di por qué va por Marey.";
  }
  if (f.hubo_cobro === null) return "Contesta si hizo cobro.";
  if (f.hubo_cobro && !Number(f.cobro_monto)) return "Pon el monto cobrado.";
  return null;
}

function NuevaVisita({ user, clientes, pueblos, onGuardado, onActiva, tick }) {
  const kBorrador = `${K_BORRADOR}.${user.id}`;
  const [f, setF] = useState(VACIO);
  // modo: null (inicio) | "visita" | "venta" (sin visita) | "actividad"
  const [modo, setModo] = useState(null);
  const activa = modo !== null;
  // Avisa al App si hay algo en curso para esconder las tabs de abajo
  useEffect(() => { onActiva?.(activa); }, [activa]);
  const [inicio, setInicio] = useState(null);
  const [fotos, setFotosRaw] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [act, setAct] = useState({ tipo: "", notas: "" });
  // Borrador: lo que el vendedor llevaba si cerro la app a mitad
  const [borrador, setBorrador] = useState(() => {
    try { const b = JSON.parse(leer(kBorrador) || "null"); return b && b.modo && b.f ? b : null; } catch { return null; }
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setFotos = (lista) => { setFotosRaw(lista); guardarFotosBorrador(user.id, lista); };

  // Cada cambio del formulario se guarda en el telefono
  useEffect(() => {
    if (modo === "visita" || modo === "venta") guardar(kBorrador, JSON.stringify({ modo, f, inicio }));
  }, [modo, f, inicio]);

  const limpiarBorrador = () => { borrar(kBorrador); borrarFotosBorrador(user.id); setBorrador(null); };
  const comenzar = (m) => {
    limpiarBorrador();
    setF(VACIO); setFotosRaw([]); setAct({ tipo: "", notas: "" });
    setInicio(m === "visita" ? Date.now() : null); setModo(m); setMsg("");
  };
  const continuar = async () => {
    const b = borrador;
    const fs = b.modo === "visita" ? await leerFotosBorrador(user.id) : [];
    setF({ ...VACIO, ...b.f }); setInicio(b.inicio || Date.now()); setFotosRaw(fs);
    setBorrador(null); setModo(b.modo); setMsg("");
  };
  const cancelar = () => { limpiarBorrador(); setModo(null); setInicio(null); setF(VACIO); setFotosRaw([]); };

  const cliSel = clientes.find((c) => c.id === f.cliente_id);

  const negocios = useMemo(
    () => clientes.map((c) => ({ id: c.id, nombre: c.nombre, sub: c.pueblos?.nombre })),
    [clientes]);

  const falta = modo === "venta"
    ? (!f.cliente_id ? "Escoge el negocio."
      : faltaOrdenCobro(f, true) || (!f.hubo_orden && !f.hubo_cobro ? "Tiene que haber orden o cobro." : null))
    : (!f.cliente_id ? "Escoge el negocio."
      : !f.pueblo_id ? "Escoge el pueblo."
      : !f.estado_cuenta_ok ? "Marca que verificaste el estado de cuenta."
      : !f.creditos_ok ? "Marca que verificaste los créditos."
      : !f.gondola_ok ? "Marca que verificaste la góndola."
      : faltaOrdenCobro(f) || (fotos.length === 0 ? "Toma al menos una foto de la tienda." : null));

  async function guardarRegistro() {
    if (busy) return; // guarda extra: ignora un segundo click mientras ya esta guardando
    if (falta) return setMsg(falta);
    setBusy(true); setMsg("");
    const esVenta = modo === "venta";
    const segs = esVenta ? null : Math.round((Date.now() - inicio) / 1000);
    // En una venta remota (teléfono/WhatsApp/email) no hay despacho de camioneta:
    // solo se guarda el monto de la orden, sin entregado/pedido/motivo.
    const ent = f.hubo_orden && !esVenta ? Number(f.orden_entregado) || 0 : null;
    const ped = f.hubo_orden && !esVenta ? Number(f.orden_pedido) || 0 : null;
    const montoOrden = f.hubo_orden
      ? (esVenta ? Number(f.orden_entregado) || 0 : ent + ped)
      : null;
    const { data, error } = await supabase.from("visitas").insert({
      vendedor_id: user.id,
      cliente_id: f.cliente_id,
      pueblo_id: Number(esVenta ? cliSel.pueblo_id : f.pueblo_id),
      canal: esVenta ? f.canal : "visita",
      estado_cuenta_ok: !esVenta, creditos_ok: !esVenta, gondola_ok: !esVenta,
      hubo_orden: f.hubo_orden,
      orden_monto: montoOrden,
      orden_entregado: ent,
      orden_pedido: ped,
      pedido_motivo: !esVenta && f.hubo_orden && ped > 0 ? f.pedido_motivo : null,
      hubo_cobro: f.hubo_cobro,
      cobro_monto: f.hubo_cobro ? Number(f.cobro_monto) : null,
      segundos: segs,
      notas: f.notas || null,
    }).select("id").single();

    if (error) {
      setBusy(false);
      // El candado de la base de datos bloquea visitas repetidas (mismo
      // cliente, mismos datos, menos de 5 min) - le mostramos al vendedor
      // un mensaje corto y claro en vez del texto tecnico de Postgres.
      if (error.message?.includes("parece igual a una que ya registraste")) {
        return setMsg("Ya registraste esto hace un momento. No se guardó de nuevo.");
      }
      return setMsg("No se guardó: " + error.message);
    }

    // Ya esta guardada. Sacamos al vendedor de esta pantalla YA MISMO para
    // que el boton "Guardar" no siga visible mientras las fotos terminan de
    // subir en segundo plano (eso evitaba el duplicado por doble tap).
    const fotosLocal = fotos;
    const idVisita = data.id;
    const hecho = esVenta ? "Venta guardada." : `Visita guardada en ${Math.floor(segs / 60)}m ${segs % 60}s.`;
    limpiarBorrador();
    setF(VACIO); setFotosRaw([]); setModo(null); setInicio(null); setBusy(false);
    setMsg(fotosLocal.length ? `${hecho} Subiendo fotos...` : hecho);
    onGuardado();

    // subir fotos (si falla alguna, la visita ya quedo guardada)
    for (let i = 0; i < fotosLocal.length; i++) {
      const path = `${idVisita}/${Date.now()}-${i}.jpg`;
      const { error: eUp } = await supabase.storage
        .from("visitas").upload(path, fotosLocal[i].blob, { contentType: "image/jpeg" });
      if (eUp) { console.warn("foto no subió", eUp.message); continue; }
      await supabase.from("visita_fotos").insert({
        visita_id: idVisita, path,
        tomada_at: fotosLocal[i].tomada_at,
      });
    }

    supabase.functions.invoke("visita-email", { body: { visita_id: idVisita } })
      .catch((e) => console.warn("email no salió", e));

    setMsg(`${hecho} Te llegó la confirmación por email.`);
    setTimeout(() => setMsg(""), 4000);
  }

  async function guardarActividad() {
    if (busy || !act.tipo) return;
    setBusy(true); setMsg("");
    const { error } = await supabase.from("actividades").insert({
      vendedor_id: user.id, tipo: act.tipo, notas: act.notas || null,
    });
    setBusy(false);
    if (error) return setMsg("No se guardó: " + error.message);
    setModo(null); setAct({ tipo: "", notas: "" });
    setMsg("Actividad guardada.");
    onGuardado();
    setTimeout(() => setMsg(""), 4000);
  }

  const botonGrande = "w-full text-left rounded-2xl border-2 border-accent px-5 py-4";

  if (!activa)
    return (
      <div className="space-y-4">
        {borrador && (
          <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4">
            <div className="font-bold text-slate-900">
              {borrador.modo === "venta" ? "Tenías una venta sin terminar" : "Tenías una visita sin terminar"}
            </div>
            <p className="text-sm text-slate-700">
              {clientes.find((c) => c.id === borrador.f.cliente_id)?.nombre || "Sin negocio escogido"}. Se guardó lo que llevabas.
            </p>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button onClick={continuar} className="bg-accent text-white rounded-xl py-3 font-bold">Continuar</button>
              <button onClick={limpiarBorrador} className="bg-white border border-slate-300 text-slate-700 rounded-xl py-3 font-semibold">Descartar</button>
            </div>
          </div>
        )}

        <div className="text-xs font-semibold text-slate-600 uppercase tracking-wider">¿Qué vas a registrar?</div>
        <div className="space-y-3">
          <button onClick={() => comenzar("visita")} className={`${botonGrande} bg-accent text-white`}>
            <span className="block text-xl font-bold leading-tight">Comenzar visita</span>
            <span className="block text-sm opacity-90">Estoy en el negocio. Empieza a contar el tiempo.</span>
          </button>
          <button onClick={() => comenzar("venta")} className={`${botonGrande} bg-white text-accent`}>
            <span className="block text-xl font-bold leading-tight">Venta por teléfono o WhatsApp</span>
            <span className="block text-sm text-slate-500">El cliente ordenó o pagó sin que lo visitara.</span>
          </button>
          <button onClick={() => comenzar("actividad")} className={`${botonGrande} bg-white text-accent`}>
            <span className="block text-xl font-bold leading-tight">Otra actividad</span>
            <span className="block text-sm text-slate-500">Oficina, restock de camioneta, entrega.</span>
          </button>
        </div>
        {msg && <p className={`text-sm font-medium text-center ${msg.includes("guardada") ? "text-emerald-700" : "text-red-600"}`}>{msg}</p>}
        <HoyResumen user={user} tick={tick} />
      </div>
    );

  const barraGuardar = (texto, onClick, apagado) => (
    <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-slate-200">
      <div className="max-w-2xl mx-auto">
        <button onClick={onClick} disabled={busy || apagado}
          className="w-full rounded-xl py-4 font-bold text-lg bg-accent text-white disabled:bg-slate-300 disabled:text-slate-500">
          {busy ? "Guardando…" : texto}
        </button>
      </div>
    </div>
  );
  const opcion = (activo) => `rounded-lg py-3 px-2 font-semibold border ${activo ? "bg-accent border-accent text-white" : "bg-white border-slate-300 text-slate-700"}`;
  const error = msg && <p className="text-sm font-medium text-red-600">{msg}</p>;

  if (modo === "actividad")
    return (
      <div className="space-y-3 pb-28">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-slate-900">Otra actividad</h2>
          <button onClick={() => { setModo(null); setMsg(""); }} className="text-xs text-slate-400 underline">cancelar</button>
        </div>
        <p className="text-sm text-slate-500">Para lo que no es una visita ni una venta.</p>
        <Paso n={1} titulo="Qué fue" />
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(TIPOS_ACT).map(([k, l]) => (
            <button key={k} onClick={() => setAct((p) => ({ ...p, tipo: k }))} className={opcion(act.tipo === k)}>{l}</button>
          ))}
        </div>
        <textarea rows={3} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
          placeholder="Qué se hizo (opcional)" value={act.notas} onChange={(e) => setAct((p) => ({ ...p, notas: e.target.value }))} />
        {error}
        {barraGuardar(act.tipo ? "Guardar actividad" : "Escoge qué fue", guardarActividad, !act.tipo)}
      </div>
    );

  if (modo === "venta")
    return (
      <div className="space-y-3 pb-28">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-slate-900">Venta sin visita</h2>
          <button onClick={cancelar} className="text-xs text-slate-400 underline">cancelar</button>
        </div>

        <Paso n={1} titulo="Cómo fue" />
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(CANALES).map(([k, l]) => (
            <button key={k} onClick={() => set("canal", k)} className={opcion(f.canal === k)}>{l}</button>
          ))}
        </div>

        <Paso n={2} titulo="Negocio" />
        <Combo label="Negocio" valor={f.cliente_id}
          placeholder={`Escribe el nombre — ${negocios.length} negocios`}
          opciones={negocios}
          onChange={(v) => set("cliente_id", v)} />

        <Paso n={3} titulo="Orden" />
        <OrdenBloque f={f} setF={setF} simple />

        <Paso n={4} titulo="Cobro" />
        <SiNo titulo="Hizo cobro" valor={f.hubo_cobro} montoValor={f.cobro_monto}
          onSi={() => set("hubo_cobro", true)} onNo={() => set("hubo_cobro", false)}
          onMonto={(v) => set("cobro_monto", v)} ph="Monto cobrado"
          on="border-blue-300 bg-blue-50" btn="bg-blue-600 text-white" />

        <textarea rows={2} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
          placeholder="Notas (opcional)" value={f.notas} onChange={(e) => set("notas", e.target.value)} />

        {error}
        {barraGuardar(falta || "Guardar venta", guardarRegistro, !!falta)}
      </div>
    );

  return (
    <div className="space-y-3 pb-28">
      <div className="flex items-center justify-between bg-white rounded-xl border border-slate-200 px-4 py-2.5">
        <span className="text-sm text-slate-500">Tiempo en esta visita</span>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-slate-900"><Reloj desde={inicio} /></span>
          <button onClick={cancelar} className="text-xs text-slate-400 underline">cancelar</button>
        </div>
      </div>

      <Paso n={1} titulo="Negocio" />
      <Combo label="Negocio" valor={f.cliente_id}
        placeholder={`Escribe el nombre — ${negocios.length} negocios`}
        opciones={negocios}
        onChange={(v) => {
          const c = clientes.find((x) => x.id === v);
          setF((p) => ({ ...p, cliente_id: v, pueblo_id: c ? String(c.pueblo_id) : p.pueblo_id }));
        }} />

      <Paso n={2} titulo="Pueblo de la visita" />
      <Combo label="Pueblo de la visita" valor={f.pueblo_id}
        placeholder="Escribe o escoge el pueblo"
        opciones={pueblos}
        onChange={(v) => set("pueblo_id", v)} />

      {cliSel && f.pueblo_id && String(f.pueblo_id) !== String(cliSel.pueblo_id) && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 text-sm text-amber-900">
          En el sistema {cliSel.nombre} está en <b>{cliSel.pueblos?.nombre}</b>. Se va a guardar
          como <b>{pueblos.find((p) => String(p.id) === String(f.pueblo_id))?.nombre}</b> y
          se le avisa a Alejandro para corregirlo.
        </div>
      )}

      <Paso n={3} titulo="Verificaciones" />
      <Check titulo="Se Verifico Estado De Cuenta" ok={f.estado_cuenta_ok} onToggle={() => set("estado_cuenta_ok", !f.estado_cuenta_ok)} />
      <Check titulo="Se Verifico Creditos" ok={f.creditos_ok} onToggle={() => set("creditos_ok", !f.creditos_ok)} />
      <Check titulo="Se Verifico Gondola" ok={f.gondola_ok} onToggle={() => set("gondola_ok", !f.gondola_ok)} />

      <Paso n={4} titulo="Orden" />
      <OrdenBloque f={f} setF={setF} />

      <Paso n={5} titulo="Cobro" />
      <SiNo titulo="Hizo cobro" valor={f.hubo_cobro} montoValor={f.cobro_monto}
        onSi={() => set("hubo_cobro", true)} onNo={() => set("hubo_cobro", false)}
        onMonto={(v) => set("cobro_monto", v)} ph="Monto cobrado"
        on="border-blue-300 bg-blue-50" btn="bg-blue-600 text-white" />

      <Paso n={6} titulo="Fotos" />
      <Fotos fotos={fotos} setFotos={setFotos} />

      <textarea rows={2} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
        placeholder="Notas (opcional)" value={f.notas} onChange={(e) => set("notas", e.target.value)} />

      {error}
      {barraGuardar(falta || "Guardar visita", guardarRegistro, !!falta)}
    </div>
  );
}

/* --------------------------------------------------- FILTROS */
function Filtros({ preset, setPreset, desde, hasta, setDesde, setHasta }) {
  function aplicar(p) {
    setPreset(p);
    if (p !== "custom") { const [d, h] = rango(p); setDesde(d); setHasta(h); }
  }
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 mb-4">
      <div className="flex gap-2 flex-wrap">
        {[["hoy", "Hoy"], ["semana", "Semana"], ["mes", "Mes"], ["custom", "Rango"]].map(([k, l]) => (
          <button key={k} onClick={() => aplicar(k)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${preset === k ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}>
            {l}
          </button>
        ))}
      </div>
      {preset === "custom" && (
        <div className="flex gap-2 mt-3">
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)}
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)}
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------- ESTADÍSTICAS */
function Barra({ partes }) {
  const vivas = partes.filter(([n]) => n > 0);
  if (!vivas.length) return null;
  return (
    <div className="flex h-3 rounded-md overflow-hidden gap-0.5 my-3 bg-slate-100">
      {vivas.map(([n, color], i) => <span key={i} style={{ flex: n, background: color }} />)}
    </div>
  );
}

// Tarjeta de una seccion del resumen: titulo + una oracion que explica que es
function Seccion({ titulo, explica, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <h3 className="text-lg font-bold text-slate-900 leading-tight">{titulo}</h3>
      <p className="text-sm text-slate-500 mt-0.5">{explica}</p>
      {children}
    </div>
  );
}

// Fila que se abre y ensena los negocios que hay detras del numero
function FilaStat({ color, titulo, sub, num, numSub, lista, monto, abierta, onToggle }) {
  return (
    <div className="border-t border-slate-100 first:border-0">
      <button onClick={onToggle} className="w-full flex items-center gap-3 py-3 text-left">
        {color && <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color }} />}
        <span className="flex-1 min-w-0">
          <span className="block font-medium text-slate-900">{titulo}</span>
          {sub && <span className="block text-xs text-slate-500">{sub}</span>}
        </span>
        <span className="text-right shrink-0">
          <span className="block font-bold text-slate-900 tabular-nums">{num}</span>
          {numSub && <span className="block text-xs text-slate-500">{numSub}</span>}
        </span>
        <IconChevron className={`w-3 h-3 shrink-0 text-slate-400 transition-transform ${abierta ? "rotate-90" : ""}`} />
      </button>
      {abierta && (
        <div className="bg-slate-50 rounded-lg px-3 mb-2">
          {lista.length === 0
            ? <p className="py-2 text-xs text-slate-500">No hay ninguna en este período.</p>
            : lista.slice(0, 30).map((v) => (
              <div key={v.id} className="py-2 border-t border-slate-200 first:border-0 flex justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 truncate">{v.cliente}</div>
                  <div className="text-xs text-slate-500">
                    {v.pueblo} · {v.vendedor} · {v.fecha}
                    {v.pedido_motivo ? ` · ${(MOTIVOS[v.pedido_motivo] || "").toLowerCase()}` : ""}
                    {!esVisita(v) ? ` · ${CANALES[v.canal] || v.canal}` : ""}
                  </div>
                </div>
                <div className="shrink-0 font-semibold text-slate-900 tabular-nums">{monto(v)}</div>
              </div>
            ))}
          {lista.length > 30 && <p className="py-2 text-xs text-slate-500 border-t border-slate-200">y {lista.length - 30} más. Están todas en la pestaña de visitas.</p>}
        </div>
      )}
    </div>
  );
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + "%";
const dolares = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("en-US");

function Stats({ visitas, desde, hasta, vendedorId, verVendedores, onVendedor }) {
  const [prev, setPrev] = useState(null);
  const [acts, setActs] = useState([]);
  const [ab, setAb] = useState({});
  const [abierto, setAbierto] = useState(null);
  const tog = (k) => setAb((p) => ({ ...p, [k]: !p[k] }));

  // Periodo anterior del mismo largo (para comparar) y otras actividades del periodo
  useEffect(() => {
    let vivo = true;
    const iso = (d) => d.toLocaleDateString("en-CA");
    const d0 = new Date(desde + "T12:00:00"), d1 = new Date(hasta + "T12:00:00");
    const dias = Math.round((d1 - d0) / 86400000) + 1;
    const pFin = new Date(d0); pFin.setDate(d0.getDate() - 1);
    const pIni = new Date(pFin); pIni.setDate(pFin.getDate() - dias + 1);
    let q = supabase.from("v_visitas").select("cliente_id,canal,orden_monto,cobro_monto")
      .gte("fecha", iso(pIni)).lte("fecha", iso(pFin));
    if (vendedorId) q = q.eq("vendedor_id", vendedorId);
    q.then(({ data }) => {
      if (!vivo) return;
      const r = data || [], vis = r.filter(esVisita);
      setPrev({
        visitas: vis.length, clientes: new Set(vis.map((v) => v.cliente_id)).size,
        ordenado: r.reduce((a, v) => a + Number(v.orden_monto || 0), 0),
        cobrado: r.reduce((a, v) => a + Number(v.cobro_monto || 0), 0),
      });
    });
    let qa = supabase.from("v_actividades").select("id,tipo,vendedor_id").gte("fecha", desde).lte("fecha", hasta);
    if (vendedorId) qa = qa.eq("vendedor_id", vendedorId);
    qa.then(({ data }) => { if (vivo) setActs(data || []); });
    return () => { vivo = false; };
  }, [desde, hasta, vendedorId]);

  const s = useMemo(() => {
    const vis = visitas.filter(esVisita), ven = visitas.filter((v) => !esVisita(v));
    const conOrden = vis.filter((v) => v.hubo_orden);
    const soloCobro = vis.filter((v) => !v.hubo_orden && v.hubo_cobro);
    const soloVisita = vis.filter((v) => !v.hubo_orden && !v.hubo_cobro);
    const ordDes = conOrden.filter(conDesglose);
    const completas = ordDes.filter((v) => pedido(v) === 0);
    const parcial = ordDes.filter((v) => pedido(v) > 0 && entregado(v) > 0);
    const nada = ordDes.filter((v) => pedido(v) > 0 && entregado(v) === 0);
    const noComp = [...parcial, ...nada];
    const suma = (l, f) => l.reduce((a, v) => a + f(v), 0);
    const conTiempo = vis.filter((v) => v.segundos != null);
    return {
      vis, ven, conOrden, soloCobro, soloVisita, ordDes, completas, parcial, nada, noComp, suma,
      sinDato: conOrden.length - ordDes.length,
      sinMerc: noComp.filter((v) => v.pedido_motivo === "sin_mercancia"),
      grande: noComp.filter((v) => v.pedido_motivo === "orden_grande"),
      clientes: new Set(vis.map((v) => v.cliente_id)).size,
      pueblos: new Set(vis.map((v) => v.pueblo)).size,
      ordenado: suma(visitas, (v) => Number(v.orden_monto || 0)),
      cobrado: suma(visitas, (v) => Number(v.cobro_monto || 0)),
      completas3: vis.filter((v) => v.estado_cuenta_ok && v.creditos_ok && v.gondola_ok).length,
      revisadas: visitas.filter((v) => v.revisada).length,
      tiempo: Math.round(suma(conTiempo, (v) => v.segundos) / (conTiempo.length || 1)),
    };
  }, [visitas]);

  const porVendedor = useMemo(() => {
    const m = {};
    visitas.forEach((v) => { (m[v.vendedor_id] = m[v.vendedor_id] || { id: v.vendedor_id, nombre: v.vendedor, lista: [] }).lista.push(v); });
    return Object.values(m).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "")).map((x) => {
      const vis = x.lista.filter(esVisita), ord = vis.filter(conDesglose);
      return {
        ...x, visitas: vis.length,
        conResultado: vis.filter((v) => v.hubo_orden || v.hubo_cobro).length,
        ordenado: x.lista.reduce((a, v) => a + Number(v.orden_monto || 0), 0),
        cobrado: x.lista.reduce((a, v) => a + Number(v.cobro_monto || 0), 0),
        ordenes: ord.length, noComp: ord.filter((v) => pedido(v) > 0).length,
        ventas: x.lista.length - vis.length,
      };
    });
  }, [visitas]);

  const porDia = useMemo(() => {
    const m = {};
    s.vis.forEach((v) => {
      const k = v.dow;
      m[k] = m[k] || { visitas: 0, pueblos: new Set(), cobrado: 0, items: [] };
      m[k].visitas++; m[k].pueblos.add(v.pueblo);
      m[k].cobrado += Number(v.cobro_monto || 0);
      m[k].items.push(v);
    });
    // agrupar cada día por fecha real (útil cuando el rango es mes o más)
    Object.values(m).forEach((x) => {
      const f = {};
      x.items.forEach((v) => { (f[v.fecha] = f[v.fecha] || []).push(v); });
      x.fechas = Object.entries(f).sort((a, b) => b[0].localeCompare(a[0]));
    });
    return Object.entries(m).sort((a, b) => a[0] - b[0]);
  }, [s]);

  const nVis = s.vis.length, nOrd = s.ordDes.length, nNo = s.noComp.length;
  const Kpi = ({ v, l, antes }) => (
    <div className="rounded-xl p-3 min-w-0 bg-white/85">
      <div className="text-xl font-bold truncate tabular-nums" style={{ fontFamily: "var(--font-display)" }}>{v}</div>
      <div className="text-xs" style={{ color: "#2C4F72" }}>{l}</div>
      {prev && <div className="text-[11px] mt-0.5" style={{ color: "#2C4F72" }}>{antes} el período anterior</div>}
    </div>
  );
  const Mini = ({ l, v, sub }) => (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="text-lg font-bold text-slate-900">{v}</div>
      <div className="text-xs text-slate-500">{l}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
  const vacio = (t) => <p className="text-sm text-slate-500 mt-3">{t}</p>;

  return (
    <div className="space-y-3">
      <div className="rounded-2xl p-4" style={{ background: "#CFE5F8", color: "#0B2A4A" }}>
        <div className="text-xl font-bold leading-tight">Resumen de ventas en la calle</div>
        <div className="text-sm mt-1" style={{ color: "#2C4F72" }}>
          Cada número se compara con el período anterior del mismo largo.
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <Kpi v={nVis} l="Visitas" antes={prev?.visitas} />
          <Kpi v={s.clientes} l="Clientes distintos" antes={prev?.clientes} />
          <Kpi v={dolares(s.ordenado)} l="Ordenado" antes={dolares(prev?.ordenado)} />
          <Kpi v={dolares(s.cobrado)} l="Cobrado" antes={dolares(prev?.cobrado)} />
        </div>
      </div>

      <Seccion titulo="Lo importante" explica="Las tres cosas que hay que saber si no miras nada más.">
        <ul className="mt-2 divide-y divide-slate-100 text-slate-900 font-medium">
          <li className="py-2">{nVis
            ? `De ${nVis} visitas, ${nVis - s.soloVisita.length} terminaron en orden o cobro y ${s.soloVisita.length} fueron solo visita.`
            : "No hubo visitas en este período."}</li>
          <li className="py-2">{nOrd
            ? `De ${nOrd} órdenes en visita, ${nNo} no se pudieron despachar completas de la camioneta.`
            : "Todavía no hay órdenes con el dato de despacho en este período."}</li>
          <li className="py-2">{nNo
            ? `${s.sinMerc.length} de esas ${nNo} fue porque la camioneta no tenía la mercancía (${dolares(s.suma(s.sinMerc, pedido))}).`
            : nOrd ? "Todo lo ordenado se entregó en el momento." : "Las visitas de antes del cambio no tienen ese dato."}</li>
        </ul>
      </Seccion>

      <Seccion titulo="Despacho desde la camioneta"
        explica="De las órdenes que se hicieron en una visita, cuántas pudo dejar el vendedor completas y cuántas tuvieron que salir de Marey. No cuenta las ventas por teléfono.">
        {!nOrd ? vacio("No hay órdenes con este dato en el período.") : (
          <>
            <div className="mt-3 text-3xl font-bold text-slate-900 leading-tight tabular-nums">
              {nNo} de {nOrd} <span className="text-sm font-medium text-slate-500">órdenes no se despacharon completas ({pct(nNo, nOrd)})</span>
            </div>
            <Barra partes={[[s.completas.length, "#16a34a"], [s.parcial.length, "#b4520f"], [s.nada.length, "#d97706"]]} />
            <div>
              <FilaStat color="#16a34a" titulo="Despachada completa" sub="Todo salió de la camioneta"
                num={s.completas.length} numSub={dolares(s.suma(s.completas, entregado))}
                lista={s.completas} monto={(v) => dolares(entregado(v))} abierta={ab.d1} onToggle={() => tog("d1")} />
              <FilaStat color="#b4520f" titulo="Despachó una parte" sub="El resto fue pedido a Marey"
                num={s.parcial.length} numSub={`${dolares(s.suma(s.parcial, pedido))} a Marey`}
                lista={s.parcial} monto={(v) => dolares(pedido(v))} abierta={ab.d2} onToggle={() => tog("d2")} />
              <FilaStat color="#d97706" titulo="No despachó nada" sub="Toda la orden fue pedido a Marey"
                num={s.nada.length} numSub={`${dolares(s.suma(s.nada, pedido))} a Marey`}
                lista={s.nada} monto={(v) => dolares(pedido(v))} abierta={ab.d3} onToggle={() => tog("d3")} />
            </div>
          </>
        )}
        {s.sinDato > 0 && (
          <p className="text-xs text-slate-400 mt-2">
            {s.sinDato} {s.sinDato === 1 ? "orden es" : "órdenes son"} de antes de este cambio y no {s.sinDato === 1 ? "tiene" : "tienen"} el dato. No se {s.sinDato === 1 ? "cuenta" : "cuentan"} aquí.
          </p>
        )}
      </Seccion>

      <Seccion titulo="Por qué no se despachó"
        explica={'La razón que puso el vendedor cada vez que una orden tuvo que salir de Marey. Si sube "no tenía la mercancía", hay que revisar el restock de las camionetas.'}>
        {!nNo ? vacio("No hubo pedidos a Marey en este período.") : (
          <>
            <Barra partes={[[s.sinMerc.length, "#d97706"], [s.grande.length, "#cbd5e1"]]} />
            <div>
              <FilaStat color="#d97706" titulo={MOTIVOS.sin_mercancia} sub={`${pct(s.sinMerc.length, nNo)} de los pedidos`}
                num={s.sinMerc.length} numSub={dolares(s.suma(s.sinMerc, pedido))}
                lista={s.sinMerc} monto={(v) => dolares(pedido(v))} abierta={ab.m1} onToggle={() => tog("m1")} />
              <FilaStat color="#cbd5e1" titulo={MOTIVOS.orden_grande} sub={`${pct(s.grande.length, nNo)} de los pedidos`}
                num={s.grande.length} numSub={dolares(s.suma(s.grande, pedido))}
                lista={s.grande} monto={(v) => dolares(pedido(v))} abierta={ab.m2} onToggle={() => tog("m2")} />
            </div>
          </>
        )}
      </Seccion>

      <Seccion titulo="En qué terminaron las visitas"
        explica="De cada visita, si salió con una orden, con un cobro, o si fue solo pasar por el negocio.">
        {!nVis ? vacio("No hubo visitas en este período.") : (
          <>
            <Barra partes={[[s.conOrden.length, "#7c3aed"], [s.soloCobro.length, "#2563eb"], [s.soloVisita.length, "#cbd5e1"]]} />
            <div>
              <FilaStat color="#7c3aed" titulo="Con orden" sub={`${pct(s.conOrden.length, nVis)} de las visitas`}
                num={s.conOrden.length} numSub={dolares(s.suma(s.conOrden, (v) => Number(v.orden_monto || 0)))}
                lista={s.conOrden} monto={(v) => dolares(v.orden_monto)} abierta={ab.r1} onToggle={() => tog("r1")} />
              <FilaStat color="#2563eb" titulo="Solo cobro" sub={`${pct(s.soloCobro.length, nVis)} de las visitas`}
                num={s.soloCobro.length} numSub={dolares(s.suma(s.soloCobro, (v) => Number(v.cobro_monto || 0)))}
                lista={s.soloCobro} monto={(v) => dolares(v.cobro_monto)} abierta={ab.r2} onToggle={() => tog("r2")} />
              <FilaStat color="#cbd5e1" titulo="Solo visita" sub={`${pct(s.soloVisita.length, nVis)} de las visitas, sin orden ni cobro`}
                num={s.soloVisita.length} lista={s.soloVisita} monto={() => ""} abierta={ab.r3} onToggle={() => tog("r3")} />
            </div>
          </>
        )}
      </Seccion>

      {verVendedores && porVendedor.length > 0 && (
        <Seccion titulo="Por vendedor"
          explica="Los mismos números, uno al lado del otro. Toca un vendedor para ver todo el resumen solo de él.">
          {porVendedor.map((x) => (
            <button key={x.id} onClick={() => onVendedor(x.id)}
              className="block w-full text-left border border-slate-200 rounded-xl p-3 mt-3">
              <div className="flex justify-between items-baseline gap-2">
                <span className="font-bold text-slate-900">{x.nombre}</span>
                <span className="text-xs font-semibold text-accent">Ver solo {x.nombre?.split(" ")[0]}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 mt-2">
                {[[x.visitas, "visitas"], [pct(x.conResultado, x.visitas), "visitas con orden o cobro"],
                  [dolares(x.ordenado), "ordenado"], [dolares(x.cobrado), "cobrado"],
                  [`${x.noComp} de ${x.ordenes}`, "órdenes sin despachar completas"], [x.ventas, "ventas sin visita"]].map(([v, l]) => (
                  <div key={l} className="bg-slate-50 rounded-lg px-2.5 py-2 min-w-0">
                    <div className="font-bold text-slate-900 truncate tabular-nums">{v}</div>
                    <div className="text-[11px] text-slate-500 leading-tight">{l}</div>
                  </div>
                ))}
              </div>
            </button>
          ))}
        </Seccion>
      )}

      <Seccion titulo="Ventas sin visita"
        explica="Órdenes y cobros que entraron por teléfono, WhatsApp o email, sin que el vendedor fuera al negocio.">
        {!s.ven.length ? vacio("No hubo ventas sin visita en este período.") : (
          <div className="mt-1">
            {Object.entries(CANALES).map(([k, l]) => {
              const x = s.ven.filter((v) => v.canal === k);
              return <FilaStat key={k} titulo={l} num={x.length}
                numSub={dolares(s.suma(x, (v) => Number(v.orden_monto || 0) + Number(v.cobro_monto || 0)))}
                lista={x} monto={(v) => dolares(Number(v.orden_monto || 0) + Number(v.cobro_monto || 0))}
                abierta={ab["c" + k]} onToggle={() => tog("c" + k)} />;
            })}
          </div>
        )}
      </Seccion>

      <Seccion titulo="Otras actividades" explica="Las veces que el vendedor registró algo que no fue visitar ni vender.">
        {!acts.length ? vacio("No se registró ninguna en este período.") : (
          <div className="mt-2 divide-y divide-slate-100">
            {Object.entries(TIPOS_ACT).map(([k, l]) => (
              <div key={k} className="flex justify-between py-2.5">
                <span className="font-medium text-slate-900">{l}</span>
                <span className="font-bold text-slate-900 tabular-nums">{acts.filter((a) => a.tipo === k).length}</span>
              </div>
            ))}
          </div>
        )}
      </Seccion>

      <div className="grid grid-cols-3 gap-2">
        <Mini l="Pueblos" v={s.pueblos} />
        <Mini l="Tiempo prom." v={`${Math.floor(s.tiempo / 60)}m ${s.tiempo % 60}s`} sub="por visita" />
        <Mini l="Revisadas" v={`${s.revisadas}/${visitas.length}`}
          sub={s.revisadas === visitas.length ? "al día" : `${visitas.length - s.revisadas} pendientes`} />
      </div>

      {porDia.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 font-semibold text-slate-900">Por día de la semana</div>
          {porDia.map(([d, x]) => (
            <div key={d} className="border-b border-slate-100 last:border-0">
              <button onClick={() => setAbierto(abierto === d ? null : d)}
                className="w-full px-4 py-3 flex justify-between gap-4 text-left hover:bg-slate-50">
                <div className="min-w-0 flex items-center gap-2">
                  <IconChevron className={`w-3 h-3 shrink-0 text-slate-400 transition-transform ${abierto === d ? "rotate-90" : ""}`} />
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">{DOW[d - 1]}</div>
                    <div className="text-xs text-slate-500 truncate">{[...x.pueblos].join(", ")}</div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-semibold text-slate-900">{x.visitas} visitas</div>
                  <div className="text-xs text-slate-500">{money(x.cobrado)}</div>
                </div>
              </button>

              {abierto === d && (
                <div className="bg-slate-50 border-t border-slate-200">
                  {x.fechas.map(([fecha, vs]) => (
                    <div key={fecha}>
                      <div className="px-4 py-1.5 bg-slate-100 text-xs font-semibold text-slate-600 flex justify-between">
                        <span>{fecha}</span>
                        <span>
                        {vs.length} visitas · {money(sumar(vs).ordenado)} órdenes · {money(sumar(vs).cobrado)} cobrado
                      </span>
                      </div>
                      {vs.map((v) => (
                        <div key={v.id} className="px-4 py-2.5 border-b border-slate-200 last:border-0 flex justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-900 truncate">{v.cliente}</div>
                            <div className="text-xs text-slate-500">
                              {v.pueblo}
                              {v.vendedor && ` · ${v.vendedor}`}
                              {" · "}
                              {new Date(v.created_at).toLocaleTimeString("en-US",
                                { timeZone: "America/Puerto_Rico", hour: "numeric", minute: "2-digit" })}
                              {v.segundos != null && ` · ${Math.floor(v.segundos / 60)}m ${v.segundos % 60}s`}
                            </div>
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            <span className="text-xs text-slate-400">
                              {[v.estado_cuenta_ok, v.creditos_ok, v.gondola_ok].filter(Boolean).length}/3
                            </span>
                            {v.hubo_orden && (
                              <span className="bg-violet-100 text-violet-800 text-xs font-bold px-2 py-0.5 rounded">
                                {money(v.orden_monto)}
                              </span>
                            )}
                            {v.hubo_cobro && (
                              <span className="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-0.5 rounded">
                                {money(v.cobro_monto)}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------- LISTA VISITAS */
function Revision({ v, esAdmin, onCambio }) {
  const [busy, setBusy] = useState(false);

  async function marcar(valor) {
    setBusy(true);
    const { error } = await supabase.rpc("marcar_revisada", { p_visita: v.id, p_valor: valor });
    setBusy(false);
    if (!error) onCambio();
  }

  if (v.revisada) {
    return (
      <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
        <span className="text-xs text-emerald-700 font-medium inline-flex items-center gap-1">
          <IconCheck className="w-3 h-3" /> Revisada por {v.revisada_nombre}
        </span>
        {esAdmin && (
          <button onClick={() => marcar(false)} disabled={busy}
            className="text-xs text-slate-400 underline">deshacer</button>
        )}
      </div>
    );
  }

  if (!esAdmin) return null;

  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <button onClick={() => marcar(true)} disabled={busy}
        className="w-full border border-slate-300 rounded-lg py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">
        {busy ? "Guardando..." : "Marcar como revisada"}
      </button>
    </div>
  );
}

function Tarjeta({ v, esAdmin, verFecha, onCambio }) {
  const [confirmando, setConfirmando] = useState(false);
  const [eliminando, setEliminando] = useState(false);
  const [errorEliminar, setErrorEliminar] = useState("");
  // Visor de fotos dentro de la app: la foto abre en grande aqui mismo,
  // sin abrir la URL firmada (con su token) en el navegador.
  const [fotoAbierta, setFotoAbierta] = useState(null);

  async function eliminarVisita() {
    setEliminando(true);
    setErrorEliminar("");
    const { error } = await supabase.from("visitas").delete().eq("id", v.id);
    setEliminando(false);
    if (error) {
      setErrorEliminar("No se pudo eliminar: " + error.message);
      return;
    }
    onCambio();
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-slate-900">{v.cliente}</div>
          <div className="text-sm text-slate-500">
            {verFecha && `${v.fecha} · `}{v.pueblo}{esAdmin && ` · ${v.vendedor}`}
            {v.segundos != null && ` · ${Math.floor(v.segundos / 60)}m ${v.segundos % 60}s`}
          </div>
          {!esVisita(v) && (
            <span className="inline-block mt-1 bg-accent-soft text-accent text-xs font-bold px-2 py-0.5 rounded-full">
              Venta por {(CANALES[v.canal] || v.canal).toLowerCase()}, sin visita
            </span>
          )}
          {conDesglose(v) && (
            <div className="text-xs text-slate-600 mt-1">
              {entregado(v) > 0 && <span className="text-emerald-700 font-semibold">{money(entregado(v))} entregado de la camioneta</span>}
              {entregado(v) > 0 && pedido(v) > 0 && <span className="text-slate-300"> · </span>}
              {pedido(v) > 0 && <span className="text-amber-700 font-semibold">{money(pedido(v))} pedido a Marey</span>}
              {pedido(v) > 0 && v.pedido_motivo && <div className="text-slate-500">Motivo: {(MOTIVOS[v.pedido_motivo] || "").toLowerCase()}</div>}
            </div>
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          {v.hubo_orden && (
            <span className="bg-violet-100 text-violet-800 text-sm font-bold px-2.5 py-1 rounded-lg whitespace-nowrap">
              Orden {money(v.orden_monto)}
            </span>
          )}
          {v.hubo_cobro && (
            <span className="bg-blue-100 text-blue-800 text-sm font-bold px-2.5 py-1 rounded-lg whitespace-nowrap">
              Cobro {money(v.cobro_monto)}
            </span>
          )}
        </div>
      </div>
      {esVisita(v) && <div className="flex gap-1.5 mt-3 flex-wrap">
        {[["Cuenta", v.estado_cuenta_ok], ["Créditos", v.creditos_ok],
          ["Góndola", v.gondola_ok], ["Orden", v.hubo_orden]].map(([l, ok]) => (
          <span key={l} className={`text-xs px-2 py-1 rounded-md font-medium inline-flex items-center gap-1
            ${ok ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-400"}`}>
            {ok ? <IconCheck className="w-3 h-3" /> : <IconX className="w-3 h-3" />}
            {l}
          </span>
        ))}
      </div>}
      {v.fotos?.length > 0 && (
        <div className="flex gap-2 mt-3">
          {v.fotos.map((src, i) => (
            <button key={i} onClick={() => setFotoAbierta(src)} className="block">
              <img src={src} alt={`Foto ${i + 1} de la visita`}
                className="w-16 h-16 object-cover rounded-lg border border-slate-200" />
            </button>
          ))}
        </div>
      )}
      {fotoAbierta && (
        <div onClick={() => setFotoAbierta(null)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4">
          <img src={fotoAbierta} alt="Foto de la visita"
            className="max-w-full max-h-full object-contain rounded-lg" />
          <button onClick={() => setFotoAbierta(null)} aria-label="Cerrar"
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/15 text-white text-2xl leading-none grid place-items-center">
            &times;
          </button>
        </div>
      )}
      {v.pueblo_corregido && (
        <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">
          Pueblo corregido — en el sistema está en {v.pueblo_registrado}
        </div>
      )}
      {v.notas && <div className="mt-3 pt-3 border-t border-slate-100 text-sm text-slate-600 italic">{v.notas}</div>}
      <Revision v={v} esAdmin={esAdmin} onCambio={onCambio} />

      {esAdmin && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          {!confirmando ? (
            <button
              onClick={() => setConfirmando(true)}
              className="text-xs text-red-600 underline"
            >
              Eliminar visita
            </button>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-red-700">
                ¿Eliminar esta visita? No se puede deshacer.
              </span>
              <button
                onClick={eliminarVisita}
                disabled={eliminando}
                className="text-xs bg-red-600 text-white rounded px-2 py-1 font-semibold disabled:opacity-50"
              >
                {eliminando ? "Eliminando..." : "Sí, eliminar"}
              </button>
              <button
                onClick={() => setConfirmando(false)}
                disabled={eliminando}
                className="text-xs text-slate-500 underline"
              >
                Cancelar
              </button>
            </div>
          )}
          {errorEliminar && (
            <p className="text-xs text-red-600 mt-1">{errorEliminar}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ListaVisitas({ visitas, esAdmin, desde, hasta, agrupar, onCambio }) {
  const grupos = useMemo(() => {
    if (!agrupar) return null;
    const m = {};
    visitas.forEach((v) => { (m[v.fecha] = m[v.fecha] || []).push(v); });
    const d0 = new Date(desde + "T12:00:00"), d1 = new Date(hasta + "T12:00:00");
    const dias = Math.round((d1 - d0) / 86400000);
    if (dias >= 0 && dias <= 31) {
      for (let i = 0; i <= dias; i++) {
        const d = new Date(d0); d.setDate(d0.getDate() + i);
        const dow = ((d.getDay() + 6) % 7) + 1;
        if (dow <= 5) { const k = d.toLocaleDateString("en-CA"); m[k] = m[k] || []; }
      }
    }
    return Object.entries(m).sort((a, b) => b[0].localeCompare(a[0]));
  }, [visitas, desde, hasta, agrupar]);

  if (!visitas.length && !agrupar)
    return <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-500">
      No hay visitas en este período.</div>;

  if (!agrupar)
    return (
      <div className="space-y-2">
        {visitas.map((v) => <Tarjeta key={v.id} v={v} esAdmin={esAdmin} verFecha onCambio={onCambio} />)}
      </div>
    );

  return (
    <div className="space-y-4">
      {grupos.map(([fecha, vs]) => {
        const d = new Date(fecha + "T12:00:00");
        const t = sumar(vs);
        return (
          <div key={fecha}>
            <div className="flex justify-between items-baseline mb-2 px-1">
              <div>
                <span className="font-bold text-slate-900">{DOW[((d.getDay() + 6) % 7)]}</span>
                <span className="text-sm text-slate-500 ml-2">
                  {d.toLocaleDateString("es-PR", { day: "numeric", month: "short" })}
                </span>
              </div>
              <div className="text-sm text-right">
                {vs.length === 0 ? (
                  <span className="text-slate-400">sin visitas</span>
                ) : (
                  <>
                    <div className="text-slate-500">
                      {vs.filter(esVisita).length} visitas
                      {vs.some((v) => !esVisita(v)) && ` · ${vs.filter((v) => !esVisita(v)).length} sin visita`}
                    </div>
                    <div className="text-xs">
                      {t.ordenado > 0 && <span className="text-violet-700 font-medium">{money(t.ordenado)} en órdenes</span>}
                      {t.ordenado > 0 && t.cobrado > 0 && <span className="text-slate-300"> · </span>}
                      {t.cobrado > 0 && <span className="text-blue-700 font-medium">{money(t.cobrado)} cobrado</span>}
                    </div>
                  </>
                )}
              </div>
            </div>
            {vs.length === 0 ? (
              <div className="bg-white rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400">
                No se registró ninguna visita
              </div>
            ) : (
              <div className="space-y-2">
                {vs.map((v) => <Tarjeta key={v.id} v={v} esAdmin={esAdmin} onCambio={onCambio} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------- CLIENTES */
function Clientes({ clientes, pueblos, recargar }) {
  const [nombre, setNombre] = useState("");
  const [pueblo, setPueblo] = useState("");
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");

  async function añadir() {
    if (!nombre.trim() || !pueblo) return setMsg("Falta nombre o pueblo.");
    const { error } = await supabase.from("clientes").insert({ nombre: nombre.trim(), pueblo_id: Number(pueblo) });
    if (error) return setMsg("No se añadió: " + error.message);
    setNombre(""); setMsg("Cliente añadido."); recargar();
    setTimeout(() => setMsg(""), 2000);
  }

  const lista = clientes.filter((c) => c.nombre.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="font-semibold text-slate-900 mb-3">Añadir cliente</div>
        <input className="w-full border border-slate-300 rounded-lg px-3 py-2 mb-2"
          placeholder="Nombre del cliente" value={nombre} onChange={(e) => setNombre(e.target.value)} />
        <select className="w-full border border-slate-300 rounded-lg px-3 py-2 mb-3 bg-white"
          value={pueblo} onChange={(e) => setPueblo(e.target.value)}>
          <option value="">Pueblo…</option>
          {pueblos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
        <button onClick={añadir} className="bg-slate-900 text-white rounded-lg px-5 py-2.5 font-semibold">Añadir</button>
        {msg && <p className="text-sm mt-2 text-slate-600">{msg}</p>}
      </div>

      <input className="w-full border border-slate-300 rounded-lg px-3 py-2"
        placeholder={`Buscar entre ${clientes.length} clientes…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {lista.slice(0, 100).map((c) => (
          <div key={c.id} className="px-4 py-3 border-b border-slate-100 last:border-0 flex justify-between">
            <span className="text-slate-900">{c.nombre}</span>
            <span className="text-sm text-slate-500">{c.pueblos?.nombre}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------- CORREOS */
/* ---------------------------------------------------- GASTOS */
const TIPOS_GASTO = [
  { id: "gasolina", nombre: "Gasolina" },
  { id: "peaje", nombre: "Peaje" },
  { id: "almuerzo", nombre: "Almuerzo / comida" },
  { id: "estacionamiento", nombre: "Estacionamiento" },
  { id: "materiales", nombre: "Materiales" },
  { id: "otro", nombre: "Otro" },
];

function comprimir_recibo(file) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1200;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        const r = Math.min(MAX / w, MAX / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      // Timestamp en la esquina inferior derecha
      const now = new Date();
      const ts = `${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,"0")}`;
      const fontSize = Math.max(16, Math.round(w * 0.03));
      ctx.font = `bold ${fontSize}px Helvetica, Arial, sans-serif`;
      const pad = Math.round(fontSize * 0.5);
      const tw = ctx.measureText(ts).width;
      // Fondo semi-transparente
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(w - tw - pad * 2.5, h - fontSize - pad * 2.5, tw + pad * 2, fontSize + pad * 1.5);
      // Texto blanco
      ctx.fillStyle = "#ffffff";
      ctx.fillText(ts, w - tw - pad * 1.5, h - pad * 1.5);
      c.toBlob((b) => res(b), "image/jpeg", 0.7);
    };
    img.src = URL.createObjectURL(file);
  });
}

function NuevoGasto({ user, onGuardado }) {
  const [tipo, setTipo] = useState("gasolina");
  const [desc, setDesc] = useState("");
  const [monto, setMonto] = useState("");
  const [recibo, setRecibo] = useState(null);
  const [reciboUrl, setReciboUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  function onRecibo(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = "";
    setRecibo(f);
    setReciboUrl(URL.createObjectURL(f));
  }

  async function guardar() {
    const descripcion = tipo === "otro" ? desc.trim() : TIPOS_GASTO.find((t) => t.id === tipo)?.nombre;
    if (!descripcion) return setMsg("Escribe la descripción del gasto.");
    if (!monto || Number(monto) <= 0) return setMsg("Pon el monto del gasto.");
    if (!recibo) return setMsg("Toma la foto del recibo.");

    setBusy(true); setMsg("");
    const blob = await comprimir_recibo(recibo);
    const path = `${user.id}/${Date.now()}.jpg`;
    const { error: eUp } = await supabase.storage.from("gastos").upload(path, blob, { contentType: "image/jpeg" });
    if (eUp) { setBusy(false); return setMsg("No se subió el recibo: " + eUp.message); }

    const { error } = await supabase.from("gastos").insert({
      usuario_id: user.id,
      tipo,
      descripcion,
      monto: Number(monto),
      recibo_path: path,
    });
    setBusy(false);
    if (error) return setMsg("No se guardó: " + error.message);

    // notificar por correo
    supabase.functions.invoke("visita-email", { body: { gasto: true, usuario: user.nombre, tipo, descripcion, monto } }).catch(() => {});

    setTipo("gasolina"); setDesc(""); setMonto(""); setRecibo(null); setReciboUrl(null);
    setMsg("Gasto registrado.");
    onGuardado();
    setTimeout(() => setMsg(""), 4000);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mt-2 mb-1">
        <span className="w-7 h-7 shrink-0 rounded-full bg-slate-900 text-white text-sm font-bold grid place-items-center">1</span>
        <span className="text-sm font-bold uppercase tracking-wide text-slate-500">Tipo de gasto</span>
      </div>
      <select value={tipo} onChange={(e) => setTipo(e.target.value)}
        className="w-full border border-slate-300 rounded-lg px-3 py-3 text-lg bg-white">
        {TIPOS_GASTO.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
      </select>

      {tipo === "otro" && (
        <>
          <div className="flex items-center gap-2 mt-2 mb-1">
            <span className="w-7 h-7 shrink-0 rounded-full bg-slate-900 text-white text-sm font-bold grid place-items-center">2</span>
            <span className="text-sm font-bold uppercase tracking-wide text-slate-500">Descripción</span>
          </div>
          <input type="text" placeholder="¿En qué fue el gasto?" value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-3 text-lg bg-white" />
        </>
      )}

      <div className="flex items-center gap-2 mt-2 mb-1">
        <span className="w-7 h-7 shrink-0 rounded-full bg-slate-900 text-white text-sm font-bold grid place-items-center">{tipo === "otro" ? 3 : 2}</span>
        <span className="text-sm font-bold uppercase tracking-wide text-slate-500">Monto</span>
      </div>
      <div className="relative">
        <span className="absolute left-3 top-3 text-slate-400 text-lg">$</span>
        <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={monto}
          onChange={(e) => setMonto(e.target.value.replace(/[^0-9.]/g, ""))}
          className="w-full border border-slate-300 rounded-lg pl-8 pr-3 py-3 text-lg bg-white" />
      </div>

      <div className="flex items-center gap-2 mt-2 mb-1">
        <span className="w-7 h-7 shrink-0 rounded-full bg-slate-900 text-white text-sm font-bold grid place-items-center">{tipo === "otro" ? 4 : 3}</span>
        <span className="text-sm font-bold uppercase tracking-wide text-slate-500">Foto del recibo</span>
      </div>
      {reciboUrl ? (
        <div className="relative">
          <img src={reciboUrl} alt="Recibo" className="w-full h-48 object-cover rounded-lg border border-slate-200" />
          <button onClick={() => { setRecibo(null); setReciboUrl(null); }}
            className="absolute top-2 right-2 bg-slate-900 text-white rounded-full w-7 h-7 grid place-items-center text-xs">X</button>
        </div>
      ) : (
        <label className="block w-full border-2 border-dashed border-slate-300 rounded-lg py-8 text-center cursor-pointer">
          <div className="text-3xl text-slate-300 mb-1">+</div>
          <div className="text-sm text-slate-500">Tomar foto del recibo</div>
          <div className="text-xs text-slate-400 mt-1">Requerido</div>
          <input type="file" accept="image/*" className="hidden" onChange={onRecibo} />
        </label>
      )}

      <button onClick={guardar} disabled={busy}
        className="w-full bg-slate-900 text-white rounded-lg py-3.5 font-semibold disabled:opacity-50 mt-2">
        {busy ? "Guardando..." : "Registrar gasto"}
      </button>
      {msg && <p className={`text-sm mt-2 ${msg.includes("registrado") ? "text-emerald-700" : "text-red-600"}`}>{msg}</p>}
    </div>
  );
}

function ListaGastos({ user, esAdmin, vendedores }) {
  const [gastos, setGastos] = useState([]);
  const [resumen, setResumen] = useState({ total: 0, count: 0, porTipo: {} });
  const [quien, setQuien] = useState("todos");
  const [mes, setMes] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
  const [registrando, setRegistrando] = useState(false);
  const [fotoAbierta, setFotoAbierta] = useState(null);

  async function cargar() {
    const [anio, m] = mes.split("-").map(Number);
    const desde = `${anio}-${String(m).padStart(2, "0")}-01`;
    const hasta = `${anio}-${String(m + 1 > 12 ? 1 : m + 1).padStart(2, "0")}-01`;

    let q = supabase.from("v_gastos").select("*")
      .gte("fecha", desde).lt("fecha", hasta).order("created_at", { ascending: false });
    if (!esAdmin) q = q.eq("usuario_id", user.id);
    else if (quien !== "todos") q = q.eq("usuario_id", quien);

    const { data } = await q;
    const lista = data || [];
    setGastos(lista);

    const total = lista.reduce((s, g) => s + Number(g.monto), 0);
    const porTipo = {};
    lista.forEach((g) => { porTipo[g.tipo] = (porTipo[g.tipo] || 0) + Number(g.monto); });
    const porVendedor = {};
    if (esAdmin) lista.forEach((g) => {
      if (!porVendedor[g.vendedor]) porVendedor[g.vendedor] = { total: 0, count: 0 };
      porVendedor[g.vendedor].total += Number(g.monto);
      porVendedor[g.vendedor].count += 1;
    });
    setResumen({ total, count: lista.length, porTipo, porVendedor });
  }

  useEffect(() => { cargar(); }, [mes, quien]);

  async function verificar(gasto) {
    await supabase.from("gastos").update({
      verificada_at: new Date().toISOString(),
      verificada_por: user.id,
    }).eq("id", gasto.id);
    cargar();
  }

  async function verRecibo(path) {
    const { data } = await supabase.storage.from("gastos").createSignedUrl(path, 3600);
    if (data?.signedUrl) setFotoAbierta(data.signedUrl);
  }

  const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const tipoNombre = (t) => TIPOS_GASTO.find((x) => x.id === t)?.nombre || t;
  const fechaCorta = (f) => { const d = new Date(f + "T12:00:00"); return `${d.getDate()} ${["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"][d.getMonth()]}`; };
  const timestamp = (t) => { if (!t) return ""; const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`; };
  const meses = () => {
    const arr = [];
    const hoy = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      arr.push({ val: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: `${["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"][d.getMonth()]} ${d.getFullYear()}` });
    }
    return arr;
  };

  if (registrando) return (
    <div>
      <button onClick={() => setRegistrando(false)} className="text-sm text-slate-500 mb-4 flex items-center gap-1">
        <span className="text-lg leading-none">‹</span> Volver
      </button>
      <NuevoGasto user={user} onGuardado={() => { setRegistrando(false); cargar(); }} />
    </div>
  );

  const pendientes = gastos.filter((g) => !g.verificada_at);
  const verificados = gastos.filter((g) => g.verificada_at);

  function exportarCSV() {
    const header = "Fecha,Hora,Vendedor,Tipo,Descripcion,Monto,Estado\n";
    const filas = gastos.map((g) =>
      `${g.fecha},${timestamp(g.created_at)},"${g.vendedor}","${tipoNombre(g.tipo)}","${g.descripcion}",${g.monto},${g.verificada_at ? "Verificado" : "Pendiente"}`
    ).join("\n");
    const blob = new Blob([header + filas], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `gastos-${mes}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportarPDF() {
    const w = window.open("", "_blank");
    w.document.write(`<html><head><title>Gastos ${mes}</title>
      <style>body{font-family:Helvetica,Arial,sans-serif;padding:24px;color:#1a2332}
      h1{font-size:18px;color:#1f3864;border-bottom:3px solid #1f3864;padding-bottom:8px}
      table{width:100%;border-collapse:collapse;font-size:13px;margin-top:16px}
      th{background:#1f3864;color:#fff;text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase}
      td{padding:8px 10px;border-bottom:1px solid #e2e8f0}
      .tot{font-weight:bold;border-top:2px solid #94a3b8}
      @media print{body{padding:0}}</style></head><body>
      <h1>Reporte de gastos — ${meses().find((m2) => m2.val === mes)?.label || mes}</h1>
      <table><tr><th>Fecha</th><th>Hora</th><th>Vendedor</th><th>Tipo</th><th>Descripcion</th><th style="text-align:right">Monto</th><th>Estado</th></tr>
      ${gastos.map((g) => `<tr><td>${fechaCorta(g.fecha)}</td><td>${timestamp(g.created_at)}</td><td>${g.vendedor}</td><td>${tipoNombre(g.tipo)}</td><td>${g.descripcion}</td><td style="text-align:right;font-weight:600">${money(g.monto)}</td><td>${g.verificada_at ? "✓" : "Pendiente"}</td></tr>`).join("")}
      <tr><td class="tot" colspan="5">Total</td><td class="tot" style="text-align:right">${money(resumen.total)}</td><td class="tot">${resumen.count} gastos</td></tr>
      </table></body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
  }

  return (
    <div>
      {/* Exportar + Filtros */}
      {esAdmin && (
        <div className="flex justify-end gap-2 mb-3">
          <button onClick={exportarCSV}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-600 flex items-center gap-1">
            Excel
          </button>
          <button onClick={exportarPDF}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-600 flex items-center gap-1">
            PDF
          </button>
        </div>
      )}
      <div className="flex gap-2 mb-4">
        {esAdmin && vendedores?.length > 0 && (
          <select value={quien} onChange={(e) => setQuien(e.target.value)}
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white">
            <option value="todos">Todos</option>
            {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
          </select>
        )}
        <select value={mes} onChange={(e) => setMes(e.target.value)}
          className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white">
          {meses().map((m) => <option key={m.val} value={m.val}>{m.label}</option>)}
        </select>
      </div>

      {/* Totales */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
          <div className="text-2xl font-bold text-slate-900">{money(resumen.total)}</div>
          <div className="text-xs text-slate-400 uppercase mt-1">Total</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
          <div className="text-2xl font-bold text-slate-900">{resumen.count}</div>
          <div className="text-xs text-slate-400 uppercase mt-1">Gastos</div>
        </div>
      </div>

      {/* Por vendedor (admin) */}
      {esAdmin && resumen.porVendedor && Object.keys(resumen.porVendedor).length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 mb-4 overflow-hidden">
          <div className="px-3 py-2 text-xs text-slate-400 uppercase tracking-wide bg-slate-50 border-b border-slate-200">Por vendedor</div>
          {Object.entries(resumen.porVendedor).sort((a, b) => b[1].total - a[1].total).map(([nom, d]) => (
            <div key={nom} className="flex justify-between items-center px-3 py-2.5 border-b border-slate-100 last:border-b-0">
              <div><span className="font-semibold text-sm">{nom}</span> <span className="text-xs text-slate-400">· {d.count} gastos</span></div>
              <span className="font-semibold text-sm">{money(d.total)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Por tipo */}
      {Object.keys(resumen.porTipo).length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 mb-4 overflow-hidden">
          <div className="px-3 py-2 text-xs text-slate-400 uppercase tracking-wide bg-slate-50 border-b border-slate-200">Por categoría</div>
          {Object.entries(resumen.porTipo).sort((a, b) => b[1] - a[1]).map(([t, m]) => (
            <div key={t} className="flex justify-between items-center px-3 py-2.5 border-b border-slate-100 last:border-b-0">
              <span className="text-sm text-slate-600">{tipoNombre(t)}</span>
              <span className="font-semibold text-sm">{money(m)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Pendientes (admin) */}
      {esAdmin && pendientes.length > 0 && (
        <div className="mb-4">
          <div className="text-xs text-slate-400 uppercase tracking-wide mb-2">
            Pendientes de verificar <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-xs ml-1">{pendientes.length}</span>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            {pendientes.map((g) => (
              <div key={g.id} className="p-3 border-b border-slate-100 last:border-b-0">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="font-semibold text-sm">{g.descripcion}</div>
                    <div className="text-xs text-slate-400">{g.vendedor} · {tipoNombre(g.tipo)} · {fechaCorta(g.fecha)}</div>
                  </div>
                  <span className="font-semibold text-sm">{money(g.monto)}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => verificar(g)}
                    className="flex-1 bg-slate-900 text-white text-sm py-2 rounded-lg font-semibold">✓ Verificar</button>
                  {g.recibo_path && (
                    <button onClick={() => verRecibo(g.recibo_path)}
                      className="px-3 py-2 rounded-lg border border-slate-300 text-sm">Ver recibo</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lista de gastos */}
      <div className="text-xs text-slate-400 uppercase tracking-wide mb-2">
        {esAdmin ? "Todos los gastos" : "Mis gastos"}
      </div>
      {gastos.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-8">Sin gastos en este período.</p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {(esAdmin ? verificados : gastos).map((g) => (
            <div key={g.id} className="flex justify-between items-center px-3 py-2.5 border-b border-slate-100 last:border-b-0">
              <div className="min-w-0">
                <div className={`font-medium text-sm truncate ${g.verificada_at ? "text-slate-500" : ""}`}>{g.descripcion}</div>
                <div className="text-xs text-slate-400">
                  {esAdmin ? `${g.vendedor} · ` : ""}{tipoNombre(g.tipo)} · {fechaCorta(g.fecha)}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`font-semibold text-sm ${g.verificada_at ? "text-slate-500" : ""}`}>{money(g.monto)}</span>
                {g.verificada_at ? (
                  <span className="text-emerald-600 text-xs">✓</span>
                ) : (
                  <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded-full">Pendiente</span>
                )}
                {g.recibo_path && (
                  <button onClick={() => verRecibo(g.recibo_path)} className="text-slate-400 text-xs">Ver recibo</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Botón registrar */}
      <button onClick={() => setRegistrando(true)}
        className="w-full bg-slate-900 text-white rounded-lg py-3.5 font-semibold mt-4">
        + Registrar gasto
      </button>

      {/* Visor de recibo */}
      {fotoAbierta && (
        <div onClick={() => setFotoAbierta(null)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4">
          <img src={fotoAbierta} alt="Recibo" className="max-w-full max-h-full object-contain rounded-lg" />
          <button onClick={() => setFotoAbierta(null)} aria-label="Cerrar"
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/15 text-white text-2xl leading-none grid place-items-center">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function QuienRecibe() {
  const [gente, setGente] = useState([]);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState("");

  const TIPOS = [
    ["visita", "Cada visita"],
    ["diario", "Diario"],
    ["semanal", "Semanal"],
  ];

  async function cargar() {
    const { data: admins } = await supabase.from("usuarios")
      .select("id, nombre").eq("activo", true).eq("rol", "admin").order("nombre");
    const { data: notis } = await supabase.from("notificaciones").select("usuario_id, tipo");
    setGente((admins || []).map((u) => ({
      ...u,
      tipos: new Set((notis || []).filter((n) => n.usuario_id === u.id).map((n) => n.tipo)),
    })));
  }
  useEffect(() => { cargar(); }, []);

  async function alternar(u, tipo) {
    const activo = u.tipos.has(tipo);
    setBusy(u.id + tipo); setErr("");

    const { error } = activo
      ? await supabase.from("notificaciones").delete()
          .eq("usuario_id", u.id).eq("tipo", tipo)
      : await supabase.from("notificaciones").insert({ usuario_id: u.id, tipo });

    setBusy(null);
    if (error) return setErr("No se pudo guardar: " + error.message);

    setGente((p) => p.map((x) => {
      if (x.id !== u.id) return x;
      const t = new Set(x.tipos);
      activo ? t.delete(tipo) : t.add(tipo);
      return { ...x, tipos: t };
    }));
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="font-semibold text-slate-900 mb-1">Quién recibe</div>
        <p className="text-xs text-slate-500 mb-3">
          Toca para prender o apagar. El cambio aplica de una, sin reinstalar nada.
        </p>
        {gente.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-2 py-2.5 border-t border-slate-100">
            <span className="font-medium text-slate-800 text-sm">{u.nombre}</span>
            <div className="flex gap-1.5 shrink-0">
              {TIPOS.map(([tipo, l]) => (
                <button key={tipo} onClick={() => alternar(u, tipo)} disabled={busy === u.id + tipo}
                  className={`text-xs px-2.5 py-1.5 rounded-md font-medium border ${
                    u.tipos.has(tipo)
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-400 border-slate-300"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        ))}
        {gente.length === 0 && <p className="text-sm text-slate-400">Cargando...</p>}
        {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm text-slate-600 space-y-2">
        <div className="font-semibold text-slate-900">Cuándo sale cada uno</div>
        <p><b>Cada visita:</b> al momento en que el vendedor la guarda.</p>
        <p><b>Diario:</b> de lunes a viernes a las 5:00 PM. Si no hubo visitas, no se manda.</p>
        <p><b>Semanal:</b> los viernes a las 5:15 PM, con la semana completa.</p>
        <p className="text-xs text-slate-400 pt-2 border-t border-slate-100">
          William y Josué siempre reciben su confirmación por visita y sus propios
          reportes con lo suyo. Eso no se apaga desde aquí.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- APP */
export default function App() {
  const [sesion, setSesion] = useState(undefined);
  const [user, setUser] = useState(null);
  const [clientes, setClientes] = useState([]);
  const [pueblos, setPueblos] = useState([]);
  const [visitas, setVisitas] = useState([]);
  const [tab, setTab] = useState("nueva");
  const [preset, setPreset] = useState("semana");
  const [desde, setDesde] = useState(rango("semana")[0]);
  const [hasta, setHasta] = useState(rango("semana")[1]);
  const [quien, setQuien] = useState("todos");
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [pendientes, setPendientes] = useState(0);
  const [vendedores, setVendedores] = useState([]);
  const [enVisita, setEnVisita] = useState(false);
  const [tick, setTick] = useState(0);
  const [masAbierto, setMasAbierto] = useState(false);

  const [recuperando, setRecuperando] = useState(false);
  const [motivo, setMotivo] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session && sesionVencida()) {
        await salir();
        setMotivo(`Pasaron ${DIAS_SESION} días desde la última vez. Entra otra vez con tu código.`);
        setSesion(null);
        return;
      }
      setSesion(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((evento, s) => {
      if (evento === "PASSWORD_RECOVERY") setRecuperando(true);
      setSesion(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!sesion) { setUser(null); return; }
    (async () => {
      const { data } = await supabase.from("usuarios").select("*").eq("id", sesion.user.id).single();
      setUser(data);
      if (data?.rol === "admin") {
        setTab("visitas");
        // vendedores + cualquier admin que tambien corra ruta (como Alejandro)
        const { data: v } = await supabase.from("usuarios")
          .select("id,nombre,rol").eq("activo", true).order("nombre");
        setVendedores((v || []).filter((u) => u.rol === "vendedor" || u.id === sesion.user.id));
      } else {
        // vendedor siempre arranca en su formulario; evita heredar una
        // pestana de admin que para el no existe (pantalla vacia)
        setTab("nueva");
      }
    })();
  }, [sesion]);

  const cargarClientes = async () => {
    const { data } = await supabase.from("clientes")
      .select("id,nombre,pueblo_id,pueblos(nombre)").eq("activo", true).order("nombre");
    setClientes(data || []);
  };

  useEffect(() => {
    if (!user) return;
    cargarClientes();
    supabase.from("pueblos").select("*").order("nombre").then(({ data }) => setPueblos(data || []));
  }, [user]);

  const cargarVisitas = async () => {
    if (!user) return;
    let q = supabase.from("v_visitas").select("*").gte("fecha", desde).lte("fecha", hasta)
      .order("fecha", { ascending: false }).order("created_at", { ascending: false });
    if (user.rol === "vendedor") q = q.eq("vendedor_id", user.id);
    else if (quien !== "todos") q = q.eq("vendedor_id", quien);
    if (soloPendientes) q = q.is("revisada_at", null);
    const { data } = await q;
    const lista = data || [];

    // fotos de las visitas cargadas, con URL firmada de 1 hora
    if (lista.length) {
      const { data: fs } = await supabase
        .from("visita_fotos").select("visita_id, path")
        .in("visita_id", lista.map((v) => v.id));

      if (fs?.length) {
        const { data: urls } = await supabase.storage
          .from("visitas").createSignedUrls(fs.map((f) => f.path), 3600);
        const porVisita = {};
        (urls || []).forEach((u, i) => {
          if (u.error) return;
          const vid = fs[i].visita_id;
          (porVisita[vid] = porVisita[vid] || []).push(u.signedUrl);
        });
        lista.forEach((v) => { v.fotos = porVisita[v.id] || []; });
      }
    }
    setVisitas(lista);
  };

  useEffect(() => { cargarVisitas(); }, [user, desde, hasta, quien, soloPendientes]);

  if (sesion === undefined) return <div className="min-h-screen grid place-items-center text-slate-400">Cargando…</div>;
  if (recuperando) return <CodigoNuevo onListo={() => setRecuperando(false)} />;
  if (!sesion) return <Login motivo={motivo} />;
  if (!user) return <div className="min-h-screen grid place-items-center text-slate-400">Cargando perfil…</div>;

  const esAdmin = user.rol === "admin";
  const tabs = esAdmin
    ? [["nueva", "Inicio"], ["visitas", "Visitas"], ["stats", "Resumen"], ["gastos", "Gastos"], ["mas", "Más"]]
    : [["nueva", "Inicio"], ["visitas", "Mis visitas"], ["stats", "Mis números"], ["gastos", "Gastos"]];
  const extras = [["clientes", "Clientes"], ["correos", "Correos"]];
  const tabActiva = (k) => k === "mas" ? extras.some(([e]) => e === tab) : tab === k;
  const verTabs = !(tab === "nueva" && enVisita);

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-slate-900 text-white sticky top-0 z-30">
        <div className="max-w-2xl mx-auto px-4 h-16 flex justify-between items-center">
          <div>
            <div className="font-bold">Hola, {user.nombre?.split(" ")[0]}</div>
            <div className="text-xs text-slate-400">{esAdmin ? "Admin" : "Vendedor"}</div>
          </div>
          <button onClick={async () => { await salir(); setSesion(null); setUser(null); }}
            className="text-sm text-slate-300 px-2 py-3">Salir</button>
        </div>
      </header>

      <main className={`max-w-2xl mx-auto p-4 ${verTabs ? "pb-28" : ""}`}>
        {tab === "nueva" && (
          <NuevaVisita user={user} clientes={clientes} pueblos={pueblos} tick={tick} onActiva={setEnVisita}
            onGuardado={() => { cargarVisitas(); setTick((t) => t + 1); }} />
        )}

        {(tab === "visitas" || tab === "stats") && (
          <>
            <Filtros preset={preset} setPreset={setPreset} desde={desde} hasta={hasta}
              setDesde={setDesde} setHasta={setHasta} />
            {esAdmin && tab === "visitas" && (
              <button onClick={() => setSoloPendientes((p) => !p)}
                className={`w-full rounded-lg px-3 py-2.5 mb-3 text-sm font-semibold border ${
                  soloPendientes ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300"}`}>
                {soloPendientes
                  ? `Viendo solo las pendientes (${visitas.length})`
                  : pendientes === 0
                    ? "Todas revisadas en este período"
                    : `Ver solo las pendientes de revisar (${pendientes})`}
              </button>
            )}
            {esAdmin && (
              <select value={quien} onChange={(e) => setQuien(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 mb-4 bg-white font-medium">
                <option value="todos">Todos los vendedores</option>
                {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
              </select>
            )}
            {tab === "visitas"
              ? <ListaVisitas visitas={visitas} esAdmin={esAdmin} desde={desde} hasta={hasta}
                  agrupar={preset !== "mes"} onCambio={cargarVisitas} />
              : <Stats visitas={visitas} desde={desde} hasta={hasta}
                  vendedorId={esAdmin ? (quien !== "todos" ? quien : null) : user.id}
                  verVendedores={esAdmin && quien === "todos"}
                  onVendedor={(id) => { setQuien(id); window.scrollTo(0, 0); }} />}
          </>
        )}

        {tab === "gastos" && (
          <ListaGastos user={user} esAdmin={esAdmin} vendedores={vendedores} />
        )}

        {tab === "clientes" && (
          <Clientes clientes={clientes} pueblos={pueblos} recargar={cargarClientes} />
        )}

        {tab === "correos" && esAdmin && <QuienRecibe />}
      </main>

      {verTabs && (
        <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-slate-200"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <div className={`max-w-2xl mx-auto grid ${tabs.length === 5 ? "grid-cols-5" : "grid-cols-4"}`}>
            {tabs.map(([k, l]) => (
              <button key={k}
                onClick={() => k === "mas" ? setMasAbierto(true) : setTab(k)}
                className={`h-16 flex flex-col items-center justify-center gap-1 text-xs ${
                  tabActiva(k) ? "text-slate-900 font-bold" : "text-slate-500 font-semibold"}`}>
                <IconTab k={k} />
                {l}
              </button>
            ))}
          </div>
        </nav>
      )}

      {masAbierto && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-end" onClick={() => setMasAbierto(false)}>
          <div className="w-full max-w-2xl mx-auto bg-white rounded-t-2xl p-4 space-y-2"
            style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}>
            <div className="text-xs font-semibold text-slate-600 uppercase tracking-wider px-1 pb-1">Más</div>
            {extras.map(([k, l]) => (
              <button key={k} onClick={() => { setTab(k); setMasAbierto(false); }}
                className={`w-full text-left px-4 py-3.5 rounded-xl font-semibold ${
                  tab === k ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-900"}`}>
                {l}
              </button>
            ))}
            <button onClick={() => setMasAbierto(false)}
              className="w-full py-3 text-slate-500 font-semibold">Cerrar</button>
          </div>
        </div>
      )}
    </div>
  );
}
