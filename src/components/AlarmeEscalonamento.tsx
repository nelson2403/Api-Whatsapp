'use client'

// Alarme sonoro de escalonamento.
//
// Quando a IA desiste de um chamado, ela grava uma linha em whatsapp_alertas.
// Este componente escuta a tabela via Realtime e toca um alarme no computador
// ate alguem clicar -- nao e um "ding" que passa despercebido.
//
// O som e sintetizado com a Web Audio API em vez de um arquivo .mp3: nao
// depende de asset, nao quebra por caminho errado no deploy e da controle
// sobre o padrao (dois bipes agudos repetidos, dificil de ignorar).
//
// Navegador bloqueia audio antes de qualquer clique na pagina. Por isso o
// componente detecta o AudioContext suspenso e mostra um botao para liberar.

import { useCallback, useEffect, useRef, useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'
import type { Alerta } from '@/lib/tipos'

const INTERVALO_BIPE_MS = 2500

export default function AlarmeEscalonamento() {
  const [alertas, setAlertas] = useState<Alerta[]>([])
  const [somBloqueado, setSomBloqueado] = useState(false)
  const [silenciado, setSilenciado] = useState(false)

  const contextoRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const supabaseRef = useRef(criarClienteNavegador())

  // --- Audio ---------------------------------------------------------------

  const obterContexto = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null

    if (!contextoRef.current) {
      const Contexto =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Contexto) return null
      contextoRef.current = new Contexto()
    }
    return contextoRef.current
  }, [])

  const tocarBipe = useCallback(() => {
    const ctx = obterContexto()
    if (!ctx) return

    if (ctx.state === 'suspended') {
      // Sem gesto do usuario ainda -- o navegador nao deixa tocar.
      setSomBloqueado(true)
      void ctx.resume().then(() => setSomBloqueado(false)).catch(() => {})
      return
    }

    setSomBloqueado(false)

    // Dois bipes curtos em 880Hz e 1175Hz. Envelope com rampa para nao
    // estalar no inicio e no fim.
    const agora = ctx.currentTime
    ;[
      { inicio: 0, freq: 880 },
      { inicio: 0.28, freq: 1175 },
    ].forEach(({ inicio, freq }) => {
      const osc = ctx.createOscillator()
      const ganho = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.value = freq

      const t0 = agora + inicio
      ganho.gain.setValueAtTime(0.0001, t0)
      ganho.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02)
      ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22)

      osc.connect(ganho).connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.24)
    })
  }, [obterContexto])

  // --- Alertas pendentes ---------------------------------------------------

  const carregarPendentes = useCallback(async () => {
    const { data } = await supabaseRef.current
      .from('whatsapp_alertas')
      .select('*')
      .is('lido_em', null)
      .lte('agendado_para', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(20)

    setAlertas((data ?? []) as unknown as Alerta[])
  }, [])

  useEffect(() => {
    void carregarPendentes()

    const canal = supabaseRef.current
      .channel('alertas-escalonamento')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_alertas' },
        () => {
          void carregarPendentes()
          setSilenciado(false) // alerta novo volta a tocar mesmo se silenciado
        },
      )
      .subscribe()

    // Rede de seguranca: alertas agendados para depois (gerados fora do
    // horario) nao geram evento de Realtime quando a janela abre.
    const intervalo = setInterval(() => void carregarPendentes(), 60_000)

    return () => {
      void supabaseRef.current.removeChannel(canal)
      clearInterval(intervalo)
    }
  }, [carregarPendentes])

  // --- Loop do alarme ------------------------------------------------------

  useEffect(() => {
    const deveTocar = alertas.length > 0 && !silenciado

    if (!deveTocar) {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      return
    }

    if (timerRef.current) return

    tocarBipe()
    timerRef.current = setInterval(tocarBipe, INTERVALO_BIPE_MS)

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [alertas.length, silenciado, tocarBipe])

  // --- Notificacao do sistema ---------------------------------------------

  const ultimoNotificado = useRef<string | null>(null)

  useEffect(() => {
    if (!alertas.length || typeof Notification === 'undefined') return

    const alerta = alertas[0]
    if (ultimoNotificado.current === alerta.id) return
    ultimoNotificado.current = alerta.id

    const notificar = () => {
      new Notification('Atendimento precisa de voce', {
        body: alerta.titulo,
        tag: alerta.id,
        requireInteraction: true,
      })
    }

    if (Notification.permission === 'granted') notificar()
    else if (Notification.permission === 'default') {
      void Notification.requestPermission().then((p) => p === 'granted' && notificar())
    }
  }, [alertas])

  // --- Acoes ---------------------------------------------------------------

  async function marcarLido(id: string) {
    const {
      data: { user },
    } = await supabaseRef.current.auth.getUser()

    await supabaseRef.current
      .from('whatsapp_alertas')
      .update({ lido_em: new Date().toISOString(), lido_por: user?.id ?? null })
      .eq('id', id)

    setAlertas((atual) => atual.filter((a) => a.id !== id))
  }

  async function marcarTodosLidos() {
    await Promise.all(alertas.map((a) => marcarLido(a.id)))
  }

  function liberarSom() {
    void obterContexto()?.resume()
    setSomBloqueado(false)
    tocarBipe()
  }

  if (!alertas.length) return null

  const urgente = alertas.some((a) => a.urgencia === 'alta')

  return (
    <div className="fixed inset-x-0 top-0 z-50 shadow-lg">
      <div
        className={`flex flex-wrap items-center gap-3 px-4 py-3 text-white ${
          urgente ? 'bg-red-600' : 'bg-amber-600'
        }`}
      >
        <span className={`text-xl ${silenciado ? '' : 'pulsando'}`} aria-hidden>
          🔔
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">
            {alertas.length === 1
              ? alertas[0].titulo
              : `${alertas.length} atendimentos aguardando voce`}
          </p>
          {alertas[0].detalhe && (
            <p className="truncate text-sm text-white/85">{alertas[0].detalhe}</p>
          )}
        </div>

        {somBloqueado && (
          <button
            onClick={liberarSom}
            className="rounded-lg bg-white/25 px-3 py-1.5 text-sm font-medium hover:bg-white/35"
          >
            🔊 Ativar som
          </button>
        )}

        <button
          onClick={() => setSilenciado((s) => !s)}
          className="rounded-lg bg-white/25 px-3 py-1.5 text-sm font-medium hover:bg-white/35"
        >
          {silenciado ? '🔊 Reativar' : '🔇 Silenciar'}
        </button>

        <button
          onClick={marcarTodosLidos}
          className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 hover:bg-white/90"
        >
          Estou atendendo
        </button>
      </div>
    </div>
  )
}
