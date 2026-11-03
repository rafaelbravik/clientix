"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

const ETAPAS = ["Boas-vindas", "Proprietário", "Plataforma", "Revisão"] as const;

type DadosDoProprietario = {
  full_name: string;
  email: string;
  phone: string;
  password: string;
  password_confirmation: string;
};

export function SetupWizard() {
  const t = useT();
  const [etapa, setEtapa] = useState(0);
  const [token, setToken] = useState("");
  const [proprietario, setProprietario] = useState<DadosDoProprietario>({
    full_name: "",
    email: "",
    phone: "",
    password: "",
    password_confirmation: "",
  });
  const [nomeDaPlataforma, setNomeDaPlataforma] = useState("Clientix");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [concluido, setConcluido] = useState(false);

  async function continuar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErro(null);

    if (etapa === 0) {
      if (token.trim().length < 32) {
        setErro(t("Informe o token fornecido pelo operador desta instalação."));
        return;
      }
      setEtapa(1);
      return;
    }
    if (etapa === 1) {
      if (proprietario.password !== proprietario.password_confirmation) {
        setErro(t("As senhas não coincidem."));
        return;
      }
      setEtapa(2);
      return;
    }
    if (etapa === 2) {
      setEtapa(3);
      return;
    }

    setEnviando(true);
    try {
      const response = await fetch("/api/setup/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          bootstrap_token: token,
          full_name: proprietario.full_name,
          email: proprietario.email,
          phone: proprietario.phone || undefined,
          password: proprietario.password,
          password_confirmation: proprietario.password_confirmation,
          platform_name: nomeDaPlataforma,
        }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        data?: { initialized?: boolean };
      };
      if (!response.ok || !payload.data?.initialized) {
        setErro(payload.error?.message ?? "Não foi possível concluir a configuração. Verifique os dados e tente novamente.");
        return;
      }
      setToken("");
      setProprietario((atual) => ({ ...atual, password: "", password_confirmation: "" }));
      setConcluido(true);
    } catch {
      setErro("Não foi possível falar com o servidor. Tente novamente.");
    } finally {
      setEnviando(false);
    }
  }

  function atualizarProprietario(campo: keyof DadosDoProprietario, valor: string) {
    setProprietario((atual) => ({ ...atual, [campo]: valor }));
  }

  if (concluido) {
    return (
      <Card className="mx-auto w-full max-w-2xl">
        <CardHeader>
          <p className="text-sm font-medium text-accent">{t("Configuração concluída")}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t("A plataforma está pronta")}</h1>
          <CardDescription>
            {t("O bootstrap foi encerrado. Entre com o e-mail e a senha do proprietário para administrar a instalação.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            {t("O proprietário tem acesso global. A conta não foi vinculada a uma empresa; você poderá criar empresas e escolher o plano no painel.")}
          </p>
          <Button asChild className="w-full sm:w-auto">
            <Link href="/login?next=%2Fadmin">{t("Entrar no painel global")}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader className="space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-accent">{t("Configuração inicial")}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{t("Configurar Clientix")}</h1>
          <CardDescription>
            {etapa === 0
              ? t("Esta instalação ainda não possui um proprietário configurado. Use o token entregue pelo operador do servidor.")
              : etapa === 1
                ? t("Crie o proprietário da plataforma. Este usuário terá acesso administrativo global.")
                : etapa === 2
                  ? t("Defina o nome exibido para esta instalação. Você poderá ajustar a identidade visual depois.")
                  : t("Confira os dados antes de finalizar. A senha não aparece nesta revisão.")}
          </CardDescription>
        </div>
        <div className="space-y-2">
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={t("Progresso da configuração")}
            aria-valuemin={0}
            aria-valuemax={4}
            aria-valuenow={etapa + 1}
          >
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${((etapa + 1) / 4) * 100}%` }} />
          </div>
          <ol className="grid grid-cols-4 gap-2 text-xs text-muted-foreground" aria-label={t("Etapas da configuração")}>
            {ETAPAS.map((nome, indice) => (
              <li key={nome} aria-current={indice === etapa ? "step" : undefined} className={indice <= etapa ? "font-medium text-foreground" : ""}>
                <span className="sr-only">{t("Etapa")} {indice + 1}: </span>
                {indice === 0 ? t("Boas-vindas") : indice === 1 ? t("Proprietário") : indice === 2 ? t("Plataforma") : t("Revisão")}
              </li>
            ))}
          </ol>
        </div>
      </CardHeader>

      <CardContent>
        <form onSubmit={continuar} className="space-y-6" noValidate={etapa === 0}>
          {etapa === 0 && (
            <div className="space-y-2">
              <Label htmlFor="bootstrap-token">{t("Token de configuração")}</Label>
              <Input
                id="bootstrap-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                aria-describedby="bootstrap-token-help"
                required
              />
              <p id="bootstrap-token-help" className="text-xs text-muted-foreground">
                {t("O token é validado no servidor e não é armazenado no navegador.")}
              </p>
            </div>
          )}

          {etapa === 1 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="owner-name">{t("Nome completo")}</Label>
                <Input id="owner-name" autoComplete="name" value={proprietario.full_name} onChange={(event) => atualizarProprietario("full_name", event.target.value)} minLength={2} maxLength={120} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="owner-email">{t("E-mail")}</Label>
                <Input id="owner-email" type="email" autoComplete="email" value={proprietario.email} onChange={(event) => atualizarProprietario("email", event.target.value)} maxLength={254} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="owner-phone">{t("Telefone")} <span className="text-muted-foreground">({t("opcional")})</span></Label>
                <Input id="owner-phone" type="tel" autoComplete="tel" value={proprietario.phone} onChange={(event) => atualizarProprietario("phone", event.target.value)} maxLength={32} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="owner-password">{t("Senha")}</Label>
                <Input id="owner-password" type="password" autoComplete="new-password" value={proprietario.password} onChange={(event) => atualizarProprietario("password", event.target.value)} minLength={8} maxLength={256} required />
                <p className="text-xs text-muted-foreground">{t("Use 8 ou mais caracteres, com letra, número e símbolo.")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="owner-password-confirmation">{t("Confirmar senha")}</Label>
                <Input id="owner-password-confirmation" type="password" autoComplete="new-password" value={proprietario.password_confirmation} onChange={(event) => atualizarProprietario("password_confirmation", event.target.value)} minLength={8} maxLength={256} required />
              </div>
            </div>
          )}

          {etapa === 2 && (
            <div className="space-y-2">
              <Label htmlFor="platform-name">{t("Nome da instalação")}</Label>
              <Input id="platform-name" value={nomeDaPlataforma} onChange={(event) => setNomeDaPlataforma(event.target.value)} minLength={1} maxLength={80} required />
              <p className="text-xs text-muted-foreground">{t("Esse nome será usado na identidade global da plataforma.")}</p>
            </div>
          )}

          {etapa === 3 && (
            <dl className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t("Proprietário")}</dt>
                <dd className="font-medium">{proprietario.full_name}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("E-mail")}</dt>
                <dd className="break-all font-medium">{proprietario.email}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">{t("Nome da instalação")}</dt>
                <dd className="font-medium">{nomeDaPlataforma}</dd>
              </div>
              <p className="text-sm text-muted-foreground sm:col-span-2">
                {t("O usuário será proprietário global e não receberá papel de administrador de empresa. A configuração inicial só poderá ser concluída uma vez.")}
              </p>
            </dl>
          )}

          {erro && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{erro}</p>}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
            {etapa > 0 ? (
              <Button type="button" variant="secondary" onClick={() => { setErro(null); setEtapa((atual) => atual - 1); }} disabled={enviando}>
                {t("Voltar")}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={enviando}>
              {enviando ? t("Finalizando…") : etapa === 0 ? t("Começar configuração") : etapa === 3 ? t("Finalizar configuração") : t("Continuar")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
