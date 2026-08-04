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

function sesionVencida() {
  const desde = Number(leer(K_DESDE) || 0);
  if (!desde) return false;
  return Date.now() - desde > DIAS_SESION * 86400000;
}

async function salir({ olvidarNombre = false } = {}) {
  borrar(K_DESDE);
  if (olvidarNombre) borrar(K_USUARIO);
  await supabase.auth.signOut();
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
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
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
        <span className="text-xs text-slate-400">opcional · hasta {MAX_FOTOS}</span>
      </div>

      <p className="text-xs text-slate-500 mb-3">
        Tira una de la orden, del cobro o de la góndola.
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
            <p className="text-[10px] text-slate-300 text-center mt-5">v2.2</p>
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
const VACIO = { pueblo_id: "", cliente_id: "", estado_cuenta_ok: false, creditos_ok: false,
  gondola_ok: false, hubo_orden: null, orden_monto: "", hubo_cobro: null,
  cobro_monto: "", notas: "" };

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

function NuevaVisita({ user, clientes, pueblos, onGuardado }) {
  const [f, setF] = useState(VACIO);
  const [activa, setActiva] = useState(false);
  const [inicio, setInicio] = useState(null);
  const [fotos, setFotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const comenzar = () => { setF(VACIO); setFotos([]); setInicio(Date.now()); setActiva(true); setMsg(""); };

  const cliSel = clientes.find((c) => c.id === f.cliente_id);

  const negocios = useMemo(
    () => clientes.map((c) => ({ id: c.id, nombre: c.nombre, sub: c.pueblos?.nombre })),
    [clientes]);

  const falta = !f.cliente_id ? "Escoge el negocio."
    : !f.pueblo_id ? "Escoge el pueblo."
    : !f.estado_cuenta_ok ? "Marca que verificaste el estado de cuenta."
    : !f.creditos_ok ? "Marca que verificaste los créditos."
    : !f.gondola_ok ? "Marca que verificaste la góndola."
    : f.hubo_orden === null ? "Contesta si generó orden."
    : f.hubo_orden && !Number(f.orden_monto) ? "Pon el monto de la orden."
    : f.hubo_cobro === null ? "Contesta si hizo cobro."
    : f.hubo_cobro && !Number(f.cobro_monto) ? "Pon el monto cobrado."
    : null;

  async function guardar() {
    if (falta) return setMsg(falta);
    setBusy(true); setMsg("");
    const segs = Math.round((Date.now() - inicio) / 1000);
    const { data, error } = await supabase.from("visitas").insert({
      vendedor_id: user.id,
      cliente_id: f.cliente_id,
      pueblo_id: Number(f.pueblo_id),
      estado_cuenta_ok: true, creditos_ok: true, gondola_ok: true,
      hubo_orden: f.hubo_orden,
      orden_monto: f.hubo_orden ? Number(f.orden_monto) : null,
      hubo_cobro: f.hubo_cobro,
      cobro_monto: f.hubo_cobro ? Number(f.cobro_monto) : null,
      segundos: segs,
      notas: f.notas || null,
    }).select("id").single();
    setBusy(false);
    if (error) return setMsg("No se guardó: " + error.message);

    // subir fotos (si falla alguna, la visita ya quedo guardada)
    for (let i = 0; i < fotos.length; i++) {
      const path = `${data.id}/${Date.now()}-${i}.jpg`;
      const { error: eUp } = await supabase.storage
        .from("visitas").upload(path, fotos[i].blob, { contentType: "image/jpeg" });
      if (eUp) { console.warn("foto no subió", eUp.message); continue; }
      await supabase.from("visita_fotos").insert({
        visita_id: data.id, path,
        tomada_at: fotos[i].tomada_at,
      });
    }

    supabase.functions.invoke("visita-email", { body: { visita_id: data.id } })
      .catch((e) => console.warn("email no salió", e));

    setF(VACIO); setFotos([]); setActiva(false); setInicio(null);
    setMsg(`Visita guardada en ${Math.floor(segs / 60)}m ${segs % 60}s. Te llegó la confirmación por email.`);
    onGuardado();
    setTimeout(() => setMsg(""), 4000);
  }

  if (!activa)
    return (
      <>
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center mt-6">
        <div className="w-16 h-16 rounded-2xl bg-slate-900 text-white grid place-items-center mx-auto mb-4 text-3xl">+</div>
        <h2 className="text-xl font-bold text-slate-900">Registrar una visita</h2>
        <p className="text-slate-500 mt-2 mb-6 text-sm">
          Aprieta comenzar cuando estés en el negocio. El tiempo empieza a contar ahí.
        </p>
        <button onClick={comenzar}
          className="w-full bg-slate-900 text-white rounded-xl py-4 font-bold text-lg">
          Comenzar visita
        </button>
      </div>
        {msg && <p className="text-sm font-medium text-emerald-700 text-center mt-3">{msg}</p>}
      </>
    );

  return (
    <div className="space-y-3 pb-28">
      <div className="flex items-center justify-between bg-white rounded-xl border border-slate-200 px-4 py-2.5">
        <span className="text-sm text-slate-500">Tiempo en esta visita</span>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-slate-900"><Reloj desde={inicio} /></span>
          <button onClick={() => { setActiva(false); setInicio(null); setF(VACIO); setFotos([]); }}
            className="text-xs text-slate-400 underline">cancelar</button>
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
      <SiNo titulo="Generó orden" valor={f.hubo_orden} montoValor={f.orden_monto}
        onSi={() => set("hubo_orden", true)} onNo={() => set("hubo_orden", false)}
        onMonto={(v) => set("orden_monto", v)} ph="Monto de la orden"
        on="border-violet-300 bg-violet-50" btn="bg-violet-600 text-white" />

      <Paso n={5} titulo="Cobro" />
      <SiNo titulo="Hizo cobro" valor={f.hubo_cobro} montoValor={f.cobro_monto}
        onSi={() => set("hubo_cobro", true)} onNo={() => set("hubo_cobro", false)}
        onMonto={(v) => set("cobro_monto", v)} ph="Monto cobrado"
        on="border-blue-300 bg-blue-50" btn="bg-blue-600 text-white" />

      <Paso n={6} titulo="Fotos" />
      <Fotos fotos={fotos} setFotos={setFotos} />

      <textarea rows={2} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
        placeholder="Notas (opcional)" value={f.notas} onChange={(e) => set("notas", e.target.value)} />

      {msg && <p className={`text-sm font-medium ${msg.includes("guardada") ? "text-emerald-700" : "text-red-600"}`}>{msg}</p>}

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-slate-200">
        <div className="max-w-2xl mx-auto">
          <button onClick={guardar} disabled={busy || !!falta}
            className="w-full rounded-xl py-4 font-bold text-lg bg-slate-900 text-white disabled:bg-slate-300 disabled:text-slate-500">
            {busy ? "Guardando…" : falta || "Guardar visita"}
          </button>
        </div>
      </div>
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
function Stats({ visitas }) {
  const s = useMemo(() => {
    const cobros = visitas.filter((v) => v.hubo_cobro);
    return {
      visitas: visitas.length,
      clientes: new Set(visitas.map((v) => v.cliente_id)).size,
      pueblos: new Set(visitas.map((v) => v.pueblo)).size,
      cobros: cobros.length,
      ordenes: visitas.filter((v) => v.hubo_orden).length,
      totalOrden: visitas.filter((v) => v.hubo_orden).reduce((a, v) => a + Number(v.orden_monto || 0), 0),
      total: cobros.reduce((a, v) => a + Number(v.cobro_monto || 0), 0),
      completas: visitas.filter((v) => v.estado_cuenta_ok && v.creditos_ok && v.gondola_ok).length,
      revisadas: visitas.filter((v) => v.revisada).length,
      tiempo: Math.round(visitas.reduce((a, v) => a + (v.segundos || 0), 0) / (visitas.length || 1)),
    };
  }, [visitas]);

  const porDia = useMemo(() => {
    const m = {};
    visitas.forEach((v) => {
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
  }, [visitas]);

  const [abierto, setAbierto] = useState(null);

  const Card = ({ l, v, sub }) => (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="text-2xl font-bold text-slate-900">{v}</div>
      <div className="text-xs text-slate-500 uppercase tracking-wide mt-1">{l}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card l="Visitas" v={s.visitas} sub={`${s.completas} con los 3 pasos`} />
        <Card l="Clientes" v={s.clientes} />
        <Card l="Pueblos" v={s.pueblos} />
        <Card l="Ordenado" v={money(s.totalOrden)} sub={`${s.ordenes} órdenes`} />
        <Card l="Cobrado" v={money(s.total)} sub={`${s.cobros} cobros`} />
        <Card l="Tiempo prom." v={`${Math.floor(s.tiempo / 60)}m ${s.tiempo % 60}s`} sub="llenando la visita" />
        <Card l="Revisadas" v={`${s.revisadas}/${s.visitas}`}
          sub={s.revisadas === s.visitas ? "al día" : `${s.visitas - s.revisadas} pendientes`} />
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
function FotosVisita({ visita }) {
  const [abierto, setAbierto] = useState(false);
  const [items, setItems] = useState(null);

  async function abrir() {
    setAbierto(true);
    if (items) return;
    const { data: fs } = await supabase
      .from("visita_fotos").select("path").eq("visita_id", visita.id);
    if (!fs?.length) return setItems([]);
    const { data: urls } = await supabase.storage
      .from("visitas").createSignedUrls(fs.map((f) => f.path), 3600);
    setItems(fs.map((f, i) => ({ ...f, url: urls?.[i]?.signedUrl })));
  }

  if (!visita.fotos) return null;

  return (
    <div className="mt-3">
      <button onClick={() => (abierto ? setAbierto(false) : abrir())}
        className="text-xs text-slate-500 underline">
        {abierto ? "Ocultar fotos" : `${visita.fotos} foto${visita.fotos > 1 ? "s" : ""}`}
      </button>

      {abierto && (
        <div className="mt-2">
          {items === null && <div className="text-xs text-slate-400">Cargando…</div>}
          {items?.length === 0 && <div className="text-xs text-slate-400">Las fotos ya se borraron.</div>}
          {items?.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {items.map((f) => (
                <img key={f.path} src={f.url} alt=""
                  className="w-full h-24 object-cover rounded-lg border border-slate-200" />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-slate-900">{v.cliente}</div>
          <div className="text-sm text-slate-500">
            {verFecha && `${v.fecha} · `}{v.pueblo}{esAdmin && ` · ${v.vendedor}`}
            {v.segundos != null && ` · ${Math.floor(v.segundos / 60)}m ${v.segundos % 60}s`}
          </div>
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
      <div className="flex gap-1.5 mt-3 flex-wrap">
        {[["Cuenta", v.estado_cuenta_ok], ["Créditos", v.creditos_ok],
          ["Góndola", v.gondola_ok], ["Orden", v.hubo_orden]].map(([l, ok]) => (
          <span key={l} className={`text-xs px-2 py-1 rounded-md font-medium inline-flex items-center gap-1
            ${ok ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-400"}`}>
            {ok ? <IconCheck className="w-3 h-3" /> : <IconX className="w-3 h-3" />}
            {l}
          </span>
        ))}
      </div>
      {v.fotos?.length > 0 && (
        <div className="flex gap-2 mt-3">
          {v.fotos.map((src, i) => (
            <a key={i} href={src} target="_blank" rel="noreferrer">
              <img src={src} alt={`Foto ${i + 1} de la visita`}
                className="w-16 h-16 object-cover rounded-lg border border-slate-200" />
            </a>
          ))}
        </div>
      )}
      {v.pueblo_corregido && (
        <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">
          Pueblo corregido — en el sistema está en {v.pueblo_registrado}
        </div>
      )}
      <FotosVisita visita={v} />
      {v.notas && <div className="mt-3 pt-3 border-t border-slate-100 text-sm text-slate-600 italic">{v.notas}</div>}
      <Revision v={v} esAdmin={esAdmin} onCambio={onCambio} />
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
                    <div className="text-slate-500">{vs.length} visitas</div>
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
    ? [["nueva", "Nueva visita"], ["visitas", "Visitas"], ["stats", "Resumen"], ["clientes", "Clientes"], ["correos", "Correos"]]
    : [["nueva", "Nueva visita"], ["visitas", "Mis visitas"], ["stats", "Mis números"]];

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-slate-900 text-white sticky top-0 z-30">
        <div className="max-w-2xl mx-auto px-4 py-3 flex justify-between items-center">
          <div>
            <div className="font-bold">{user.nombre}</div>
            <div className="text-xs text-slate-400">{esAdmin ? "Admin" : "Vendedor"}</div>
          </div>
          <button onClick={() => salir()} className="text-sm text-slate-300">Salir</button>
        </div>
        <div className="max-w-2xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 ${
                tab === k ? "border-white text-white" : "border-transparent text-slate-400"}`}>
              {l}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4">
        {tab === "nueva" && (
          <NuevaVisita user={user} clientes={clientes} pueblos={pueblos} onGuardado={cargarVisitas} />
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
              : <Stats visitas={visitas} />}
          </>
        )}

        {tab === "clientes" && (
          <Clientes clientes={clientes} pueblos={pueblos} recargar={cargarClientes} />
        )}
      </main>
    </div>
  );
}
