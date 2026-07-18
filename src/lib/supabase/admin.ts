// Cliente administrativo -- ignora RLS.
//
// Existe por um motivo so: o webhook do Z-API chega sem sessao de usuario,
// entao nao ha auth.uid() para as policies avaliarem. Nao importe este
// modulo em nada que responda a uma requisicao de usuario.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Sem tipos gerados do banco (`supabase gen types`), o cliente infere um
// schema vazio e todo insert/update vira `never`. O `any` aqui e deliberado:
// a alternativa e manter um arquivo de tipos gerado em sincronia com as
// migrations a mao. Se um dia rodar `supabase gen types typescript`, troque
// `any` por `Database` e o codigo de chamada nao muda.
type ClienteAdmin = SupabaseClient<any, 'public', any>

let cache: ClienteAdmin | null = null

export function criarClienteAdmin(): ClienteAdmin {
  if (cache) return cache

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !chave) {
    throw new Error(
      'Supabase admin nao configurado: faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY',
    )
  }

  cache = createClient<any, 'public', any>(url, chave, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return cache
}
