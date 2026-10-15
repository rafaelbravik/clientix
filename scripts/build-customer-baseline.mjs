#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VENDOR_ONLY_FUNCTIONS = [
  "fn_support_context",
  "fn_start_support",
  "fn_end_support",
  "fn_support_callback_write_allowed",
];

function extractFunctionStatement(sql, name) {
  const declaration = new RegExp(
    `^[\\t ]*create[\\t ]+(?:or[\\t ]+replace[\\t ]+)?function[\\t ]+public\\.${name}[\\t ]*\\(`,
    "gim",
  );
  const match = declaration.exec(sql);
  if (!match) return null;

  const remainder = sql.slice(match.index);
  const bodyDelimiter = /\bas[\t ]+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/i.exec(remainder);
  if (!bodyDelimiter) throw new Error(`FUNCTION_BODY_DELIMITER_MISSING:${name}`);

  const delimiter = bodyDelimiter[1];
  const bodyStart = match.index + bodyDelimiter.index + bodyDelimiter[0].length;
  const bodyEnd = sql.indexOf(delimiter, bodyStart);
  if (bodyEnd === -1) throw new Error(`FUNCTION_BODY_END_MISSING:${name}`);

  const semicolon = sql.indexOf(";", bodyEnd + delimiter.length);
  if (semicolon === -1) throw new Error(`FUNCTION_STATEMENT_END_MISSING:${name}`);

  return {
    name,
    start: match.index,
    end: semicolon + 1,
    text: sql.slice(match.index, semicolon + 1),
  };
}

function removeFunctionStatements(sql, names) {
  const ranges = [];
  for (const name of names) {
    let count = 0;
    let searchOffset = 0;
    while (true) {
      const statement = extractFunctionStatement(sql.slice(searchOffset), name);
      if (!statement) break;
      ranges.push({
        start: searchOffset + statement.start,
        end: searchOffset + statement.end,
      });
      count += 1;
      searchOffset += statement.end;
    }
    if (count === 0) throw new Error(`VENDOR_FUNCTION_NOT_FOUND:${name}`);
  }

  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    sql = `${sql.slice(0, range.start)}${sql.slice(range.end)}`;
  }

  return sql;
}

function removeFunctionPermissions(sql, names) {
  const namesPattern = names.join("|");
  const permission = new RegExp(
    `^[\\t ]*(?:revoke|grant)\\b(?:(?!;)[\\s\\S])*?\\bfunction[\\t ]+public\\.(?:${namesPattern})[\\t ]*\\([^;]*;[\\t ]*`,
    "gim",
  );
  return sql.replace(permission, "");
}

function replaceReplyDeliveryPolicySupportBranch(sql) {
  const statement = extractFunctionStatement(sql, "fn_reply_delivery_policy");
  if (!statement) throw new Error("CUSTOMER_REPLY_DELIVERY_POLICY_NOT_FOUND");

  let body = statement.text;
  const joins = /^[\t ]*left join public\.platform_support_sessions ss[^\r\n]*\r?\n[\t ]*left join public\.platform_admins pa[^\r\n]*\r?\n[\t ]*left join auth\.sessions au[^\r\n]*\r?\n/gim;
  const matches = body.match(joins) ?? [];
  if (matches.length !== 1) throw new Error("CUSTOMER_REPLY_DELIVERY_SUPPORT_JOINS_UNEXPECTED");
  body = body.replace(joins, "");

  const gateStart = body.indexOf("and((d.approved_support_session_id is not null");
  const gateEndMarker = "),'{\"current\":false}'::jsonb);";
  const gateEnd = body.indexOf(gateEndMarker, gateStart);
  if (gateStart === -1 || gateEnd === -1) {
    throw new Error("CUSTOMER_REPLY_DELIVERY_SUPPORT_GATE_UNEXPECTED");
  }
  const customerGate =
    "and d.approved_support_session_id is null and u.user_id is not null " +
    "and (u.role in('manager','admin') or c.assigned_to_user_id=u.user_id " +
    "or o.settings->>'visibility_mode'='all' " +
    "or (coalesce(o.settings->>'visibility_mode','own_and_unassigned')='own_and_unassigned' " +
    "and c.assigned_to_user_id is null))";
  body = `${body.slice(0, gateStart)}${customerGate}${body.slice(gateEnd)}`;
  return `${sql.slice(0, statement.start)}${body}${sql.slice(statement.end)}`;
}

export function transformCustomerBaseline(source, sourceManifest) {
  const vendorFunctions = VENDOR_ONLY_FUNCTIONS;
  let sql = source.replace(/\r\n/g, "\n");

  sql = removeFunctionStatements(sql, vendorFunctions);
  sql = removeFunctionPermissions(sql, vendorFunctions);
  sql = sql.replace(/\bpublic\.fn_support_context\s*\(\s*\)/gi, "NULL::jsonb");
  sql = replaceReplyDeliveryPolicySupportBranch(sql);

  if (/\bpublic\.fn_support_context\s*\(/i.test(sql)) {
    throw new Error("CUSTOMER_BASELINE_SUPPORT_CONTEXT_REFERENCE_REMAINS");
  }

  const functionDeclarations = /^[\t ]*create[\t ]+(?:or[\t ]+replace[\t ]+)?function[\t ]+public\.([A-Za-z0-9_]+)[\t ]*\(/gim;
  for (const match of sql.matchAll(functionDeclarations)) {
    const functionName = match[1];
    const statement = extractFunctionStatement(sql, functionName);
    if (statement?.text.includes("platform_support_sessions")) {
      throw new Error(`CUSTOMER_BASELINE_SUPPORT_TABLE_DEPENDENCY_REMAINS:${functionName}`);
    }
  }

  if (!/create table if not exists public\.platform_support_sessions\s*\(/i.test(sql)) {
    throw new Error("CUSTOMER_BASELINE_COMPATIBILITY_TABLE_MISSING");
  }
  if (/create(?:\s+or\s+replace)?\s+function\s+public\.(?:fn_support_context|fn_start_support|fn_end_support|fn_support_callback_write_allowed)\s*\(/i.test(sql)) {
    throw new Error("CUSTOMER_BASELINE_VENDOR_FUNCTION_REMAINS");
  }

  const manifest = structuredClone(sourceManifest);
  if (!manifest?.baseline || typeof manifest.baseline !== "object") {
    throw new Error("MIGRATOR_BASELINE_MANIFEST_INVALID");
  }
  manifest.baseline.checksum = createHash("sha256").update(sql, "utf8").digest("hex");
  manifest.baseline.size_bytes = Buffer.byteLength(sql, "utf8");

  return { sql, manifest };
}

function main(args) {
  const [baselinePath, manifestPath, outputBaselinePath, outputManifestPath] = args;
  if (!baselinePath || !manifestPath || !outputBaselinePath || !outputManifestPath) {
    throw new Error(
      "usage: build-customer-baseline.mjs <baseline.sql> <manifest.json> <out-baseline.sql> <out-manifest.json>",
    );
  }

  const source = readFileSync(baselinePath, "utf8");
  const sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = transformCustomerBaseline(source, sourceManifest);
  mkdirSync(dirname(outputBaselinePath), { recursive: true });
  mkdirSync(dirname(outputManifestPath), { recursive: true });
  writeFileSync(outputBaselinePath, result.sql, "utf8");
  writeFileSync(outputManifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
  console.info("Customer migrator schema materialized without executable support persistence dependencies.");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2));
}
