'use client'

// Cliente do navegador. Usa a chave anon e respeita RLS -- toda leitura passa
// pela sessao do atendente logado.

import { createBrowserClient } from '@supabase/ssr'

export function criarClienteNavegador() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
