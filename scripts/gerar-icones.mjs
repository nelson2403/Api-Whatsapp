// Gera os icones do PWA sem depender de ferramenta de imagem instalada.
//
// Escreve PNG na mao (IHDR + IDAT + IEND, RGBA 8 bits) porque o projeto nao
// tem nenhuma lib grafica e nao vale adicionar uma so por causa de quatro
// arquivos que quase nunca mudam.
//
// Rode com: node scripts/gerar-icones.mjs

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const VERDE = [18, 140, 126] // #128C7E, mesmo verde da interface
const BRANCO = [255, 255, 255]

function crc32(buffer) {
  let tabela = crc32.tabela
  if (!tabela) {
    tabela = crc32.tabela = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      tabela[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ tabela[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(tipo, dados) {
  const tamanho = Buffer.alloc(4)
  tamanho.writeUInt32BE(dados.length)
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(corpo))
  return Buffer.concat([tamanho, corpo, crc])
}

function png(largura, altura, pixels) {
  const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(largura, 0)
  ihdr.writeUInt32BE(altura, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // filtro adaptativo
  ihdr[12] = 0 // sem entrelacamento

  // Cada linha e prefixada pelo byte de filtro (0 = nenhum).
  const bruto = Buffer.alloc(altura * (1 + largura * 4))
  let pos = 0
  for (let y = 0; y < altura; y++) {
    bruto[pos++] = 0
    for (let x = 0; x < largura; x++) {
      const i = (y * largura + x) * 4
      bruto[pos++] = pixels[i]
      bruto[pos++] = pixels[i + 1]
      bruto[pos++] = pixels[i + 2]
      bruto[pos++] = pixels[i + 3]
    }
  }

  return Buffer.concat([
    assinatura,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(bruto, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Cobertura do pixel por um retangulo de cantos arredondados (0 a 1). */
function dentroDoArredondado(x, y, esq, topo, dir, base, raio) {
  if (x < esq || x > dir || y < topo || y > base) return 0

  const cx = Math.min(Math.max(x, esq + raio), dir - raio)
  const cy = Math.min(Math.max(y, topo + raio), base - raio)
  const d = Math.hypot(x - cx, y - cy)

  // Faixa de 1px para suavizar a borda (antialias simples).
  if (d <= raio - 0.5) return 1
  if (d >= raio + 0.5) return 0
  return raio + 0.5 - d
}

function desenhar(tamanho, { margem }) {
  const pixels = Buffer.alloc(tamanho * tamanho * 4)
  const s = tamanho

  // Balao de conversa, proporcional ao tamanho do icone.
  const bEsq = s * (margem + 0.1)
  const bDir = s * (1 - margem - 0.1)
  const bTopo = s * (margem + 0.14)
  const bBase = s * (1 - margem - 0.24)
  const bRaio = s * 0.09

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4

      // Fundo: quadrado arredondado verde ocupando o icone todo.
      const fundo = dentroDoArredondado(x, y, s * margem, s * margem, s * (1 - margem), s * (1 - margem), s * 0.22)

      let r = VERDE[0]
      let g = VERDE[1]
      let b = VERDE[2]

      let balao = dentroDoArredondado(x, y, bEsq, bTopo, bDir, bBase, bRaio)

      // Rabicho do balao: triangulo saindo da base, lado esquerdo.
      const rxIni = bEsq + (bDir - bEsq) * 0.18
      const rLargura = (bDir - bEsq) * 0.22
      const rAltura = s * 0.12
      if (y >= bBase && y <= bBase + rAltura) {
        const t = (y - bBase) / rAltura
        if (x >= rxIni && x <= rxIni + rLargura * (1 - t)) balao = 1
      }

      if (balao > 0) {
        r = BRANCO[0] * balao + r * (1 - balao)
        g = BRANCO[1] * balao + g * (1 - balao)
        b = BRANCO[2] * balao + b * (1 - balao)
      }

      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
      pixels[i + 3] = Math.round(fundo * 255)
    }
  }

  return png(s, s, pixels)
}

const destino = join(process.cwd(), 'public')
mkdirSync(destino, { recursive: true })

const arquivos = [
  // margem 0 = icone sangra ate a borda (uso normal)
  ['icone-192.png', 192, { margem: 0 }],
  ['icone-512.png', 512, { margem: 0 }],
  // maskable: o sistema recorta as bordas, entao o desenho fica menor e
  // centralizado dentro da zona segura.
  ['icone-maskable-512.png', 512, { margem: 0.1 }],
  ['apple-touch-icon.png', 180, { margem: 0 }],
]

for (const [nome, tamanho, opcoes] of arquivos) {
  writeFileSync(join(destino, nome), desenhar(tamanho, opcoes))
  console.log(`gerado public/${nome} (${tamanho}x${tamanho})`)
}
