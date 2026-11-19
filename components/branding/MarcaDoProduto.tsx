import { LOGOTIPO, SIMBOLO } from "@/lib/branding/desenho";
import { cn } from "@/lib/utils";

/**
 * Marca vetorial do produto. Só aparece quando nenhuma instalação ou
 * organização configurou a própria marca (`marcaEhADoProduto`).
 *
 * Continua inline para acompanhar o tema sem publicar um logo estático em
 * `public/`, que seria servido também pelas instalações dos revendedores.
 * O símbolo e as letras vêm dos contornos de `docs/brand/clientix-logo.svg`;
 * o X claro usa verde para continuar legível sobre fundo claro.
 */
type Props = {
  readonly nome: string;
  readonly className?: string;
  /** `true` quando o texto ao lado já nomeia a marca — evita ler duas vezes. */
  readonly decorativo?: boolean;
};

const SIMBOLO_CLARO_ESCURO = "fill-[#017a32] dark:fill-[#01fa4e]";
const NOME_CLARO_ESCURO = "fill-[#017a32] dark:fill-[#f5f5f5]";
const SUFIXO_CLARO_ESCURO = "fill-[#017a32] dark:fill-[#01fa4e]";

// As classes repetem os hexes de `CORES_DA_MARCA` porque o Tailwind só inclui
// utilitários com valores literais. O teste da marca mantém os dois alinhados.
export const CLASSES_DE_COR = {
  simbolo: SIMBOLO_CLARO_ESCURO,
  nome: NOME_CLARO_ESCURO,
  sufixo: SUFIXO_CLARO_ESCURO,
} as const;

function acessibilidade(nome: string, decorativo: boolean) {
  return decorativo
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": nome } as const);
}

/** O símbolo sozinho, usado na barra recolhida e em espaços compactos. */
export function SimboloDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox={SIMBOLO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <path className={SIMBOLO_CLARO_ESCURO} d={SIMBOLO.d} />
    </svg>
  );
}

/** Logotipo completo, com proporção e contornos dos SVGs fornecidos. */
export function LogotipoDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox={LOGOTIPO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <path
        className={SIMBOLO_CLARO_ESCURO}
        transform={LOGOTIPO.simbolo.transform}
        d={LOGOTIPO.simbolo.d}
      />
      <g transform={LOGOTIPO.letrasTransform}>
        {LOGOTIPO.letras.map((glifo, indice) => (
          <path
            key={`${glifo.papel}-${indice}`}
            className={glifo.papel === "sufixo" ? SUFIXO_CLARO_ESCURO : NOME_CLARO_ESCURO}
            transform={glifo.transform}
            d={glifo.d}
          />
        ))}
      </g>
      {/* Contorno textual para extração; o aria-label acima é o nome acessível. */}
      <text x="0" y="0" fontSize="0" opacity="0" aria-hidden="true">
        {nome}
      </text>
    </svg>
  );
}
