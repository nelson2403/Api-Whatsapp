'use client'

// Quadro de atendimentos.
//
// Substitui a lista estilo WhatsApp. O problema da lista era ordenar por
// "quem falou por ultimo": quem esta esperando ha 40 minutos afunda assim que
// outra pessoa manda um "oi". Aqui a ordem e por prioridade e tempo de
// espera, que e o que decide quem deve ser atendido primeiro.
//
// A prioridade vem do caso reconhecido na base de conhecimento, nao de um
// palpite sobre o texto -- quem sabe o que para a operacao e quem escreveu o
// caso.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'
import { formatarTelefone } from '@/lib/whatsapp/telefone'
import Conversa, { type AtendimentoDetalhado } from '@/components/Conversa'
import type { Perfil } from '@/lib/tipos'

type Prioridade = 'alta' | 'normal' | 'baixa'

const BLOCOS: { prioridade: Prioridade; titulo: string; cor: string; borda: string }[] = [
  { prioridade: 'alta', titulo: 'Urgente', cor: 'bg-red-50 text-red-800', borda: 'border-red-200' },
  { prioridade: 'normal', titulo: 'Normal', cor: 'bg-amber-50 text-amber-800', borda: 'border-amber-200' },
  { prioridade: 'baixa', titulo: 'Baixa', cor: 'bg-sky-50 text-sky-800', borda: 'border-sky-200' },
]

