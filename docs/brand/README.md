# Marca

## Símbolo e logotipo

| Arquivo | O que é |
|---|---|
| `Clientix-icon.svg` | Exportação quadrada de alta resolução do símbolo Clientix. |
| `clientix-logo.svg` | Logotipo vetorial para fundo claro, em verde `#017a32`. |
| `clientix-logo-dark.svg` | Logotipo para fundo escuro, com letras claras e X verde `#01fa4e`. |

O X da versão clara foi ajustado para `#017a32`: o arquivo recebido o deixava
branco sobre transparência, invisível em superfícies claras.

**Os SVGs são a fonte; o app usa a geometria vetorial de `clientix-logo.svg` em
`lib/branding/desenho.ts`.** `components/branding/MarcaDoProduto.tsx` desenha o
logotipo inline na barra lateral e na entrada. `app/icon.tsx` e o ícone do app
usam o mesmo símbolo vetorial. Ele só aparece quando ninguém configurou marca
própria (`marcaEhADoProduto`, em `lib/branding.ts`); nenhum logo fixo é publicado
em `public/`, que serve também as instalações dos revendedores.

O `Clientix-icon.svg` é o export de alta resolução para materiais visuais. A
interface usa o contorno vetorial compartilhado com o logotipo para manter o
favicon nítido, leve e compatível com o branding dinâmico por instalação.
Ao revisar a arte, atualize os três SVGs e a geometria em `desenho.ts`.

Materiais de marketing e a LP mantêm seus próprios artefatos; eles não são carregados
pela imagem Docker do sistema nem alteram o white-label da instalação.

Capturas históricas da prova pela tela (2026-09-08, Supabase local fresco do
`baseline.sql`, marca sem configurar). Elas mostram a geometria anterior e
precisam ser renovadas para documentar visualmente este novo logotipo:

| Imagem | O que mostra |
|---|---|
| `evidence/marca/crm-login-claro.png` | Fachada de entrada com o logotipo, tema claro |
| `evidence/marca/crm-login-escuro.png` | A mesma fachada no escuro: sálvia clara e nome em creme |
| `evidence/marca/crm-sidebar-aberta.png` | Barra lateral aberta com o logotipo |
| `evidence/marca/crm-sidebar-aberta-escura.png` | Barra aberta no escuro |
| `evidence/marca/crm-sidebar-recolhida.png` | Barra recolhida (64px) só com o símbolo |
| `evidence/marca/crm-sidebar-recolhida-escura.png` | Barra recolhida no escuro |
| `evidence/marca/favicon-produto.png` | `/icon` gerado em runtime com o símbolo |
| `evidence/marca/crm-login-revendedor.png` | Controle negativo: com `platform_branding.app_name` gravado, a fachada fica sem o desenho |
| `evidence/marca/favicon-revendedor.png` | Controle negativo: o favicon volta à inicial sobre a cor de destaque |
| `evidence/marca/lp-cabecalho.png` | Cabeçalho da LP (`deskcomm-site`) com o logotipo |
| `evidence/marca/lp-rodape.png` | Rodapé da LP com o símbolo |

## Social preview (Open Graph)

`og-social-preview.png` — 1280×640, é a imagem que aparece quando um link do
repositório é compartilhado no X, LinkedIn, WhatsApp, Slack ou Discord. O PNG
versionado ainda é uma captura anterior; regenere-o pelo HTML abaixo antes de
enviá-lo como social preview.

**Como aplicar:** GitHub → Settings → General → *Social preview* → Upload.
Não existe endpoint público na API para isso; é upload pela interface.

**Como regerar** (depois de mudar posicionamento, chips ou paleta):

```bash
# edite docs/brand/og-card.html, depois:
node -e '
import("@playwright/test").then(async ({ chromium }) => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  await p.goto("file://" + process.cwd() + "/docs/brand/og-card.html", { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: "docs/brand/og-social-preview.png" });
  await b.close();
});'
```

A fonte fica versionada de propósito: card cuja origem se perde vira arte que
ninguém consegue atualizar quando o posicionamento muda — e aí ou envelhece
mentindo, ou é refeito do zero com outra identidade.

## Regras da arte

- Paleta lida de `app/globals.css` (creme `#faf9f6`, sage `#506d48`, texto
  `#1c1a16`). O card usa a identidade real do produto, não uma criada para ele.
- Tipografia: Atkinson Hyperlegible (títulos) + IBM Plex Mono (rótulos), as
  mesmas da aplicação.
- O painel direito é a doutrina do sistema vivo virando imagem: o rastro que uma
  demanda deixa ao atravessar o sistema, terminando no follow-up — o mecanismo
  anti-morte. É o argumento do produto mostrado, não adjetivado.
- Card de compartilhamento **sempre** carrega o logotipo (lido de
  `clientix-logo.svg`). Sem ele, quem vê a imagem não sabe de quem ela é.
