'use client'

// Importar grupos direto do WhatsApp.
//
// O caminho alternativo (mandar mensagem no grupo e esperar ele aparecer)
// continua funcionando e cobre o caso de grupo criado depois. Este aqui e
// para o comeco: escolher entre os grupos que ja existem, sem adivinhacao.

import { useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'

interface GrupoDescoberto {
  grupoId: string
  nome: string
  arquivado: boolean
  ultimaMensagemEm: string | null
  jaCadastrado: boolean
  ativo: boolean
}

export default function ImportarGrupos({ aoImportar }: { aoImportar: () => void }) {
  const [grupos, setGrupos] = useState<GrupoDescoberto[] | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [importando, setImportando] = useState<string | null>(null)
  const [busca, setBusca] = useState('')

  async function buscar() {
    setCarregando(true)
    setErro(null)

    try {
      const resposta = await fetch('/api/whatsapp/grupos/descobrir')
      const corpo = (await resposta.json()) as { grupos?: GrupoDescoberto[]; erro?: string }

      if (!resposta.ok) {
        setErro(corpo.erro ?? 'Nao foi possivel consultar os grupos.')
        setGrupos(null)
      } else {
        setGrupos(corpo.grupos ?? [])
      }
    } catch {
      setErro('Falha de rede ao consultar o Z-API.')
    }

    setCarregando(false)
  }

  async function importar(grupo: GrupoDescoberto) {
    setImportando(grupo.grupoId)

    const supabase = criarClienteNavegador()
    const { error } = await supabase.from('whatsapp_grupos').insert({
      grupo_id: grupo.grupoId,
      nome: grupo.nome,
      // Entra desativado: importar e escolher, ativar e uma decisao separada.
      ativo: false,
      descricao: 'Importado da lista de grupos do WhatsApp.',
    })

    setImportando(null)

    if (error) {
      setErro(
        error.message.includes('row-level security')
          ? 'Somente administradores podem cadastrar grupos.'
          : error.message,
      )
      return
    }

    setGrupos((atual) =>
      atual?.map((g) => (g.grupoId === grupo.grupoId ? { ...g, jaCadastrado: true } : g)) ?? null,
    )
    aoImportar()
  }

  const filtrados = grupos?.filter((g) =>
    busca.trim() ? g.nome.toLowerCase().includes(busca.toLowerCase()) : true,
  )

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-slate-300 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Importar do WhatsApp</p>
          <p className="text-xs text-slate-500">
            Lista os grupos da conta conectada para voce escolher quais atender.
          </p>
        </div>
        <button
          onClick={buscar}
          disabled={carregando}
          className="rounded-lg bg-[var(--color-zap)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {carregando ? 'Buscando...' : grupos ? 'Atualizar lista' : 'Buscar meus grupos'}
        </button>
      </div>

      {erro && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{erro}</p>}

      {grupos && grupos.length === 0 && (
        <p className="text-sm text-slate-500">
          Nenhum grupo encontrado nesta conta do WhatsApp.
        </p>
      )}

      {grupos && grupos.length > 0 && (
        <>
          {grupos.length > 8 && (
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Filtrar por nome..."
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-[var(--color-zap)]"
            />
          )}

          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {filtrados?.map((g) => (
              <li
                key={g.grupoId}
                className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{g.nome}</p>
                  <p className="truncate text-xs text-slate-400">
                    {g.ultimaMensagemEm
                      ? `Ultima mensagem em ${new Date(g.ultimaMensagemEm).toLocaleDateString('pt-BR')}`
                      : g.grupoId}
                    {g.arquivado && ' · arquivado'}
                  </p>
                </div>

                {g.jaCadastrado ? (
                  <span className="shrink-0 rounded bg-slate-200 px-2 py-1 text-xs text-slate-600">
                    {g.ativo ? 'Atendendo' : 'Ja na lista'}
                  </span>
                ) : (
                  <button
                    onClick={() => importar(g)}
                    disabled={importando === g.grupoId}
                    className="shrink-0 rounded-lg border border-[var(--color-zap)] px-3 py-1 text-xs font-medium text-[var(--color-zap)] hover:bg-emerald-50 disabled:opacity-50"
                  >
                    {importando === g.grupoId ? '...' : 'Adicionar'}
                  </button>
                )}
              </li>
            ))}
          </ul>

          <p className="text-xs text-slate-500">
            Grupos importados entram <strong>desativados</strong>. Ative abaixo o que voce quer que
            seja atendido.
          </p>
        </>
      )}
    </div>
  )
}
