'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'

function FormularioLogin() {
  const router = useRouter()
  const parametros = useSearchParams()
  const supabase = criarClienteNavegador()

  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(false)

  async function entrar(evento: React.FormEvent) {
    evento.preventDefault()
    setCarregando(true)
    setErro(null)

    const { error } = await supabase.auth.signInWithPassword({ email, password: senha })

    if (error) {
      setErro(
        error.message === 'Invalid login credentials'
          ? 'E-mail ou senha incorretos.'
          : error.message,
      )
      setCarregando(false)
      return
    }

    router.push(parametros.get('proximo') || '/atendimento')
    router.refresh()
  }

  return (
    <form onSubmit={entrar} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-8 shadow-lg">
      <div className="space-y-1 text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-zap)] text-2xl">
          💬
        </div>
        <h1 className="text-xl font-semibold">Central de Suporte</h1>
        <p className="text-sm text-slate-500">Entre para acessar o painel de atendimento</p>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">E-mail</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-[var(--color-zap)] focus:ring-2 focus:ring-[var(--color-zap)]/20"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Senha</span>
        <input
          type="password"
          required
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          autoComplete="current-password"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-[var(--color-zap)] focus:ring-2 focus:ring-[var(--color-zap)]/20"
        />
      </label>

      {erro && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{erro}</p>}

      <button
        type="submit"
        disabled={carregando}
        className="w-full rounded-lg bg-[var(--color-zap)] py-2.5 font-medium text-white transition hover:brightness-110 disabled:opacity-60"
      >
        {carregando ? 'Entrando...' : 'Entrar'}
      </button>

      <p className="text-center text-xs text-slate-400">
        O primeiro usuario criado no Supabase vira administrador automaticamente.
      </p>
    </form>
  )
}

export default function PaginaLogin() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <Suspense fallback={<div className="text-slate-400">Carregando...</div>}>
        <FormularioLogin />
      </Suspense>
    </main>
  )
}
