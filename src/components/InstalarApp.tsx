'use client'

// Registra o service worker e oferece a instalacao do app.
//
// No Android/desktop o navegador dispara `beforeinstallprompt` e da para
// mostrar um botao proprio. No iOS nao existe esse evento -- a instalacao e
// manual pelo menu Compartilhar -> Adicionar a Tela de Inicio -- entao ali a
// unica coisa util e explicar o caminho.

import { useEffect, useState } from 'react'

interface EventoInstalacao extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const CHAVE_DISPENSADO = 'instalacao-dispensada'

export default function InstalarApp() {
  const [evento, setEvento] = useState<EventoInstalacao | null>(null)
  const [mostrarIOS, setMostrarIOS] = useState(false)

  // Registro do service worker + recarga automatica quando sai versao nova.
  //
  // Sem isto, uma aba aberta continua rodando a versao antiga ate a pessoa
  // dar refresh forcado -- e ninguem sabe que precisa. Neste projeto isso ja
  // custou varias rodadas de "nao funcionou" que na verdade eram "nao
  // atualizou", que sao problemas completamente diferentes.
  //
  // Como funciona: o sw.js chama skipWaiting() ao instalar, entao a versao
  // nova assume o controle assim que baixa. Quando isso acontece o navegador
  // dispara `controllerchange`, e a pagina se recarrega sozinha.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    let intervalo: ReturnType<typeof setInterval> | null = null

    navigator.serviceWorker
      .register('/sw.js')
      .then((registro) => {
        // Procura versao nova de tempos em tempos. Sem isso a checagem so
        // aconteceria ao abrir a aba, e um painel de atendimento fica aberto
        // o dia inteiro.
        intervalo = setInterval(() => void registro.update().catch(() => {}), 5 * 60_000)
      })
      .catch((e) => console.error('[pwa] falha ao registrar o service worker:', e))

    let recarregando = false
    const aoTrocarControlador = () => {
      // Guarda contra laco de recarga: sem ela, um erro na ativacao poderia
      // deixar a pagina recarregando sem parar.
      if (recarregando) return
      recarregando = true
      window.location.reload()
    }

    navigator.serviceWorker.addEventListener('controllerchange', aoTrocarControlador)

    return () => {
      if (intervalo) clearInterval(intervalo)
      navigator.serviceWorker.removeEventListener('controllerchange', aoTrocarControlador)
    }
  }, [])

  useEffect(() => {
    if (localStorage.getItem(CHAVE_DISPENSADO) === 'sim') return

    // Ja instalado: nao insistir.
    if (window.matchMedia('(display-mode: standalone)').matches) return

    const aoPoderInstalar = (e: Event) => {
      e.preventDefault() // impede o banner padrao, usamos o nosso
      setEvento(e as EventoInstalacao)
    }

    window.addEventListener('beforeinstallprompt', aoPoderInstalar)

    // iOS: sem beforeinstallprompt. Detecta o Safari em iPhone/iPad fora do
    // modo standalone e mostra a instrucao manual.
    const ua = navigator.userAgent
    const ehIOS = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window)
    const ehSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
    if (ehIOS && ehSafari) setMostrarIOS(true)

    return () => window.removeEventListener('beforeinstallprompt', aoPoderInstalar)
  }, [])

  function dispensar() {
    localStorage.setItem(CHAVE_DISPENSADO, 'sim')
    setEvento(null)
    setMostrarIOS(false)
  }

  async function instalar() {
    if (!evento) return
    await evento.prompt()
    await evento.userChoice
    setEvento(null)
  }

  if (!evento && !mostrarIOS) return null

  return (
    <div className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-lg sm:left-auto sm:right-4">
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icone-192.png" alt="" className="h-10 w-10 shrink-0 rounded-lg" />

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Instalar a Central de Suporte</p>
          {mostrarIOS ? (
            <p className="mt-0.5 text-xs text-slate-500">
              No Safari, toque em <strong>Compartilhar</strong> e depois em{' '}
              <strong>Adicionar a Tela de Inicio</strong>.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-slate-500">
              Abre como aplicativo, em tela cheia, e o alarme de atendimento fica mais visivel.
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={dispensar}
          className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
        >
          Agora nao
        </button>
        {evento && (
          <button
            onClick={instalar}
            className="rounded-lg bg-[var(--color-zap)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
          >
            Instalar
          </button>
        )}
      </div>
    </div>
  )
}
