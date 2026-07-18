// Middleware de autenticacao.
//
// ATENCAO -- este arquivo ja causou um bug de producao na versao anterior
// desta ferramenta, e a causa nao era obvia:
//
//   Se a rota do webhook NAO estiver na allowlist publica, o Next.js
//   redireciona a chamada do Z-API para a tela de login (ele nao tem sessao).
//   O handler do webhook nunca executa, e portanto NAO GERA LOG NENHUM.
//   O sintoma e "nao esta chegando mensagem nenhuma" quando na verdade esta
//   chegando e sendo barrada antes de chegar no codigo.
//
// Se um dia o webhook parecer morto, o primeiro lugar a olhar e aqui.

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/** Prefixos que NAO exigem sessao. */
const ROTAS_PUBLICAS = [
  '/api/webhooks/', // chamado pelo Z-API, sem sessao -- protegido pelo segredo na URL
  '/api/cron/', // chamado pelo agendador -- protegido pelo CRON_SECRET
  '/login',
  '/auth/',
]

function ehPublica(caminho: string): boolean {
  return ROTAS_PUBLICAS.some((prefixo) => caminho.startsWith(prefixo))
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (ehPublica(pathname)) return NextResponse.next()

  // Sem as variaveis do Supabase, createServerClient lanca -- e uma excecao
  // no middleware derruba TODAS as rotas com MIDDLEWARE_INVOCATION_FAILED,
  // um erro que nao diz o que faltou.
  //
  // A pegadinha: variaveis NEXT_PUBLIC_* sao gravadas no bundle durante o
  // build. Adicionar na Vercel depois do deploy nao tem efeito nenhum ate
  // rodar um Redeploy.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const chaveAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !chaveAnon) {
    const faltando = [
      !url ? 'NEXT_PUBLIC_SUPABASE_URL' : null,
      !chaveAnon ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY' : null,
    ]
      .filter(Boolean)
      .join(', ')

    console.error(`[middleware] variaveis de ambiente ausentes: ${faltando}`)

    return NextResponse.json(
      {
        erro: 'Aplicacao nao configurada',
        faltando: faltando.split(', '),
        comoResolver:
          'Adicione as variaveis em Vercel > Settings > Environment Variables e rode um Redeploy. ' +
          'Variaveis NEXT_PUBLIC_* so entram no bundle durante o build, entao adicionar sem redeploy nao resolve.',
      },
      { status: 503 },
    )
  }

  let resposta = NextResponse.next({ request })

  const supabase = createServerClient(
    url,
    chaveAnon,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          resposta = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            resposta.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // getUser() revalida o token no servidor. Nao troque por getSession(), que
  // confia no cookie sem verificar.
  //
  // O try/catch nao e decorativo: sem cookie de sessao esta chamada pode
  // lancar (AuthSessionMissingError, falha de rede ao contatar o Supabase),
  // e excecao em middleware derruba a requisicao inteira com
  // MIDDLEWARE_INVOCATION_FAILED -- 500 em toda pagina e toda API, inclusive
  // no caminho de quem so queria chegar na tela de login.
  //
  // Falhar aqui significa "nao consegui provar que esta autenticado", que e
  // exatamente o mesmo tratamento de nao estar: manda para o login.
  let user = null
  try {
    const resultado = await supabase.auth.getUser()
    user = resultado.data.user
  } catch (e) {
    console.error('[middleware] falha ao validar a sessao:', e)
  }

  if (!user) {
    // API responde 401; navegacao vai para o login.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ erro: 'Nao autenticado' }, { status: 401 })
    }

    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('proximo', pathname)
    return NextResponse.redirect(url)
  }

  return resposta
}

export const config = {
  matcher: [
    // Tudo, exceto estaticos e imagens.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp3|ico)$).*)',
  ],
}
