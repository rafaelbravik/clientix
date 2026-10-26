import { describe, expect, it } from "vitest";
import { isHistoricalImportedMessage } from "./historical-message";

describe("marcador persistente de mensagem histórica", () => {
  it("reconhece a marca gravada e a compatibilidade de import_id", () => {
    expect(isHistoricalImportedMessage({ metadata: { historico_importado: "true" } })).toBe(true);
    expect(isHistoricalImportedMessage({ metadata: { historico_importado: true } })).toBe(true);
    expect(isHistoricalImportedMessage({ metadata: { importacao_id: "job-1" } })).toBe(true);
  });

  it("falha fechado para valores e formatos inválidos", () => {
    expect(isHistoricalImportedMessage({ metadata: { historico_importado: "false" } })).toBe(false);
    expect(isHistoricalImportedMessage({ metadata: "historico_importado" })).toBe(false);
    expect(isHistoricalImportedMessage(null)).toBe(false);
  });
});
