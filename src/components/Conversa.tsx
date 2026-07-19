'use client'

// Painel de conversa de um atendimento.
//
// Separado do painel principal porque agora abre como gaveta sobre o quadro,
// em vez de ocupar uma coluna fixa.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'
import { formatarTelefone } from '@/lib/whatsapp/telefone'
import type { Atendimento, Mensagem, Perfil } from '@/lib/tipos'

export interface AtendimentoDetalhado extends Atendimento {
  grupo: { nome: string } | null
  atendente: { nome: string } | null
}

interface Props {
  atendimento: AtendimentoDetalhado
  perfil: Perfil
  aoFechar: () => void
  aoMudar: () => void
}

export default function Conversa({ atendimento, perfil, aoFechar, aoMudar }: Props) {
  const supabase = useMemo(() => criarClienteNavegador(), [])

  const [mensagens, setMensagens] = useState<Mensagem[]>([])
  const [rascunho, setRascunho] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [modalEncerrar, setModalEncerrar] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const [ampliada, setAmpliada] = useState<string | null>(null)

  const fimRef = useRef<HTMLDivElement>(null)
  const encerrado = ['encerrado', 'resolvido'].includes(atendimento.status)

  const carregar = useCallback(async () => {
    const { data } = await supabase
      .from('whatsapp_mensagens')
      .select('*')
      .eq('atendimento_id', atendimento.id)
      .order('created_at', { ascending: true })
      .limit(300)

    setMensagens((data ?? []) as unknown as Mensagem[])
  }, [supabase, atendimento.id])

  useEffect(() => {
    void carregar()
  }, [carregar])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const canal = supabase
      .channel(`conversa-${atendimento.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_mensagens' },
        () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => void carregar(), 800)
        },
      )
      .subscribe()

    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(canal)
    }
  }, [supabase, atendimento.id, carregar])

  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [mensagens])

  // Esc fecha a gaveta -- e a expectativa de qualquer painel sobreposto.
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (ampliada) setAmpliada(null)
      else if (!modalEncerrar) aoFechar()
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [aoFechar, ampliada, modalEncerrar])

  async function assumir() {
    setOcupado(true)
    await supabase
      .from('whatsapp_atendimentos')
      .update({ usuario_id: perfil.id, assumido_em: new Date().toISOString(), status: 'em_andamento' })
      .eq('id', atendimento.id)

    await supabase
      .from('whatsapp_alertas')
      .update({ lido_em: new Date().toISOString(), lido_por: perfil.id })
      .eq('atendimento_id', atendimento.id)
      .is('lido_em', null)

    setOcupado(false)
    aoMudar()
  }

  async function liberar() {
    setOcupado(true)
    await supabase
      .from('whatsapp_atendimentos')
      .update({ usuario_id: null, assumido_em: null })
      .eq('id', atendimento.id)
    setOcupado(false)
    aoMudar()
  }

  async function enviar() {
    const texto = rascunho.trim()
    if (!texto || enviando) return

    setEnviando(true)
    setErro(null)

    const resposta = await fetch(`/api/whatsapp/atendimentos/${atendimento.id}/responder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    })

    if (resposta.ok) {
      setRascunho('')
      await carregar()
      aoMudar()
    } else {
      const corpo = (await resposta.json().catch(() => ({}))) as { erro?: string }
      setErro(corpo.erro ?? 'Falha ao enviar. Verifique a conexao do WhatsApp.')
    }

    setEnviando(false)
  }

  async function encerrar(problema?: string, solucao?: string) {
    if (problema?.trim() && solucao?.trim()) {
      await supabase.from('whatsapp_conhecimento_aprendido').insert({
        atendimento_id: atendimento.id,
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
      .eq('id', atendimento.id)

    setModalEncerrar(false)
    aoMudar()
    aoFechar()
  }

  async function excluir() {
    const quem = atendimento.contato_nome || formatarTelefone(atendimento.contato_numero)
    if (
      !confirm(
        `Excluir o atendimento de ${quem}?\n\n` +
          'Todo o historico de mensagens dele sera apagado e nao tem como recuperar. ' +
          'O que voce registrou na base de conhecimento nao e afetado.',
      )
    ) {
      return
    }

    setOcupado(true)
    const { error } = await supabase.from('whatsapp_atendimentos').delete().eq('id', atendimento.id)
    setOcupado(false)

    if (error) {
      setErro(`Nao foi possivel excluir: ${error.message}`)
      return
    }

    aoMudar()
    aoFechar()
  }

  const origem = atendimento.grupo
    ? atendimento.grupo.nome
    : atendimento.origem === 'grupo'
      ? 'Grupo removido'
      : 'Privado'

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/40" onClick={aoFechar} aria-hidden />

      <aside
        role="dialog"
        aria-label="Conversa do atendimento"
        className="fixed inset-y-0 right-0 z-30 flex w-full flex-col bg-white shadow-2xl sm:max-w-xl"
      >
        <header className="flex items-center gap-2 border-b border-slate-200 p-3">
          <button
            onClick={aoFechar}
            aria-label="Fechar"
            className="rounded-lg px-2 py-1 text-lg text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">
              {atendimento.contato_nome || formatarTelefone(atendimento.contato_numero)}
            </p>
            <p className="truncate text-xs text-slate-500">
              {origem} · {formatarTelefone(atendimento.contato_numero)}
            </p>
          </div>
        </header>

        {/* Acesso remoto em destaque: e a primeira coisa que o atendente
            procura ao assumir um chamado que precisa de intervencao. */}
        {atendimento.acesso_remoto && (
          <div className="flex items-center gap-3 border-b border-slate-100 bg-emerald-50 px-3 py-2">
            <span className="text-lg" aria-hidden>
              🖥️
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-emerald-800">AnyDesk informado pelo cliente</p>
              <p className="font-mono text-lg font-semibold tracking-wider text-emerald-900">
                {atendimento.acesso_remoto}
              </p>
            </div>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(atendimento.acesso_remoto!)
                setErro(null)
              }}
              className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-50"
            >
              Copiar
            </button>
          </div>
        )}

        {atendimento.acesso_pedido_em && !atendimento.acesso_remoto && (
          <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            🖥️ AnyDesk pedido ao cliente, ainda sem resposta.
          </div>
        )}

        {(atendimento.motivo_escalonamento || atendimento.motivo_prioridade) && (
          <div className="border-b border-slate-100 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {atendimento.motivo_escalonamento && (
              <p>
                <strong>Escalado:</strong> {atendimento.motivo_escalonamento}
              </p>
            )}
            {atendimento.motivo_prioridade && (
              <p>
                <strong>Prioridade:</strong> {atendimento.motivo_prioridade}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-b border-slate-200 p-2">
          {!encerrado && !atendimento.usuario_id && (
            <button
              onClick={assumir}
              disabled={ocupado}
              className="rounded-lg bg-[var(--color-zap)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              Assumir
            </button>
          )}
          {!encerrado && atendimento.usuario_id === perfil.id && (
            <button
              onClick={liberar}
              disabled={ocupado}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Liberar
            </button>
          )}
          {!encerrado && (
            <button
              onClick={() => setModalEncerrar(true)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Encerrar
            </button>
          )}
          {encerrado && (
            <button
              onClick={excluir}
              disabled={ocupado}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Excluir
            </button>
          )}
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-3">
          {mensagens.map((m) => (
            <Bolha key={m.id} mensagem={m} aoAmpliar={setAmpliada} />
          ))}
          <div ref={fimRef} />
        </div>

        <div className="border-t border-slate-200 p-3">
          {erro && <p className="mb-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{erro}</p>}

          {encerrado ? (
            <p className="text-center text-sm text-slate-400">
              Atendimento encerrado. Uma nova mensagem do contato abre um chamado novo.
            </p>
          ) : (
            <>
              <div className="flex items-end gap-2">
                <textarea
                  value={rascunho}
                  onChange={(e) => setRascunho(e.target.value)}
                  onKeyDown={(e) => {
                    const noCelular = window.matchMedia('(max-width: 1023px)').matches
                    if (e.key === 'Enter' && !e.shiftKey && !noCelular) {
                      e.preventDefault()
                      void enviar()
                    }
                  }}
                  rows={1}
                  placeholder="Escreva sua resposta..."
                  className="max-h-40 flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-[var(--color-zap)] sm:text-sm"
                />
                <button
                  onClick={enviar}
                  disabled={enviando || !rascunho.trim()}
                  className="rounded-lg bg-[var(--color-zap)] px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {enviando ? '...' : 'Enviar'}
                </button>
              </div>
              {atendimento.origem === 'grupo' && (
                <p className="mt-1.5 text-xs text-slate-400">
                  A resposta vai para o grupo, mencionando quem abriu o chamado.
                </p>
              )}
            </>
          )}
        </div>
      </aside>

      {modalEncerrar && (
        <ModalEncerrar aoConfirmar={encerrar} aoCancelar={() => setModalEncerrar(false)} />
      )}

      {ampliada && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setAmpliada(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ampliada} alt="Imagem ampliada" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

function Bolha({
  mensagem,
  aoAmpliar,
}: {
  mensagem: Mensagem
  aoAmpliar: (url: string) => void
}) {
  const recebida = mensagem.direcao === 'recebida'

  // midia_url e a copia rehospedada. O fallback em raw cobre mensagens
  // gravadas antes da rehospedagem existir.
  const midia =
    mensagem.midia_url ??
    (mensagem.raw as { image?: { imageUrl?: string } } | null)?.image?.imageUrl ??
    null

  const ehImagem = mensagem.tipo === 'imagem' || mensagem.midia_tipo?.startsWith('image/')
  const ehVideo = mensagem.tipo === 'video' || mensagem.midia_tipo?.startsWith('video/')
  const ehAudio = mensagem.tipo === 'audio' || mensagem.midia_tipo?.startsWith('audio/')

  return (
    <div className={`flex ${recebida ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${
          recebida ? 'bg-white' : 'bg-[var(--color-zap-bolha)]'
        }`}
      >
        {recebida && mensagem.remetente_nome && (
          <p className="mb-0.5 text-xs font-semibold text-[var(--color-zap)]">
            {mensagem.remetente_nome}
          </p>
        )}

        {midia && ehImagem && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={midia}
            alt="Imagem enviada pelo contato"
            onClick={() => aoAmpliar(midia)}
            className="mb-1 max-h-72 cursor-zoom-in rounded-lg"
          />
        )}

        {midia && ehVideo && (
          <video src={midia} controls playsInline className="mb-1 max-h-72 rounded-lg" />
        )}

        {midia && ehAudio && <audio src={midia} controls className="mb-1 w-full" />}

        {/* Transcricao do print. Fica recolhida para nao empurrar a conversa
            para baixo, mas a um clique -- e o texto do erro costuma ser mais
            util que a propria imagem na hora de entender o chamado. */}
        {mensagem.leitura_ia && (
          <details className="mb-1 rounded-lg bg-slate-100 px-2 py-1.5">
            <summary className="cursor-pointer text-xs font-medium text-slate-600">
              🔍 O que a IA leu na imagem
            </summary>
            <p className="texto-mensagem mt-1 text-xs text-slate-700">{mensagem.leitura_ia}</p>
          </details>
        )}

        {midia && !ehImagem && !ehVideo && !ehAudio && (
          <a
            href={midia}
            target="_blank"
            rel="noreferrer"
            className="mb-1 block text-sm text-[var(--color-zap)] underline"
          >
            📎 {mensagem.midia_nome ?? 'Abrir arquivo'}
          </a>
        )}

        <p className="texto-mensagem text-sm">{mensagem.conteudo}</p>

        <div className="mt-1 flex items-center justify-end gap-1.5">
          {mensagem.gerado_por_ia && (
            <span className="rounded bg-violet-100 px-1 py-0.5 text-[10px] font-semibold text-violet-700">
              IA
            </span>
          )}
          <span className="text-[10px] text-slate-400">
            {new Date(mensagem.created_at).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      </div>
    </div>
  )
}

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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
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
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-[var(--color-zap)] sm:text-sm"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Como foi resolvido?</span>
          <textarea
            value={solucao}
            onChange={(e) => setSolucao(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-[var(--color-zap)] sm:text-sm"
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
