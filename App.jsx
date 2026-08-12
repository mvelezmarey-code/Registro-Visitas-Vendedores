function Tarjeta({ v, esAdmin, verFecha, onCambio }) {
  const [confirmando, setConfirmando] = useState(false);
  const [eliminando, setEliminando] = useState(false);
  const [errorEliminar, setErrorEliminar] = useState("");

  async function eliminarVisita() {
    setEliminando(true);
    setErrorEliminar("");
    const { error } = await supabase.from("visitas").delete().eq("id", v.id);
    setEliminando(false);
    if (error) { setErrorEliminar("No se pudo eliminar: " + error.message); return; }
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

      {esAdmin && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          {!confirmando ? (
            <button onClick={() => setConfirmando(true)}
              className="text-xs text-red-600 underline">
              Eliminar visita
            </button>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-red-700">¿Eliminar esta visita? No se puede deshacer.</span>
              <button onClick={eliminarVisita} disabled={eliminando}
