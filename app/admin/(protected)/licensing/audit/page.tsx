"use client";
import React, { useState, useEffect } from "react";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CircleNotch, MagnifyingGlass } from "@/lib/ui/icons";

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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trilha de Auditoria</h1>
          <p className="text-sm text-muted-foreground">
            Eventos append-only de emissão, ativação, PoP, heartbeat e operações administrativas.
          </p>
        </div>
      </div>

      <LicensingNav />

      {/* Filter Bar */}
      <form
        onSubmit={handleFilterSubmit}
        className="flex flex-wrap gap-3 items-center justify-between bg-card p-4 rounded-lg border"
      >
        <div className="flex flex-wrap gap-2 items-center flex-1">
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
            placeholder="Até"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-40"
          />
          <Button type="submit" variant="secondary" size="sm">
            <MagnifyingGlass className="h-4 w-4 mr-1.5" /> Filtrar
          </Button>
        </div>
      </form>

      {/* Table */}
      <div className="border rounded-lg bg-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center flex items-center justify-center text-muted-foreground">
            <CircleNotch className="h-5 w-5 animate-spin mr-2" /> Carregando eventos de auditoria...
          </div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            Nenhum evento registrado com os filtros aplicados.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/40 text-muted-foreground font-medium border-b text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Data / Hora (UTC)</th>
                  <th className="px-4 py-3">Tipo de Evento</th>
                  <th className="px-4 py-3">Ator</th>
                  <th className="px-4 py-3">Licença / Instalação</th>
                  <th className="px-4 py-3">Payload (Sanitizado)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((evt) => (
                  <tr key={evt.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(evt.created_at).toLocaleString("pt-BR")}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-foreground">
                      {evt.event_type}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{evt.actor}</td>
                    <td className="px-4 py-3 text-xs font-mono">
                      {evt.license_id && (
                        <div className="text-foreground">
                          Licença: {evt.license_id.slice(0, 8)}...
                        </div>
                      )}
                      {evt.installation_id && (
                        <div className="text-muted-foreground">
                          Inst: {evt.installation_id.slice(0, 16)}...
                        </div>
                      )}
                      {!evt.license_id && !evt.installation_id && "—"}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-muted-foreground max-w-lg">
                      <pre className="bg-muted/50 p-2 rounded text-[11px] overflow-x-auto max-h-24">
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
