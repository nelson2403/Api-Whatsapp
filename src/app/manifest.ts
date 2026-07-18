import type { MetadataRoute } from 'next'

// Manifest do PWA. O Next serve isto em /manifest.webmanifest e injeta o
// <link rel="manifest"> sozinho.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Central de Suporte WhatsApp',
    short_name: 'Suporte',
    description:
      'Atendimento em grupos de suporte no WhatsApp, com diagnostico automatico e alerta de escalonamento.',
    // Abre direto no painel de atendimento, nao na raiz.
    start_url: '/atendimento',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f1f5f9',
    theme_color: '#128c7e',
    lang: 'pt-BR',
    dir: 'ltr',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // maskable: o sistema recorta as bordas para encaixar no formato de
      // icone do aparelho. Sem uma versao propria, o desenho sai cortado.
      { src: '/icone-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      {
        name: 'Atendimentos',
        url: '/atendimento',
        description: 'Chamados abertos e quem precisa de atendente',
      },
      {
        name: 'Base de conhecimento',
        url: '/base-conhecimento',
        description: 'Casos que a ferramenta sabe resolver',
      },
    ],
  }
}
