'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'

const LINKS = [
  { href: '/atendimento', rotulo: 'Atendimento', icone: '💬' },
  { href: '/base-conhecimento', rotulo: 'Base de conhecimento', icone: '📘' },
  { href: '/configuracoes', rotulo: 'Configuracoes', icone: '⚙️' },
]

interface StatusResposta {
  zapi: { conectado: boolean; sessaoIniciada: boolean; erro: string | null }
  ia: boolean
}

export default function Nav({ nome }: { nome: string }) {
  const caminho = usePathname()
  const router = useRouter()
  const [status, setStatus] = useState<StatusResposta | null>(null)

  // O pareamento do Z-API cai sozinho e, quando cai, nada mais chega -- sem
  // erro visivel em lugar nenhum. Conferir de minuto em minuto e o que
  // transforma "parou de funcionar misteriosamente" em um aviso na tela.
  useEffect(() => {
    const conferir = () =>
      fetch('/api/whatsapp/status')
        .then((r) => (r.ok ? r.json() : null))
        .then(setStatus)
        .catch(() => {})

    void conferir()
    const intervalo = setInterval(conferir, 60_000)
    return () => clearInterval(intervalo)
  }, [])

  async function sair() {
    await criarClienteNavegador().auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const desconectado = status && !status.zapi.conectado

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-3 py-2 sm:gap-4 sm:px-4 sm:py-3">
        <span className="text-base font-semibold text-[var(--color-zap)] sm:text-lg">
          <span className="sm:hidden">Suporte</span>
          <span className="hidden sm:inline">Central de Suporte</span>
        </span>

        <nav className="flex gap-1">
          {LINKS.map((link) => {
            const ativo = caminho.startsWith(link.href)
            return (
              <Link
                key={link.href}
                href={link.href}
                title={link.rotulo}
                className={`rounded-lg px-2.5 py-1.5 text-sm font-medium transition sm:px-3 ${
                  ativo
                    ? 'bg-[var(--color-zap)] text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <span className="md:mr-1.5" aria-hidden>
                  {link.icone}
                </span>
                {/* No celular so o icone: os tres rotulos nao cabem na barra */}
                <span className="hidden md:inline">{link.rotulo}</span>
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {status && (
            <span
              title={
                desconectado
                  ? status.zapi.erro ?? 'WhatsApp desconectado -- refaca o pareamento no Z-API'
                  : 'WhatsApp conectado'
              }
              className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium sm:px-2.5 ${
                desconectado ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  desconectado ? 'bg-red-500' : 'bg-emerald-500'
                }`}
              />
              {/* No celular fica so a bolinha colorida; o texto vai no title */}
              <span className="hidden lg:inline">
                {desconectado ? 'WhatsApp desconectado' : 'WhatsApp conectado'}
              </span>
            </span>
          )}

          {status && !status.ia && (
            <span
              title="GROQ_API_KEY ausente: todo chamado vai direto para atendente humano"
              className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700"
            >
              IA desligada
            </span>
          )}

          <span className="hidden text-sm text-slate-500 sm:inline">{nome}</span>

          <button
            onClick={sair}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            Sair
          </button>
        </div>
      </div>
    </header>
  )
}
