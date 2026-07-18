'use client'

// Painel de atendimento.
//
// Leitura e escrita falam direto com o Supabase sob RLS -- so o envio de
// mensagem passa por rota de servidor, porque o token do Z-API e segredo.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'
import { formatarTelefone } from '@/lib/whatsapp/telefone'
import type { Atendimento, Mensagem, Perfil, StatusAtendimento } from '@/lib/tipos'

interface AtendimentoComGrupo extends Atendimento {
  grupo: { nome: string } | null
  atendente: { nome: string } | null
}

type Aba = 'atencao' | 'abertos' | 'meus' | 'encerrados'

const ABAS: { id: Aba; rotulo: string }[] = [
  { id: 'atencao', rotulo: 'Precisa de atendente' },
  { id: 'abertos', rotulo: 'Em aberto' },
  { id: 'meus', rotulo: 'Meus' },
  { id: 'encerrados', rotulo: 'Encerrados' },
]

export default function Inbox({ perfil }: { perfil: Perfil }) {
  const supabase = useMemo(() => criarClienteNavegador(), [])

  const [aba, setAba] = useState<Aba>('atencao')
  const [atendimentos, setAtendimentos] = useState<AtendimentoComGrupo[]>([])
  const [selecionadoId, setSelecionadoId] = useState<string | null>(null)
  const [mensagens, setMensagens] = useState<Mensagem[]>([])
  const [rascunho, setRascunho] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erroEnvio, setErroEnvio] = useState<string | null>(null)
  const [modalEncerrar, setModalEncerrar] = useState(false)

  const fimDaListaRef = useRef<HTMLDivElement>(null)

  // --- Carregamento --------------------------------------------------------

  const carregarAtendimentos = useCallback(async () => {
    let consulta = supabase
      .from('whatsapp_atendimentos')
      .select('*, grupo:whatsapp_grupos(nome), atendente:whatsapp_perfis(nome)')
      .order('ultima_mensagem_em', { ascending: false })
      .limit(120)

    if (aba === 'atencao') {
      consulta = consulta.eq('ia_escalado', true).is('usuario_id', null).in('status', ['aberto', 'em_andamento'])
    } else if (aba === 'abertos') {
      consulta = consulta.in('status', ['aberto', 'em_andamento', 'aguardando_cliente'])
    } else if (aba === 'meus') {
      consulta = consulta.eq('usuario_id', perfil.id).in('status', ['aberto', 'em_andamento', 'aguardando_cliente'])
    } else {
      consulta = consulta.in('status', ['resolvido', 'encerrado'])
    }

    const { data } = await consulta
    setAtendimentos((data ?? []) as unknown as AtendimentoComGrupo[])
  }, [supabase, aba, perfil.id])

  const carregarMensagens = useCallback(
    async (atendimentoId: string) => {
      const { data } = await supabase
        .from('whatsapp_mensagens')
        .select('*')
        .eq('atendimento_id', atendimentoId)
        .order('created_at', { ascending: true })
        .limit(300)

      setMensagens((data ?? []) as unknown as Mensagem[])
    },
    [supabase],
  )

  useEffect(() => {
    void carregarAtendimentos()
  }, [carregarAtendimentos])

  useEffect(() => {
    if (selecionadoId) void carregarMensagens(selecionadoId)
    else setMensagens([])
  }, [selecionadoId, carregarMensagens])

  // Realtime com debounce: numa rajada de mensagens, recarregar a cada evento
  // derruba a interface. 1,2s agrupa a rajada num refresh so.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const agendar = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void carregarAtendimentos()
        if (selecionadoId) void carregarMensagens(selecionadoId)
      }, 1200)
    }

    const canal = supabase
      .channel('inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_mensagens' }, agendar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_atendimentos' }, agendar)
      .subscribe()

    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(canal)
    }
  }, [supabase, carregarAtendimentos, carregarMensagens, selecionadoId])

  useEffect(() => {
    fimDaListaRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [mensagens])

  const selecionado = atendimentos.find((a) => a.id === selecionadoId) ?? null

  // --- Acoes ---------------------------------------------------------------

  async function assumir(id: string) {
    await supabase
      .from('whatsapp_atendimentos')
      .update({ usuario_id: perfil.id, assumido_em: new Date().toISOString(), status: 'em_andamento' })
      .eq('id', id)

    // Assumir tambem quita o alerta -- senao o alarme continua tocando para
    // um chamado que ja tem dono.
    await supabase
      .from('whatsapp_alertas')
      .update({ lido_em: new Date().toISOString(), lido_por: perfil.id })
      .eq('atendimento_id', id)
      .is('lido_em', null)

    void carregarAtendimentos()
  }

  async function liberar(id: string) {
    await supabase
      .from('whatsapp_atendimentos')
      .update({ usuario_id: null, assumido_em: null })
      .eq('id', id)
    void carregarAtendimentos()
  }

  async function enviar() {
    const texto = rascunho.trim()
    if (!texto || !selecionadoId || enviando) return

    setEnviando(true)
    setErroEnvio(null)

    const resposta = await fetch(`/api/whatsapp/atendimentos/${selecionadoId}/responder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    })

    if (resposta.ok) {
      setRascunho('')
      await carregarMensagens(selecionadoId)
      void carregarAtendimentos()
    } else {
      const corpo = (await resposta.json().catch(() => ({}))) as { erro?: string }
      setErroEnvio(corpo.erro ?? 'Falha ao enviar. Verifique a conexao do WhatsApp.')
    }

    setEnviando(false)
  }

  async function encerrar(problema?: string, solucao?: string) {
    if (!selecionadoId) return

    if (problema?.trim() && solucao?.trim()) {
      await supabase.from('whatsapp_conhecimento_aprendido').insert({
        atendimento_id: selecionadoId,
        problema: problema.trim(),
        solucao: solucao.trim(),
        registrado_por: perfil.id,
      })
    }

    await supabase
      .from('whatsapp_atendimentos')
      .update({
        status: 'encerrado',
        resolvido_por: 'humano',
        resolvido_em: new Date().toISOString(),
      })
      .eq('id', selecionadoId)

    setModalEncerrar(false)
    setSelecionadoId(null)
    void carregarAtendimentos()
  }

  // --- Render --------------------------------------------------------------

  return (
    <div className="mx-auto flex max-w-7xl gap-4 p-4">
      {/* Lista */}
      <aside className="flex w-80 shrink-0 flex-col rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap gap-1 border-b border-slate-200 p-2">
          {ABAS.map((a) => (
            <button
              key={a.id}
              onClick={() => setAba(a.id)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                aba === a.id ? 'bg-[var(--color-zap)] text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {a.rotulo}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 190px)' }}>
          {atendimentos.length === 0 && (
            <p className="p-6 text-center text-sm text-slate-400">Nenhum atendimento aqui.</p>
          )}

          {atendimentos.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelecionadoId(a.id)}
              className={`block w-full border-b border-slate-100 p-3 text-left transition hover:bg-slate-50 ${
                selecionadoId === a.id ? 'bg-emerald-50' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate font-medium text-slate-800">
                  {a.contato_nome || formatarTelefone(a.contato_numero)}
                </span>
                <span className="shrink-0 text-xs text-slate-400">
                  {new Date(a.ultima_mensagem_em).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              {a.grupo && <p className="truncate text-xs text-slate-500">📍 {a.grupo.nome}</p>}

              <div className="mt-1.5 flex flex-wrap gap-1">
                {a.ia_escalado && !a.usuario_id && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">
                    Precisa de atendente
                  </span>
                )}
                {a.prioridade === 'alta' && (
                  <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-700">
                    Urgente
                  </span>
                )}
                {a.atendente && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] text-blue-700">
                    {a.atendente.nome}
                  </span>
                )}
                {a.status === 'aguardando_cliente' && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    Aguardando cliente
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Conversa */}
      <section
        className="flex min-w-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white"
        style={{ height: 'calc(100vh - 130px)' }}
      >
        {!selecionado ? (
          <div className="flex flex-1 items-center justify-center text-slate-400">
            Selecione um atendimento a esquerda
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {selecionado.contato_nome || formatarTelefone(selecionado.contato_numero)}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {selecionado.grupo ? `${selecionado.grupo.nome} · ` : 'Privado · '}
                  {formatarTelefone(selecionado.contato_numero)}
                  {selecionado.motivo_escalonamento && ` · ${selecionado.motivo_escalonamento}`}
                </p>
              </div>

              {!selecionado.usuario_id ? (
                <button
                  onClick={() => assumir(selecionado.id)}
                  className="rounded-lg bg-[var(--color-zap)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
                >
                  Assumir
                </button>
              ) : selecionado.usuario_id === perfil.id ? (
                <button
                  onClick={() => liberar(selecionado.id)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                >
                  Liberar
                </button>
              ) : null}

              {!['encerrado', 'resolvido'].includes(selecionado.status) && (
                <button
                  onClick={() => setModalEncerrar(true)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                >
                  Encerrar
                </button>
              )}
            </header>

            <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4">
              {mensagens.map((m) => {
                const recebida = m.direcao === 'recebida'
                const imagem = (m.raw as { image?: { imageUrl?: string } } | null)?.image?.imageUrl

                return (
                  <div key={m.id} className={`flex ${recebida ? 'justify-start' : 'justify-end'}`}>
                    <div
                      className={`max-w-[75%] rounded-2xl px-3 py-2 shadow-sm ${
                        recebida ? 'bg-white' : 'bg-[var(--color-zap-bolha)]'
                      }`}
                    >
                      {recebida && m.remetente_nome && (
                        <p className="mb-0.5 text-xs font-semibold text-[var(--color-zap)]">
                          {m.remetente_nome}
                        </p>
                      )}

                      {imagem && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imagem}
                          alt="Imagem enviada pelo contato"
                          className="mb-1 max-h-72 rounded-lg"
                        />
                      )}

                      <p className="texto-mensagem text-sm">{m.conteudo}</p>

                      <div className="mt-1 flex items-center justify-end gap-1.5">
                        {m.gerado_por_ia && (
                          <span className="rounded bg-violet-100 px-1 py-0.5 text-[10px] font-semibold text-violet-700">
                            IA
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400">
                          {new Date(m.created_at).toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={fimDaListaRef} />
            </div>

            <div className="border-t border-slate-200 p-3">
              {erroEnvio && (
                <p className="mb-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{erroEnvio}</p>
              )}

              <div className="flex items-end gap-2">
                <textarea
                  value={rascunho}
                  onChange={(e) => setRascunho(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter envia, Shift+Enter quebra linha.
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void enviar()
                    }
                  }}
                  rows={1}
                  placeholder="Escreva sua resposta... (Enter envia, Shift+Enter quebra linha)"
                  className="max-h-40 flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
                />
                <button
                  onClick={enviar}
                  disabled={enviando || !rascunho.trim()}
                  className="rounded-lg bg-[var(--color-zap)] px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {enviando ? '...' : 'Enviar'}
                </button>
              </div>

              {selecionado.origem === 'grupo' && (
                <p className="mt-1.5 text-xs text-slate-400">
                  A resposta vai para o grupo, mencionando quem abriu o chamado.
                </p>
              )}
            </div>
          </>
        )}
      </section>

      {modalEncerrar && <ModalEncerrar aoConfirmar={encerrar} aoCancelar={() => setModalEncerrar(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

function ModalEncerrar({
  aoConfirmar,
  aoCancelar,
}: {
  aoConfirmar: (problema?: string, solucao?: string) => void
  aoCancelar: () => void
}) {
  const [problema, setProblema] = useState('')
  const [solucao, setSolucao] = useState('')

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-xl">
        <div>
          <h2 className="text-lg font-semibold">Encerrar atendimento</h2>
          <p className="text-sm text-slate-500">
            Se registrar o que era e como resolveu, a IA passa a usar esse caso nos proximos
            atendimentos. Opcional -- pode pular.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Qual era o problema?</span>
          <textarea
            value={problema}
            onChange={(e) => setProblema(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Como foi resolvido?</span>
          <textarea
            value={solucao}
            onChange={(e) => setSolucao(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
        </label>

        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={aoCancelar} className="rounded-lg px-3 py-2 text-sm hover:bg-slate-100">
            Cancelar
          </button>
          <button
            onClick={() => aoConfirmar()}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
          >
            Pular e encerrar
          </button>
          <button
            onClick={() => aoConfirmar(problema, solucao)}
            disabled={!problema.trim() || !solucao.trim()}
            className="rounded-lg bg-[var(--color-zap)] px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            Salvar e encerrar
          </button>
        </div>
      </div>
    </div>
  )
}
