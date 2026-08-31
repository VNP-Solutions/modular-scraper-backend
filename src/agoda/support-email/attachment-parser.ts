/**
 * Downloads and parses the CSV / XLSX files Agoda Partner Support attaches to
 * its replies (for example `69836fdc661b7989c3cec535.csv`).
 */

import type { gmail_v1 } from "googleapis";
import Papa from "papaparse";
import XLSX from "xlsx";
import { dualLogInfo, dualLogWarn } from "../../common/log-helper.js";
import { evaluateReopenDecision } from "./reopen-rules.js";
import type {
  AttachmentFormat,
  ParsedAttachment,
  ReopenRuleOptions,
} from "./support-email.types.js";

export interface AttachmentContext {
  /** Agoda property ID, used to reject rows belonging to another hotel. */
  agodaId?: string | null;
  reopenRules?: ReopenRuleOptions;
}

interface AttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
  sizeBytes: number;
}

function detectFormat(filename: string, mimeType: string): AttachmentFormat {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "csv") return "csv";
  if (extension === "xlsx" || extension === "xls") return "xlsx";

  const type = mimeType.toLowerCase();
  if (type.includes("csv")) return "csv";
  if (type.includes("spreadsheet") || type.includes("excel")) return "xlsx";
  return "unknown";
}

/**
 * Walks the MIME tree collecting every downloadable attachment reference.
 */
export function collectAttachmentRefs(
  payload: gmail_v1.Schema$MessagePart | undefined,
  refs: AttachmentRef[] = []
): AttachmentRef[] {
  if (!payload) return refs;

  const filename = payload.filename ?? "";
  const attachmentId = payload.body?.attachmentId;

  if (filename && attachmentId) {
    refs.push({
      filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      attachmentId,
      sizeBytes: payload.body?.size ?? 0,
    });
  }

  for (const part of payload.parts ?? []) {
    collectAttachmentRefs(part, refs);
  }

  return refs;
}

function toStringRecord(row: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.trim()] = value == null ? "" : String(value).trim();
  }
  return normalized;
}

function parseCsv(buffer: Buffer): {
  columns: string[];
  rows: Record<string, string>[];
} {
  // Strip a UTF-8 BOM so the first column name does not gain a stray prefix.
  const content = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const result = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: true,
  });

  return {
    columns: (result.meta.fields ?? []).map((field) => field.trim()),
    rows: result.data.map(toStringRecord),
  };
}

function parseXlsx(buffer: Buffer): {
  columns: string[];
  rows: Record<string, string>[];
} {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { columns: [], rows: [] };

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils
    .sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false })
    .map(toStringRecord);

  const columns = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    range: 0,
  })[0];

  return {
    columns: (columns ?? []).map((column) => String(column).trim()),
    rows,
  };
}

export function parseAttachmentBuffer(
  filename: string,
  mimeType: string,
  buffer: Buffer
): ParsedAttachment {
  const format = detectFormat(filename, mimeType);
  const base = {
    filename,
    mimeType,
    sizeBytes: buffer.length,
    format,
  };

  if (format === "unknown") {
    return {
      ...base,
      columns: [],
      rows: [],
      rowCount: 0,
      parseError: `Unsupported attachment type: ${filename}`,
    };
  }

  try {
    const { columns, rows } = format === "csv" ? parseCsv(buffer) : parseXlsx(buffer);
    return { ...base, columns, rows, rowCount: rows.length };
  } catch (error: any) {
    return {
      ...base,
      columns: [],
      rows: [],
      rowCount: 0,
      parseError: error?.message || String(error),
    };
  }
}

/**
 * Downloads every CSV / XLSX attachment on a message and parses it into rows.
 * Attachments of other types are reported with a `parseError` rather than
 * dropped, so the caller can still see what came through.
 */
export async function downloadAndParseAttachments(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload: gmail_v1.Schema$MessagePart | undefined,
  context: AttachmentContext = {}
): Promise<ParsedAttachment[]> {
  const refs = collectAttachmentRefs(payload);
  if (refs.length === 0) return [];

  await dualLogInfo(
    `📎 Found ${refs.length} attachment(s) on message ${messageId}`
  );

  const parsed: ParsedAttachment[] = [];

  for (const ref of refs) {
    if (detectFormat(ref.filename, ref.mimeType) === "unknown") {
      await dualLogInfo(`⏭️ Skipping non-tabular attachment: ${ref.filename}`);
      parsed.push({
        filename: ref.filename,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        format: "unknown",
        columns: [],
        rows: [],
        rowCount: 0,
        parseError: "Unsupported attachment type",
      });
      continue;
    }

    try {
      const response = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: ref.attachmentId,
      });

      const data = response.data.data;
      if (!data) {
        throw new Error("Gmail returned an empty attachment body");
      }

      const buffer = Buffer.from(data, "base64url");
      const attachment = parseAttachmentBuffer(
        ref.filename,
        ref.mimeType,
        buffer
      );

      attachment.reopenDecision = evaluateReopenDecision(
        attachment,
        { agodaId: context.agodaId },
        context.reopenRules
      );

      await dualLogInfo(
        `✅ Parsed attachment ${ref.filename} (${attachment.rowCount} rows)`,
        {
          sheetType: attachment.reopenDecision.sheetType,
          shouldReopen: attachment.reopenDecision.shouldReopen,
          collectCount: attachment.reopenDecision.collect.length,
          reopenCount: attachment.reopenDecision.reopen.length,
          skippedCount: attachment.reopenDecision.skipped.length,
        }
      );
      parsed.push(attachment);
    } catch (error: any) {
      await dualLogWarn(`⚠️ Failed to download attachment ${ref.filename}`, {
        error: error?.message || String(error),
      });
      parsed.push({
        filename: ref.filename,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        format: detectFormat(ref.filename, ref.mimeType),
        columns: [],
        rows: [],
        rowCount: 0,
        parseError: error?.message || String(error),
      });
    }
  }

  return parsed;
}