'use client'

// Base de conhecimento -- o que a IA pode usar para responder.
//
// Esta e a tela mais importante do sistema. A IA nao tem conhecimento proprio
// sobre a operacao: ela so consegue orientar a partir dos casos cadastrados
// aqui. Base vazia = todo chamado vai direto para atendente humano.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'
import UploadImagens from '@/components/UploadImagens'
import type { CasoConhecimento } from '@/lib/tipos'

const VAZIO = {
  titulo: '',
  categoria: '',
  sintomas: '',
  causa: '',
  passos: '',
  observacao: '',
  escalar_direto: false,
  prioridade: 0,
  ativo: true,
  urgencia_padrao: 'normal' as 'baixa' | 'normal' | 'alta',
  imagens: [] as string[],
  pedir_acesso_remoto: true,
}

type Formulario = typeof VAZIO

export default function PaginaBaseConhecimento() {
  const supabase = useMemo(() => criarClienteNavegador(), [])

  const [casos, setCasos] = useState<CasoConhecimento[]>([])
  const [form, setForm] = useState<Formulario>(VAZIO)
  const [editandoId, setEditandoId] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [busca, setBusca] = useState('')

  const carregar = useCallback(async () => {
    const { data } = await supabase
      .from('whatsapp_base_conhecimento')
      .select('*')
      .order('prioridade', { ascending: false })
      .order('titulo')

    setCasos((data ?? []) as unknown as CasoConhecimento[])
  }, [supabase])

  useEffect(() => {
    void carregar()
  }, [carregar])

  function editar(caso: CasoConhecimento) {
    setEditandoId(caso.id)
    setForm({
      titulo: caso.titulo,
      categoria: caso.categoria ?? '',
      sintomas: caso.sintomas.join('\n'),
      causa: caso.causa ?? '',
      passos: caso.passos.join('\n'),
      observacao: caso.observacao ?? '',
      escalar_direto: caso.escalar_direto,
      prioridade: caso.prioridade,
      ativo: caso.ativo,
      urgencia_padrao: caso.urgencia_padrao ?? 'normal',
      imagens: caso.imagens ?? [],
      pedir_acesso_remoto: caso.pedir_acesso_remoto ?? true,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function cancelar() {
    setEditandoId(null)
    setForm(VAZIO)
    setErro(null)
  }

  async function salvar(evento: React.FormEvent) {
    evento.preventDefault()
    setErro(null)

    // Uma linha por item -- linhas vazias sao descartadas.
    const linhas = (texto: string) =>
      texto
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)

    const sintomas = linhas(form.sintomas)
    const passos = linhas(form.passos)

    if (!form.titulo.trim()) return setErro('Informe um titulo para o caso.')
    if (sintomas.length === 0) {
      return setErro(
        'Cadastre ao menos um sintoma. E por ele que a IA reconhece o problema na mensagem do cliente.',
      )
    }
    if (passos.length === 0 && !form.escalar_direto) {
      return setErro(
        'Cadastre os passos da solucao, ou marque "sempre encaminhar para atendente" se este caso nao pode ser resolvido pelo bot.',
      )
    }

    setSalvando(true)

    const registro = {
      titulo: form.titulo.trim(),
      categoria: form.categoria.trim() || null,
      sintomas,
      causa: form.causa.trim() || null,
      passos,
      observacao: form.observacao.trim() || null,
      escalar_direto: form.escalar_direto,
      prioridade: Number(form.prioridade) || 0,
      ativo: form.ativo,
      urgencia_padrao: form.urgencia_padrao,
      imagens: form.imagens,
      pedir_acesso_remoto: form.pedir_acesso_remoto,
    }

    const { error } = editandoId
      ? await supabase.from('whatsapp_base_conhecimento').update(registro).eq('id', editandoId)
      : await supabase.from('whatsapp_base_conhecimento').insert(registro)

    setSalvando(false)

    if (error) {
      setErro(
        error.message.includes('row-level security')
          ? 'Somente administradores podem editar a base de conhecimento.'
          : error.message,
      )
      return
    }

    cancelar()
    void carregar()
  }

  async function alternarAtivo(caso: CasoConhecimento) {
    await supabase
      .from('whatsapp_base_conhecimento')
      .update({ ativo: !caso.ativo })
      .eq('id', caso.id)
    void carregar()
  }

  async function excluir(caso: CasoConhecimento) {
    if (!confirm(`Excluir o caso "${caso.titulo}"? Isso nao pode ser desfeito.`)) return
    await supabase.from('whatsapp_base_conhecimento').delete().eq('id', caso.id)
    void carregar()
  }

  const filtrados = busca.trim()
    ? casos.filter((c) =>
        [c.titulo, c.categoria ?? '', ...c.sintomas]
          .join(' ')
          .toLowerCase()
          .includes(busca.toLowerCase()),
      )
    : casos

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4">
      <div>
        <h1 className="text-xl font-semibold">Base de conhecimento</h1>
        <p className="text-sm text-slate-500">
          Cada caso aqui e um problema que a ferramenta sabe resolver sozinha. A IA nao inventa
          procedimento: se nenhum caso corresponder ao que o cliente relatou, ela chama voce.
        </p>
      </div>

      {/* Formulario */}
      <form onSubmit={salvar} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-medium">{editandoId ? 'Editando caso' : 'Novo caso'}</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-sm font-medium">Titulo</span>
            <input
              value={form.titulo}
              onChange={(e) => setForm({ ...form, titulo: e.target.value })}
              placeholder="Ex: Impressora fiscal nao imprime"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
            />
          </label>

          <label className="space-y-1">
            <span className="text-sm font-medium">Categoria</span>
            <input
              value={form.categoria}
              onChange={(e) => setForm({ ...form, categoria: e.target.value })}
              placeholder="Ex: Impressora, Rede, Sistema"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Sintomas <span className="font-normal text-slate-500">(um por linha)</span>
          </span>
          <textarea
            value={form.sintomas}
            onChange={(e) => setForm({ ...form, sintomas: e.target.value })}
            rows={4}
            placeholder={
              'Escreva do jeito que o cliente fala, nao do jeito tecnico:\nimpressora nao imprime\nnao sai cupom\na impressora travou\nnao ta saindo nota'
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
          <span className="text-xs text-slate-500">
            Quanto mais variacoes, melhor o reconhecimento. E por aqui que a IA liga a mensagem ao
            caso certo.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Causa provavel (opcional)</span>
          <input
            value={form.causa}
            onChange={(e) => setForm({ ...form, causa: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Passos da solucao <span className="font-normal text-slate-500">(um por linha, na ordem)</span>
          </span>
          <textarea
            value={form.passos}
            onChange={(e) => setForm({ ...form, passos: e.target.value })}
            rows={6}
            placeholder={
              'Verifique se o cabo USB esta conectado na impressora e no computador\nDesligue a impressora, aguarde 10 segundos e ligue novamente\nConfira se a luz verde esta acesa\nAbra o sistema e tente imprimir de novo'
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
          <span className="text-xs text-slate-500">
            A IA envia os passos nesta ordem, sem pular e sem inventar.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Observacao final (opcional)</span>
          <textarea
            value={form.observacao}
            onChange={(e) => setForm({ ...form, observacao: e.target.value })}
            rows={2}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          />
        </label>

        <UploadImagens
          imagens={form.imagens}
          aoMudar={(imagens) => setForm({ ...form, imagens })}
        />

        <label className="block space-y-1">
          <span className="text-sm font-medium">Urgencia deste problema</span>
          <select
            value={form.urgencia_padrao}
            onChange={(e) =>
              setForm({ ...form, urgencia_padrao: e.target.value as 'baixa' | 'normal' | 'alta' })
            }
            className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--color-zap)]"
          >
            <option value="baixa">Baixa - pode esperar</option>
            <option value="normal">Normal - atender no fluxo</option>
            <option value="alta">Urgente - operacao parada</option>
          </select>
          <span className="block text-xs text-slate-500">
            Quando a IA reconhecer este caso, o chamado entra na fila com esta prioridade. Quem
            sabe o que para a operacao e voce, nao a IA -- por isso a urgencia vem daqui e nao de
            um palpite sobre o texto da mensagem.
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.escalar_direto}
              onChange={(e) => setForm({ ...form, escalar_direto: e.target.checked })}
              className="h-4 w-4"
            />
            Sempre encaminhar para atendente
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.pedir_acesso_remoto}
              onChange={(e) => setForm({ ...form, pedir_acesso_remoto: e.target.checked })}
              className="h-4 w-4"
            />
            Pedir AnyDesk ao escalar
          </label>

          <label className="flex items-center gap-2 text-sm">
            Prioridade
            <input
              type="number"
              value={form.prioridade}
              onChange={(e) => setForm({ ...form, prioridade: Number(e.target.value) })}
              className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm"
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.ativo}
              onChange={(e) => setForm({ ...form, ativo: e.target.checked })}
              className="h-4 w-4"
            />
            Ativo
          </label>
        </div>

        <p className="text-xs text-slate-500">
          Marque &quot;sempre encaminhar&quot; em casos que exigem decisao, acesso fisico ou
          envolvem dinheiro. Nesses, a IA reconhece o problema mas nao tenta resolver -- chama voce
          direto.
        </p>

        {erro && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{erro}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={salvando}
            className="rounded-lg bg-[var(--color-zap)] px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {salvando ? 'Salvando...' : editandoId ? 'Salvar alteracoes' : 'Adicionar caso'}
          </button>
          {editandoId && (
            <button
              type="button"
              onClick={cancelar}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
            >
              Cancelar
            </button>
          )}
        </div>
      </form>

      {/* Lista */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-medium">Casos cadastrados ({casos.length})</h2>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar..."
            className="ml-auto rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-[var(--color-zap)]"
          />
        </div>

        {casos.length === 0 && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            Nenhum caso cadastrado ainda. Enquanto a base estiver vazia, a IA nao responde nada --
            todo chamado vai direto para atendente humano.
          </p>
        )}

        {filtrados.map((caso) => (
          <article
            key={caso.id}
            className={`rounded-xl border bg-white p-4 ${
              caso.ativo ? 'border-slate-200' : 'border-slate-200 opacity-60'
            }`}
          >
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="font-medium">{caso.titulo}</h3>
                <p className="text-xs text-slate-500">
                  {caso.categoria && `${caso.categoria} · `}
                  {caso.sintomas.length} sintomas · {caso.passos.length} passos
                  {caso.vezes_usado > 0 &&
                    ` · usado ${caso.vezes_usado}x, resolveu ${caso.vezes_resolveu}x`}
                </p>
              </div>

              {caso.escalar_direto && (
                <span className="rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                  Sempre humano
                </span>
              )}
              {!caso.ativo && (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  Inativo
                </span>
              )}
            </div>

            <p className="mt-2 line-clamp-2 text-sm text-slate-600">
              {caso.sintomas.slice(0, 4).join(' · ')}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => editar(caso)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50"
              >
                Editar
              </button>
              <button
                onClick={() => alternarAtivo(caso)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50"
              >
                {caso.ativo ? 'Desativar' : 'Ativar'}
              </button>
              <button
                onClick={() => excluir(caso)}
                className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
              >
                Excluir
              </button>
            </div>
          </article>
        ))}
      </div>
    </main>
  )
}
