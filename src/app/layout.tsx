import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Central de Suporte WhatsApp',
  description: 'Atendimento em grupos de suporte com diagnostico assistido e escalonamento.',
  applicationName: 'Central de Suporte',
  appleWebApp: {
    capable: true,
    title: 'Suporte',
    // 'default' mantem a barra de status legivel sobre o fundo claro do app.
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/icone-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icone-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  formatDetection: {
    // Evita o iOS transformar numeros de telefone da lista em links.
    telephone: false,
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Nao trava o zoom: bloquear pinch-to-zoom atrapalha quem precisa ampliar.
  maximumScale: 5,
  themeColor: '#128c7e',
  // Deixa o conteudo usar a area sob o notch, com padding vindo do CSS.
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
