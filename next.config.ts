import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // As imagens recebidas pelo Z-API vem de um storage temporario de dominio
  // variavel. Sao renderizadas com <img> comum, entao nao precisam passar pelo
  // otimizador do Next -- o que evita erro de dominio nao configurado.
  images: { unoptimized: true },
}

export default nextConfig
