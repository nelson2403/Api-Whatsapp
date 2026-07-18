// Estado da conexao com o WhatsApp.
//
// O pareamento por QR code do Z-API cai sozinho -- celular sem bateria,
// WhatsApp Web deslogado em outro lugar, plano vencido. Quando cai, tudo
// para de funcionar sem nenhum erro visivel: o webhook simplesmente nao
// recebe mais nada. O painel consulta esta rota para mostrar o aviso.

import { NextResponse } from 'next/server'
import { criarClienteServidor } from '@/lib/supabase/server'
import { statusInstancia, zapiConfigurado } from '@/lib/whatsapp/zapi'
import { iaDisponivel } from '@/lib/whatsapp/ia'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await criarClienteServidor()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ erro: 'Nao autenticado' }, { status: 401 })

  if (!zapiConfigurado()) {
    return NextResponse.json({
      zapi: { conectado: false, sessaoIniciada: false, erro: 'Z-API nao configurado' },
      ia: iaDisponivel(),
    })
  }

  return NextResponse.json({
    zapi: await statusInstancia(),
    ia: iaDisponivel(),
  })
}
