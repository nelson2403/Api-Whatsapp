'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'
import { formatarTelefone } from '@/lib/whatsapp/telefone'
import type { Config, Grupo } from '@/lib/tipos'

const DIAS = [
  { valor: 0, rotulo: 'Dom' },
  { valor: 1, rotulo: 'Seg' },
  { valor: 2, rotulo: 'Ter' },
  { valor: 3, rotulo: 'Qua' },
  { valor: 4, rotulo: 'Qui' },
  { valor: 5, rotulo: 'Sex' },
  { valor: 6, rotulo: 'Sab' },
]

export default function PaginaConfiguracoes() {
  const supabase = useMemo(() => criarClienteNavegador(), [])

  const [config, setConfig] = useState<Config | null>(null)
  const [grupos, setGrupos] = useState<Grupo[]>([])
  const [ignorados, setIgnorados] = useState<{ id: string; numero: string; observacao: string | null; ativo: boolean }[]>([])
  const [aprendidos, setAprendidos] = useState<{ id: string; problema: string; solucao: string; created_at: string }[]>([])
  const [aviso, setAviso] = useState<string | null>(null)
  const [novoNumero, setNovoNumero] = useState('')

  const carregar = useCallback(async () => {
    const [c, g, i, a] = await Promise.all([
      supabase.from('whatsapp_config').select('*').eq('id', 1).single(),
      supabase.from('whatsapp_grupos').select('*').order('nome'),
      supabase.from('whatsapp_numeros_ignorados').select('*').order('created_at', { ascending: false }),
      supabase
        .from('whatsapp_conhecimento_aprendido')
        .select('id, problema, solucao, created_at')
        .order('created_at', { ascending: false })
        .limit(30),
    ])

    setConfig((c.data as unknown as Config) ?? null)
    setGrupos((g.data ?? []) as unknown as Grupo[])
    setIgnorados((i.data ?? []) as unknown as typeof ignorados)
    setAprendidos((a.data ?? []) as unknown as typeof aprendidos)
  }, [supabase])

  useEffect(() => {
    void carregar()
  }, [carregar])

  function mostrarAviso(texto: string) {
    setAviso(texto)
    setTimeout(() => setAviso(null), 3500)
  }

  async function salvarConfig(mudancas: Partial<Config>) {
    if (!config) return
    setConfig({ ...config, ...mudancas })

    const { error } = await supabase.from('whatsapp_config').update(mudancas).eq('id', 1)

    if (error) {
      mostrarAviso(
        error.message.includes('row-level security')
          ? 'Somente administradores podem alterar as configuracoes.'
          : error.message,
      )
      void carregar()
    } else {
      mostrarAviso('Salvo.')
    }
  }

  async function salvarGrupo(id: string, mudancas: Partial<Grupo>) {
    setGrupos((atual) => atual.map((g) => (g.id === id ? { ...g, ...mudancas } : g)))

    const { error } = await supabase.from('whatsapp_grupos').update(mudancas).eq('id', id)

    if (error) {
      mostrarAviso(
        error.message.includes('row-level security')
          ? 'Somente administradores podem alterar grupos.'
          : error.message,
      )
      void carregar()
    } else {
      mostrarAviso('Salvo.')
    }
  }

  async function adicionarIgnorado(evento: React.FormEvent) {
    evento.preventDefault()
    if (!novoNumero.trim()) return

    const { error } = await supabase
      .from('whatsapp_numeros_ignorados')
      .insert({ numero: novoNumero.replace(/\D/g, '') })

    if (error) mostrarAviso(error.message)
    else {
      setNovoNumero('')
      void carregar()
    }
  }

  if (!config) {
    return <main className="p-8 text-slate-400">Carregando configuracoes...</main>
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 pb-16">
      <h1 className="text-xl font-semibold">Configuracoes</h1>

      {aviso && (
        <div className="sticky top-2 z-10 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {aviso}
        </div>
      )}

      {/* 1. Interruptor geral ------------------------------------------- */}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-medium">Automacao</h2>

        <Interruptor
          ligado={config.bot_ativo}
          aoAlternar={(v) => salvarConfig({ bot_ativo: v })}
          titulo="Bot ativo"
          descricao="Interruptor geral. Desligado, nada e respondido automaticamente -- mas todas as mensagens continuam chegando no painel."
        />

        <Interruptor
          ligado={config.ia_ativa}
          aoAlternar={(v) => salvarConfig({ ia_ativa: v })}
          titulo="Resposta automatica por IA"
          descricao="Desligado, todo chamado vai direto para atendente humano."
        />

        <Interruptor
          ligado={config.ia_classificacao_ativa}
          aoAlternar={(v) => salvarConfig({ ia_classificacao_ativa: v })}
          titulo="Filtrar conversa solta"
          descricao='Desligado, toda mensagem de participante abre chamado -- inclusive "bom dia" e "obrigado".'
        />

        <label className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">Tentativas da IA antes de chamar humano</span>
          <input
            type="number"
            min={1}
            max={5}
            value={config.max_tentativas_ia}
            onChange={(e) => salvarConfig({ max_tentativas_ia: Number(e.target.value) })}
            className="w-20 rounded-lg border border-slate-300 px-2 py-1"
          />
          <span className="text-slate-500">
            Se o cliente disser que nao resolveu mais vezes que isso, o chamado escala.
          </span>
        </label>
      </section>

      {/* 2. Alerta ------------------------------------------------------ */}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-medium">Alerta de escalonamento</h2>
        <p className="text-sm text-slate-500">
          Quando a IA desiste de um chamado, o alarme toca no painel aberto e uma mensagem e enviada
          para o numero abaixo. Fora do horario de atendimento do grupo, a mensagem fica represada e
          sai quando a janela abrir.
        </p>

        <Interruptor
          ligado={config.alerta_ativo}
          aoAlternar={(v) => salvarConfig({ alerta_ativo: v })}
          titulo="Enviar alerta por WhatsApp"
          descricao="O alarme sonoro no painel funciona independente disso."
        />

        <label className="block space-y-1">
          <span className="text-sm font-medium">Seu numero (com DDI)</span>
          <input
            value={config.numero_alerta ?? ''}
            onChange={(e) => setConfig({ ...config, numero_alerta: e.target.value })}
            onBlur={(e) => salvarConfig({ numero_alerta: e.target.value.replace(/\D/g, '') || null })}
            placeholder="5527999998888"
            className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
          <span className="text-xs text-slate-500">
            {config.numero_alerta
              ? `Alertas vao para ${formatarTelefone(config.numero_alerta)}`
              : 'Sem numero configurado, so o alarme do painel funciona.'}
          </span>
        </label>
      </section>

      {/* 3. Mensagens privadas ------------------------------------------ */}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-medium">Mensagens no privado</h2>

        <Interruptor
          ligado={config.redirecionar_privado}
          aoAlternar={(v) => salvarConfig({ redirecionar_privado: v })}
          titulo="Redirecionar para o grupo"
          descricao="Quem chamar no privado recebe a mensagem abaixo e nao abre chamado. Desligado, mensagens privadas viram atendimento normal."
        />

        <label className="block space-y-1">
          <span className="text-sm font-medium">Mensagem enviada</span>
          <textarea
            value={config.mensagem_privado}
            onChange={(e) => setConfig({ ...config, mensagem_privado: e.target.value })}
            onBlur={(e) => salvarConfig({ mensagem_privado: e.target.value })}
            rows={4}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
        </label>

        <label className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">Nao repetir antes de</span>
          <input
            type="number"
            min={1}
            max={168}
            value={config.privado_aviso_horas}
            onChange={(e) => salvarConfig({ privado_aviso_horas: Number(e.target.value) })}
            className="w-20 rounded-lg border border-slate-300 px-2 py-1"
          />
          <span className="text-slate-500">horas para o mesmo numero</span>
        </label>
      </section>

      {/* 4. Grupos ------------------------------------------------------- */}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-medium">Grupos de suporte</h2>
        <p className="text-sm text-slate-500">
          Grupos aparecem aqui sozinhos assim que recebem a primeira mensagem, ja desativados.
          Ative o que voce quer que seja atendido.
        </p>

        {grupos.length === 0 && (
          <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
            Nenhum grupo detectado ainda. Adicione o numero do WhatsApp aos grupos de suporte e
            mande qualquer mensagem neles -- em segundos aparecem aqui.
          </p>
        )}

        {grupos.map((grupo) => (
          <div key={grupo.id} className="space-y-3 rounded-lg border border-slate-200 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{grupo.nome}</p>
                <p className="truncate font-mono text-xs text-slate-400">{grupo.grupo_id}</p>
              </div>
              <Interruptor
                ligado={grupo.ativo}
                aoAlternar={(v) => salvarGrupo(grupo.id, { ativo: v })}
                titulo=""
                descricao=""
                compacto
              />
            </div>

            {grupo.ativo && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={grupo.atendimento_24h}
                    onChange={(e) => salvarGrupo(grupo.id, { atendimento_24h: e.target.checked })}
                    className="h-4 w-4"
                  />
                  Atendimento 24 horas
                </label>

                {!grupo.atendimento_24h && (
                  <>
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="font-medium">Horario</span>
                      <input
                        type="time"
                        value={grupo.horario_inicio.slice(0, 5)}
                        onChange={(e) => salvarGrupo(grupo.id, { horario_inicio: e.target.value })}
                        className="rounded-lg border border-slate-300 px-2 py-1"
                      />
                      <span>as</span>
                      <input
                        type="time"
                        value={grupo.horario_fim.slice(0, 5)}
                        onChange={(e) => salvarGrupo(grupo.id, { horario_fim: e.target.value })}
                        className="rounded-lg border border-slate-300 px-2 py-1"
                      />
                    </div>

                    <div className="flex flex-wrap gap-1">
                      {DIAS.map((dia) => {
                        const marcado = grupo.dias_semana?.includes(dia.valor)
                        return (
                          <button
                            key={dia.valor}
                            onClick={() => {
                              const atual = grupo.dias_semana ?? []
                              const novo = marcado
                                ? atual.filter((d) => d !== dia.valor)
                                : [...atual, dia.valor].sort()
                              void salvarGrupo(grupo.id, { dias_semana: novo })
                            }}
                            className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                              marcado
                                ? 'bg-[var(--color-zap)] text-white'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {dia.rotulo}
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}

                <label className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">Anti-flood</span>
                  <input
                    type="number"
                    min={0}
                    max={60}
                    value={grupo.anti_flood_minutos}
                    onChange={(e) =>
                      salvarGrupo(grupo.id, { anti_flood_minutos: Number(e.target.value) })
                    }
                    className="w-20 rounded-lg border border-slate-300 px-2 py-1"
                  />
                  <span className="text-slate-500">
                    minutos minimos entre respostas automaticas para a mesma pessoa (0 desliga)
                  </span>
                </label>

                <label className="block space-y-1">
                  <span className="text-sm font-medium">Mensagem fora do horario</span>
                  <textarea
                    defaultValue={grupo.mensagem_fora_horario}
                    onBlur={(e) => salvarGrupo(grupo.id, { mensagem_fora_horario: e.target.value })}
                    rows={3}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
                  />
                  <span className="text-xs text-slate-500">
                    Use {'{{horario_inicio}}'} e {'{{horario_fim}}'} para inserir os horarios.
                  </span>
                </label>
              </>
            )}
          </div>
        ))}
      </section>

      {/* 5. Numeros ignorados -------------------------------------------- */}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-medium">Numeros sem resposta automatica</h2>
        <p className="text-sm text-slate-500">
          Mensagens desses numeros continuam aparecendo no painel -- so a automacao e pulada.
        </p>

        <form onSubmit={adicionarIgnorado} className="flex flex-wrap gap-2">
          <input
            value={novoNumero}
            onChange={(e) => setNovoNumero(e.target.value)}
            placeholder="Numero com ou sem DDI"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
          <button
            type="submit"
            className="rounded-lg bg-[var(--color-zap)] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            Adicionar
          </button>
        </form>

        <ul className="space-y-1">
          {ignorados.map((n) => (
            <li key={n.id} className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={n.ativo}
                onChange={async (e) => {
                  await supabase
                    .from('whatsapp_numeros_ignorados')
                    .update({ ativo: e.target.checked })
                    .eq('id', n.id)
                  void carregar()
                }}
                className="h-4 w-4"
              />
              <span className="flex-1">{formatarTelefone(n.numero)}</span>
              <button
                onClick={async () => {
                  await supabase.from('whatsapp_numeros_ignorados').delete().eq('id', n.id)
                  void carregar()
                }}
                className="text-xs text-red-600 hover:underline"
              >
                Remover
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* 6. Aprendizado --------------------------------------------------- */}
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-medium">Casos resolvidos por atendentes</h2>
        <p className="text-sm text-slate-500">
          Preenchido pelo modal de encerrar atendimento. Serve de contexto extra para a IA. Quando
          um caso se repetir, vale cadastra-lo formalmente na Base de conhecimento.
        </p>

        {aprendidos.length === 0 && (
          <p className="text-sm text-slate-400">Nada registrado ainda.</p>
        )}

        {aprendidos.map((a) => (
          <div key={a.id} className="rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-medium">{a.problema}</p>
            <p className="text-slate-600">{a.solucao}</p>
            <p className="mt-1 text-xs text-slate-400">
              {new Date(a.created_at).toLocaleDateString('pt-BR')}
            </p>
          </div>
        ))}
      </section>
    </main>
  )
}

// ---------------------------------------------------------------------------

function Interruptor({
  ligado,
  aoAlternar,
  titulo,
  descricao,
  compacto = false,
}: {
  ligado: boolean
  aoAlternar: (valor: boolean) => void
  titulo: string
  descricao: string
  compacto?: boolean
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        role="switch"
        aria-checked={ligado}
        aria-label={titulo || 'Ativar'}
        onClick={() => aoAlternar(!ligado)}
        className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${
          ligado ? 'bg-[var(--color-zap)]' : 'bg-slate-300'
        }`}
      >
        <span
          className={`block h-5 w-5 rounded-full bg-white transition ${
            ligado ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>

      {!compacto && (
        <div className="min-w-0">
          <p className="text-sm font-medium">{titulo}</p>
          <p className="text-xs text-slate-500">{descricao}</p>
        </div>
      )}
    </div>
  )
}