function tempoDecorrido(desde: string): string {
  const minutos = Math.floor((Date.now() - new Date(desde).getTime()) / 60000)
  if (minutos < 1) return 'agora'
  if (minutos < 60) return `${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `${horas}h${minutos % 60 ? ` ${minutos % 60}min` : ''}`
  return `${Math.floor(horas / 24)}d`
}

/** Espera longa demais precisa saltar aos olhos, nao ficar em cinza discreto. */
function corDaEspera(desde: string): string {
  const minutos = (Date.now() - new Date(desde).getTime()) / 60000
  if (minutos >= 30) return 'bg-red-600 text-white'
  if (minutos >= 10) return 'bg-amber-500 text-white'
  return 'bg-slate-200 text-slate-700'
}

export default function PainelAtendimentos({ perfil }: { perfil: Perfil }) {
  const supabase = useMemo(() => criarClienteNavegador(), [])

  const [atendimentos, setAtendimentos] = useState<AtendimentoDetalhado[]>([])
  const [abertoId, setAbertoId] = useState<string | null>(null)
  const [mostrarEncerrados, setMostrarEncerrados] = useState(false)
  const [carregando, setCarregando] = useState(true)
  // Reloga o componente de minuto em minuto para os contadores de espera
  // andarem sozinhos, sem depender de evento do banco.
  const [, setTique] = useState(0)

  const carregar = useCallback(async () => {
    const status = mostrarEncerrados
      ? ['resolvido', 'encerrado']
      : ['aberto', 'em_andamento', 'aguardando_cliente']

    const { data } = await supabase
      .from('whatsapp_atendimentos')
      .select('*, grupo:whatsapp_grupos(nome), atendente:whatsapp_perfis(nome)')
      .in('status', status)
      .order('ultima_mensagem_em', { ascending: false })
      .limit(200)

    setAtendimentos((data ?? []) as unknown as AtendimentoDetalhado[])
    setCarregando(false)
  }, [supabase, mostrarEncerrados])

  useEffect(() => {
    void carregar()
  }, [carregar])

  useEffect(() => {
    const intervalo = setInterval(() => setTique((t) => t + 1), 60_000)
    return () => clearInterval(intervalo)
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const agendar = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void carregar(), 1200)
    }

    const canal = supabase
      .channel('painel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_atendimentos' }, agendar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_mensagens' }, agendar)
      .subscribe()

    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(canal)
    }
  }, [supabase, carregar])

  const aberto = atendimentos.find((a) => a.id === abertoId) ?? null

  // Fila de espera: quem a IA escalou e ninguem assumiu. Ordem por
  // prioridade, e dentro dela por quem chegou primeiro.
  const fila = atendimentos
    .filter((a) => a.ia_escalado && !a.usuario_id && !['resolvido', 'encerrado'].includes(a.status))
    .sort((a, b) => {
      const peso = { alta: 0, normal: 1, baixa: 2 }
      const dif = peso[a.prioridade] - peso[b.prioridade]
      if (dif !== 0) return dif
      const ta = a.entrou_na_fila_em ?? a.escalado_em ?? a.created_at
      const tb = b.entrou_na_fila_em ?? b.escalado_em ?? b.created_at
      return new Date(ta).getTime() - new Date(tb).getTime()
    })

  const idsNaFila = new Set(fila.map((a) => a.id))
  const demais = atendimentos.filter((a) => !idsNaFila.has(a.id))

  return (
    <main className="mx-auto max-w-7xl space-y-5 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Atendimentos</h1>

        <div className="ml-auto flex gap-1 rounded-lg bg-slate-200 p-1">
          <button
            onClick={() => setMostrarEncerrados(false)}
            className={`rounded-md px-3 py-1 text-sm font-medium ${
              !mostrarEncerrados ? 'bg-white shadow-sm' : 'text-slate-600'
            }`}
          >
            Em andamento
          </button>
          <button
            onClick={() => setMostrarEncerrados(true)}
            className={`rounded-md px-3 py-1 text-sm font-medium ${
              mostrarEncerrados ? 'bg-white shadow-sm' : 'text-slate-600'
            }`}
          >
            Encerrados
          </button>
        </div>
      </div>

      {/* Fila de espera */}
      {!mostrarEncerrados && (
        <section
          className={`rounded-xl border-2 p-4 ${
            fila.length ? 'border-red-200 bg-red-50/60' : 'border-slate-200 bg-white'
          }`}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">
              🔔 Fila de espera
              {fila.length > 0 && (
                <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-xs text-white">
                  {fila.length}
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-500">
              Aguardando atendente humano, na ordem em que devem ser atendidos.
            </p>
          </div>

          {fila.length === 0 ? (
            <p className="py-2 text-sm text-slate-500">
              Ninguem esperando. A IA esta dando conta.
            </p>
          ) : (
            <ol className="space-y-2">
              {fila.map((a, indice) => {
                const desde = a.entrou_na_fila_em ?? a.escalado_em ?? a.created_at
                return (
                  <li key={a.id}>
                    <button
                      onClick={() => setAbertoId(a.id)}
                      className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:shadow-sm"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white">
                        {indice + 1}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">
                          {a.contato_nome || formatarTelefone(a.contato_numero)}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {a.grupo?.nome ?? 'Privado'}
                          {a.motivo_escalonamento && ` · ${a.motivo_escalonamento}`}
                        </p>
                      </div>

                      {/* Sinaliza na fila quem ja mandou o AnyDesk: da para
                          escolher atender primeiro quem esta pronto. */}
                      {a.acesso_remoto && (
                        <span
                          title={`AnyDesk ${a.acesso_remoto}`}
                          className="shrink-0 rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
                        >
                          🖥️ pronto
                        </span>
                      )}

                      <Etiqueta prioridade={a.prioridade} />

                      <span
                        className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${corDaEspera(desde)}`}
                        title="Tempo de espera"
                      >
                        {tempoDecorrido(desde)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      )}

      {/* Blocos por prioridade */}
      {carregando ? (
        <p className="p-6 text-center text-slate-400">Carregando...</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {BLOCOS.map((bloco) => {
            const doBloco = demais.filter((a) => a.prioridade === bloco.prioridade)

            return (
              <section
                key={bloco.prioridade}
                className={`rounded-xl border bg-white ${bloco.borda}`}
              >
                <header
                  className={`flex items-center justify-between rounded-t-xl px-3 py-2 ${bloco.cor}`}
                >
                  <h2 className="text-sm font-semibold">{bloco.titulo}</h2>
                  <span className="rounded-full bg-white/70 px-2 text-xs font-medium">
                    {doBloco.length}
                  </span>
                </header>

                <div className="space-y-2 p-2">
                  {doBloco.length === 0 && (
                    <p className="px-1 py-3 text-center text-xs text-slate-400">Nada aqui.</p>
                  )}

                  {doBloco.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setAbertoId(a.id)}
                      className="w-full rounded-lg border border-slate-200 p-3 text-left transition hover:border-slate-300 hover:shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {a.contato_nome || formatarTelefone(a.contato_numero)}
                        </span>
                        <span className="shrink-0 text-xs text-slate-400">
                          {tempoDecorrido(a.ultima_mensagem_em)}
                        </span>
                      </div>

                      {a.grupo && (
                        <p className="truncate text-xs text-slate-500">📍 {a.grupo.nome}</p>
                      )}

                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {a.atendente && (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] text-blue-700">
                            {a.atendente.nome}
                          </span>
                        )}
                        {a.status === 'aguardando_cliente' && (
                          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700">
                            IA respondeu
                          </span>
                        )}
                        {a.status === 'resolvido' && (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700">
                            Resolvido
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {aberto && (
        <Conversa
          atendimento={aberto}
          perfil={perfil}
          aoFechar={() => setAbertoId(null)}
          aoMudar={carregar}
        />
      )}
    </main>
  )
}

function Etiqueta({ prioridade }: { prioridade: Prioridade }) {
  const estilo = {
    alta: 'bg-red-100 text-red-700',
    normal: 'bg-amber-100 text-amber-700',
    baixa: 'bg-sky-100 text-sky-700',
  }[prioridade]

  const rotulo = { alta: 'Urgente', normal: 'Normal', baixa: 'Baixa' }[prioridade]

  return (
    <span className={`hidden shrink-0 rounded px-2 py-0.5 text-xs font-medium sm:inline ${estilo}`}>
      {rotulo}
    </span>
  )
}
