import { Readable } from "stream";
import { GoogleAuth, JWT } from "google-auth-library";
import { google } from "googleapis";

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];

const AGODA_FOLDER_NAME = "Agoda";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function readCredentials(): Record<string, unknown> | null {
  const jsonRaw = process.env.GOOGLE_DRIVE_CREDENTIALS_JSON?.trim();
  if (jsonRaw) {
    try {
      return JSON.parse(jsonRaw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export function extractFolderIdFromDriveUrl(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

export function resolveGoogleDriveRootFolderId(): string | null {
  const link =
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_LINK?.trim() ||
    process.env.GOOGLE_DRIVE_FOLDER_LINK?.trim();
  if (link) {
    const id = extractFolderIdFromDriveUrl(link);
    if (id) return id;
  }
  return process.env.GOOGLE_DRIVE_JOB_ITEMS_FOLDER_ID?.trim() || null;
}

export function getGoogleDriveJobItemsConfigurationIssue(): string | null {
  if (process.env.GOOGLE_DRIVE_JOB_ITEMS_UPLOAD_ENABLED === "false") {
    return "GOOGLE_DRIVE_JOB_ITEMS_UPLOAD_ENABLED=false";
  }
  if (!resolveGoogleDriveRootFolderId()) {
    return "missing root folder (set GOOGLE_DRIVE_ROOT_FOLDER_LINK, GOOGLE_DRIVE_FOLDER_LINK, or GOOGLE_DRIVE_JOB_ITEMS_FOLDER_ID)";
  }
  const creds = readCredentials();
  const path = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH?.trim();
  if (!creds && !path) {
    return "missing credentials (set GOOGLE_DRIVE_CREDENTIALS_PATH or GOOGLE_DRIVE_CREDENTIALS_JSON)";
  }
  return null;
}

export function isGoogleDriveJobItemsUploadConfigured(): boolean {
  return getGoogleDriveJobItemsConfigurationIssue() === null;
}

function escapeDriveQueryLiteral(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function formatDriveDateFolderName(d = new Date()): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function sanitizeXlsxNamePart(raw: string): string {
  const s = raw
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim();
  return s || "Unknown";
}

export function buildJobItemsXlsxFileName(
  portfolioName: string,
  propertyName: string,
  d = new Date()
): string {
  const port = sanitizeXlsxNamePart(portfolioName);
  const prop = sanitizeXlsxNamePart(propertyName);
  const dateOnly = formatDriveDateFolderName(d);
  return `${port}-${prop}-${dateOnly}.xlsx`;
}

async function getAuthorizedClient(): Promise<JWT> {
  const path = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH?.trim();
  const creds = readCredentials();

  if (creds) {
    const auth = new GoogleAuth({
      credentials: creds,
      scopes: DRIVE_SCOPES,
    });
    const client = await auth.getClient();
    if (!(client instanceof JWT)) {
      throw new Error("Expected JWT client for service account credentials");
    }
    return client;
  }

  if (path) {
    const auth = new GoogleAuth({
      keyFile: path,
      scopes: DRIVE_SCOPES,
    });
    const client = await auth.getClient();
    if (!(client instanceof JWT)) {
      throw new Error("Expected JWT client for service account credentials");
    }
    return client;
  }

  throw new Error("No Google Drive credentials configured");
}

async function findChildFolderId(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  folderName: string
): Promise<string | null> {
  const safeName = escapeDriveQueryLiteral(folderName);
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${safeName}' and trashed=false`,
    fields: "files(id,name)",
    spaces: "drive",
    corpora: "allDrives",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 10,
  });
  const first = res.data.files?.[0];
  return first?.id ?? null;
}

async function createChildFolder(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  folderName: string
): Promise<string> {
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error(`Failed to create Drive folder: ${folderName}`);
  return id;
}

async function findOrCreateChildFolder(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  folderName: string
): Promise<string> {
  const existing = await findChildFolderId(drive, parentId, folderName);
  if (existing) return existing;
  return createChildFolder(drive, parentId, folderName);
}

async function listXlsxFileIdsByNameInFolder(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  fileName: string
): Promise<string[]> {
  const safeName = escapeDriveQueryLiteral(fileName);
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name='${safeName}' and mimeType='${XLSX_MIME}' and trashed=false`,
    fields: "files(id)",
    spaces: "drive",
    corpora: "allDrives",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 100,
  });
  const files = res.data.files ?? [];
  return files.map((f) => f.id).filter((id): id is string => Boolean(id));
}

function viewLinkForFileId(id: string, webViewLink?: string | null): string {
  if (webViewLink) return webViewLink;
  return `https://drive.google.com/file/d/${id}/view`;
}

async function upsertXlsxInFolder(
  drive: ReturnType<typeof google.drive>,
  parentFolderId: string,
  fileName: string,
  xlsxBuffer: Buffer
): Promise<string | null> {
  const existingIds = await listXlsxFileIdsByNameInFolder(
    drive,
    parentFolderId,
    fileName
  );

  if (existingIds.length === 0) {
    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [parentFolderId],
      },
      media: {
        mimeType: XLSX_MIME,
        body: Readable.from(xlsxBuffer),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    const id = created.data.id;
    if (!id) return null;
    return viewLinkForFileId(id, created.data.webViewLink);
  }

  const keepId = existingIds[0];
  for (const dupId of existingIds.slice(1)) {
    await drive.files.delete({
      fileId: dupId,
      supportsAllDrives: true,
    });
  }

  const updated = await drive.files.update({
    fileId: keepId,
    media: {
      mimeType: XLSX_MIME,
      body: Readable.from(xlsxBuffer),
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  const id = updated.data.id ?? keepId;
  return viewLinkForFileId(id, updated.data.webViewLink);
}

/**
 * Ensures root/Agoda/DD-MM-YYYY and uploads the XLSX. Same file name replaces in place.
 */
export async function uploadAgodaJobItemsXlsxToGoogleDrive(
  xlsxBuffer: Buffer,
  meta: { portfolioName: string; propertyName: string }
): Promise<string | null> {
  if (!isGoogleDriveJobItemsUploadConfigured()) {
    return null;
  }

  const rootId = resolveGoogleDriveRootFolderId();
  if (!rootId) return null;

  const auth = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth });

  const agodaFolderId = await findOrCreateChildFolder(
    drive,
    rootId,
    AGODA_FOLDER_NAME
  );
  const dateFolderName = formatDriveDateFolderName();
  const dateFolderId = await findOrCreateChildFolder(
    drive,
    agodaFolderId,
    dateFolderName
  );

  const fileName = buildJobItemsXlsxFileName(
    meta.portfolioName,
    meta.propertyName
  );

  return upsertXlsxInFolder(drive, dateFolderId, fileName, xlsxBuffer);
}
