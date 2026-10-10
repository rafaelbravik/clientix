"use client";
import React, { useState, useEffect } from "react";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CircleNotch, MagnifyingGlass } from "@/lib/ui/icons";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface AuditEventItem {
  id: string;
  license_id: string | null;
  installation_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  actor: string;
  created_at: string;
}

export default function AdminAuditPage() {
  const t = useT();
  const tag = useTagDeIdioma();
  const [events, setEvents] = useState<AuditEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (eventTypeFilter) params.set("event_type", eventTypeFilter);
      if (fromDate) params.set("from_date", fromDate);
      if (toDate) params.set("to_date", toDate);

      const res = await fetch(`/api/v1/admin/licensing/audit?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setEvents(json.data || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, []);

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchEvents();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("Trilha de Auditoria")}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "Eventos append-only de emissão, ativação, PoP, heartbeat e operações administrativas.",
            )}
          </p>
        </div>
      </div>

      <LicensingNav />

      {/* Filter Bar */}
      <form
        onSubmit={handleFilterSubmit}
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
      >
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <Input
            placeholder="Filtrar por tipo de evento (ex: LICENSE_CREATED)"
            value={eventTypeFilter}
            onChange={(e) => setEventTypeFilter(e.target.value)}
            className="w-64"
          />
          <Input
            type="date"
            placeholder="De"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-40"
          />
          <Input
            type="date"
            placeholder={t("Até")}
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-40"
          />
          <Button type="submit" variant="secondary" size="sm">
            <MagnifyingGlass className="mr-1.5 h-4 w-4" /> Filtrar
          </Button>
        </div>
      </form>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center p-8 text-center text-muted-foreground">
            <CircleNotch className="mr-2 h-5 w-5 animate-spin" /> Carregando eventos de auditoria...
          </div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("Nenhum evento registrado com os filtros aplicados.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3">Data / Hora (UTC)</th>
                  <th className="px-4 py-3">Tipo de Evento</th>
                  <th className="px-4 py-3">Ator</th>
                  <th className="px-4 py-3">{t("Licença / Instalação")}</th>
                  <th className="px-4 py-3">Payload (Sanitizado)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((evt) => (
                  <tr key={evt.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">
                      {new Date(evt.created_at).toLocaleString(tag)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-foreground">
                      {evt.event_type}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{evt.actor}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {evt.license_id && (
                        <div className="text-foreground">
                          {t("Licença:")} {evt.license_id.slice(0, 8)}...
                        </div>
                      )}
                      {evt.installation_id && (
                        <div className="text-muted-foreground">
                          Inst: {evt.installation_id.slice(0, 16)}...
                        </div>
                      )}
                      {!evt.license_id && !evt.installation_id && "—"}
                    </td>
                    <td className="max-w-lg px-4 py-3 font-mono text-xs text-muted-foreground">
                      <pre className="max-h-24 overflow-x-auto rounded-md bg-muted/50 p-2 text-[11px]">
                        {JSON.stringify(evt.payload, null, 2)}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
