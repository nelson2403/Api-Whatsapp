// Cliente de servidor com a sessao do usuario (Server Components e rotas
// autenticadas). Respeita RLS.

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function criarClienteServidor() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // Server Component nao pode escrever cookie. O middleware ja
            // renova a sessao, entao ignorar aqui e seguro.
          }
        },
      },
    },
  )
}

/** Devolve o usuario logado e seu perfil, ou null. */
export async function usuarioAtual() {
  const supabase = await criarClienteServidor()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  const { data: perfil } = await supabase
    .from('whatsapp_perfis')
    .select('*')
    .eq('id', user.id)
    .maybeSingle()

  return { user, perfil }
}
