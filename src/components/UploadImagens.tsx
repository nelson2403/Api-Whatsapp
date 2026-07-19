'use client'

// Imagens de exemplo de um caso da base de conhecimento.
//
// Servem a dois publicos ao mesmo tempo: o atendente, que reconhece o caso de
// relance, e o modelo de visao, que compara o print enviado pelo cliente com
// "e assim que este problema aparece".

import { useRef, useState } from 'react'
import { criarClienteNavegador } from '@/lib/supabase/client'

const TAMANHO_MAXIMO = 5 * 1024 * 1024
const TIPOS_ACEITOS = ['image/jpeg', 'image/png', 'image/webp']
const MAXIMO_POR_CASO = 4

export default function UploadImagens({
  imagens,
  aoMudar,
}: {
  imagens: string[]
  aoMudar: (imagens: string[]) => void
}) {
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function enviar(arquivos: FileList | null) {
    if (!arquivos?.length) return

    setErro(null)

    const restante = MAXIMO_POR_CASO - imagens.length
    if (restante <= 0) {
      setErro(`Maximo de ${MAXIMO_POR_CASO} imagens por caso.`)
      return
    }

    setEnviando(true)
    const supabase = criarClienteNavegador()
    const novas: string[] = []

    for (const arquivo of Array.from(arquivos).slice(0, restante)) {
      if (!TIPOS_ACEITOS.includes(arquivo.type)) {
        setErro(`"${arquivo.name}" nao e JPG, PNG ou WEBP.`)
        continue
      }
      if (arquivo.size > TAMANHO_MAXIMO) {
        setErro(`"${arquivo.name}" passa de 5 MB.`)
        continue
      }

      const extensao = arquivo.name.split('.').pop()?.toLowerCase() || 'jpg'
      const caminho = `conhecimento/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extensao}`

      const { error } = await supabase.storage.from('midias').upload(caminho, arquivo, {
        contentType: arquivo.type,
        upsert: false,
      })

      if (error) {
        setErro(
          error.message.includes('row-level security') || error.message.includes('Unauthorized')
            ? 'Sem permissao para enviar imagem. Confira se voce e administrador e se a migration 0005 foi aplicada.'
            : `Falha ao enviar "${arquivo.name}": ${error.message}`,
        )
        continue
      }

      novas.push(supabase.storage.from('midias').getPublicUrl(caminho).data.publicUrl)
    }

    setEnviando(false)
    if (inputRef.current) inputRef.current.value = ''
    if (novas.length) aoMudar([...imagens, ...novas])
  }

  // Remove so da lista do caso. O arquivo fica no Storage de proposito: ele
  // pode estar referenciado por outro caso, e lixo em bucket custa pouco
  // perto de quebrar a imagem de um caso que ainda usa.
  function remover(url: string) {
    aoMudar(imagens.filter((i) => i !== url))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Imagens de exemplo</span>
        <span className="text-xs text-slate-500">
          ({imagens.length}/{MAXIMO_POR_CASO})
        </span>
      </div>

      <p className="text-xs text-slate-500">
        Prints de como esse problema costuma chegar. A IA compara a foto que o cliente enviar com
        estas para reconhecer o caso.
      </p>

      {imagens.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imagens.map((url) => (
            <div key={url} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt="Exemplo cadastrado"
                className="h-24 w-24 rounded-lg border border-slate-200 object-cover"
              />
              <button
                type="button"
                onClick={() => remover(url)}
                aria-label="Remover imagem"
                className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-xs text-white shadow hover:bg-red-700"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {imagens.length < MAXIMO_POR_CASO && (
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={enviando}
          onChange={(e) => enviar(e.target.files)}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-200"
        />
      )}

      {enviando && <p className="text-xs text-slate-500">Enviando...</p>}
      {erro && <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700">{erro}</p>}
    </div>
  )
}
