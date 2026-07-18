// Service worker.
//
// Deliberadamente minimo. A tentacao num PWA e cachear tudo para funcionar
// offline, mas aqui isso seria um tiro no pe: esta e uma ferramenta de
// atendimento em tempo real, e servir uma tela velha de chamados e pior do
// que nao abrir. Ja perdemos tempo neste projeto com cache servindo versao
// antiga -- nao vamos institucionalizar o problema.
//
// Entao a regra e:
//   - Navegacao e API  -> sempre rede. Sem cache, nunca.
//   - Estatico do build -> cache com atualizacao em segundo plano.
//
// O handler de fetch tambem e o que torna o app instalavel.

const CACHE = 'suporte-estatico-v1'

self.addEventListener('install', (evento) => {
  // Assume o controle sem esperar as abas antigas fecharem.
  self.skipWaiting()
  evento.waitUntil(caches.open(CACHE))
})

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    (async () => {
      // Remove caches de versoes anteriores.
      const nomes = await caches.keys()
      await Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (evento) => {
  const requisicao = evento.request

  if (requisicao.method !== 'GET') return

  const url = new URL(requisicao.url)

  // Outro dominio (Supabase, Z-API, Groq): nao interfere.
  if (url.origin !== self.location.origin) return

  // Paginas e API sempre da rede. Se a rede cair, deixa o erro aparecer --
  // e informacao honesta, melhor que dado velho disfarcado de atual.
  const ehNavegacao = requisicao.mode === 'navigate'
  const ehApi = url.pathname.startsWith('/api/')

  if (ehNavegacao || ehApi) return

  // Estatico com hash no nome (/_next/static/...) nunca muda de conteudo,
  // entao cache-first e seguro e deixa a abertura instantanea.
  evento.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const guardado = await cache.match(requisicao)
      if (guardado) return guardado

      try {
        const resposta = await fetch(requisicao)
        if (resposta.ok) cache.put(requisicao, resposta.clone())
        return resposta
      } catch (e) {
        if (guardado) return guardado
        throw e
      }
    })(),
  )
})
